// Tiled OCR reads and their seams (#471). Pure and DOM-free: the renders and
// the engine run elsewhere (rasterize.ts, the worker); this plans the rasters
// and joins what they read, so a page too big for one raster reads as if it
// were one.
//
// A read covers `rect` (image px at the sheet's render scale `rs`, like a
// marquee). planTiles cuts it into balanced cores that partition it,
// half-open [x0,x1) and closed at the rect's far edge, and renders each core
// with `overlapPt` points of overlap, sized so every raster reaches the
// target DPI exactly (ocrRenderFactor never has to shrink it).
//
// The engine returns text lines, not words, so a seam can cut a long line.
// A line is *near* a raster's inner edge (a side not on `rect`) when it is
// within max(3 render px, h) of it: ppu rounds its boxes, and the engine
// drops a glyph the edge cuts, box and all, so a cut line can end short of
// the edge by up to a capital's advance (0.64–0.79·h measured on the demo
// plan; see nearMargin).
//   • A line near no inner edge is whole. It is kept once: from the tile
//     whose core holds its centre if whole there, else from any tile where
//     it is whole (admit: a duplicate is another read's line with IoU ≥ 0.5,
//     or one that holds it and its text; a longer read of the same ink
//     replaces the shorter; two reads of one row as overlapping pieces,
//     each cut past the near margin, are joined into one line when their
//     texts overlap by the width their boxes do; see mergeRow).
//   • A fragment (near an inner edge) that kept lines account for is
//     dropped. What is left belongs to true straddlers, grouped by line.
//     Each group's patch is sized to the line (its fragments, and kept lines
//     it runs into on its row) plus end margins; the axis comes from the
//     edge the fragment is near. Across, each edge sits in the widest clear
//     gap between the rows beside the band, so it cuts no neighbour's ink.
//     Neighbouring groups on one seam share a
//     patch while it fits the cap both ways, so a table across a seam is one
//     raster, not one per row. From a patch, lines in a group's band and
//     over one of its fragments join `kept` through admit, patch by patch.
//   • A line longer than a patch holds (about 19 in at 216 DPI) is kept as
//     its fragments, flagged `clipped`, and so is any fragment its patch
//     didn't read back. Nothing a tile read is silently lost.
// A seam in a gap between words wider than the near margin, on a row with no
// straddler, gives two kept lines (each whole): the text is right, the line
// is split.
//
// Vertical lines are handled on the same rules, with h the box's short side
// (a vertical line's h is its length); the engine reading them isn't shown.
//
// createSeamRun is the step driver regionRead uses: next raster, its words,
// progress in two phases (tiles n/N, then seams n/M).
import type { OcrWord } from "./types";
import { OCR_TARGET_DPI } from "./rasterize";
import { SCAN_MAX_DIM } from "../scheduleScan";
import { MAX_CANVAS_AREA, MAX_CANVAS_DIM } from "../canvasConstants.js";

/** Bump whenever the keep, patch or merge rules change: saved page reads are keyed on it. */
export const SEAM_RULES_VERSION = 2;

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface SeamTile {
  index: number;
  /** the part of `rect` this tile owns; half-open unless closedX/closedY */
  core: Rect;
  /** what is rendered: core ± overlap, clipped to `rect` */
  render: Rect;
  /** the core includes its far edge: the last column / row */
  closedX: boolean;
  closedY: boolean;
}

export interface TilePlan {
  /** the read's rect, corners in order */
  rect: Rect;
  rs: number;
  /** pass to rasterizeRegion so it renders at `zoom` */
  dpi: number;
  /** render factor relative to rs: dpi / (72·rs) */
  zoom: number;
  /** image px */
  overlap: number;
  /** the longest raster side, image px, that still renders at `zoom` */
  maxSide: number;
  /** row-major */
  tiles: SeamTile[];
}

export interface TilePlanOptions { dpi?: number; overlapPt?: number }

/** A line in image px; `clipped` when it's a piece of a line no raster
 * read whole. Neighbouring pieces overlap where their tiles did (up to
 * 2 × overlapPt), so the text of clipped pieces repeats there: they are not
 * trimmed, since a cut by width would split glyphs. */
export type SeamLine = OcrWord & { clipped?: true };

/** A kept line and the read it came from ("t3", "p0"). */
export interface KeptLine { word: OcrWord; src: string }

/** The fragments of one straddling line, and their extent across the line's
 * axis (image px). */
