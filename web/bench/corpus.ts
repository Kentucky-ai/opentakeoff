// Synthetic benchmark corpus — every case constructs its linework AND its
// golden polygon from the same numbers, so the truth is exact by definition.
// One canvas convention throughout: 1000×800 image px, ws = 1, 18 px/ft
// (1/4" = 1'-0" at render scale 1). Each case yields probes: a seed with a
// golden ring, or a seed whose golden answer is "refuse".
//
// These cases encode the failure modes the upstream RFC enumerates: boundary
// gaps (cased openings), unclosed door swings, dense hatch, tile grids,
// curved partitions, and honest refusal on open/oversized space.
import { SEG_CURVE } from "../src/lib/oneclick";
import type { Point } from "../src/lib/oneclick";

// ── WALL-LINE SEMANTICS (audit A5b; RENAMED by audit F5) ────────────────────
// This field used to read "centerline", and that was FALSE on 60% of the
// corpus's square footage. What a golden actually traces to is a DRAWN PATH
// VERTEX: production is trace-THEN-SNAP, pulling each traced corner onto the
// nearest `extractVectorGeometry(...).points` entry within SNAP_TOL_PX (7) —
// a vertex of the PDF's own paths. Whether that vertex sits on a wall's
// centreline depends entirely on how the wall was DRAWN:
//
//   • SINGLE-STROKE wall ⇒ drawn vertex IS the centreline. Both fixture
//     generators draw walls this way, which is where the old name came from:
//       – e2e/make-fixture.cjs draws OFFICE 101 as a 216×180 pt rectangle at
//         1.6 pt stroke and e2e/one-click.e2e.cjs asserts the product measures
//         120 SF through real Chromium: 216/18 × 180/18 = 120.00 exactly.
//         Interior-clear would be (216−1.6)/18 × (180−1.6)/18 = 118.05.
//       – demo/make_sample_plan.py draws `3 w` / `120 110 980 580 re` with the
//         two interior partitions as SEPARATE strokes ("610 110 m 610 690 l S"
//         and "120 400 m 1100 400 l S").
//   • DOUBLE-LINE wall ⇒ the drawn vertices are on the wall FACES and there is
//     no centreline vertex to snap to at all. demo/sample-finish-plan.pdf (the
//     va-finish-plan case: 2580 of the corpus's 4332 golden SF, 60%) is drawn
//     that way. MEASURED on that sheet, scanning perpendicular across the
//     pinned goldens' own long straight edges: the wall lines come in parallel
//     PAIRS 7.44–9.26 image px apart at ptPerFt 18 = 4.96–6.17 in of building,
//     and each golden edge sits at offset 0.00 from ONE line of its pair —
//     i.e. on a face, not between them. Consequence: two rooms across such a
//     wall do NOT share a line. patient-toilet-137a and patient-room-137 are
//     8.79 px = 5.86 in apart at their closest, where a genuine centreline
//     pair measures exactly 0.00 (ward-room ↔ ward-vestibule, whose shared
//     boundary is one 36-px line, measures 0.000 px).
//
// A third case follows from the same rule and is what the sample plan pins:
//   • NO vertex within tolerance ⇒ the corner stays where the raster contour
//     put it. That is why the sample plan's quadrants pin at 437.978 SF and
//     NOT the 438.58 SF an ideal centreline rectangle (490×290 pt) would give.
//     The sheet has exactly 8 path vertices — the shell's 4 corners plus the
//     2 partitions' 4 endpoints — and the interior partition CROSS at image
//     (1220,784) is where two separate strokes cross, so it is an endpoint of
//     neither and not a recorded vertex (nearest is 580 px away). Each
//     quadrant's cross-corner therefore stays on the raster contour ~1 px
//     inside, costing 0.602 SF (−0.137%) per room.
//
// Recorded here and in each corpus JSON's `wallSemantics`. bench/run.mts does
// not merely compare the JSON's string to this constant (that was a tautology
// while every writer stamped it from here) — it also VERIFIES the declaration
// by measurement, see `wallSemanticsMinVertexCoverage`.
export const WALL_SEMANTICS = "drawn-path-vertex";

