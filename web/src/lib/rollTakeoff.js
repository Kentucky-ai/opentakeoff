// Roll-goods takeoff wiring (#136) — the pure bridge between the canvas's
// shape/condition model and lib/rollgoods.js (the packing engine). The engine
// speaks polygon rings in FEET; the app stores verts normalized to a sheet's
// bitmap. This module owns that conversion plus everything derivable without
// React or the DOM: per-condition layouts, the per-sheet cut rectangles the
// overlay draws, the per-shape override plumbing, and the report rows the
// Report table / CSV / opentakeoff.report.v1 consume. Keep it pure — the same
// math must serve the canvas and any headless consumer.
//
// Opt-in contract (the engine's own header states it): OpenTakeoff conditions
// are trade-agnostic, so roll goods is a `roll_setup` object ON the condition
// — presence is the opt-in — carrying `material` (carpet | sheet_vinyl |
// rubber) for color/defaults plus the engine's spec fields. Manual per-cut
// edits live on the SHAPE as `roll_layout: { laneCount, lanes: { [laneIndex]:
// { runMin, runMax, seq? } } }` — keyed by lane so a reshaped room (lane count
// changed) drops its stale overrides via the engine's own laneCount guard.
import {
  isRollType, defaultRollSetup, computeRollLayout, rollLayoutOrderLengthFt,
  rollLayoutRollCount, rollCutNumbers, rollQtyForUnit, roundUpToInch,
} from "./rollgoods.js";
import { round2 } from "./num.js";

// A condition is roll goods iff it carries a usable roll_setup. Corrupt
// payloads (roll_setup an array/string, width missing) read as opted OUT —
// the same defensive posture as spec/attrs sanitizing, without a hydrate pass.
export function hasRollSetup(c) {
  const rs = c?.roll_setup;
  return !!rs && typeof rs === "object" && !Array.isArray(rs) && Number(rs.roll_width_ft) > 0;
}

// Fresh setup for the opt-in select — the engine's defaults plus the material
// class the overlay colors by.
export function mintRollSetup(material) {
  const ft = isRollType(material) ? material : "carpet";
  return { material: ft, ...defaultRollSetup(ft) };
}

// roll_setup → the engine's config object, every field coerced. doorway
// overage rides along for forward-compat but stays inert until door edges
// exist on shapes (hasDoorAtEdge is never supplied — deliberately no UI knob
// for a field that would silently do nothing).
export function rollConfig(rs) {
  return {
    rollWidthFt: Math.max(0.5, Number(rs.roll_width_ft) || 12),
    rollLengthFt: Math.max(0, Number(rs.roll_length_ft) || 0),
    seamAllowanceIn: Math.max(0, Number(rs.seam_allowance_in) || 0),
    wallOverageIn: Math.max(0, Number(rs.wall_overage_in) || 0),
    doorwayOverageIn: Math.max(0, Number(rs.doorway_overage_in) || 0),
    direction: rs.direction === "ns" || rs.direction === "ew" ? rs.direction : "auto",
  };
}

// Manual per-cut overrides, flattened off every shape into the engine's
// { "<shapeId>:<laneIndex>": { runMin, runMax, seq, laneCount } } map. The
// laneCount guard is applied by the ENGINE (applyStripOverrides /
// seqFromOverrides) — this just collects.
export function collectRollOverrides(shapes) {
  const out = {};
  for (const s of shapes) {
    const rl = s.roll_layout;
    if (!rl || typeof rl !== "object" || !rl.lanes || typeof rl.lanes !== "object") continue;
    for (const [li, o] of Object.entries(rl.lanes)) {
      if (!o || typeof o !== "object") continue;
      out[`${s.id}:${li}`] = { ...o, laneCount: rl.laneCount };
    }
  }
  return out;
}

// The length/width of one strip's physical cut piece, in feet.
export const stripLenFt = (s) => Math.max(0, s.runMax - s.runMin);
export const stripWidthFt = (s) => Math.max(0, s.laneMax - s.laneMin);

// One strip's floor rectangle in SHEET PX — the overlay's frame. laneAxis "x"
// (direction ns) tiles lanes across x and runs along y; "ew" the reverse.
export function stripSheetRect(strip, upp) {
  if (!(upp > 0)) return null;
  const lane0 = strip.laneMin / upp, lane1 = strip.laneMax / upp;
  const run0 = strip.runMin / upp, run1 = strip.runMax / upp;
  return strip.laneAxis === "x"
    ? { x: lane0, y: run0, w: lane1 - lane0, h: run1 - run0 }
    : { x: run0, y: lane0, w: run1 - run0, h: lane1 - lane0 };
}

