// One-Click Area — v1 geometry core (pure, no DOM; node-testable).
//
// Click inside a room → flood-fill bounded by the plan's vector linework →
// traced polygon, vertices snapped. The pipeline:
//   extractVectorGeometry  PDF op list → line segments + snap endpoints (image px)
//   buildMask              segments → downscaled 1-bit boundary raster
//   floodRegion            seed → bounded region (or "leak"/"tiny"/"boundary")
//   traceRegion            region → outer contour → RDP-simplified polygon (image px)
//
// A single-pixel Bresenham barrier is 8-connected, which provably blocks the
// 4-connected scanline fill — no dilation, so the boundary sits ~half a mask px
// inside the drawn line (sub-inch at plan scales). Text never blocks fills
// (glyphs are showText ops, not constructPath). The caller owns the
// propose → review → Create gate.
//
// Hatch (2026-07-05): hatch/poché strokes are constructPath linework too, so a
// naive mask traps the fill between hatch lines. The cure is a TIERED mask —
// walls plot bit 1, segments classified as hatch (members of a periodic
// parallel family — classifyHatchSegs) plot bit 2 — plus an escalating flood:
// the primary pass treats both as barrier (bit-identical to the original), and
// when it comes back trapped (tiny/boundary), predominantly hatch-bounded (a
// tile-grid cell), or MODERATELY hatch-bounded (a hatch-lined room — issue #32),
// a second pass re-floods with hatch transparent. The moderate tier is the only
// one bounded: it accepts the re-flood only if the area growth stays within a cap
// (grow-but-verify). If the escalated pass leaks, stays tiny, or balloons, the
// primary result stands — a misclassified wall can never make the tool worse
// than the strict mask.

// The snap spatial hash (dependency-free, no DOM) — imported so `oneClickRing`
// below can be THE one composition of trace-then-snap. See section 6b.
import { buildSnapGrid, nearestSnap } from "./geometry.js";

export type Point = [number, number];
export interface OpList { fnArray: number[]; argsArray: any[]; }  // per-op args array, or null for arg-less ops
/** pdf.js's OPS code table (op name → numeric code); passed in so this module never imports pdfjs. */
export type OpsTable = Record<string, number>;
/** meta: one byte per segment — SEG_* bits + device line width in the high nibble.
 *  imageArea: total placed image area in device px² (scan/photo underlay detection).
 *  layerOf/layerIds (#85): per-segment index into layerIds (−1 = outside any
 *  Optional Content Group); layerIds carries pdf.js OCG ids in first-seen
 *  order. The id→name/visibility mapping is the CALLER's (pdf.js API side) —
 *  this module never resolves it, which is what keeps it pure. Optional so
 *  hand-built geometry (rastermask, tests) needs no ceremony; extraction
 *  always emits both (empty table on an unlayered sheet). */
export interface VectorGeometry { points: Point[]; segs: number[]; meta: Uint8Array; imageArea: number; layerOf?: Int32Array; layerIds?: string[]; }
export interface MaskObj { mask: Uint8Array; mw: number; mh: number; ws: number; softCount: number; mppf?: number; }  // mppf: mask px per foot (0/absent = scale unknown)
export interface RegionResult { region: Uint8Array; mw: number; mh: number; ws: number; count?: number; }
export type FloodResult =
  | { status: "boundary" }
  // leakedDilationPx (internal to the seal→bridge handoff): the largest
  // Manhattan dilation radius at which the seal ladder's flood STILL leaked
  // with the click cell itself clear of the dilated walls AND not soft
  // (dt > r, no hatch bit — no seed ascent, no nudge in ANY of the masks
  // involved). Evidence that gap bridging at box radius ≤ r/2 is futile;
  // see floodRegionSealedInner.
  | { status: "leak"; leakedDilationPx?: number }
  | { status: "tiny"; count: number }
  | { status: "ok"; region: Uint8Array; count: number; mw: number; mh: number; ws: number; mppf?: number; hardHits?: number; softHits?: number; hatchFiltered?: boolean; hatchTier?: HatchTier; sealedPx?: number; virtualFrac?: number; wedges?: number; ringWedges?: number; wedgeGrowth?: number; curveFrac?: number; minPassPx?: number; minPassDelta?: number; gapBridged?: number };
/** Caller's snap-grid lookup: nearest true endpoint to (x,y) within maxDist, or null. */
export type NearestFn = (x: number, y: number, maxDist: number) => Point | null | undefined;

export const MASK_MAX_DIM = 3000;   // working raster cap (Uint8 ≈ 6–7 MB)

/** The BASELINE bitmap dims of a page — `ceil(pageDim × baseScale)`, the exact
 *  rounding the canvas's panel render uses. This is the ONE place the answer to
 *  "what grid does this sheet's working raster live on" is computed: `buildMask`
 *  (via its `page` argument) and `rastermask.rasterMaskScale` both call it, so
 *  the vector and raster masks of one sheet cannot land on different grids.
 *
 *  Derived from PAGE POINTS, deliberately, NOT from the panel's bitmap dims.
 *  The bitmap is `ceil(pageDim × renderScale)`; reconstructing the baseline from
 *  it as `imgDim × baseScale/renderScale` carries that ceil into the baseline,
 *  which is a render-DEPENDENT ±1 px grid — the exact class of thing the A1 pin
 *  exists to remove (audit F3; `rasterMaskScale`'s own doc comment says the same
 *  thing about its inputs, and it was right). */
export function baselineImgDims(pageW: number, pageH: number, baseScale: number): { w: number; h: number } {
  const bs = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
  const w = Number.isFinite(pageW) && pageW > 0 ? pageW : 1;
  const h = Number.isFinite(pageH) && pageH > 0 ? pageH : 1;
  return { w: Math.max(1, Math.ceil(w * bs)), h: Math.max(1, Math.ceil(h * bs)) };
}

/** A sheet's render-free identity, for pinning the working raster (audit A1/F3).
 *  `pageW`/`pageH` are PDF POINTS; `renderScale` is the scale this sheet's panel
 *  bitmap — and therefore the `segs` handed to `buildMask` — was rendered at;
 *  `baseScale` is `sheets.RENDER_SCALE`, the pin. Same four numbers
 *  `rasterMaskScale` takes, so the two mask paths are given the same facts. */
export interface MaskPage { pageW: number; pageH: number; renderScale: number; baseScale: number }
const LEAK_FRACTION = 0.30;         // fill > 30% of the sheet ⇒ not an enclosed space (ws-invariant: a fraction)
const CURVE_STEPS = 8;              // chords per bezier (door swings stay closed)
export const GAP_BRIDGE_MAX = 2;    // mask px — leak recovery seals drafting pinholes (≤ ~2r px), never doorways

// ── resolution-independent thresholds (RFC failure mode #3) ─────────────────
// A verdict must not depend on the working raster's resolution, so every
// threshold that MEANS something physical is denominated in FEET and converted
// through the sheet scale (MaskObj.mppf). The px values are (a) the exact
// calibration point — all four ft constants reproduce the historical px
// behavior bit-for-bit at 18 mask px/ft, the corpus convention — and (b) the
// fallback when the scale is unknown, plus raster-honesty FLOORS below which
// a threshold can't shrink (you cannot tell a 1-cell room from noise no
// matter what the feet say).
const CAL_MPPF = 18;                    // calibration resolution (mask px per foot)
const TINY_PX = 30;                     // fill < this many mask px ⇒ landed in dense linework
export const TINY_SF = TINY_PX / (CAL_MPPF * CAL_MPPF);        // ≈ 0.093 SF
const TINY_PX_FLOOR = 8;
const MIN_THICK = 4;                    // region bbox thinner than this ⇒ hatch sliver, not a room
export const MIN_THICK_FT = MIN_THICK / CAL_MPPF;              // ≈ 0.22 ft
const MIN_THICK_FLOOR = 2;
const NUDGE_PX = 3;                     // seed nudge: nearest open cell (clicks land on hatch lines)
export const NUDGE_FT = NUDGE_PX / CAL_MPPF;                   // = 2 inches
// Openings narrower than this never connect two spaces — a slit between an
// annotation leader tip and a wall corner, a hairline drafting gap. Without a
// feet-true rule the answer depends on which side of a cell boundary the
// linework rounds to at the current resolution (bench: ward-room lost
// its vestibule through exactly such a slit at ws × 0.5 only).
export const MIN_PASS_FT = 0.5;
/** Dilation radius that closes sub-MIN_PASS_FT passages at maskPxPerFt.
 *  0 (rule off) when the scale is unknown or the mask is too coarse to say.
 *  ROUND, not floor: a dilation of r closes AXIS-ALIGNED gaps ≤ 2r (the
 *  Manhattan dilation reaches only r/√2 across a 45° slit, so the rule's
 *  effective threshold for diagonal gaps is ≈ MIN_PASS_FT/√2 — a known
 *  anisotropy, stable across resolutions). The effective threshold
 *  quantizes in TWO-cell steps, so no rounding can implement the half-foot
 *  rule exactly — rounding to nearest centers the error band at
 *  MIN_PASS_FT ± ONE cell (±1/mppf ft). Flooring biased it a full band
 *  low, so a 0.42 ft slit closed at one resolution and stayed open at
 *  another (bench, patient-room-137); ceiling biased it high and severed a
 *  real 0.56 ft waist between two open door leaves (ward room). Features
 *  inside the ± one-cell band remain genuinely undecidable from the raster
 *  at ANY floor — see DETERMINISM_MIN_MPPF for what is and isn't promised. */
export function minPassRadiusFor(maskPxPerFt: number): number {
  if (!Number.isFinite(maskPxPerFt) || maskPxPerFt <= 0) return 0;
  return Math.min(SEAL_R_MAX, Math.round((MIN_PASS_FT * maskPxPerFt) / 2));
}
// The engine's honesty line — a PRAGMATIC CHOICE, not a derivation (an
// earlier comment here claimed to derive it; adversarial review showed the
// claimed band was off by 2× and the criterion didn't follow). What is
// true: the min-passage dilation quantizes its effective threshold to
// MIN_PASS_FT ± one cell (±1/mppf ft), so a drawn feature within a cell of
// the threshold — a 0.56 ft waist, a 0.42 ft slit — is UNDECIDABLE from the
// raster at ANY practical floor, and its verdict can differ between two
// resolutions that are both above this line. The floor bounds the band's
// WIDTH (at 8 px/ft it is ±1.5", a quarter of the threshold), not the
// existence of near-threshold flips; full resolution-independence for
// connectivity needs vector-native topology (RFC item A). In production the
// working raster is pinned by MASK_MAX_DIM, so a given sheet always sees one
// resolution. Consumers: traceConfidence deducts on coarser masks; the bench
// gates cross-resolution agreement only at-or-above the floor (coarser runs
// are tracked, non-gating; a case with fewer than two gated resolutions is
// NOT cross-checked and says so).
export const DETERMINISM_MIN_MPPF = 8;   // mask px per foot (a cell ≤ 1.5")

// segment meta bits (extractVectorGeometry emits, classifyHatchSegs consumes)
export const SEG_CURVE = 1;         // curve chord (bezier tessellation OR a detected polyline arc) — never hatch (door swings close gaps)
export const SEG_CLIP = 2;          // clip-only path (endPath) — invisible ink, never a wall
export const SEG_FILLONLY = 4;      // filled-not-stroked path (solid poché outlines classify normally)
export const SEG_POLYARC = 8;       // provenance: SEG_CURVE came from markPolylineArcs, not a bezier op
// meta high nibble = device line width, ceil'd and capped at 15 (0 = hairline)

// polyline arc detection (markPolylineArcs) — the SHAPE thresholds are
// dimensionless geometry (turn angles, ratios), but detection as a whole is
// NOT scale-free: two of these are absolute image px (the sliver floor at
// markPolylineArcs' length test and circleFitOk's absolute residual slack),
// so a drawing rendered small enough eventually stops resolving its own arcs.
// They are raster-honesty floors, not physical thresholds — which is exactly
// why nothing PHYSICAL (a door leaf's length) may be tested here: this runs
// inside extractVectorGeometry at render time, with no sheet scale. Feet-true
// arc tests live at cluster time instead (see arcClusterFit / DOOR_R_*_FT).
export const ARC_MIN_CHORDS = 4;       // fewer chords is a corner chamfer, not an arc
export const ARC_MIN_TOTAL_TURN = 30;  // deg — shallower chains are gentle wall sweeps; door swings are ~90°
export const ARC_CHORD_TURN_MIN = 2;   // deg — near-collinear chains are straight runs with drafting jitter
export const ARC_CHORD_TURN_MAX = 45;  // deg — sharper turns are zigzags/symbols, not tessellation
export const ARC_FIT_TOL_FRAC = 0.03;  // circle-fit residual cap as a fraction of the radius (ellipse fixtures fail this)

// ── non-door curve discrimination (issue: clouds/columns read as door arcs) ──
// SEG_CURVE answers "is this curved linework?" — true of a column, a revision
// cloud and a door swing alike, and it must stay true of all three (it is what
// exempts them from hatch classification). "Is this a DOOR swing?" is a
// separate question, answered here and carried in its own mask bit, so that
// refusing a cloud can never make its chords hatch-eligible.
// Both of these are dimensionless, so they can run at render time:
export const ARC_CLOSED_TURN = 300;    // deg — a chain that sweeps this far closes on itself: a round column, a callout bubble, a north-arrow ring. A door leaf never passes 180°.
export const ARC_CUSP_MIN = 3;         // consecutive cusp reversals that make a chain a revision cloud. A mirrored DOUBLE DOOR is two arcs with ONE reversal, so it must stay under this — the naive "any cusp" form deletes double doors.
export const ARC_CUSP_R_RATIO = 1.5;   // ...and a cloud's scallops all share one radius
export const ARC_CUSP_SPAN_MULT = 8;   // ...which is small next to the chain's own run length (a double door's radius is ~1/3 of its run)
/** mask bit: this curve cell is NOT door-swing linework (closed circle / cloud
 *  scallop). A cell crossed by both a door-like and a non-door-like chord ends
 *  up flagged — deliberately conservative; clusters are judged on the FRACTION
 *  of their cells flagged, so a few shared cells can't flip a real door. */
export const MASK_NODOOR_BIT = 8;
// Feet-true door-leaf band, applied per CLUSTER (where MaskObj.mppf exists).
// NOT 2–6 ft: 1'-6" closet leaves are real, and at 1/16" = 1'-0" a ¼" paper
// scallop is 4 ft model — it would sneak in under a 6 ft cap, so the cap sits
// below it and the cusp rule catches the rest.
export const DOOR_R_MIN_FT = 1.5;
export const DOOR_R_MAX_FT = 4.5;
export const CLUSTER_FIT_TOL_FRAC = 0.05;  // per-cluster circle-fit RMS cap (fraction of the fitted radius) — cells are integer-quantized and the arc rasters 1–2 px thick, so the absolute floor below matters more
export const CLUSTER_FIT_TOL_PX = 1.5;

// hatch classification — a hatch/poché member is a stroke INSIDE a periodic
// parallel family: same-pen neighbors at ±pitch on both sides (and the lattice
// extending ±2 pitches at least one way), gaps equal to raster precision,
// pitch at fill scale. Walls never sit inside such a lattice; the outermost
// rows of a real fill fail it too, so hatch-region edges stay hard for free
// (see classifyHatchSegs).
export const HATCH_ANGLE_TOL = 2;      // deg — CAD hatch angle jitter is ≪ 1°
export const HATCH_MAX_PITCH = 24;     // mask px — scale-unknown fallback for the pitch cap
export const HATCH_MAX_PITCH_FT = HATCH_MAX_PITCH / 18;  // = 4/3 ft at the 18 px/ft calibration — keeps room-scale rhythm (demising walls) hard, at every resolution
/** Which verification regime accepted a hatch escalation — see floodRegion. */
export type HatchTier = "bounded" | "trapped" | "override";
/** Ordering for combining tiers across a room's retries: worst wins. */
export const HATCH_TIER_RISK: Record<HatchTier, number> = { bounded: 0, trapped: 1, override: 2 };
export const HATCH_BOUND_FRAC = 0.7;   // ≥ this soft-bounded fraction ⇒ PREDOMINANTLY hatch (tile-grid cell): escalate unbounded
export const HATCH_ESCALATE_FRAC = 0.02; // MODERATE band [this, HATCH_BOUND_FRAC): grow-but-verify escalation. Was 0.35 when hatch classification was a loose rhythm heuristic and a high bar kept its false positives from escalating everything; with per-stroke periodicity evidence (item C), ANY real hatch run on the boundary is worth testing — a hatched alcove of a room is often < 35% of its boundary — and grow-but-verify remains the gate. The floor only skips re-floods over boundary specks. Balanced-preset value; see escalationParams.
export const HATCH_GROWTH_MAX = 2.5;     // grow-but-verify cap: reject a walls-only escalation that balloons past this × the strict area (a misclassified wall would leak or overgrow). Balanced-preset value.

// Fill sensitivity — a single 0..1 knob the estimator can dial per drawing to
// trade spill-resistance against reach (the constants above are calibrated on one
// sheet/one CAD style; other plans hatch differently). It tunes ONLY the moderate
// escalation tier: how eagerly a hatch-bounded fill escalates (escalateFrac) and
// how much area growth that escalation may add (growthMax). The trapped and
// predominantly-soft tiers stay unbounded at every setting, so lowering
// sensitivity never regresses tile-grid recovery — it only narrows the moderate
// band, and at Strict it empties (reproducing pre-#32 behavior).
export const SENS_STRICT = 0;
export const SENS_BALANCED = 0.5;      // default: the calibrated (0.35, 2.5) pair
export const SENS_AGGRESSIVE = 1;
// Notch detents interpolated piecewise-linearly: [sensitivity, escalateFrac, growthMax].
const SENS_ANCHORS: Array<[number, number, number]> = [
  [SENS_STRICT, HATCH_BOUND_FRAC, 1.5],                     // moderate band empties (escalateFrac == HATCH_BOUND_FRAC) ⇒ pre-#32
  [SENS_BALANCED, HATCH_ESCALATE_FRAC, HATCH_GROWTH_MAX],   // calibrated on the sample plan (issue #32)
  [SENS_AGGRESSIVE, 0, 4.0],                               // cross any hatch, tolerate more growth
];
export function escalationParams(sensitivity: number): { escalateFrac: number; growthMax: number } {
  const s = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : SENS_BALANCED));
  let a = SENS_ANCHORS[0], b = SENS_ANCHORS[SENS_ANCHORS.length - 1];
  for (let i = 1; i < SENS_ANCHORS.length; i++) { if (s <= SENS_ANCHORS[i][0]) { a = SENS_ANCHORS[i - 1]; b = SENS_ANCHORS[i]; break; } }
  const t = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0]);
  return { escalateFrac: a[1] + (b[1] - a[1]) * t, growthMax: a[2] + (b[2] - a[2]) * t };
}

