// SPDX-License-Identifier: AGPL-3.0-only
// THE 3D SCENE for one sheet, from OpenTakeoff's own shapes and conditions — the one entry the 3D
// view calls. Adapter in the place of the Spline viewer's model-driven scene (Michael Edlin, 2026):
//
//   floor_area polygons      → slabs (thickness_in, nominal ½" when unset; holes; stacked layers)
//   deduct polygons          → holes in their own condition's floor, else a red "excluded" volume
//   linear (base)            → vertical ribbons at the condition's height_ft (nominal 4")
//   linear (other)           → flush strips on the higher adjoining floor (transitions)
//   surface_area runs        → vertical ribbons at the run's / condition's height
//   count with a height      → 2" posts (corner guards)
//   stair / landing floors   → treads, risers, nosings and landings (lib/scene3dStairs.js)
//   tile conditions          → a grout grid texture at the stated size (lib/scene3dTile.js)
//   ceiling (ACT / CLG) areas → a plane at the ceiling height, soffits with drops (scene3dCeilings.js)
//
// Read-only: every number on a chip is read off the shape's own computed quantities; nothing here
// writes a shape, a condition or a quantity. Pure (no three), so it runs in node for tests.
import { buildScene, ftIn, heightOf, isBaseCondition } from "./scene3d.js";
import { tileGridOf } from "./scene3dTile.js";
import { buildStairLayer } from "./scene3dStairs.js";
import { buildCeilingLayer } from "./scene3dCeilings.js";

const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString("en-US");

export function buildTakeoffScene({ shapes, conditions, sheetId, sheet }) {
  if (!(sheet?.upp > 0)) throw new Error("Set the sheet scale first — 3D is feet-true or nothing.");
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const sheetShapes = (shapes || []).filter((s) => s.sheet_id === sheetId);
  const ceilings = buildCeilingLayer({ shapes: sheetShapes, conditions, sheet });
  const base = buildScene({ shapes: sheetShapes, conditions, sheet, skipIds: ceilings.ceilingIds });
  // stairs stand up as steps, not as a flat floor slab
  const stairs = buildStairLayer({ shapes: sheetShapes, conditions, sheet, sheetId });
  if (stairs.stairIds.size) base.slabs = base.slabs.filter((s) => !(s.kind === "floor" && stairs.stairIds.has(s.shapeId)));
  const floorSlabs = base.slabs.filter((s) => s.kind === "floor");
  for (const sl of floorSlabs) if (tileGridOf(condById.get(sl.condId))) sl.grid = sl.condId;

  // ── the chips: what each surface IS ──
  const info = new Map([...stairs.info, ...ceilings.info]);
  const byId = new Map(sheetShapes.map((s) => [s.id, s]));
  const sourceOf = (s) => {
    const o = s.origin || {};
    const who = o.actor ? String(o.actor).replace(/^agent:/, "agent ") : "estimator";
    const how = o.derived ? (o.derived.from_shape_id ? "derived from a room" : o.derived.between_shape_ids ? "derived between two floors" : "derived") : o.method || "drawn";
    return `${how} · ${who}`;
  };
  const shapeChip = (s, extraRows = []) => {
    const c = condById.get(s.condition_id) || {};
    const comp = s.computed || {}, m = Math.max(1, Number(c.multiplier) || 1);
    const rows = [["Condition", `${c.finish_tag || "?"}${c.name && c.name !== c.finish_tag ? ` — ${c.name}` : ""}${c.flooring_type ? ` · ${String(c.flooring_type).replace(/_/g, " ")}` : ""}`]];
    const role = s.measure_role || "floor_area";
    if (role === "floor_area" || role === "deduct" || role === "surface_area") {
      const sf = Number(comp.area_sf) || 0;
      rows.push(["Measured", `${fmt(sf)} SF${c.flooring_type === "carpet" ? ` (${fmt(sf / 9)} SY)` : ""}${m > 1 ? ` × ${m} = ${fmt(sf * m)} SF` : ""}`]);
      if (comp.perimeter_lf) rows.push(["Perimeter", `${fmt(comp.perimeter_lf)} LF`]);
    } else if (role === "linear") rows.push(["Measured", `${fmt(Number(comp.perimeter_lf ?? comp.length_lf) || 0)} LF${m > 1 ? ` × ${m}` : ""}`]);
    else if (role === "count") rows.push(["Measured", `${comp.count ?? 1} EA${m > 1 ? ` × ${m}` : ""}`]);
    rows.push(...extraRows);
    rows.push(["Source", sourceOf(s)]);
    return { title: `${c.finish_tag || "?"}${s.label ? ` · ${s.label}` : ""}`, rows, source: `shape ${s.id}`, shapeId: s.id };
  };
  for (const sl of base.slabs) {
    const s = byId.get(sl.shapeId);
    if (!s) continue;
    const c = condById.get(sl.condId) || {};
    const extra = [["Thickness", Number(c.thickness_in) > 0 ? `${c.thickness_in}″` : "nominal (not set)"]];
    if (sl.z0 > 0) extra.push(["Layer", `stacked at ${ftIn(sl.z0)} on the floor under it`]);
    if (sl.claimedDeducts?.length) extra.push(["Holes", `${sl.claimedDeducts.length} same-condition deduct${sl.claimedDeducts.length === 1 ? "" : "s"}`]);
    const g = tileGridOf(c);
    if (g) extra.push(["Tile", `grout grid ${g.sizeText} · ${Math.round(g.jointIn * 1000) / 1000}" joint${g.jointStated ? "" : " (assumed)"} · ${g.pattern}`]);
    if (sl.kind === "excluded") extra.unshift(["Excluded", "a deduct outside any floor of its condition — shown as a red volume"]);
    info.set(`shape:${sl.shapeId}`, shapeChip(s, extra));
  }
  for (const rb of base.ribbons) {
    const s = byId.get(rb.shapeId);
    if (!s) continue;
    const c = condById.get(rb.condId) || {};
    const h = heightOf(s, c);
    info.set(`shape:${rb.shapeId}`, shapeChip(s, rb.mode === "flush" ? [["Sits on", `the higher floor, at ${ftIn(rb.z0)}`]]
      : [["Height", h > 0 ? ftIn(h) : isBaseCondition(c) ? "nominal 4\" (not set)" : "nominal (not set)"], ...(rb.kind === "base" ? [["Runs", rb.side === "interior" ? "on its room's side of the wall line" : "on the traced line"]] : [])]));
  }
  for (const p of base.posts) { const s = byId.get(p.shapeId); if (s) info.set(`shape:${p.shapeId}`, shapeChip(s, [["Height", ftIn(p.z1 - p.z0)]])); }

  return {
    slabs: base.slabs, ribbons: base.ribbons, posts: base.posts, stairs, ceilings, info,
    notes: [...base.notes, ...stairs.notes, ...ceilings.notes],
    stats: {
      floors: floorSlabs.length, ribbons: base.ribbons.length, posts: base.posts.length,
      flights: [...stairs.info.values()].filter((x) => /^Stair flight/.test(x.title)).length,
      landings: [...stairs.info.values()].filter((x) => /^Landing/.test(x.title)).length,
      ceilings: ceilings.slabs.length, soffits: new Set(ceilings.quads.map((q) => q.shapeId)).size,
      ceilingAllowances: ceilings.slabs.filter((s) => s.allowance).length,
    },
  };
}