/** The semantics vocabulary the bench knows. A case declaring anything else
 *  cannot be read, and a case declaring one of the other two cannot be graded
 *  against the engine under bench/run.mts's SF gates — the measurands differ
 *  by half a wall thickness (1.6% on the sample plan, 8.5% on a 1.15-ft-wide
 *  band, and ~5.9 in per shared wall on the VA plan). Kept as a closed set so
 *  a typo fails loudly instead of reading as "some other convention". */
export const KNOWN_WALL_SEMANTICS = [
  WALL_SEMANTICS,   // what the engine returns: the snapped ring's own measurand
  "centerline",     // wall-centre to wall-centre (equals the above on single-stroke walls only)
  "interior-clear", // face to face, wall thickness excluded
] as const;
export type WallSemantics = (typeof KNOWN_WALL_SEMANTICS)[number];

export interface Probe {
  name: string;
  seed: Point;                       // image px
  expect: "golden" | "refusal";
  golden?: Point[];                  // image px, when expect === "golden"
  tags?: string[];
  knownFail?: boolean;               // tracked, not gating
}
export interface SyntheticCase {
  name: string;
  imgW: number; imgH: number;
  ptPerFt: number;                   // image px per foot (for radii/wedge caps)
  segs: number[];
  /** Snap targets — what `extractVectorGeometry(...).points` would hold for the
   *  op list that draws `segs`. See `snapPointsFor`. */
  points: Point[];
  meta?: Uint8Array;
  probes: Probe[];
  /** What this case's goldens measure to — see WALL_SEMANTICS. Every synthetic
   *  case draws its walls as SINGLE strokes, so here the drawn path vertex and
   *  the wall centreline are the same point; the declaration is verified by
   *  measurement in test/benchProductionRing.test.ts rather than trusted. */
  wallSemantics: WallSemantics;
}

// ── snap targets for a synthetic case (audit A5b) ───────────────────────────
// Production snaps traced corners onto `extractVectorGeometry(...).points`, and
// a SyntheticCase had no such field — it carries only `segs`. Rather than
// hand-listing a point set per case (thirteen chances to be quietly wrong), the
// point set is DERIVED from `segs` under one stated rule, because `segs` is
// already authored as an op-list mirror: consecutive entries that share an
// endpoint are one moveTo/lineTo chain, and disjoint entries are separate ones.
//
// THE RULE — exactly what `extractVectorGeometry`'s `visit()` records:
//   • moveTo (a chain's first vertex)            → recorded
//   • lineTo (every straight segment's end)      → recorded
//   • a cubic bezier                             → its ENDPOINT ONLY; the
//     CURVE_STEPS−1 interior chord vertices are never recorded, so a run of
//     SEG_CURVE chords contributes one point, at the run's end
//   • closePath                                  → records nothing (the start
//     vertex was already recorded by its moveTo)
//   • `re` (rectangle) → its four corners, which is what an `sq(...)` run of
//     four joined straight segments derives to anyway
//
// The one judgement call is reading SEG_CURVE as BEZIER provenance. It is the
// right one for this corpus: SEG_CURVE without SEG_POLYARC is precisely the bit
// `extractVectorGeometry` sets while tessellating a `curveTo`, and no synthetic
// case sets SEG_POLYARC. It is also the conservative reading — a polyline arc
// (drawn lineTo-by-lineTo) would hand the snapper a target on every chord and
// make curved boundaries snap MORE accurately, so deriving them as beziers
// gives curved probes the harder, not the easier, corpus.
export function snapPointsFor(segs: number[], meta?: Uint8Array | null): Point[] {
  const n = segs.length >> 2;
  const isCurve = (i: number) => !!meta && !!(meta[i] & SEG_CURVE);
  const out: Point[] = [];
  let start: Point | null = null;
  const same = (p: Point | null, q: Point) => !!p && p[0] === q[0] && p[1] === q[1];
  // A segment back onto the chain's own first vertex is the `closePath` case,
  // which records nothing — so the point set never carries a duplicate of the
  // chain start (duplicates would only burn slots in buildSnapGrid's 40-per-
  // bucket cap and can never add a snap target).
  const push = (p: Point) => { if (!same(out[out.length - 1] ?? null, p) && !same(start, p)) out.push(p); };
  for (let i = 0; i < n; i++) {
    const k = i << 2;
    const a: Point = [segs[k], segs[k + 1]], b: Point = [segs[k + 2], segs[k + 3]];
    const prevEnd: Point | null = i > 0 ? [segs[k - 2], segs[k - 1]] : null;
    if (!same(prevEnd, a)) { start = null; push(a); start = a; }   // moveTo
    // interior chord of a bezier run ⇒ not a recorded vertex
    const nextContinuesCurve = i + 1 < n && isCurve(i + 1)
      && segs[k + 4] === b[0] && segs[k + 5] === b[1];
    if (!(isCurve(i) && nextContinuesCurve)) push(b);
  }
  return out;
}