// ── 1. op-list walk ────────────────────────────────────────────────────────
// Same transform composition as the original snap extractor (save/restore/
// transform/constructPath), now also emitting SEGMENTS for the boundary mask
// plus one META byte per segment: curve/clip/fill bits + the device line width
// in the high nibble (setLineWidth / setGState "LW", scaled by the CTM). Form
// XObjects push/pop their matrix so hatch living inside a form lands where it
// draws. `transform` is viewport.transform; OPS is pdfjs's op-code table.
export function extractVectorGeometry(opList: OpList, transform: number[], OPS: OpsTable): VectorGeometry {
  const points: Point[] = [];
  const segs: number[] = [];
  const metaArr: number[] = [];
  let imageArea = 0;
  let m = transform.slice();
  let lw = 1;                          // graphics-state line width (user space)
  const stack: Array<[number[], number]> = [];
  // Marked-content / Optional Content (#85): a purely SEQUENTIAL stack — not
  // graphics state, so save/restore never touches it, and a Form XObject with
  // /OC arrives as its own begin/end pair around the form's ops (the worker
  // emits them), so the linear walk covers page content and forms alike.
  // Every begin pushes (−1 for non-OC marked content — it still nests); every
  // end pops; a segment is attributed to the NEAREST enclosing OC layer.
  const layerIds: string[] = [];
  const layerIdxById = new Map<string, number>();
  const layerOfArr: number[] = [];
  const mcStack: number[] = [];
  let curLayer = -1;
  const layerIdxFor = (id: string): number => {
    let k = layerIdxById.get(id);
    if (k === undefined) { k = layerIds.length; layerIds.push(id); layerIdxById.set(id, k); }
    return k;
  };
  const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const tx = (x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const fns = opList.fnArray, A = opList.argsArray;
  // the paint op FOLLOWS its path in the op stream (clip ops may sit between):
  // endPath = clip-only (invisible), fill/eoFill = filled-not-stroked
  const paintFlags = (i: number): number => {
    for (let j = i + 1; j < fns.length && j <= i + 3; j++) {
      const f = fns[j];
      if (f === OPS.clip || f === OPS.eoClip) continue;
      if (f === OPS.endPath) return SEG_CLIP;
      if (f === OPS.fill || f === OPS.eoFill) return SEG_FILLONLY;
      break;                            // stroke / fillStroke / anything else
    }
    return 0;
  };
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i], args = A[i];
    if (fn === OPS.save) stack.push([m.slice(), lw]);
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.setGState) { for (const pr of args[0] || []) if (pr && pr[0] === "LW") lw = pr[1]; }
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m.slice(), lw]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.beginMarkedContent) { mcStack.push(-1); }
    else if (fn === OPS.beginMarkedContentProps) {
      // worker emits ["OC", data] where data is {type:"OCG", id}, an OCMD
      // ({ids, policy} / {expression}) or null. Attribute to a SINGLE stated
      // group only — a multi-group OCMD or an expression is a visibility rule,
      // not an authorship claim, and misattributing it would poison the roles.
      const data = args && args[0] === "OC" ? args[1] : null;
      let li = -1;
      if (data && typeof data === "object") {
        if (typeof data.id === "string" && data.id) li = layerIdxFor(data.id);
        else if (Array.isArray(data.ids) && data.ids.length === 1 && typeof data.ids[0] === "string" && data.ids[0]) li = layerIdxFor(data.ids[0]);
      }
      mcStack.push(li);
      if (li >= 0) curLayer = li;
    }
    else if (fn === OPS.endMarkedContent) {
      if (mcStack.length) {
        mcStack.pop();
        curLayer = -1;
        for (let k = mcStack.length - 1; k >= 0; k--) if (mcStack[k] >= 0) { curLayer = mcStack[k]; break; }
      }
    }
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // the singular paint ops are each preceded by their OWN `transform` op
      // (already folded into `m` above), mapping the image's unit square onto
      // the placed rect — |det m| is its device-px area. Summed per sheet, it
      // flags scan wrappers / photo underlays (a plan-area scan covers most of
      // the sheet; logos and stamps are ≪ 2%).
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]);
    }
    else if (fn === OPS.paintImageXObjectRepeat) {
      // pdf.js FOLDS a run of identical placements into one op — no per-instance
      // `transform` op precedes it, so `m` here is just the ambient CTM (the
      // viewport transform); placement lives in the op's OWN args instead:
      // [objId, scaleX, scaleY, positions] where positions is a flat (x, y) ×
      // instanceCount array. Area = |det ambient| × |scaleX·scaleY| × count.
      const [, scaleX, scaleY, positions] = args;
      const count = positions ? positions.length >> 1 : 0;
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]) * Math.abs(scaleX * scaleY) * count;
    }
    else if (fn === OPS.paintImageMaskXObjectRepeat) {
      // args: [objId, a, b, c, d, positions] — a..d are the per-instance local
      // transform's 2×2 (folded the same way as the repeat op above).
      const [, ra, rb, rc, rd, positions] = args;
      const count = positions ? positions.length >> 1 : 0;
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]) * Math.abs(ra * rd - rb * rc) * count;
    }
    else if (fn === OPS.paintImageMaskXObjectGroup) {
      // args: [images] — each images[k].transform is that instance's own local
      // [a,b,c,d,e,f] (pdf.js keeps per-instance transforms here instead of
      // folding to *Repeat when the run isn't uniform enough).
      const ctmDet = Math.abs(m[0] * m[3] - m[1] * m[2]);
      for (const im of args[0] || []) {
        const t = im && im.transform;
        if (t) imageArea += ctmDet * Math.abs(t[0] * t[3] - t[1] * t[2]);
      }
    }
    else if (fn === OPS.paintInlineImageXObjectGroup) {
      // args: [img, map] — each map[k].transform is that instance's own local
      // [a,b,c,d,e,f].
      const ctmDet = Math.abs(m[0] * m[3] - m[1] * m[2]);
      for (const mp of args[1] || []) {
        const t = mp && mp.transform;
        if (t) imageArea += ctmDet * Math.abs(t[0] * t[3] - t[1] * t[2]);
      }
    }
    else if (fn === OPS.constructPath) {
      const devW = Math.min(15, Math.max(0, Math.ceil((lw || 0) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])))));
      const flags = paintFlags(i) | (devW << 4);
      const ops = args[0], co = args[1];
      let c = 0, cur: Point | null = null, start: Point | null = null;
      const pathLayer = curLayer;   // one path = one marked-content scope (#85)
      const visit = (p: Point) => { points.push(p); };
      const lineTo = (p: Point) => { if (cur) { segs.push(cur[0], cur[1], p[0], p[1]); metaArr.push(flags); layerOfArr.push(pathLayer); } cur = p; visit(p); };
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = tx(co[c], co[c + 1]); start = cur; visit(cur); c += 2; }
        else if (op === OPS.lineTo) { lineTo(tx(co[c], co[c + 1])); c += 2; }
        else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
          // cubic bezier, sampled as chords; control points transform first
          // (affine maps commute with bezier interpolation)
          let p1: Point, p2: Point, p3: Point;
          if (op === OPS.curveTo) { p1 = tx(co[c], co[c + 1]); p2 = tx(co[c + 2], co[c + 3]); p3 = tx(co[c + 4], co[c + 5]); c += 6; }
          else if (op === OPS.curveTo2) { p1 = cur || tx(co[c], co[c + 1]); p2 = tx(co[c], co[c + 1]); p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          else { p1 = tx(co[c], co[c + 1]); p2 = p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          const p0: Point = cur || p1;
          for (let k = 1; k <= CURVE_STEPS; k++) {
            const t = k / CURVE_STEPS, u = 1 - t;
            const q: Point = [
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            ];
            if (cur) { segs.push(cur[0], cur[1], q[0], q[1]); metaArr.push(flags | SEG_CURVE); layerOfArr.push(pathLayer); }
            cur = q;
          }
          visit(p3);
        }
        else if (op === OPS.closePath) { if (cur && start) { segs.push(cur[0], cur[1], start[0], start[1]); metaArr.push(flags); layerOfArr.push(pathLayer); cur = start; } }
        else if (op === OPS.rectangle) {
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q: Point[] = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); metaArr.push(flags); layerOfArr.push(pathLayer); visit(a); }
          cur = q[0]; start = q[0];
        }
      }
    }
  }
  const meta = Uint8Array.from(metaArr);
  markPolylineArcs(segs, meta);
  return { points, segs, meta, imageArea, layerOf: Int32Array.from(layerOfArr), layerIds };
}

// ── 1b. polyline arc detection ─────────────────────────────────────────────
// Door swings on many real plans are POLYLINES, not beziers — CAD exports
// tessellate the arc into lineTo chords — so they carry no SEG_CURVE bit: the
// mask can't recognize them as door linework (no curve-transparent retry, no
// wedge unification), and to a rhythm-based hatch classifier their chords can
// masquerade as pattern rows. An arc is GEOMETRY, not rhythm: consecutive
// chained chords, turning consistently in one direction by similar amounts,
// whose vertices all sit on one circle. Detect exactly that and give the
// chords the same SEG_CURVE the bezier tessellation gets (SEG_POLYARC records
// the provenance). Chains tolerate endpoint gaps up to a chord length so
// DASHED arcs (phantom door leaves) detect too, while a dashed straight line
// has no turn and never qualifies. Ellipse fixtures (toilets, sinks) fail the
// circle fit; chamfers are too short; zigzag symbols flip turn sign.
export function markPolylineArcs(segs: number[], meta: Uint8Array): number {
  const n = segs.length >> 2;
  if (!meta || n < ARC_MIN_CHORDS) return 0;
  let marked = 0;
  const len = (i: number) => Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);
  // chains hold CHORD indices — segments long enough to carry a direction.
  // Sub-half-px slivers (dash-pattern pen-down artifacts) neither join nor
  // break a chain: they're bridged, and marked with the window they sit in.
  let chain: number[] = [];
  const flush = () => {
    if (chain.length >= ARC_MIN_CHORDS) marked += scanChainForArcs(segs, meta, chain);
    chain = [];
  };
  for (let i = 0; i < n; i++) {
    if (meta[i] & (SEG_CURVE | SEG_CLIP)) { flush(); continue; }
    if (len(i) < 0.5) continue;                        // sliver — bridge it
    if (chain.length) {
      const p = chain[chain.length - 1];
      // same path & pen (identical meta), endpoints joined or dash-gapped
      // less than the longer of the two chords (dash gaps run shorter than
      // their dashes; anything longer is separate linework)
      const gap = Math.hypot(segs[i * 4] - segs[p * 4 + 2], segs[i * 4 + 1] - segs[p * 4 + 3]);
      if (meta[i] !== meta[p] || gap > Math.max(len(i), len(p))) flush();
    }
    chain.push(i);
  }
  flush();
  return marked;
}

// One chain of joined same-pen chords: find maximal windows of consistent
// uniform turning, then confirm each window's vertices against a fitted
// circle before marking. The fit is the arbiter — turn statistics alone
// would admit near-circular polylines that aren't arcs.
function scanChainForArcs(segs: number[], meta: Uint8Array, chain: number[]): number {
  let marked = 0;
  for (const w of scanChainWindows(segs, chain)) {
    // mark the seg-index RANGE so bridged slivers ride along — but only segs
    // sharing the chain's meta (a foreign path's sliver interleaved in the
    // stream must not be stamped)
    const cm = meta[chain[w.c0]];
    for (let j = chain[w.c0]; j <= chain[w.c1]; j++) if (meta[j] === cm) meta[j] |= SEG_CURVE | SEG_POLYARC;
    marked += w.c1 - w.c0 + 1;
  }
  return marked;
}

/** One confirmed arc inside a chain: chord range (chain indices), the signed
 *  total turn across it (deg), and the circle it fits. */
interface ArcWindow { c0: number; c1: number; turn: number; r: number; }

// The window scanner both marking and non-door discrimination run on.
function scanChainWindows(segs: number[], chain: number[]): ArcWindow[] {
  const m = chain.length;
  const dirs: number[] = [], lens: number[] = [];
  for (const i of chain) {
    const dx = segs[i * 4 + 2] - segs[i * 4], dy = segs[i * 4 + 3] - segs[i * 4 + 1];
    dirs.push(Math.atan2(dy, dx) * 180 / Math.PI);
    lens.push(Math.hypot(dx, dy));
  }
  // turn[k] = signed direction change entering chord k (k ≥ 1), in (−180, 180]
  const turn: number[] = [0];
  for (let k = 1; k < m; k++) {
    let t = dirs[k] - dirs[k - 1];
    if (t > 180) t -= 360; if (t <= -180) t += 360;
    turn.push(t);
  }
  const ratioOk = (k: number) => {
    const r = Math.max(lens[k], lens[k - 1]) / Math.max(1e-9, Math.min(lens[k], lens[k - 1]));
    return r <= 3;                     // uniform tessellation (dash phase shortens end dashes)
  };
  const signedTurn = (k: number) => Math.abs(turn[k]) >= ARC_CHORD_TURN_MIN && Math.abs(turn[k]) <= ARC_CHORD_TURN_MAX && ratioOk(k);
  // a dash pattern can split ONE tessellation chord into two near-collinear
  // pieces, so an ISOLATED sub-threshold turn continues a window; two in a
  // row is a straight run and breaks it
  const neutral = (k: number) => Math.abs(turn[k]) < ARC_CHORD_TURN_MIN && ratioOk(k);
  const out: ArcWindow[] = [];
  let s = 1;
  while (s < m) {
    if (!signedTurn(s)) { s++; continue; }
    const sgn = Math.sign(turn[s]);
    let e = s, bridged = false;
    for (let k = s + 1; k < m; k++) {
      if (signedTurn(k) && Math.sign(turn[k]) === sgn) { e = k; bridged = false; continue; }
      if (neutral(k) && !bridged) { bridged = true; continue; }
      break;
    }
    // window of turns [s..e] covers chords s-1 .. e (trailing neutrals
    // excluded). A joined stub meeting the arc at a plausible turn (a
    // threshold tick, a leader drawn continuous with the swing) rides in as
    // the window's first or last chord and its off-circle vertex fails the
    // fit — so on failure, retry with the end chords trimmed instead of
    // discarding the whole arc (adversarial review, round 8).
    if (e - s + 2 >= ARC_MIN_CHORDS) {
      let total = 0; for (let j = s; j <= e; j++) total += Math.abs(turn[j]);
      if (total >= ARC_MIN_TOTAL_TURN) {
        for (const [c0, c1] of [[s - 1, e], [s, e], [s - 1, e - 1], [s, e - 1]] as const) {
          if (c1 - c0 + 1 < ARC_MIN_CHORDS) continue;
          let t = 0, signed = 0;
          for (let j = c0 + 1; j <= c1; j++) { t += Math.abs(turn[j]); signed += turn[j]; }
          const fit = t < ARC_MIN_TOTAL_TURN ? null : circleFitOk(segs, chain, c0, c1);
          if (!fit) continue;
          out.push({ c0, c1, turn: signed, r: fit.r });
          break;
        }
      }
    }
    s = e + 1;
  }
  return out;
}

/** Per-chord verdict: this curve chord is NOT door-swing linework. Runs over
 *  every SEG_CURVE chord — bezier tessellation included, since CAD emits
 *  circles as beziers and extractVectorGeometry stamps SEG_CURVE on those
 *  unconditionally, so a discriminator scoped to the polyline path would never
 *  see a bezier-drawn column.
 *
 *  Two dimensionless refusals (the feet-true radius band is a CLUSTER-time
 *  test — there is no sheet scale here):
 *    1. a chain sweeping ≥ ARC_CLOSED_TURN closes on itself — column, callout
 *       bubble, north arrow. Nothing that closes is a door leaf.
 *    2. a CUSP CHAIN — four or more equal-radius arcs meeting at reversals —
 *       is a revision cloud. The naive "consecutive arcs with opposite turn
 *       sign" form also describes a mirrored DOUBLE DOOR, so all three of
 *       similar radius, SMALL radius (relative to the chain's own run) and
 *       ≥ ARC_CUSP_MIN reversals are required; a double door has one. */
export function flagNonDoorArcs(segs: number[], meta: Uint8Array): Uint8Array {
  const n = segs.length >> 2;
  const veto = new Uint8Array(n);
  if (!meta || n < ARC_MIN_CHORDS) return veto;
  const len = (i: number) => Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);
  let chain: number[] = [];
  const flush = () => {
    if (chain.length >= ARC_MIN_CHORDS) judgeChain(segs, chain, veto);
    chain = [];
  };
  for (let i = 0; i < n; i++) {
    // Slivers are bridged BEFORE the membership test, unlike markPolylineArcs:
    // pdf.js emits a ZERO-LENGTH lineTo between the two half-circle beziers of
    // a CAD circle, and letting that break the chain split every bezier circle
    // into two 180° halves — neither of which closes (measured on the corpus's
    // real plan; the column read as two door-sized arcs).
    if (len(i) < 0.5) continue;
    if (!(meta[i] & SEG_CURVE) || (meta[i] & SEG_CLIP)) { flush(); continue; }
    if (chain.length) {
      const p = chain[chain.length - 1];
      const gap = Math.hypot(segs[i * 4] - segs[p * 4 + 2], segs[i * 4 + 1] - segs[p * 4 + 3]);
      if (meta[i] !== meta[p] || gap > Math.max(len(i), len(p))) flush();
    }
    chain.push(i);
  }
  flush();
  return veto;
}

function judgeChain(segs: number[], chain: number[], veto: Uint8Array): void {
  const wins = scanChainWindows(segs, chain);
  if (!wins.length) return;
  const stamp = (w: ArcWindow) => { for (let j = chain[w.c0]; j <= chain[w.c1]; j++) veto[j] = 1; };
  // 1. closed circles
  let closed = false;
  for (const w of wins) if (Math.abs(w.turn) >= ARC_CLOSED_TURN) { stamp(w); closed = true; }
  if (closed) return;
  // 3. cusp chains (revision clouds). Windows separated by at most one chord
  // are joined at a cusp — the sharp reversal that broke the turn window.
  if (wins.length <= ARC_CUSP_MIN) return;
  let run = 1, best = 1;
  for (let k = 1; k < wins.length; k++) {
    if (wins[k].c0 - wins[k - 1].c1 <= 2 && Math.sign(wins[k].turn) === Math.sign(wins[k - 1].turn)) run++;
    else run = 1;
    if (run > best) best = run;
  }
  if (best <= ARC_CUSP_MIN) return;                    // ≤ 3 arcs in a row ⇒ ≤ 2 reversals
  let rmin = Infinity, rmax = 0, span = 0;
  for (const w of wins) { if (w.r < rmin) rmin = w.r; if (w.r > rmax) rmax = w.r; }
  for (const i of chain) span += Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);
  if (!(rmin > 0) || rmax > rmin * ARC_CUSP_R_RATIO) return;       // radii must match
  if (rmax * ARC_CUSP_SPAN_MULT > span) return;                    // ...and be small next to the run
  for (const w of wins) stamp(w);
}