export interface PatchGroup { band: { lo: number; hi: number }; fragments: OcrWord[] }

/** One raster across a seam, for one or more neighbouring straddlers. */
export interface Patch {
  index: number;
  render: Rect;
  /** the axis its lines run along */
  axis: "h" | "v";
  groups: PatchGroup[];
}

/** The tiles' reads, sorted: lines kept so far, patches still to read, and
 * fragments of lines too long for any patch. */
export interface Assignment {
  plan: TilePlan;
  kept: KeptLine[];
  patches: Patch[];
  oversize: OcrWord[];
}

/** One raster to read: rasterizeRegion(page, plan.rs, render, { dpi }),
 * which renders it at `zoom`. */
export interface SeamJob { kind: "tile" | "patch"; index: number; render: Rect; dpi: number; zoom: number }

/** `done`/`total` count the current phase; `rastersDone`/`rastersPlanned`
 * count every raster (patches join the plan when the tiles are in). */
export interface SeamProgress {
  phase: "tiles" | "seams";
  done: number;
  total: number;
  rastersDone: number;
  rastersPlanned: number;
}

export interface SeamRun {
  /** the raster to read next; null when the read is done */
  next(): SeamJob | null;
  /** the words read for `job`, which must be the one next() names; any
   * other (late, repeated, after the end) throws */
  accept(job: SeamJob, words: OcrWord[]): void;
  progress(): SeamProgress;
  /** the joined lines, image px; throws until the read is done */
  lines(): SeamLine[];
}

function tileGrid(rect: Rect, rs: number, opts: TilePlanOptions) {
  const { dpi = OCR_TARGET_DPI, overlapPt = 72 } = opts;
  const r = { x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1) };
  const zoom = dpi / (72 * Math.max(1e-6, rs));
  const limit = Math.min(SCAN_MAX_DIM, MAX_CANVAS_DIM, Math.sqrt(MAX_CANVAS_AREA)) / zoom;
  const maxSide = Math.floor(limit) - 1;
  const overlap = overlapPt * rs;
  const coreMax = maxSide - 2 * overlap;
  if (!(coreMax > 0)) throw new RangeError("overlap leaves no room for a core");
  const count = (a0: number, a1: number) => Math.max(1, Math.ceil((a1 - a0) / coreMax));
  return { r, dpi, zoom, maxSide, overlap, count };
}

/** How many tiles planTiles would cut `rect` into, without building them. */
export function tileCount(rect: Rect, rs: number, opts: TilePlanOptions = {}): number {
  const g = tileGrid(rect, rs, opts);
  return g.count(g.r.x0, g.r.x1) * g.count(g.r.y0, g.r.y1);
}

/** Plan the rasters for a read of `rect` (image px at `rs`, any corner
 * order). The side cap is the one rasterizeRegion applies (the scan cap and
 * the canvas caps, via ocrRenderFactor), floored less 1 px so every raster's
 * factor is exactly dpi/(72·rs). */
export function planTiles(rect: Rect, rs: number, opts: TilePlanOptions = {}): TilePlan {
  const { r, dpi, zoom, maxSide, overlap, count } = tileGrid(rect, rs, opts);
  const cuts = (a0: number, a1: number) => {
    const n = count(a0, a1);
    const b: number[] = [];
    for (let k = 0; k < n; k++) b.push(a0 + ((a1 - a0) * k) / n);
    b.push(a1);
    return b;
  };
  const xs = cuts(r.x0, r.x1), ys = cuts(r.y0, r.y1);
  const tiles: SeamTile[] = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
    const core = { x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] };
    tiles.push({
      index: tiles.length, core,
      render: { x0: Math.max(r.x0, core.x0 - overlap), y0: Math.max(r.y0, core.y0 - overlap), x1: Math.min(r.x1, core.x1 + overlap), y1: Math.min(r.y1, core.y1 + overlap) },
      closedX: i + 2 === xs.length, closedY: j + 2 === ys.length,
    });
  }
  return { rect: r, rs, dpi, zoom, overlap, maxSide, tiles };
}

/** Whether (x, y) is in the tile's core: half-open, the far edge closed. */
export function inCore(tile: SeamTile, x: number, y: number): boolean {
  const c = tile.core;
  return x >= c.x0 && (x < c.x1 || (tile.closedX && x === c.x1)) && y >= c.y0 && (y < c.y1 || (tile.closedY && y === c.y1));
}

