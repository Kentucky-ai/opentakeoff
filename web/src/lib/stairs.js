// SPDX-License-Identifier: AGPL-3.0-only
// STAIR GEOMETRY for the 3D view — treads, risers, nosings and landings, measured off a flight
// drawn on the plan as a rectangle (short side = clear width, long side = run). From Michael
// Edlin's Spline stair takeoff (2026), ported to OpenTakeoff: N treads over N+1 risers (the top
// riser steps up to the floor or landing above), nosing = one per tread across the width.
//
// OpenTakeoff has no stair card yet, so the counts come from the plan's own note written into the
// shape's label or note ("13T @ 11\" 14R @ 7\"") — parseStairNote reads it (scene3dTakeoff.js).
// Quantities only, never prices. Pure: web/test/scene3d.test.ts.

export const HOLLYWOOD_EXTRA_IN = 2;
export const STAIR_KINDS = ["flight", "landing"];
export const SIDE_KINDS = ["wall", "open"];

const pos = (v) => Math.max(0, Number(v) || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** A fresh stair block for a flight rectangle. Every count starts empty: the plan note or the
 *  estimator fills it — nothing is assumed from the drawn length. */
export function blankStair(kind = "flight") {
  return kind === "landing"
    ? { kind: "landing", nosing: true }
    : { kind: "flight", treads: null, risers: null, tread_in: null, riser_in: null, sides: ["wall", "wall"], skirts: false,
      hollywood: false, wrap_risers: true, top_nosing: true, run_axis: "auto", note: "" };
}

// ── the drawn rectangle: width (across) and run (along), in feet ──────────────────────────
// The minimum-area bounding rectangle of the drawn ring (rotating calipers over its hull), so a
// stair drawn on a rotated plan measures true. Returns { a, b, axisA } with a ≥ b.
export function flightRect(ptsFt) {
  const P = (ptsFt || []).map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  if (P.length < 3) return null;
  const hull = convexHull(P);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(L > 1e-9)) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    let mn = Infinity, mx = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const p of hull) {
      const s = (p.x - a.x) * ux + (p.y - a.y) * uy, t = -(p.x - a.x) * uy + (p.y - a.y) * ux;
      mn = Math.min(mn, s); mx = Math.max(mx, s); mnv = Math.min(mnv, t); mxv = Math.max(mxv, t);
    }
    const w = mx - mn, h = mxv - mnv;
    if (!best || w * h < best.area - 1e-9) best = { area: w * h, along: w, across: h, ux, uy };
  }
  if (!best) return null;
  const long = Math.max(best.along, best.across), short = Math.min(best.along, best.across);
  const axis = best.along >= best.across ? { x: best.ux, y: best.uy } : { x: -best.uy, y: best.ux };
  return { long, short, axis, area: best.area };
}
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/**
 * The quantities of one stair shape.
 *   st:   shape.stair (blankStair shape)
 *   rect: flightRect(...) of the drawn ring (feet) — width / run come from here
 * → { kind, treads, risers, steps, width_ft, run_ft, noted_run_ft, rise_ft, tread_sf, riser_sf,
 *     nosing_count, nosing_lf, stair_sf, landing_sf, stringer_lf, warnings[] }
 */