// Kasa least-squares circle through the chords' vertices, centroid-centered
// for conditioning; accept when every vertex sits on the circle to within
// ARC_FIT_TOL_FRAC of the radius (a hair of absolute slack for PDF coordinate
// rounding). Tessellation vertices of a true arc lie exactly on it.
// Returns the fitted circle (the RADIUS is what the cloud test needs), or null.
function circleFitOk(segs: number[], chain: number[], c0: number, c1: number): { cx: number; cy: number; r: number } | null {
  const xs: number[] = [], ys: number[] = [];
  xs.push(segs[chain[c0] * 4]); ys.push(segs[chain[c0] * 4 + 1]);
  for (let k = c0; k <= c1; k++) { const i = chain[k]; xs.push(segs[i * 4 + 2]); ys.push(segs[i * 4 + 3]); }
  const m = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < m; i++) { mx += xs[i]; my += ys[i]; }
  mx /= m; my /= m;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < m; i++) {
    const x = xs[i] - mx, y = ys[i] - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null;               // collinear — no circle
  const cx = (sxz * syy - syz * sxy) / (2 * det);
  const cy = (syz * sxx - sxz * sxy) / (2 * det);
  let r = 0;
  for (let i = 0; i < m; i++) r += Math.hypot(xs[i] - mx - cx, ys[i] - my - cy);
  r /= m;
  if (!(r > 0)) return null;
  const tol = Math.max(0.75, r * ARC_FIT_TOL_FRAC);
  for (let i = 0; i < m; i++) {
    if (Math.abs(Math.hypot(xs[i] - mx - cx, ys[i] - my - cy) - r) > tol) return null;
  }
  return { cx: cx + mx, cy: cy + my, r };
}

// ── 2. hatch classification ────────────────────────────────────────────────
// PERIODICITY evidence, decided per stroke (issue #184 item C — replaces the
// parallel-row run heuristic). A stroke is hatch iff it sits INSIDE a local
// periodic lattice of its own family: same-angle, SAME-PEN neighbors at ±p on
// both sides — and the lattice extending to ±2p on at least one side — every
// gap equal to within half a mask cell, for some pitch p at fill scale
// (≤ pitchCapPx, feet-true when the scale is known). That one statement
// replaces five knobs of the old classifier:
//   • run length / regularity band / majority vote — CAD hatch pitch is
//     machine-exact, so gaps match to raster precision or the family isn't
//     hatch; five equal-pitched overlapping rows is the evidence, not ten
//     loosely-similar gaps out-voting their outliers.
//   • tangential-overlap fraction — each lattice neighbor must overlap the
//     stroke at all (≥ half a cell): hatch is an areal fill, so its rows
//     stack; scattered same-angle linework that happens to be evenly offset
//     (door arc chords, dimension ticks) doesn't.
//   • pen-width protect ratio — the pen IS part of the pattern: lattice
//     neighbors must match the stroke's width nibble, so a heavy wall
//     overprinting a hairline family finds no same-pen lattice and stays
//     hard, without a ratio to tune.
//   • span protect ratio — a wall riding a fill's rhythm still needs same-pen
//     equal-pitch neighbors BOTH sides; where it does ride them, the
//     escalation's grow-but-verify cap is the backstop (unchanged).
//   • extremal-row protection — the outermost rows of a fill have no ±p
//     neighbor outside the fill, so they fail the lattice and stay hard for
//     free (tile/hatch edges coincide with walls).
// Curve chords are exempt (bezier AND detected polyline arcs — door swings
// must keep closing gaps, and an arc is never a periodic family); clip-only
// paths are soft outright (invisible ink); filled-not-stroked outlines bound
// SOLID ink (wall poché) and are exempt — making them transparent lets the
// escalated fill cross a solid black band. The half-cell tolerances are the
// raster's own honesty floor (two lines closer than half a cell plot on the
// same cells; offsets carry ~1e-14 float noise — the corpus caught a pitch
// sitting exactly ON the cap splitting on that noise at one resolution), not
// tunables.
interface HatchPiece { i: number; d: number; t0: number; t1: number; w: number; }
export function classifyHatchSegs(segs: number[], meta: Uint8Array, ws: number, pitchCapPx: number = HATCH_MAX_PITCH): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n) return soft;
  const HALF_CELL = 0.5;                         // mask px — raster resolution floor
  interface Cand { i: number; ang: number; x1: number; y1: number; x2: number; y2: number; w: number; }
  const cand: Cand[] = [];
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    if (mt & SEG_CURVE) continue;
    if (mt & SEG_CLIP) { soft[i] = 1; continue; }
    if (mt & SEG_FILLONLY) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.75) continue;                    // sub-cell specks can't form rows
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // fold to [0,180): direction-free
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, w: meta[i] >> 4 });
  }
  if (cand.length < 5) return soft;              // a lattice is 5 rows minimum
  cand.sort((a, b) => a.ang - b.ang);
  // sweep into angle clusters; a near-0° cluster merges with a near-180° one
  const clusters: Cand[][] = [];
  let cl: Cand[] = [cand[0]];
  for (let k = 1; k < cand.length; k++) {
    if (cand[k].ang - cand[k - 1].ang <= HATCH_ANGLE_TOL) cl.push(cand[k]);
    else { clusters.push(cl); cl = [cand[k]]; }
  }
  clusters.push(cl);
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters[clusters.length - 1];
    if (first[0].ang < HATCH_ANGLE_TOL && last[last.length - 1].ang > 180 - HATCH_ANGLE_TOL) {
      for (const s of last) s.ang -= 180;        // fold across the seam for the mean
      clusters[0] = last.concat(first);
      clusters.pop();
    }
  }
  for (const members of clusters) {
    if (members.length < 5) continue;
    let sum = 0; for (const s of members) sum += s.ang;
    const th = (sum / members.length) * Math.PI / 180;
    const dxu = Math.cos(th), dyu = Math.sin(th);      // along the family
    const nxu = -dyu, nyu = dxu;                        // across it
    const pieces: HatchPiece[] = members.map((s) => ({
      i: s.i,
      d: ((s.x1 + s.x2) / 2) * nxu + ((s.y1 + s.y2) / 2) * nyu,
      t0: Math.min(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
      t1: Math.max(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
      w: s.w,
    })).sort((a, b) => a.d - b.d);
    // group into ROWS at raster resolution (anchor-based: a piece joins the
    // row when its offset is within half a cell of the row's first piece —
    // dashed/collinear pieces of one drawn line land together)
    const rowOf = new Int32Array(pieces.length);
    const rowD: number[] = [];
    const rowPieces: HatchPiece[][] = [];
    for (let k = 0; k < pieces.length; k++) {
      if (rowD.length && pieces[k].d - rowD[rowD.length - 1] <= HALF_CELL) {
        rowOf[k] = rowD.length - 1; rowPieces[rowPieces.length - 1].push(pieces[k]);
      } else {
        rowOf[k] = rowD.length; rowD.push(pieces[k].d); rowPieces.push([pieces[k]]);
      }
    }
    // per-row t0-sorted pieces + a prefix-max of t1: queries bisect to the
    // last piece starting before the window and walk left only while an
    // overlap is still possible — without this, a cap-wide band of dense
    // same-angle non-overlapping linework (stipple textures, tick swarms)
    // makes the per-piece loop quadratic (adversarial review, round 8)
    for (const rp of rowPieces) rp.sort((a, b) => a.t0 - b.t0);
    const rowMaxT1: number[][] = rowPieces.map((rp) => {
      const m: number[] = new Array(rp.length);
      let mx = -Infinity;
      for (let i = 0; i < rp.length; i++) { mx = Math.max(mx, rp[i].t1); m[i] = mx; }
      return m;
    });
    // does row j hold a piece of pen width w overlapping [t0, t1]?
    const rowHas = (j: number, w: number, t0: number, t1: number): boolean => {
      const P = rowPieces[j], M = rowMaxT1[j];
      let lo = 0, hi = P.length - 1, last = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (P[mid].t0 <= t1 - HALF_CELL) { last = mid; lo = mid + 1; } else hi = mid - 1; }
      for (let i = last; i >= 0; i--) {
        if (M[i] < t0 + HALF_CELL) break;              // nothing further left can overlap
        const p = P[i];
        if (p.w === w && Math.min(p.t1, t1) - Math.max(p.t0, t0) >= HALF_CELL) return true;
      }
      return false;
    };
    // nearest row from j (exclusive) in direction dir with a matching piece,
    // within the pitch cap; −1 when none
    const nearestRow = (j: number, dir: 1 | -1, w: number, t0: number, t1: number): number => {
      for (let r = j + dir; r >= 0 && r < rowD.length; r += dir) {
        if (Math.abs(rowD[r] - rowD[j]) > pitchCapPx + HALF_CELL) break;
        if (rowHas(r, w, t0, t1)) return r;
      }
      return -1;
    };
    // any row at offset ≈ target (± half cell) with a matching piece?
    const rowAt = (target: number, w: number, t0: number, t1: number): boolean => {
      let lo = 0, hi = rowD.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (rowD[mid] < target - HALF_CELL) lo = mid + 1; else hi = mid; }
      for (let r = lo; r < rowD.length && rowD[r] <= target + HALF_CELL; r++) {
        // the bisection can land on the last row when target is beyond every
        // row — enforce the lower bound too, or the nearest-below row would
        // spuriously validate lattice positions that don't exist
        if (rowD[r] >= target - HALF_CELL && rowHas(r, w, t0, t1)) return true;
      }
      return false;
    };
    for (let k = 0; k < pieces.length; k++) {
      const c = pieces[k];
      const j = rowOf[k];
      const up = nearestRow(j, 1, c.w, c.t0, c.t1);
      const dn = nearestRow(j, -1, c.w, c.t0, c.t1);
      // a true pattern edge (nothing of the family beyond it within a pitch)
      // stays hard — tile/hatch edges coincide with walls
      if (up < 0 || dn < 0) continue;
      const pUp = rowD[up] - rowD[j], pDn = rowD[j] - rowD[dn];
      const at = (mult: number, p: number) => rowAt(rowD[j] + mult * p, c.w, c.t0, c.t1);
      for (const p of pUp === pDn ? [pUp] : [pUp, pDn]) {
        if (p < HALF_CELL || p > pitchCapPx + HALF_CELL) continue;
        // interior: ±p both sides, lattice extending to ±2p at least one way
        const interior = at(1, p) && at(-1, p) && (at(2, p) || at(-2, p));
        // clipped edge: a fill's LAST row before its bounding wall has a
        // remainder gap (< pitch) to the wall, not a pitch gap — accept a
        // deeper three-step lattice on one side when the OPPOSITE side is
        // bounded within a pitch (the clip signature; a lone pattern edge
        // with open space beyond stays hard). The bound must be tested on
        // the side away from the lattice: testing min(pUp, pDn) is a
        // tautology (p is always one of them), which let any same-pen
        // stroke within the CAP on the far side soften a pattern edge
        // (adversarial review, round 8).
        const clipped =
          (at(1, p) && at(2, p) && at(3, p) && pDn <= p + HALF_CELL) ||
          (at(-1, p) && at(-2, p) && at(-3, p) && pUp <= p + HALF_CELL);
        if (interior || clipped) { soft[c.i] = 1; break; }
      }
    }
  }
  return soft;
}

// ── 2b. hatch families — the context view of the sheet's patterns (issue #29) ──
// The MASK asks "is this stroke a wall?" and the lattice classifier above
// answers per stroke. The CONTEXT tools (sheet_context, legend↔plan matching)
// ask a different question — "what pattern families exist on this sheet, and
// where?" — and that is the row/run sweep below: same-angle rows, regularly
// pitched, stacking tangentially, reported as instances with an (angle, pitch,
// pen-width) signature. The two views are deliberately separate: replacing the
// classifier's evidence rule (item C) must not silently re-identify families
// that MCP callers have already matched by id.
export const HATCH_MIN_RUN = 10;       // rows — fewer evenly-spaced parallels is plausibly walls
export const HATCH_PITCH_TOL = 0.35;   // regularity band around the median pitch
export const HATCH_MIN_REGULAR = 0.7;  // fraction of gaps that must sit inside the band
export const HATCH_OVERLAP_FRAC = 0.5; // successive rows must overlap tangentially this much
export const ROW_EPS = 1.5;            // mask px — collinear/dashed pieces merge into one row
export const WIDE_PROTECT_RATIO = 2;   // heavier-pen member of a hairline family stays hard (wall overprint)
export const SPAN_PROTECT_RATIO = 3;   // a row spanning ≫ the run's median row is a wall riding the rhythm, not hatch
interface HatchCand { i: number; ang: number; x1: number; y1: number; x2: number; y2: number; w: number; }
interface HatchRow { d: number; t0: number; t1: number; segs: HatchCand[]; }

/** One periodic family found by the sweep — the (angle, pitch, pen-width)
 * signature plus its membership, in the caller's coordinate unit (ws-scaled).
 * `softIdx` is the subset the sweep's own wall guards would soften (extremal
 * rows, span-protected rows, heavy-pen overprints) — kept for diagnostics;
 * the MASK's soft/hard verdict comes from the lattice classifier above. */
export interface HatchRunInfo {
  /** Mean member angle, folded to [0, 180) — direction-free. */
  angleDeg: number;
  /** Median row-to-row gap (the pattern's pitch), in the caller's unit. */
  pitch: number;
  /** Modal device pen width of the members (meta high nibble). */
  modalW: number;
  rowCount: number;
  /** Tight bbox over member segments [x0, y0, x1, y1], caller's unit. */
  bbox: [number, number, number, number];
  /** Every segment index belonging to the run's rows. */
  memberIdx: number[];
  /** The subset the sweep's wall guards allow — see the interface comment. */
  softIdx: number[];
}

/** The family sweep: collect stroked non-curve candidates, cluster by angle
 * (folding the 0°/180° seam), merge collinear pieces into rows, and keep
 * maximal regularly-pitched tangentially-stacking runs. Returns the runs plus
 * the clip-only indices (invisible ink, independent of any family). */