// ── the whole takeoff, figured ──────────────────────────────────────────────
// computeRollTakeoff(conditions, shapes, dimsFor, uppFor) →
//   { byCond: Map(condition_id → summary), cutsBySheet: Map(sheet_id → cut[]) }
//
// dimsFor(sheetId) → {w,h}|null (bitmap px), uppFor(sheetId) → feet-per-px|null.
// Shapes on unscaled/unrendered sheets are skipped — a ring needs real feet.
// Only floor_area shapes participate: a roll cut is a floor piece. Interior
// holes (verts_norm_holes) deliberately do NOT shorten cuts — material runs
// past a column and the cut piece is still full length; the hole nets out of
// the AREA quantities, not the roll.
//
// summary: { material, config, direction, strips, nums, orderFt, rollCount,
//            oversize, qty, unit, cutCount }
//   orderFt is roundUpToInch'd (you order to the inch) and PER UNIT — the
//   condition ×N multiplier applies at the report seam like every quantity.
export function computeRollTakeoff(conditions, shapes, dimsFor, uppFor) {
  const byCond = new Map();
  const cutsBySheet = new Map();
  const rollConds = (conditions || []).filter(hasRollSetup);
  if (!rollConds.length) return { byCond, cutsBySheet };
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  for (const c of rollConds) {
    const rs = c.roll_setup;
    const config = rollConfig(rs);
    const items = [];
    for (const s of shapes) {
      if (s.condition_id !== c.id || s.measure_role !== "floor_area") continue;
      if (!Array.isArray(s.verts_norm) || s.verts_norm.length < 3) continue;
      const dims = dimsFor(s.sheet_id), upp = uppFor(s.sheet_id);
      if (!dims || !(dims.w > 0) || !(upp > 0)) continue;
      items.push({ id: s.id, name: s.label || "", ring: s.verts_norm.map(([nx, ny]) => ({ x: nx * dims.w * upp, y: ny * dims.h * upp })) });
    }
    if (!items.length) continue;
    const layout = computeRollLayout(items, config, collectRollOverrides(shapes));
    const nums = rollCutNumbers(layout.strips);
    const orderFt = roundUpToInch(rollLayoutOrderLengthFt(layout.strips));
    const material = isRollType(rs.material) ? rs.material : "carpet";
    const unit = rs.price_unit === "lf" || rs.price_unit === "sf" || rs.price_unit === "sy" ? rs.price_unit : "sf";
    byCond.set(c.id, {
      material, config, direction: layout.direction, strips: layout.strips, nums,
      orderFt, rollCount: rollLayoutRollCount(layout.strips),
      oversize: layout.strips.some((s) => s.overRoll),
      qty: round2(rollQtyForUnit(orderFt, config.rollWidthFt, unit)), unit,
      cutCount: layout.strips.length,
    });
    for (const strip of layout.strips) {
      const src = shapeById.get(strip.srcId);
      if (!src) continue;
      const upp = uppFor(src.sheet_id);
      const rect = stripSheetRect(strip, upp);
      if (!rect) continue;
      if (!cutsBySheet.has(src.sheet_id)) cutsBySheet.set(src.sheet_id, []);
      cutsBySheet.get(src.sheet_id).push({
        id: strip.id, srcId: strip.srcId, condId: c.id,
        laneIndex: strip.laneIndex, laneCount: strip.laneCount, laneAxis: strip.laneAxis,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        runMin: strip.runMin, runMax: strip.runMax, upp,
        lenFt: stripLenFt(strip), widthFt: stripWidthFt(strip),
        num: nums.get(strip.id) || 0, overRoll: !!strip.overRoll,
        multi: strip.laneCount > 1, material,
      });
    }
  }
  return { byCond, cutsBySheet };
}

// ── report seam ─────────────────────────────────────────────────────────────
// The additive roll_goods block for opentakeoff.report.v1 (and the ctx the
// Report's roll columns read). rows = conditionTotals output — finish_tag and
// multiplier come from there so the block can never disagree with the table.
// ×N applies here, the same convention as every other reported quantity: N
// identical units are N cuttings of the same layout.
export function rollReportRows(rollByCond, rows) {
  if (!rollByCond || !rollByCond.size || !Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const ri = rollByCond.get(r.id);
    if (!ri) continue;
    const mult = r.multiplier || 1;
    out.push({
      condition_id: r.id, finish_tag: r.finish_tag, material: ri.material,
      roll_width_ft: ri.config.rollWidthFt, roll_length_ft: ri.config.rollLengthFt,
      direction: ri.direction, cuts: ri.cutCount,
      order_lf: round2(ri.orderFt * mult), rolls: ri.rollCount * mult,
      order_qty: round2(ri.qty * mult), order_unit: ri.unit,
      oversize: ri.oversize,
    });
  }
  return out;
}
