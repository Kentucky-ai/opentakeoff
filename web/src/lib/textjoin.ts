// Text-run joining — put a tag pdf.js split back together.
//
// pdf.js starts a new text item at every font or style change, and CAD
// exports routinely draw a boxed finish tag as three runs: "WB", "-", "01"
// (the hyphen set in a different font). The pieces touch exactly, so on the
// page it reads WB-01, but every consumer that matches a whole run — find_text,
// the sheet graph's schedule keys, sweep_schedule_row's tag labels, count_marks,
// the Symbol tool's labels — sees three strings and matches none of them.
// Measured on six SFG plan sets (EXP-OT-TAG-01): exact find_text recall on
// finish tags was 0–35% before joining and 100% after on the vector sets.
//
// The rule is ABUTMENT, not proximity: the split pieces sit within a tenth of
// a pixel of each other, while a word space is ≥ 0.25 × the glyph height. So
// two runs join only when they share a direction and a line, are set at about
// the same size, and the gap between them is at most JOIN_GAP × height — no
// space is ever invented, and ordinary words never merge. A run drawn twice
// on top of itself (fake bold) overlaps by its own width and stays separate.
// Two guards keep a tag from swallowing its neighbour where the DRAFTING
// collides (the demo plan's "VCT-1" label overlaps room number "170" by
// 1.6 px, 0.08 × height): overlap tolerance is a hair (JOIN_OVERLAP; split
// pieces measured up to 0.03 × height, a rotated "TL" + "-1"), and a run
// ending in a digit never joins a run starting with one.
//
// Pure and DOM-free, like sheets.ts / oneclick.ts: the MCP's textSpans and the
// canvas's span cache both call it, so canvas and agent read the same text.

/** A positioned run: image-px box (y down) and the reading direction in
 *  degrees (0 = left→right; absent means 0) — the shape textSpans emits. */
export interface BoxSpan { str: string; x0: number; y0: number; x1: number; y1: number; rot?: number }

/** Largest gap (fraction of glyph height) between two runs that still join.
 *  Split tag pieces measure ≈ 0.00; a word space ≈ 0.25+. */
export const JOIN_GAP = 0.08;
/** Most two runs may overlap along the line (fraction of height) and still join. */
const JOIN_OVERLAP = 0.05;
/** Line test: run centres across the line within this fraction of height. */
const LINE_TOL = 0.25;
/** Size test: heights within this ratio. */
const SIZE_TOL = 0.25;

type Axis = { a0: number; a1: number; p: number; h: number };
function axis(s: BoxSpan): Axis {
  const r = s.rot ?? 0;
  if (r === 90) return { a0: s.y0, a1: s.y1, p: (s.x0 + s.x1) / 2, h: s.x1 - s.x0 };
  if (r === 270) return { a0: -s.y1, a1: -s.y0, p: (s.x0 + s.x1) / 2, h: s.x1 - s.x0 };
  if (r === 180) return { a0: -s.x1, a1: -s.x0, p: (s.y0 + s.y1) / 2, h: s.y1 - s.y0 };
  return { a0: s.x0, a1: s.x1, p: (s.y0 + s.y1) / 2, h: s.y1 - s.y0 };
}

/** Index groups of runs that read as one string, each in reading order. Every
 *  input index appears in exactly one group; groups are ordered by their
 *  first member's input index, so a caller's reading order survives. */
export function abuttingGroups(spans: readonly BoxSpan[]): number[][] {
  const n = spans.length;
  const next = new Int32Array(n).fill(-1);
  const hasPrev = new Uint8Array(n);
  const byRot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = spans[i].rot ?? 0;
    let l = byRot.get(r);
    if (!l) byRot.set(r, (l = []));
    l.push(i);
  }
  const ax = spans.map(axis);
  for (const [rot, idx] of byRot) {
    if (rot % 90 !== 0) continue;                        // skewed text: no axis to judge a line by
    // sort along the line; for each run, the nearest following run on the same
    // line is its only join candidate (a split tag is a chain of neighbours)
    idx.sort((i, j) => ax[i].a0 - ax[j].a0);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], A = ax[i];
      if (!(A.h > 0) || !spans[i].str) continue;
      let best = -1, bestGap = Infinity;
      for (let m = k + 1; m < idx.length; m++) {
        const j = idx[m], B = ax[j];
        if (B.a0 - A.a1 > JOIN_GAP * A.h) break;           // sorted: nothing further can touch
        if (!(B.h > 0) || !spans[j].str) continue;
        const h = Math.max(A.h, B.h);
        if (Math.abs(A.h - B.h) > SIZE_TOL * h) continue;
        if (Math.abs(A.p - B.p) > LINE_TOL * h) continue;
        const gap = B.a0 - A.a1;
        if (gap < -JOIN_OVERLAP * h || gap > JOIN_GAP * h) continue;
        if (/\d$/.test(spans[i].str) && /^\d/.test(spans[j].str)) continue;   // 1|170: two numbers, not one
        if (Math.abs(gap) < Math.abs(bestGap)) { best = j; bestGap = gap; }
      }
      if (best >= 0 && !hasPrev[best] && next[i] < 0) { next[i] = best; hasPrev[best] = 1; }
    }
  }
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (hasPrev[i]) continue;
    const g = [i];
    for (let j = next[i], guard = 0; j >= 0 && guard < n; j = next[j], guard++) g.push(j);
    groups.push(g);
  }
  return groups;
}

/** The runs with every abutting chain merged into one: joined string, union
 *  box; any other fields ride from the chain's first run. Unsplit runs come
 *  back unchanged (same object). */
export function joinAbuttingSpans<T extends BoxSpan>(spans: readonly T[]): T[] {
  return abuttingGroups(spans).map((g) => {
    if (g.length === 1) return spans[g[0]];
    const first = spans[g[0]];
    let { x0, y0, x1, y1 } = first, str = first.str;
    for (const j of g.slice(1)) {
      const s = spans[j];
      str += s.str;
      x0 = Math.min(x0, s.x0); y0 = Math.min(y0, s.y0); x1 = Math.max(x1, s.x1); y1 = Math.max(y1, s.y1);
    }
    return { ...first, str, x0, y0, x1, y1 };
  });
}