function sweepHatchRuns(segs: number[], meta: Uint8Array, ws: number): { clipSoft: number[]; runs: HatchRunInfo[] } {
  const n = segs.length >> 2;
  const clipSoft: number[] = [];
  const runs: HatchRunInfo[] = [];
  if (!meta || !n) return { clipSoft, runs };
  const cand: HatchCand[] = [];
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    if (mt & SEG_CURVE) continue;
    if (mt & SEG_CLIP) { clipSoft.push(i); continue; }
    // Filled-not-stroked outlines bound SOLID ink (wall poché); hatch itself
    // is stroked linework, so exempting fills costs nothing.
    if (mt & SEG_FILLONLY) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.75) continue;                    // sub-cell specks can't form rows
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // fold to [0,180): direction-free
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, w: meta[i] >> 4 });
  }
  if (cand.length < HATCH_MIN_RUN) return { clipSoft, runs };
  cand.sort((a, b) => a.ang - b.ang);
  // sweep into angle clusters; a near-0° cluster merges with a near-180° one
  const clusters: HatchCand[][] = [];
  let cl: HatchCand[] = [cand[0]];
  for (let k = 1; k < cand.length; k++) {
    if (cand[k].ang - cand[k - 1].ang <= HATCH_ANGLE_TOL) cl.push(cand[k]);
    else { clusters.push(cl); cl = [cand[k]]; }
  }
  clusters.push(cl);
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters[clusters.length - 1];
    if (first[0].ang < HATCH_ANGLE_TOL && last[last.length - 1].ang > 180 - HATCH_ANGLE_TOL) {
      for (const s of last) s.ang -= 180;        // fold across the seam for the mean
      clusters[0] = last.concat(first);
      clusters.pop();
    }
  }
  const median = (arr: number[]): number => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  for (const members of clusters) {
    if (members.length < HATCH_MIN_RUN) continue;
    let sum = 0; for (const s of members) sum += s.ang;
    const th = (sum / members.length) * Math.PI / 180;
    const dxu = Math.cos(th), dyu = Math.sin(th);      // along the family
    const nxu = -dyu, nyu = dxu;                        // across it
    const rowsIn = members.map((s) => ({
      s,
      d: ((s.x1 + s.x2) / 2) * nxu + ((s.y1 + s.y2) / 2) * nyu,
      t0: Math.min(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
      t1: Math.max(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
    })).sort((a, b) => a.d - b.d);
    // collinear/dashed pieces at the same offset merge into one ROW
    const rows: HatchRow[] = [];
    let row: HatchRow = { d: rowsIn[0].d, t0: rowsIn[0].t0, t1: rowsIn[0].t1, segs: [rowsIn[0].s] };
    for (let k = 1; k < rowsIn.length; k++) {
      const r = rowsIn[k];
      if (r.d - row.d <= ROW_EPS) { row.t0 = Math.min(row.t0, r.t0); row.t1 = Math.max(row.t1, r.t1); row.segs.push(r.s); }
      else { rows.push(row); row = { d: r.d, t0: r.t0, t1: r.t1, segs: [r.s] }; }
    }
    rows.push(row);
    // maximal RUNS of rows: pitched within cap AND stacking tangentially
    let runStart = 0;
    const flushRun = (a: number, b: number) => {        // rows[a..b] inclusive
      const count = b - a + 1;
      if (count < HATCH_MIN_RUN) return;
      const gaps: number[] = [];
      for (let k = a + 1; k <= b; k++) gaps.push(rows[k].d - rows[k - 1].d);
      const med = median(gaps);
      if (!med) return;
      let reg = 0; for (const g of gaps) if (Math.abs(g - med) <= med * HATCH_PITCH_TOL) reg++;
      if (reg / gaps.length < HATCH_MIN_REGULAR) return;
      const widths: number[] = [];
      for (let k = a; k <= b; k++) for (const s of rows[k].segs) widths.push(s.w);
      const modalW = Math.max(1, median(widths));
      // hatch rows span a room; a wall at the family's angle spans the wing.
      // A row much longer than the run's median is a wall riding the pattern's
      // rhythm — softening it would let the escalated fill breach the room.
      const spans: number[] = [];
      for (let k = a; k <= b; k++) spans.push(rows[k].t1 - rows[k].t0);
      const medSpan = Math.max(1, median(spans));
      const memberIdx: number[] = [];
      const softIdx: number[] = [];
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      let angSum = 0, angN = 0;
      for (let k = a; k <= b; k++) {
        const guarded = rows[k].t1 - rows[k].t0 > SPAN_PROTECT_RATIO * medSpan;
        for (const s of rows[k].segs) {
          memberIdx.push(s.i);
          angSum += s.ang; angN++;
          bx0 = Math.min(bx0, s.x1, s.x2); by0 = Math.min(by0, s.y1, s.y2);
          bx1 = Math.max(bx1, s.x1, s.x2); by1 = Math.max(by1, s.y1, s.y2);
          // the sweep's wall guards: extremal rows stay hard, span-protected
          // rows stay hard, heavy-pen overprints stay hard
          if (k > a && k < b && !guarded && s.w < WIDE_PROTECT_RATIO * modalW) softIdx.push(s.i);
        }
      }
      const meanAng = ((angSum / Math.max(1, angN)) % 180 + 180) % 180;
      runs.push({ angleDeg: meanAng, pitch: med, modalW, rowCount: count,
                  bbox: [bx0, by0, bx1, by1], memberIdx, softIdx });
    };
    for (let k = 1; k < rows.length; k++) {
      const gap = rows[k].d - rows[k - 1].d;
      const ov = Math.min(rows[k].t1, rows[k - 1].t1) - Math.max(rows[k].t0, rows[k - 1].t0);
      const need = HATCH_OVERLAP_FRAC * Math.min(rows[k].t1 - rows[k].t0, rows[k - 1].t1 - rows[k - 1].t0);
      if (gap > HATCH_MAX_PITCH || ov < need) { flushRun(runStart, k - 1); runStart = k; }
    }
    flushRun(runStart, rows.length - 1);
  }
  return { clipSoft, runs };
}

// Signature quantization for the stable family id (issue #29): coarse enough
// to absorb CAD jitter (≪ the classifier's own tolerances), fine enough that
// distinct pattern specs never collide. The RAW signature values ride along
// beside the id so a caller can run its own tolerance match when an instance
// sits on a bucket boundary.
export const HATCH_ID_ANGLE_Q = 0.5;  // degrees
export const HATCH_ID_PITCH_Q = 0.1;  // px

/** One hatch-family INSTANCE: a periodic region of the sheet, carrying the
 * content-derived id that makes instances comparable. Two regions drawn with
 * the same pattern spec — a legend swatch and the plan region it labels — get
 * the SAME id, which is the whole point: matching them is `id === id`. The id
 * identifies a pattern, not a material; the legend maps pattern → material. */
export interface HatchFamily {
  /** Content hash of the quantized signature: `h-a{angle}p{pitch}w{penW}`.
   * Derived from geometry alone — stable across calls, crops, and sessions. */
  id: string;
  angle_deg: number;
  pitch_px: number;
  pen_w_px: number;
  rows: number;
  segments: number;
  /** Tight bbox over the instance's members, image px [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Member segment indices into the sheet's segs/meta arrays. */
  memberIdx: number[];
}

/** The context view of the sweep (issue #29): every periodic family on the
 * sheet as an instance record with its (angle, pitch, pen-width) signature —
 * in IMAGE PX (ws = 1), the frame every tool speaks. Pure and deterministic;
 * same input, same ids. */
export function hatchFamilies(segs: number[], meta: Uint8Array): HatchFamily[] {
  const { runs } = sweepHatchRuns(segs, meta, 1);
  const q = (v: number, step: number): number => Math.round(v / step) * step;
  return runs.map((r) => {
    const a = q(r.angleDeg, HATCH_ID_ANGLE_Q), p = q(r.pitch, HATCH_ID_PITCH_Q);
    return {
      id: `h-a${a.toFixed(1)}p${p.toFixed(1)}w${r.modalW}`,
      angle_deg: +r.angleDeg.toFixed(2),
      pitch_px: +r.pitch.toFixed(2),
      pen_w_px: r.modalW,
      rows: r.rowCount,
      segments: r.memberIdx.length,
      bbox: r.bbox.map((v) => +v.toFixed(1)) as [number, number, number, number],
      memberIdx: r.memberIdx,
    };
  });
}

// ── 3. boundary mask ───────────────────────────────────────────────────────
// Segments (image px) → Uint8Array raster at ws = maskDim/imageDim. Single-px
// Bresenham; coincident endpoints round to the same cell so chained walls stay
// continuous. Without meta the mask is bit-identical to the original (every
// cell 1). With meta, wall cells carry bit 1 and suspected-hatch cells bit 2 —
// a cell crossed by both keeps bit 1, so hard always wins. Curve chords (door
// swings, curved walls) additionally carry bit 4: still hard, but identifiable
// so annexDoorWedges can recognize a swing arc on a region's boundary.
//
// roles (#85, optional, LAST parameter): one code per segment from a sheet
// whose layers STATE what the ink is (lib/layers.ts) — a short-circuit over
// the heuristics, never a replacement:
//   boundary / structure → hard (bit 1), no classifyHatchSegs vote;
//   finish-pattern / annotation / demolition / hidden → not plotted at all —
//     the file says this ink is not a wall (a hidden layer is excluded
//     whatever its name, or a demolished wall traces as a real one);
//   unknown (0) → exactly today's path.
// Null roles (unlayered sheet, or nothing classified) is bit-identical to the
// pre-#85 mask — the fallback must be invisible, and a regression test holds
// it there. The second overload accepts upstream #85's positional shape
// (roles sixth, no scale pinning) so layered callers without a scale need no
// placeholder zeros; the canonical order keeps roles last.
export const MASK_CURVE_BIT = 4;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim?: number, meta?: Uint8Array | null, pxPerFt?: number, basePxPerFt?: number, page?: MaskPage | null, roles?: Uint8Array | null): MaskObj;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim?: number, meta?: Uint8Array | null, roles?: Uint8Array | null): MaskObj;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim = MASK_MAX_DIM, meta: Uint8Array | null = null, pxPerFt: number | Uint8Array | null = 0, basePxPerFt = 0, page: MaskPage | null = null, roles: Uint8Array | null = null): MaskObj {
  // the compat overload: a Uint8Array (or explicit null) in the pxPerFt slot
  // is a roles table, scale unknown
  if (pxPerFt instanceof Uint8Array || pxPerFt === null) { if (!roles) roles = pxPerFt; pxPerFt = 0; }
  // A1 (audit): the working raster must be a property of the SHEET, not of the
  // render scale. It used to be `ws = min(1, maxDim/imgmax)` — a CAP, not a pin —
  // so on any sheet rendering under the cap the mask resolution just followed the
  // render, and the per-sheet "Hi-Res render" toggle silently changed measured
  // square footage (11×17 at 1/8": 97.8 SF vs 134.0 SF, +37%). Above the cap the
  // resolution was pinned but `Math.round(seg*ws)` still quantized in RENDER px,
  // so cap-bound sheets shifted too (VA plan: −3.96% on one probe at identical mppf).
  //
  // Fix: map into the BASELINE render (RENDER_SCALE) before choosing the raster and
  // before quantizing. k is this render's ratio to baseline, and the baseline dims
  // it maps onto come from `page` — the sheet in POINTS.
  //
  // AUDIT F3 — WHY `page`, AND WHY THE FIRST ATTEMPT WAS A NO-OP. The first fix
  // (1a02b15) reconstructed the baseline dims from the RENDERED ones, as
  // `bW = imgW · k` with k from the px/ft ratio. `imgW` is `ceil(pageW · rs)`, so
  // that reconstruction carries the render's own rounding into the baseline, and
  // on a CAP-BOUND sheet the cap cancels k outright:
  //     ws = k · min(1, maxDim/(imgW·k)) = maxDim/imgW
  // — algebraically the OLD formula, render-dependent through imgW. Measured on a
  // 2160×1440 pt sheet (baseline 4320×2880, cap-bound): mask px per POINT came out
  // 1.388888889 at rs 2, 1.388640429 at rs 2.070 and 1.388598256 at the true
  // autoRenderScale 2.0704, and the mask itself grew to 3000×2001 at rs 5.374.
  // Zero mask cells differed fix-vs-nofix, and the VA plan still drifted up to
  // −7.03% across the Hi-Res toggle. Sub-cap it was not a no-op but still ±1 cell:
  // 1225×1585 at rs 2.07 where the RASTER mask of the same sheet is 1224×1584, so
  // the two masks of one sheet sat on different grids and one click yielded three
  // SFs at the ~0.02% level.
  // With `page`, the baseline dims are `ceil(pageDim · baseScale)` — identical at
  // every render scale — and k = baseScale/renderScale exactly (no ceil, and no
  // dependence on a calibration having happened yet). Mask px per point is then a
  // constant 1.388888889 / 3000×2000 at every rs above, and the vector grid equals
  // `rasterMaskScale`'s by construction (both call `baselineImgDims`).
  //
  // Without `page` the legacy px/ft reconstruction stands, so this is a no-op for
  // every existing caller (the bench and its goldens included), and at the default
  // render k === 1, ceil(pageDim·bs) === imgDim, and the two paths agree bit-for-bit.
  const pg = page && Number.isFinite(page.pageW) && page.pageW > 0 && Number.isFinite(page.pageH) && page.pageH > 0
    && Number.isFinite(page.baseScale) && page.baseScale > 0 && Number.isFinite(page.renderScale) && page.renderScale > 0
    ? page : null;
  let k: number, bW: number, bH: number;
  if (pg) {
    k = pg.baseScale / pg.renderScale;
    const bd = baselineImgDims(pg.pageW, pg.pageH, pg.baseScale);
    bW = bd.w; bH = bd.h;                                   // the BASELINE bitmap, from points
  } else {
    k = (Number.isFinite(basePxPerFt) && basePxPerFt > 0 && Number.isFinite(pxPerFt) && pxPerFt > 0)
      ? basePxPerFt / pxPerFt : 1;
    bW = imgW * k; bH = imgH * k;                            // image dims at baseline
  }
  const wsB = Math.min(1, maxDim / Math.max(bW, bH, 1));    // baseline raster scale
  const mw = Math.max(2, Math.ceil(bW * wsB)), mh = Math.max(2, Math.ceil(bH * wsB));
  const ws = k * wsB;                                       // image px → mask px at THIS render
  const mask = new Uint8Array(mw * mh);
  // pxPerFt = IMAGE px per foot (the sheet scale at this render). When known,
  // the hatch pitch cap converts to mask px through it, so whether a rhythm
  // reads as hatch or as walls is a property of the DRAWING, not of ws.
  // mppf = pxPerFt*k*wsB = basePxPerFt*wsB — the render scale cancels exactly.
  const mppf = Number.isFinite(pxPerFt) && pxPerFt > 0 ? pxPerFt * ws : 0;
  const soft = meta ? classifyHatchSegs(segs, meta, ws, mppf > 0 ? HATCH_MAX_PITCH_FT * mppf : HATCH_MAX_PITCH) : null;
  // curve chords that are demonstrably not door swings (closed circles, cloud
  // scallops) — a SEPARATE plane from SEG_CURVE, so refusing them never makes
  // them hatch-eligible (classifyHatchSegs still skips every SEG_CURVE chord)
  const noDoor = meta ? flagNonDoorArcs(segs, meta) : null;
  let softCount = 0;
  for (let i = 0, si = 0; i + 3 < segs.length; i += 4, si++) {
    const role = roles ? roles[si] : 0;
    if (role === 2 || role === 3 || role === 5 || role === 6) continue;  // pattern/annotation/demolition/hidden — stated non-boundary ink
    // stated boundary/structure: hard, no heuristic vote. The curve bit is not
    // a vote — it records geometry (door-swing recognition), so it still rides
    // on stated-hard curve chords exactly as on heuristic-hard ones.
    let v = role === 1 || role === 4 ? 1 : soft && soft[si] ? 2 : 1;
    if (v === 1 && meta && (meta[si] & SEG_CURVE)) v = 1 | MASK_CURVE_BIT;
    if ((v & MASK_CURVE_BIT) && noDoor && noDoor[si]) v |= MASK_NODOOR_BIT;
    if (v === 2) softCount++;
    // Quantization needs no separate baseline step: ws is now baseline-derived
    // (ws = k·wsB) and mw/mh come from the baseline dims, so seg*ws already lands
    // on the baseline grid. Measured: Math.round(seg*ws) and Math.round(seg*k*wsB)
    // agree on 400k random (rs, wsB, seg) draws — 0 differences. The audit plan
    // listed this as a separate fix (1.1i); it is subsumed by pinning ws.
    let x0 = Math.round(segs[i] * ws), y0 = Math.round(segs[i + 1] * ws);
    const x1 = Math.round(segs[i + 2] * ws), y1 = Math.round(segs[i + 3] * ws);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      if (x0 >= 0 && y0 >= 0 && x0 < mw && y0 < mh) mask[y0 * mw + x0] |= v;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  return { mask, mw, mh, ws, softCount, mppf };
}

// ── A8: the raster book-keeping the interactive path lives or dies on ───────
// Three shared devices, none of which change a single measured cell:
//
//  1. DilatedMask — a dilated mask that is never MATERIALIZED. dilateHardMask's
//     output is exactly `(dt[i] <= r) | (mask[i] & 2)`, and its only consumer
//     is floodPass, which reads a few thousand cells of it. Building all
//     mw·mh of them (a 9 MB write per rung, five rungs per arc cluster) to
//     read a fraction was the single largest allocator on the hover path.
//  2. regionBox — floodPass already knows the box it filled; every later
//     full-raster scan only ever looks at region cells, so the box is all the
//     raster any of them needs. A missing entry means "scan everything",
//     which is what they all did before.
//  3. scratch buffers — hardDT and the per-cluster mask copy write into
//     caller-owned arrays, so a six-door room allocates one of each instead
//     of six.
interface DilatedMask extends MaskObj { dilDT?: Uint8Array; dilR?: number }
interface RegionBox { x0: number; y0: number; x1: number; y1: number }
const regionBox = new WeakMap<Uint8Array, RegionBox>();
function boxOf(region: Uint8Array, mw: number, mh: number): RegionBox {
  return regionBox.get(region) || { x0: 0, y0: 0, x1: mw - 1, y1: mh - 1 };
}

// A hovered room runs ~30 fills and keeps ONE of their region bitmaps — every
// leak, every too-thin probe, every rejected ladder rung throws its raster
// away. Those buffers come back here instead of to the collector; only a fill
// that returns "ok" hands its region to the caller and leaves the pool.
const REGION_POOL_MAX = 2;
const regionPool: Uint8Array[] = [];   // two is the observed steady state — a fill takes one and the next leak gives it back
function takeRegion(n: number): Uint8Array {
  for (let k = regionPool.length - 1; k >= 0; k--) {
    if (regionPool[k].length === n) { const b = regionPool.splice(k, 1)[0]; b.fill(0); return b; }
  }
  return new Uint8Array(n);
}
function dropRegion(b: Uint8Array): void {
  if (regionPool.length < REGION_POOL_MAX) regionPool.push(b);
}


// ── 4. flood fill ──────────────────────────────────────────────────────────
// Scanline fill from an image-px seed. `barrier` picks which mask bits block:
// 3 = walls + hatch (the strict original behavior), 1 = walls only. hardHits/
// softHits count blocking encounters so the caller can tell a wall-bounded
// region from a hatch-bounded one.
function floodPass(maskObj: MaskObj, ix: number, iy: number, barrier: number): FloodResult {
  const { mask, mw, mh, ws } = maskObj;
  // virtual dilation (see DilatedMask): identical bits, no 9 MB buffer
  const dilDT = (maskObj as DilatedMask).dilDT;
  const dilR = dilDT ? (maskObj as DilatedMask).dilR as number : -1;
  const bits = (i: number): number => (dilDT === undefined ? mask[i] : (dilDT[i] <= dilR ? 1 : 0) | (mask[i] & 2));
  // feet-true guards when the scale is known (identical to the px values at
  // the 18 px/ft calibration), px fallbacks + floors otherwise — see the
  // resolution-independence block up top
  const mppf = maskObj.mppf || 0;
  const tinyPx = mppf > 0 ? Math.max(TINY_PX_FLOOR, Math.round(TINY_SF * mppf * mppf)) : TINY_PX;
  const minThick = mppf > 0 ? Math.max(MIN_THICK_FLOOR, Math.round(MIN_THICK_FT * mppf)) : MIN_THICK;
  const nudge = mppf > 0 ? Math.max(NUDGE_PX, Math.round(NUDGE_FT * mppf)) : NUDGE_PX;
  let sx = Math.round(ix * ws), sy = Math.round(iy * ws);
  if (sx < 0 || sy < 0 || sx >= mw || sy >= mh) return { status: "boundary" };
  if (bits(sy * mw + sx) & barrier) {
    // nudge: nearest open cell (clicks often land on hatch lines)
    let found: Point | null = null;
    for (let r = 1; r <= nudge && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = sx + dx, ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && !(bits(ny * mw + nx) & barrier)) { found = [nx, ny]; break; }
      }
    }
    if (!found) return { status: "boundary" };
    sx = found[0]; sy = found[1];
  }
  const region = takeRegion(mw * mh);
  const cap = Math.floor(mw * mh * LEAK_FRACTION);
  let count = 0, hardHits = 0, softHits = 0;
  let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
  // Span stack: packed cell indices in a flat Int32Array. The [x, y] pair per
  // pushed span allocated one two-element array per span — with tens of
  // thousands of spans per fill and thirty fills per hovered room it made the
  // fill GC-bound rather than raster-bound (A8). Same LIFO order, same pushes.
  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (x: number, y: number) => {
    if (sp === stack.length) { const g = new Int32Array(sp * 2); g.set(stack); stack = g; }
    stack[sp++] = y * mw + x;
  };
  // The dilated-mask read, INLINE. `bits` above is the same expression, but as
  // a closure it sits on the single hottest path in the engine (a leaking fill
  // touches the leak cap — 30% of the raster — and a six-door room runs thirty
  // fills); `dil` is loop-invariant, so the branch predicts perfectly and the
  // two loads stay in registers.
  const dil = dilDT !== undefined;
  const dtA = dilDT as Uint8Array;
  push(sx, sy);
  while (sp > 0) {
    const cell = stack[--sp];
    const py = (cell / mw) | 0, px = cell - py * mw;
    const row = py * mw;
    let x0 = px;
    for (;;) {
      if (x0 === 0) break;
      const j = row + x0 - 1;
      if ((dil ? (dtA[j] <= dilR ? 1 : 0) | (mask[j] & 2) : mask[j]) & barrier) break;
      if (region[j]) break;
      x0--;
    }
    if (x0 > 0) { const j = row + x0 - 1, b = dil ? (dtA[j] <= dilR ? 1 : 0) | (mask[j] & 2) : mask[j]; if (b & barrier) { if (b & 1) hardHits++; else softHits++; } }
    let x1 = px;
    for (;;) {
      if (x1 >= mw - 1) break;
      const j = row + x1 + 1;
      if ((dil ? (dtA[j] <= dilR ? 1 : 0) | (mask[j] & 2) : mask[j]) & barrier) break;
      if (region[j]) break;
      x1++;
    }
    if (x1 < mw - 1) { const j = row + x1 + 1, b = dil ? (dtA[j] <= dilR ? 1 : 0) | (mask[j] & 2) : mask[j]; if (b & barrier) { if (b & 1) hardHits++; else softHits++; } }
    // A fill that reaches the raster edge is a leak, and it used to note that
    // and keep filling — to the leak cap, 30% of the sheet — before the tail
    // of the function returned "leak" anyway. Nothing between here and there
    // can change that verdict or is read after it, so returning now is the
    // same value for up to a third of a raster less work (A8).
    if (x0 === 0 || x1 === mw - 1 || py === 0 || py === mh - 1) { dropRegion(region); return { status: "leak" }; }
    if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (py < by0) by0 = py; if (py > by1) by1 = py;
    let upOpen = false, downOpen = false;
    for (let x = x0; x <= x1; x++) {
      const idx = row + x;
      if (region[idx]) { upOpen = downOpen = false; continue; }
      region[idx] = 1; count++;
      if (py > 0) {
        const u = idx - mw;
        const ub = dil ? (dtA[u] <= dilR ? 1 : 0) | (mask[u] & 2) : mask[u];
        if (!(ub & barrier) && !region[u]) { if (!upOpen) { push(x, py - 1); upOpen = true; } }
        else { if (ub & barrier) { if (ub & 1) hardHits++; else softHits++; } upOpen = false; }
      }
      if (py < mh - 1) {
        const d = idx + mw;
        const db = dil ? (dtA[d] <= dilR ? 1 : 0) | (mask[d] & 2) : mask[d];
        if (!(db & barrier) && !region[d]) { if (!downOpen) { push(x, py + 1); downOpen = true; } }
        else { if (db & barrier) { if (db & 1) hardHits++; else softHits++; } downOpen = false; }
      }
    }
    if (count > cap) { dropRegion(region); return { status: "leak" }; }
  }
  // hatch/text slivers: plenty of cells but no room-like thickness
  if (count < tinyPx || bx1 - bx0 + 1 < minThick || by1 - by0 + 1 < minThick) { dropRegion(region); return { status: "tiny", count }; }
  regionBox.set(region, { x0: bx0, y0: by0, x1: bx1, y1: by1 });
  return { status: "ok", region, count, mw, mh, ws, mppf: mppf || undefined, hardHits, softHits };
}

