import { RENDER_SCALE } from "./takeoffConstants";

/** Optional paper-space footprint, never a measured spread or calibration. */
export function countDiameterPt(condition?: { count_diameter_pt?: unknown } | null): number | null {
  const value = condition?.count_diameter_pt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Legacy pins stay screen-sized until an explicit ring diameter is chosen. */
export function countRadiusPx(condition?: { count_diameter_pt?: unknown } | null, zoom = 1): number {
  const diameter = countDiameterPt(condition);
  return diameter === null ? 7 / zoom : diameter * RENDER_SCALE / 2;
}
