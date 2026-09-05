// Read-only presentation of stored measurement receipts. These labels are not
// verification or authentication; missing attribution stays unknown.
export function workActor(shape) {
  const origin = shape.origin || {};
  if (origin.actor === "agent" || origin.method === "agent_v1") return "Agent";
  if (origin.actor === "rule" || origin.method === "rule_v1") return "Rule";
  if (origin.actor === "canvas" || origin.actor === "human") return "Canvas";
  return shape.author ? "Named author" : "Not recorded";
}

export function workReviewState(shape) {
  if (shape.origin?.reviewed === false) return "Needs review";
  if (shape.origin?.reviewed === true) return "Reviewed";
  return "Recorded";
}

export function workQuantity(shape) {
  const c = shape.computed || {};
  const kind = shape.measure_role === "count" ? "count" : shape.measure_role === "linear" ? "length" : "area";
  const value = kind === "count" ? c.count : kind === "length" ? c.perimeter_lf : c.area_sf;
  return { kind, value: Number.isFinite(value) ? value : null, deduct: shape.measure_role === "deduct" };
}

export function filterWork(shapes, { filter = "all", query = "", conditionLabel = () => "", sheetLabel = () => "" } = {}) {
  const term = query.trim().toLocaleLowerCase();
  return shapes.filter((shape) => {
    if (filter === "pending" && workReviewState(shape) !== "Needs review") return false;
    if (filter === "agent" && workActor(shape) !== "Agent") return false;
    return !term || [shape.id, shape.label, shape.author, conditionLabel(shape.condition_id), sheetLabel(shape.sheet_id)]
      .some((value) => String(value || "").toLocaleLowerCase().includes(term));
  });
}