// ── gap bridging (leak recovery) ───────────────────────────────────────────
// A room whose walls don't quite meet — a hairline drafting gap where two
// wall runs stop short of each other, or a jamb drawn a pixel shy of the
// wall — floods straight through the pinhole and dies as a "leak": the
// engine calls a plainly enclosed space not-a-room and the user is left
// tracing it by hand. Sealing is a hard-bit (wall) box dilation: radius r
// closes gaps up to ~2r px in MASK space, and with GAP_BRIDGE_MAX = 2 only
// pinholes ≤ ~4-5 px ever seal. A real doorway is tens of mask px wide at
// any plausible drawing scale, so it keeps leaking at every radius and an
// open floor plan is never fenced into a fake room. The traced ring sits
// ≤ r px inside the true wall line; snapVertices pulls the corners back onto
// true endpoints, and the rescue rides provenance (`gapBridged` →
// origin.gap_bridged_px) rather than passing itself off as a clean fill.

/** Box-dilate the HARD (wall) bit by Chebyshev radius r — separable
 *  two-pass, O(n·r). Soft (hatch) bits copy through untouched: hatch is
 *  transparent at the walls-only barrier, so it never causes a leak, and
 *  growing it would only skew the escalation tiers' soft/hard hit counts. */
export function dilateHard(maskObj: MaskObj, r: number): MaskObj {
  const { mask, mw, mh, ws, softCount, mppf } = maskObj;
  const horiz = new Uint8Array(mask);
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      if (mask[row + x] & 1) {
        const x1 = Math.min(mw - 1, x + r);
        for (let i = Math.max(0, x - r); i <= x1; i++) horiz[row + i] |= 1;
      }
    }
  }
  const out = new Uint8Array(horiz);
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      if (horiz[row + x] & 1) {
        const y1 = Math.min(mh - 1, y + r);
        for (let j = Math.max(0, y - r); j <= y1; j++) out[j * mw + x] |= 1;
      }
    }
  }
  // mppf rides through (upstream dropped it, but it predates mppf): the
  // bridged re-flood must judge tiny/thin at the same feet-true thresholds
  // as the fill it is rescuing.
  return { mask: out, mw, mh, ws, softCount, mppf };
}

// dilateHard materializes two full-raster copies per call, and the bridge
// rungs run once per LEAK — on the hover-preview path that is once per
// cursor step over open paper. The dilated hard bit is a pure function of
// (mask identity, r), and a sheet's mask object is cached upstream (the same
// assumption sealCache leans on), so the bridged rasters are memoized per
// mask; repeat hovers reuse them instead of re-churning ~2 rasters per rung.
// The wrapper MaskObj is rebuilt from the caller's `mo` each time so the
// riding fields (ws, softCount, mppf) always match the caller's view.
const bridgeCache = new WeakMap<Uint8Array, (Uint8Array | undefined)[]>();
function bridgedMask(mo: MaskObj, r: number): MaskObj {
  let per = bridgeCache.get(mo.mask);
  if (!per) { per = []; bridgeCache.set(mo.mask, per); }
  let m = per[r];
  if (!m) { m = dilateHard(mo, r).mask; per[r] = m; }
  return { mask: m, mw: mo.mw, mh: mo.mh, ws: mo.ws, softCount: mo.softCount, mppf: mo.mppf };
}

// The escalating fill. Pass 1 is the strict mask (walls + hatch — exactly the
// original behavior; masks with no soft cells never go further). When the strict
// pass is bounded by hatch, re-flood with hatch transparent (pass 2). Three tiers
// keyed off how much of the strict fill's boundary is soft (hatch) vs hard (wall):
//   • trapped (tiny/boundary): strict found no room — escalate UNBOUNDED (any
//     clean re-flood beats nothing).
//   • predominantly soft (≥ HATCH_BOUND_FRAC, e.g. a lone tile-grid cell): the
//     strict fill is a sliver of the real room — escalate UNBOUNDED.
//   • moderate ([HATCH_ESCALATE_FRAC, HATCH_BOUND_FRAC)): any real hatch run on
//     the boundary (hatched alcoves of a room are often well under a third of
//     its boundary; the floor only skips boundary specks). Escalate
//     GROW-BUT-VERIFY: accept walls-only only if it stays a clean "ok", GROWS
//     the region (an escalation that changes nothing isn't one — and must not
//     cost confidence), and stays ≤ growthMax×. A misclassified wall then
//     either leaks or balloons and is discarded — the escalation can never do
//     worse than the strict pass.
//   • lightly soft (< escalateFrac) or a leak: strict result stands
//     (removing linework only leaks more).
// `sensitivity` (0..1) dials the moderate tier's escalateFrac/growthMax via
// escalationParams; the default is the calibrated Balanced preset.
export function floodRegion(maskObj: MaskObj, ix: number, iy: number, sensitivity: number = SENS_BALANCED): FloodResult {
  const r = floodRegionLadder(maskObj, ix, iy, sensitivity);
  if (r.status !== "leak") return r;
  // Leak recovery (see the gap-bridging block above): seal hairline wall gaps
  // and rerun the whole ladder. The first radius that yields a clean fill
  // wins; a real opening keeps leaking at every radius, so the original leak
  // stands and bridging can never do worse than the un-bridged result. Only a
  // LEAK is recovered — a tiny/boundary verdict is truthful and must not be
  // dilated away.
  for (let br = 1; br <= GAP_BRIDGE_MAX; br++) {
    const rb = floodRegionLadder(bridgedMask(maskObj, br), ix, iy, sensitivity);
    if (rb.status === "ok") { rb.gapBridged = br; return rb; }
  }
  return r;
}

// The hatch-escalation ladder alone — floodRegion minus the bridging rungs.
// floodRegionSealed's seal machinery calls THIS, deliberately: its own dilated
// rungs (growback, virtual-boundary gates, sealedPx provenance) subsume
// pinhole recovery with a strictly better boundary, and a dilated VIEW
// re-entering the bridging loop would box-dilate the view's BASE mask — the
// wrong geometry at the wrong cost. Bridging joins the sealed ladder exactly
// once, as its last rung (see floodRegionSealedInner).
function floodRegionLadder(maskObj: MaskObj, ix: number, iy: number, sensitivity: number): FloodResult {
  const r1 = floodPass(maskObj, ix, iy, 3);
  if (!maskObj.softCount) return r1;
  if (r1.status === "leak") return r1;
  const { escalateFrac, growthMax } = escalationParams(sensitivity);
  let growthCap = Infinity;                            // unbounded unless we're in the moderate band
  if (r1.status === "ok") {
    const blocks = (r1.hardHits || 0) + (r1.softHits || 0);
    const softFrac = blocks ? (r1.softHits || 0) / blocks : 0;
    if (softFrac < escalateFrac) return r1;            // lightly hatch-bounded ⇒ strict is right
    if (softFrac < HATCH_BOUND_FRAC) growthCap = growthMax; // moderate ⇒ grow-but-verify
  }
  const r2 = floodPass(maskObj, ix, iy, 1);
  if (r2.status === "ok" && (r1.status !== "ok" || (r2.count > r1.count && r2.count <= r1.count * growthCap))) {
    r2.hatchFiltered = true;
    // AUDIT A2. WHICH REGIME accepted this escalation, not how far it reached.
    // Escalation GROWTH is useless as a magnitude here and worse than useless
    // as a threshold (corpus: tile-grid-room grows 451.8× and is right, IoU
    // 0.992; partition-bank-15in grows 5.09× and is wrong, IoU 0.197). What
    // does carry information is how much the engine PROMISED before accepting:
    //   bounded  — the moderate band: the re-flood had to grow AND stay inside
    //              growthMax, so a misclassified wall leaks or balloons and is
    //              thrown away. Grow-but-verify.
    //   trapped  — the strict pass found no room at all (tiny/boundary). The
    //              escalation is unbounded, but there was no measurement to
    //              lose: any clean re-flood beats nothing.
    //   override — predominantly soft (≥ HATCH_BOUND_FRAC): the strict pass
    //              DID return a bounded region and the escalation DISCARDS it,
    //              unbounded, on the hatch classifier's word alone. Strictly
    //              the most exposed of the three, and the only tier both known
    //              hatch failures sit in.
    r2.hatchTier = growthCap !== Infinity ? "bounded" : r1.status === "ok" ? "override" : "trapped";
    return r2;
  }
  return r1;
}

// ── 4b. leak recovery — seal door-width gaps ───────────────────────────────
// A room with an open doorway (no door swing drawn, or a faded line on a scan)
// is the flood's classic dead end: the fill escapes through the opening and the
// whole click comes back "leak". Sealing recovers it: re-flood with the HARD
// (wall) cells dilated by an escalating radius r — a square dilation closes any
// passage up to 2r mask px wide — then grow the bounded region back r steps
// against the ORIGINAL mask so the boundary still sits on the true linework
// everywhere except across the sealed opening (where the fill may reach up to
// r px past the wall ends — sub-inch at plan scales, and the seed star + review
// gate still apply). Soft (hatch) cells are never dilated: thickening a hatch
// family would fuse the pattern into a solid block and starve the fill.
//
// Every non-"ok" status gets a sealing attempt — not just "leak". A hatched
// room behind a doorway reads as TINY, not leak: the strict pass is trapped by
// the hatch, and the escalated walls-only pass leaks through the door and is
// discarded. On the sealed mask that same escalation is bounded and succeeds.
// A genuine dense-linework tiny/boundary just fails again on every radius
// (dilation only adds barrier) and the original status stands — the retries
// cost little because trapped floods are small and dilated masks are cached.
//
// RADII ARE SCALE-DEPENDENT. A doorway is feet wide, and how many mask px that
// is depends on the sheet's scale and render resolution — at 1/4" = 1'-0" a
// 3'-0" door can be anywhere from ~20 to ~160 mask px. Callers that know the
// scale should pass sealRadiiFor(maskPxPerFt); the exported SEAL_RADII default
// is the scale-blind floor (hairline drafting gaps only).
export const SEAL_RADII = [1, 2, 4];    // fallback — seals gaps up to 2/4/8 px wide
export const DOOR_SEAL_MAX_FT = 5;      // widest opening sealing will bridge (3'-0" doors + margin)
export const SEAL_R_MAX = 128;          // absolute radius cap (cost + the Uint8 distance transform)
export const SEAL_VIRTUAL_MAX = 0.25;   // a sealed region's boundary must be ≥75% real linework
export const SEAL_MAX_SHEET_FRAC = 0.30; // ...and must still satisfy the room-size cap (= LEAK_FRACTION)
/** How far off drawn linework a boundary cell may sit and still count as REAL
 *  rather than dilation-invented — see virtualBoundaryFrac. RASTER cells, not
 *  feet, and audit F2 established that deliberately: the margin has to stay
 *  small next to the DILATION radius being judged, and the radii this gate sees
 *  scale with the sheet while a feet-true margin would not. */
export const VIRTUAL_HUG_PX = 3;

/** The escalation ladder for a sheet where one foot spans `maskPxPerFt` mask px:
 *  1, 2, 4, … doubling up to the radius that bridges a DOOR_SEAL_MAX_FT opening
 *  (a dilation of r closes gaps ≤ 2r). Falls back to SEAL_RADII when the scale
 *  is unknown or degenerate. */
export function sealRadiiFor(maskPxPerFt: number): number[] {
  if (!Number.isFinite(maskPxPerFt) || maskPxPerFt <= 0) return SEAL_RADII;
  const maxR = Math.min(SEAL_R_MAX, Math.ceil((DOOR_SEAL_MAX_FT * maskPxPerFt) / 2));
  const radii: number[] = [];
  for (let r = 1; r < maxR; r *= 2) radii.push(r);
  radii.push(maxR);
  return radii;
}

// Distance transforms + dilated masks are pure functions of the mask; memoized
// per mask identity so hover-preview and click share the work (a sheet's mask
// object is cached upstream).
interface SealScratch { dt: Uint8Array; }
const sealCache = new WeakMap<Uint8Array, SealScratch>();
/** Dilated masks used to be memoized per radius here too. They are no longer
 *  built at all — see dilatedView — so the only thing worth keeping is `dt`. */

// MANHATTAN (city-block) distance to the nearest HARD cell, two-pass chamfer,
// saturating at 255 (radii are capped far below). One O(n) pass pair makes
// every dilation radius an O(n) threshold instead of r erosion sweeps.
//
// Manhattan, not chessboard, deliberately: growRegionBack walks this field by
// STRICT descent, and the city-block metric has no plateau faces — every open
// cell at distance d has a 4-neighbor at d−1 (step toward its wall), so the
// stolen band is fully recoverable, while the ridge in front of a sealed
// doorway (where two jamb fronts tie) stays a strict-descent dead end.
// Chessboard contours are squares whose flat faces plateau for r cells at a
// stretch — descent stalls inside rooms and creeps through doorways instead.
function hardDT(mask: Uint8Array, mw: number, mh: number, out?: Uint8Array): Uint8Array {
  // `out` lets the caller supply a scratch buffer (the per-arc-cluster retries
  // want one field, not one per cluster). Every cell is written by the forward
  // pass before anything reads it, so a dirty buffer is safe; the fill is kept
  // for a fresh allocation's sake only.
  const dt = out || new Uint8Array(mw * mh).fill(255);
  for (let y = 0; y < mh; y++) {                       // forward: W, N
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      const i = row + x;
      if (mask[i] & 1) { dt[i] = 0; continue; }
      let d = 255;
      if (x > 0) d = Math.min(d, dt[i - 1] + 1);
      if (y > 0) d = Math.min(d, dt[i - mw] + 1);
      dt[i] = Math.min(255, d);
    }
  }
  for (let y = mh - 1; y >= 0; y--) {                  // backward: E, S
    const row = y * mw;
    for (let x = mw - 1; x >= 0; x--) {
      const i = row + x;
      let d = dt[i];
      if (x < mw - 1) d = Math.min(d, dt[i + 1] + 1);
      if (y < mh - 1) d = Math.min(d, dt[i + mw] + 1);
      dt[i] = Math.min(255, d);
    }
  }
  return dt;
}

// ── A8: the SAME transform, for a mask that differs in a handful of cells ───
// The door-swing retry re-runs the distance transform once per arc cluster,
// against a mask that differs from the sheet's by the few hundred cells of one
// arc — and that recomputation, not the fills, is the largest single cost on
// the interactive path (12 clusters × two passes over the whole raster, per
// hovered room). It does not have to be global.
//
// Opening a set of cells C can only RAISE distances, and only for cells whose
// every nearest hard cell lay in C. So dt is unchanged at every cell i with
//     L1(i, box(C)) > dt[i]
// — i keeps a hard cell at least as close as anything in C. Both sides of that
// inequality are 1-Lipschitz in L1, so if it holds on the ring just outside a
// window B ⊇ box(C) it holds everywhere beyond B too: step away from the box
// and the left side gains 1 while the right gains at most 1. Grow B until the
// ring passes, and the transform only has to be redone INSIDE B, seeded from
// the unchanged values on its edge.
//
// The seeding is exact for the same reason the two-pass chamfer is exact at
// all: an L1 geodesic from an interior cell to a hard cell outside B is a
// monotone staircase, so it crosses the edge at a cell whose distance is
// already known, and `edge value + steps to the edge` is the true distance.

/** L1 distance from (x, y) to the box [bx0..bx1] × [by0..by1] (0 inside). */
function l1ToBox(x: number, y: number, bx0: number, by0: number, bx1: number, by1: number): number {
  const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0;
  const dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
  return dx + dy;
}

/** Window big enough that opening `cl` cannot change dt outside it, or null
 *  when no window short of the whole raster qualifies. */
