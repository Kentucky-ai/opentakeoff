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
/*  lum (#260, reported by @FrankAtGHub): per-segment STROKE LUMINANCE, 0–255,
 *  Rec. 709 over the graphics-state stroke color at the time the path was
 *  built. The fallback rung of the "recover what the file already states"
 *  ladder (#85): layers where they survive, pen weight (meta's high nibble)
 *  where they don't, luminance where neither made the trip. On a flattened
 *  export — 0 OCGs, every segment at one pen — a black fixture outline over a
 *  grey ceiling grid is still stated in the file, and until now the pipeline
 *  dropped it before anything downstream could see it. One byte per segment,
 *  the same shape as `meta`. Optional so hand-built geometry (rastermask,
 *  tests) needs no ceremony; extraction always emits it. */
/*  subpaths (#320 follow-on, the ink-classification foundation): the drawn
 *  FIGURE each segment belongs to. A `constructPath` op carries one or more
 *  subpaths — each `moveTo` starts one, each `rectangle` is one — and every
 *  segment a subpath contributes is appended to `segs` consecutively, so a
 *  subpath is exactly a contiguous index RANGE. That is what makes this cheap
 *  (two numbers per figure, no per-segment table) and what makes path-level
 *  facts available at all: whether ink is a closed figure, how big the figure
 *  is, how many segments it took. Rasterizing to a 1-bit mask destroys all of
 *  it, and every classifier that came before had to infer it back from
 *  neighbourhood geometry. Optional, like lum/layerOf: hand-built geometry
 *  (rastermask, tests) needs no ceremony; extraction always emits it. */
export interface SubPath {
  /** segment index range [i0, i1) into segs/meta. */
  i0: number; i1: number;
  /** tight bbox over the subpath's segment endpoints, image px. */
  x0: number; y0: number; x1: number; y1: number;
  /** the figure returns to its own start (a fleck, a poché outline, a box). */
  closed: boolean;
  /** SEG_CLIP / SEG_FILLONLY / 0 (stroked), and the pen nibble — the paint
   *  facts, read once per figure instead of per segment. */
  flags: number;
  /** Rec.709 luminance of the FILL colour in force when the figure was built,
   *  0 (black) to 255 (white). Meaningful on a filled figure: dark is solid
   *  material — poché — and pale is a finish wash. */
  fillLum: number;
}
/** A positioned text item, image px: (x, y) is the baseline START, w/h the
 *  rendered extent. The text layer is evidence about the DRAWING that the
 *  linework alone cannot supply — what a box is for. */
export interface TextMark { x: number; y: number; w: number; h: number }
/** The sheet context ink classification reads. Every field optional: a caller
 *  that supplies none gets exactly the pre-classification mask, which is what
 *  keeps hand-built geometry (rastermask, tests) and stitched composites
 *  working unchanged. */
export interface InkContext { subpaths?: SubPath[] | null; texts?: TextMark[] | null; dimTexts?: DimTextMark[] | null }
export interface VectorGeometry { points: Point[]; segs: number[]; meta: Uint8Array; imageArea: number; lum?: Uint8Array; layerOf?: Int32Array; layerIds?: string[]; subpaths?: SubPath[]; }
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
  | { status: "ok"; region: Uint8Array; count: number; mw: number; mh: number; ws: number; mppf?: number; hardHits?: number; softHits?: number; hatchFiltered?: boolean; hatchTier?: HatchTier; sealedPx?: number; virtualFrac?: number; wedges?: number; ringWedges?: number; wedgesRefused?: number; leafStubsRefused?: number; wedgeGrowth?: number; curveFrac?: number; minPassPx?: number; minPassDelta?: number; gapBridged?: number };
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
/** Radius ceiling for a swing whose own LEAF the engine found (doorLeafCells):
 *  straight, non-curve ink running along a radius at one end of a clean
 *  circular sweep. A curved WALL — the thing DOOR_R_MAX_FT exists to refuse —
 *  has no leaf: its fitted centre is tens of feet away, in another room, with
 *  no radial stroke covering LEAF_MIN_COVER of the way out to it. So a found
 *  leaf is positive evidence of a door, and the bare-radius ceiling may widen
 *  to the widest leaf anyone actually draws as ONE swing (a 6'-0" equipment or
 *  OR door), with margin for the fit's own bias.
 *
 *  WHY THIS EXISTS (#257). At DOOR_R_MAX_FT the refusal is a CLIFF, and it sits
 *  where real doors are: measured on a synthetic room at 18 mask px/ft, a
 *  nominal 4'-6" leaf fits at r = 4.56 ft — over the ceiling by raster bias
 *  alone, since the arc rasters 1–2 px thick and the least-squares circle rides
 *  its outer edge. wedgeAllowance returned 0, the opening was filtered out of
 *  the ranking entirely, and the room came back 18.0 SF short on a 15.9 SF
 *  sector — the whole wedge, silently. A 4'-0" leaf fit at 4.02 and survived
 *  with 12% to spare, which is the margin the entire in-swing path was resting
 *  on. Widening only where a leaf corroborates leaves pass 0/1 (arc openings)
 *  bit-identical, so the curved-wall protection this ceiling was written for is
 *  untouched. */
export const DOOR_R_LEAF_MAX_FT = 7;
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
/** Rec. 709 luminance of a pdf.js stroke-color arg list, 0–255 (#260). Accepts
 *  the components either as three args or as one array — pdf.js has emitted
 *  both shapes across versions — and anything else leaves the state alone by
 *  returning null. Rec. 709 rather than a plain mean because the case this
 *  exists for is black-vs-grey linework, where every weighting agrees, and
 *  because a green annotation layer should not read as light as a yellow one. */
export function strokeLuminance(args: unknown[]): number | null {
  // pdf.js has emitted the components as three args, one plain array, and one
  // typed array across versions — read all three shapes, refuse the rest.
  const first = args?.[0];
  const a = Array.isArray(first) || (ArrayBuffer.isView(first) && !(first instanceof DataView))
    ? (first as ArrayLike<unknown>)
    : args;
  if (!a || a.length < 3) return null;
  const [r, g, b] = [a[0], a[1], a[2]].map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  // pdf.js emits 0–255 components; a 0–1 file that reached here unscaled would
  // otherwise read as black. All three at or under 1 is the only ambiguous
  // case, and there it is the darkest corner of the 0–255 cube either way.
  const k = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) * k;
  return Math.max(0, Math.min(255, Math.round(L)));
}

export function extractVectorGeometry(opList: OpList, transform: number[], OPS: OpsTable): VectorGeometry {
  const points: Point[] = [];
  const segs: number[] = [];
  const metaArr: number[] = [];
  const lumArr: number[] = [];
  const subpaths: SubPath[] = [];
  // the subpath under construction: opened by moveTo/rectangle, sealed when
  // the next one opens or the op stream ends. A figure that contributed no
  // segment (a lone moveTo, a degenerate rect) is dropped rather than
  // recorded as an empty range.
  let sp: SubPath | null = null;
  const sealSub = () => {
    if (sp && sp.i1 > sp.i0) subpaths.push(sp);
    sp = null;
  };
  let pathFill = 0;                 // the fill colour of the path being built
  const openSub = (flags: number, at: Point) => {
    sealSub();
    const k = metaArr.length;
    sp = { i0: k, i1: k, x0: at[0], y0: at[1], x1: at[0], y1: at[1], closed: false, flags, fillLum: pathFill };
  };
  // every segment push goes through this, so a subpath's range and bbox can
  // never drift from what actually landed in segs
  const closeSub = () => { if (sp) sp.closed = true; };
  const noteSeg = (a: Point, b: Point) => {
    if (!sp) return;
    sp.i1 = metaArr.length;
    if (a[0] < sp.x0) sp.x0 = a[0]; if (a[0] > sp.x1) sp.x1 = a[0];
    if (a[1] < sp.y0) sp.y0 = a[1]; if (a[1] > sp.y1) sp.y1 = a[1];
    if (b[0] < sp.x0) sp.x0 = b[0]; if (b[0] > sp.x1) sp.x1 = b[0];
    if (b[1] < sp.y0) sp.y0 = b[1]; if (b[1] > sp.y1) sp.y1 = b[1];
  };
  let imageArea = 0;
  let m = transform.slice();
  let lw = 1;                          // graphics-state line width (user space)
  // graphics-state STROKE luminance (#260). PDF's initial stroke color is
  // black, so 0 is the right default and an uncolored file costs nothing.
  // pdf.js normalizes every simple stroke colorspace to setStrokeRGBColor
  // (0–255 components); a pattern stroke (setStrokeColorN) states no single
  // color, so it keeps whatever the state carried rather than inventing one.
  let lum = 0;
  // PDF's initial fill colour is black, same as stroke, so 0 is the right
  // default and an uncoloured file costs nothing.
  let fillLum = 0;
  const stack: Array<[number[], number, number, number]> = [];
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
    if (fn === OPS.save) stack.push([m.slice(), lw, lum, fillLum]);
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; lum = p[2]; fillLum = p[3]; } }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.setGState) { for (const pr of args[0] || []) if (pr && pr[0] === "LW") lw = pr[1]; }
    else if (fn === OPS.setStrokeRGBColor && args) { const L = strokeLuminance(args); if (L !== null) lum = L; }
    // FILL luminance, the same device strokeLuminance already applies to
    // strokes (#260) — and the fact that finally answers "is this ink WALL".
    // A drafter poches a wall in dark grey or black because it is solid
    // material; the pale washes over a finish plan's rooms are the finish
    // legend, not structure. Both arrive as SEG_FILLONLY and were
    // indistinguishable until now, which is why a wall test had to fall back
    // to guessing at a figure's shape.
    else if (fn === OPS.setFillRGBColor && args) { const L = strokeLuminance(args); if (L !== null) fillLum = L; }
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m.slice(), lw, lum, fillLum]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; lum = p[2]; fillLum = p[3]; } }
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
      const pathLum = lum;          // stroke color cannot change mid-path (#260)
      pathFill = fillLum;           // …and neither can the fill colour
      const visit = (p: Point) => { points.push(p); };
      const lineTo = (p: Point) => { if (cur) { segs.push(cur[0], cur[1], p[0], p[1]); metaArr.push(flags); lumArr.push(pathLum); layerOfArr.push(pathLayer); noteSeg(cur, p); } cur = p; visit(p); };
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = tx(co[c], co[c + 1]); start = cur; openSub(flags, cur); visit(cur); c += 2; }
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
            if (cur) { segs.push(cur[0], cur[1], q[0], q[1]); metaArr.push(flags | SEG_CURVE); lumArr.push(pathLum); layerOfArr.push(pathLayer); noteSeg(cur, q); }
            cur = q;
          }
          visit(p3);
        }
        else if (op === OPS.closePath) { if (cur && start) { segs.push(cur[0], cur[1], start[0], start[1]); metaArr.push(flags); lumArr.push(pathLum); layerOfArr.push(pathLayer); noteSeg(cur, start); closeSub(); cur = start; } }
        else if (op === OPS.rectangle) {
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q: Point[] = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          openSub(flags, q[0]);                       // a rect is its own figure
          for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); metaArr.push(flags); lumArr.push(pathLum); layerOfArr.push(pathLayer); noteSeg(a, b); visit(a); }
          closeSub();
          cur = q[0]; start = q[0];
        }
      }
    }
  }
  sealSub();
  const meta = Uint8Array.from(metaArr);
  markPolylineArcs(segs, meta);
  return { points, segs, meta, imageArea, lum: Uint8Array.from(lumArr), layerOf: Int32Array.from(layerOfArr), layerIds, subpaths };
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

