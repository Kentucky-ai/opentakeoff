// Unit-system display layer. ALL takeoff math stays in feet internally (shapes,
// scales, totals) — these helpers convert at the edges only: readouts, chips,
// the report, exports, and the calibration input. Toggling systems never
// rewrites stored data.
export type UnitSystem = "imperial" | "metric";

export const M_PER_FT = 0.3048;
export const M2_PER_SF = 0.09290304;
export const MM_PER_IN = 25.4;
export const M3_PER_CF = 0.028316846592;
export const MM2_PER_IN2 = 645.16;

// ── trade-suite tools: names and values in either system (#620) ─────────────
// The suite tools work in feet, inches and SF inside, like everything else.
// A metric caller names its arguments in mm, m and m² and gets m² and m back;
// these pairs are the one table for both directions. A pair is the imperial
// and metric ending of a name, and `factor` takes an imperial value to metric.
// Longest endings first, so `_in2_per_lf` is not read as `_lf`.
export const SUITE_UNIT_PAIRS: readonly { imperial: string; metric: string; factor: number }[] = [
  { imperial: "_in2_per_lf", metric: "_mm2_per_m", factor: MM2_PER_IN2 / M_PER_FT },
  { imperial: "_per_100_lf", metric: "_per_100_m", factor: 1 / M_PER_FT },
  { imperial: "_in2", metric: "_mm2", factor: MM2_PER_IN2 },
  { imperial: "_sf", metric: "_m2", factor: M2_PER_SF },
  { imperial: "_lf", metric: "_m", factor: M_PER_FT },
  { imperial: "_ft", metric: "_m", factor: M_PER_FT },
  { imperial: "_in", metric: "_mm", factor: MM_PER_IN },
];
/** Bare keys that name a quantity: a pipe run's `lf`, an opening's `sf`. */
const SUITE_BARE_KEYS: Readonly<Record<string, { metric: string; factor: number }>> = {
  lf: { metric: "m", factor: M_PER_FT },
  sf: { metric: "m2", factor: M2_PER_SF },
};

/** The metric name of an imperial suite name, or null when it carries no unit. */
export function suiteMetricName(name: string): string | null {
  if (SUITE_BARE_KEYS[name]) return SUITE_BARE_KEYS[name].metric;
  const pair = SUITE_UNIT_PAIRS.find((p) => name.endsWith(p.imperial));
  return pair ? name.slice(0, -pair.imperial.length) + pair.metric : null;
}

/** Reply keys whose metric name is not the plain pair: a fixture row carries both `whip_ft` (each) and
 *  `whip_lf` (all of them), which would both be `whip_m`. */
const SUITE_REPLY_NAMES: Readonly<Record<string, string>> = { whip_lf: "whip_total_m" };

const r2 = (n: number) => Math.round(n * 100) / 100;
const scale = (v: unknown, factor: number): unknown =>
  typeof v === "number" ? r2(v * factor)
    : Array.isArray(v) ? v.map((x) => scale(x, factor))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scale(x, factor)]))
    : v;

/** The caller's own names in a reply: condition tags (`tag` values and the keys of `multipliers_set`)
 *  and shape ids. A tag such as `roof_sf`, or an imported id such as `wall_1_sf`, is never read as a unit. */
function replyTags(value: unknown, tags = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const x of value) replyTags(x, tags);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "tag" || k === "id") && typeof v === "string") tags.add(v);
      else if (k === "multipliers_set" && v && typeof v === "object") for (const t of Object.keys(v)) tags.add(t);
      else replyTags(v, tags);
    }
  }
  return tags;
}

/** Tags longest first, so `pl.gas_lf` is kept whole before a tag `pl` could split it. */
const longestFirst = (tags: Set<string>) => new Set([...tags].sort((a, b) => b.length - a.length));

/** Where `tag` stands as a whole word in `text`, or -1: not `valley` inside `valley_ft`, and not a tag
 *  `valley_ft` that is the last part of the argument `ice_water.valley_ft`. */
