// Unit-system display layer. ALL takeoff math stays in feet internally (shapes,
// scales, totals) — these helpers convert at the edges only: readouts, chips,
// the report, exports, and the calibration input. Toggling systems never
// rewrites stored data.
export type UnitSystem = "imperial" | "metric";

export const M_PER_FT = 0.3048;
export const M2_PER_SF = 0.09290304;

/** area for display: SF in, SF or m² out */
export const areaVal = (sf: number, units: UnitSystem): number =>
  units === "metric" ? sf * M2_PER_SF : sf;
export const areaUnit = (units: UnitSystem): string => (units === "metric" ? "m²" : "SF");

/** length for display: LF in, LF or m out */
export const lenVal = (lf: number, units: UnitSystem): number =>
  units === "metric" ? lf * M_PER_FT : lf;
export const lenUnit = (units: UnitSystem): string => (units === "metric" ? "m" : "LF");

/** calibration input → internal feet (metric users type meters) */
export const calInputToFeet = (v: number, units: UnitSystem): number =>
  units === "metric" ? v / M_PER_FT : v;
