// Batch-fill detection metrics — pure core.
//
// RFC item F proposes rooms UNPROMPTED, so per-seed IoU against a hand-picked
// probe is the wrong grade: what matters is what a whole sheet's worth of
// proposals looks like. Room-level precision ("is this proposal a real room?")
// needs a full room census — human truth we don't have yet (issue #184 item
// 2). Everything here is what CAN be measured without an answer key, which is
// also where batch fill actually fails (round-9 research):
//
//   1. double-counted floor — two labels flooding one conjoined space is the
//      classic batch failure, and the bench already treats it as a gate on
//      human-measured cases (humanOverlapFrac 0.5%);
//   2. proposal quality — sub-fixture-sized regions (on the VA sheet: the
//      interior of the box drawn around the room tag, or one cell of a 1-ft
//      floor-tile grid) and outliers that dwarf the median room;
//   3. seed stability — a proposal that changes when the seed moves a foot was
//      never a measurement;
//   4. seeding reach — how many known rooms carry a label anchor at all, the
//      ceiling on recall no flood improvement can lift.
//
// Reported, never gated: these numbers describe a feature that doesn't exist
// yet. They exist so it can be built against them.
import { ringAreaAbs, polyOverlapPx2 } from "./score.ts";
import type { Point } from "../src/lib/oneclick.ts";
import { pointInPoly } from "../src/lib/geometry.js";

/** The canvas's "fixture-sized?" hint threshold — below this a region is an
 *  equipment footprint, a tag box or a tile cell, not a room. Note it cuts
 *  through a real cluster on the VA sheet (25 of 52 proposals land in
 *  3.0–4.2 SF), so the count either side of it is knife-edge; read the size
 *  distribution, not the flag count. */
export const TINY_PROPOSAL_SF = 4;
/** Two proposals whose symmetric IoU reaches this are the same space proposed
 *  twice, not neighbors touching along a wall. */
export const DUPLICATE_FRAC = 0.5;
/** One proposal this far inside another is NESTED — reported separately,
 *  because a closet inside a suite is legitimate and a duplicate is not. */
export const NESTED_FRAC = 0.9;

export interface Proposal { label: string; seed: Point; ring: Point[] }

export interface BatchMetrics {
  labels: number;              // seeds offered to the detector
  proposals: number;           // seeds that produced a region
  refused: number;             // labels the engine declined (the honest ones)
  sumProposedSF: number;
  overlapSF: number;           // floor covered by more than one proposal
  overlapFrac: number;         // as a share of the proposed total
  duplicates: Array<[string, string]>;   // label pairs that are the same space
  nested: Array<[string, string]>;       // one proposal inside another (legitimate, or a hole)
  tiny: string[];              // labels whose proposal is under TINY_PROPOSAL_SF
  minSF: number; medianSF: number; maxSF: number;
}