// ── 2c. offset annotation rings — the finish tag's own outline ─────────────
// A second, independent reason a stroke is not a wall, and the one that costs
// the most square footage on a real finish plan.
//
// Room-finish sheets label each WALL, not just each room, and the drafting
// convention for that is an inset ring: a hairline offset run parallel to each
// wall a foot or two inside the room, 45° ties at the corners, with the finish
// tag (`P-1`, `P-2`) boxed on the run. It is a closed loop — the tag box
// straddles the line rather than breaking it — so a flood started inside the
// room stops on the ring and the perimeter band between ring and wall is lost.
// On demo/sample-finish-plan.pdf that is EVERY patient room: 137 measures
// 161.3 SF against roughly 200 wall-to-wall, and the band is only measurable
// as its own separate click (the corpus pins one at 20.65 SF).
//
// The hatch classifier cannot see this: a ring is ONE run per wall, and a
// lattice needs five. What identifies it is the pen. The ring is drawn
// hairline and the wall it shadows is drawn heavy — nibble 1 against nibble 2
// on the VA sheet — so the test is: the FIRST stroke you meet walking
// perpendicular off this one, within a couple of feet, on either side, is
// substantially heavier and runs alongside it. A wall fails it (walking inward
// from a wall you meet the ring, which is LIGHTER). A tile grid fails it (the
// neighbour is another grid line at the same pen). Poché fails it on length.
// An interior partition fails it unless it is genuinely shadowing a heavier
// parallel line within two feet, and where it does, the escalation's
// grow-but-verify cap is the backstop — this feeds the SAME soft plane hatch
// does, so the strict pass still treats a ring as a barrier and only an
// escalation that stays bounded and doesn't balloon is ever accepted.
// 2 ft, and the ceiling is set by a DOUBLE-COUNT hazard, not by what rings
// measure. On the VA sheet patient room 137's four rings stand off 1.6–2.18 ft,
// so 2 ft recovers three walls and leaves the west band. Raising the cap to 2.5
// takes that band too — and the bench immediately reports 20.7 SF double
// counted, because a click INSIDE the 1.15 ft band still traces the band alone
// (growing it into the room is an 11× jump, which grow-but-verify rejects), so
// the same floor is now billable twice depending where the estimator clicks.
// Under-measuring is visible on a bid; double-measuring is not. The west band
// needs the sliver rule — a 1.15 ft × 16 ft strip is not a room and should
// escalate unbounded — which is its own change with its own evidence.
export const ANNOT_OFFSET_MAX_FT = 2;      // ft — how far off a wall an annotation ring is drawn
export const ANNOT_OFFSET_MIN_FT = 0.25;   // ft — below this the pair is one drawn wall's two faces, not a ring
// 4 ft, because "spans a wall" is the actual claim and a wall is rarely
// shorter. At 2 ft the rule picked up four 2.6 ft hairline stubs beside the
// ward vestibule — door jamb pieces, not ring runs — and bought +0.68 SF (1%)
// for a real confidence deduction, which is a bad trade twice over: the
// measurement barely moved and the engine got less sure of it. The ring runs
// this rule exists for are 7.8–14 ft on the VA sheet, so the floor has room.
export const ANNOT_MIN_LEN_FT = 4;         // ft — a ring run spans a wall; poché ticks and symbol edges don't
export const ANNOT_OVERLAP_FRAC = 0.6;     // the heavier neighbour must run ALONGSIDE, not merely cross nearby
export const ANNOT_MIN_PEN_STEP = 1;       // nibbles the neighbour must exceed this stroke by
const ANNOT_MAX_SCAN = 64;                 // neighbours probed per direction — dense linework stays linear

/** Strokes that are an inset offset of a heavier parallel stroke — annotation
 *  rings, not boundaries. Same contract as classifyHatchSegs: one byte per
 *  segment, 1 = soft. `ws` scales segs into mask px; `maxOffsetPx` /
 *  `minLenPx` are mask px (feet-true when the caller knows the scale). */
export function classifyOffsetAnnotationSegs(
  segs: number[], meta: Uint8Array, ws: number,
  maxOffsetPx: number, minOffsetPx: number, minLenPx: number,
): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n || !(maxOffsetPx > 0) || !(minLenPx > 0)) return soft;
  interface Run { i: number; ang: number; d: number; t0: number; t1: number; w: number }
  const cand: Array<{ i: number; ang: number; x1: number; y1: number; x2: number; y2: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    // curves are never a straight offset run; clip-only ink is already soft;
    // a filled outline bounds solid ink and must stay hard (same exemptions
    // the hatch classifier makes, for the same reasons)
    if (mt & (SEG_CURVE | SEG_CLIP | SEG_FILLONLY)) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.hypot(dx, dy) < minLenPx) continue;
    let ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, w: meta[i] >> 4 });
  }
  if (cand.length < 2) return soft;
  // Fixed interleaved angle bins — a stroke's family must be a property of its
  // own angle, not of what else the sheet happens to contain. (A single-linkage
  // sweep chains an entire real drawing into one cluster; measured on the VA
  // sheet, 17,820 candidates collapse to 1.) Two grids offset by half a bin, so
  // a pair straddling one grid's boundary is intact in the other.
  const BIN = HATCH_ANGLE_TOL, NBINS = Math.max(1, Math.round(180 / BIN));
  for (const shift of [0, BIN / 2]) {
    const bins = new Map<number, Run[]>();
    for (const c of cand) {
      let b = Math.floor((c.ang + shift) / BIN);
      if (b >= NBINS) b -= NBINS;              // the 0°/180° seam is one family
      const th = c.ang * Math.PI / 180;
      const dxu = Math.cos(th), dyu = Math.sin(th);
      const nxu = -dyu, nyu = dxu;
      const r: Run = {
        i: c.i, ang: c.ang,
        d: ((c.x1 + c.x2) / 2) * nxu + ((c.y1 + c.y2) / 2) * nyu,
        t0: Math.min(c.x1 * dxu + c.y1 * dyu, c.x2 * dxu + c.y2 * dyu),
        t1: Math.max(c.x1 * dxu + c.y1 * dyu, c.x2 * dxu + c.y2 * dyu),
        w: c.w,
      };
      const arr = bins.get(b);
      if (arr) arr.push(r); else bins.set(b, [r]);
    }
    for (const runs of bins.values()) {
      if (runs.length < 2) continue;
      runs.sort((a, b) => a.d - b.d);
      for (let k = 0; k < runs.length; k++) {
        const c = runs[k];
        if (soft[c.i]) continue;
        const need = ANNOT_OVERLAP_FRAC * (c.t1 - c.t0);
        // The FIRST neighbour that runs alongside, each way. First and not
        // best, deliberately: a ring is the innermost line of its pair, so
        // anything between it and the wall would mean it is shadowing
        // something else and the evidence does not hold.
        const alongside = (dir: 1 | -1): Run | null => {
          for (let step = 1, j = k + dir; step <= ANNOT_MAX_SCAN && j >= 0 && j < runs.length; step++, j += dir) {
            const o = runs[j];
            const gap = Math.abs(o.d - c.d);
            if (gap > maxOffsetPx) break;
            if (gap < minOffsetPx) continue;                                    // the same wall's two faces
            if (Math.min(o.t1, c.t1) - Math.max(o.t0, c.t0) < need) continue;   // crosses nearby, doesn't run alongside
            return o;
          }
          return null;
        };
        const up = alongside(1), dn = alongside(-1);
        // A ring is a wall's shadow with OPEN FLOOR inboard of it: heavier
        // partner on exactly one side, nothing running alongside on the other.
        // The second half of that is what keeps a repetitive real bank of
        // partitions hard — its outermost member is also hairline a couple of
        // feet off a heavy shell, and only the sibling partition inboard of it
        // tells the two apart (corpus: partition-bank-15in). Requiring the
        // far side to be EMPTY also means this can never soften a stroke that
        // sits between two things, which is the shape of every real boundary.
        const heavier = (o: Run | null, other: Run | null) => !!o && !other && o.w >= c.w + ANNOT_MIN_PEN_STEP;
        if (heavier(up, dn) || heavier(dn, up)) soft[c.i] = 1;
      }
    }
  }
  return soft;
}

// ── 2d. finish texture: figures smaller than a wall ────────────────────────
// The first classifier that reads WHAT THE INK IS rather than inferring it
// from neighbourhood geometry. Rasterizing to a 1-bit mask destroys the
// distinction between a wall and a speckle fleck; `subpaths` preserves it, so
// this asks the one question the mask cannot: is this figure even large
// enough to BE a wall?
//
// The threshold is not a new guess — it is MIN_THICK_FT, the minimum wall
// thickness the flood already recognizes (a passage narrower than this is not
// a room boundary but a drafting artifact). A closed figure whose entire
// bounding box fits inside the thinnest drawable wall cannot be one.
//
// FIELD, not fleck. A lone tiny mark is a fixture detail, a hardware tick, a
// leader terminator — softening it buys nothing and costs ring stability
// (measured on the VA sheet: softening every sub-wall figure left SF within
// 1% but roughened 7 of 12 traced rings, because the fill then weaves one
// cell further into scattered detail). What actually chops a room is a
// POPULATION: concrete stipple, terrazzo speckle, carpet noise — hundreds of
// flecks blanketing a floor. So a fleck softens only where it has company,
// counted on a coarse grid. Measured on a stipple-filled commercial finish
// plan: 4,906 flecks over ~8 rooms, every one with dozens of neighbours in
// its own cell; the VA sheet's scattered detail marks mostly sit alone.
//
// Same contract as the other classifiers: one byte per segment, 1 = soft,
// pure, total, never throws. Feeds the SAME soft plane, so the escalation
// ladder still verifies by boundedness — a misjudged field either leaks or
// balloons and the strict result stands.
export const FLECK_FIELD_FT = 2;        // grid cell for the population count — a room's worth of texture, not a sheet's
export const FLECK_FIELD_MIN = 6;       // flecks in a cell (with its neighbours) before any of them is texture
export function classifyFleckSegs(
  segs: number[], meta: Uint8Array, subpaths: SubPath[] | null | undefined, ws: number, ftPx: number,
): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n || !subpaths || !subpaths.length || !(ftPx > 0)) return soft;
  const lim = MIN_THICK_FT * ftPx;
  interface Fleck { sp: SubPath; cx: number; cy: number }
  const flecks: Fleck[] = [];
  for (const s of subpaths) {
    // clip ink is already soft; a filled figure bounds solid ink and must stay
    // hard (the exemptions every classifier here makes, for the same reasons)
    if (s.flags & (SEG_CLIP | SEG_FILLONLY)) continue;
    if (s.i1 <= s.i0) continue;
    if (Math.max(s.x1 - s.x0, s.y1 - s.y0) * ws >= lim) continue;
    flecks.push({ sp: s, cx: ((s.x0 + s.x1) / 2) * ws, cy: ((s.y0 + s.y1) / 2) * ws });
  }
  if (flecks.length < FLECK_FIELD_MIN) return soft;
  const cell = FLECK_FIELD_FT * ftPx;
  const bins = new Map<string, number>();
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  for (const f of flecks) {
    const k = key(Math.floor(f.cx / cell), Math.floor(f.cy / cell));
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  for (const f of flecks) {
    const gx = Math.floor(f.cx / cell), gy = Math.floor(f.cy / cell);
    let pop = 0;
    for (let dx = -1; dx <= 1 && pop < FLECK_FIELD_MIN; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        pop += bins.get(key(gx + dx, gy + dy)) || 0;
        if (pop >= FLECK_FIELD_MIN) break;
      }
    }
    if (pop < FLECK_FIELD_MIN) continue;      // alone: a detail mark, not texture
    for (let i = f.sp.i0; i < f.sp.i1; i++) soft[i] = 1;
  }
  return soft;
}

