// Roll-goods layout — the packing/nesting/collision engine for fixed-width
// roll materials (broadloom carpet, sheet vinyl, sheet rubber): how many
// strips, where the seams fall, what footage to order. Contributed by
// Michael Hartman; decoupled from any room model — it operates on a polygon
// RING (array of {x,y} in feet) plus an optional hasDoorAtEdge(i) predicate,
// so it stays pure (no React, no DOM) like oneclick/sheets. Canvas wiring
// (cut overlay + roll panel) is tracked as its own issue; this lands the
// engine + tests first. Directions: 'ns' = strips run along world Y (lanes
// tile across X); 'ew' = strips run along world X (lanes tile across Y).

const OVERLAP_EPS_FT = 0.02; // ~1/4in — flush cuts aren't treated as overlapping
export function uid(p = "cut") { return p + Math.random().toString(36).slice(2, 9); }

// The roll-goods material classes. OpenTakeoff conditions are trade-agnostic
// (no flooring-type field), so when the canvas wires up, roll goods will be an
// OPT-IN on a condition (a roll_setup present = roll goods) with one of these
// classes picked for color/defaults — not inferred from a type the app doesn't
// have. The helpers keep the vocabulary in one place for that consumer.
export const ROLL_FLOORING_TYPES = ["carpet", "sheet_vinyl", "rubber"];
export function isRollType(ft) { return ROLL_FLOORING_TYPES.includes(ft); }
// Roll-goods material colors — warm, material-true tones for the cut overlay
// (carpet tan, vinyl/rubber grey) instead of the condition's line-palette color.
export const ROLL_TYPE_COLORS = { carpet: "#c9a876", sheet_vinyl: "#c9ccce", rubber: "#8a8f98" };
export function rollColorForType(ft) { return ROLL_TYPE_COLORS[ft] || "#c9a876"; }

// Sensible starter roll setup for a condition of the given material class.
// price_unit is the UNIT the material sells in (sy/sf/lf) — a unit, never a
// dollar. No price field lives here: OpenTakeoff's stored takeoff is
// quantities-only, and roll_setup would ride the condition into exports.
export function defaultRollSetup(ft) {
  return { roll_width_ft: 12, roll_length_ft: 0, seam_allowance_in: 2, wall_overage_in: 3, doorway_overage_in: 1, direction: "auto", price_unit: ft === "carpet" ? "sy" : "sf" };
}
// Figured roll quantity for a price unit, given order footage (lf of full-width roll).
export function rollQtyForUnit(orderFt, rollWidthFt, unit) {
  const w = rollWidthFt || 12;
  if (unit === "lf") return orderFt;
  if (unit === "sf") return orderFt * w;
  return (orderFt * w) / 9; // sy
}

// ── lane capacity / count (all inches) ──────────────────────────────────────
export function laneCapacityIn(n, i, rollWidthIn, seamIn, wallIn) {
  if (n === 1) return rollWidthIn - 2 * wallIn;
  const isEdge = (i === 0 || i === n - 1);
  return isEdge ? (rollWidthIn - seamIn - wallIn) : (rollWidthIn - 2 * seamIn);
}
export function totalCapacityIn(n, rollWidthIn, seamIn, wallIn) {
  let sum = 0; for (let i = 0; i < n; i++) sum += laneCapacityIn(n, i, rollWidthIn, seamIn, wallIn);
  return sum;
}
export function computeLaneCount(widthIn, rollWidthIn, seamIn, wallIn) {
  for (let n = 1; n <= 40; n++) if (totalCapacityIn(n, rollWidthIn, seamIn, wallIn) >= widthIn - 1e-6) return n;
  return 40;
}

// ── scanline run-extent over an arbitrary (possibly concave) ring ────────────
function scanlineCrossings(ring, laneAxis, runAxis, v) {
  const n = ring.length, vals = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const av = a[laneAxis], bv = b[laneAxis];
    if ((av <= v && bv > v) || (bv <= v && av > v)) {
      const t = (v - av) / (bv - av);
      vals.push({ val: a[runAxis] + t * (b[runAxis] - a[runAxis]), edgeIndex: i });
    }
  }
  vals.sort((p, q) => p.val - q.val);
  return vals;
}
function laneSampleAxisValues(ring, laneAxis, lo, hi) {
  const eps = 1e-6;
  const vs = [Math.min(lo + eps, hi), Math.max(hi - eps, lo)];
  ring.forEach((p) => { if (p[laneAxis] > lo + eps && p[laneAxis] < hi - eps) vs.push(p[laneAxis]); });
  return vs;
}
export function computeLaneRunExtent(ring, laneAxis, lo, hi) {
  const runAxis = laneAxis === "x" ? "y" : "x";
  const samples = laneSampleAxisValues(ring, laneAxis, lo, hi);
  let best = null, bestMax = null;
  samples.forEach((v) => {
    const crossings = scanlineCrossings(ring, laneAxis, runAxis, v);
    if (!crossings.length) return;
    const first = crossings[0], last = crossings[crossings.length - 1];
    if (!best || first.val < best.val) best = first;
    if (!bestMax || last.val > bestMax.val) bestMax = last;
  });
  if (!best) return null;
  return { min: best.val, minEdgeIndex: best.edgeIndex, max: bestMax.val, maxEdgeIndex: bestMax.edgeIndex };
}