/** How close to an inner edge, image px, counts as near it: max(3 render px,
 * h), h the box's short side. The engine drops a glyph the edge cuts, box
 * and all, so a cut line can end up to a capital's advance short of the
 * edge: 0.64–0.79·h on the demo plan (one plan, #471), where the nearest
 * whole lines sat 1.05·h and 1.48·h in; 1.2·h added a patch for a whole line
 * there. */
export function nearMargin(word: OcrWord, zoom: number): number {
  return Math.max(3 / zoom, Math.min(word.w, word.h));
}

/** The slack for matching boxes that two reads drew around the same ink
 * (covered, grouping, a patch growing over its row): max(3 render px,
 * 0.6·h). Not the near margin: a fragment may overhang a kept line by this
 * much and still be the same line, but not by a glyph. */
function slackOf(word: OcrWord, zoom: number): number {
  return Math.max(3 / zoom, 0.6 * Math.min(word.w, word.h));
}

/** Sort the tiles' reads (one array per tile, in plan order) into kept
 * lines and the patches still to read. */
export function assignLines(plan: TilePlan, tileWords: OcrWord[][]): Assignment {
  if (tileWords.length !== plan.tiles.length) throw new RangeError(`${tileWords.length} tile reads for ${plan.tiles.length} tiles`);
  const entries: Entry[] = [];
  tileWords.forEach((words, i) => {
    const t = plan.tiles[i], inner = innerEdges(t.render, plan.rect);
    for (const word of words) {
      const b = boxOf(word);
      const sides = nearSides(b, word, t.render, inner, plan.zoom);
      entries.push({ word, src: `t${i}`, sides, v: sides.left || sides.right, h: sides.top || sides.bottom, owned: inCore(t, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) });
    }
  });
  // Whole lines, kept once: the centre-owner's read first, then any other
  // read where the line is whole (admit: duplicates across reads).
  const kept: KeptLine[] = [];
  const whole = entries.filter(e => !e.v && !e.h);
  for (const e of [...whole.filter(e => e.owned), ...whole.filter(e => !e.owned)]) admit(kept, e.word, e.src);
  // A fragment of a line some tile read whole is done with; only the rest,
  // true straddlers, need a patch.
  const fragments = entries.filter(e => (e.v || e.h) && !covered(e.word, kept, plan.zoom));
  const spans: Span[] = [];
  const oversize: OcrWord[] = [];
  for (const group of groupFragments(fragments, plan.zoom)) {
    const span = spanFor(plan, group, kept, entries.map(e => e.word));
    if (span) spans.push(span);
    else oversize.push(...group.map(e => e.word));
  }
  return { plan, kept, patches: packSpans(plan, spans), oversize };
}

/** Finish the join with each patch's read, in patch order. From a patch,
 * keep the whole lines (clear of its inner edges) that cross the group's
 * band and aren't already kept; `kept` grows as each patch is taken, so two
 * patches that both read a line keep it once. A group whose patch read no
 * line covering a fragment keeps that fragment, as does a line too long for
 * a patch: flagged `clipped`, never dropped. */
export function joinPatches(a: Assignment, patchWords: OcrWord[][]): SeamLine[] {
  if (patchWords.length !== a.patches.length) throw new RangeError(`${patchWords.length} patch reads for ${a.patches.length} patches`);
  const { plan } = a;
  const kept = [...a.kept];
  a.patches.forEach((p, j) => {
    const inner = innerEdges(p.render, plan.rect), src = `p${j}`;
    const along = (r: Rect) => (p.axis === "h" ? [r.x0, r.x1] : [r.y0, r.y1]);
    const across = (r: Rect) => (p.axis === "h" ? [r.y0, r.y1] : [r.x0, r.x1]);
    for (const word of patchWords[j]) {
      const b = boxOf(word);
      const [lo, hi] = across(b), [a0, a1] = along(b);
      // in a group's band, and over one of that group's fragments
      const mine = p.groups.some(g => hi > g.band.lo && lo < g.band.hi
        && g.fragments.some(f => { const [f0, f1] = along(boxOf(f)); return a1 > f0 && a0 < f1; }));
      if (!mine) continue;
      const n = nearSides(b, word, p.render, inner, plan.zoom);
      if (n.left || n.right || n.top || n.bottom) continue;
      admit(kept, word, src);
    }
  });
  const unread = a.patches.flatMap(p => p.groups.flatMap(g => g.fragments.filter(f => !covered(f, kept, plan.zoom))));
  const flag = (w: OcrWord): SeamLine => ({ ...w, clipped: true });
  return [...kept.map(k => k.word), ...unread.map(flag), ...a.oversize.map(flag)];
}