function wholeTagAt(text: string, tag: string): number {
  for (let i = text.indexOf(tag); i >= 0; i = text.indexOf(tag, i + 1)) {
    if (!/[\w.]/.test(text[i - 1] ?? "") && !/\w/.test(text[i + tag.length] ?? "")) return i;
  }
  return -1;
}

/** Text with each snake_case name that carries a unit given its metric name ("pass ice_water.eave_ft"
 *  → "pass ice_water.eave_m"), so a hint names the argument a metric caller passes. A tag the reply
 *  names, whatever its separators, and a name inside a hyphenated tag are left alone. */
function suiteMetricText(text: string, keep: Set<string>): string {
  for (const tag of keep) {
    const i = tag ? wholeTagAt(text, tag) : -1;
    if (i >= 0) return suiteMetricText(text.slice(0, i), keep) + tag + suiteMetricText(text.slice(i + tag.length), keep);
  }
  // the prefix is captured, not a lookbehind: Safari before 16.4 cannot load a module with one
  return text.replace(/(^|[^\w-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w-])/g,
    (_m, pre: string, name: string) => pre + (suiteMetricName(name) ?? name));
}

/** A suite reply in metric: each quantity key renamed (`sloped_sf` → `sloped_m2`, `edges_true_lf` →
 *  `edges_true_m`) with its value converted, and squares left out (a roofing or siding square has no
 *  metric meaning). Unit-bearing names inside text are renamed too; nested objects and lists are
 *  walked. Condition tags and the slope factors set on them stay as they are. */
export function suiteMetricReply(value: unknown, keep: Set<string> = longestFirst(replyTags(value))): unknown {
  if (typeof value === "string") return keep.has(value) ? value : suiteMetricText(value, keep);
  if (Array.isArray(value)) return value.map((x) => suiteMetricReply(x, keep));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/(^|_)squares(_|$)/.test(k)) continue;
    const bare = SUITE_BARE_KEYS[k];
    const pair = bare ? null : SUITE_UNIT_PAIRS.find((p) => k.endsWith(p.imperial));
    const name = SUITE_REPLY_NAMES[k] ?? (bare && typeof v === "number" ? bare.metric : pair ? k.slice(0, -pair.imperial.length) + pair.metric : k);
    // two imperial keys landing on one metric name would hide a number
    if (Object.prototype.hasOwnProperty.call(out, name)) throw new Error(`suite reply: ${k} and another key are both ${name} in metric`);
    if (k === "multipliers_set") out[k] = v;
    else if (bare && typeof v === "number") out[name] = r2(v * bare.factor);
    else if (pair) out[name] = scale(v, pair.factor);
    else out[name] = suiteMetricReply(v, keep);
  }
  return out;
}

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

// ── condition/shape dimension params (issue #115) ────────────────────────────
// A wall HEIGHT is stored as `height_ft` and a material THICKNESS as
// `thickness_in`; both are internal-feet-contract fields that the UI used to
// edit RAW, so a metric user typing a 2.4 m wall got a 2.4 FOOT wall and the
// vertical area came out ~3.3x short while the readout beside it said m².
// Nothing downstream reads these in display units — the report never surfaces
// them — so the whole fix lives at the input edge, exactly like calInputToFeet.
//
// Thickness localizes to MILLIMETRES, not metres: it is a material callout
// (3 mm LVT, 10 mm tile), and metres would bury every real value four decimals
// deep. Height localizes to metres, the way a wall is actually called out.

/** wall height for display: internal feet → ft or m */
export const heightVal = (ft: number, units: UnitSystem): number =>
  units === "metric" ? ft * M_PER_FT : ft;
export const heightUnit = (units: UnitSystem): string => (units === "metric" ? "m" : "ft");
/** typed wall height → internal feet (metric users type metres) */
export const heightInputToFeet = (v: number, units: UnitSystem): number =>
  units === "metric" ? v / M_PER_FT : v;
