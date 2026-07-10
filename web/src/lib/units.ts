// Unit-system display layer. ALL takeoff math stays in feet internally (shapes,
// scales, totals) — these helpers convert at the edges only: readouts, chips,
// the report, exports, and the calibration input. Toggling systems never
// rewrites stored data.
//
// NOTE (this fork): the metric display mode itself (upstream ee3c2ad) is not
// ported yet — the canvas runs imperial-only, so the metric-only exports here
// (areaVal/areaUnit/lenVal/lenUnit/calInputToFeet in their "metric" branches)
// sit unused until that port lands. They're kept whole so the metric port is a
// drop-in and the check-a-dimension helpers below stay byte-identical to
// upstream.
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

/** Feet → drawing-style feet-and-inches: 12.51 → "12′ 6″". Rounds to the
 *  nearest inch; 12″ rolls up to the next foot. */
export function ftIn(feet: number): string {
  if (!Number.isFinite(feet)) return "";
  const sign = feet < 0 ? "-" : "";
  let ft = Math.floor(Math.abs(feet) + 1e-9);
  let inch = Math.round((Math.abs(feet) - ft) * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return `${sign}${ft}′ ${inch}″`;
}

/** length readout for the check tool: ft-in in imperial, meters in metric */
export const fmtCheckLen = (feet: number, units: UnitSystem): string =>
  units === "metric" ? `${(feet * M_PER_FT).toFixed(2)} m` : ftIn(feet);

/** Parse a typed dimension into internal feet. Imperial accepts decimal feet
 *  ("12.5"), feet-inches forms ("12'6", "12' 6\"", "12-6"), and inches-only
 *  ("6\"", "6in" — the natural way to type a sub-foot check dimension); metric
 *  users type meters. Bare numbers must be plain unsigned decimals: scientific
 *  notation ("1e3") and negatives parse as NaN — every consumer guards > 0,
 *  but a dimension parser should never produce them in the first place.
 *  Returns NaN when it can't read the input. */
export function parseLenInput(raw: string, units: UnitSystem): number {
  const s = (raw || "").trim();
  if (!s) return NaN;
  // a typed dimension number is a plain unsigned decimal — no sign, no exponent
  const plainNum = (t: string): number => (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t) ? Number(t) : NaN);
  if (units === "metric") {
    const m = plainNum(s.replace(/m$/i, "").trim());
    return Number.isFinite(m) ? m / M_PER_FT : NaN;
  }
  // inches-only: 6", 6″, 6in (values ≥ 12″ are fine here — "18\"" is a real
  // dimension callout; only the feet-inches form below treats inch ≥ 12 as a typo)
  const inOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|″|”|in)$/i);
  if (inOnly) return Number(inOnly[1]) / 12;
  // feet-inches: 12'6, 12' 6", 12-6, 12ft 6in — incl. the curly quotes (’ ”)
  // macOS/iOS smart punctuation substitutes and spec-doc pastes carry
  const fi = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|′|’|ft)\s*(?:-|\s)?\s*(\d+(?:\.\d+)?)?\s*(?:"|″|”|in)?$/i)
    || s.match(/^(\d+)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (fi) {
    const ft = Number(fi[1]);
    const inch = fi[2] != null ? Number(fi[2]) : 0;
    if (!Number.isFinite(ft) || !Number.isFinite(inch) || inch >= 12) return NaN;
    return ft + inch / 12;
  }
  return plainNum(s);
}

/** Check-tool verdict, graded from the ROUNDED error the chip displays so the
 *  color can never contradict the number beside it: raw 1.04% used to grade
 *  amber while displaying "+1.0%", which the docs promise is green. Tie-break:
 *  the displayed one-decimal value is authoritative — |shown| ≤ 1.0 is green
 *  ("match"), ≤ 5.0 amber ("close"), past that red ("wrong"); these are
 *  upstream's inclusive ≤1/≤5 thresholds applied after display rounding.
 *  `shown` also normalizes IEEE -0 (the `|| 0` falsy coercion, num.js's
 *  convention) so an exact recalibrate's 1-ulp FP residue reads "+0.0%",
 *  never "(-0.0%)". */
export function checkVerdict(errPct: number): { shown: number; grade: "match" | "close" | "wrong" } {
  // an exported helper whose failure mode is "confidently green" needs the
  // guard even though current callers null-check first: NaN.toFixed(1) → "NaN"
  // → Number → NaN → ||0 → 0 would grade a non-answer as a match
  if (!Number.isFinite(errPct)) return { shown: 0, grade: "wrong" };
  const shown = Number(errPct.toFixed(1)) || 0;
  const a = Math.abs(shown);
  return { shown, grade: a <= 1 ? "match" : a <= 5 ? "close" : "wrong" };
}