// ── 2d′. stroke texture ─────────────────────────────────────────────────────
// The fleck classifier above reads a population of SUB-WALL-THICKNESS
// figures. Revit's stock finish patterns are not flecks: an LVT / carpet /
// rubber "stipple" prints as thousands of straight single-segment strokes one
// to eight inches long at every angle. Measured on a Revit finish plan at
// 1/8" (a VA corridor, 1,261 strokes over 286 SF): median 0.27 ft, p90
// 0.64 ft, 61% ABOVE MIN_THICK_FT — so the fleck cap leaves most of the field
// hard, and One-Click fences a 52 ft corridor into the 1–2 SF cells between
// strokes while every walled room beside it closes.
//
// What separates that field from real short linework is not size but two
// population facts, read on the same 2-ft grid the fleck classifier uses:
//   DENSITY — 53–121 eligible strokes per cell-with-neighbours (36 SF) inside
//     the stipple, against ≤ 3 in a plain room on the same sheet;
//   ORIENTATION SPREAD — 73–83% of stipple strokes sit off both drawing axes,
//     while every dense axis-aligned field on the same sheets (wall poché
//     printed as hairline arrays, ceiling grids, tile coursing, a stipple-free
//     finish plan's densest cell at 97) measures 0–25% off-axis.
// Both must hold: density alone would soften poché, spread alone a lone
// fixture. Curve chords, closed figures, multi-chord paths, clip and fill ink
// are never eligible — those are drawing, and the door-swing / poché
// exemptions every classifier here makes hold unchanged.
//
// Same contract as the others: one byte per segment, 1 = soft, pure, total,
// never throws. Feeds the SAME soft plane, so the escalation ladder still
// verifies by boundedness — a misjudged field leaks or balloons and the
// strict result stands.
export const STROKE_TEX_MAX_FT = 1.0;        // longer is drawing, not texture (stipple p90 0.64 ft)
export const STROKE_TEX_FIELD_MIN = 40;      // eligible strokes in a cell with its neighbours; stipple measures ≥ 53
export const STROKE_TEX_OFFAXIS_MIN = 0.5;   // fraction off both axes; stipple ≥ 0.73, poché / grids ≤ 0.25
export const STROKE_TEX_AXIS_TOL_DEG = 5;    // within this of horizontal or vertical is ON axis
export function classifyStrokeTextureSegs(
  segs: number[], meta: Uint8Array, subpaths: SubPath[] | null | undefined, ws: number, ftPx: number,
): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n || !subpaths || !subpaths.length || !(ftPx > 0)) return soft;
  const lo = MIN_THICK_FT * ftPx, hi = STROKE_TEX_MAX_FT * ftPx;
  const axisTol = Math.tan(STROKE_TEX_AXIS_TOL_DEG * Math.PI / 180);
  interface Stroke { sp: SubPath; gx: number; gy: number; off: number }
  const cell = FLECK_FIELD_FT * ftPx;
  const strokes: Stroke[] = [];
  for (const s of subpaths) {
    if (s.flags & (SEG_CLIP | SEG_FILLONLY)) continue;
    if (s.closed || s.i1 <= s.i0 || s.i1 - s.i0 > 2) continue;
    const ext = Math.max(s.x1 - s.x0, s.y1 - s.y0) * ws;
    if (ext < lo || ext >= hi) continue;
    let curve = false;
    for (let i = s.i0; i < s.i1; i++) if (meta[i] & SEG_CURVE) { curve = true; break; }
    if (curve) continue;
    const i = s.i0 * 4;
    const dx = Math.abs(segs[i + 2] - segs[i]), dy = Math.abs(segs[i + 3] - segs[i + 1]);
    const off = Math.min(dx, dy) > Math.max(dx, dy) * axisTol ? 1 : 0;
    strokes.push({ sp: s, gx: Math.floor(((s.x0 + s.x1) / 2) * ws / cell), gy: Math.floor(((s.y0 + s.y1) / 2) * ws / cell), off });
  }
  if (strokes.length < STROKE_TEX_FIELD_MIN) return soft;
  const bins = new Map<string, [number, number]>();
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  for (const st of strokes) {
    const k = key(st.gx, st.gy);
    const b = bins.get(k);
    if (b) { b[0]++; b[1] += st.off; } else bins.set(k, [1, st.off]);
  }
  const verdict = new Map<string, boolean>();
  for (const st of strokes) {
    const k = key(st.gx, st.gy);
    let v = verdict.get(k);
    if (v === undefined) {
      let pop = 0, off = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b = bins.get(key(st.gx + dx, st.gy + dy));
        if (b) { pop += b[0]; off += b[1]; }
      }
      v = pop >= STROKE_TEX_FIELD_MIN && off >= STROKE_TEX_OFFAXIS_MIN * pop;
      verdict.set(k, v);
    }
    if (!v) continue;
    for (let i = st.sp.i0; i < st.sp.i1; i++) soft[i] = 1;
  }
  return soft;
}

// ── 2e. label boxes ────────────────────────────────────────────────────────
// The most common way an estimator's click goes wrong, and the one the mask
// can never see: a room tag (`111`), a finish tag (`PC-01`), a keynote
// bubble — each a CLOSED box drawn inside the room it labels. Click inside
// one and the flood is bounded by the box, so the answer is 0.5 SF instead of
// the room. Measured on a commercial finish plan: in one 24 SF storeroom,
// 55% of clicks landed in a tag box and traced it.
//
// What identifies a label box is not its size — it is that THE BOX EXISTS TO
// FRAME THE TEXT. A tag hugs its label; a room dwarfs its label. Measured
// across two sheets as the ratio of contained-text bbox area to figure area:
// figures under a room's size average 1.70 and 1.57, room-scale figures
// average 0.59 and 0.29, and the outliers on the high side at room scale are
// sheet borders and title blocks that enclose ALL the text on the page — which
// is why the ratio alone is not enough and the size cap below it is.
//
// The cap is set beneath the smallest space anyone takes off (a broom closet
// is 15-20 SF; the largest genuine tag box measured is 1.5 SF), so no room
// can be inside it whatever its text. And because this feeds the SAME soft
// plane, a misjudged box does not delete a boundary: the strict pass still
// stops at it, the escalation ladder sees a wholly-soft boundary and reflows
// to the room behind it, and any escalation that leaks is discarded.
export const TAGBOX_MAX_SF = 6;         // well under any real space; measured tag boxes top out at 1.5 SF
export const TAGBOX_TEXT_FRAC = 0.25;   // the text must FILL the box — rooms sit far below this
export const TAGBOX_HALO = 1.0;         // frame strokes lie within this many text heights of the text line
export const TAGBOX_LINE_TOL = 0.3;     // baseline jitter (in text heights) that still reads as one line
export const TAGBOX_LINE_GAP = 1.0;     // horizontal gap (in text heights) between items of one label
export const TAGBOX_FRAME_AXIS_TOL_DEG = 5;
export const TAGBOX_SIDE_MIN_FRAC = 0.6;  // a side is at least this fraction of the text extent it parallels
export const TAGBOX_PAIR_OVERLAP = 0.8;   // the two sides of a pair overlap along their length by this much
export function classifyTagBoxSegs(
  segs: number[], meta: Uint8Array, subpaths: SubPath[] | null | undefined,
  texts: TextMark[] | null | undefined, ws: number, ftPx: number,
): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n || !subpaths?.length || !texts?.length || !(ftPx > 0)) return soft;
  const maxArea = TAGBOX_MAX_SF * ftPx * ftPx;
  // text lookup on a coarse grid — a sheet carries thousands of items and
  // every small closed figure would otherwise scan all of them
  const cell = Math.max(1, 4 * ftPx);
  const grid = new Map<string, TextMark[]>();
  for (const t of texts) {
    const k = `${Math.floor(t.x * ws / cell)},${Math.floor(t.y * ws / cell)}`;
    const a = grid.get(k); if (a) a.push(t); else grid.set(k, [t]);
  }
  for (const sp of subpaths) {
    if (!sp.closed || sp.i1 <= sp.i0) continue;
    if (sp.flags & SEG_CLIP) continue;          // invisible ink is soft already
    const x0 = sp.x0 * ws, y0 = sp.y0 * ws, x1 = sp.x1 * ws, y1 = sp.y1 * ws;
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0) || !(h > 0) || w * h > maxArea) continue;
    // contained text, and its own extent
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity, found = 0;
    const gx = Math.floor(x0 / cell), gy = Math.floor(y0 / cell);
    const gx1 = Math.floor(x1 / cell), gy1 = Math.floor(y1 / cell);
    for (let a = gx; a <= gx1; a++) for (let b = gy; b <= gy1; b++) {
      for (const t of grid.get(`${a},${b}`) || []) {
        const px = t.x * ws, py = t.y * ws, pw = t.w * ws, ph = (t.h || 0) * ws;
        if (px < x0 || px > x1 || py < y0 - ph || py > y1 + ph) continue;
        found++;
        if (px < tx0) tx0 = px; if (px + pw > tx1) tx1 = px + pw;
        if (py - ph < ty0) ty0 = py - ph; if (py > ty1) ty1 = py;
      }
    }
    if (!found) continue;                       // an empty small box is a fixture, not a label
    const ta = Math.max(0, tx1 - tx0) * Math.max(0, ty1 - ty0);
    if (ta < TAGBOX_TEXT_FRAC * w * h) continue;  // the text does not fill it: not a frame
    for (let i = sp.i0; i < sp.i1; i++) soft[i] = 1;
  }
  // A frame that is not a figure. Revit draws a finish / room tag as FOUR open
  // strokes, not one closed path, so the figure test above never sees it —
  // and at 1/8" a stock tag frame is ~5 × 3 ft of plan (14 SF), past any
  // SF cap, because a label is sized on PAPER, not on the floor. Measured on
  // a VA finish plan: the "LVT-1" frame across a 3.4 ft corridor left a
  // 3-mask-px slit against each wall, under the minimum passage, and cut the
  // corridor in two. The rule here is text-relative, so it holds at any
  // scale: merge text items on one baseline into a line, pad the line by its
  // own height into a halo, and soften every OPEN, straight, axis-aligned
  // stroke that lies ENTIRELY inside the halo. A wall runs feet past any
  // label's halo and never qualifies; a jamb stub under a door tag can, and
  // the escalation ladder then verifies the result by boundedness as always.
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number; h: number }> = [];
  const sorted = texts.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const t of sorted) {
    const th = t.h || 0;
    if (!(th > 0) || !(t.w > 0)) continue;
    const last = lines[lines.length - 1];
    if (last && Math.abs(t.y - last.y1) <= last.h * TAGBOX_LINE_TOL && t.x - last.x1 <= last.h * TAGBOX_LINE_GAP && t.x >= last.x0) {
      last.x1 = Math.max(last.x1, t.x + t.w); last.y0 = Math.min(last.y0, t.y - th); last.h = Math.max(last.h, th);
    } else lines.push({ x0: t.x, y0: t.y - th, x1: t.x + t.w, y1: t.y, h: th });
  }
  // Candidate frame sides: open, straight, axis-aligned strokes. Indexed on
  // the same coarse grid; a wall piece is feet long and never fits a halo.
  const axisTol = Math.tan(TAGBOX_FRAME_AXIS_TOL_DEG * Math.PI / 180);
  interface Side { sp: SubPath; x0: number; y0: number; x1: number; y1: number; horiz: boolean; len: number }
  const sideGrid = new Map<string, Side[]>();
  for (const sp of subpaths) {
    if (sp.closed || sp.i1 <= sp.i0 || sp.i1 - sp.i0 > 2) continue;
    if (sp.flags & (SEG_CLIP | SEG_FILLONLY)) continue;
    if (meta[sp.i0] & SEG_CURVE) continue;
    const i = sp.i0 * 4;
    const dx = Math.abs(segs[i + 2] - segs[i]), dy = Math.abs(segs[i + 3] - segs[i + 1]);
    if (Math.min(dx, dy) > Math.max(dx, dy) * axisTol) continue;      // a leader is oblique; a frame side is not
    const sd: Side = { sp, x0: sp.x0 * ws, y0: sp.y0 * ws, x1: sp.x1 * ws, y1: sp.y1 * ws, horiz: dx >= dy, len: Math.max(dx, dy) * ws };
    const k = `${Math.floor(sd.x0 / cell)},${Math.floor(sd.y0 / cell)}`;
    const arr = sideGrid.get(k); if (arr) arr.push(sd); else sideGrid.set(k, [sd]);
  }
  if (!sideGrid.size) return soft;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (const ln of lines) {
    const pad = ln.h * TAGBOX_HALO;
    const hx0 = (ln.x0 - pad) * ws, hy0 = (ln.y0 - pad) * ws, hx1 = (ln.x1 + pad) * ws, hy1 = (ln.y1 + pad) * ws;
    const tx0 = ln.x0 * ws, ty0 = ln.y0 * ws, tx1 = ln.x1 * ws, ty1 = ln.y1 * ws, th = ln.h * ws;
    const above: Side[] = [], below: Side[] = [], left: Side[] = [], right: Side[] = [];
    for (let a = Math.floor(hx0 / cell); a <= Math.floor(hx1 / cell); a++) for (let b = Math.floor(hy0 / cell); b <= Math.floor(hy1 / cell); b++) {
      for (const sd of sideGrid.get(`${a},${b}`) || []) {
        if (sd.x0 < hx0 || sd.x1 > hx1 || sd.y0 < hy0 || sd.y1 > hy1) continue;   // must lie ENTIRELY in the halo
        if (sd.horiz) {
          if (sd.len < TAGBOX_SIDE_MIN_FRAC * (tx1 - tx0)) continue;             // a side spans the text it frames
          if (sd.y1 <= ty0) above.push(sd); else if (sd.y0 >= ty1) below.push(sd);
        } else {
          if (sd.len < TAGBOX_SIDE_MIN_FRAC * th) continue;
          if (sd.x1 <= tx0) left.push(sd); else if (sd.x0 >= tx1) right.push(sd);
        }
      }
    }
    // A frame is two parallel sides BRACKETING the text — a lone stroke under
    // a label (a jamb, a wall face, an underline) has no partner and stays hard.
    const pair = (as: Side[], bs: Side[], horiz: boolean) => {
      for (const a of as) for (const b of bs) {
        const ov = horiz ? overlap(a.x0, a.x1, b.x0, b.x1) : overlap(a.y0, a.y1, b.y0, b.y1);
        if (ov >= TAGBOX_PAIR_OVERLAP * Math.min(a.len, b.len)) {
          for (let j = a.sp.i0; j < a.sp.i1; j++) soft[j] = 1;
          for (let j = b.sp.i0; j < b.sp.i1; j++) soft[j] = 1;
        }
      }
    };
    pair(above, below, true);
    pair(left, right, false);
  }
  return soft;
}

