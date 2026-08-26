// Pure derivation for the readout card's individual-measurement breakdown.
// Extracted from TakeoffCanvas.jsx so the logic is unit-testable without a
// mounted React tree; the canvas imports and calls this in a useMemo.

/**
 * Build the per-shape measurement list shown below the condition totals.
 *
 * @param {Array} shapes       visibleShapes (already filtered to open sheets)
 * @param {string|null} activeCond  activeConditionId
 * @param {number|null|undefined} conditionHeightFt  condition-level H fallback (feet)
 * @returns {Array<{shape: object, index: number, lengthLf: number, heightFt: number, areaSf: number}>}
 */
export function buildReadoutMeasurements(shapes, activeCond, conditionHeightFt) {
  const list = [];
  let index = 0;
  for (const s of shapes) {
    if (s.condition_id !== activeCond) continue;
    if (s.measure_role !== "linear" && s.measure_role !== "surface_area") continue;

    const lengthLf = s.computed?.perimeter_lf || 0;

    // Shape-level override wins; condition height is the fallback (same
    // resolution order as shapeMetrics.js computeShapeMetrics).
    let heightFt;
    if (s.measure_role === "surface_area") {
      heightFt = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(conditionHeightFt) || 0;
    } else {
      heightFt = 0;
    }

    // Prefer the canonical computed area when present (set by shapeMetrics
    // from exact geometry); recompute from perimeter × height only as a
    // legacy fallback for shapes that arrived without a computed area.
    // Use ?? (nullish coalescing) so canonical 0 is preserved.
    const areaSf = s.measure_role === "surface_area"
      ? (s.computed?.area_sf ?? lengthLf * heightFt)
      : s.computed?.area_sf ?? 0;

    if (lengthLf <= 0 && areaSf <= 0) continue;
    list.push({ shape: s, index: index++, lengthLf, heightFt, areaSf });
  }
  return list;
}
