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
// walls plot bit 1, segments classified as hatch (regular runs of overlapping
// parallel rows — classifyHatchSegs) plot bit 2 — plus an escalating flood:
// the primary pass treats both as barrier (bit-identical to the original), and
// when it comes back trapped (tiny/boundary), predominantly hatch-bounded (a
// tile-grid cell), or MODERATELY hatch-bounded (a hatch-lined room — issue #32),
// a second pass re-floods with hatch transparent. The moderate tier is the only
// one bounded: it accepts the re-flood only if the area growth stays within a cap
// (grow-but-verify). If the escalated pass leaks, stays tiny, or balloons, the
// primary result stands — a misclassified wall can never make the tool worse
// than the strict mask.

export type Point = [number, number];
export interface OpList { fnArray: number[]; argsArray: any[]; }  // per-op args array, or null for arg-less ops
/** pdf.js's OPS code table (op name → numeric code); passed in so this module never imports pdfjs. */
export type OpsTable = Record<string, number>;
/** meta: one byte per segment — SEG_* bits + device line width in the high nibble.
 *  imageArea: total placed image area in device px² (scan/photo underlay detection). */
export interface VectorGeometry { points: Point[]; segs: number[]; meta: Uint8Array; imageArea: number; }
export interface MaskObj { mask: Uint8Array; mw: number; mh: number; ws: number; softCount: number; }
export interface RegionResult { region: Uint8Array; mw: number; mh: number; ws: number; count?: number; }
export type FloodResult =
  | { status: "boundary" }
  | { status: "leak" }
  | { status: "tiny"; count: number }
  | { status: "ok"; region: Uint8Array; count: number; mw: number; mh: number; ws: number; hardHits?: number; softHits?: number; hatchFiltered?: boolean };
/** Caller's snap-grid lookup: nearest true endpoint to (x,y) within maxDist, or null. */
export type NearestFn = (x: number, y: number, maxDist: number) => Point | null | undefined;

export const MASK_MAX_DIM = 3000;   // working raster cap (Uint8 ≈ 6–7 MB)
const LEAK_FRACTION = 0.30;         // fill > 30% of the sheet ⇒ not an enclosed space
const TINY_PX = 30;                 // fill < 30 mask px ⇒ landed in dense linework
const MIN_THICK = 4;                // region bbox thinner than 4 mask px ⇒ hatch sliver, not a room
const CURVE_STEPS = 8;              // chords per bezier (door swings stay closed)

// segment meta bits (extractVectorGeometry emits, classifyHatchSegs consumes)
export const SEG_CURVE = 1;         // bezier chord — never classified as hatch (door swings close gaps)
export const SEG_CLIP = 2;          // clip-only path (endPath) — invisible ink, never a wall
export const SEG_FILLONLY = 4;      // filled-not-stroked path (solid poché outlines classify normally)
// meta high nibble = device line width, ceil'd and capped at 15 (0 = hairline)

// hatch classification — a family is many similar-angle rows, regularly pitched,
// stacking tangentially; walls don't do that (see classifyHatchSegs)
export const HATCH_ANGLE_TOL = 2;      // deg — CAD hatch angle jitter is ≪ 1°
export const HATCH_MIN_RUN = 10;       // rows — fewer evenly-spaced parallels is plausibly walls
export const HATCH_MAX_PITCH = 24;     // mask px — keeps room-scale rhythm (demising walls) hard
export const HATCH_PITCH_TOL = 0.35;   // regularity band around the median pitch
export const HATCH_MIN_REGULAR = 0.7;  // fraction of gaps that must sit inside the band
export const HATCH_OVERLAP_FRAC = 0.5; // successive rows must overlap tangentially this much
export const ROW_EPS = 1.5;            // mask px — collinear/dashed pieces merge into one row
export const WIDE_PROTECT_RATIO = 2;   // heavier-pen member of a hairline family stays hard (wall overprint)
export const SPAN_PROTECT_RATIO = 3;   // a row spanning ≫ the run's median row is a wall riding the rhythm, not hatch
export const HATCH_BOUND_FRAC = 0.7;   // ≥ this soft-bounded fraction ⇒ PREDOMINANTLY hatch (tile-grid cell): escalate unbounded
export const HATCH_ESCALATE_FRAC = 0.35; // MODERATE band [this, HATCH_BOUND_FRAC): grow-but-verify escalation (issue #32 — real hatch-lined rooms top out ~0.63, so 0.70 alone never fired). This is the Balanced-preset value; see escalationParams.
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
  [SENS_AGGRESSIVE, 0.20, 4.0],                            // cross more hatch, tolerate more growth
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
      const visit = (p: Point) => { points.push(p); };
      const lineTo = (p: Point) => { if (cur) { segs.push(cur[0], cur[1], p[0], p[1]); metaArr.push(flags); } cur = p; visit(p); };
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
            if (cur) { segs.push(cur[0], cur[1], q[0], q[1]); metaArr.push(flags | SEG_CURVE); }
            cur = q;
          }
          visit(p3);
        }
        else if (op === OPS.closePath) { if (cur && start) { segs.push(cur[0], cur[1], start[0], start[1]); metaArr.push(flags); cur = start; } }
        else if (op === OPS.rectangle) {
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q: Point[] = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); metaArr.push(flags); visit(a); }
          cur = q[0]; start = q[0];
        }
      }
    }
  }
  return { points, segs, meta: Uint8Array.from(metaArr), imageArea };
}