function dtDirtyWindow(cl: number[], mw: number, mh: number, dt: Uint8Array): RegionBox | null {
  let cx0 = mw, cy0 = mh, cx1 = -1, cy1 = -1;
  for (const i of cl) {
    const y = (i / mw) | 0, x = i - y * mw;
    if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
  }
  if (cx1 < 0) return null;
  for (let w = 16; ; w *= 2) {
    const x0 = cx0 - w, y0 = cy0 - w, x1 = cx1 + w, y1 = cy1 + w;
    if (x0 <= 0 && y0 <= 0 && x1 >= mw - 1 && y1 >= mh - 1) return null;   // no cheaper than the full pass
    // the ring immediately outside the window, corners included (cells off the
    // raster pass vacuously — there is nothing out there to be wrong about)
    const clear = (x: number, y: number): boolean =>
      x < 0 || y < 0 || x >= mw || y >= mh || dt[y * mw + x] < l1ToBox(x, y, cx0, cy0, cx1, cy1);
    let ok = true;
    for (let x = x0 - 1; x <= x1 + 1 && ok; x++) ok = clear(x, y0 - 1) && clear(x, y1 + 1);
    for (let y = y0; y <= y1 && ok; y++) ok = clear(x0 - 1, y) && clear(x1 + 1, y);
    if (ok) return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(mw - 1, x1), y1: Math.min(mh - 1, y1) };
  }
}

/** Two-pass chamfer restricted to `b`, reading the unchanged field outside it
 *  straight out of `dt` — the same recurrence hardDT runs, same saturation. */
function hardDTWindow(mask: Uint8Array, mw: number, mh: number, dt: Uint8Array, b: RegionBox): void {
  for (let y = b.y0; y <= b.y1; y++) {
    const row = y * mw;
    for (let x = b.x0; x <= b.x1; x++) {
      const i = row + x;
      if (mask[i] & 1) { dt[i] = 0; continue; }
      let d = 255;
      if (x > 0) d = Math.min(d, dt[i - 1] + 1);
      if (y > 0) d = Math.min(d, dt[i - mw] + 1);
      dt[i] = Math.min(255, d);
    }
  }
  for (let y = b.y1; y >= b.y0; y--) {
    const row = y * mw;
    for (let x = b.x1; x >= b.x0; x--) {
      const i = row + x;
      let d = dt[i];
      if (x < mw - 1) d = Math.min(d, dt[i + 1] + 1);
      if (y < mh - 1) d = Math.min(d, dt[i + mw] + 1);
      dt[i] = Math.min(255, d);
    }
  }
}

/** Diamond (Manhattan) dilation of the HARD cells by r — every cell within
 *  city-block distance r of a wall becomes barrier; along a wall's axis a gap
 *  of ≤ 2r closes. Soft (bit 2) cells carry over untouched; a soft cell
 *  swallowed by the dilation becomes 3, and hard wins every barrier test.
 *  `dt` lets floodRegionSealed reuse its cached distance transform; standalone
 *  callers may omit it. */
export function dilateHardMask(mo: MaskObj, r: number, dt?: Uint8Array): MaskObj {
  const { mask, mw, mh, ws, softCount, mppf } = mo;
  const n = mw * mh;
  const d = dt || hardDT(mask, mw, mh);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (d[i] <= r ? 1 : 0) | (mask[i] & 2);
  return { mask: out, mw, mh, ws, softCount, mppf };
}

/** The same dilation, UNMATERIALIZED: a MaskObj floodPass reads through
 *  `dt[i] <= r` per visited cell instead of a precomputed buffer. Bit-identical
 *  to dilateHardMask(mo, r, dt) at every index — that function's whole body is
 *  this expression — but it costs no 9 MB write and no O(mw·mh) pass, which is
 *  what the seal ladder needed: five rungs × one arc cluster each, per hover.
 *  Only floodPass ever reads a dilated mask (growback and the boundary
 *  fractions read the ORIGINAL mask and the dt directly), so nothing else has
 *  to know. */
function dilatedView(mo: MaskObj, r: number, dt: Uint8Array): DilatedMask {
  return { mask: mo.mask, mw: mo.mw, mh: mo.mh, ws: mo.ws, softCount: mo.softCount, mppf: mo.mppf, dilDT: dt, dilR: r };
}

// Grow the sealed-mask region back toward the true linework (4-connected BFS,
// ≤ r layers) into cells open on the ORIGINAL mask. Two constraints keep the
// growth honest at door-scale radii:
//   • dt[cell] ≤ r — only cells the dilation actually stole are recoverable;
//   • dt never INCREASES along a growth path — the region descends (or moves
//     level) toward the walls it was pushed off of. Plateau moves are what
//     recover corner blocks and wall-hugging runs (their dt is min-of-two-walls
//     and holds constant along one axis). The doorway still can't be crossed:
//     past the wall plane the Manhattan distance to the jambs strictly RISES,
//     so every path out of the opening would have to ascend — forbidden. That
//     asymmetry (plateaus inside, ascent outside) is the whole trick.
// With ascent forbidden the walk is naturally confined; no step budget needed.
// `barrier` mirrors the fill that produced the region: walls-only when it
// escalated past hatch, walls+hatch otherwise.
function growRegionBack(f: { region: Uint8Array; count: number; mw: number; mh: number }, orig: MaskObj, r: number, barrier: number, dt: Uint8Array): void {
  const { region, mw, mh } = f;
  const mask = orig.mask;
  const b = boxOf(region, mw, mh);        // frontier cells are region cells
  regionBox.set(region, b);               // ...and the growth below extends it
  let frontier: number[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    const row = y * mw;
    for (let x = b.x0; x <= b.x1; x++) {
      const i = row + x;
      if (!region[i]) continue;
      if ((x > 0 && !region[i - 1]) || (x < mw - 1 && !region[i + 1]) || (y > 0 && !region[i - mw]) || (y < mh - 1 && !region[i + mw])) frontier.push(i);
    }
  }
  const tryGrow = (from: number, to: number, next: number[]) => {
    if (!region[to] && !(mask[to] & barrier) && dt[to] <= r && dt[to] <= dt[from]) {
      region[to] = 1; f.count++; next.push(to);
      const y = (to / mw) | 0, x = to - y * mw;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
  };
  while (frontier.length) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % mw, y = (i / mw) | 0;
      if (x > 0) tryGrow(i, i - 1, next);
      if (x < mw - 1) tryGrow(i, i + 1, next);
      if (y > 0) tryGrow(i, i - mw, next);
      if (y < mh - 1) tryGrow(i, i + mw, next);
    }
    frontier = next;
  }
}

// ── 4c. door-swing inclusion — measure to the wall opening ─────────────────
// A drawn door (leaf + swing arc) bounds the flood, which keeps rooms from
// merging through their doorways — but the swing wedge behind the arc IS floor
// the estimator must count: flooring runs under the door. The wedge is NOT an
// enclosed pocket (its far edge is the open doorway itself), so it cannot be
// annexed by flooding "behind the arc" — that walks straight out the opening.
//
// Instead, doorways UNIFY: re-flood with CURVE cells (bit 4) transparent so
// the arc no longer bounds the room, and let gap sealing close the doorway at
// the wall plane exactly as it would a cased opening. The result reads to the
// threshold, wedge included, neighbor still excluded — with every sealing
// sanity gate in force.
//
// PER ARC, not all at once (adversarial review, round 8): a room ringed by
// several open doorways used to open every boundary arc in one retry — the
// combined growth blew the allowance, the whole retry was rejected, and a
// multi-door room lost every wedge (~a quarter-circle of real floor per
// door). Now each arc CLUSTER (connected curve cells; dash gaps bridge)
// retries independently and its acceptance is bounded by the arc's OWN
// GEOMETRY, re-fitted from the cluster's cells (arcClusterFit →
// wedgeAllowance): the sector the leaf sweeps about the fitted hinge, boxed in
// the arc's CHORD FRAME, capped at two 5-ft doors' worth.
//
// The claim that used to stand here — that a curved wall's thin box could
// never admit the closet behind it — was FALSE, and this is the correction.
// The box was AXIS-ALIGNED, so a diagonal shallow arc got a near-square one;
// the ceiling was a constant ≈51 SF at every scale that ignored the arc's own
// radius; and the rim was denominated in mask px. A 30 ft wall with a 2.5 ft
// bulge annexed the whole ~50 SF behind it, at 0.97 confidence, labelled
// "incl. door swing", with no door anywhere in the scene. What actually keeps
// a curved wall honest is its RADIUS: 46 ft is not a door leaf, and a cluster
// that fits one clean circle of non-leaf radius gets no allowance at all.
export const WEDGE_SLACK = 1.3;        // growth head-room over the ideal quarter-circle
export const WEDGE_GROWTH_FRAC = 0.30; // or this fraction of the region — corridors touch many doors
export const WEDGE_MAX_DOORS = 12;     // absolute ceiling on the fractional allowance — 30% of a
                                       // giant region (sheet-margin space) is not a door's worth
/** Per-door growth allowance (mask cells) at maskPxPerFt: a DOOR_SEAL_MAX_FT
 *  leaf's swing wedge, with slack. 0 (skip the door retry) when the scale is
 *  unknown. */
export function doorWedgeCapPx(maskPxPerFt: number): number {
  if (!Number.isFinite(maskPxPerFt) || maskPxPerFt <= 0) return 0;
  return Math.round((Math.PI / 4) * (DOOR_SEAL_MAX_FT * maskPxPerFt) ** 2 * WEDGE_SLACK);
}

/** Curve cells hugging THIS region's boundary (Chebyshev ≤ 3, covering a
 *  2-px arc raster), grouped into CLUSTERS — one per door arc; gaps up to
 *  3 cells bridge, so a dashed arc is one cluster. Locality is what makes
 *  the retry work on dense plans: a hospital wing has dozens of drawn
 *  doors, and opening arcs beyond the clicked room's boundary merges
 *  spaces through doorways the seal ladder can't all close. (Per-click
 *  build, no cache — the retry only runs on curve-adjacent rooms, and the
 *  hover path already caches per room.) */
function boundaryCurveClusters(mo: MaskObj, region: Uint8Array): number[][] {
  const { mw, mh } = mo;
  const src = mo.mask;
  const near: number[] = [];
  // A cell can only be within Chebyshev 3 of the region if it is within 3 of
  // the region's own box, so the search window is the box grown by 3 — scanline
  // order inside it is the same order the full-raster scan visited them in.
  const b = boxOf(region, mw, mh);
  const y0 = Math.max(0, b.y0 - 3), y1 = Math.min(mh - 1, b.y1 + 3);
  const x0 = Math.max(0, b.x0 - 3), x1 = Math.min(mw - 1, b.x1 + 3);
  for (let y = y0; y <= y1; y++) {
    const row = y * mw;
    for (let x = x0; x <= x1; x++) {
      const i = row + x;
      if (!(src[i] & MASK_CURVE_BIT)) continue;
      let n = false;
      for (let dy = -3; dy <= 3 && !n; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mh) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < mw && region[ny * mw + nx]) { n = true; break; }
        }
      }
      if (n) near.push(i);
    }
  }
  // expand from the near cells through EVERY connected curve cell: a door
  // that swings into the clicked space has only part of its arc hugging the
  // boundary, but the retry must open (and the allowance must be sized by)
  // the WHOLE arc — a partial cluster's bounding box under-sizes the wedge
  // and the door is wrongly rejected
  const clusters: number[][] = [];
  // `seen` is SPARSE — only curve cells are ever marked, a few hundred per
  // door — so a Set costs a few KB where the full-raster flag plane cost 9 MB
  // per hover. Cluster order still comes from `near` (scanline) and the walk
  // order from the stack, both untouched.
  const seen = new Set<number>();
  for (const s of near) {                    // scanline order ⇒ deterministic clusters
    if (seen.has(s)) continue;
    const cl: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const i = stack.pop() as number;
      cl.push(i);
      const x = i % mw, y = (i / mw) | 0;
      for (let dy = -3; dy <= 3; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mh) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= mw) continue;
          const j = ny * mw + nx;
          if (!seen.has(j) && (src[j] & MASK_CURVE_BIT)) { seen.add(j); stack.push(j); }
        }
      }
    }
    clusters.push(cl);
  }
  return clusters;
}

/** A boundary curve cluster, re-fitted as geometry.
 *  A cluster is a bag of mask CELLS — it carries no radius, and a per-SEGMENT
 *  bit can't supply one (buildMask ORs bits per crossing segment, so a cell
 *  touched by two different arcs carries both). Re-fitting the circle from the
 *  cells themselves is what actually works, and it is the only place the
 *  sheet scale (MaskObj.mppf) is available, so the feet-true door-leaf test
 *  lives here rather than in render-time arc detection. */
export interface ArcClusterFit {
  cx: number; cy: number;      // fitted centre, mask px (the HINGE of a door arc)
  r: number;                   // fitted radius, mask px
  rms: number;                 // fit residual, mask px
  good: boolean;               // one circle explains the cluster (a double door's two arcs do not)
  sweep: number;               // angular extent about the centre, radians
  noDoorFrac: number;          // fraction of cells flagged MASK_NODOOR_BIT
  bu: number; bn: number;      // CHORD-FRAME extents (along / across the arc's own chord), mask px
  buH: number; bnH: number;    // ...the same box widened to reach the hinge (only meaningful when `good`)
}

/** Least-squares circle through a cluster's cells + its chord-frame extent.
 *  The chord frame is the whole point of the extent: an axis-aligned box gives
 *  a DIAGONAL shallow arc a near-square box (a 30 ft chord at 45° boxes
 *  21 ft × 21 ft instead of 30 ft × its 2.5 ft sagitta), which is how a curved
 *  wall used to buy itself a door's worth of allowance. */
export function arcClusterFit(cl: number[], mw: number, mask: Uint8Array): ArcClusterFit {
  const m = cl.length;
  const X = (i: number) => i % mw, Y = (i: number) => (i / mw) | 0;
  let mx = 0, my = 0, noDoor = 0;
  for (const i of cl) { mx += X(i); my += Y(i); if (mask[i] & MASK_NODOOR_BIT) noDoor++; }
  mx /= m; my /= m;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (const i of cl) {
    const x = X(i) - mx, y = Y(i) - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
  }
  // principal axis of the cells = the arc's own chord direction (a shallow arc
  // is dominated by its chord); the covariance is already accumulated above
  const tr = sxx + syy, dsc = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const l1 = tr / 2 + dsc;
  let ux = sxy, uy = l1 - sxx;
  if (Math.hypot(ux, uy) < 1e-9) { ux = 1; uy = 0; } else { const L = Math.hypot(ux, uy); ux /= L; uy /= L; }
  let u0 = Infinity, u1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (const i of cl) {
    const x = X(i) - mx, y = Y(i) - my;
    const a = x * ux + y * uy, b = -x * uy + y * ux;
    if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < n0) n0 = b; if (b > n1) n1 = b;
  }
  const bu = u1 - u0 + 1, bn = n1 - n0 + 1;
  const base = { cx: mx, cy: my, r: 0, rms: Infinity, good: false, sweep: 0, noDoorFrac: noDoor / m, bu, bn, buH: bu, bnH: bn };
  const det = sxx * syy - sxy * sxy;
  if (m < ARC_MIN_CHORDS || Math.abs(det) < 1e-9) return base;
  const cx = (sxz * syy - syz * sxy) / (2 * det), cy = (syz * sxx - sxz * sxy) / (2 * det);
  let r = 0;
  for (const i of cl) r += Math.hypot(X(i) - mx - cx, Y(i) - my - cy);
  r /= m;
  if (!(r > 0)) return base;
  let s2 = 0;
  const angs: number[] = [];
  for (const i of cl) {
    const dx = X(i) - mx - cx, dy = Y(i) - my - cy;
    const d = Math.hypot(dx, dy) - r;
    s2 += d * d;
    angs.push(Math.atan2(dy, dx));
  }
  const rms = Math.sqrt(s2 / m);
  angs.sort((a, b) => a - b);
  let gap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
  for (let k = 1; k < angs.length; k++) if (angs[k] - angs[k - 1] > gap) gap = angs[k] - angs[k - 1];
  // the hinge (fitted centre) in the SAME chord frame, so the wedge's box can
  // reach it — a quarter arc's own box is smaller than the wedge it bounds
  const hu = cx * ux + cy * uy, hn = -cx * uy + cy * ux;
  return {
    ...base,
    cx: cx + mx, cy: cy + my, r, rms,
    good: rms <= Math.max(CLUSTER_FIT_TOL_PX, CLUSTER_FIT_TOL_FRAC * r),
    sweep: Math.max(0, 2 * Math.PI - gap),
    buH: Math.max(u1, hu) - Math.min(u0, hu) + 1,
    bnH: Math.max(n1, hn) - Math.min(n0, hn) + 1,
  };
}

/** The growback rim, in FEET. The retry's boundary may sit up to the seal
 *  growback margin (dt ≤ 3 cells at the 18 px/ft calibration — 2 inches)
 *  outside the arc's own extent, so the allowance carries a rim of that
 *  width. Written as 3 CELLS it was not feet-true: the rim's AREA is
 *  width × perimeter, and with the perimeter growing as mppf the rim shrank
 *  as 1/mppf in SF — the same drawing got a different allowance at a
 *  different raster. Denominated in feet it is resolution-free, with the
 *  3-cell raster-honesty floor kept below the calibration point. */
export const WEDGE_RIM_FT = 3 / CAL_MPPF;              // = 2 inches
export function wedgeRimPx(maskPxPerFt: number): number {
  if (!Number.isFinite(maskPxPerFt) || maskPxPerFt <= 0) return 3;
  return Math.max(3, Math.round(WEDGE_RIM_FT * maskPxPerFt));
}

/** Growth (mask cells) a cluster's curve-transparent retry may add, and
 *  whether the cluster looks like a door swing at all.
 *
 *  A door retry annexes the SECTOR between the arc and its hinge — and the
 *  hinge is the fitted circle's CENTRE, so the sector is 0.5·θ·r², bounded
 *  independently by the cluster's chord-frame box (which must include that
 *  centre, or a quarter-arc's box would be smaller than its own wedge).
 *  Two refusals, and the line between them is whether the cluster's OWN
 *  geometry already bounds the growth:
 *    • flagged non-door (closed circle / cloud scallop) AND no clean circle
 *      fit — a cloud explains nothing about how far a hole in it can reach, so
 *      only the refusal stands between it and 51 SF of the next room. A
 *      flagged cluster that DOES fit one circle needs no refusal: the sector
 *      bound below is its own interior, and the corpus's real plan counts the
 *      floor inside a drawn ring as floor.
 *    • one clean circle whose radius is not a door leaf — what a curved wall
 *      always is. Here geometry does NOT help: a 46 ft radius sweeps a 700 SF
 *      sector, so the old constant ceiling (2 × a 5 ft door's wedge ≈ 51 SF at
 *      every scale) let a 30 ft × 2.5 ft wall annex the ~50 SF behind it. Only
 *      the upper edge of the band refuses — an arc SHORTER than a closet leaf
 *      is bounded by its own tiny sector, so DOOR_R_MIN_FT governs ranking. */