/** Step through a tiled read one raster at a time: `next()` names the raster
 * to read (every tile, then every patch, which are known once the last tile
 * is in), `accept()` takes its words. The caller renders and recognizes, so
 * it owns ordering, abort and errors. */
export function createSeamRun(plan: TilePlan): SeamRun {
  const tileWords: OcrWord[][] = [], patchWords: OcrWord[][] = [];
  let assignment: Assignment | null = null;
  let final: SeamLine[] | null = null;
  const n = plan.tiles.length;
  function next(): SeamJob | null {
    if (tileWords.length < n) {
      const t = plan.tiles[tileWords.length];
      return { kind: "tile", index: t.index, render: t.render, dpi: plan.dpi, zoom: plan.zoom };
    }
    const p = final ? undefined : assignment?.patches[patchWords.length];
    return p ? { kind: "patch", index: p.index, render: p.render, dpi: plan.dpi, zoom: plan.zoom } : null;
  }
  return {
    next,
    accept(job, words) {
      const due = next();
      if (!due || due.kind !== job.kind || due.index !== job.index) {
        throw new Error(`${job.kind} ${job.index} is not the job outstanding (${due ? `${due.kind} ${due.index}` : "none"})`);
      }
      if (tileWords.length < n) {
        tileWords.push(words);
        if (tileWords.length === n) assignment = assignLines(plan, tileWords);
      } else patchWords.push(words);
      if (assignment && patchWords.length === assignment.patches.length) final = joinPatches(assignment, patchWords);
    },
    progress() {
      const m = assignment?.patches.length ?? 0;
      if (!assignment || m === 0) return { phase: "tiles", done: tileWords.length, total: n, rastersDone: tileWords.length, rastersPlanned: n + m };
      return { phase: "seams", done: patchWords.length, total: m, rastersDone: n + patchWords.length, rastersPlanned: n + m };
    },
    lines() {
      if (!final) throw new Error("the read isn't finished");
      return final;
    },
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/** One line from one read, classified against that read's inner edges:
 * v near a vertical edge (left/right), h near a horizontal one. */
interface Entry { word: OcrWord; src: string; sides: Edges; v: boolean; h: boolean; owned: boolean }
interface Edges { left: boolean; right: boolean; top: boolean; bottom: boolean }

const boxOf = (w: OcrWord): Rect => ({ x0: w.x, y0: w.y - w.h, x1: w.x + w.w, y1: w.y });
const area = (b: Rect) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const sizeOf = (w: OcrWord) => Math.min(w.w, w.h);

function iou(a: Rect, b: Rect): number {
  const inter = area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

const inside = (a: Rect, b: Rect, tol: number) =>
  a.x0 >= b.x0 - tol && a.y0 >= b.y0 - tol && a.x1 <= b.x1 + tol && a.y1 <= b.y1 + tol;

/** A raster's inner edges: the sides not on the read's rect. Text there may
 * go on past the raster; at the rect's own boundary it can't. */
const innerEdges = (render: Rect, rect: Rect): Edges => ({
  left: render.x0 > rect.x0, right: render.x1 < rect.x1, top: render.y0 > rect.y0, bottom: render.y1 < rect.y1,
});

/** Which inner edges of `render` the box is near. */
function nearSides(b: Rect, word: OcrWord, render: Rect, inner: Edges, zoom: number): Edges {
  const m = nearMargin(word, zoom);
  return {
    left: inner.left && b.x0 - render.x0 <= m, right: inner.right && render.x1 - b.x1 <= m,
    top: inner.top && b.y0 - render.y0 <= m, bottom: inner.bottom && render.y1 - b.y1 <= m,
  };
}

const interArea = (a: Rect, b: Rect) =>
  area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Add `word` (from read `src`) to `kept` unless another read already has
 * that line. Against each kept line from another read:
 *   • `word` is longer and holds ≥ 80% of its box: the same ink read more
 *     fully (a patch across the seam the tile cut in a gap). If `word`'s
 *     text holds its text exactly (spaces ignored), `word` replaces it;
 *     otherwise both stay (a misread can't prove it's the same text, and
 *     for search a duplicate beats a miss);
 *   • it holds ≥ 80% of `word`'s box and `word`'s text (textHolds, a
 *     misread glyph in ten allowed): `word` is the duplicate;
 *   • else IoU ≥ 0.5 is a duplicate.
 * "Longer" is along the line by a line height or more, not just more
 * characters: two reads of one ink, one misread with extra characters, are
 * a duplicate by IoU. Before all that, two pieces of one row (mergeRow) are
 * joined, and the joined line is admitted in their place.
 * Lines from one read are never duplicates: the engine found two. A joined
 * line counts as from both its reads. */
function admit(kept: KeptLine[], word: OcrWord, src: string): void {
  const b = boxOf(word), replaced: KeptLine[] = [];
  const srcs = src.split("+");
  for (const k of kept) {
    if (k.src.split("+").some(s => srcs.includes(s))) continue;
    const merged = mergeRow(k.word, word);
    if (merged) {
      kept.splice(kept.indexOf(k), 1);
      admit(kept, merged, `${k.src}+${src}`);
      return;
    }
    const kb = boxOf(k.word), inter = interArea(b, kb);
    if (inter >= 0.8 * area(kb) && squash(word.str).length > squash(k.word.str).length && lengthOf(word) >= lengthOf(k.word) + sizeOf(k.word)) {
      if (squash(word.str).includes(squash(k.word.str))) replaced.push(k);
      continue;
    }
    if ((inter >= 0.8 * area(b) && textHolds(k.word.str, word.str)) || iou(b, kb) >= 0.5) {
      // A duplicate must not erase another view's code-check warning.
      if (word.codeAlternate !== undefined && k.word.codeAlternate === undefined) {
        k.word = { ...k.word, codeAlternate: word.codeAlternate !== k.word.str ? word.codeAlternate : word.str !== k.word.str ? word.str : "" };
      }
      return;
    }
  }
  if (word.codeAlternate === undefined && replaced.some((k) => k.word.codeAlternate !== undefined)) word = { ...word, codeAlternate: "" };
  for (const k of replaced) kept.splice(kept.indexOf(k), 1);
  kept.push({ word, src });
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** A line's extent along itself. */
const lengthOf = (w: OcrWord) => Math.max(w.w, w.h);

/** Two reads of one row as overlapping pieces: on the same row (sharing
 * half a line height), overlapping along it, one starting a line height or
 * more before the other and the other ending a line height or more after:
 * each tile read its piece whole up to a cut whose glyphs it dropped. They
 * are one row only when the text says so: the left piece ends with what the
 * right one starts with (one edit in ten allowed, three characters at
 * least), and the boxes overlap by that shared text's width, give or take
 * one character (each piece's width over its characters; a box edge sits on
 * its glyphs to about a pixel, and one shared glyph's width differs from
 * the average by less than one; on the demo plan's doubled row the
 * difference was 3.5 px of a 7.7 px character). Joined: the left piece,
 * then the right one past the shared characters; the box is the union.
 * Null otherwise: two different lines (or a short token like "P-1" ending
 * one cell and starting the next) both stay, never spliced. */
function mergeRow(a: OcrWord, b: OcrWord): OcrWord | null {
  const horiz = a.w >= a.h;
  if ((b.w >= b.h) !== horiz) return null;
  const ab = boxOf(a), bb = boxOf(b);
  const along = (r: Rect) => (horiz ? [r.x0, r.x1] : [r.y0, r.y1]);
  const across = (r: Rect) => (horiz ? [r.y0, r.y1] : [r.x0, r.x1]);
  const h = Math.min(sizeOf(a), sizeOf(b));
  const [ac0, ac1] = across(ab), [bc0, bc1] = across(bb);
  if (Math.min(ac1, bc1) - Math.max(ac0, bc0) < 0.5 * h) return null;
  let [[l0, l1], [r0, r1]] = [along(ab), along(bb)];
  let left = a, right = b;
  if (r0 < l0) { [left, right] = [b, a]; [[l0, l1], [r0, r1]] = [[r0, r1], [l0, l1]]; }
  const overlap = Math.min(l1, r1) - r0;
  if (!(overlap > 0 && r0 - l0 >= h && r1 - l1 >= h && left.str.length && right.str.length)) return null;
  const cwL = (l1 - l0) / left.str.length, cwR = (r1 - r0) / right.str.length, cw = (cwL + cwR) / 2;
  const str = joinTexts(left.str, right.str, (nL, nR) => Math.abs(overlap - (nL * cwL + nR * cwR) / 2) <= cw);
  if (str === null) return null;
  const u = { x0: Math.min(ab.x0, bb.x0), y0: Math.min(ab.y0, bb.y0), x1: Math.max(ab.x1, bb.x1), y1: Math.max(ab.y1, bb.y1) };
  const out: OcrWord = { str, x: u.x0, y: u.y1, w: u.x1 - u.x0, h: u.y1 - u.y0 };
  if (a.confidence !== undefined && b.confidence !== undefined) out.confidence = Math.min(a.confidence, b.confidence);
  if (a.codeAlternate !== undefined || b.codeAlternate !== undefined) out.codeAlternate = "";
  return out;
}

/** `left`, then `right` past the longest run of its first characters that
 * `left` ends with (spaces ignored, one mismatch per full ten characters,
 * at least three) for which `fits` holds, or null. `fits` gets how many
 * characters, spaces included, the shared run spans in each. */
function joinTexts(left: string, right: string, fits: (inLeft: number, inRight: number) => boolean): string | null {
  const L = [...left].flatMap((c, i) => (/\s/.test(c) ? [] : [[c, i] as const]));
  const R = [...right].flatMap((c, i) => (/\s/.test(c) ? [] : [[c, i] as const]));
  for (let k = Math.min(L.length, R.length); k >= 3; k--) {
    const allow = Math.floor(k / 10);
    let bad = 0;
    for (let i = 0; i < k && bad <= allow; i++) if (L[L.length - k + i][0] !== R[i][0]) bad++;
    if (bad <= allow && fits(left.length - L[L.length - k][1], R[k - 1][1] + 1)) return left + right.slice(R[k - 1][1] + 1);
  }
  return null;
}

/** Whether `long` contains `short` (spaces ignored), with one edit per full
 * ten characters of `short` (so under ten, exactly): an approximate
 * substring match (Sellers). */
function textHolds(long: string, short: string): boolean {
  const a = squash(long), b = squash(short);
  const k = Math.floor(b.length / 10);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  if (prev[b.length] <= k) return true;
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (cur[b.length] <= k) return true;
    prev = cur;
  }
  return false;
}

/** A fragment is covered when the kept lines on its row account for it:
 * one it mostly coincides with (IoU ≥ 0.5, which catches a box unpad
 * stretched to the edge) or lies inside, give or take its near margin, or
 * several that between them span 80% of it along the row (a patch that
 * split the line). A row is sharing half a line's height. */
function covered(word: OcrWord, kept: KeptLine[], zoom: number): boolean {
  const b = boxOf(word), tol = slackOf(word, zoom);
  const horiz = b.x1 - b.x0 >= b.y1 - b.y0;
  const along = (r: Rect) => (horiz ? [r.x0, r.x1] : [r.y0, r.y1]);
  const across = (r: Rect) => (horiz ? [r.y0, r.y1] : [r.x0, r.x1]);
  const [f0, f1] = along(b), [c0, c1] = across(b);
  const runs: [number, number][] = [];
  for (const k of kept) {
    const kb = boxOf(k.word);
    if (iou(b, kb) >= 0.5 || inside(b, kb, tol)) return true;
    const [k0, k1] = across(kb);
    if (Math.min(c1, k1) - Math.max(c0, k0) < 0.5 * Math.min(sizeOf(word), sizeOf(k.word))) continue;
    const [a0, a1] = along(kb);
    if (a1 > f0 && a0 < f1) runs.push([Math.max(a0, f0), Math.min(a1, f1)]);
  }
  runs.sort((p, q) => p[0] - q[0]);
  let len = 0, end = -Infinity;
  for (const [r0, r1] of runs) { if (r1 > end) { len += r1 - Math.max(r0, end); end = r1; } }
  return len >= 0.8 * (f1 - f0) && f1 > f0;
}

/** The axis a fragment's line runs along: from the edge it's near (a
 * vertical edge cuts a horizontal line), its shape only when near both. */
const axisOf = (e: Entry): "h" | "v" =>
  e.v && !e.h ? "h" : e.h && !e.v ? "v" : e.word.w >= e.word.h ? "h" : "v";

/** Fragments of one line: same axis, sharing at least half a line's height
 * across it, and touching (within a near margin) along it. */
function groupFragments(frags: Entry[], zoom: number): Entry[][] {
  const parent = frags.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const span = (e: Entry) => {
    const b = boxOf(e.word);
    return axisOf(e) === "h" ? { a0: b.x0, a1: b.x1, c0: b.y0, c1: b.y1 } : { a0: b.y0, a1: b.y1, c0: b.x0, c1: b.x1 };
  };
  for (let i = 0; i < frags.length; i++) for (let j = i + 1; j < frags.length; j++) {
    if (axisOf(frags[i]) !== axisOf(frags[j])) continue;
    const a = span(frags[i]), b = span(frags[j]);
    const across = Math.min(a.c1, b.c1) - Math.max(a.c0, b.c0);
    const gap = Math.max(a.a0, b.a0) - Math.min(a.a1, b.a1);
    const m = Math.max(slackOf(frags[i].word, zoom), slackOf(frags[j].word, zoom));
    if (across >= 0.5 * Math.min(sizeOf(frags[i].word), sizeOf(frags[j].word)) && gap <= m) parent[find(i)] = find(j);
  }
  const groups = new Map<number, Entry[]>();
  frags.forEach((e, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), e]); });
  return [...groups.values()];
}