// ── render-only slab clip (true footprint within a lane) ─────────────────────
function intersectAxisRender(a, b, axis, bound) {
  const other = axis === "x" ? "y" : "x";
  const da = b[axis] - a[axis];
  const t = Math.abs(da) < 1e-12 ? 0 : (bound - a[axis]) / da;
  const ct = Math.max(0, Math.min(1, t));
  const pt = {}; pt[axis] = bound; pt[other] = a[other] + ct * (b[other] - a[other]);
  return pt;
}
function clipHalf(poly, axis, bound, keepGE) {
  const n = poly.length; if (n === 0) return [];
  const keep = (p) => keepGE ? (p[axis] >= bound - 1e-9) : (p[axis] <= bound + 1e-9);
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = poly[i], prev = poly[(i - 1 + n) % n];
    const curIn = keep(cur), prevIn = keep(prev);
    if (curIn) { if (!prevIn) out.push(intersectAxisRender(prev, cur, axis, bound)); out.push(cur); }
    else if (prevIn) out.push(intersectAxisRender(prev, cur, axis, bound));
  }
  return out;
}
export function clipRingToLaneSlab(ring, laneAxis, lo, hi) {
  return clipHalf(clipHalf(ring, laneAxis, lo, true), laneAxis, hi, false);
}