export function stairMetrics(st = {}, rect = null) {
  const warnings = [];
  const zero = { kind: st.kind || "flight", treads: 0, risers: 0, steps: 0, width_ft: 0, run_ft: 0, noted_run_ft: 0, rise_ft: 0, tread_sf: 0, riser_sf: 0,
    nosing_count: 0, nosing_lf: 0, stair_sf: 0, landing_sf: 0, stringer_lf: 0, warnings };
  if (!rect) { warnings.push({ code: "no_rect", message: "draw the flight as a rectangle on the plan" }); return zero; }
  if (st.kind === "landing") {
    const sf = rect.area;
    // a landing's LEADING edge oversails the riser below it: one nosing across the flight's width.
    // The flight that arrives here counts it (top_nosing) — the landing carries its area only.
    return { ...zero, kind: "landing", width_ft: r2(rect.short), run_ft: r2(rect.long), landing_sf: r2(sf), stair_sf: r2(sf) };
  }
  const tIn = pos(st.tread_in), rIn = pos(st.riser_in);
  let treads = Math.round(pos(st.treads));
  let risers = Math.round(pos(st.risers));
  if (!treads && risers) treads = risers - 1;
  if (!risers && treads) risers = treads + 1;
  if (!treads) warnings.push({ code: "no_count", message: "no tread / riser count — read the plan note (e.g. 19T @ 11\") or type it" });
  if (treads && risers && risers !== treads + 1) warnings.push({ code: "riser_count", message: `${treads} treads with ${risers} risers — a straight flight has one riser more than treads; kept as noted` });
  // which side of the rectangle is the run: the one closest to the noted run, else the long side
  const noted = treads && tIn ? (treads * tIn) / 12 : 0;
  let run = rect.long, width = rect.short;
  if (st.run_axis === "short") { run = rect.short; width = rect.long; }
  else if (st.run_axis !== "long" && noted > 0 && Math.abs(rect.short - noted) < Math.abs(rect.long - noted)) { run = rect.short; width = rect.long; }
  if (noted > 0 && Math.abs(run - noted) / noted > 0.05) warnings.push({ code: "run_mismatch", message: `drawn run ${r2(run)}' vs the noted ${treads} × ${tIn}" = ${r2(noted)}' — check the rectangle or the note` });
  const treadFt = tIn / 12 || (treads ? run / treads : 0);
  const riserFt = rIn / 12;
  if (!rIn) warnings.push({ code: "no_riser", message: "no riser height — riser SF and the stringer slope need it" });
  const hollywood = !!st.hollywood;
  const wrap = st.wrap_risers !== false;
  const nosingCount = treads ? treads + (st.top_nosing === false ? 0 : 1) : 0;
  const runFt = treads * treadFt;
  const riseFt = risers * riserFt;
  const slope = Math.hypot(runFt, riseFt);
  const sides = Array.isArray(st.sides) ? st.sides : ["wall", "wall"];
  const stringerSides = sides.filter((s) => s === "open").length + (st.skirts ? sides.filter((s) => s !== "open").length : 0);
  const stairSf = ((treads * (treadFt * 12 + (hollywood ? HOLLYWOOD_EXTRA_IN : 0)) + (wrap ? risers * riserFt * 12 : 0)) / 12) * width;
  return {
    kind: "flight", treads, risers, steps: risers, width_ft: r2(width), run_ft: r2(run), noted_run_ft: r2(noted), rise_ft: r2(riseFt),
    tread_sf: r2(treads * treadFt * width), riser_sf: r2(risers * riserFt * width),
    nosing_count: nosingCount, nosing_lf: r2(nosingCount * width),
    stair_sf: r2(stairSf), landing_sf: 0, stringer_lf: r2(stringerSides * slope), stringer_sides: stringerSides, warnings,
  };
}

// ── the plan's own stair note ───────────────────────────────────────────────────────────────
// "19T @11" = 17'-5"", "20R @ 6.85"", "UP 20R", "20 RISERS @ 6-7/8"", "18 TREADS @ 11"". The text
// layer of a rotated dimension often arrives as separate words in any order, so the words are
// joined both ways and read with anchored patterns.
const FRAC = (s) => {
  const t = String(s).trim();
  const m = t.match(/^(\d+)(?:[-\s]+(\d+)\/(\d+))?$/) || t.match(/^(\d+\.\d+)$/);
  if (!m) { const f = t.match(/^(\d+)\/(\d+)$/); return f ? Number(f[1]) / Number(f[2]) : NaN; }
  if (m[3]) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  return Number(m[1]);
};
const IN = String.raw`(\d+(?:\.\d+)?(?:[-\s]+\d+\/\d+)?)\s*(?:"|″|''|IN\b|INCH)`;
export function parseStairNote(text) {
  const t = String(text || "").toUpperCase().replace(/[“”]/g, '"').replace(/\s+/g, " ");
  const out = { treads: null, tread_in: null, risers: null, riser_in: null, run_ft: null };
  const tr = t.match(new RegExp(String.raw`\b(\d{1,2})\s*(?:T|TREADS?)\s*@\s*` + IN)) || t.match(/\b(\d{1,2})\s*TREADS?\b/);
  if (tr) { out.treads = Number(tr[1]); if (tr[2]) out.tread_in = FRAC(tr[2]); }
  const rr = t.match(new RegExp(String.raw`\b(\d{1,2})\s*(?:R|RISERS?)\s*@\s*` + IN)) || t.match(/\b(?:UP|DN|DOWN)\s*(\d{1,2})\s*R\b/) || t.match(/\b(\d{1,2})\s*RISERS?\b/);
  if (rr) { out.risers = Number(rr[1]); if (rr[2]) out.riser_in = FRAC(rr[2]); }
  const run = t.match(/=\s*(\d{1,3})'\s*-?\s*(\d{1,2}(?:\.\d+)?)?(?:\s*(\d+\/\d+))?"?/);
  if (run) out.run_ft = Number(run[1]) + (run[2] ? Number(run[2]) / 12 : 0) + (run[3] ? FRAC(run[3]) / 12 : 0);
  const found = out.treads != null || out.risers != null;
  return found ? out : null;
}
