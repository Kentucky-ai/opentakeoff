// Tile-pyramid compositor glue (#86) — the DOM/Worker orchestration layer.
// Pure tile math lives in tiles.ts (tested); the worker pool lives in
// tilePool.ts. This file is the untested glue, matching the repo's existing
// split (canvasUtil.js/panelGeometry.js are pure+tested, the render effects
// in TakeoffCanvas.jsx that drive real canvases are not) — see the #86
// research note on why DOM+pdf.js orchestration stays outside node:test.
//
// Two layers per panel, mirroring the OLD base-raster + detail-overlay split
// so pan/zoom never blanks:
//   BASE  — painted ONCE per sheet, in two phases: an instant coarse
//           placeholder (level 0, a handful of tiles), then upgraded to a
//           bounded ~28MP-equivalent tiled composite (BASE_TARGET_AREA,
//           matching the OLD codebase's MAX_PANEL_AREA raster budget) once
//           those tiles land. Never re-rendered on pan/zoom after that.
//           This second phase is NOT an optimization — it's a correctness
//           fix. The detail layer deliberately doesn't repaint mid-gesture
//           (see its comment), which means the base layer is what a fast
//           pan actually shows most of the time. Shipping this at level-0
//           quality (an instant-placeholder density, maybe 1-1.5K px for
//           the WHOLE sheet) reads as "blurry and laggy" during exactly the
//           panning-across-a-big-sheet motion an estimator does constantly —
//           confirmed live, not a hypothesis. The old per-sheet raster was
//           sharp on its own up to 28MP; the base layer has to clear that
//           same bar, or #86 is a real quality regression for that gesture
//           even though the DETAIL layer is sharper than the old code ever
//           was once it engages.
//   DETAIL — repositioned/resized to [visible region + margin] on settle,
//           like the old detail view, but active at every zoom level (no
//           DETAIL_ENGAGE gate) and sourced from the tile cache instead of a
//           fresh pdf.js render. One per PANEL (not one shared global,
//           unlike the old single detailCanvasRef) — every panel in a group
//           gets independent sharpness, closing the RFC's noted group-mode gap.
//
// paintDetail double-buffers and swaps ATOMICALLY (compose off-DOM, one
// drawImage onto the visible canvas once the crop is READY — never on a
// timer, see its comment) — this is the OLD codebase's own "never a partial paint"
// rule (see its double-buffer comment history), which the first version of
// this file dropped in favor of drawing each tile the moment it landed.
// That reads, live, as tiles visibly sweeping across the sheet in whatever
// order the worker pool happens to finish them — confirmed as a real UX
// complaint, not a perf one: the fix is compositing off-screen and revealing
// once, not rendering fewer/faster tiles (see tilePool.ts for the actual
// speed fix — real N-way parallelism instead of one worker doing everything).
//
// Dark mode: tiles are cached per-mode (key suffixed :0/:1) and rendered
// inverted BY THE WORKER before transfer, not re-inverted on the main thread
// — inversion moves into the tile pipeline exactly as the RFC asks. This
// trades a possible cache doubling (only if a user actively toggles dark
// mode while looking at the same tiles) for zero main-thread pixel work.

import { RENDER_SCALE } from "./sheets";
import { createTilePool } from "./tilePool";
import { TileLRU, buildLevels, pickLevel, levelDims, visibleTiles, visibleTilesAtDensity, fitDensity, BASE_LEVEL, tileKey as rawTileKey, TILE_SIZE } from "./tiles";