// ── 2. hatch classification ────────────────────────────────────────────────
// A hatch family is what walls never are: MANY same-angle rows (collinear
// pieces merged), REGULARLY pitched at fill scale, each row OVERLAPPING the
// next tangentially (hatch stacks; scattered parallel walls don't). Marks
// suspected hatch segments soft (1). Curve chords are exempt (door swings must
// keep closing gaps); clip-only paths are soft outright (invisible ink). Two
// wall guards inside a family: the EXTREMAL rows stay hard (tile/hatch edges
// coincide with walls), and heavier-pen members stay hard (wall overprint).
interface HatchCand { i: number; ang: number; x1: number; y1: number; x2: number; y2: number; w: number; }
interface HatchRow { d: number; t0: number; t1: number; segs: HatchCand[]; }
export function classifyHatchSegs(segs: number[], meta: Uint8Array, ws: number): Uint8Array {
  const n = segs.length >> 2;
  const soft = new Uint8Array(n);
  if (!meta || !n) return soft;
  const cand: HatchCand[] = [];
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    if (mt & SEG_CURVE) continue;
    if (mt & SEG_CLIP) { soft[i] = 1; continue; }
    // Filled-not-stroked outlines bound SOLID ink (wall poché). Their short
    // 0°/90° edges ride a tile grid's rhythm and would classify as hatch — but
    // making them transparent lets the escalated fill cross a solid black band
    // (the leak that turned hatched-room clicks into "dense linework" guards).
    // Hatch itself is stroked linework, so exempting fills costs nothing.
    if (mt & SEG_FILLONLY) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.75) continue;                    // sub-cell specks can't form rows
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // fold to [0,180): direction-free
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, w: meta[i] >> 4 });
  }
  if (cand.length < HATCH_MIN_RUN) return soft;
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
      for (let k = a + 1; k < b; k++) {                 // extremal rows stay hard
        if (rows[k].t1 - rows[k].t0 > SPAN_PROTECT_RATIO * medSpan) continue;
        for (const s of rows[k].segs)
          if (s.w < WIDE_PROTECT_RATIO * modalW) soft[s.i] = 1;
      }
    };
    for (let k = 1; k < rows.length; k++) {
      const gap = rows[k].d - rows[k - 1].d;
      const ov = Math.min(rows[k].t1, rows[k - 1].t1) - Math.max(rows[k].t0, rows[k - 1].t0);
      const need = HATCH_OVERLAP_FRAC * Math.min(rows[k].t1 - rows[k].t0, rows[k - 1].t1 - rows[k - 1].t0);
      if (gap > HATCH_MAX_PITCH || ov < need) { flushRun(runStart, k - 1); runStart = k; }
    }
    flushRun(runStart, rows.length - 1);
  }
  return soft;
}