export function wedgeAllowance(fit: ArcClusterFit, mppf: number, wedgeCapPx: number): number {
  if (fit.noDoorFrac > 0.5 && !fit.good) return 0;
  if (fit.good && mppf > 0 && fit.r / mppf > DOOR_R_MAX_FT) return 0;
  const rim = wedgeRimPx(mppf);
  const bu = fit.good ? fit.buH : fit.bu, bn = fit.good ? fit.bnH : fit.bn;
  let area = bu * bn;
  if (fit.good) area = Math.min(area, 0.5 * fit.sweep * fit.r * fit.r);
  area += 2 * rim * (bu + bn) + 4 * rim * rim;
  return Math.min(2 * wedgeCapPx, Math.round(area * WEDGE_SLACK));
}

/** How door-like a cluster is, for RANKING (the wedge budget is finite, and
 *  taking clusters in scanline order let a row of curved fixtures spend it
 *  before the room's real doors were ever reached). Higher is more door-like. */
function doorLikeness(fit: ArcClusterFit, mppf: number): number {
  let s = 1 - fit.noDoorFrac;
  const swDeg = (fit.sweep * 180) / Math.PI;
  if (fit.good) {
    s += 1;
    if (mppf > 0 && fit.r / mppf >= DOOR_R_MIN_FT && fit.r / mppf <= DOOR_R_MAX_FT) s += 4;
    if (swDeg >= 45 && swDeg <= 190) s += 2;
  }
  return s;
}

// Walk the seed up the distance field until it clears the dilation radius —
// a click near a wall lands inside the dilated barrier, where floodPass's
// 3-px nudge can't rescue it. Strict ascent never crosses a wall (dt = 0), so
// the walk stays in the seed's own open component; if it stalls on a ridge
// before clearing r, the original seed stands and the attempt fails as before.
function ascendSeed(dt: Uint8Array, mw: number, mh: number, ws: number, ix: number, iy: number, r: number): [number, number] {
  let cx = Math.max(0, Math.min(mw - 1, Math.round(ix * ws)));
  let cy = Math.max(0, Math.min(mh - 1, Math.round(iy * ws)));
  for (let step = 0; step < 2 * r && dt[cy * mw + cx] <= r; step++) {
    let bx = cx, by = cy, bd = dt[cy * mw + cx];
    if (cx > 0 && dt[cy * mw + cx - 1] > bd) { bd = dt[cy * mw + cx - 1]; bx = cx - 1; by = cy; }
    if (cx < mw - 1 && dt[cy * mw + cx + 1] > bd) { bd = dt[cy * mw + cx + 1]; bx = cx + 1; by = cy; }
    if (cy > 0 && dt[(cy - 1) * mw + cx] > bd) { bd = dt[(cy - 1) * mw + cx]; bx = cx; by = cy - 1; }
    if (cy < mh - 1 && dt[(cy + 1) * mw + cx] > bd) { bd = dt[(cy + 1) * mw + cx]; bx = cx; by = cy + 1; }
    if (bx === cx && by === cy) break;                 // stalled on a ridge
    cx = bx; cy = by;
  }
  return [cx / ws, cy / ws];
}

// One base-flood + seal-ladder attempt against a specific mask. The dt used
// for growback/virtual-boundary checks is the ATTEMPT mask's own transform, so
// the curve-transparent retry measures distance to walls-without-arcs.
//
// `minPassPx` > 0 turns on the feet-true minimum-passage rule: the PRIMARY
// flood runs against walls dilated by that radius (closing sub-MIN_PASS_FT
// slits — see minPassRadiusFor), grown back onto the true linework. This is a
// SEMANTIC default, not a repair: whether a hair-width slit connects two
// spaces must be a property of the drawing, never of the mask resolution. If
// the dilated flood fails (open space still leaks; the dilation ate a
// sliver-sized region), everything falls back exactly to the old behavior:
// raw flood first, then the seal ladder — sealing still only ever improves.
//
// AUDIT A3. The min-passage path is a DILATION path — the same machinery the
// seal ladder runs, at a smaller radius — and for a year it took neither of
// the ladder's two sanity gates and reported no provenance at all. Because
// minPassPx > 0 on every scaled sheet, that made the ladder's advertised
// "room-size cap + ≥75%-real-boundary" guarantee vacuous on the PRIMARY path:
// a region the ladder would have refused was returned unguarded, with
// sealedPx/virtualFrac unset, so the readout said nothing and traceConfidence
// scored it a verbatim 1.00. The path now reports itself:
//   • minPassPx    — the radius that ran, whenever the rule changed the answer
//   • minPassDelta — the fraction of the VERBATIM flood's region the rule
//                    removed: 1 − minPass.count / rawFlood.count, and 1 when
//                    the verbatim flood produced no bounded region at all
//                    (the rule is then the only reason there is a measurement).
// Both are only set when minPassDelta > 0. The rule runs on essentially every
// scaled click and usually changes nothing; provenance for "a rule ran and did
// not matter" is noise, and a confidence deduction for it would be a lie.
//
// AUDIT F1/F2 (post-A3 review). A3 also applied both of the ladder's gates
// here UNCONDITIONALLY, and that was a regression, because the two paths ask
// different questions. Which one this is turns on a single fact — does the
// VERBATIM linework already bound the clicked space?
//
//   • it does (minPassDelta < 1) — the rule is TRIMMING. Its region is then a
//     SUBSET of the verbatim flood's (the dilation only ever removes open
//     cells, ascendSeed stays in the seed's own open component, and growback
//     re-enters only cells open on the original mask), so:
//       – the room-size cap is arithmetically redundant: the superset already
//         passed it;
//       – the ≥75%-real-boundary cap is satisfied IN KIND, not by luck: every
//         synthetic run on this path bridges a gap the rule itself just judged
//         narrower than MIN_PASS_FT, so no virtual run is even door-width. The
//         cap is a proxy for run LENGTH; here run length is bounded a priori.
//     A high fraction therefore means "many sub-half-foot slots" — a dashed or
//     picket wall — and refusing it does not buy safety, it hands back the
//     LEAKIER superset. Measured: a 0.433 ft slotted wall inside a suite went
//     64.4 SF → 126.6 SF (+96%) and confidence 0.99 → 1.00, because the raw
//     flood fell out of the bottom of the gate carrying no provenance at all.
//     So on the trimming path the gates do not run. (test/minPassGate.test.ts)
//   • it does not (minPassDelta === 1) — the rule is CREATING boundedness: not
//     trimming a hairline connection but BRIDGING an opening, which is the seal
//     ladder's job under another name. Both gates run, exactly as they do for a
//     ladder rung, and an accepted region reports gap_sealed_px + the ladder's
//     own virtual-boundary fraction beside min_pass_px.
//
// Because the gates now run only when the verbatim flood is unbounded, the
// fall-through below can no longer return a bounded raw flood that a gate
// refused: `base` is bounded only when the min-passage flood produced no
// bounded region at all, and then there is nothing to report.
function sealAttempt(mo: MaskObj, ix: number, iy: number, sensitivity: number, radii: number[], minPassPx = 0, given?: SealScratch): FloodResult {
  // `given` is the caller's own scratch — the per-arc-cluster retries run
  // against a REUSED mask buffer, which the sealCache (keyed on mask identity)
  // must never see: it would hand back the previous cluster's distance field.
  const scratch = (): SealScratch => {
    if (given) return given;
    let s = sealCache.get(mo.mask);
    if (!s) { s = { dt: hardDT(mo.mask, mo.mw, mo.mh) }; sealCache.set(mo.mask, s); }
    return s;
  };
  let raw: FloodResult | null = null;
  const rawFlood = (): FloodResult => (raw ??= floodRegionLadder(mo, ix, iy, sensitivity));
  // Bridge-futility evidence for floodRegionSealedInner (see leakedDilationPx
  // on the FloodResult type): the largest Manhattan radius whose dilated flood
  // leaked FROM THE CLICK CELL ITSELF. Two conditions make the seed provably
  // identical to the bridge's seed, so "leaked with MORE walls" transfers:
  //   • dt > r — the click sits clear of the dilated walls, so ascendSeed
  //     returned it unmoved and it is not a hard barrier;
  //   • the click cell is NOT SOFT — the strict pass's barrier is walls+hatch,
  //     and a soft seed makes floodPass NUDGE to the nearest open cell of
  //     whichever mask it is flooding. The nudge is per-mask, so the evidence
  //     flood's seed and the bridged flood's seed could land on opposite sides
  //     of the very hatch line the click sits on — different components, and
  //     the futility transfer would be unsound. Non-soft, neither flood ever
  //     nudges (Chebyshev(click) ≥ ⌊dt/2⌋+1 > br keeps it open in the bridged
  //     mask too) and the bridged pass-1 leak is forced by wall-set inclusion.
  let leakedR = 0;
  const cx = Math.max(0, Math.min(mo.mw - 1, Math.round(ix * mo.ws)));
  const cy = Math.max(0, Math.min(mo.mh - 1, Math.round(iy * mo.ws)));
  const cSoft = (mo.mask[cy * mo.mw + cx] & 2) !== 0;
  const cdt = (s: SealScratch): number => (cSoft ? 0 : s.dt[cy * mo.mw + cx]);
  if (minPassPx > 0) {
    const s = scratch();
    const dm = dilatedView(mo, minPassPx, s.dt);
    const [ax, ay] = ascendSeed(s.dt, mo.mw, mo.mh, mo.ws, ix, iy, minPassPx);
    const f = floodRegionLadder(dm, ax, ay, sensitivity);
    if (f.status === "leak" && minPassPx > leakedR && cdt(s) > minPassPx) leakedR = minPassPx;
    if (f.status === "ok") {
      growRegionBack(f, mo, minPassPx, f.hatchFiltered ? 1 : 3, s.dt);
      // TRIMMING or CREATING? (see the F1/F2 note above — this one fact decides
      // whether the ladder's gates are asking a question about this region)
      const r0 = rawFlood();
      if (r0.status === "ok" && r0.count > 0) {
        const d = +(1 - f.count / r0.count).toFixed(4);
        if (d > 0) { f.minPassPx = minPassPx; f.minPassDelta = d; }
        return f;                       // a subset of a region that already passed both gates
      }
      // creating: the ladder's own two gates, on the ladder's own terms
      const vf = f.count > f.mw * f.mh * SEAL_MAX_SHEET_FRAC ? 1 : virtualBoundaryFrac(f, s.dt);
      if (vf <= SEAL_VIRTUAL_MAX) {
        f.minPassPx = minPassPx;
        f.minPassDelta = 1;
        // the verbatim linework bounds NOTHING here, so report the bridge as
        // one: gap_sealed_px + the ladder's own virtual-boundary fraction, with
        // min_pass_px beside them to say which radius did it and why.
        f.sealedPx = minPassPx;
        f.virtualFrac = +vf.toFixed(3);
        return f;
      }
    }
  }
  const base = rawFlood();
  if (base.status === "ok") return base;
  const sc = scratch();
  for (const r of radii) {
    // Skipped because a SMALLER dilation bridges strictly less: reaching here
    // means the verbatim flood is unbounded, so every escape route the rung
    // would have to close is one the min-passage radius already closed (or
    // failed to). The one case this forgoes is a rung landing between the
    // widest escape's half-width and minPassPx after a gate refusal — measured
    // across every scene in test/minPassGate.test.ts and a 47.7k-click sweep of
    // both corpus sheets, no such rung ever bounded anything (the ladder is
    // geometric — 1, 2, 4, 8 — so it rarely has a rung to spare down there).
    if (r <= minPassPx) continue;
    const dm = dilatedView(mo, r, sc.dt);
    const [ax, ay] = ascendSeed(sc.dt, mo.mw, mo.mh, mo.ws, ix, iy, r);
    const f = floodRegionLadder(dm, ax, ay, sensitivity);
    if (f.status !== "ok") {
      if (f.status === "leak" && r > leakedR && cdt(sc) > r) leakedR = r;
      continue;
    }
    growRegionBack(f, mo, r, f.hatchFiltered ? 1 : 3, sc.dt);
    // Two sanity gates keep sealing honest — without them, dilating hard enough
    // eventually STARVES any big open space (a lobby, the sheet itself) under
    // the leak cap and reports a giant "sealed" blob:
    //   • the grown region must still satisfy the room-size cap the plain
    //     flood enforces (a room is never 30% of the sheet);
    //   • the seal must be LOCAL — most of the region's boundary must hug real
    //     linework (within VIRTUAL_HUG_PX), with only door-width virtual runs. A
    //     starved blob ends at descent watersheds in open space and fails this
    //     immediately.
    if (f.count > f.mw * f.mh * SEAL_MAX_SHEET_FRAC) continue;
    const vf = virtualBoundaryFrac(f, sc.dt);
    if (vf > SEAL_VIRTUAL_MAX) continue;
    f.sealedPx = r;
    f.virtualFrac = +vf.toFixed(3);   // confidence signal: how much boundary is synthetic
    return f;
  }
  if (base.status === "leak" && leakedR > 0) base.leakedDilationPx = leakedR;
  return base;
}

/** floodRegion, plus leak recovery (see sealAttempt), plus door-swing
 *  inclusion: when `wedgeCapPx` > 0 and the result is bounded by drawn door
 *  linework, each boundary arc cluster gets its own curve-transparent retry
 *  re-measuring to the wall opening; a retry is kept only when its growth
 *  stays inside the arc's own bounding-box allowance. Accepted wedges union. */
export function floodRegionSealed(mo: MaskObj, ix: number, iy: number, sensitivity: number = SENS_BALANCED, radii: number[] = SEAL_RADII, wedgeCapPx = 0, minPassPx = 0): FloodResult {
  const out = floodRegionSealedInner(mo, ix, iy, sensitivity, radii, wedgeCapPx, minPassPx);
  if (out.status === "ok") {
    const cf = curveBoundaryFrac(out, mo);
    if (cf > 0) out.curveFrac = +cf.toFixed(3);
  }
  return out;
}