export function batchMetrics(proposals: Proposal[], labels: number, pxPerFt: number, cell = 4): BatchMetrics {
  const sf = (px2: number) => px2 / (pxPerFt * pxPerFt);
  const areas = proposals.map((p) => sf(ringAreaAbs(p.ring)));
  const sumProposedSF = areas.reduce((a, b) => a + b, 0);
  // Double-counted floor is Σ areas − union, counted PER CELL. Summing
  // pairwise overlaps instead (the first version of this did) triple-counts a
  // cell three proposals share and can report a fraction above 1 — four labels
  // on one 600 SF bay read as 3600 SF double-counted.
  const overlapPx2 = doubleCountedPx2(proposals.map((p) => p.ring), cell);
  const duplicates: Array<[string, string]> = [];
  const nested: Array<[string, string]> = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const ov = polyOverlapPx2(proposals[i].ring, proposals[j].ring, cell);
      if (ov <= 0) continue;
      const ai = ringAreaAbs(proposals[i].ring), aj = ringAreaAbs(proposals[j].ring);
      // Symmetric IoU, not "share of the smaller": the target is two labels
      // flooding ONE space, where both rings are the same region. Share-of-
      // smaller flagged every legitimately nested room (a closet in a suite, an
      // island in a kitchen — and traceRegion walks the outer contour, so any
      // interior room reads as nested) while MISSING the real case when two
      // large rooms leak into one shared stub.
      const iou = ov / Math.max(1e-9, ai + aj - ov);
      if (iou >= DUPLICATE_FRAC) duplicates.push([proposals[i].label, proposals[j].label]);
      else if (ov / Math.max(1e-9, Math.min(ai, aj)) >= NESTED_FRAC) nested.push([proposals[i].label, proposals[j].label]);
    }
  }
  const sorted = [...areas].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
  const overlapSF = sf(overlapPx2);
  return {
    labels,
    proposals: proposals.length,
    refused: labels - proposals.length,
    sumProposedSF,
    overlapSF,
    overlapFrac: sumProposedSF > 0 ? overlapSF / sumProposedSF : 0,
    duplicates,
    nested,
    tiny: proposals.filter((_, i) => areas[i] < TINY_PROPOSAL_SF).map((p) => p.label),
    minSF: sorted[0] ?? 0,
    medianSF: median,
    maxSF: sorted[sorted.length - 1] ?? 0,
  };
}

export interface CoverageRow { name: string; knownSF: number; coveredSF: number; frac: number }
export interface BatchCoverage {
  knownSF: number;             // Σ floor of the rooms we know about
  coveredSF: number;           // …that at least one proposal covers
  frac: number;                // coveredSF / knownSF
  rows: CoverageRow[];         // per room, worst-covered first
}

/** Floor that NO proposal covers — the metric whose absence let a regression
 *  through in round 9. Overlap, sizes, reach and recall are all blind to it:
 *  a change can drive double-counting to a perfect 0.0% by making one of the
 *  duplicates SHRINK, and every other number improves while real floor stops
 *  being proposed at all. (That is what happened: sealing the batch path took
 *  `ward-vestibule` from 66.6% covered to 0.0%, and reach/recall/overlap did
 *  not move, because its best IoU was under the 0.5 recall bar either way.)
 *
 *  `knownFloor` is whatever floor we can name — today the case's pinned
 *  goldens, which cover only part of a sheet, so this is a LOWER bound on
 *  what's missed, not a sheet-wide coverage number. It becomes the real thing
 *  when a human-measured case exists. */
export function batchCoverage(
  proposals: Proposal[],
  knownFloor: Array<{ name: string; ring: Point[] }>,
  pxPerFt: number,
  cell = 4,
): BatchCoverage {
  const sf = (px2: number) => px2 / (pxPerFt * pxPerFt);
  const rows: CoverageRow[] = knownFloor.map((k) => {
    const knownSF = sf(ringAreaAbs(k.ring));
    // union, not sum: two proposals covering the same half of a room must not
    // read as full coverage
    const covered = unionOverlapPx2(k.ring, proposals.map((p) => p.ring), cell);
    const coveredSF = sf(covered);
    return { name: k.name, knownSF, coveredSF, frac: knownSF > 0 ? Math.min(1, coveredSF / knownSF) : 1 };
  });
  const knownSF = rows.reduce((a, r) => a + r.knownSF, 0);
  const coveredSF = rows.reduce((a, r) => a + Math.min(r.coveredSF, r.knownSF), 0);
  return {
    knownSF,
    coveredSF,
    frac: knownSF > 0 ? coveredSF / knownSF : 1,
    rows: [...rows].sort((a, b) => a.frac - b.frac),
  };
}

/** Σ areas − union, counted per cell: how much floor is covered more than
 *  once, no matter how many proposals pile on it. Only samples inside pairwise
 *  bbox intersections, so it stays cheap on a sheet where most proposals are
 *  far apart. Blind to overlaps thinner than `cell` — an unavoidable floor,
 *  worth stating whenever the answer is 0. */
