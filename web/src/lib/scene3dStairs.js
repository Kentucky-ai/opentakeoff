// SPDX-License-Identifier: AGPL-3.0-only
// STAIRS IN 3D: the stair card's flights and landings stood up as stepped geometry, so an
// estimator can SEE the space: where the landings are, what is under the flight, which side is
// open and which is wall, and every tread, riser and nosing.
//
// From Michael Edlin's Spline 3D viewer (2026), ported to OpenTakeoff under AGPL-3.0-only:
//   * One source of truth. The geometry comes from the stair card (shape.stair + lib/stairs.js
//     stairMetrics): the counts the estimate prices are the steps that are drawn. Nothing here
//     recounts a stair.
//   * N treads over N+1 risers (Tread's rule, lib/stairs.js): tread k sits at k risers, and the
//     last riser steps up to the floor or landing above, at (N+1) risers.
//   * Datums, not guesses. A flight starts at its own `base_ft`, else on the landing its bottom
//     lands in, else the floor. A landing sits at its own `elev_ft`, else at the top of the
//     flight that arrives at it. No riser height → drawn at a nominal 7" and flagged.
//
// Frames: world [x, up, y] in feet, (plan x, elevation, plan y).
// Pure — no React, no three.js. web/test/scene3d.test.ts.

import { toWorldFt, ftIn } from "./scene3d.js";
import { flightRect, stairMetrics, blankStair, parseStairNote } from "./stairs.js";

export const NOMINAL_RISER_IN = 7;          // drawn only, never priced: the card warns until a riser is set
export const LANDING_THICK_FT = 0.5;        // the landing slab's drawn thickness (context)
export const STRINGER_DEPTH_FT = 10 / 12;   // an open side's stringer band, drawn under the nosing line
export const WALL_ABOVE_FT = 3;             // a wall side is drawn this far above the nosing line (context)
export const NOSING_HALF_FT = 1 / 24;
export const NOSING_COLOR = "#e0b400";
const CONTEXT_COLOR = "#c9ccd1";
const r2 = (v) => Math.round(v * 100) / 100;
const pos = (v) => Math.max(0, Number(v) || 0);
const has = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

// OpenTakeoff has no stair condition type: a floor_area shape is a stair when its condition's
// flooring_type is "stairs" or its tag / name says STAIR or LANDING.
const STAIR_WORDS = /\bSTAIRS?\b|\bLANDING\b/i;
export const isStairShape = (s, cById) => {
  if (!s || (s.measure_role || "floor_area") !== "floor_area") return false;
  const c = cById.get(s.condition_id);
  return String(c?.flooring_type || "") === "stairs" || STAIR_WORDS.test(`${c?.finish_tag || ""} ${c?.name || ""}`);
};
// The stair card: shape.stair when a tool wrote one, else the plan note typed in the shape's label
// or note, else in the condition's tag or name ("13T @ 11\" 14R @ 7\""); "LANDING" in the label (or the condition) makes it a landing.
export function stairCardOf(s, c) {
  if (s.stair) return { ...blankStair(s.stair.kind || "flight"), ...s.stair };
  const text = `${s.label || ""} ${s.note || ""}`;
  if (/\bLANDING\b/i.test(text) || (/\bLANDING\b/i.test(`${c?.finish_tag || ""} ${c?.name || ""}`) && !parseStairNote(text))) return blankStair("landing");
  // the shape's own note first; else the condition's tag / name ("STAIR-1 13T @ 11\" 14R @ 7\""),
  // so every flight of one stair type reads the same counts
  const n = parseStairNote(text) || parseStairNote(`${c?.finish_tag || ""} ${c?.name || ""}`) || {};
  const out = blankStair("flight");
  for (const k of ["treads", "risers", "tread_in", "riser_in"]) if (n[k] != null) out[k] = n[k];
  if (/\bOPEN\b/i.test(text)) out.sides = ["open", "wall"];
  return out;
}

/** A drawn ring (feet) → the stair's own frame: u runs UP the flight, v across it.
 *  Returns { o, u, v, run, width } with o the bottom-left corner as you walk up. */
