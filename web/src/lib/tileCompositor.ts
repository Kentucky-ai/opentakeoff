// Tile-pyramid compositor glue (#86) — the DOM/Worker orchestration layer.
// Pure tile math lives in tiles.ts (tested); the worker pool lives in
// tilePool.ts. This file is the untested glue, matching the repo's existing
// split (canvasUtil.js/panelGeometry.js are pure+tested, the render effects
// in TakeoffCanvas.jsx that drive real canvases are not) — see the #86
// research note on why DOM+pdf.js orchestration stays outside node:test.
//
// Two layers per panel, mirroring the OLD base-raster + detail-overlay split
// so pan/zoom never blanks:
//   BASE  — one small (bounded backing store), painted ONCE per sheet from
//           the coarsest pyramid level, stretched to the panel's full CSS
//           footprint. Never re-rendered on pan/zoom. The "never blank"
//           guarantee.
//   DETAIL — repositioned/resized to [visible region + margin] on settle,
//           like the old detail view, but active at every zoom level (no
//           DETAIL_ENGAGE gate) and sourced from the tile cache instead of a
//           fresh pdf.js render. One per PANEL (not one shared global,
//           unlike the old single detailCanvasRef) — every panel in a group
//           gets independent sharpness, closing the RFC's noted group-mode gap.
//
// Dark mode: tiles are cached per-mode (key suffixed :0/:1) and rendered
// inverted BY THE WORKER before transfer, not re-inverted on the main thread
// — inversion moves into the tile pipeline exactly as the RFC asks. This
// trades a possible cache doubling (only if a user actively toggles dark
// mode while looking at the same tiles) for zero main-thread pixel work.

import { RENDER_SCALE } from "./sheets";
import { createTilePool } from "./tilePool";
import { TileLRU, buildLevels, pickLevel, levelDims, visibleTiles, tileKey as rawTileKey, TILE_SIZE } from "./tiles";

// ~450MB shared across every open sheet/panel — the old per-group ceiling
// ("4-up ≈ 450MB" per canvasConstants.js), now a BUDGET instead of a floor
// that individual panels could each independently blow past.
const BYTE_BUDGET = 450 * 1024 * 1024;
const BASE_MARGIN = 0.5; // same DETAIL_MARGIN intent — buffer beyond the viewport

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
      } catch {
        return undefined;
      }
    })();
    inflightReqs.set(key, { cancel: () => cancelRef.cancel(), promise: run });
    const settle = () => { if (inflightReqs.get(key)?.promise === run) inflightReqs.delete(key); };
    run.then(settle, settle);
    return run;
  }

  /** Whole-sheet coarse placeholder — small backing store, painted once. */
  async function paintBase(canvas: HTMLCanvasElement, sheetKey: string, imgW: number, imgH: number, dark: boolean) {
    const levels = levelsFor(sheetKey, imgW, imgH);
    const level = 0;
    const density = levels[level];
    const { w: lw, h: lh } = levelDims(imgW, imgH, density);
    const tiles = visibleTiles(imgW, imgH, levels, level, 0, 0, imgW, imgH);
    // the base layer is visible for as long as the sheet is open — protect it
    visibleKeys.set(`${sheetKey}|base`, new Set(tiles.map((t) => modeKey(rawTileKey(sheetKey, level, t.tx, t.ty), dark))));
    canvas.width = lw; canvas.height = lh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const myGen = generation;
    await Promise.all(tiles.map(async (t) => {
      const bmp = await getOrFetchTile(sheetKey, level, t.tx, t.ty, density, dark);
      if (!bmp || myGen !== generation) return;
      ctx.drawImage(bmp, t.x, t.y);
    }));
  }

  /** Best coarser level fully cached for this region — the instant
   *  placeholder drawn under the target level while its tiles stream in. */
  function bestPlaceholderLevel(sheetKey: string, levels: number[], target: number, x0: number, y0: number, x1: number, y1: number, dark: boolean) {
    const dims = dimsBySheet.get(sheetKey)!;
    for (let l = target - 1; l >= 0; l--) {
      const tiles = visibleTiles(dims.w, dims.h, levels, l, x0, y0, x1, y1);
      if (tiles.length && tiles.every((t) => cache.has(modeKey(rawTileKey(sheetKey, l, t.tx, t.ty), dark)))) return l;
    }
    return 0; // level 0 is always fetched by paintBase — safe fallback even if not yet cached (draws nothing, not a crash)
  }

  /** Paints [x0,y0,x1,y1) (image px, +BASE_MARGIN buffer applied by the
   *  caller) into `canvas`, sized to the region at `density`. Fires `onDone`
   *  every time a fresh tile arrival changes what's on screen, so the caller
   *  can just no-op if nothing needs repositioning. Returns a disposer that
   *  stops this call from PAINTING anything further — deliberately NOT a
   *  worker-render cancel: a superseded crop's tiles usually overlap the next
   *  crop (pans are incremental), so letting them finish warms the cache the
   *  successor reads from, and the byte budget bounds the cost. resetAll is
   *  the hard cancel for sheet/group changes, where in-flight tiles really
   *  are garbage. */
  function paintDetail(
    canvas: HTMLCanvasElement, sheetKey: string, x0: number, y0: number, x1: number, y1: number,
    density: number, dark: boolean, onDone: () => void,
  ) {
    const dims = dimsBySheet.get(sheetKey);
    const levels = levelsBySheet.get(sheetKey);
    if (!dims || !levels) return { cancel() {} };
    const level = pickLevel(levels, density);
    const targetDensity = levels[level];
    const bw = Math.max(1, Math.round((x1 - x0) * targetDensity));
    const bh = Math.max(1, Math.round((y1 - y0) * targetDensity));
    canvas.width = bw; canvas.height = bh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { cancel() {} };
    const myGen = generation;
    let live = true;

    const placeholderLevel = bestPlaceholderLevel(sheetKey, levels, level, x0, y0, x1, y1, dark);
    const phDensity = levels[placeholderLevel];
    const phTiles = visibleTiles(dims.w, dims.h, levels, placeholderLevel, x0, y0, x1, y1);
    for (const t of phTiles) {
      const bmp = cache.get(modeKey(rawTileKey(sheetKey, placeholderLevel, t.tx, t.ty), dark)) as ImageBitmap | undefined;
      if (!bmp) continue;
      const dx = (t.x / phDensity - x0) * targetDensity, dy = (t.y / phDensity - y0) * targetDensity;
      const dw = (t.w / phDensity) * targetDensity, dh = (t.h / phDensity) * targetDensity;
      ctx.drawImage(bmp, dx, dy, dw, dh);
    }

    const target = visibleTiles(dims.w, dims.h, levels, level, x0, y0, x1, y1);
    // protect THIS crop's tiles from eviction while they're the visible set
    // (replaced wholesale by the next paintDetail on this sheet)
    visibleKeys.set(`${sheetKey}|detail`, new Set(target.map((t) => modeKey(rawTileKey(sheetKey, level, t.tx, t.ty), dark))));
    Promise.all(target.map(async (t) => {
      const bmp = await getOrFetchTile(sheetKey, level, t.tx, t.ty, targetDensity, dark);
      if (!bmp || !live || myGen !== generation) return;
      const dx = t.x - x0 * targetDensity, dy = t.y - y0 * targetDensity;
      ctx.drawImage(bmp, dx, dy);
      onDone();
    })).catch(() => {});

    return { cancel() { live = false; } };
  }

  function dispose() { resetAll(); pool.dispose(); }

  return { openSheet, resetAll, paintBase, paintDetail, dispose };
}