// ── 2f. dimension strings (issue #320) ──────────────────────────────────────
// On a FLATTENED sheet the layer path is dead (`classifyLayerName` returns
// role unknown at confidence 0 — correctly: nothing is stated) and neither
// geometric classifier sees a dimension string: it has no heavier parallel
// neighbour within 2 ft (the run is drawn 2–6 ft off the building face, often
// stacked), its witness lines run PERPENDICULAR to everything nearby, and its
// pen weight matches thin partition linework. So One-Click reads the string as
// boundary: the flood leaks into the dimension band beside the building, or a
// witness line crossing a room chops it. Field report, flattened multifamily.
//
// What identifies a dimension string is its ANATOMY, not its pen. Measured on
// two real flattened sets (a Revit multifamily permit sheet at 1/4" = 1'-0",
// 18 px/ft; an AutoCAD-exported commercial finish plan at 3/32" = 1'-0",
// 6.75 px/ft, its linework exploded to ~1 px dashes):
//   • one long straight RUN (measured 4.7–31 ft), text between witnesses —
//     text is showText ops, never vectors, so a real run sits in an EMPTY band;
//   • short WITNESS lines meeting it at 90°, one per dimensioned feature —
//     0.5–1.2 ft on the Revit sheet — spaced at ROOM-scale intervals (never
//     the sub-foot rhythm of hatch, coursing, or stipple);
//   • an oblique TICK or arrow ON the run at each junction: 45° slashes
//     0.94 ft long (heavier pen) on the Revit sheet, ~30° arrow strokes
//     0.34 ft long (same pen) on the AutoCAD sheet;
//   • at every junction, ink CONTINUES PAST the joint — the run overshoots
//     the end witnesses (0.39 ft measured) or the witness extends past the
//     run. A rectangle's corner has neither, which is what separates a
//     two-witness dim from every legend swatch and tag box on the sheet;
//   • nothing runs alongside: a wall face has its partner face 0.33–1 ft
//     away for its whole length, a stacked dim string's neighbour run is
//     ≥ 1.5 ft off (3/8" paper at 1/4" scale) and is another dim, not a wall.
//
// The classifier reassembles collinear CHAINS first (the AutoCAD sheet's
// exploded dashes — same device markPolylineArcs uses for arc chords), then
// accepts a chain as a dim RUN only on the full conjunction: isolated, ≥ 2
// sparse witness junctions each continuing past the joint, ticks at ≥ 2 of
// them (and at least half), and an otherwise-empty band. Every threshold is
// feet-true — this runs only when the sheet scale is known — with small
// absolute px floors where the phenomenon is ink/quantization, not geometry
// (the CLUSTER_FIT_TOL_PX precedent).
//
// Softening is deliberately narrower than evidence: a witness is often drawn
// COLLINEAR with the wall edge it dimensions, and on the Revit sheet the
// 0.25 ft witness-to-wall drafting gap sits BELOW the 0.5 ft dash gaps of the
// sheet's own centreline patterns — no gap threshold separates them — so a
// witness chain that merged into longer linework, or one with a wall-length
// parallel partner of its own, is counted as evidence but never softened.
// Union into the same soft plane as hatch and annotation rings; never
// subtracted; the escalation ladder decides what soft is worth.
export const DIMSTR_ANGLE_TOL = 2;        // deg — CAD angle jitter ≪ 1° (HATCH_ANGLE_TOL's evidence)
export const DIMSTR_CHAIN_GAP_FT = 0.6;   // collinear pieces closer than this are one drawn line
export const DIMSTR_CHAIN_GAP_PX = 3;     // floor — dash/quantization gaps are ink-scale, not feet
export const DIMSTR_CHAIN_OFF_FT = 0.06;  // perpendicular jitter within one drawn line
export const DIMSTR_CHAIN_OFF_PX = 1.25;  // floor — sub-px offsets are float noise at coarse scales
export const DIMSTR_RUN_MIN_FT = 4;       // shortest measured real run is 4.7 ft; ANNOT_MIN_LEN_FT's reasoning
export const DIMSTR_ISO_OFF_FT = 1.0;     // a parallel partner within a wall's breadth …
export const DIMSTR_ISO_OVERLAP = 0.4;    // … spanning this fraction of the RUN makes it a wall face
export const DIMSTR_WITNESS_MIN_FT = 0.3; // below the shortest measured witness (0.5 ft) with margin
export const DIMSTR_WITNESS_SOFT_MAX_FT = 8;  // soften cap — longer chains are glued linework: evidence only
export const DIMSTR_ATTACH_FT = 0.35;     // junction slop: witness end / tick centre to the run line
export const DIMSTR_ATTACH_PX = 2;        // floor — a junction is an ink joint, ≥ pen scale
export const DIMSTR_JUNCTION_MIN_FT = 1.5;// witnesses are room-spaced; coursing/stipple rhythms are sub-foot
export const DIMSTR_WIT_PER_JUNCTION_MAX = 2; // a dim junction is ONE witness (two at a shared boundary)
export const DIMSTR_TICK_MIN_FT = 0.2;    // measured ticks 0.34–0.94 ft; stipple dots sit below this
export const DIMSTR_TICK_MAX_FT = 1.5;    // a longer oblique is drawing, not a tick
export const DIMSTR_TICK_ANG_LO = 20;     // deg off the run — covers ~30° arrows …
export const DIMSTR_TICK_ANG_HI = 70;     // … and 45° slashes with jitter margin
export const DIMSTR_TICK_AT_JUNCTION_FT = 0.5;  // a tick marks ITS junction, not the run at large
export const DIMSTR_MIN_JUNCTIONS = 2;    // a dimension has two ends
export const DIMSTR_MIN_TICKED = 2;       // … and marks both
export const DIMSTR_TICKED_FRAC = 0.5;    // most junctions carry their mark (jamb clutter does not)
export const DIMSTR_OVERSHOOT_FT = 0.1;   // ink past a joint (0.39 ft measured); a corner has none
export const DIMSTR_OVERSHOOT_PX = 2;     // floor — overshoot is ink, not geometry
export const DIMSTR_TOUCH_CLUTTER_MAX = 1;// non-witness/tick chains allowed to TOUCH the run
// path B (tick-anchored interior strings) — measured on the calibration
// sheet's interior strings: slash pairs 3.4 px apart, junction spacing ≥ 3 ft
export const DIMTEXT_NEAR_FT = 1.0;             // dim text sits ON its line (2 px measured); a generous foot covers styles that float it
export const DIMTEXT_REACH_FT = 40;             // how far along the line from its text a string plausibly extends
export const DIMTEXT_MIN_LINE_X = 1.5;          // the drawn line must dwarf the text (an underline matches it)
export const DIMTEXT_STUB_MAX_FT = 2.5;         // ticks and witness stubs; measured 0.27–1.2 ft
export const DIMSTR_LINE_MARGIN_FT = 0.5;       // pieces just past the span still belong
export const DIMSTR_PIECE_MAX_DIMFRAC = 0.66;   // a merge piece more dim-bounded than this is exterior band, not floor
export const DIMSTR_PIECE_MAX_CURVEFRAC = 0.25; // …and one this curve-bounded is a door-swing pocket, not floor
export const DIMSTR_BAND_FT = 0.7;        // the empty band a real run sits in …
export const DIMSTR_BAND_CLUTTER_MAX = 4; // … and the stray chains tolerated inside it (hex keynote
                                          // tags ride the band on the Revit sheet; a stipple field
                                          // or a table's cell text boxes blow far past this)

interface DimChain {
  axis: number;               // deg, [0, 180) — the bin axis the chain merged on
  d: number;                  // mean perpendicular offset of members, mask px
  t0: number; t1: number;     // extent along the axis, mask px
  len: number;
  members: number[];          // segment indices
  p0: [number, number]; p1: [number, number];  // endpoints in mask px
}

/** Collinear-chain reassembly + dimension-string comb detection. Pure and
 *  deterministic; all inputs in mask px, `ftPx` = mask px per foot (> 0 —
 *  the caller gates on scale). Exported for calibration and tests; the
 *  boundary-mask contract is `classifyDimensionStringSegs` below. */
export interface DimReject { axis: number; d: number; t0: number; t1: number; lenFt: number; why: string }
/** A positioned dimension-pattern text item (image px; ang = baseline rotation
 *  in degrees; wPx = rendered text width) — see sheets.extractDimTexts. */