// ~450MB shared across every open sheet/panel — the old per-group ceiling
// ("4-up ≈ 450MB" per canvasConstants.js), now a BUDGET instead of a floor
// that individual panels could each independently blow past.
const BYTE_BUDGET = 450 * 1024 * 1024;
// The base layer's phase-2 target — deliberately the SAME number as the old
// codebase's MAX_PANEL_AREA (canvasConstants.js), not a new tuning constant.
// The goal isn't a new budget, it's parity with the raster quality that
// shipped for years before #86; tiling just makes hitting that number
// bounded-memory instead of one giant backing store.
const BASE_TARGET_AREA = 28_000_000;
// Sanity ceiling on ONE detail crop's backing store. In normal use the crop
// is viewport*dpr — about 8MP — at every zoom, because zooming in shrinks the
// image-space region by exactly the factor it raises the density. This only
// engages for an abnormally large panel (a huge display, or a margin far
// wider than the viewport), and it is a backstop, not a quality knob: at the
// sizes real screens produce it never binds.
const MAX_CROP_AREA = 40_000_000;

/** Density ceiling for a crop of this image-space size, from MAX_CROP_AREA. */
function cropDensityCap(iw: number, ih: number): number {
  const area = Math.max(1, iw * ih);
  return Math.sqrt(MAX_CROP_AREA / area);
}

function modeKey(key: string, dark: boolean) { return `${key}:${dark ? 1 : 0}`; }