// ── one item's strips in a direction ─────────────────────────────────────────
// item: { id, name, ring:[{x,y}...], hasDoorAtEdge?:(edgeIndex)=>bool }
// config: { rollWidthFt, seamAllowanceIn, wallOverageIn, doorwayOverageIn }
export function layoutRingStrips(item, direction, config) {
  const ring = item.ring;
  if (!ring || ring.length < 3) return [];
  const laneAxis = direction === "ns" ? "x" : "y";
  let lo = Infinity, hi = -Infinity;
  ring.forEach((p) => { lo = Math.min(lo, p[laneAxis]); hi = Math.max(hi, p[laneAxis]); });
  const widthFt = hi - lo;
  if (!(widthFt > 0)) return [];
  const rollWidthIn = config.rollWidthFt * 12;
  const n = computeLaneCount(widthFt * 12, rollWidthIn, config.seamAllowanceIn, config.wallOverageIn);
  // Lane widths reflect the REAL roll-width strips (so cuts draw to scale by
  // width): each lane fills to its usable capacity — roll width minus seam/wall
  // losses — and the LAST lane takes the remainder. (Not an even room/n split,
  // which would make a full 12-ft strip render narrower than the roll.)
  const laneWidthsFt = [];
  let remaining = widthFt;
  for (let i = 0; i < n; i++) {
    const capFt = laneCapacityIn(n, i, rollWidthIn, config.seamAllowanceIn, config.wallOverageIn) / 12;
    const w = i === n - 1 ? Math.max(0, remaining) : Math.min(capFt, remaining);
    laneWidthsFt.push(w); remaining -= w;
  }
  const hasDoor = item.hasDoorAtEdge || (() => false);
  const wallOverageFt = config.wallOverageIn / 12;
  const seamFt = config.seamAllowanceIn / 12;
  const doorwayOverageFt = (config.doorwayOverageIn != null ? config.doorwayOverageIn : config.wallOverageIn) / 12;
  // Doors on the SIDE walls (parallel to the run — the lane-axis boundaries at lo/hi):
  // a door there means the outermost lane on that side runs THROUGH the opening, so
  // its side edge gets the doorway overage too — this is how doorways matter
  // regardless of run direction, not just on the run-end walls.
  let lowSideDoor = false, highSideDoor = false;
  for (let e = 0; e < ring.length; e++) {
    const A = ring[e], B = ring[(e + 1) % ring.length];
    if (Math.abs(A[laneAxis] - lo) < 1e-6 && Math.abs(B[laneAxis] - lo) < 1e-6 && hasDoor(e)) lowSideDoor = true;
    if (Math.abs(A[laneAxis] - hi) < 1e-6 && Math.abs(B[laneAxis] - hi) < 1e-6 && hasDoor(e)) highSideDoor = true;
  }
  const strips = [];
  let cursor = lo;
  for (let i = 0; i < n; i++) {
    const laneLo = cursor, laneHi = cursor + laneWidthsFt[i]; cursor = laneHi; // COVERAGE slab (room area this lane covers)
    const ext = computeLaneRunExtent(ring, laneAxis, laneLo, laneHi);
    if (!ext) continue;
    // Every run-end gets the wall overage; a run-end landing on a doorway gets the
    // doorway overage ADDED on top (extra material to carry through the opening).
    const minDoor = hasDoor(ext.minEdgeIndex), maxDoor = hasDoor(ext.maxEdgeIndex);
    const minOverageFt = wallOverageFt + (minDoor ? doorwayOverageFt : 0);
    const maxOverageFt = wallOverageFt + (maxDoor ? doorwayOverageFt : 0);
    const runMin = ext.min - minOverageFt, runMax = ext.max + maxOverageFt;
    // PHYSICAL cut piece: expand the coverage slab outward by the real allowances —
    // wall overage on a lane edge that meets a side wall (the outer lanes), seam
    // allowance on an edge shared with the neighbouring lane. So a full lane draws
    // at the true roll width, overlaps its neighbour by the seam, and tucks past the
    // walls; adjacent physical pieces overlapping is exactly the visible seam.
    const laneLowDoor = i === 0 && lowSideDoor;      // this lane's low side runs into a doorway
    const laneHighDoor = i === n - 1 && highSideDoor; // this lane's high side runs into a doorway
    const lowExpand = (i === 0 ? wallOverageFt : seamFt) + (laneLowDoor ? doorwayOverageFt : 0);
    const highExpand = (i === n - 1 ? wallOverageFt : seamFt) + (laneHighDoor ? doorwayOverageFt : 0);
    strips.push({
      // STABLE id (srcId + lane) so manual per-cut overrides can be re-associated
      // across recomputes; unique within a layout since srcId is unique per item.
      id: `${item.id}:${i}`, srcId: item.id, label: item.name || "", laneIndex: i, laneCount: n, laneAxis,
      laneMin: laneLo - lowExpand, laneMax: laneHi + highExpand, // physical piece width (incl. seam/wall/door)
      coverMin: laneLo, coverMax: laneHi,                        // room-coverage slab (no allowances)
      runMin, runMax, autoRunMin: runMin, autoRunMax: runMax,
      minOverageFt, maxOverageFt, minDoor, maxDoor, laneLowDoor, laneHighDoor, doorwayOverageFt, seamFt, rollWidthFt: config.rollWidthFt,
    });
  }
  return strips;
}
export function sumStripLengthsFt(strips) { return strips.reduce((s, st) => s + Math.max(0, st.runMax - st.runMin), 0); }