export interface DimTextMark { x: number; y: number; ang: number; wPx: number }
export function sweepDimensionStrings(segs: number[], meta: Uint8Array, ws: number, ftPx: number, rejects?: DimReject[], dimTexts?: DimTextMark[] | null): { soft: Uint8Array; runs: DimChain[] } {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  const hits: DimChain[] = [];
  if (!meta || !n || !(ftPx > 0)) return { soft, runs: hits };
  interface Cand { i: number; ang: number; x1: number; y1: number; x2: number; y2: number; L: number }
  const cand: Cand[] = [];
  for (let i = 0; i < n; i++) {
    if (meta[i] & (SEG_CURVE | SEG_CLIP | SEG_FILLONLY)) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (!(L > 0)) continue;
    let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, L });
  }
  if (!cand.length) return { soft, runs: hits };      // (path A self-guards on counts; the text path can anchor a single drawn line)
  // 1. collinear chains, on the hatch classifier's interleaved angle grids so
  // a family straddling one grid's bin boundary is intact in the other. A
  // multi-member chain claims its segs in pass 1; singletons re-bin in pass 2.
  const BIN = DIMSTR_ANGLE_TOL, NB = Math.round(180 / BIN);
  const gap = Math.max(DIMSTR_CHAIN_GAP_PX, DIMSTR_CHAIN_GAP_FT * ftPx);
  const offTol = Math.max(DIMSTR_CHAIN_OFF_PX, DIMSTR_CHAIN_OFF_FT * ftPx);
  const chains: DimChain[] = [];
  const claimed = new Uint8Array(n);
  interface Row { c: Cand; d: number; t0: number; t1: number }
  for (const shift of [0, BIN / 2]) {
    const bins = new Map<number, Row[]>();
    for (const c of cand) {
      if (claimed[c.i]) continue;
      let b = Math.floor((c.ang + shift) / BIN);
      if (b >= NB) b -= NB;                             // the 0°/180° seam is one family
      const axis = ((b * BIN - shift + BIN / 2) % 180 + 180) % 180;
      const th = axis * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
      const r: Row = { c,
        d: ((c.x1 + c.x2) / 2) * nx + ((c.y1 + c.y2) / 2) * ny,
        t0: Math.min(c.x1 * dx + c.y1 * dy, c.x2 * dx + c.y2 * dy),
        t1: Math.max(c.x1 * dx + c.y1 * dy, c.x2 * dx + c.y2 * dy) };
      const arr = bins.get(b);
      if (arr) arr.push(r); else bins.set(b, [r]);
    }
    for (const [b, rows] of bins) {
      const axis = ((b * BIN - shift + BIN / 2) % 180 + 180) % 180;
      rows.sort((a, z) => a.d - z.d || a.t0 - z.t0);
      let g0 = 0;
      for (let k = 1; k <= rows.length; k++) {
        if (k < rows.length && rows[k].d - rows[k - 1].d <= offTol) continue;
        const grp = rows.slice(g0, k).sort((a, z) => a.t0 - z.t0 || a.t1 - z.t1);
        let cur: (DimChain & { dSum: number }) | null = null;
        const flush = () => {
          if (!cur) return;
          if (shift === 0 || cur.members.length > 1 || !claimed[cur.members[0]]) {
            if (shift === 0 && cur.members.length < 2) { cur = null; return; }  // singleton: retry on the shifted grid
            cur.d = cur.dSum / cur.members.length;
            cur.len = cur.t1 - cur.t0;
            const th = axis * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
            cur.p0 = [cur.t0 * dx + cur.d * nx, cur.t0 * dy + cur.d * ny];
            cur.p1 = [cur.t1 * dx + cur.d * nx, cur.t1 * dy + cur.d * ny];
            chains.push(cur);
            for (const m of cur.members) claimed[m] = 1;
          }
          cur = null;
        };
        for (const r of grp) {
          if (cur && r.t0 - cur.t1 <= gap) { cur.t1 = Math.max(cur.t1, r.t1); cur.members.push(r.c.i); cur.dSum += r.d; }
          else { flush(); cur = { axis, d: 0, dSum: r.d, t0: r.t0, t1: r.t1, len: 0, members: [r.c.i], p0: [0, 0], p1: [0, 0] }; }
        }
        flush();
        g0 = k;
      }
    }
  }
  // 2. comb detection over the chains
  const runMin = DIMSTR_RUN_MIN_FT * ftPx, isoOff = DIMSTR_ISO_OFF_FT * ftPx;
  const wMin = DIMSTR_WITNESS_MIN_FT * ftPx, wSoftMax = DIMSTR_WITNESS_SOFT_MAX_FT * ftPx;
  const attach = Math.max(DIMSTR_ATTACH_PX, DIMSTR_ATTACH_FT * ftPx);
  const jMin = DIMSTR_JUNCTION_MIN_FT * ftPx;
  const tickMin = DIMSTR_TICK_MIN_FT * ftPx, tickMax = DIMSTR_TICK_MAX_FT * ftPx;
  const tickAt = DIMSTR_TICK_AT_JUNCTION_FT * ftPx;
  const over = Math.max(DIMSTR_OVERSHOOT_PX, DIMSTR_OVERSHOOT_FT * ftPx);
  const band = DIMSTR_BAND_FT * ftPx;
  // has this chain a same-axis partner alongside for most of its length?
  const hasParallelPartner = (C: DimChain, skip: DimChain | null): boolean => {
    const th = C.axis * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    for (const O of chains) {
      if (O === C || O === skip) continue;
      let rel = Math.abs(O.axis - C.axis); if (rel > 90) rel = 180 - rel;
      if (rel > 3 * DIMSTR_ANGLE_TOL) continue;
      const d0 = O.p0[0] * nx + O.p0[1] * ny - C.d, d1 = O.p1[0] * nx + O.p1[1] * ny - C.d;
      // below attach/2 the "partner" is this same drawn line's own pieces
      // (jitter ≤ ~2 px) — a wall's partner face sits a wall-thickness off
      // (0.28 ft = 5 px measured), safely above. Same reasoning as
      // ANNOT_OFFSET_MIN_FT: too close is one line, not a pair.
      const gapAbs = Math.min(Math.abs(d0), Math.abs(d1));
      if (gapAbs > isoOff || gapAbs < attach / 2) continue;
      const t0 = Math.min(O.p0[0] * dx + O.p0[1] * dy, O.p1[0] * dx + O.p1[1] * dy);
      const t1 = Math.max(O.p0[0] * dx + O.p0[1] * dy, O.p1[0] * dx + O.p1[1] * dy);
      if (Math.min(t1, C.t1) - Math.max(t0, C.t0) >= DIMSTR_ISO_OVERLAP * C.len) return true;
    }
    return false;
  };
  const reject = (R: DimChain, why: string) => { rejects?.push({ axis: R.axis, d: R.d, t0: R.t0, t1: R.t1, lenFt: R.len / ftPx, why }); };
  for (const R of chains) {
    if (R.len < runMin) continue;
    if (hasParallelPartner(R, null)) { reject(R, "iso"); continue; }   // a wall face, never a dim run
    const th = R.axis * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    interface Joint { t: number; C: DimChain; past: boolean }
    const wit: Joint[] = [], ticks: Joint[] = [];
    let touchClutter = 0;
    for (const C of chains) {
      if (C === R) continue;
      const d0 = C.p0[0] * nx + C.p0[1] * ny - R.d, d1 = C.p1[0] * nx + C.p1[1] * ny - R.d;
      const near0 = Math.abs(d0) <= attach, near1 = Math.abs(d1) <= attach;
      const crosses = (d0 < -attach && d1 > attach) || (d1 < -attach && d0 > attach);
      if (!near0 && !near1 && !crosses) continue;
      const t0 = C.p0[0] * dx + C.p0[1] * dy, t1 = C.p1[0] * dx + C.p1[1] * dy;
      const tm = (t0 + t1) / 2;
      const tRef = near0 && !near1 ? t0 : near1 && !near0 ? t1 : tm;
      if (tRef < R.t0 - attach || tRef > R.t1 + attach) continue;
      let rel = Math.abs(C.axis - R.axis); if (rel > 90) rel = 180 - rel;
      if (rel >= 90 - 2 * DIMSTR_ANGLE_TOL && C.len >= wMin) {
        // continues past the joint: crosses outright, or reaches the line at
        // both extremes of its own extent (an overshooting witness does; a
        // stroke that merely ENDS on the line does not)
        wit.push({ t: tRef, C, past: crosses || (near0 && near1) });
      } else if (rel >= DIMSTR_TICK_ANG_LO && rel <= DIMSTR_TICK_ANG_HI
          && C.len >= tickMin && C.len <= tickMax && Math.abs((d0 + d1) / 2) <= attach) {
        ticks.push({ t: tm, C, past: false });
      } else if (++touchClutter > DIMSTR_TOUCH_CLUTTER_MAX) break;
    }
    if (touchClutter > DIMSTR_TOUCH_CLUTTER_MAX) { reject(R, "touch-clutter"); continue; }
    // box-corner rejection: keep a junction only where ink continues past it
    const live = wit.filter((w) => w.past || (w.t >= R.t0 + over && w.t <= R.t1 - over));
    if (live.length < DIMSTR_MIN_JUNCTIONS) { reject(R, `witnesses (raw=${wit.length} live=${live.length} ticks=${ticks.length})`); continue; }
    live.sort((a, z) => a.t - z.t);
    interface Junction { t: number; n: number }
    const junc: Junction[] = [];
    let dense = false;
    for (const w of live) {
      const j = junc[junc.length - 1];
      if (j && w.t - j.t < jMin) { if (++j.n > DIMSTR_WIT_PER_JUNCTION_MAX) { dense = true; break; } }
      else junc.push({ t: w.t, n: 1 });
    }
    if (dense || junc.length < DIMSTR_MIN_JUNCTIONS) { reject(R, dense ? "dense" : "junctions"); continue; }
    let ticked = 0;
    const usedTicks: Joint[] = [];
    for (const j of junc) {
      const t = ticks.find((tk) => Math.abs(tk.t - j.t) <= tickAt);
      if (t) { ticked++; usedTicks.push(t); }
    }
    if (ticked < DIMSTR_MIN_TICKED || ticked < DIMSTR_TICKED_FRAC * junc.length) { reject(R, `ticked (junc=${junc.length} ticked=${ticked} ticks=${ticks.length})`); continue; }
    // empty-band check: beyond its own comb, nothing shares a real run's band
    const witSet = new Set(live.map((w) => w.C)), tickSet = new Set(usedTicks.map((t) => t.C));
    let bandClutter = 0;
    for (const C of chains) {
      if (C === R || witSet.has(C) || tickSet.has(C)) continue;
      const mx = (C.p0[0] + C.p1[0]) / 2, my = (C.p0[1] + C.p1[1]) / 2;
      if (Math.abs(mx * nx + my * ny - R.d) > band) continue;
      const tt = mx * dx + my * dy;
      if (tt < R.t0 || tt > R.t1) continue;
      if (++bandClutter > DIMSTR_BAND_CLUTTER_MAX) break;
    }
    if (bandClutter > DIMSTR_BAND_CLUTTER_MAX) { reject(R, "band-clutter"); continue; }
    hits.push(R);
    for (const m of R.members) soft[m] = 1;
    for (const t of usedTicks) for (const m of t.C.members) soft[m] = 1;
    for (const w of live) {
      // soften a witness only when it is demonstrably NOT wall linework: short
      // enough to be a witness alone (not glued across a drafting gap) and
      // without a wall-length parallel partner of its own
      if (w.C.len > wSoftMax) continue;
      if (hasParallelPartner(w.C, R)) continue;
      for (const m of w.C.members) soft[m] = 1;
    }
  }

  // ── path B: dimension-TEXT-anchored strings (#320) ─────────────────────────
  // The comb path above is calibrated on EXTERIOR dimension bands, which sit
  // in empty sheet space. An INTERIOR string — drawn across a room, chopping
  // the flood (the reported failure) — lives in clutter by nature, and no
  // purely geometric acceptance survived four real sheets: every conjunction
  // loose enough to catch interior strings also caught door-leaf chevrons,
  // X-braces, or a diagonal hatch field somewhere. The unambiguous anchor the
  // sheet actually offers is the DIMENSION TEXT itself: `18'-10"` is a
  // pattern nothing else on a plan carries, and on the calibration sheet it
  // sits within 2 px of its line. So when the caller supplies positioned
  // dim-pattern text (the app extracts page text anyway for scale detection;
  // headless callers that pass none simply get path A alone), a string is:
  // collinear drawn ink near the text, aligned with the text's own baseline
  // rotation, spanning well past the text — plus its ticks and witness stubs.
  // The wall guards stay: a chain with a wall-length parallel partner is
  // never softened, which also self-protects schedule tables (their row rules
  // ride 0.3–0.5 ft apart and read as partnered linework).
  if (dimTexts && dimTexts.length) {
    const near = DIMTEXT_NEAR_FT * ftPx;
    const reach = DIMTEXT_REACH_FT * ftPx;
    const margin = DIMSTR_LINE_MARGIN_FT * ftPx;
    for (const T of dimTexts) {
      const ang = ((T.ang % 180) + 180) % 180;
      const th = ang * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
      const tx = T.x * ws, ty = T.y * ws;
      const dT = tx * nx + ty * ny, tT = tx * dx + ty * dy;
      const pieces: DimChain[] = [];
      let dSum = 0, wSum = 0;
      for (const C of chains) {
        let rel = Math.abs(C.axis - ang); if (rel > 90) rel = 180 - rel;
        if (rel > 2 * DIMSTR_ANGLE_TOL) continue;
        const cd = ((C.p0[0] + C.p1[0]) / 2) * nx + ((C.p0[1] + C.p1[1]) / 2) * ny;
        if (Math.abs(cd - dT) > near) continue;
        const ct0 = Math.min(C.p0[0] * dx + C.p0[1] * dy, C.p1[0] * dx + C.p1[1] * dy);
        const ct1 = Math.max(C.p0[0] * dx + C.p0[1] * dy, C.p1[0] * dx + C.p1[1] * dy);
        if (ct1 < tT - reach || ct0 > tT + reach) continue;
        pieces.push(C);
        dSum += cd * C.len; wSum += C.len;
      }
      if (!wSum) continue;
      let t0 = Infinity, t1 = -Infinity, drawn = 0;
      for (const C of pieces) {
        t0 = Math.min(t0, Math.min(C.p0[0] * dx + C.p0[1] * dy, C.p1[0] * dx + C.p1[1] * dy));
        t1 = Math.max(t1, Math.max(C.p0[0] * dx + C.p0[1] * dy, C.p1[0] * dx + C.p1[1] * dy));
        drawn += C.len;
      }
      // the line must be REAL: drawn ink at least room-scale AND well past the
      // text itself (a room label's underline matches its text width; a dim
      // line dwarfs its text)
      if (drawn < Math.max(runMin, DIMTEXT_MIN_LINE_X * T.wPx * ws)) continue;
      const dLine = dSum / wSum;
      const proxy: DimChain = { axis: ang, d: dLine, t0, t1, len: t1 - t0, members: [],
        p0: [t0 * dx + dLine * nx, t0 * dy + dLine * ny], p1: [t1 * dx + dLine * nx, t1 * dy + dLine * ny] };
      if (hasParallelPartner(proxy, null)) continue;
      hits.push(proxy);
      for (const C of pieces) {
        // per-piece wall protection, same rule as witness softening above
        if (C.len > (t1 - t0) + 2 * margin) continue;
        if (hasParallelPartner(C, null)) continue;
        for (const m of C.members) soft[m] = 1;
      }
      // ticks and witness stubs at the line, inside the span: short strokes
      // meeting it obliquely or perpendicularly
      for (const C of chains) {
        if (C.len < tickMin || C.len > DIMTEXT_STUB_MAX_FT * ftPx) continue;
        let rel = Math.abs(C.axis - ang); if (rel > 90) rel = 180 - rel;
        if (rel < DIMSTR_TICK_ANG_LO) continue;
        const d0 = C.p0[0] * nx + C.p0[1] * ny - dLine, d1 = C.p1[0] * nx + C.p1[1] * ny - dLine;
        const near0 = Math.abs(d0) <= attach, near1 = Math.abs(d1) <= attach;
        const crosses = (d0 < -attach && d1 > attach) || (d1 < -attach && d0 > attach);
        if (!near0 && !near1 && !crosses) continue;
        const tm = ((C.p0[0] + C.p1[0]) / 2) * dx + ((C.p0[1] + C.p1[1]) / 2) * dy;
        if (tm < t0 - margin || tm > t1 + margin) continue;
        if (hasParallelPartner(C, null)) continue;
        for (const m of C.members) soft[m] = 1;
      }
    }
  }
  return { soft, runs: hits };
}

