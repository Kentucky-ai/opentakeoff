// SPDX-License-Identifier: AGPL-3.0-only
// CEILINGS IN 3D: an ACT / gypsum ceiling area is drawn at its ELEVATION (the RCP's height tag,
// e.g. 9'-0" AFF), not flat on the floor; a soffit or bulkhead sits at its lower height with a
// vertical drop down from the ceiling around it; acoustical tile carries its grid.
//
// Height, first found wins:
//   1. the shape's own `ceiling_ft` (per-area override, set on the selected shape)
//   2. the condition's `ceiling_ft` (Ceiling AFF field on a ceiling condition)
//   3. a height written in the shape's label/note or the condition's tag/name ("9'-0\"", "8'-6\" AFF")
//   4. a 9'-0" ALLOWANCE — drawn, labelled and flagged in the panel, never silent
// Read-only: nothing here writes a quantity. Pure (no three): web/test/scene3d.test.ts.
import { toWorldFt, bbox2, pointInRing2, interiorPoint, ringCCW, ringCW, ftIn } from "./scene3d.js";
import { tileGridOf, groutColorOf } from "./scene3dTile.js";
import { isCeilingCondition } from "./ceilingKind.js";

export const CEILING_ALLOWANCE_FT = 9;
export const CEILING_THICK_FT = 1 / 12;     // drawn panel thickness (display only)
const ACT_RE = /\bACT\b|\bAPC\b|ACOUSTIC/i;
const FT_IN_RE = /(\d{1,2})\s*'\s*-?\s*(\d{1,2}(?:\.\d+)?)?(?:\s*(\d+)\/(\d+))?\s*"?/;

const condText = (c) => `${c?.finish_tag || ""} ${c?.name || ""}`;
export { isCeilingCondition };

/** "9'-0\"" / "8' 6\" AFF" → feet, or null */
export function parseFtIn(text) {
  const m = String(text || "").match(FT_IN_RE);
  if (!m) return null;
  const ft = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0) + (m[3] ? Number(m[3]) / Number(m[4]) / 12 : 0);
  return ft > 0 && ft < 60 ? ft : null;
}

/** → { ft, from, allowance } */
export function ceilingHeightOf(s, c) {
  if (Number(s?.ceiling_ft) > 0) return { ft: Number(s.ceiling_ft), from: "this area", allowance: false };
  if (Number(c?.ceiling_ft) > 0) return { ft: Number(c.ceiling_ft), from: "the condition", allowance: false };
  const own = parseFtIn(`${s?.label || ""} ${s?.note || ""}`);
  if (own) return { ft: own, from: "the area's label", allowance: false };
  const tag = parseFtIn(condText(c));
  if (tag) return { ft: tag, from: "the condition's tag", allowance: false };
  return { ft: CEILING_ALLOWANCE_FT, from: `allowance (${ftIn(CEILING_ALLOWANCE_FT)} — no height given)`, allowance: true };
}

/** the grid on a ceiling: the stated size, else ACT's common 2'×2' (labelled assumed) */
export function ceilingGridOf(c) {
  const stated = tileGridOf({ ...c, flooring_type: "tile" });
  const grout = { color: "#f4f4f2", stated: false, text: "white tee" };
  if (stated) {
    // ceiling sizes are written in feet ("2x4") as often as inches ("24x48")
    const feet = stated.wFt * 12 <= 6 && stated.hFt * 12 <= 6;
    const w = feet ? stated.wFt * 12 : stated.wFt, h = feet ? stated.hFt * 12 : stated.hFt;
    return { ...stated, wFt: w, hFt: h, sizeText: `${w * 12}"×${h * 12}"`, jointFt: 1 / 12, jointIn: 1, grout, assumed: false };
  }
  if (!ACT_RE.test(condText(c)) && c?.flooring_type !== "act") return null;
  return { wFt: 2, hFt: 2, jointFt: 1 / 12, jointIn: 1, pattern: "stacked", grout, sizeText: `24"×24"`, assumed: true, jointStated: false };
}