// ── skyline bottom-left nesting (default / reset placement) ──────────────────
// seqById (optional): { [stripId]: number } — a MANUAL order the estimator chose.
// Cuts with a seq pack first, in that order; the rest fall back to the default
// widest-then-longest rule. Packing in sequence keeps the layout overlap-free
// (the skyline never double-places), so reordering always yields a clean roll.
// rollLenFt (optional, 0 = unlimited): the MAX usable length of one physical roll.
// When set, cuts pack across multiple rolls — when a roll fills up lengthwise a
// fresh roll opens; rolls are stacked end-to-end along the length axis (roll k
// occupies cutX ∈ [k·rollLenFt, (k+1)·rollLenFt)). A cut longer than a whole roll
// can't be produced from one and is flagged `overRoll`. Each strip gets rollIndex.
export function assignDefaultCutPositions(strips, rollWidthFt, seqById, rollLenFt = 0) {
  const EPS = 1e-6;
  const L = rollLenFt > 0 ? rollLenFt : Infinity; // usable length per roll
  const laneW = (s) => s.laneMax - s.laneMin;
  const lenX = (s) => Math.max(0, s.runMax - s.runMin);
  const makeRoll = () => ({ sky: [{ y: 0, width: rollWidthFt, x: 0 }] });
  function findSpot(roll, lw, cutLen) {
    const sky = roll.sky; let best = null;
    for (let i = 0; i < sky.length; i++) {
      const y = sky[i].y;
      if (y + lw > rollWidthFt + EPS) continue;
      let spanned = 0, x = 0, j = i;
      while (j < sky.length && spanned < lw - EPS) { x = Math.max(x, sky[j].x); spanned += sky[j].width; j++; }
      if (spanned < lw - EPS) continue;
      if (x + cutLen > L + EPS) continue; // would run past this roll's usable length
      if (!best || x < best.x - EPS || (Math.abs(x - best.x) < EPS && y < best.y)) best = { x, y };
    }
    return best;
  }
  function raise(roll, y, lw, newX) {
    const spanEnd = y + lw, out = []; let placed = false;
    roll.sky.forEach((seg) => {
      const segEnd = seg.y + seg.width;
      if (segEnd <= y + EPS || seg.y >= spanEnd - EPS) { out.push(seg); return; }
      if (seg.y < y - EPS) out.push({ y: seg.y, width: y - seg.y, x: seg.x });
      if (!placed) { out.push({ y, width: lw, x: newX }); placed = true; }
      if (segEnd > spanEnd + EPS) out.push({ y: spanEnd, width: segEnd - spanEnd, x: seg.x });
    });
    if (!placed) out.push({ y, width: lw, x: newX });
    const merged = [];
    out.sort((a, b) => a.y - b.y).forEach((nn) => {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.x - nn.x) < EPS) last.width += nn.width; else merged.push(nn);
    });
    roll.sky = merged;
  }
  const order = strips.slice().sort((a, b) => {
    if (seqById) {
      const sa = seqById[a.id], sb = seqById[b.id];
      const ha = Number.isFinite(sa), hb = Number.isFinite(sb);
      if (ha && hb && sa !== sb) return sa - sb;   // both manual: chosen order
      if (ha !== hb) return ha ? -1 : 1;           // manual cuts pack before auto
    }
    const dw = laneW(b) - laneW(a);
    if (Math.abs(dw) > EPS) return dw;
    return lenX(b) - lenX(a);
  });
  const rolls = [makeRoll()];
  order.forEach((s) => {
    const lw = laneW(s), Lc = lenX(s);
    let idx = -1, spot = null;
    for (let k = 0; k < rolls.length; k++) { const sp = findSpot(rolls[k], lw, Lc); if (sp) { idx = k; spot = sp; break; } }
    if (idx < 0) {                       // no room in any open roll → open a fresh one
      idx = rolls.length; rolls.push(makeRoll());
      spot = findSpot(rolls[idx], lw, Lc);
      if (!spot) { spot = { x: 0, y: Math.max(0, (rollWidthFt - lw) / 2) }; s.overRoll = Number.isFinite(L) && Lc > L + EPS; }
      else s.overRoll = false;
    } else s.overRoll = false;
    const baseX = Number.isFinite(L) ? idx * rollLenFt : 0; // stack rolls end-to-end
    s.cutX = baseX + spot.x; s.cutY = spot.y; s.autoCutX = s.cutX; s.autoCutY = s.cutY; s.rollIndex = idx;
    raise(rolls[idx], spot.y, lw, spot.x + Lc);
  });
  return strips;
}
// How many physical rolls the current layout spans (from strip.rollIndex).
export function rollLayoutRollCount(strips) {
  return (strips || []).reduce((m, s) => Math.max(m, (s.rollIndex || 0) + 1), 0);
}
export function ensureCutPositions(strips, rollWidthFt) {
  if (!strips.some((s) => s.cutX == null || s.cutY == null)) return strips;
  let cursor = strips.reduce((m, s) => (s.cutX != null ? Math.max(m, s.cutX + Math.max(0, s.runMax - s.runMin)) : m), 0);
  strips.forEach((s) => {
    if (s.cutX == null || s.cutY == null) {
      const lw = s.laneMax - s.laneMin, y = Math.max(0, (rollWidthFt - lw) / 2);
      s.cutX = cursor; s.cutY = y;
      if (s.autoCutX == null) s.autoCutX = cursor;
      if (s.autoCutY == null) s.autoCutY = y;
      cursor += Math.max(0, s.runMax - s.runMin);
    }
  });
  return strips;
}

// The footage actually ordered — how far the furthest cut reaches down the roll
// (side-by-side cuts share length, so NOT the sum of every cut's length).
export function rollLayoutOrderLengthFt(strips) {
  return strips.reduce((m, s) => Math.max(m, (s.cutX || 0) + Math.max(0, s.runMax - s.runMin)), 0);
}
export function roundUpToInch(ft) { return Math.ceil(ft * 12 - 1e-6) / 12; }