// ── 3. boundary mask ───────────────────────────────────────────────────────
// Segments (image px) → Uint8Array raster at ws = maskDim/imageDim. Single-px
// Bresenham; coincident endpoints round to the same cell so chained walls stay
// continuous. Without meta the mask is bit-identical to the original (every
// cell 1). With meta, wall cells carry bit 1 and suspected-hatch cells bit 2 —
// a cell crossed by both keeps bit 1, so hard always wins.
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim = MASK_MAX_DIM, meta: Uint8Array | null = null): MaskObj {
  const ws = Math.min(1, maxDim / Math.max(imgW, imgH, 1));
  const mw = Math.max(2, Math.ceil(imgW * ws)), mh = Math.max(2, Math.ceil(imgH * ws));
  const mask = new Uint8Array(mw * mh);
  const soft = meta ? classifyHatchSegs(segs, meta, ws) : null;
  let softCount = 0;
  for (let i = 0, si = 0; i + 3 < segs.length; i += 4, si++) {
    const v = soft && soft[si] ? 2 : 1;
    if (v === 2) softCount++;
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
  return { mask, mw, mh, ws, softCount };
}

// ── 4. flood fill ──────────────────────────────────────────────────────────
// Scanline fill from an image-px seed. `barrier` picks which mask bits block:
// 3 = walls + hatch (the strict original behavior), 1 = walls only. hardHits/
// softHits count blocking encounters so the caller can tell a wall-bounded
// region from a hatch-bounded one.
function floodPass(maskObj: MaskObj, ix: number, iy: number, barrier: number): FloodResult {
  const { mask, mw, mh, ws } = maskObj;
  let sx = Math.round(ix * ws), sy = Math.round(iy * ws);
  if (sx < 0 || sy < 0 || sx >= mw || sy >= mh) return { status: "boundary" };
  if (mask[sy * mw + sx] & barrier) {
    // nudge: nearest open cell within 3 px (clicks often land on hatch lines)
    let found: Point | null = null;
    for (let r = 1; r <= 3 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = sx + dx, ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && !(mask[ny * mw + nx] & barrier)) { found = [nx, ny]; break; }
      }
    }
    if (!found) return { status: "boundary" };
    sx = found[0]; sy = found[1];
  }
  const region = new Uint8Array(mw * mh);
  const cap = Math.floor(mw * mh * LEAK_FRACTION);
  let count = 0, leaked = false, hardHits = 0, softHits = 0;
  let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
  const stack: number[][] = [[sx, sy]];
  while (stack.length) {
    const popped = stack.pop() as number[];
    const px = popped[0], py = popped[1];
    let x0 = px;
    while (x0 > 0 && !(mask[py * mw + x0 - 1] & barrier) && !region[py * mw + x0 - 1]) x0--;
    if (x0 > 0 && (mask[py * mw + x0 - 1] & barrier)) { if (mask[py * mw + x0 - 1] & 1) hardHits++; else softHits++; }
    let x1 = px;
    while (x1 < mw - 1 && !(mask[py * mw + x1 + 1] & barrier) && !region[py * mw + x1 + 1]) x1++;
    if (x1 < mw - 1 && (mask[py * mw + x1 + 1] & barrier)) { if (mask[py * mw + x1 + 1] & 1) hardHits++; else softHits++; }
    if (x0 === 0 || x1 === mw - 1 || py === 0 || py === mh - 1) leaked = true;
    if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (py < by0) by0 = py; if (py > by1) by1 = py;
    let upOpen = false, downOpen = false;
    for (let x = x0; x <= x1; x++) {
      const idx = py * mw + x;
      if (region[idx]) { upOpen = downOpen = false; continue; }
      region[idx] = 1; count++;
      if (py > 0) {
        const u = idx - mw;
        if (!(mask[u] & barrier) && !region[u]) { if (!upOpen) { stack.push([x, py - 1]); upOpen = true; } }
        else { if (mask[u] & barrier) { if (mask[u] & 1) hardHits++; else softHits++; } upOpen = false; }
      }
      if (py < mh - 1) {
        const d = idx + mw;
        if (!(mask[d] & barrier) && !region[d]) { if (!downOpen) { stack.push([x, py + 1]); downOpen = true; } }
        else { if (mask[d] & barrier) { if (mask[d] & 1) hardHits++; else softHits++; } downOpen = false; }
      }
    }
    if (count > cap) return { status: "leak" };
  }
  if (leaked) return { status: "leak" };
  // hatch/text slivers: plenty of cells but no room-like thickness
  if (count < TINY_PX || bx1 - bx0 + 1 < MIN_THICK || by1 - by0 + 1 < MIN_THICK) return { status: "tiny", count };
  return { status: "ok", region, count, mw, mh, ws, hardHits, softHits };
}

// The escalating fill. Pass 1 is the strict mask (walls + hatch — exactly the
// original behavior; masks with no soft cells never go further). When the strict
// pass is bounded by hatch, re-flood with hatch transparent (pass 2). Three tiers
// keyed off how much of the strict fill's boundary is soft (hatch) vs hard (wall):
//   • trapped (tiny/boundary): strict found no room — escalate UNBOUNDED (any
//     clean re-flood beats nothing).
//   • predominantly soft (≥ HATCH_BOUND_FRAC, e.g. a lone tile-grid cell): the
//     strict fill is a sliver of the real room — escalate UNBOUNDED.
//   • moderate ([HATCH_ESCALATE_FRAC, HATCH_BOUND_FRAC)): where real hatch-lined
//     rooms sit (issue #32 measured max ~0.63, so the 0.70 gate never fired).
//     Escalate GROW-BUT-VERIFY: accept walls-only only if it stays a clean "ok"
//     AND grows the area ≤ HATCH_GROWTH_MAX×. A misclassified wall then either
//     leaks or balloons and is discarded — the escalation can never do worse
//     than the strict pass.
//   • lightly soft (< escalateFrac) or a leak: strict result stands
//     (removing linework only leaks more).
// `sensitivity` (0..1) dials the moderate tier's escalateFrac/growthMax via
// escalationParams; the default is the calibrated Balanced preset.
export function floodRegion(maskObj: MaskObj, ix: number, iy: number, sensitivity: number = SENS_BALANCED): FloodResult {
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
  if (r2.status === "ok" && (r1.status !== "ok" || r2.count <= r1.count * growthCap)) {
    r2.hatchFiltered = true;
    return r2;
  }
  return r1;
}

// ── 5. contour trace + simplify ────────────────────────────────────────────
// Moore-neighbor trace of the region's OUTER boundary, then closed-ring RDP.
// Returns image-px vertices.
export function traceRegion(reg: RegionResult, epsMaskPx = 1.5): Point[] {
  const { region, mw, mh, ws } = reg;
  let s = -1;
  for (let i = 0; i < region.length; i++) if (region[i]) { s = i; break; }
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

// Shoelace in whatever px the ring is in (caller multiplies by upp²).
export function ringArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
