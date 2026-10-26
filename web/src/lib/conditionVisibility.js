// Per-condition canvas visibility (#440) — the pure half. The hidden set is
// VIEW STATE: it decides what the canvas paints and what a click can pick,
// and nothing else. Totals, the report, the marked-set PDF and every export
// read the full shape list, so a hidden condition is still counted and still
// goes out the door. Kept here (no React, no DOM) so the eye / isolate rules
// are testable in isolation from the canvas.

/** True when `hidden` is exactly "everything except `id`". */
export function isIsolated(hidden, id, allIds) {
  if (!allIds.includes(id) || hidden.has(id)) return false;
  return allIds.every((x) => x === id || hidden.has(x));
}

/** Next hidden set for one eye click. Always returns a NEW Set on change.
 *    id == null          → show everything
 *    isolate (⌥-click)   → hide every other condition; on the condition that
 *                          is already isolated, show everything again
 *    plain click         → flip this one condition
 *  Ids no longer in `allIds` (deleted conditions) are dropped on the way. */
export function nextHidden(hidden, id, allIds, { isolate = false } = {}) {
  if (id == null || !allIds.includes(id)) return new Set();
  if (isolate) {
    if (isIsolated(hidden, id, allIds)) return new Set();
    return new Set(allIds.filter((x) => x !== id));
  }
  const next = new Set([...hidden].filter((x) => allIds.includes(x)));
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** The hidden set with `id` shown — same Set back when it already is, so a
 *  caller can hand it to setState without forcing a render. */
export function revealed(hidden, id) {
  if (!hidden.has(id)) return hidden;
  const next = new Set(hidden);
  next.delete(id);
  return next;
}