// Apply manual per-cut run overrides (keyed by stable strip id) before nesting,
// but only where the lane count still matches (a reshaped room drops its overrides).
function applyStripOverrides(strips, overrides) {
  if (!overrides) return;
  strips.forEach((s) => {
    const o = overrides[s.id];
    if (o && o.laneCount === s.laneCount && Number.isFinite(o.runMin) && Number.isFinite(o.runMax) && o.runMax > o.runMin) {
      s.runMin = o.runMin; s.runMax = o.runMax;
    }
  });
}
// Pull the manual cut ORDER out of the overrides map into { [stripId]: seq },
// but only where the lane count still matches (a reshaped room drops its order).
function seqFromOverrides(strips, overrides) {
  if (!overrides) return null;
  const m = {}; let any = false;
  strips.forEach((s) => {
    const o = overrides[s.id];
    if (o && o.laneCount === s.laneCount && Number.isFinite(o.seq)) { m[s.id] = o.seq; any = true; }
  });
  return any ? m : null;
}
// Combine one or more items onto a roll; pick the direction that needs less
// footage unless one is forced. items: [{id,name,ring,hasDoorAtEdge?}].
// overrides: { [stripId]: {runMin,runMax,seq,laneCount} } — manual per-cut edits
// (runMin/runMax = where the cut sits on the FLOOR; seq = its order ON THE ROLL).
// extraStrips: pre-built strips (e.g. stair-carpet pieces) that aren't derived from
// a floor polygon — already oriented (run along the roll), just nested + numbered.
export function computeRollLayout(items, config, overrides = {}, extraStrips = []) {
  const build = (d) => items.flatMap((it) => layoutRingStrips(it, d, config));
  let dir = config.direction, strips;
  if (dir === "ns" || dir === "ew") { strips = build(dir); }
  else {
    const ns = build("ns"), ew = build("ew");
    if (sumStripLengthsFt(ns) <= sumStripLengthsFt(ew)) { dir = "ns"; strips = ns; } else { dir = "ew"; strips = ew; }
  }
  if (extraStrips && extraStrips.length) strips = strips.concat(extraStrips);
  // Hard invariant: a physical cut can NEVER be wider than the roll. Room lanes are
  // already bounded by the lane math; this guards other inputs (e.g. a stair whose
  // width exceeds the roll) so nothing figures/draws past the roll edge.
  const maxW = config.rollWidthFt;
  strips.forEach((s) => {
    if (s.laneMax - s.laneMin > maxW + 1e-6) s.laneMax = s.laneMin + maxW;
    if (s.coverMax - s.coverMin > maxW + 1e-6) s.coverMax = s.coverMin + maxW;
  });
  applyStripOverrides(strips, overrides);
  assignDefaultCutPositions(strips, config.rollWidthFt, seqFromOverrides(strips, overrides), config.rollLengthFt || 0);
  return { direction: dir, strips, totalLinearFt: sumStripLengthsFt(strips) };
}

// ── interactive drag: axis-separated slide collision ─────────────────────────
export function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  const e = OVERLAP_EPS_FT;
  return (ax < bx + bw - e) && (ax + aw > bx + e) && (ay < by + bh - e) && (ay + ah > by + e);
}
export function moveStripWithCollision(strip, others, rollWidthFt, candX, candY) {
  const lengthFt = Math.max(0, strip.runMax - strip.runMin);
  const laneWidthFt = strip.laneMax - strip.laneMin;
  const maxY = Math.max(0, rollWidthFt - laneWidthFt);
  const clampedX = Math.max(0, candX);
  const clampedY = Math.min(maxY, Math.max(0, candY));
  const overlapsAny = (x, y) => others.some((o) => rectsOverlap(x, y, lengthFt, laneWidthFt, o.cutX, o.cutY, Math.max(0, o.runMax - o.runMin), o.laneMax - o.laneMin));
  let finalX = strip.cutX, finalY = strip.cutY;
  if (!overlapsAny(clampedX, finalY)) finalX = clampedX;
  if (!overlapsAny(finalX, clampedY)) finalY = clampedY;
  strip.cutX = finalX; strip.cutY = finalY;
}

// Deterministic numbering by physical order on the roll (cutX then cutY).
export function rollCutNumbers(strips) {
  const m = new Map();
  strips.slice().sort((a, b) => {
    const ax = a.cutX || 0, bx = b.cutX || 0;
    if (Math.abs(ax - bx) > 1e-6) return ax - bx;
    return (a.cutY || 0) - (b.cutY || 0);
  }).forEach((s, i) => m.set(s.id, i + 1));
  return m;
}
