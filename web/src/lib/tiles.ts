// Pure tile-pyramid math for the Takeoff Canvas (#86). No DOM, no pdf.js, no
// React — this module answers "which tiles, at what density, cover this
// region" and "what's evicted under this byte budget," nothing else. The
// worker (pdfTile.worker.ts) renders tiles; the compositor (tileCompositor.js)
// paints them; both import this for the shared vocabulary.
//
// A sheet's LOGICAL pixel space (imgW × imgH) is fixed forever at page-points
// × RENDER_SCALE (see sheets.ts) — the same space verts_norm, the snap grid,
// and vector-geometry extraction already normalize against. It is NOT a real
// backing store, so it costs nothing to leave it exactly as-is even for an
// oversized ingested-image page; only tiles (bounded to TILE_SIZE²) are ever
// actually rastered. That single fixed space is what lets factorFor collapse
// to a constant 1 (panelGeometry.js) instead of tracking a per-sheet render
// scale.
//
// A "density" is device px per logical-space px — 1.0 means "as sharp as the
// PDF vectors at the RENDER_SCALE baseline," matching the quantity the old
// DETAIL_ENGAGE check compared against (t.scale × dpr).

export const TILE_SIZE = 512;
// Coarsest level's long edge, in device px — small enough that a whole-sheet
// placeholder is one to a few tiles, cheap to keep resident forever.
export const MIN_LEVEL_PX = 768;
// Reuses the old QUALITY_CEILING's intent (≈576 px/in-equivalent deep zoom)
// as the top of the pyramid, relative to the RENDER_SCALE=2 logical baseline.
// That intent works out to 4, not 8: 576 px/in ÷ 72 pt/in = 8 device px per
// POINT, and the logical space is already 2 px per point (RENDER_SCALE), so
// the density multiplier on top of it is 8/2 = 4. Shipping 8 asked pdf.js to
// render each tile at scale RENDER_SCALE×8 = 16 — a >100k-px viewport on an
// E-size sheet — and quadrupled the tile count for the same crop. Measured on
// the hosted demo at 259% zoom: not one level-8 tile ever completed (no
// error, they simply never finished), so the detail layer sat on the base
// placeholder upscaled 16× — the "so so pixelated" report. Deep zoom is
// exactly where a tile must still be CHEAP, because that's where the pyramid
// has the most tiles to produce.
export const MAX_DENSITY = 4;

/** Level id for the whole-sheet BASE composite. Deliberately outside the
 *  pyramid's 0..n index range so its cache keys can never collide with a
 *  real level's — the base is rendered at its own exact-fit density (see
 *  fitDensity), not at a power-of-two level. */
export const BASE_LEVEL = -1;

/** The exact density whose full-sheet composite hits `targetArea` device px.
 *  The pyramid is power-of-two, so snapping a budget DOWN to a level wastes
 *  most of it: on a 7920×5280 sheet a 28MP budget admits density 0.818, but
 *  the nearest level at-or-under is 0.5 — 10.4MP, 37% of the budget and a
 *  1.6× LINEAR regression against the single raster this replaced. The base
 *  layer is whatever a fast pan and any zoom past the pyramid's top actually
 *  shows, so that shortfall is visible constantly. Never denser than 1.0:
 *  past the RENDER_SCALE baseline there is no more detail to recover, only
 *  supersampling a whole sheet nobody asked for. */
export function fitDensity(imgW: number, imgH: number, targetArea: number): number {
  const area = Math.max(1, imgW * imgH);
  return Math.min(1, Math.sqrt(targetArea / area));
}

/** Density multiplier for each level, ascending, level index = array index.
 *  Always includes 1.0 (the native baseline) as a level boundary so pickLevel
 *  never has to interpolate across the DETAIL_ENGAGE-equivalent seam. */
export function buildLevels(imgW: number, imgH: number): number[] {
  const long = Math.max(1, imgW, imgH);
  let d = Math.pow(2, Math.ceil(Math.log2(MIN_LEVEL_PX / long)));
  d = Math.min(1, Math.max(Math.pow(2, -6), d)); // never start denser than native, floor at 1/64
  const levels: number[] = [];
  while (d < 1) { levels.push(d); d *= 2; }
  d = 1;
  while (d <= MAX_DENSITY) { levels.push(d); d *= 2; }
  return levels;
}

/** Index of the lowest-index level whose density already covers
 *  `requiredDensity` (never blurrier than asked); clamps to the top level
 *  once past MAX_DENSITY rather than growing the pyramid unboundedly. */
export function pickLevel(levels: number[], requiredDensity: number): number {
  for (let i = 0; i < levels.length; i++) if (levels[i] >= requiredDensity) return i;
  return levels.length - 1;
}

export function levelDims(imgW: number, imgH: number, density: number) {
  return { w: Math.max(1, Math.ceil(imgW * density)), h: Math.max(1, Math.ceil(imgH * density)) };
}