function floodRegionSealedInner(mo: MaskObj, ix: number, iy: number, sensitivity: number, radii: number[], wedgeCapPx: number, minPassPx: number): FloodResult {
  const r1 = sealAttempt(mo, ix, iy, sensitivity, radii, minPassPx);
  if (r1.status === "leak") {
    // Gap bridging, the ladder's LAST leak-recovery rung (see floodRegion).
    // Ordering is deliberate: the seal rungs above already close pinholes with
    // growback and the virtual-boundary gates, so anything they recover keeps
    // the strictly better boundary and its sealedPx provenance — bridging only
    // sees the leaks the whole ladder refused (e.g. a diagonal pinhole the
    // diamond dilation can't quite pinch). Box-dilated, no growback, no gates
    // — its guard is the radius cap, and the rescue rides `gapBridged` rather
    // than passing itself off as a clean fill. No wedge retries on a bridged
    // base: the region sits ≤ 2 px inside the true walls, so boundary-arc
    // adjacency is meaningless there.
    //
    // FUTILITY SKIP (hover-cost regression, audit A8's budget): the bridge is
    // a box (Chebyshev) dilation, and a Chebyshev ball of radius br sits
    // inside the Manhattan ball of radius 2·br — the exact shape the seal
    // ladder's rungs already dilated by. So when a rung at Manhattan radius
    // ≥ 2·br LEAKED, seeded at the very click cell (leakedDilationPx — seed
    // provably unmoved), the bridged mask has a SUBSET of that rung's walls
    // and the same seed: its flood reaches a superset of a leaking fill and
    // can only leak again. Skipping it returns the identical verdict without
    // paying dilateHard (two full-raster copies) plus a leak-capped fill per
    // rung — the cost that made every hover over open paper ~20× a frame.
    // A hover with no enclosure at all leaks every rung, so it always carries
    // the evidence and the bridge costs nothing; a genuine pinhole seals a
    // rung instead (no leak evidence), so rescue-worthy leaks still bridge.
    const futileBelowPx = (r1.leakedDilationPx ?? 0) >> 1;
    for (let br = 1; br <= GAP_BRIDGE_MAX; br++) {
      if (br <= futileBelowPx) continue;
      const rb = floodRegionLadder(bridgedMask(mo, br), ix, iy, sensitivity);
      if (rb.status === "ok") { rb.gapBridged = br; return rb; }
    }
  }
  if (!wedgeCapPx || r1.status !== "ok") return r1;
  const clusters = boundaryCurveClusters(mo, r1.region);
  if (!clusters.length) return r1;
  // the global ceiling across all accepted wedges keeps the old semantics:
  // a giant region's fractional allowance is still never more than
  // WEDGE_MAX_DOORS' worth of 5-ft doors
  const globalAllowance = Math.max(wedgeCapPx, Math.min(Math.round(r1.count * WEDGE_GROWTH_FRAC), WEDGE_MAX_DOORS * wedgeCapPx));
  const { mw, mh } = mo;
  let region: Uint8Array | null = null;
  let count = r1.count;
  let wedges = 0, ringWedges = 0;
  let hatchFiltered = !!r1.hatchFiltered;
  let hatchTier = r1.hatchTier;
  let sealedPx = r1.sealedPx, virtualFrac = r1.virtualFrac;
  let minPassPxOut = r1.minPassPx, minPassDelta = r1.minPassDelta;
  // Judge every cluster as GEOMETRY first (re-fitted circle: radius, sweep,
  // chord-frame extent), then spend the finite wedge budget on the most
  // door-like ones. Ranking, not scanline order: a room ringed with curved
  // millwork used to exhaust the budget before its real doors were reached.
  // Ties break on first-cell index, so the order stays deterministic.
  const ranked = clusters
    .map((cl) => {
      const fit = arcClusterFit(cl, mw, mo.mask);
      return { cl, fit, allow: wedgeAllowance(fit, mo.mppf || 0, wedgeCapPx), rank: doorLikeness(fit, mo.mppf || 0), at: cl[0] };
    })
    .filter((c) => c.allow >= 1)
    .sort((a, b) => (b.rank - a.rank) || (a.at - b.at));
  // ONE mask buffer and ONE distance field for the whole ladder of clusters
  // (A8): each cluster used to slice a fresh copy of the mask and run a fresh
  // hardDT over it, so a six-door room allocated and refilled twelve
  // full-raster arrays before it drew anything. The buffers are private to
  // this call, so the sealCache — keyed on mask IDENTITY — must be bypassed
  // for them; sealAttempt takes the scratch explicitly instead.
  let m2mask: Uint8Array | null = null, m2dt: Uint8Array | null = null;
  let openedCl: number[] | null = null, dirty: RegionBox | null = null;
  const rb1 = boxOf(r1.region, mw, mh);
  // the sheet's own distance field — computed once per MASK (this is the
  // WeakMap the per-cluster copies used to defeat) and never recomputed here
  let base = sealCache.get(mo.mask);
  if (!base) { base = { dt: hardDT(mo.mask, mw, mh) }; sealCache.set(mo.mask, base); }
  const baseDT = base.dt;
  for (const { cl, fit, allow: clusterAllowance } of ranked.slice(0, WEDGE_MAX_DOORS)) {
    // open ONLY this cluster's cells, and undo the previous cluster's — mask
    // and distance field alike — so both buffers hold exactly "the sheet with
    // this one arc opened" without either being rebuilt from scratch
    if (!m2mask) { m2mask = mo.mask.slice(); m2dt = baseDT.slice(); }
    else {
      if (openedCl) for (const i of openedCl) m2mask[i] = mo.mask[i];
      if (dirty) for (let y = dirty.y0; y <= dirty.y1; y++) { const r = y * mw; (m2dt as Uint8Array).set(baseDT.subarray(r + dirty.x0, r + dirty.x1 + 1), r + dirty.x0); }
      else (m2dt as Uint8Array).set(baseDT);
    }
    for (const i of cl) m2mask[i] = m2mask[i] & ~1;
    openedCl = cl;
    const m2: MaskObj = { mask: m2mask, mw, mh, ws: mo.ws, softCount: mo.softCount, mppf: mo.mppf };
    dirty = dtDirtyWindow(cl, mw, mh, baseDT);
    if (dirty) hardDTWindow(m2mask, mw, mh, m2dt as Uint8Array, dirty);
    else hardDT(m2mask, mw, mh, m2dt as Uint8Array);
    const sc2: SealScratch = { dt: m2dt as Uint8Array };
    // retry from the ROOM'S most interior cell, not the click — the retry's
    // sealed floods dilate the walls, and a click near a wall (or a hover
    // sweeping in from a neighbor) would start inside the dilated barrier.
    // Any cell of r1's region floods the same space, so pick the deepest
    // one; this also makes the retry deterministic per room per door.
    let bi = -1, bd = -1;
    for (let y = rb1.y0; y <= rb1.y1; y++) {          // r1's own box: every region cell is in it
      const row = y * mw;
      for (let x = rb1.x0; x <= rb1.x1; x++) { const i = row + x; if (r1.region[i] && sc2.dt[i] > bd) { bd = sc2.dt[i]; bi = i; } }
    }
    const sx = bi < 0 ? ix : (bi % mw) / mo.ws, sy = bi < 0 ? iy : Math.floor(bi / mw) / mo.ws;
    const r2 = sealAttempt(m2, sx, sy, sensitivity, radii, minPassPx, sc2);
    if (r2.status !== "ok" || r2.count <= r1.count) continue;
    const growth = r2.count - r1.count;
    if (growth > clusterAllowance) continue;           // curved wall / open paper, not a door
    if (count - r1.count + growth > globalAllowance) continue;
    if (!region) { region = r1.region.slice(); regionBox.set(region, { ...rb1 }); }
    const rb = regionBox.get(region) as RegionBox, b2 = boxOf(r2.region, mw, mh);
    for (let y = b2.y0; y <= b2.y1; y++) {            // r2's box: every cell it could add is in it
      const row = y * mw;
      for (let x = b2.x0; x <= b2.x1; x++) {
        const i = row + x;
        if (r2.region[i] && !region[i]) {
          region[i] = 1; count++;
          if (x < rb.x0) rb.x0 = x; if (x > rb.x1) rb.x1 = x; if (y < rb.y0) rb.y0 = y; if (y > rb.y1) rb.y1 = y;
        }
      }
    }
    wedges++;
    // AUDIT F7(g) — WHAT KIND of wedge this was. `flagNonDoorArcs` marks closed
    // circles and cloud scallops as non-doors; `wedgeAllowance` refuses them
    // UNLESS the cluster also fits one clean circle, because then its own
    // interior bounds the growth and the corpus's real plan counts the floor
    // inside a drawn ring as floor (annotation-ring-room). So flagged AND
    // clean-circle is exactly the round-column / callout-bubble case: a full
    // sweep about a fitted centre, interior annexed, `wedges` incremented.
    // The MEASUREMENT is deliberately unchanged (it is corpus-pinned — see
    // test/doorArcs.test.ts "F7(g)"), but calling it a door swing was false, and
    // three surfaces said so. Counting it separately is what lets them stop.
    // NOT a policy decision: whether a round column is floor or a deduct belongs
    // to the operator, and this records which happened rather than choosing.
    if (fit.noDoorFrac > 0.5 && fit.good) ringWedges++;
    if (r2.hatchFiltered) hatchFiltered = true;
    if (r2.hatchTier && HATCH_TIER_RISK[r2.hatchTier] > (hatchTier ? HATCH_TIER_RISK[hatchTier] : -1)) hatchTier = r2.hatchTier;
    if (r2.sealedPx && (!sealedPx || r2.sealedPx > sealedPx)) sealedPx = r2.sealedPx;
    if (r2.virtualFrac != null && (virtualFrac == null || r2.virtualFrac > virtualFrac)) virtualFrac = r2.virtualFrac;
    if (r2.minPassPx && (!minPassPxOut || r2.minPassPx > minPassPxOut)) minPassPxOut = r2.minPassPx;
    if (r2.minPassDelta != null && (minPassDelta == null || r2.minPassDelta > minPassDelta)) minPassDelta = r2.minPassDelta;
  }
  if (!wedges || !region) return r1;
  const out: FloodResult & { status: "ok" } = {
    status: "ok", region, count, mw, mh, ws: r1.ws, mppf: r1.mppf,
    hardHits: r1.hardHits, softHits: r1.softHits,
    hatchFiltered: hatchFiltered || undefined, hatchTier, sealedPx, virtualFrac,
    minPassPx: minPassPxOut, minPassDelta,
    ...(ringWedges ? { ringWedges } : {}),
  };
  // Absorb the door LEAF: the straight leaf line stays a barrier through the
  // retry, leaving a 1–2 px slit between the room and the annexed wedge. The
  // outer contour would dive up that slit and back, inflating perimeter_lf by
  // ~2 leaf lengths per door — a baseboard over-count. The leaf is exactly
  // the barrier pinched between r1's region and the annexed delta, so absorb
  // only that: real wall stubs (pinched between r1 and r1) keep their slit —
  // baseboard genuinely runs around those.
  const reg = region, reg1 = r1.region, mask = mo.mask;
  const isDelta = (i: number) => reg[i] && !reg1[i];
  // An absorbed cell is pinched BETWEEN two region cells, so it lies strictly
  // inside the region's own box — and absorbing it cannot widen that box.
  const rbA = boxOf(reg, mw, mh);
  const ay0 = Math.max(1, rbA.y0), ay1 = Math.min(mh - 2, rbA.y1);
  const ax0 = Math.max(1, rbA.x0), ax1 = Math.min(mw - 2, rbA.x1);
  for (let pass = 0; pass < 2; pass++) {               // Bresenham lines raster up to 2 px thick
    for (let y = ay0; y <= ay1; y++) {
      const row = y * mw;
      for (let x = ax0; x <= ax1; x++) {
        const i = row + x;
        if (reg[i] || !(mask[i] & 1)) continue;
        const pinchH = reg[i - 1] && reg[i + 1], pinchV = reg[i - mw] && reg[i + mw];
        if ((pinchH && (isDelta(i - 1) || isDelta(i + 1))) || (pinchV && (isDelta(i - mw) || isDelta(i + mw)))) { reg[i] = 1; out.count++; }
      }
    }
  }
  out.wedges = wedges;
  out.wedgeGrowth = +(out.count / r1.count).toFixed(3); // confidence signal: how much the door retries grew
  return out;
}

// Fraction of a region's boundary cells that do NOT hug original linework:
// 0 for a fully wall-bounded room, ≈ door/perimeter for a legit seal, large for
// a dilation-starved blob whose edges sit in open space.
//
// VIRTUAL_HUG_PX is in RASTER cells, and audit F2 tried the obvious-looking
// alternative — a feet-true margin, `dt > round(2in x mppf)`, since every other
// constant in this module converts through CAL_MPPF — and MEASURED it wrong:
//   • it made the metric blind at exactly the scale this gate adjudicates. A
//     2 in/side margin erases every bridged gap under 4 in, and the min-passage
//     rule's entire business is gaps under MIN_PASS_FT = 6 in. On the A3/D-1
//     fixture (a picket rectangle, 3 in gaps at 72 px/ft) it reported a boundary
//     that is 82% invented as 0.000 synthetic, and the guard that had refused a
//     "room" drawn as a dotted line handed it back at confidence 0.85.
//   • the same swap with `dt > minPassPx` is worse still: no boundary cell can
//     be further than the radius from linework after growback, so the fraction
//     is identically 0 on this path — vacating the gate AND the confidence
//     deduction that reads the same number.
// The margin has to stay small next to the DILATION radius it judges, and 3
// cells is what makes it so on a working raster.
//
// KNOWN UNDER-COUNT: this is the share of boundary CELLS further than
// VIRTUAL_HUG_PX from linework, not the share of boundary LENGTH the dilation
// invented — the cells within the margin of each jamb count as real, so a
// 0.43 ft slot the rule closed reports ~4 cells of 10. Read it as a floor on
// how synthetic a boundary is. The honest measure keys on whether a boundary
// cell's barrier neighbour is DRAWN or DILATED, which recalibrates
// SEAL_VIRTUAL_MAX and every virtualFrac the corpus reads; not done here.
function virtualBoundaryFrac(f: { region: Uint8Array; mw: number; mh: number }, dt: Uint8Array): number {
  const { region, mw, mh } = f;
  const b = boxOf(region, mw, mh);        // boundary cells are region cells
  let boundary = 0, virtual = 0;
  for (let y = b.y0; y <= b.y1; y++) {
    const row = y * mw;
    for (let x = b.x0; x <= b.x1; x++) {
      const i = row + x;
      if (!region[i]) continue;
      if ((x > 0 && !region[i - 1]) || (x < mw - 1 && !region[i + 1]) || (y > 0 && !region[i - mw]) || (y < mh - 1 && !region[i + mw])) {
        boundary++;
        if (dt[i] > VIRTUAL_HUG_PX) virtual++;
      }
    }
  }
  return boundary ? virtual / boundary : 1;
}

// Fraction of a region's boundary cells that abut CURVE linework (bit 4) —
// an arc the door-wedge retry never opened (a curved wall, a revision cloud,
// a door whose cluster was refused). AUDIT A2: this is the one place a trace
// can be less than verbatim without any inference having run. buildMask
// tessellates every bezier into CURVE_STEPS chords and traceRegion returns an
// RDP-simplified staircase through them, so the reported area of a
// curve-bounded space is a polygonal approximation of geometry the drawing
// states exactly — and it measurably costs accuracy (corpus: curved-partition
// 3.2% SF error against 2.0% for the same-scale straight-walled rooms). An
// arc ABSORBED as a door swing is not counted: those cells stop being
// boundary, which is the honest reading — the wedge deduction already covers
// them.
function curveBoundaryFrac(f: { region: Uint8Array; mw: number; mh: number }, mo: MaskObj): number {
  const { region, mw, mh } = f;
  const mask = mo.mask;
  const b = boxOf(region, mw, mh);        // boundary cells are region cells
  let boundary = 0, curved = 0;
  for (let y = b.y0; y <= b.y1; y++) {
    const row = y * mw;
    for (let x = b.x0; x <= b.x1; x++) {
      const i = row + x;
      if (!region[i]) continue;
      const w = x > 0 ? i - 1 : -1, e = x < mw - 1 ? i + 1 : -1, n = y > 0 ? i - mw : -1, s = y < mh - 1 ? i + mw : -1;
      if (!((w >= 0 && !region[w]) || (e >= 0 && !region[e]) || (n >= 0 && !region[n]) || (s >= 0 && !region[s]))) continue;
      boundary++;
      for (const j of [w, e, n, s]) if (j >= 0 && !region[j] && (mask[j] & MASK_CURVE_BIT)) { curved++; break; }
    }
  }
  return boundary ? curved / boundary : 0;
}

// ── 5. contour trace + simplify ────────────────────────────────────────────
// Moore-neighbor trace of the region's OUTER boundary, then closed-ring RDP.
// Returns image-px vertices.
export function traceRegion(reg: RegionResult, epsMaskPx = 1.5): Point[] {
  const { region, mw, mh, ws } = reg;
  let s = -1;
  // first set cell in scanline order — the region's own box holds all of them,
  // so restricting the search finds the same one (A8: this scan alone was a
  // full 9 MB sweep on every hovered room)
  const b = boxOf(region, mw, mh);
  for (let y = b.y0; y <= b.y1 && s < 0; y++) {
    const row = y * mw;
    for (let x = b.x0; x <= b.x1; x++) if (region[row + x]) { s = row + x; break; }
  }
  if (s < 0) return [];
  const sx = s % mw, sy = (s / mw) | 0;
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < mw && y < mh && !!region[y * mw + x];
  // Moore neighborhood, clockwise from W
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const pts: Point[] = [];
  let cx = sx, cy = sy, dir = 6;          // entered heading south (came from the open row above)
  const maxSteps = mw * mh * 4;
  for (let step = 0; step < maxSteps; step++) {
    pts.push([cx, cy]);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;        // start search 90° counter-clockwise of arrival
      const nx = cx + N[d][0], ny = cy + N[d][1];
      if (at(nx, ny)) { cx = nx; cy = ny; dir = d; found = true; break; }
    }
    if (!found) break;                     // isolated pixel
    if (cx === sx && cy === sy && pts.length > 2) break;
  }
  const ring = rdpClosed(pts, epsMaskPx);
  return ring.map(([x, y]) => [x / ws, y / ws] as Point);
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L;
}
function rdpOpen(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  let imax = 0, dmax = -1;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) { const d = perpDist(pts[i], a, b); if (d > dmax) { dmax = d; imax = i; } }
  if (dmax <= eps) return [a, b];
  const left = rdpOpen(pts.slice(0, imax + 1), eps);
  const right = rdpOpen(pts.slice(imax), eps);
  return left.slice(0, -1).concat(right);
}
// Closed ring: anchor at the two mutually-farthest-ish points (first vertex and
// the vertex farthest from it), simplify each half, rejoin.
export function rdpClosed(pts: Point[], eps: number): Point[] {
  if (pts.length < 4) return pts.slice();
  let split = 0, dmax = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > dmax) { dmax = d; split = i; }
  }
  const h1 = rdpOpen(pts.slice(0, split + 1), eps);
  const h2 = rdpOpen(pts.slice(split).concat([pts[0]]), eps);
  const ring = h1.slice(0, -1).concat(h2.slice(0, -1));
  return ring.length >= 3 ? ring : pts.slice();
}

// ── 6. vertex snap + cleanup ───────────────────────────────────────────────
// Pull traced corners onto true PDF endpoints (the ruling: "vertices snapped").
// Collapses any post-snap duplicates; refuses a snap set that would degenerate
// the ring.
export function snapVertices(poly: Point[], nearest: NearestFn, tolPx = 6, minGapPx = 2): Point[] {
  const snapped: Point[] = poly.map(([x, y]) => {
    const hit = nearest(x, y, tolPx);
    return hit ? [hit[0], hit[1]] as Point : [x, y] as Point;
  });
  const out: Point[] = [];
  for (const p of snapped) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > minGapPx) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= minGapPx) out.pop();
  return out.length >= 3 ? out : poly;
}

// ── 6b. THE PRODUCTION RING ────────────────────────────────────────────────
// `traceRegion` is NOT what the product returns. Every vector One-Click ring in
// the product is trace-THEN-SNAP, and `area_sf` is computed from the SNAPPED
// ring.
//
// Audit A5b measured the cost of composing that by hand: `bench/run.mts` and
// `bench/pin-goldens.mts` called bare `traceRegion` and never imported
// `snapVertices` at all, so EVERY engine-pinned golden pinned a number the
// product never displays — the bench read 117.568 SF on a room the product
// (and e2e/one-click.e2e.cjs, through real Chromium) measures at exactly
// 120.000. The long-standing "1,751.9 vs 1,744.7" sample-plan discrepancy was
// this, not sloppiness: 1,751.9 is the snapped production reading.
//
// So the composition lives HERE, once. AUDIT F7(b): for one release it lived
// here and NOTHING production called it — the five sites still composed the two
// calls by hand, the only callers were the bench and a source-scan test that
// asserted the hand-composed COUNT, and this comment nonetheless claimed "every
// surface … calls this". The five are now converted, so the sentence is earned:
// the callers are TakeoffCanvas.jsx (propose / live-preview / agent tool),
// mcp/src/session.ts (one_click / detect_rooms), bench/run.mts and
// bench/pin-goldens.mts — seven call sites, no hand-composed ones left, and
// web/test/benchProductionRing.test.ts scans the two production files to keep it
// that way. Same reasoning as confidence.ts's `floodSignals`: a hand-listed call
// site is a call site that goes stale.
/** Snap-grid bucket size, image px. Mirrors canvasConstants.SNAP_CELL. */
export const SNAP_CELL_PX = 24;
/** Vertex-snap tolerance, image px — how far a traced corner may be pulled onto
 *  a true PDF vertex. Mirrors the canvas's literal 7 and mcp's SNAP_TOL. */
export const SNAP_TOL_PX = 7;

/** Build the production snap lookup from `extractVectorGeometry(...).points`.
 *  Callers that already hold a grid (the canvas caches one per sheet) can keep
 *  passing their own `NearestFn` instead. */
export function snapNearest(points: Point[], cell = SNAP_CELL_PX): NearestFn {
  const grid = buildSnapGrid(points, cell);
  return (x, y, d) => nearestSnap(grid, x, y, d);
}

/** Options for `oneClickRing`. The raster branch is a DIFFERENT measurement —
 *  a looser RDP eps and NO snapping, because a scan has no true endpoints and
 *  pulling room corners onto the title block's vector corners would corrupt
 *  the ring — so the type makes it impossible to ask for a raster ring without
 *  supplying the raster eps, or to hand a snap grid to the raster path. */
export type OneClickRingOpts =
  | { raster?: false; nearest?: NearestFn | null }
  | { raster: true; rasterEps: number };

/** THE ring the product returns for a completed flood. Vector path: trace, then
 *  snap corners onto true PDF vertices at SNAP_TOL_PX. Raster path: trace at the
 *  scan eps, unsnapped. */
export function oneClickRing(f: Extract<FloodResult, { status: "ok" }>, opts: OneClickRingOpts = {}): Point[] {
  if (opts.raster) return traceRegion(f, opts.rasterEps);
  const nearest = opts.nearest;
  return snapVertices(traceRegion(f), (x, y, d) => (nearest ? nearest(x, y, d) : null), SNAP_TOL_PX);
}

// Shoelace in whatever px the ring is in (caller multiplies by upp²).
export function ringArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