export function doubleCountedPx2(rings: Point[][], cell: number): number {
  const box = (r: Point[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1] as const;
  };
  const boxes = rings.map(box);
  const seen = new Set<string>();
  let extra = 0;
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = boxes[i], b = boxes[j];
      const x0 = Math.max(a[0], b[0]), x1 = Math.min(a[2], b[2]);
      const y0 = Math.max(a[1], b[1]), y1 = Math.min(a[3], b[3]);
      if (x0 >= x1 || y0 >= y1) continue;
      for (let y = Math.floor(y0 / cell) * cell + cell / 2; y <= y1; y += cell) {
        for (let x = Math.floor(x0 / cell) * cell + cell / 2; x <= x1; x += cell) {
          if (x < x0 || y < y0) continue;
          const key = `${Math.round(x / cell)},${Math.round(y / cell)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let n = 0;
          for (const r of rings) if (r.length >= 3 && pointInPoly(x, y, r)) n++;
          if (n > 1) extra += (n - 1) * cell * cell;
        }
      }
    }
  }
  return extra;
}

/** Area of `target` covered by AT LEAST ONE of `others` (cell-sampled). */
function unionOverlapPx2(target: Point[], others: Point[][], cell: number): number {
  if (target.length < 3 || !others.length) return 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of target) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let hits = 0;
  for (let y = y0 + cell / 2; y <= y1; y += cell) {
    for (let x = x0 + cell / 2; x <= x1; x += cell) {
      if (!pointInPoly(x, y, target)) continue;
      for (const o of others) {
        if (o.length >= 3 && pointInPoly(x, y, o)) { hits++; break; }
      }
    }
  }
  return hits * cell * cell;
}

export interface ReachMetrics {
  goldens: number;             // known rooms in the corpus case
  withLabel: number;           // …that contain a label anchor — the recall ceiling
  recallHalf: number;          // proposals matching a golden at IoU ≥ 0.5
  recallNine: number;          // …at IoU ≥ 0.9
}

/** Seeding reach and recall against the case's pinned goldens. `iou` is passed
 *  in (the bench's rasterized polyIoU) so this core stays arithmetic. */
export function batchReach(
  proposals: Proposal[],
  goldens: Point[][],
  seeds: Point[],
  iou: (a: Point[], b: Point[]) => number,
): ReachMetrics {
  let withLabel = 0, half = 0, nine = 0;
  for (const g of goldens) {
    if (seeds.some(([x, y]) => pointInPoly(x, y, g))) withLabel++;
    let best = 0;
    for (const p of proposals) best = Math.max(best, iou(p.ring, g));
    if (best >= 0.5) half++;
    if (best >= 0.9) nine++;
  }
  return { goldens: goldens.length, withLabel, recallHalf: half, recallNine: nine };
}

export interface StabilityRow { label: string; held: number; tried: number }

/** Jitter each proposal's seed and re-measure: a region that survives a foot
 *  of seed movement is a measurement; one that doesn't is an accident of where
 *  the label happened to sit. `remeasure` returns the re-traced RING, or null
 *  when the engine refuses.
 *
 *  Compares regions, not areas. Comparing areas (the first version of this
 *  did) calls a jitter "held" whenever it lands on a different room of similar
 *  size — on the VA sheet 7 of 94 "held" jitters had IoU 0.000 with the region
 *  they were supposedly confirming, because the plan is full of identically
 *  sized room-tag boxes. */
export function seedStability(
  proposals: Proposal[],
  remeasure: (x: number, y: number) => Point[] | null,
  offsetsPx: Array<[number, number]>,
  iou: (a: Point[], b: Point[]) => number,
  minIoU = 0.9,
): StabilityRow[] {
  return proposals.map((p) => {
    let held = 0;
    for (const [dx, dy] of offsetsPx) {
      const ring = remeasure(p.seed[0] + dx, p.seed[1] + dy);
      if (ring && ring.length >= 3 && iou(ring, p.ring) >= minIoU) held++;
    }
    return { label: p.label, held, tried: offsetsPx.length };
  });
}