/**
 * Ceiling areas on one sheet → { slabs, quads, info, notes, ceilingIds }.
 *   slabs: { verts_ft, holes_ft, z0, z1, kind:"ceiling", shapeId, condId, color, gridSpec, opacity }
 *   quads: soffit drops — { pickId, shapeId, condId, layer:"ceiling", color, pts }
 */
export function buildCeilingLayer({ shapes, conditions, sheet }) {
  const cById = new Map((conditions || []).map((c) => [c.id, c]));
  const items = [];
  for (const s of shapes || []) {
    if ((s.measure_role || "floor_area") !== "floor_area" || (s.verts_norm || []).length < 3) continue;
    const c = cById.get(s.condition_id);
    if (!isCeilingCondition(c)) continue;
    const ring = toWorldFt(s.verts_norm, sheet);
    const h = ceilingHeightOf(s, c);
    items.push({ s, c, ring, bbox: bbox2(ring), h, holes: (s.verts_norm_holes || []).map((x) => toWorldFt(x, sheet)).filter((x) => x.length >= 3) });
  }
  const slabs = [], quads = [], notes = [], info = new Map(), ceilingIds = new Set();
  const allowance = items.filter((it) => it.h.allowance);
  if (allowance.length) notes.push({ kind: "ceiling-allowance", tag: "", text: `${allowance.length} ceiling area${allowance.length === 1 ? " has" : "s have"} no height — drawn at a ${ftIn(CEILING_ALLOWANCE_FT)} ALLOWANCE (set Ceiling AFF on the condition or the area, or write the RCP tag, e.g. 9'-0")` });
  for (const it of items) {
    const { s, c, ring, h } = it;
    ceilingIds.add(s.id);
    const grid = ceilingGridOf(c);
    // a soffit / bulkhead: a ceiling inside another ceiling that is higher — drop down to it
    const [px, py] = interiorPoint(ring);
    let host = null;
    for (const o of items) {
      if (o === it || o.h.ft <= h.ft + 1e-6 || px < o.bbox[0] || px > o.bbox[2] || py < o.bbox[1] || py > o.bbox[3]) continue;
      if (pointInRing2(px, py, o.ring) && (!host || o.h.ft < host.h.ft)) host = o;
    }
    slabs.push({ verts_ft: ringCCW(ring), holes_ft: it.holes.map((x) => ringCW(x)), z0: h.ft, z1: h.ft + CEILING_THICK_FT, kind: "ceiling",
      shapeId: s.id, condId: c.id, color: c.color || "#d9dcdf", gridSpec: grid, allowance: h.allowance });
    if (host) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        quads.push({ pickId: `shape:${s.id}`, shapeId: s.id, condId: c.id, layer: "ceiling", color: c.color || "#c9ccd1",
          pts: [[a[0], h.ft, a[1]], [b[0], h.ft, b[1]], [b[0], host.h.ft, b[1]], [a[0], host.h.ft, a[1]]] });
      }
    }
    const sf = Number(s.computed?.area_sf) || 0;
    info.set(`shape:${s.id}`, {
      title: `Ceiling — ${c.finish_tag || ""}${s.label ? ` · ${s.label}` : ""}`,
      rows: [
        ["Measured", `${Math.round(sf * 100) / 100} SF`],
        ["Height", `${ftIn(h.ft)} AFF · from ${h.from}${h.allowance ? " — ALLOWANCE" : ""}`],
        ...(host ? [["Soffit", `drops ${ftIn(host.h.ft - h.ft)} from the ${ftIn(host.h.ft)} ceiling around it`]] : []),
        ...(grid ? [["Grid", `${grid.sizeText}${grid.assumed ? " (assumed — no size stated)" : ""}`]] : []),
      ],
      source: `shape ${s.id}`, shapeId: s.id,
    });
  }
  return { slabs, quads, info, notes, ceilingIds, groutColor: groutColorOf("white").color };
}