/** Strokes belonging to a dimension string — run, witnesses, ticks — are
 *  annotation, not boundary. Same contract as classifyHatchSegs /
 *  classifyOffsetAnnotationSegs: one byte per segment, 1 = soft, pure, total,
 *  never throws. `ftPx` is mask px per foot; the caller gates on scale. */
export function classifyDimensionStringSegs(segs: number[], meta: Uint8Array, ws: number, ftPx: number, dimTexts?: DimTextMark[] | null): Uint8Array {
  return sweepDimensionStrings(segs, meta, ws, ftPx, undefined, dimTexts).soft;
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
// Soft cells plotted from DIMENSION-STRING ink additionally carry bit 16
// (#320): the dim classifier is a conjunction of measured gates (ticked sparse
// junctions, isolation, corner rejection), far higher precision than the hatch
// rhythm heuristic — and a dimension line is never a scope boundary, so an
// escalation crossing predominantly-dim soft ink may be trusted past the
// grow-but-verify cap (see sealedEscalation). Rides only on soft (bit 2)
// cells; a cell also crossed by hard ink keeps hard's verdict as always.
export const MASK_DIMSTR_BIT = 16;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim?: number, meta?: Uint8Array | null, pxPerFt?: number, basePxPerFt?: number, page?: MaskPage | null, roles?: Uint8Array | null, ink?: InkContext | null): MaskObj;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim?: number, meta?: Uint8Array | null, roles?: Uint8Array | null): MaskObj;
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim = MASK_MAX_DIM, meta: Uint8Array | null = null, pxPerFt: number | Uint8Array | null = 0, basePxPerFt = 0, page: MaskPage | null = null, roles: Uint8Array | null = null, ink: InkContext | null = null): MaskObj {
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
  // Second, independent contributor to the SAME soft plane: inset annotation
  // rings (section 2c). Feet-true only — every threshold it uses is a physical
  // distance, and guessing them in raw mask px on a sheet of unknown scale
  // would soften linework on no evidence at all. Unioned, never subtracted: a
  // stroke either classifier calls non-boundary is soft, and the escalation
  // ladder decides what that is worth.
  const annot = meta && mppf > 0
    ? classifyOffsetAnnotationSegs(segs, meta, ws, ANNOT_OFFSET_MAX_FT * mppf, ANNOT_OFFSET_MIN_FT * mppf, ANNOT_MIN_LEN_FT * mppf)
    : null;
  if (soft && annot) for (let i = 0; i < soft.length; i++) if (annot[i]) soft[i] = 1;
  // Third contributor to the SAME soft plane: finish texture (section 2d).
  // Feet-true and subpath-fed — it reads what the ink IS, where the two above
  // infer it from neighbourhood geometry. Unioned, never subtracted.
  const fleck = meta && mppf > 0 && ink?.subpaths ? classifyFleckSegs(segs, meta, ink.subpaths, ws, mppf) : null;
  if (soft && fleck) for (let i = 0; i < soft.length; i++) if (fleck[i]) soft[i] = 1;
  // Fifth contributor, beside the flecks: stroke texture (section 2d′) — the
  // stipple whose strokes are too long to be flecks and too many, at too many
  // angles, to be drawing. Unioned, never subtracted.
  const strokeTex = meta && mppf > 0 && ink?.subpaths ? classifyStrokeTextureSegs(segs, meta, ink.subpaths, ws, mppf) : null;
  if (soft && strokeTex) for (let i = 0; i < soft.length; i++) if (strokeTex[i]) soft[i] = 1;
  // Fourth contributor: label boxes (section 2e). Also subpath-fed, and the
  // first classifier to read the TEXT layer — what a box is FOR is a fact the
  // linework cannot state.
  const tagbox = meta && mppf > 0 && ink?.subpaths && ink?.texts
    ? classifyTagBoxSegs(segs, meta, ink.subpaths, ink.texts, ws, mppf) : null;
  if (soft && tagbox) for (let i = 0; i < soft.length; i++) if (tagbox[i]) soft[i] = 1;
  // Third independent contributor to the SAME soft plane: dimension strings
  // (section 2d, issue #320). Feet-true only, for the same reason as the
  // annotation classifier above; unioned, never subtracted.
  const dimstr = meta && mppf > 0 ? classifyDimensionStringSegs(segs, meta, ws, mppf, ink?.dimTexts || null) : null;
  if (soft && dimstr) for (let i = 0; i < soft.length; i++) if (dimstr[i]) soft[i] = 1;
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
    if (v === 2 && dimstr && dimstr[si]) v |= MASK_DIMSTR_BIT;
    if (v === 1 && meta && (meta[si] & SEG_CURVE)) v = 1 | MASK_CURVE_BIT;
    if ((v & MASK_CURVE_BIT) && noDoor && noDoor[si]) v |= MASK_NODOOR_BIT;
    if ((v & 2) && !(v & 1)) softCount++;   // dim-soft cells carry bit 16 beside bit 2
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
/** Exported for the door-arc tests and diagnostics — see doorArcs.test.ts. */
export function boundaryCurveClusters(mo: MaskObj, region: Uint8Array): number[][] {
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

// ── separating two doors that the bridge glued together (in-swing wedges) ────
// The 3-cell bridge above exists so a DASHED arc stays one cluster, and it has
// to stay. But two doors meeting near a corner — a patient room's own door and
// its toilet's, hinged a couple of feet apart — come within three cells of each
// other too, and then one cluster holds two arcs. Every consequence of that is
// bad, and they compound:
//   • arcClusterFit puts ONE circle through both, so the fit is garbage
//     (measured on demo/sample-finish-plan.pdf, patient room 138: 120 cells,
//     241° sweep, rms 10.35, good=false, where a clean single door reads ~40
//     cells / 89° / rms 0.31);
//   • good=false drops doorLikeness from 8.0 to 1.0, so a real pair of doors
//     ranks below anything with a clean fit and can lose the budget entirely;
//   • good=false also takes wedgeAllowance's fallback branch, which is far
//     LOOSER than either door deserves;
//   • and the retry opens both arcs at once, so the re-flood has two openings
//     to get through and the seal ladder has to close both or nothing is
//     annexed. Room 138 measured 159.4 SF against 190–228 for its neighbours —
//     its own swing sector, cut off by the leaf, never came back.
//
// The cure is to split ONLY what fails the fit, and then to put back together
// whatever the split shouldn't have separated. A dashed arc's pieces all lie on
// the SAME circle, so re-fitting each piece and re-merging pieces whose centre
// and radius agree reconstructs it exactly; two doors have centres feet apart
// and stay separate. A cluster that already fits one circle is returned
// untouched, so this is a no-op everywhere the fit was fine (rooms 137 and 140
// re-cluster to a single part and are bit-identical).
const SPLIT_GAP = 1;                       // Chebyshev gap for the re-split — tight enough to part two arcs
const SPLIT_MIN_SEED = 8;                  // cells: below this a circle fit means nothing, so a piece can't seed a group
export const SAME_ARC_CENTRE_FT = 0.5;     // two pieces of ONE arc share a hinge to within this
export const SAME_ARC_RADIUS_FRAC = 0.15;  // ...and a radius to within this fraction

/** Split a cluster that does not fit one circle into its constituent arcs,
 *  re-merging pieces that share a circle (a dashed arc). Returns the original
 *  cluster unchanged when it already fits, when it cannot be parted, or when
 *  the split explains less than the whole — nothing is ever dropped. */
export function splitMergedArcs(cl: number[], mw: number, mask: Uint8Array, mppf: number): number[][] {
  if (cl.length < 2 * SPLIT_MIN_SEED) return [cl];
  if (arcClusterFit(cl, mw, mask).good) return [cl];
  // connected components at the tight gap
  const set = new Set(cl);
  const seen = new Set<number>();
  const parts: number[][] = [];
  for (const start of cl) {
    if (seen.has(start)) continue;
    seen.add(start);
    const comp = [start];
    const stack = [start];
    while (stack.length) {
      const i = stack.pop() as number;
      const y = (i / mw) | 0, x = i - y * mw;
      for (let dy = -SPLIT_GAP; dy <= SPLIT_GAP; dy++) {
        for (let dx = -SPLIT_GAP; dx <= SPLIT_GAP; dx++) {
          if (!dx && !dy) continue;
          const j = (y + dy) * mw + (x + dx);
          if (set.has(j) && !seen.has(j)) { seen.add(j); comp.push(j); stack.push(j); }
        }
      }
    }
    parts.push(comp);
  }
  if (parts.length < 2) return [cl];
  // group pieces by the circle they sit on — this is what puts a dashed arc
  // back together. Only pieces big enough for a fit to mean anything may open
  // a group; the rest ride along with the nearest group that claims them, and
  // anything unclaimed goes back as its own cluster rather than being lost.
  const centreTol = mppf > 0 ? Math.max(2, SAME_ARC_CENTRE_FT * mppf) : 4;
  const groups: Array<{ cx: number; cy: number; r: number; cells: number[] }> = [];
  const orphans: number[] = [];
  for (const p of parts.slice().sort((a, b) => b.length - a.length)) {
    const f = p.length >= SPLIT_MIN_SEED ? arcClusterFit(p, mw, mask) : null;
    const claim = f && f.good
      ? groups.find((gp) => Math.hypot(gp.cx - f.cx, gp.cy - f.cy) <= centreTol
          && Math.abs(gp.r - f.r) <= SAME_ARC_RADIUS_FRAC * Math.max(gp.r, f.r))
      : undefined;
    if (claim) { claim.cells.push(...p); continue; }
    if (f && f.good) { groups.push({ cx: f.cx, cy: f.cy, r: f.r, cells: p.slice() }); continue; }
    orphans.push(...p);
  }
  // Fewer than two explained arcs means the split found no real separation —
  // keep the original so a genuinely messy cluster (a cloud, curved millwork)
  // is judged exactly as it was, not shattered into fragments that each look
  // door-sized.
  if (groups.length < 2) return [cl];
  const out = groups.map((gp) => gp.cells);
  if (orphans.length) out.push(orphans);
  return out;
}

// ── the IN-SWING sector, and why opening the arc could never reach it ────────
// A drawn door is two marks: the LEAF (a straight double line from the hinge to
// where the panel stands open) and the ARC (the swept edge, hinge-centred,
// running from the leaf's tip round to the closed jamb). The sector between
// them is floor — flooring runs under a door — and which mark separates it from
// the room depends entirely on which way the door swings:
//
//   OUT-swing — leaf and sector are on the CORRIDOR side. The room's boundary
//     at the doorway is the opening itself, and the ARC is what closes it.
//     Opening the arc and re-flooding re-measures the room to the wall. This is
//     what the retry has always done, and it works.
//
//   IN-swing — leaf and sector are INSIDE the room. The room's boundary at the
//     doorway is the LEAF. The arc is on the far side of the sector, closing it
//     off from the corridor. Opening the arc lets the room out toward the
//     corridor; it does not, and cannot, reach the sector, because the leaf
//     still stands between them. Every in-swing door on a plan therefore lost
//     its sector no matter how the cluster ranked — measured on
//     demo/sample-finish-plan.pdf, patient room 138 read 159.4 SF against
//     190–228 for its neighbours.
//
// So the in-swing retry opens the LEAF and leaves the arc hard. That is not
// just the correct mark, it is the SAFE one: with the arc still standing, the
// sector is completely enclosed by leaf-gone + arc + jamb, so the re-flood can
// gain the sector and nothing else. There is no opening for it to escape
// through and no dilation needed to close one. On an out-swing door the leaf is
// not on the room's boundary at all, so opening it changes nothing — the arc is
// still there sealing the doorway — which is exactly the "don't disturb what
// already works" property this needs.
export const LEAF_MIN_SECTOR_FRAC = 0.15;  // a leaf wedge must recover at least this much of the fitted sector, or it is a crack not a door
export const LEAF_MIN_COVER = 0.55;   // fraction of the ray that must actually be inked for it to be a leaf
/** A door panel SPANS THE RADIUS IT SWEPT. The mark `doorLeafCells` returns is
 *  the hard ink within LEAF_HALF_FT of a radius segment, so a real panel —
 *  drawn as two parallel strokes down the full radius — comes back at roughly
 *  2r cells. A mark SHORTER than r never swept that arc.
 *
 *  WHY THIS EXISTS. #191 opens a door's leaf as its own flood opening, on the
 *  reasoning that the in-swing sector is enclosed by leaf-gone + arc + jamb so
 *  the re-flood "gains the sector and nothing else", and that on an out-swing
 *  door "the leaf is not on the room's boundary, so opening it changes
 *  nothing". Both statements are about a LEAF. Neither holds for what the ray
 *  finder returns on a DOUBLE door: two leaves fit ONE circle whose sweep is
 *  ~180 degrees, and the extreme angles of that sweep point at the two JAMBS
 *  rather than at a panel tip, so the ray lands along the WALL and comes back
 *  as a short stub of it. Opening that stub punches a hole in the room's own
 *  wall; the re-flood then walks out through the doorway and annexes the swing
 *  sector on the FAR side — floor belonging to the space the doors swing into.
 *  Both spaces then report it, and an estimator who clicks both buys it twice.
 *  On the bundled VA finish plan that is PATIENT ROOM 158 taking 16.18 SF of
 *  CORRIDOR CE-5, which the corridor also reports (mcp/test/overlap.test.ts).
 *
 *  Measured, not fitted: across the demo plan and five real GC finish plans
 *  (Crunch Mishawaka, Planet Fitness New Castle, Ulta Bowling Green, VEG
 *  Greenwood, Spot Freight Indy) every one of the 91 ACCEPTED leaf wedges spans
 *  at least 1.17 r; the room-158 wall stub spans 0.90 r. The rule states the
 *  physical fact — the panel reaches the arc — and 1.0 sits clear of both. */
export const LEAF_MIN_SPAN_R = 1.0;
/** Half-thickness of a drawn door leaf. FEET-TRUE, like every other physical
 *  threshold in this file: a leaf is a panel drawn as a thin rectangle — two
 *  parallel strokes a few inches apart — and at 1.5 mask px the outer stroke
 *  survived the opening, so the barrier held and every retry reported "no
 *  growth" with the leaf apparently opened. 0.3 ft = 3.6in covers a 1.75in
 *  panel plus its line weight either side. The px floor is the raster-honesty
 *  fallback when the sheet scale is unknown. */
export const LEAF_HALF_FT = 0.3;
const LEAF_HALF_FLOOR_PX = 1.5;
const LEAF_T0 = 0.2, LEAF_T1 = 0.95;  // sample the ray between these fractions of r (skip the hinge knuckle and the tip)

/** The door leaf belonging to an arc cluster: the hard, NON-curve ink lying
 *  along a radius of the fitted circle at one end of the arc's sweep. Returns
 *  null when neither end carries a leaf (an out-swing door seen from the
 *  corridor, a curved wall, a cloud scallop) — the caller then has nothing to
 *  open and behaves exactly as before. */
export function doorLeafCells(fit: ArcClusterFit, cl: number[], mw: number, mh: number, mask: Uint8Array, mppf = 0): number[] | null {
  if (!fit.good || !(fit.r > 2)) return null;
  const LEAF_HALF_W = mppf > 0 ? Math.max(LEAF_HALF_FLOOR_PX, LEAF_HALF_FT * mppf) : LEAF_HALF_FLOOR_PX;
  // the arc's own extreme angles about the fitted hinge — the leaf stands at
  // one of them (unwrapped the same way arcClusterFit measures its sweep)
  const angs = cl.map((i) => Math.atan2(((i / mw) | 0) - fit.cy, (i % mw) - fit.cx)).sort((a, b) => a - b);
  if (angs.length < 2) return null;
  let gapAt = -1, gapMax = angs[0] + 2 * Math.PI - angs[angs.length - 1];
  for (let k = 1; k < angs.length; k++) { const gp = angs[k] - angs[k - 1]; if (gp > gapMax) { gapMax = gp; gapAt = k; } }
  const ends = gapAt < 0 ? [angs[0], angs[angs.length - 1]] : [angs[gapAt], angs[gapAt - 1]];
  let best: number[] | null = null, bestCover = LEAF_MIN_COVER;
  for (const th of ends) {
    const ux = Math.cos(th), uy = Math.sin(th);
    const ax = fit.cx + ux * fit.r * LEAF_T0, ay = fit.cy + uy * fit.r * LEAF_T0;
    const bx = fit.cx + ux * fit.r * LEAF_T1, by = fit.cy + uy * fit.r * LEAF_T1;
    // SWEEP THE BOX, don't sample the ray. Sampling leaves gaps: a barrier is
    // 8-connected, so a single cell missed anywhere along the leaf still blocks
    // the 4-connected fill and the retry reports no growth with the leaf
    // apparently opened. (Measured: room 138's leaves opened as dotted lines
    // and every retry came back "no growth".) Taking every hard cell within
    // LEAF_HALF_W of the SEGMENT is contiguous by construction.
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - LEAF_HALF_W - 1));
    const x1 = Math.min(mw - 1, Math.ceil(Math.max(ax, bx) + LEAF_HALF_W + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - LEAF_HALF_W - 1));
    const y1 = Math.min(mh - 1, Math.ceil(Math.max(ay, by) + LEAF_HALF_W + 1));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) continue;
    const cells: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let t = ((x - ax) * dx + (y - ay) * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - x, ey = ay + t * dy - y;
        if (ex * ex + ey * ey > LEAF_HALF_W * LEAF_HALF_W) continue;
        const i = y * mw + x;
        // the leaf is STRAIGHT ink: curve cells belong to the arc (or to a
        // second door) and must stay hard, or the retry re-opens the doorway
        if ((mask[i] & 1) && !(mask[i] & MASK_CURVE_BIT)) cells.push(i);
      }
    }
    // coverage is still measured ALONG the ray — "is there a leaf here at all"
    // is a question about the line, not about how many cells a band contains
    let hit = 0, tries = 0;
    for (let t = 0; t <= 1; t += 0.02) {
      tries++;
      const px = ax + t * dx, py = ay + t * dy;
      let inked = false;
      for (let o = -LEAF_HALF_W; o <= LEAF_HALF_W && !inked; o += 0.5) {
        const x = Math.round(px - (dy / Math.sqrt(L2)) * o), y = Math.round(py + (dx / Math.sqrt(L2)) * o);
        if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
        const i = y * mw + x;
        if ((mask[i] & 1) && !(mask[i] & MASK_CURVE_BIT)) inked = true;
      }
      if (inked) hit++;
    }
    const cover = tries ? hit / tries : 0;
    if (cover > bestCover && cells.length) { bestCover = cover; best = cells; }
  }
  return best && best.length ? best : null;
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
export function wedgeAllowance(fit: ArcClusterFit, mppf: number, wedgeCapPx: number, leafFound = false): number {
  if (fit.noDoorFrac > 0.5 && !fit.good) return 0;
  const rMax = leafFound ? DOOR_R_LEAF_MAX_FT : DOOR_R_MAX_FT;
  if (fit.good && mppf > 0 && fit.r / mppf > rMax) return 0;
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
/** Exported for the door-arc tests and diagnostics — see doorArcs.test.ts. */
export function doorLikeness(fit: ArcClusterFit, mppf: number, leafFound = false): number {
  let s = 1 - fit.noDoorFrac;
  const swDeg = (fit.sweep * 180) / Math.PI;
  if (fit.good) {
    s += 1;
    // the band widens with the allowance's, or a wide door would keep its
    // allowance and then lose the finite budget to narrower neighbours
    const rMax = leafFound ? DOOR_R_LEAF_MAX_FT : DOOR_R_MAX_FT;
    if (mppf > 0 && fit.r / mppf >= DOOR_R_MIN_FT && fit.r / mppf <= rMax) s += 4;
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
  // Region-level dim merge (#320). A room chopped by an interior dimension
  // string floods as several pieces, each a perfectly good STRICT region whose
  // shared boundary is dim-classified soft ink (mask bit 16). Flood-level
  // escalation cannot heal this reliably: soft-transparent passes exit through
  // the door openings the softened witness lines used to plug (measured), and
  // dilated rungs swallow more area than the merge gains on tiny rooms. So
  // merge at the REGION level instead: for every dim cell on the region's rim,
  // strict-flood the far side; a far side that comes back bounded is the same
  // floor (a dimension line never bounds scope) and unions in — one that
  // leaks simply doesn't merge, so this can never turn a bounded click into a
  // leak. The union is re-connected by BFS over region + dim ink, which keeps
  // it one 4-connected component whose traced ring rides real walls. Pieces
  // are strict floods, so the result is symmetric: clicking any side of the
  // chop yields the same union. The room-size cap still stands.
  const mergeAcrossDimStrings = (ref: FloodResult & { status: "ok" }): FloodResult | null => {
    if (!mo.softCount) return null;
    const { mw, mh, mask, ws } = mo;
    const isDim = (i: number): boolean => (mask[i] & MASK_DIMSTR_BIT) !== 0 && (mask[i] & 1) === 0;
    const capCells = mw * mh * SEAL_MAX_SHEET_FRAC;
    const box = boxOf(ref.region, mw, mh);
    // rim scan: dim cells adjacent to the region, and their open far sides
    const region = ref.region.slice();
    let count = ref.count, mergedPieces = 0;
    const tried = new Set<number>();
    let frontier = true;
    for (let pass = 0; pass < 8 && frontier; pass++) {
      frontier = false;
      const b = { x0: Math.max(1, box.x0 - 2), y0: Math.max(1, box.y0 - 2), x1: Math.min(mw - 2, box.x1 + 2), y1: Math.min(mh - 2, box.y1 + 2) };
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
        const i = y * mw + x;
        if (!isDim(i)) continue;
        if (!(region[i - 1] || region[i + 1] || region[i - mw] || region[i + mw])) continue;
        for (const o of [-1, 1, -mw, mw]) {
          // walk across the (possibly 2-cell-thick) dim stroke to open floor
          let j = i + o, steps = 0;
          while (steps++ < 3 && isDim(j)) j += o;
          if (region[j] || (mask[j] & 3) || tried.has(j)) continue;
          tried.add(j);
          const jx = j % mw, jy = (j / mw) | 0;
          const fr = floodPass(mo, (jx + 0.5) / ws, (jy + 0.5) / ws, 3);
          if (fr.status !== "ok") continue;
          if (count + fr.count > capCells) continue;
          // a piece bounded MOSTLY by dim ink is a sliver of the exterior
          // dimension band (stacked strings wall it on both long sides), not
          // room floor — an interior chop piece is mostly wall-bounded
          // (measured: ~50% dim boundary vs ~87% for a band sliver)
          {
            const fb = boxOf(fr.region, mw, mh);
            let bAll = 0, bDim = 0, bCurve = 0;
            for (let yy = Math.max(1, fb.y0); yy <= Math.min(mh - 2, fb.y1); yy++) for (let xx = Math.max(1, fb.x0); xx <= Math.min(mw - 2, fb.x1); xx++) {
              const k = yy * mw + xx;
              if (!fr.region[k]) continue;
              for (const oo of [-1, 1, -mw, mw]) {
                const mk = mask[k + oo];
                if ((mk & 3) && !fr.region[k + oo]) { bAll++; if (isDim(k + oo)) bDim++; if (mk & MASK_CURVE_BIT) bCurve++; }
              }
            }
            if (bAll && bDim / bAll > DIMSTR_PIECE_MAX_DIMFRAC) continue;
            // a piece bounded appreciably by CURVE ink is a door-swing pocket
            // reached through the witness line plugging its doorway — door
            // zones are the wedge pass's jurisdiction, never the dim merge's
            if (bAll && bCurve / bAll > DIMSTR_PIECE_MAX_CURVEFRAC) continue;
          }
          for (let k = 0; k < region.length; k++) if (fr.region[k] && !region[k]) { region[k] = 1; count++; }
          const fb = boxOf(fr.region, mw, mh);
          box.x0 = Math.min(box.x0, fb.x0); box.y0 = Math.min(box.y0, fb.y0);
          box.x1 = Math.max(box.x1, fb.x1); box.y1 = Math.max(box.y1, fb.y1);
          mergedPieces++; frontier = true;
        }
      }
    }
    if (!mergedPieces) return null;
    // re-connect: BFS from the click over region cells + the dim ink between
    // them — one 4-connected component, dropping anything not actually joined
    const final = new Uint8Array(mw * mh);
    const cx0 = Math.max(0, Math.min(mw - 1, Math.round(ix * ws)));
    const cy0 = Math.max(0, Math.min(mh - 1, Math.round(iy * ws)));
    let s0 = cy0 * mw + cx0;
    if (!region[s0]) {           // click sat on ink; start from any ref cell
      s0 = -1;
      for (let k = 0; k < region.length && s0 < 0; k++) if (ref.region[k]) s0 = k;
      if (s0 < 0) return null;
    }
    const stack = [s0];
    final[s0] = 1;
    let fCount = 0;
    const nb = { x0: mw, y0: mh, x1: 0, y1: 0 };
    while (stack.length) {
      const i = stack.pop() as number;
      fCount++;
      const x = i % mw, y = (i / mw) | 0;
      if (x < nb.x0) nb.x0 = x; if (x > nb.x1) nb.x1 = x;
      if (y < nb.y0) nb.y0 = y; if (y > nb.y1) nb.y1 = y;
      for (const o of [-1, 1, -mw, mw]) {
        const j = i + o;
        if (j < 0 || j >= final.length || final[j]) continue;
        const xj = j % mw;
        if (Math.abs(xj - x) > 1) continue;              // row wrap
        if (region[j] || isDim(j)) { final[j] = 1; stack.push(j); }
      }
    }
    regionBox.set(final, nb);
    return {
      status: "ok", region: final, count: fCount, mw, mh, ws,
      mppf: mo.mppf, hardHits: ref.hardHits, softHits: ref.softHits,
      hatchFiltered: true, hatchTier: "bounded",
    };
  };
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
        return mergeAcrossDimStrings(f) ?? f;   // a subset of a region that already passed both gates
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
  if (base.status === "ok") return mergeAcrossDimStrings(base) ?? base;
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
  let wedges = 0, ringWedges = 0, refused = 0, leafStubs = 0;
  let hatchFiltered = !!r1.hatchFiltered;
  let hatchTier = r1.hatchTier;
  let sealedPx = r1.sealedPx, virtualFrac = r1.virtualFrac;
  let minPassPxOut = r1.minPassPx, minPassDelta = r1.minPassDelta;
  // Judge every cluster as GEOMETRY first (re-fitted circle: radius, sweep,
  // chord-frame extent), then spend the finite wedge budget on the most
  // door-like ones. Ranking, not scanline order: a room ringed with curved
  // millwork used to exhaust the budget before its real doors were reached.
  // Ties break on first-cell index, so the order stays deterministic.
  // Every opening the retry may try, in THREE passes. The passes exist because
  // the wedge budget is shared and the accepted wedges union: an opening tried
  // earlier can spend budget a later one needed, so the only way to add
  // openings without ever taking area away is to run the old ones first,
  // unchanged, and let the new ones have what is left.
  //   pass 0 — the cluster exactly as boundaryCurveClusters found it. Bit-for-
  //            bit what shipped before, and it must stay first: the ward room's
  //            double doors are ONE cluster whose two arcs have to open
  //            TOGETHER for the pair's wedge to be reachable, and offering only
  //            the split pieces cost it 2.21 SF.
  //   pass 1 — the same cluster parted into single arcs (splitMergedArcs), for
  //            the opposite case: two unrelated doors the 3-cell bridge glued
  //            into one unfittable blob.
  //   pass 2 — door LEAVES, the in-swing sector (see doorLeafCells).
  // A cluster that neither splits nor carries a leaf yields exactly one entry,
  // which is why this is a no-op on everything that already worked.
  interface Opening { cl: number[]; fit: ArcClusterFit; allow: number; rank: number; at: number; pass: number; minGrow: number }
  const entry = (cl: number[], pass: number, fit?: ArcClusterFit, leafFound = false): Opening => {
    const f = fit ?? arcClusterFit(cl, mw, mo.mask);
    // A leaf opening must return a SECTOR or nothing. Accepting a few cells
    // is not free: the traced ring is re-contoured and re-snapped around
    // whatever is added, and a sliver can move a corner onto a different
    // vertex and enclose LESS area than before — ward-room gained 5 cells
    // this way and lost 2.21 SF off its ring. A real in-swing sector is a
    // quarter-disc about the hinge; anything under LEAF_MIN_SECTOR_FRAC of
    // that is the retry finding a crack, not a door. Arc openings keep no
    // floor at all, so pass 0 stays bit-identical.
    const ideal = 0.5 * f.r * f.r * f.sweep;
    const allow = wedgeAllowance(f, mo.mppf || 0, wedgeCapPx, leafFound);
    // a clean circular sweep in the door band, refused ONLY by the radius
    // ceiling, is a withheld wedge — count it so the refusal is not silent
    if (!allow && f.good && (mo.mppf || 0) > 0 && f.r / (mo.mppf as number) > (leafFound ? DOOR_R_LEAF_MAX_FT : DOOR_R_MAX_FT)) refused++;
    return {
      cl, fit: f, allow,
      rank: doorLikeness(f, mo.mppf || 0, leafFound), at: cl[0], pass,
      minGrow: pass === 2 ? Math.max(1, Math.round(LEAF_MIN_SECTOR_FRAC * ideal)) : 0,
    };
  };
  const ranked: Opening[] = [];
  for (const cl of clusters) {
    const fit = arcClusterFit(cl, mw, mo.mask);
    const parts = splitMergedArcs(cl, mw, mo.mask, mo.mppf || 0);
    const pieces = parts.length > 1 ? parts : [cl];
    // a leaf per ARC, taken from the parted pieces so a glued pair offers both.
    // Computed BEFORE anything is ranked (#257): a found leaf is what widens
    // the radius ceiling, and it is evidence about the ARC — not about which
    // opening we happen to be trying. Attaching it to the leaf opening alone
    // left the ARC opening (pass 0) refused at DOOR_R_MAX_FT, and pass 0 is the
    // opening that actually recovers an in-swing sector on a wide door: the
    // measured leaf retry came back with NEGATIVE growth (−1469 cells on a
    // 4'-6" leaf), because opening the leaf alone re-opens the doorway and the
    // seal ladder must then dilate hard enough to close it, eroding more of the
    // room than the sector returns. Opening the ARC lets the doorway close at
    // the wall plane instead, which is the whole "doorways UNIFY" design above.
    const leaves = pieces.map((p) => {
      const pf = p === cl ? fit : arcClusterFit(p, mw, mo.mask);
      return { p, pf, leaf: doorLeafCells(pf, p, mw, mh, mo.mask, mo.mppf || 0) };
    });
    const anyLeaf = leaves.some((l) => !!l.leaf);
    ranked.push(entry(cl, 0, fit, anyLeaf));
    if (parts.length > 1) for (const { p, pf, leaf } of leaves) ranked.push(entry(p, 1, pf, !!leaf));
    // Only a mark that SPANS the radius may be opened as a leaf — see
    // LEAF_MIN_SPAN_R. A shorter one is the ray landing on the wall between the
    // two arcs of a double door, and opening it breaches the room. The leaf is
    // still EVIDENCE for the arc either way (`anyLeaf`, above, widens the radius
    // ceiling for #257) — this gates only whether it becomes its own opening.
    for (const { pf, leaf } of leaves) {
      if (!leaf) continue;
      if (leaf.length < LEAF_MIN_SPAN_R * pf.r) { leafStubs++; continue; }
      ranked.push({ ...entry(leaf, 2, pf, true), cl: leaf });
    }
  }
  ranked
    .splice(0, ranked.length, ...ranked
      .filter((c) => c.allow >= 1)
      .sort((a, b) => (a.pass - b.pass) || (b.rank - a.rank) || (a.at - b.at)));
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
  // 2× because a door now contributes up to TWO openings (arc and leaf) and
  // WEDGE_MAX_DOORS counts DOORS — capping entries at 12 would silently halve
  // the ceiling to six doors the moment leaves started being offered.
  for (const { cl, fit, allow: clusterAllowance, minGrow } of ranked.slice(0, 2 * WEDGE_MAX_DOORS)) {
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
    if (growth < minGrow) continue;                  // a leaf must return a SECTOR, not a sliver (see entry())
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
  if (!wedges || !region) {
    if (refused) r1.wedgesRefused = refused;
    if (leafStubs) r1.leafStubsRefused = leafStubs;
    return r1;
  }
  const out: FloodResult & { status: "ok" } = {
    status: "ok", region, count, mw, mh, ws: r1.ws, mppf: r1.mppf,
    hardHits: r1.hardHits, softHits: r1.softHits,
    hatchFiltered: hatchFiltered || undefined, hatchTier, sealedPx, virtualFrac,
    minPassPx: minPassPxOut, minPassDelta,
    ...(ringWedges ? { ringWedges } : {}),
    ...(refused ? { wedgesRefused: refused } : {}),
    ...(leafStubs ? { leafStubsRefused: leafStubs } : {}),
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
export function rdpOpen(pts: Point[], eps: number): Point[] {
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
