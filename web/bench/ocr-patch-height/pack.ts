// The measurement's logic for #488, part 1, shared by the native sweep
// (scripts/measure-ocr-patch-height.mts) and the browser page (main.ts):
// pack the planned patches under a height cap and score the joined lines
// against the sheet's vector text. Measurement only: the app's planner is
// seams.ts packSpans, which this does not change.
import { nearMargin, type Assignment, type Patch, type PatchGroup, type Rect } from "../../src/lib/ocr/seams";
import type { OcrWord } from "../../src/lib/ocr/types";

export interface VectorRun { str: string; box: Rect; axis: "h" | "v" }

export const boxOf = (w: OcrWord): Rect => ({ x0: w.x, y0: w.y - w.h, x1: w.x + (w.w ?? 0), y1: w.y });
export const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const alongOf = (axis: "h" | "v", b: Rect) => (axis === "h" ? [b.x0, b.x1] : [b.y0, b.y1]);
export const acrossOf = (axis: "h" | "v", b: Rect) => (axis === "h" ? [b.y0, b.y1] : [b.x0, b.x1]);
const alnum = (s: string) => squash(s).replace(/[^A-Z0-9]/g, "").length;

/** Fewest edits that make `short` a substring of `long` (Sellers). */
function subDistance(long: string, short: string): number {
  const a = squash(long), b = squash(short);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let best = prev[b.length];
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    best = Math.min(best, cur[b.length]);
    prev = cur;
  }
  return best;
}
/** One edit per full ten characters, seams.ts textHolds' allowance. */
export const holds = (long: string, short: string) => subDistance(long, short) <= Math.floor(squash(short).length / 10);

/** A page's vector runs in image px. `transform` is pdfjs Util.transform, the
 * viewport one at the render scale. */
export function runsOf(
  items: { str?: string; transform: number[]; width: number; height: number }[],
  rs: number, viewportTransform: number[], transform: (a: number[], b: number[]) => number[],
): VectorRun[] {
  const runs: VectorRun[] = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const t = transform(viewportTransform, it.transform);
    const size = Math.hypot(t[2], t[3]) || it.height * rs;
    const len = Math.hypot(t[0], t[1]) || 1;
    const dx = t[0] / len, dy = t[1] / len, wide = it.width * rs;
    const xs = [t[4], t[4] + dx * wide, t[4] + dy * size, t[4] + dx * wide + dy * size];
    const ys = [t[5], t[5] + dy * wide, t[5] - dx * size, t[5] + dy * wide - dx * size];
    runs.push({ str: it.str.trim(), box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, axis: Math.abs(dx) >= Math.abs(dy) ? "h" : "v" });
  }
  return runs;
}

/** The vector runs a straddling line is made of. */
export function keyFor(p: Patch, g: PatchGroup, runs: VectorRun[]): string[] {
  const boxes = g.fragments.map(boxOf).map((b) => alongOf(p.axis, b));
  const f0 = Math.min(...boxes.map((b) => b[0])), f1 = Math.max(...boxes.map((b) => b[1]));
  return runs.filter((r) => {
    if (r.axis !== p.axis) return false;
    const [c0, c1] = acrossOf(p.axis, r.box), [a0, a1] = alongOf(p.axis, r.box);
    const mid = (c0 + c1) / 2;
    return mid > g.band.lo && mid < g.band.hi && a1 > f0 && a0 < f1;
  }).map((r) => r.str).filter((s) => alnum(s) >= 3);
}

/** How many of a line's runs a raster read, joining what it read on the band. */
export function score(p: Patch, g: PatchGroup, key: string[], words: OcrWord[]): number {
  const row = words.filter((w) => {
    const [c0, c1] = acrossOf(p.axis, boxOf(w));
    return c1 > g.band.lo && c0 < g.band.hi;
  }).sort((a, b) => alongOf(p.axis, boxOf(a))[0] - alongOf(p.axis, boxOf(b))[0]);
  const text = row.map((w) => w.str).join(" ");
  return key.filter((k) => holds(text, k)).length;
}

/** The patches packed under a height cap: same axis, read in order across,
 * joined while the packed raster stays within `capRender` px across and the
 * members' own text (not their stretched lengths) within the side cap. */
export function packed(a: Assignment, capRender: number): Assignment {
  const { plan } = a;
  const out: Patch[] = [];
  for (const axis of ["h", "v"] as const) {
    const mine = a.patches.filter((p) => p.axis === axis).sort((p, q) => acrossOf(axis, p.render)[0] - acrossOf(axis, q.render)[0]);
    const own = (p: Patch) => {
      const words = p.groups.flatMap((g) => g.fragments);
      const end = Math.max(...words.map((w) => 2 * nearMargin(w, plan.zoom))) + 2 / plan.zoom;
      const b = words.map(boxOf).map((r) => alongOf(axis, r));
      return [Math.min(...b.map((x) => x[0])) - end, Math.max(...b.map((x) => x[1])) + end];
    };
    let cur: { c0: number; c1: number; o0: number; o1: number; a0: number; a1: number; groups: PatchGroup[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const [ra0, ra1] = axis === "h" ? [plan.rect.x0, plan.rect.x1] : [plan.rect.y0, plan.rect.y1];
      let lo = cur.a0, hi = cur.a1;
      if (hi - lo > plan.maxSide) { lo = Math.max(ra0, (cur.o0 + cur.o1) / 2 - plan.maxSide / 2); hi = Math.min(ra1, lo + plan.maxSide); }
      out.push({ index: out.length, axis, groups: cur.groups, render: axis === "h" ? { x0: lo, x1: hi, y0: cur.c0, y1: cur.c1 } : { x0: cur.c0, x1: cur.c1, y0: lo, y1: hi } });
    };
    for (const p of mine) {
      const [c0, c1] = acrossOf(axis, p.render), [a0, a1] = alongOf(axis, p.render), [o0, o1] = own(p);
      if (cur && (Math.max(cur.c1, c1) - cur.c0) * plan.zoom <= capRender && Math.max(cur.o1, o1) - Math.min(cur.o0, o0) <= plan.maxSide) {
        cur = { c0: cur.c0, c1: Math.max(cur.c1, c1), o0: Math.min(cur.o0, o0), o1: Math.max(cur.o1, o1), a0: Math.min(cur.a0, a0), a1: Math.max(cur.a1, a1), groups: [...cur.groups, ...p.groups] };
      } else { flush(); cur = { c0, c1, o0, o1, a0, a1, groups: p.groups }; }
    }
    flush();
  }
  return { ...a, patches: out };
}

/** The vector runs in any planned patch's bands, and which the lines hold. */
export function bandRecall(a: Assignment, lines: OcrWord[], runs: VectorRun[]) {
  const wanted = runs.filter((r) => alnum(r.str) >= 3 && a.patches.some((p) => p.axis === r.axis && p.groups.some((g) => {
    const [c0, c1] = acrossOf(p.axis, r.box), mid = (c0 + c1) / 2;
    return mid > g.band.lo && mid < g.band.hi;
  })));
  const missed: string[] = [];
  for (const r of wanted) {
    const [k0, k1] = acrossOf(r.axis, r.box), mid = (k0 + k1) / 2;
    const row = lines.filter((w) => {
      const [c0, c1] = acrossOf(r.axis, boxOf(w));
      return c1 > mid && c0 < mid;
    }).sort((x, y) => alongOf(r.axis, boxOf(x))[0] - alongOf(r.axis, boxOf(y))[0]);
    if (!holds(row.map((w) => w.str).join(" "), r.str)) missed.push(r.str);
  }
  return { wanted: wanted.length, read: wanted.length - missed.length, missed };
}