/** A straddler's patch before packing: `lo..hi` along its axis, `clo..chi`
 * across it (image px, not yet clipped to the rect). */
interface Span { axis: "h" | "v"; lo: number; hi: number; clo: number; chi: number; group: PatchGroup }

/** Size one group's patch along its line: the fragments' extent, grown over
 * any kept line on the same row it runs into (a tile that cut the row in a
 * gap read that part whole; the patch may read the row as one line, which
 * then replaces it), plus two near margins and 2 render px at each end, so
 * the line reads whole even a little taller. Growth stops short of the
 * cap, so a line that fits is never lost to its neighbours. An end that is
 * a fragment cut at an inner edge with nothing read past it (its partner
 * missing) reaches toward the cap instead. Across, the band plus two line heights. Null when
 * the line can't fit the cap with its end margins. */
function spanFor(plan: TilePlan, group: Entry[], kept: KeptLine[], read: OcrWord[]): Span | null {
  const axis = axisOf(group[0]);
  const along = (w: OcrWord) => { const b = boxOf(w); return axis === "h" ? [b.x0, b.x1] : [b.y0, b.y1]; };
  const across = (w: OcrWord) => { const b = boxOf(w); return axis === "h" ? [b.y0, b.y1] : [b.x0, b.x1]; };
  let a0 = Math.min(...group.map(e => along(e.word)[0])), a1 = Math.max(...group.map(e => along(e.word)[1]));
  const c0 = Math.min(...group.map(e => across(e.word)[0])), c1 = Math.max(...group.map(e => across(e.word)[1]));
  const size = Math.max(...group.map(e => sizeOf(e.word)));
  const m = Math.max(...group.map(e => slackOf(e.word, plan.zoom)));
  const near = Math.max(...group.map(e => nearMargin(e.word, plan.zoom)));
  const row = kept.map(k => k.word).filter(w => {
    const [k0, k1] = across(w);
    return Math.min(c1, k1) - Math.max(c0, k0) >= 0.5 * Math.min(size, sizeOf(w));
  });
  const end = 2 * near + 2 / plan.zoom;
  if (a1 - a0 + 2 * end > plan.maxSide) return null;
  // grow over the row only while the patch still fits the cap; a kept line
  // that would push it over is left out (it stays kept; the straddler is
  // still read whole)
  for (let grew = true; grew;) {
    grew = false;
    for (const w of row) {
      const [k0, k1] = along(w);
      const g0 = Math.min(a0, k0), g1 = Math.max(a1, k1);
      if (k1 >= a0 - m && k0 <= a1 + m && (k0 < a0 || k1 > a1) && g1 - g0 + 2 * end <= plan.maxSide) { a0 = g0; a1 = g1; grew = true; }
    }
  }
  const lowOpen = group.some(e => along(e.word)[0] === a0 && (axis === "h" ? e.sides.left : e.sides.top));
  const highOpen = group.some(e => along(e.word)[1] === a1 && (axis === "h" ? e.sides.right : e.sides.bottom));
  let lo = a0 - end, hi = a1 + end;
  if (lowOpen && highOpen) { lo = (a0 + a1) / 2 - plan.maxSide / 2; hi = lo + plan.maxSide; }
  else if (highOpen) hi = lo + plan.maxSide;
  else if (lowOpen) lo = hi - plan.maxSide;
  const pad = Math.max(2 * size, end + 4 / plan.zoom);
  // Each edge across goes in the widest clear gap between the rows beside
  // the band, from the default out to two line heights past it (never
  // nearer the band), so no edge cuts or grazes a neighbour's ink (lines
  // kept or not); with no row there, the default.
  // Known limit: neighbours are taken over this span's own length, not the
  // packed patch's (packSpans may widen it to hold other groups), so a row
  // beside the band that only the packed length reaches can still be grazed.
  // Filtering on the packed length would move patch 0's bottom edge on the
  // demo fixture (501.3 → 500.1), so it waits for a re-capture.
  const beside = read.filter(w => {
    const [k0, k1] = along(w), [x0, x1] = across(w);
    return k1 > lo && k0 < hi && !(x1 > c0 && x0 < c1);
  }).map(across);
  const clearEdge = (w0: number, w1: number, dflt: number) => {
    const inWin = beside.filter(([x0, x1]) => x1 > w0 && x0 < w1).sort((p, q) => p[0] - q[0]);
    if (!inWin.length) return dflt;
    let best: [number, number] | null = null, at = w0;
    for (const [x0, x1] of [...inWin, [w1, w1] as [number, number]]) {
      if (x0 > at && (!best || x0 - at > best[1] - best[0])) best = [at, x0];
      at = Math.max(at, x1);
    }
    return best ? (best[0] + best[1]) / 2 : dflt;
  };
  const clo = clearEdge(c0 - pad - 2 * size, c0 - pad, c0 - pad);
  const chi = clearEdge(c1 + pad, c1 + pad + 2 * size, c1 + pad);
  return { axis, lo, hi, clo, chi, group: { band: { lo: c0, hi: c1 }, fragments: group.map(e => e.word) } };
}