export function stairFrame(ring, st, m) {
  const rect = flightRect(ring);
  if (!rect) return null;
  let u = rect.axis;                                     // along the long side
  const runIsLong = Math.abs(m.run_ft - rect.long) <= Math.abs(m.run_ft - rect.short) || m.kind === "landing";
  if (!runIsLong) u = { x: -u.y, y: u.x };
  let v = { x: -u.y, y: u.x };
  let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
  for (const [x, y] of ring) {
    const s = x * u.x + y * u.y, t = x * v.x + y * v.y;
    smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  // the up direction: as drawn (the run's start end), or flipped by the card
  if (st.flip) { u = { x: -u.x, y: -u.y }; v = { x: -v.x, y: -v.y }; [smin, smax] = [-smax, -smin]; [tmin, tmax] = [-tmax, -tmin]; }
  const o = { x: u.x * smin + v.x * tmin, y: u.y * smin + v.y * tmin };
  return { o, u, v, run: smax - smin, width: tmax - tmin };
}

// (s up the flight, t across it, z elevation) → world [x, up, y]
const P = (f, s, t, z) => [f.o.x + f.u.x * s + f.v.x * t, z, f.o.y + f.u.y * s + f.v.y * t];
const quadOf = (f, a, b, c, d, extra) => ({ pts: [P(f, ...a), P(f, ...b), P(f, ...c), P(f, ...d)], ...extra });
const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const nearRing = (pt, ring, tol) => inRing(pt.x, pt.y, ring) || [[tol, 0], [-tol, 0], [0, tol], [0, -tol]].some(([dx, dy]) => inRing(pt.x + dx, pt.y + dy, ring));

/**
 * Every stair on one sheet → { quads, bars, info, notes, stairIds, topFt }.
 *   quads: { pickId, shapeId, condId, layer: "stair"|"context", color, pts, opacity? }
 *   bars:  nosings, { pickId, shapeId, condId, color, a, b, half }
 *   topFt: the highest floor a flight arrives at (the level above, for the stacked sheet)
 */
export function buildStairLayer({ shapes, conditions, sheet, sheetId }) {
  const cById = new Map((conditions || []).map((c) => [c.id, c]));
  const quads = [], bars = [], notes = [], info = new Map(), stairIds = new Set();
  const note = (kind, text) => { if (!notes.some((n) => n.kind === kind)) notes.push({ kind, tag: "", text }); };
  const items = [];
  for (const s of shapes || []) {
    if (s.sheet_id !== sheetId || !isStairShape(s, cById)) continue;
    const st = stairCardOf(s, cById.get(s.condition_id));
    const ring = toWorldFt(s.verts_norm, sheet);
    if (ring.length < 3) continue;
    const m = stairMetrics(st, flightRect(ring));
    const f = stairFrame(ring, st, m);
    if (!f) continue;
    stairIds.add(s.id);
    items.push({ s, st, m, f, ring, cond: cById.get(s.condition_id) || {} });
  }
  const flights = items.filter((it) => it.st.kind !== "landing");
  const landings = items.filter((it) => it.st.kind === "landing");
  for (const it of flights) {
    const nominal = !(pos(it.st.riser_in) > 0);
    it.h = (nominal ? NOMINAL_RISER_IN : pos(it.st.riser_in)) / 12;
    it.N = it.m.treads || 0;
    it.R = it.m.risers || (it.N ? it.N + 1 : 0);
    it.d = it.N ? it.f.run / it.N : 0;
    it.nominal = nominal;
    it.z0 = has(it.st.base_ft) ? pos(it.st.base_ft) : null;
    it.bottomPt = { x: it.f.o.x + it.f.v.x * it.f.width / 2, y: it.f.o.y + it.f.v.y * it.f.width / 2 };
    it.topPt = { x: it.bottomPt.x + it.f.u.x * it.f.run, y: it.bottomPt.y + it.f.u.y * it.f.run };
  }
  // datums: flights on the floor first, then landings off the flights that arrive, then the
  // flights that start on those landings — two passes carry a U stair (flight · landing · flight)
  for (const L of landings) L.z = has(L.st.elev_ft) ? pos(L.st.elev_ft) : null;
  for (let pass = 0; pass < 3; pass++) {
    for (const it of flights) {
      if (it.z0 != null && it.fixed) continue;
      const on = landings.find((L) => L.z != null && nearRing(it.bottomPt, L.ring, 0.75));
      if (has(it.st.base_ft)) { it.z0 = pos(it.st.base_ft); it.fixed = true; it.from = "the card"; }
      else if (on) { it.z0 = on.z; it.from = `the landing ${on.s.label || ""}`.trim(); }
      else if (it.z0 == null) { it.z0 = 0; it.from = "the floor"; }
    }
    for (const L of landings) {
      if (has(L.st.elev_ft)) { L.from = "the card"; continue; }
      const arr = flights.find((it) => it.R && nearRing(it.topPt, L.ring, 0.75));
      if (arr) { L.z = arr.z0 + arr.R * arr.h; L.from = `the top of ${arr.s.label || "the flight"}`; }
    }
  }
  let topFt = 0;
  for (const it of flights) {
    const { s, st, m, f, cond, N, R, h, d, z0 } = it;
    const pickId = `shape:${s.id}`, color = cond.color || "#8a8f98", base = { pickId, shapeId: s.id, condId: s.condition_id };
    if (!N) { note(`stair-count-${s.id}`, `${cond.finish_tag || "stair"} ${s.label || ""}: no tread count yet — drawn flat until its label carries the plan note (e.g. 13T @ 11" 14R @ 7")`); continue; }
    const W = f.width;
    for (let k = 1; k <= R; k++) {
      const s0 = (k - 1) * d, zLo = z0 + (k - 1) * h, zHi = z0 + k * h;
      // riser k at s0 (the last one steps up to the floor / landing above at s = N·d)
      quads.push(quadOf(f, [s0, 0, zLo], [s0, W, zLo], [s0, W, zHi], [s0, 0, zHi], { ...base, layer: "stair", color }));
      if (k <= N) {
        quads.push(quadOf(f, [s0, 0, zHi], [s0 + d, 0, zHi], [s0 + d, W, zHi], [s0, W, zHi], { ...base, layer: "stair", color }));
        bars.push({ ...base, color: NOSING_COLOR, a: P(f, s0, 0, zHi), b: P(f, s0, W, zHi), half: NOSING_HALF_FT });
      }
    }
    if (st.top_nosing !== false) bars.push({ ...base, color: NOSING_COLOR, a: P(f, N * d, 0, z0 + R * h), b: P(f, N * d, W, z0 + R * h), half: NOSING_HALF_FT });
    const top = z0 + R * h;
    topFt = Math.max(topFt, top);
    // sides: an open side's stringer under the nosing line; a wall side as context wall
    const sides = Array.isArray(st.sides) ? st.sides : ["wall", "wall"];
    sides.forEach((side, i) => {
      const t = i ? W : 0;
      if (side === "open") {
        quads.push(quadOf(f, [0, t, z0 + h - STRINGER_DEPTH_FT], [N * d, t, top - STRINGER_DEPTH_FT], [N * d, t, top], [0, t, z0 + h], { ...base, layer: "stair", color: "#6b6f76" }));
      } else {
        quads.push(quadOf(f, [0, t, z0], [N * d, t, z0], [N * d, t, top + WALL_ABOVE_FT], [0, t, z0 + h + WALL_ABOVE_FT], { pickId: null, shapeId: s.id, condId: s.condition_id, layer: "context", color: CONTEXT_COLOR }));
      }
    });
    if (it.nominal) note(`stair-riser-${s.id}`, `${cond.finish_tag || "stair"} ${s.label || ""}: no riser height on the stair card — drawn at a nominal ${NOMINAL_RISER_IN}" (set it in the label, e.g. 14R @ 7")`);
    info.set(pickId, {
      title: `Stair flight — ${cond.finish_tag || ""}${s.label ? ` · ${s.label}` : ""}`,
      rows: [
        ["Steps", `${N} treads · ${R} risers`],
        ["Tread × riser", `${ftIn(d)} × ${r2(h * 12)}"${it.nominal ? " (nominal — not set)" : ""}`],
        ["Width × run", `${ftIn(W)} × ${ftIn(N * d)}`],
        ["Climbs", `${ftIn(z0)} → ${ftIn(top)} AFF · starts on ${it.from}`],
        ["Sides", sides.map((x, i) => `${i ? "right" : "left"} ${x === "open" ? "open (stringer)" : "wall"}`).join(" · ")],
        ["Nosing", `${m.nosing_count} × ${ftIn(W)} = ${m.nosing_lf} LF`],
        ["Finish", `${m.stair_sf} SF (treads${st.wrap_risers !== false ? " + risers" : ""})`],
        ["Under", z0 > 0 || top > 0 ? "open below the flight — check the plan for a closet, barrier or soffit" : "—"],
      ],
      source: `stair card on shape ${s.id} · ${sheetId}`, shapeId: s.id,
    });
  }
  for (const L of landings) {
    const { s, f, cond } = L;
    const z = L.z ?? 0;
    if (L.z == null) note(`landing-${s.id}`, `${cond.finish_tag || "landing"} ${s.label || ""}: no flight arrives at it and no elevation is set — drawn at the floor (set it on the stair card)`);
    const pickId = `shape:${s.id}`, color = cond.color || "#8a8f98", base = { pickId, shapeId: s.id, condId: s.condition_id };
    const W = f.width, Lr = f.run, zb = Math.max(0, z - LANDING_THICK_FT);
    quads.push(quadOf(f, [0, 0, z], [Lr, 0, z], [Lr, W, z], [0, W, z], { ...base, layer: "stair", color }));
    if (z > 0.01) for (const [a, b] of [[[0, 0], [Lr, 0]], [[Lr, 0], [Lr, W]], [[Lr, W], [0, W]], [[0, W], [0, 0]]]) {
      quads.push(quadOf(f, [a[0], a[1], zb], [b[0], b[1], zb], [b[0], b[1], z], [a[0], a[1], z], { ...base, layer: "stair", color: "#9aa0a8" }));
    }
    topFt = Math.max(topFt, z);
    info.set(pickId, {
      title: `Landing — ${cond.finish_tag || ""}${s.label ? ` · ${s.label}` : ""}`,
      rows: [["Size", `${ftIn(Lr)} × ${ftIn(W)} = ${r2(Lr * W)} SF`], ["Elevation", `${ftIn(z)} AFF · from ${L.from || "the floor (not set)"}`]],
      source: `stair card on shape ${s.id} · ${sheetId}`, shapeId: s.id,
    });
  }
  return { quads, bars, info, notes, stairIds, topFt: r2(topFt) };
}