export function tileGrid(imgW: number, imgH: number, density: number) {
  const { w, h } = levelDims(imgW, imgH, density);
  return { cols: Math.ceil(w / TILE_SIZE), rows: Math.ceil(h / TILE_SIZE), w, h };
}

export function tileKey(sheetKey: string, level: number, tx: number, ty: number) {
  return `${sheetKey}:${level}:${tx}:${ty}`;
}

/** Tile rect in LEVEL px (edge tiles are smaller than TILE_SIZE). */
export function tileRect(level: number, tx: number, ty: number, levelW: number, levelH: number) {
  const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
  return { x, y, w: Math.min(TILE_SIZE, levelW - x), h: Math.min(TILE_SIZE, levelH - y) };
}

export interface VisibleTile { level: number; tx: number; ty: number; x: number; y: number; w: number; h: number; }

/** Every tile at `level` intersecting the region [x0,y0,x1,y1) given in the
 *  sheet's LOGICAL (imgW×imgH) px space. Returns rects in level px. */
export function visibleTiles(
  imgW: number, imgH: number, levels: number[], level: number,
  x0: number, y0: number, x1: number, y1: number,
): VisibleTile[] {
  return visibleTilesAtDensity(imgW, imgH, levels[level], level, x0, y0, x1, y1);
}

/** visibleTiles for a density that is NOT a pyramid level — the base layer's
 *  exact-fit density. `level` is carried through untouched purely as the id
 *  the caller will key the cache on (BASE_LEVEL for the base). */
export function visibleTilesAtDensity(
  imgW: number, imgH: number, density: number, level: number,
  x0: number, y0: number, x1: number, y1: number,
): VisibleTile[] {
  const { w: levelW, h: levelH } = levelDims(imgW, imgH, density);
  const lx0 = Math.max(0, Math.floor(x0 * density));
  const ly0 = Math.max(0, Math.floor(y0 * density));
  const lx1 = Math.min(levelW, Math.ceil(x1 * density));
  const ly1 = Math.min(levelH, Math.ceil(y1 * density));
  if (lx1 <= lx0 || ly1 <= ly0) return [];
  const txMin = Math.floor(lx0 / TILE_SIZE), txMax = Math.floor((lx1 - 1) / TILE_SIZE);
  const tyMin = Math.floor(ly0 / TILE_SIZE), tyMax = Math.floor((ly1 - 1) / TILE_SIZE);
  const out: VisibleTile[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const r = tileRect(level, tx, ty, levelW, levelH);
      out.push({ level, tx, ty, ...r });
    }
  }
  return out;
}

/** device px per logical px on screen right now — the same quantity the old
 *  detail view compared against DETAIL_ENGAGE. */
export const requiredDensity = (stageScale: number, dpr: number) => stageScale * dpr;

interface Entry { bytes: number; value: unknown; }

/** LRU keyed by tile key, evicted by a total-byte budget. Protected keys (the
 *  currently-visible set, from `protect` or the constructor's provider) are
 *  never evicted even if least-recently-used — a settle-then-immediately-
 *  re-fetch loop would otherwise thrash the very tiles on screen. `onEvict`
 *  fires for every value leaving the cache (evict / replace / clear) so the
 *  owner can release non-GC-tracked backing memory — an ImageBitmap holds its
 *  pixels until close(), so without this the byte budget only bounds what the
 *  cache COUNTS, not what the process actually holds. */
export class TileLRU {
  private map = new Map<string, Entry>();
  private total = 0;
  constructor(
    public maxBytes: number,
    private onEvict?: (value: unknown) => void,
    private protectProvider?: () => Set<string> | undefined,
  ) {}

  get size() { return this.total; }
  has(key: string) { return this.map.has(key); }

  get(key: string): unknown {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key); this.map.set(key, e); // touch → most-recently-used
    return e.value;
  }

  set(key: string, value: unknown, bytes: number) {
    const prev = this.map.get(key);
    if (prev) { this.total -= prev.bytes; if (prev.value !== value) this.onEvict?.(prev.value); }
    this.map.set(key, { value, bytes });
    this.total += bytes;
    this.evictToBudget();
  }

  delete(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.bytes;
    this.map.delete(key);
    this.onEvict?.(e.value);
  }

  /** Explicit `protect` wins; otherwise the constructor's provider is asked.
   *  If the protected set alone exceeds the budget, the cache stays over
   *  budget rather than evicting on-screen tiles — deliberate. */
  evictToBudget(protect?: Set<string>) {
    if (this.total <= this.maxBytes) return;
    const shielded = protect ?? this.protectProvider?.();
    for (const key of this.map.keys()) {
      if (this.total <= this.maxBytes) break;
      if (shielded?.has(key)) continue;
      this.delete(key);
    }
  }

  clear() {
    if (this.onEvict) for (const e of this.map.values()) this.onEvict(e.value);
    this.map.clear();
    this.total = 0;
  }
}