/** Pack neighbouring straddlers into shared patches: spans of one axis that
 * overlap along it (the same seam), taken in order across it, join the
 * current patch while it still fits the cap both ways. Each patch is
 * clipped to the rect (its edge there isn't inner, so nothing is lost). */
function packSpans(plan: TilePlan, spans: Span[]): Patch[] {
  const patches: Patch[] = [];
  for (const axis of ["h", "v"] as const) {
    // seams: spans chained by overlapping along the axis
    const mine = spans.filter(s => s.axis === axis);
    const parent = mine.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      if (mine[i].lo < mine[j].hi && mine[j].lo < mine[i].hi) parent[find(i)] = find(j);
    }
    const seams = new Map<number, Span[]>();
    mine.forEach((s, i) => seams.set(find(i), [...(seams.get(find(i)) ?? []), s]));
    for (const seam of seams.values()) {
      seam.sort((p, q) => p.clo - q.clo);
      let cur: Omit<Span, "group"> & { groups: PatchGroup[] } | null = null;
      const flush = () => { if (cur) patches.push(toPatch(plan, cur, patches.length)); };
      for (const s of seam) {
        if (cur && Math.max(cur.hi, s.hi) - Math.min(cur.lo, s.lo) <= plan.maxSide && Math.max(cur.chi, s.chi) - Math.min(cur.clo, s.clo) <= plan.maxSide) {
          cur = { axis, lo: Math.min(cur.lo, s.lo), hi: Math.max(cur.hi, s.hi), clo: Math.min(cur.clo, s.clo), chi: Math.max(cur.chi, s.chi), groups: [...cur.groups, s.group] };
        } else {
          flush();
          cur = { axis, lo: s.lo, hi: s.hi, clo: s.clo, chi: s.chi, groups: [s.group] };
        }
      }
      flush();
    }
  }
  return patches;
}

function toPatch(plan: TilePlan, s: Omit<Span, "group"> & { groups: PatchGroup[] }, index: number): Patch {
  const r = plan.rect;
  const [ra0, ra1, rc0, rc1] = s.axis === "h" ? [r.x0, r.x1, r.y0, r.y1] : [r.y0, r.y1, r.x0, r.x1];
  const lo = Math.max(ra0, s.lo), hi = Math.min(ra1, s.hi), clo = Math.max(rc0, s.clo), chi = Math.min(rc1, s.chi);
  const render = s.axis === "h" ? { x0: lo, y0: clo, x1: hi, y1: chi } : { x0: clo, y0: lo, x1: chi, y1: hi };
  return { index, render, axis: s.axis, groups: s.groups };
}