/** sane spinner step per system: a quarter foot, or 5 cm */
export const heightStep = (units: UnitSystem): number => (units === "metric" ? 0.05 : 0.25);

/** material thickness for display: internal inches → in or mm */
export const thickVal = (inches: number, units: UnitSystem): number =>
  units === "metric" ? inches * MM_PER_IN : inches;
export const thickUnit = (units: UnitSystem): string => (units === "metric" ? "mm" : "in");
/** typed thickness → internal inches (metric users type millimetres) */
export const thickInputToInches = (v: number, units: UnitSystem): number =>
  units === "metric" ? v / MM_PER_IN : v;
/** sane spinner step per system: a quarter inch, or 1 mm */
export const thickStep = (units: UnitSystem): number => (units === "metric" ? 1 : 0.25);

/** The string a dimension input SHOWS when it is not being edited. Rounded so
 *  metric doesn't display 8 ft as "2.4384000000000004", but only ever at the
 *  precision the field is actually built for (mm for a height, 0.1 mm for a
 *  thickness) — so re-committing an untouched value can't visibly drift it.
 *  Empty/blank in → empty out: a cleared param is null, not 0. */
export function dimInputStr(
  internal: number | string | null | undefined,
  units: UnitSystem,
  kind: "height" | "thickness",
): string {
  if (internal === null || internal === undefined || internal === "") return "";
  const n = Number(internal);
  if (!Number.isFinite(n)) return "";
  if (units !== "metric") return String(n);
  const shown = kind === "height" ? heightVal(n, units) : thickVal(n, units);
  return String(Number(shown.toFixed(kind === "height" ? 3 : 1)));
}

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

/** volume readout: cubic feet in, cubic yards (imperial) or m³ (metric) out.
 *  A footprint × the condition's H is a fill, a slab, an excavation — the
 *  number an estimator wants beside the L × W × D. */
export const volVal = (cf: number, units: UnitSystem): number =>
  units === "metric" ? cf * M3_PER_CF : cf / 27;
export const volUnit = (units: UnitSystem): string => (units === "metric" ? "m³" : "CY");

/** length readout for the check tool: ft-in in imperial, meters in metric */
export const fmtCheckLen = (feet: number, units: UnitSystem): string =>
  units === "metric" ? `${(feet * M_PER_FT).toFixed(2)} m` : ftIn(feet);

/** Dimension-annotation label: ASCII feet-and-inches (12.51 → `12'-6"`) so it
 *  survives WinAnsi PDF embedding — ftIn's ′/″ sit outside cp1252 and would
 *  print as "?" in the marked set. Same rounding rules as ftIn (nearest inch,
 *  12″ rolls up). Metric callers get meters at 2dp. */
export function dimLabel(feet: number, units: UnitSystem = "imperial"): string {
  if (!Number.isFinite(feet)) return "";
  if (units === "metric") return `${(feet * M_PER_FT).toFixed(2)} m`;
  const sign = feet < 0 ? "-" : "";
  let ft = Math.floor(Math.abs(feet) + 1e-9);
  let inch = Math.round((Math.abs(feet) - ft) * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return `${sign}${ft}'-${inch}"`;
}

/** Parse a typed dimension into internal feet. Imperial accepts decimal feet
 *  ("12.5"), feet-inches forms ("12'6", "12' 6\"", "12-6", "12-6\""), and inches-only
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
  // feet-inches: 12'6, 12' 6", 12-6, 12-6", 12ft 6in — incl. the curly quotes (’ ”)
  // macOS/iOS smart punctuation substitutes and spec-doc pastes carry.
  // The hyphen form takes the same optional inch mark as the foot-mark form;
  // without it, typing the mark the other examples show ("12-6"") read as nothing.
  const fi = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|′|’|ft)\s*(?:-|\s)?\s*(\d+(?:\.\d+)?)?\s*(?:"|″|”|in)?$/i)
    || s.match(/^(\d+)\s*-\s*(\d+(?:\.\d+)?)\s*(?:"|″|”|in)?$/i);
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