export function createTileCompositor() {
  const pool = createTilePool();
  // The LRU owns real pixel memory: ImageBitmaps hold their backing store
  // until close(), so eviction/replace/clear must close, or the "byte budget"
  // only bounds the ledger while the process keeps every bitmap ever rendered
  // alive until GC gets around to it. Never close a bitmap still on screen:
  // the protect provider unions every panel's last-painted tile set (base +
  // detail), so evictToBudget skips exactly what's visible right now.
  const visibleKeys = new Map<string, Set<string>>(); // `${sheetKey}|base` / `${sheetKey}|detail` → protected tile keys
  const cache = new TileLRU(
    BYTE_BUDGET,
    // close() on a MACROTASK, not inline: every drawImage of a just-fetched
    // tile runs synchronously right after its await resumes, so deferring one
    // macrotask guarantees no draw ever sees a closed bitmap even if the
    // insert that cached it immediately evicted it (budget saturated by
    // protected tiles). Memory still releases within the same tick's turn.
    (v) => { const b = v as ImageBitmap; setTimeout(() => { try { b.close(); } catch { /* already closed */ } }, 0); },
    () => {
      const s = new Set<string>();
      for (const set of visibleKeys.values()) for (const k of set) s.add(k);
      return s;
    },
  );
  // One entry per tile IN FLIGHT, holding the SHARED promise every concurrent
  // caller awaits. Sharing (rather than "already fetching → undefined") is
  // load-bearing: during a pan, paint N requests a tile, paint N+1 supersedes
  // paint N (live=false) and asks for the same tile — if N+1 got `undefined`
  // back, NOBODY would ever draw that tile once it lands (N is dead, N+1
  // skipped it, and nothing else repaints at rest), leaving a permanently
  // blurry patch after every settle. With the shared promise, N+1 draws it.
  const inflightReqs = new Map<string, { cancel: () => void; promise: Promise<ImageBitmap | undefined> }>();
  const levelsBySheet = new Map<string, number[]>();
  const dimsBySheet = new Map<string, { w: number; h: number }>();
  // exact-fit density the BASE composite was painted at, per sheet — the
  // placeholder search needs it to rank the base against the pyramid levels
  const baseDensityBySheet = new Map<string, number>();
  const opened = new Set<string>();
  // Every tile request awaits this before hitting the worker — dataPromise
  // (an IndexedDB read) resolves well after openSheet() returns, so without
  // this gate a base-layer paint kicked off right after openSheet() would
  // race the worker's "openSheet" message and come back "sheet not open".
  const readyBySheet = new Map<string, Promise<void>>();
  let generation = 0; // bumped on sheet/group change — invalidates in-flight paints

  function levelsFor(sheetKey: string, imgW: number, imgH: number) {
    let levels = levelsBySheet.get(sheetKey);
    if (!levels) { levels = buildLevels(imgW, imgH); levelsBySheet.set(sheetKey, levels); dimsBySheet.set(sheetKey, { w: imgW, h: imgH }); }
    return levels;
  }

  /** Idempotent per sheetKey. `dataPromise` must resolve to a FRESH byte copy
   *  (transferred to the worker, not shared with the main-thread pdf.js doc). */
  function openSheet(sheetKey: string, pageNum: number, dataPromise: Promise<ArrayBuffer | Uint8Array>, imgW: number, imgH: number) {
    levelsFor(sheetKey, imgW, imgH);
    if (opened.has(sheetKey)) return;
    opened.add(sheetKey);
    const ready = dataPromise.then((data) => {
      const buf = data instanceof Uint8Array ? data.slice().buffer : data;
      return pool.openSheet(sheetKey, pageNum, buf);
    }).catch((err) => {
      opened.delete(sheetKey);
      // A sheet that never opens is a permanently blank panel, not a
      // recoverable/expected case (unlike a superseded/cancelled tile) — this
      // must be visible, or the failure mode is silent forever.
      console.error(`[tiles] sheet failed to open: ${sheetKey}`, err);
    });
    readyBySheet.set(sheetKey, ready);
  }

  /** Clears every cached tile and closes every worker-side sheet — call on
   *  group/sheet-set change, mirroring the old effect's *Ref.current.clear() sweep. */
  function resetAll() {
    generation++;
    for (const r of inflightReqs.values()) { try { r.cancel(); } catch { /* done */ } }
    inflightReqs.clear();
    cache.clear();
    for (const k of opened) pool.closeSheet(k);
    opened.clear();
    levelsBySheet.clear();
    dimsBySheet.clear();
    readyBySheet.clear();
    visibleKeys.clear();
  }

  async function getOrFetchTile(sheetKey: string, level: number, tx: number, ty: number, density: number, dark: boolean): Promise<ImageBitmap | undefined> {
    const key = modeKey(rawTileKey(sheetKey, level, tx, ty), dark);
    const cached = cache.get(key) as ImageBitmap | undefined;
    if (cached) return cached;
    const myGen = generation;
    const existing = inflightReqs.get(key);
    if (existing) {
      // join the in-flight fetch (see inflightReqs' comment for why joining,
      // not skipping, is what keeps settled views sharp)
      const bmp = await existing.promise;
      return myGen === generation ? bmp : undefined;
    }
    const dims = dimsBySheet.get(sheetKey);
    const levels = levelsBySheet.get(sheetKey);
    if (!dims || !levels) return undefined;
    // Register the entry SYNCHRONOUSLY (before any await) or two callers can
    // both pass the `existing` check during the sheet-ready await and issue
    // duplicate worker renders for the same tile.
    const cancelRef: { cancel: () => void } = { cancel: () => {} };
    const run = (async (): Promise<ImageBitmap | undefined> => {
      try { await readyBySheet.get(sheetKey); } catch { return undefined; } // sheet failed to open
      if (myGen !== generation) return undefined; // superseded while we waited on open
      const { w: levelW, h: levelH } = levelDims(dims.w, dims.h, density);
      const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
      const rect = { x, y, w: Math.min(TILE_SIZE, levelW - x), h: Math.min(TILE_SIZE, levelH - y) };
      if (rect.w <= 0 || rect.h <= 0) return undefined;
      const { promise, cancel } = pool.requestTile({ sheetKey, scale: RENDER_SCALE * density, rect, dark });
      cancelRef.cancel = cancel;
      try {
        const { bitmap, w, h } = await promise;
        if (myGen !== generation) { bitmap.close(); return undefined; } // superseded by resetAll
        cache.set(key, bitmap, w * h * 4);
        return bitmap;
      } catch (err) {
        // A failed tile silently degrades to "placeholder forever" on screen,
        // which reads as blur rather than as breakage — the #86 pixelation
        // hunt cost a day precisely because this catch was bare. Cancellation
        // is routine and stays quiet; a genuine render failure must not.
        if (!(err as Error)?.message?.includes("Rendering cancelled")) {
          console.warn(`[tiles] level ${level} tile ${tx},${ty} failed:`, err);
        }
        return undefined;
      }
    })();
    inflightReqs.set(key, { cancel: () => cancelRef.cancel(), promise: run });
    const settle = () => { if (inflightReqs.get(key)?.promise === run) inflightReqs.delete(key); };
    run.then(settle, settle);
    return run;
  }

  /** Renders the WHOLE sheet at `density` into an off-DOM buffer, then swaps
   *  it into `canvas` atomically (same "compose off-screen, one reveal" rule
   *  as paintDetail — a ~28MP base composite can be 100+ tiles, and painting
   *  those onto the visible canvas one at a time would be its own wave).
   *  `level` is the cache-key id only; it need not index `levels`. */
  async function paintBaseAtLevel(canvas: HTMLCanvasElement, sheetKey: string, imgW: number, imgH: number, density: number, level: number, dark: boolean, myGen: number) {
    const { w: lw, h: lh } = levelDims(imgW, imgH, density);
    const tiles = visibleTilesAtDensity(imgW, imgH, density, level, 0, 0, imgW, imgH);
    const back = document.createElement("canvas");
    back.width = lw; back.height = lh;
    const bctx = back.getContext("2d");
    if (!bctx) return;
    await Promise.all(tiles.map(async (t) => {
      const bmp = await getOrFetchTile(sheetKey, level, t.tx, t.ty, density, dark);
      if (!bmp || myGen !== generation) return;
      bctx.drawImage(bmp, t.x, t.y);
    }));
    if (myGen !== generation) return;
    // the base layer is visible for as long as the sheet is open — protect
    // whichever level is CURRENTLY painted (replaces the prior phase's set)
    visibleKeys.set(`${sheetKey}|base`, new Set(tiles.map((t) => modeKey(rawTileKey(sheetKey, level, t.tx, t.ty), dark))));
    canvas.width = lw; canvas.height = lh;
    canvas.getContext("2d")?.drawImage(back, 0, 0);
  }

  /** Two-phase whole-sheet base layer, painted once per sheet: an instant
   *  coarse placeholder (near-zero tiles), then upgraded in place to a
   *  bounded ~28MP-equivalent composite — see the file header for why the
   *  second phase isn't optional polish. */
  async function paintBase(canvas: HTMLCanvasElement, sheetKey: string, imgW: number, imgH: number, dark: boolean) {
    const levels = levelsFor(sheetKey, imgW, imgH);
    const myGen = generation;
    await paintBaseAtLevel(canvas, sheetKey, imgW, imgH, levels[0], 0, dark, myGen);
    if (myGen !== generation) return;
    // Phase 2 at the EXACT budget density, not the nearest level under it —
    // see fitDensity for the 37%-of-budget shortfall that snapping caused.
    const bd = fitDensity(imgW, imgH, BASE_TARGET_AREA);
    baseDensityBySheet.set(sheetKey, bd);
    if (bd > levels[0]) await paintBaseAtLevel(canvas, sheetKey, imgW, imgH, bd, BASE_LEVEL, dark, myGen);
  }

  /** Densest fully-cached stand-in for this region — drawn under the target
   *  level while its tiles stream in. Considers the BASE composite alongside
   *  the coarser pyramid levels: the base sits at the exact budget density
   *  (~0.82 on an E-size sheet), denser than any power-of-two level under 1,
   *  so at deep zoom it is both the best available placeholder AND the thing
   *  the user actually stares at while the target level renders. */
  function bestPlaceholder(sheetKey: string, levels: number[], target: number, x0: number, y0: number, x1: number, y1: number, dark: boolean): { level: number; density: number } {
    const dims = dimsBySheet.get(sheetKey)!;
    const cached = (level: number, density: number) => {
      const tiles = visibleTilesAtDensity(dims.w, dims.h, density, level, x0, y0, x1, y1);
      return tiles.length > 0 && tiles.every((t) => cache.has(modeKey(rawTileKey(sheetKey, level, t.tx, t.ty), dark)));
    };
    const baseDensity = baseDensityBySheet.get(sheetKey);
    const candidates: { level: number; density: number }[] = [];
    for (let l = target - 1; l >= 0; l--) candidates.push({ level: l, density: levels[l] });
    if (baseDensity !== undefined && baseDensity < levels[target]) candidates.push({ level: BASE_LEVEL, density: baseDensity });
    candidates.sort((a, b) => b.density - a.density); // densest stand-in first
    for (const c of candidates) if (cached(c.level, c.density)) return c;
    return { level: 0, density: levels[0] }; // always fetched by paintBase — safe even if not yet cached (draws nothing, not a crash)
  }

  /** Paints [x0,y0,x1,y1) (image px, margin already applied by the caller)
   *  for a panel positioned at `panelXOffset` in stage space. Composes
   *  off-DOM and swaps into `canvas` ATOMICALLY — the visible canvas (size,
   *  position, AND pixels) is untouched until the new crop is ready (or
   *  is READY — never on a timer), so the previous, fully-painted crop stays on
   *  screen with zero flicker and zero tile-by-tile sweep. `onDone` fires
   *  once per actual reveal (the atomic swap, or a rare post-grace straggler
   *  patch), not once per tile. Returns a disposer that stops this call from
   *  PAINTING anything further — deliberately NOT a worker-render cancel: a
   *  superseded crop's tiles usually overlap the next crop (pans are
   *  incremental), so letting them finish warms the cache the successor
   *  reads from, and the byte budget bounds the cost. resetAll is the hard
   *  cancel for sheet/group changes, where in-flight tiles really are garbage. */
  function paintDetail(
    canvas: HTMLCanvasElement, sheetKey: string, panelXOffset: number, x0: number, y0: number, x1: number, y1: number,
    density: number, dark: boolean, onDone: () => void,
  ) {
    const dims = dimsBySheet.get(sheetKey);
    const levels = levelsBySheet.get(sheetKey);
    if (!dims || !levels) return { cancel() {} };
    // The detail crop is rendered ONCE, at exactly the density the screen
    // asks for — no pyramid snapping, no density ceiling.
    //
    // The pyramid was the wrong tool here. A crop at full sharpness is
    // (viewport/zoom) image px at (zoom*dpr) density, and those cancel: it is
    // viewport*dpr device px at EVERY zoom — a constant ~8MP, whether you are
    // at 50% or 1600%. Tiling that constant into 512² pieces doesn't make it
    // cheaper, it makes it ~36x more expensive, because pdf.js replays the
    // whole page operator list per render regardless of how little of the page
    // lands in the target canvas. That is why deep-zoom tiles never completed,
    // which is why #108 lowered MAX_DENSITY to 4, which capped sharpness at
    // 200% zoom on a dpr-2 screen and produced visible pixel-doubling (2.08x
    // measured at 417%). One render removes the cause instead of trading one
    // blur for another. Tiles remain exactly right for the BASE layer: a
    // whole-sheet composite, built once, where the pyramid's bounded memory is
    // the entire point.
    const targetDensity = Math.min(density, cropDensityCap(x1 - x0, y1 - y0));
    const bw = Math.max(1, Math.round((x1 - x0) * targetDensity));
    const bh = Math.max(1, Math.round((y1 - y0) * targetDensity));
    const myGen = generation;
    let live = true;

    // Compose off-DOM — see the file header for why this replaced painting
    // straight onto the visible canvas.
    const back = document.createElement("canvas");
    back.width = bw; back.height = bh;
    const bctx = back.getContext("2d");
    if (!bctx) return { cancel() {} };

    const { level: placeholderLevel, density: phDensity } = bestPlaceholder(sheetKey, levels, pickLevel(levels, targetDensity), x0, y0, x1, y1, dark);
    const phTiles = visibleTilesAtDensity(dims.w, dims.h, phDensity, placeholderLevel, x0, y0, x1, y1);
    for (const t of phTiles) {
      const bmp = cache.get(modeKey(rawTileKey(sheetKey, placeholderLevel, t.tx, t.ty), dark)) as ImageBitmap | undefined;
      if (!bmp) continue;
      const dx = (t.x / phDensity - x0) * targetDensity, dy = (t.y / phDensity - y0) * targetDensity;
      const dw = (t.w / phDensity) * targetDensity, dh = (t.h / phDensity) * targetDensity;
      bctx.drawImage(bmp, dx, dy, dw, dh);
    }

    // Nothing to protect from eviction any more — the crop is a one-off
    // render, not cached tiles. Clearing the old detail set lets the LRU
    // reclaim the previous crop's tiles (base tiles stay shielded).
    visibleKeys.delete(`${sheetKey}|detail`);

    let swapped = false;
    const swap = () => {
      if (swapped || !live || myGen !== generation) return;
      swapped = true;
      canvas.width = bw; canvas.height = bh;
      canvas.style.left = `${panelXOffset + x0}px`; canvas.style.top = `${y0}px`;
      canvas.style.width = `${x1 - x0}px`; canvas.style.height = `${y1 - y0}px`;
      canvas.style.display = "block";
      canvas.getContext("2d")?.drawImage(back, 0, 0);
      onDone();
    };
    // NOTHING reveals this buffer on a timer any more, and that is the whole
    // point: A SHARP CROP IS NEVER REPLACED BY A COARSER ONE.
    //
    // There used to be a REVEAL_GRACE_MS fallback that swapped in whatever was
    // ready. On a slow render that meant revealing a placeholder-only buffer —
    // which resizes and repaints the visible canvas, destroying the previous
    // sharp crop to show a ~26x upscale of the base. Every pan became
    // sharp -> blurry -> sharp, and holding a gesture parked you in the blurry
    // half. Reported as "jumps and flashes and blurry just out of focus", and
    // confirmed from a screen recording: two frames at the SAME 1081% zoom,
    // one smeared and one crisp.
    //
    // Waiting costs nothing, because the previous crop is still correct while
    // we wait. The detail canvas is positioned in SHEET space, so it pans with
    // the stage: its pixels stay pinned to the region they were rendered for.
    // A small pan is still covered (the crop carries a margin for exactly
    // this), and wherever it no longer reaches, the BASE layer shows through —
    // which is the "never blank" guarantee doing its job. Base under new
    // territory is honest; base smeared over ground we already had sharp is
    // not.

    // ONE render for the whole crop. The rect is in the crop's own density
    // space, which is what the worker's `transform: [1,0,0,1,-x,-y]` expects.
    let cropReq: { cancel: () => void } | undefined;
    if (bw <= 0 || bh <= 0) {
      swap(); // degenerate region — nothing to wait for
    } else {
      const req = pool.requestTile({
        sheetKey,
        scale: RENDER_SCALE * targetDensity,
        rect: { x: Math.round(x0 * targetDensity), y: Math.round(y0 * targetDensity), w: bw, h: bh },
        dark,
      });
      cropReq = { cancel: req.cancel };
      req.promise.then(({ bitmap }) => {
        if (!live || myGen !== generation) { bitmap.close(); return; }
        // The ONLY path that reveals this crop. Compose over the placeholder
        // underlay (which covers any region the render left transparent) and
        // swap once, fully sharp. Then release — a one-off crop, so nothing
        // else will ever close it for us.
        bctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        swap();
      }).catch((err) => {
        if (!live || myGen !== generation) return;
        // Deliberately do NOT swap. A failed crop means we have nothing better
        // than what is already on screen, and revealing the placeholder buffer
        // here would blur a view the user could still read. Keep the last good
        // crop, let the base cover the rest, and say so.
        console.warn("[tiles] detail crop failed — keeping the previous crop:", err);
      });
    }

    return { cancel() { live = false; cropReq?.cancel(); } };
  }

  function dispose() { resetAll(); pool.dispose(); }

  return { openSheet, resetAll, paintBase, paintDetail, dispose };
}
