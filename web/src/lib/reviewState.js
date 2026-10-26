// Legacy agent hand traces omitted the flag. Absence is not an approval.
// Preserve explicit review decisions and the human-origin convention.
export function normalizeAgentReview(shape) {
  return shape?.origin?.actor === "agent" && shape.origin.reviewed == null
    ? { ...shape, origin: { ...shape.origin, reviewed: false } }
    : shape;
}
