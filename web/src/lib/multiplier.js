// A condition's multiplier is ×N identical areas (measure one unit, bill N).
// The one rule, wherever a value can enter: absent means ×1, anything present
// is a finite number > 0. edit_condition / propose_condition_edit enforce it
// with z.number().positive() and the Takeoffs panel clamps its input; this
// module is the same rule for the two paths that take a value from a FILE —
// takeoff import (reject) and saved-project load (repair) (#455).
//
// Why 0 is not "off": every quantity reader is `multiplier || 1`, so a 0
// bills at ×1 — the silent case the MCP tool description already warns about.

/** True when `v` may sit on a condition as its multiplier. */
export function isValidMultiplier(v) {
  return v === undefined || v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
}

/**
 * Load-time repair for a saved project written before the import guard. A bad
 * value becomes the number it was already billing at, so the report does not
 * move under the operator: a numeric string ("3") keeps its value (the readers
 * coerce it to ×3 today), and 0 / negative / non-numeric fall to ×1 — the
 * readers' own fallback for 0 and NaN; a negative stops billing a negative
 * quantity. Untouched conditions keep their object identity.
 *
 * @returns {{conditions: any[], repaired: {finish_tag: string, was: unknown, now: number}[]}}
 */
export function repairConditionMultipliers(conditions) {
  if (!Array.isArray(conditions)) return { conditions: [], repaired: [] };
  const repaired = [];
  const out = conditions.map((c) => {
    if (!c || typeof c !== "object" || isValidMultiplier(c.multiplier)) return c;
    const n = typeof c.multiplier === "string" && c.multiplier.trim() ? Number(c.multiplier) : NaN;
    const now = Number.isFinite(n) && n > 0 ? n : 1;
    repaired.push({ finish_tag: String(c.finish_tag ?? c.id ?? "?"), was: c.multiplier, now });
    return { ...c, multiplier: now };
  });
  return { conditions: out, repaired };
}

/** One line for the message bar naming what a load repaired. It leads with
 *  "Couldn't" on purpose: that is the canvas's sticky convention (isDangerMsg),
 *  and a quantity that changed on load has to stay up until someone reads it —
 *  a project often loads into the plan-set gallery, where the bar isn't shown. */
export function describeMultiplierRepair(repaired) {
  if (!repaired.length) return "";
  const list = repaired.map((r) => `${r.finish_tag} ${JSON.stringify(r.was)} → ×${r.now}`).join(", ");
  return `Couldn't load ${repaired.length === 1 ? "a condition multiplier" : `${repaired.length} condition multipliers`} as saved (must be a positive number) — reset: ${list}. Check these quantities.`;
}