const PXFT = 18;
const sq = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0,
];
const border = sq(2, 2, 998, 798);
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const zeroMeta = (segs: number[]) => new Uint8Array(segs.length >> 2);

function mk(name: string, segs: number[], probes: Probe[], meta?: Uint8Array): SyntheticCase {
  const all = [...border, ...segs];
  return { name, imgW: 1000, imgH: 800, ptPerFt: PXFT, segs: all, points: snapPointsFor(all, meta), meta, probes, wallSemantics: WALL_SEMANTICS };
}

// door-swing linework shared by two cases: 54 px (3 ft) south opening at
// x 208..262, leaf open into the room, quarter arc tip → strike jamb
const R = 54;
function doorSwing(): { segs: number[]; curveFrom: number } {
  const leaf = [208, 280, 208, 280 - R];
  const arc: number[] = [];
  let px = 208, py = 280 - R;
  for (let k = 1; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    const qx = 208 + R * Math.sin(a), qy = 280 - R * Math.cos(a);
    arc.push(px, py, qx, qy); px = qx; py = qy;
  }
  return { segs: [...leaf, ...arc], curveFrom: leaf.length >> 2 };
}

export function syntheticCorpus(): SyntheticCase[] {
  const ROOM = rect(100, 100, 316, 280);            // 12×10 ft
  const cases: SyntheticCase[] = [];

  cases.push(mk("enclosed-room", sq(100, 100, 316, 280), [
    { name: "center", seed: [200, 190], expect: "golden", golden: ROOM },
    { name: "near-wall", seed: [108, 190], expect: "golden", golden: ROOM, tags: ["near-wall-seed"] },
  ]));

  cases.push(mk("cased-opening-3ft", [
    100, 100, 316, 100, 316, 100, 316, 280, 316, 280, 262, 280,
    208, 280, 100, 280, 100, 280, 100, 100,
  ], [
    { name: "center", seed: [200, 190], expect: "golden", golden: ROOM, tags: ["gap-seal"] },
  ]));

  {
    const d = doorSwing();
    const roomSegs = [
      100, 100, 316, 100, 316, 100, 316, 280, 316, 280, 262, 280,
      208, 280, 100, 280, 100, 280, 100, 100, ...d.segs,
    ];
    const meta = zeroMeta([...border, ...roomSegs]);
    const arcStart = (border.length >> 2) + (roomSegs.length >> 2) - 8;
    for (let k = 0; k < 8; k++) meta[arcStart + k] = SEG_CURVE;
    cases.push(mk("door-swing-3ft", roomSegs, [
      { name: "center", seed: [200, 190], expect: "golden", golden: ROOM, tags: ["door-swing", "wedge-included"] },
      { name: "in-doorway", seed: [235, 290], expect: "refusal", tags: ["doorway-interior", "known-limit"] },
    ], meta));
  }

  cases.push(mk("two-doorways", [
    20, 20, 50, 20, 57, 20, 100, 20, 100, 20, 100, 100,
    100, 100, 62, 100, 55, 100, 20, 100, 20, 100, 20, 20,
  ], [
    { name: "center", seed: [60, 60], expect: "golden", golden: rect(20, 20, 100, 100), tags: ["gap-seal", "multi-gap"] },
  ]));

  {
    const room = sq(100, 100, 700, 500);              // 600×400 hatched room
    const hatch: number[] = [];
    for (let x = 104; x <= 696; x += 4) hatch.push(x, 100, x, 500);
    const all = [...room, ...hatch];
    cases.push(mk("hatched-room", all, [
      { name: "center", seed: [400, 300], expect: "golden", golden: rect(100, 100, 700, 500), tags: ["hatch"] },
    ], zeroMeta([...border, ...all])));
  }

  {
    const room = sq(100, 100, 700, 500);
    const grid: number[] = [];
    for (let x = 100; x <= 700; x += 24) grid.push(x, 100, x, 500);
    for (let y = 100; y <= 500; y += 24) grid.push(100, y, 700, y);
    const all = [...room, ...grid];
    cases.push(mk("tile-grid-room", all, [
      { name: "in-cell", seed: [410, 310], expect: "golden", golden: rect(100, 100, 700, 500), tags: ["hatch", "tile-grid"] },
    ], zeroMeta([...border, ...all])));
  }

  {
    // curved partition: the space beyond the arc is a room, not a swing wedge
    const room = sq(100, 100, 316, 280);
    const part: number[] = [];
    let px = 208, py = 100;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      const qx = 208 + Math.sin(t * Math.PI) * 24, qy = 100 + t * 180;
      part.push(px, py, qx, qy); px = qx; py = qy;
    }
    const golden: Point[] = [[100, 100], [208, 100]];
    let gx = 208, gy = 100;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      gx = 208 + Math.sin(t * Math.PI) * 24; gy = 100 + t * 180;
      golden.push([gx, gy]);
    }
    golden.push([100, 280]);
    const all = [...room, ...part];
    const meta = zeroMeta([...border, ...all]);
    const partStart = (border.length >> 2) + (room.length >> 2);
    for (let k = 0; k < 8; k++) meta[partStart + k] = SEG_CURVE;
    cases.push(mk("curved-partition", all, [
      { name: "left-half", seed: [150, 190], expect: "golden", golden, tags: ["curved-wall", "no-false-wedge"] },
    ], meta));
  }

  {
    // TWO drawn doors on one room — the per-arc-cluster retry must include
    // BOTH swing wedges (the all-at-once retry used to balloon, reject, and
    // drop every wedge on multi-door rooms — adversarial review, round 8)
    const R2 = 54;
    const south = doorSwing();
    const eastLeaf = [316, 154, 316 - R2, 154];
    const eastArc: number[] = [];
    let px = 316 - R2, py = 154;
    for (let k = 1; k <= 8; k++) {
      const a = (k / 8) * (Math.PI / 2);
      const qx = 316 - R2 * Math.cos(a), qy = 154 + R2 * Math.sin(a);
      eastArc.push(px, py, qx, qy); px = qx; py = qy;
    }
    const roomSegs = [
      100, 100, 316, 100, 316, 100, 316, 154, 316, 208, 316, 280, 316, 280, 262, 280,
      208, 280, 100, 280, 100, 280, 100, 100,
      ...south.segs, ...eastLeaf, ...eastArc,
    ];
    const meta = zeroMeta([...border, ...roomSegs]);
    const n = (border.length >> 2) + (roomSegs.length >> 2);
    for (let k = 0; k < 8; k++) meta[n - 8 + k] = SEG_CURVE;              // east arc
    for (let k = 0; k < 8; k++) meta[n - 8 - 1 - 8 + k] = SEG_CURVE;      // south arc (before east leaf)
    cases.push(mk("two-door-room", roomSegs, [
      { name: "center", seed: [200, 190], expect: "golden", golden: ROOM, tags: ["door-swing", "multi-door"] },
    ], meta));
  }

  {
    // Finish-tag ANNOTATION RING: solid hairline lines inset from every wall
    // with 45° corner ties (the VA plan draws per-wall paint tags this way).
    // The precise classifier correctly says the ring is not hatch — and then
    // nothing lets the flood past it, so the room reads to the ring, not the
    // wall (adversarial re-pin audit, round 8: patient-room-137 lost a
    // perimeter band this way). KNOWN-FAIL until the engine understands
    // annotation semantics; the golden pins the wall-to-wall intent.
    const ring = sq(118, 118, 298, 262);
    const ties = [118, 118, 100, 100, 298, 118, 316, 100, 298, 262, 316, 280, 118, 262, 100, 280];
    const all = [...sq(100, 100, 316, 280), ...ring, ...ties];
    cases.push(mk("annotation-ring-room", all, [
      { name: "center", seed: [200, 190], expect: "golden", golden: ROOM, tags: ["annotation-ring", "known-limit"], knownFail: true },
    ], zeroMeta([...border, ...all])));
  }

  {
    // Partition BANK at sub-cap pitch (15" o.c. cubbies/lockers): repetitive
    // real architecture IS a periodic same-pen lattice, so the interior
    // partitions classify as hatch and the predominantly-soft tier annexes
    // the bank (adversarial review, round 8). Genuine ambiguity — at this
    // pitch the linework is indistinguishable from a tile pattern without
    // context. KNOWN-FAIL documenting the limitation; the golden pins one
    // bay. Shell is a heavier pen, partitions hairline (pen-width membership
    // is what keeps the SHELL hard).
    const bank: number[] = [];
    const meta: number[] = [];
    const shell = sq(100, 100, 350, 208);
    for (let k = 0; k < 4; k++) meta.push(3 << 4);      // shell pen w=3
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) { const x = 136 + i * 22.5; xs.push(x); bank.push(x, 100, x, 208); meta.push(0); }
    const all = [...shell, ...bank];
    const m = new Uint8Array((border.length >> 2) + (all.length >> 2));
    for (let i = 0; i < meta.length; i++) m[(border.length >> 2) + i] = meta[i];
    cases.push(mk("partition-bank-15in", all, [
      // middle bay: between partitions 3 and 4 (x 181..203.5)
      { name: "mid-bay", seed: [192, 154], expect: "golden", golden: rect(xs[2], 100, xs[3], 208), tags: ["partition-bank", "known-limit"], knownFail: true },
    ], m));
  }

  {
    // Same-pen demising wall on a SHARED tile module (flattened exports draw
    // everything hairline; the CAD tool's global hatch origin makes adjacent
    // same-pattern fills share the lattice). The wall sits in a perfect
    // lattice of its own pen → soft → rooms merge. Pre-existing exposure
    // (the old classifier's protects were width-based too); KNOWN-FAIL
    // documenting it; the golden pins room A alone.
    const grid: number[] = [];
    for (let x = 100; x <= 568; x += 18) grid.push(x, 100, x, 334);
    for (let y = 100; y <= 334; y += 18) grid.push(100, y, 568, y);
    // demising wall at x = 334 — exactly 13 tile modules from the shared
    // hatch origin, so it sits IN the grid's lattice
    const all = [...sq(100, 100, 568, 334), 334, 100, 334, 334, ...grid];
    cases.push(mk("tile-demising-same-pen", all, [
      { name: "room-a", seed: [220, 220], expect: "golden", golden: rect(100, 100, 334, 334), tags: ["demising-wall", "known-limit"], knownFail: true },
    ], zeroMeta([...border, ...all])));
  }

  cases.push(mk("open-space", sq(100, 100, 316, 280), [
    { name: "outside-room", seed: [600, 600], expect: "refusal", tags: ["open-space"] },
  ]));

  cases.push(mk("oversized-enclosure", sq(60, 20, 840, 780), [
    // 780×760 interior ≈ 74% of the sheet — the room-size cap must refuse
    { name: "center", seed: [420, 390], expect: "refusal", tags: ["room-size-cap"] },
  ]));

  return cases;
}
