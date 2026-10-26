// T — trace another one like the selected shape (idea credited to the
// brodeurguillaume-spec fork, implemented independently here).
//
// A committed shape already says everything a fresh trace of the same kind
// needs: its condition, its measure role, whether it was curved, and — for a
// four-corner axis-aligned ring — that Rectangle is the faster tool for the
// next one. This module is the pure read of that record → the tool to arm.
// The canvas owns the side effects (activate the condition without
// reassigning, set the curve switch, arm the tool, drop the selection).
//
// Kept DOM-free so it is unit-tested against every measure_role and both
// ring shapes in test/repeatTool.test.ts.

const EPS = 1e-6;

/** Four vertices whose consecutive pairs share an x OR a y — the ring the
 *  Rectangle / Deduct-rectangle tools draw. Works in normalized sheet space
 *  (verts_norm) and in pixels alike; a rotated quad is NOT axis-aligned. */
export function isAxisAlignedQuad(verts) {
  if (!Array.isArray(verts) || verts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = verts[i], b = verts[(i + 1) % 4];
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const sameX = Math.abs(a[0] - b[0]) < EPS, sameY = Math.abs(a[1] - b[1]) < EPS;
    if (!sameX && !sameY) return false;   // a diagonal edge
    if (sameX && sameY) return false;     // a degenerate (zero-length) edge
  }
  return true;
}

/** The canvas tool that draws another shape like `shape`, or null when the
 *  record carries no repeatable measure (unknown role, missing verts). */
export function toolForShape(shape) {
  if (!shape || typeof shape !== "object") return null;
  const verts = shape.verts_norm;
  const rectangular = !shape.curved && isAxisAlignedQuad(verts);
  switch (shape.measure_role) {
    case "floor_area":   return rectangular ? "rect" : "area";
    case "deduct":       return rectangular ? "deduct-rect" : "deduct";
    case "linear":       return "linear";
    case "surface_area": return "surface";
    case "count":        return "count";
    default:             return null;
  }
}

/** Everything the T key needs to do, as data: which condition to activate,
 *  which tool to arm, and where the straight/curve switch should sit. `curve`
 *  is only meaningful for the bendable tools; it reads false for the rest so
 *  a Count repeat never flips the switch a later Area trace inherits. */
export function repeatPlan(shape) {
  const tool = toolForShape(shape);
  if (!tool) return null;
  const bendable = tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface";
  return { conditionId: shape.condition_id || null, tool, curve: bendable && shape.curved === true };
}
