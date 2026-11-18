// Trade suites — the one registry of what each trade adds on top of the core.
//
// The core (load, scale, read the set, measure area / line / count, revise,
// export) is trade-neutral and always there. A suite is what one trade adds:
// a short method, the condition names its tools default to, and — only where
// the core cannot already do the job — a tool of its own. A suite costs an
// agent nothing until it is opened: its tools stay out of the tool list and
// its method is handed over once, at open time, instead of riding every turn.
//
// Divisions are CSI MasterFormat numbers, so "open Division 07" works the way
// a bid package is split: one division can carry several suites, and a suite
// can answer to more than one division (Electrical covers 26, 27 and 28).
//
// Nothing here carries a price, a manufacturer or a product: allowances are
// reported as allowances and every document-supplied value is an argument.

export interface SuitePreset {
  /** the finish tag the suite's tools default to */
  tag: string;
  /** the measure the condition is taken with */
  measure: "area" | "line" | "count" | "surface";
  what: string;
}

export interface TradeSuite {
  id: string;
  label: string;
  divisions: string[];
  /** one line: what the suite takes off. This is all an agent reads before opening it. */
  summary: string;
  /** tools the suite adds; [] = the core already covers the trade and the method says how */
  tools: string[];
  /** the method, handed over once at open time — short, imperative, names the tools in order */
  method: string;
  presets: SuitePreset[];
  /** finish-tag prefixes that place a condition in this suite when it carries no explicit trade */
  prefixes: string[];
}

export const DIVISIONS: Record<string, string> = {
  "07": "Thermal & moisture protection",
  "08": "Openings",
  "09": "Finishes",
  "22": "Plumbing",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic safety & security",
};

export const TRADE_SUITES: readonly TradeSuite[] = Object.freeze([
  {
    id: "finishes",
    label: "Finishes",
    prefixes: [],
    divisions: ["09"],
    summary: "flooring, base, transitions, wall finishes: core tools, no extra tools",
    tools: [],
    method: [
      "Finish plan, scale set. Trace each room with measure_polygon under its finish tag from the room's schedule row (resolve_tag).",
      "Base: derive_base from the floor condition, stating door openings. Transitions: derive_transitions.",
      "Wall finishes: measure_surface along the wall with the condition's height. Roll goods: edit_condition roll_setup.",
    ].join("\n"),
    presets: [],
  },
  {
    id: "roofing",
    label: "Roofing",
    prefixes: ["RF-"],
    divisions: ["07"],
    summary: "sloped roof area and squares, true rake/hip/valley LF, drip edge, starter, ridge cap, underlayment",
    tools: ["roof_takeoff"],
    method: [
      "Roof plan, scale set. Plan view is what you trace; roof_takeoff makes it true.",
      "1. measure_polygon each roof plane (or the field of one pitch) under RF-FIELD. Plan area, not sloped.",
      "2. measure_line every edge by type: RF-EAVE, RF-RAKE, RF-RIDGE, RF-HIP, RF-VALLEY. Plan lengths.",
      "3. Count drains, vents, curbs and penetrations with place_count or symbol_sweep under RF-PEN-<type>.",
      "4. roof_takeoff {pitch} once per pitch: it puts the slope factor on the field and edge conditions so totals read true, commits drip edge (RF-DRIP), starter (RF-STARTER) and ridge cap (RF-CAP) runs, and reports squares with waste.",
      "The pitch comes from the drawings' slope callout (6/12, 1/4\" per ft). No callout: create_rfi, never guess. A second pitch = separate tags (RF-FIELD-B …) and a second call.",
      "Parapets: measure_line RF-PARAPET, then edit_condition height_ft for the flashing height.",
    ].join("\n"),
    presets: [
      { tag: "RF-FIELD", measure: "area", what: "roof planes, plan view" },
      { tag: "RF-EAVE", measure: "line", what: "eaves" },
      { tag: "RF-RAKE", measure: "line", what: "rakes / gable edges" },
      { tag: "RF-RIDGE", measure: "line", what: "ridges" },
      { tag: "RF-HIP", measure: "line", what: "hips" },
      { tag: "RF-VALLEY", measure: "line", what: "valleys" },
      { tag: "RF-PEN-<type>", measure: "count", what: "drains, vents, curbs, penetrations" },
    ],
  },
  {
    id: "siding",
    label: "Siding",
    prefixes: ["SD-"],
    divisions: ["07"],
    summary: "net wall area and squares from elevations, opening trim, starter, corners, lap pieces",
    tools: ["siding_takeoff"],
    method: [
      "Elevations, scale set on each. Trace each wall face once; a face that shows on two elevations is taken on one.",
      "1. measure_polygon each sided wall face under SD-WALL (gable ends included, up to the soffit line).",
      "2. measure_polygon each window and door under SD-OPEN (or cut_out them from the wall).",
      "3. measure_line each outside corner under SD-OSC and inside corner under SD-ISC, full height, on one elevation.",
      "4. siding_takeoff {door_openings: [shape ids of doors], exposure_in, piece_length_ft}: net SF and squares, J/trim runs around openings (SD-TRIM, doors 3 sides) and starter along wall bottoms (SD-STARTER) committed so you can see them.",
      "A different siding material on part of a wall = its own tags (SD-WALL-B …) and a second call.",
    ].join("\n"),
    presets: [
      { tag: "SD-WALL", measure: "area", what: "sided wall faces on elevations" },
      { tag: "SD-OPEN", measure: "area", what: "windows and doors in those faces" },
      { tag: "SD-OSC", measure: "line", what: "outside corners, full height" },
      { tag: "SD-ISC", measure: "line", what: "inside corners, full height" },
    ],
  },
  {
    id: "soffit_fascia",
    label: "Soffit & fascia",
    prefixes: ["SF-"],
    divisions: ["07"],
    summary: "soffit SF from eave/rake LF × depth, fascia LF, wall receiver, attic intake vent area",
    tools: ["soffit_takeoff"],
    method: [
      "Roof plan, scale set. Reuse the roofing edges when they exist (RF-EAVE, RF-RAKE); otherwise measure_line the eaves and rakes under those tags.",
      "Soffit depth comes from the wall section or eave detail (horizontal, wall face to fascia). No dimension: create_rfi.",
      "soffit_takeoff {overhang_in, rake_overhang_in, pitch}: commits soffit as a surface (eave LF × depth) under SF-SOFFIT and fascia runs under SF-FASCIA; pass vent {attic_sf, ratio} for the required intake area.",
    ].join("\n"),
    presets: [
      { tag: "RF-EAVE", measure: "line", what: "eaves (shared with roofing)" },
      { tag: "RF-RAKE", measure: "line", what: "rakes (shared with roofing)" },
    ],
  },
  {
    id: "glazing",
    label: "Glazing & storefront",
    prefixes: ["GL-"],
    divisions: ["08"],
    summary: "storefront / curtain wall: frame SF, lites, glass SF, mullion LF, perimeter sealant",
    tools: ["glazing_takeoff"],
    method: [
      "Exterior elevations or storefront elevations, scale set.",
      "1. measure_polygon each frame opening (rough frame outline) under GL-<type> (GL-SF1, GL-CW1 …).",
      "2. Read each frame's grid off the elevation: bays across, rows up. Window and door types on a schedule: sweep_schedule_row / count_marks for counts.",
      "3. glazing_takeoff {condition, grid: [{shape_id, bays, rows}]}: per opening lites, lite size, glass SF, mullion LF (committed as GL-MULLION lines, equal spacing — fix unequal ones with edit_shape), perimeter sealant.",
      "Sightline and sealant beads are arguments: take them from the spec section.",
    ].join("\n"),
    presets: [
      { tag: "GL-<type>", measure: "area", what: "frame openings on elevations, one tag per frame type" },
    ],
  },
  {
    id: "doors",
    label: "Doors, frames & hardware",
    prefixes: ["DR-", "HW-"],
    divisions: ["08"],
    summary: "doors per type and size from the door schedule, matched to tags on the plans: core tools",
    tools: [],
    method: [
      "find_schedule for the door schedule; sweep_schedule_row per door type to count its tags on the plans (it withholds a tag with no schedule row: report those).",
      "count_marks {commit:true} when tags carry values. Each scheduled door number counts once; a door on the schedule but on no plan is counted from the schedule and named.",
      "Hardware sets: one condition per set, counted from the schedule's HW column.",
    ].join("\n"),
    presets: [],
  },
  {
    id: "plumbing",
    label: "Plumbing",
    prefixes: ["P-"],
    divisions: ["22"],
    summary: "fixture counts checked against the schedule QTY, pipe LF by system/size, hangers, fittings, insulation",
    tools: ["plumbing_rollup"],
    method: [
      "Fixtures: find_schedule for the plumbing fixture schedule; count each mark with sweep_schedule_row or count_marks under P-<mark> (P-WC1, P-LAV1).",
      "Pipe: measure_line runs by system and size under P-<system>-<size> (P-CW-3/4, P-SAN-4). Risers: edit_condition rise_ft / drop_ft.",
      "plumbing_rollup {fixtures: [{condition, schedule_qty}], pipes: [{condition, hanger_every_ft}]}: checks counts against the schedule (carries the plan count, the schedule QTY only when nothing is tagged, and names every difference), and figures hangers, fittings and insulation.",
      "Hanger spacing and insulation come from the spec. Rough-in, equipment and pricing are not part of this suite.",
    ].join("\n"),
    presets: [
      { tag: "P-<mark>", measure: "count", what: "fixtures, one tag per schedule mark" },
      { tag: "P-<system>-<size>", measure: "line", what: "pipe runs by system and size" },
    ],
  },
  {
    id: "electrical",
    label: "Electrical & low voltage",
    prefixes: ["E-", "FA-", "LV-"],
    divisions: ["26", "27", "28"],
    summary: "legend devices and fixtures counted, conduit LF with drops, wire LF by conductors, boxes, whips",
    tools: ["electrical_rollup"],
    method: [
      "Devices drawn as legend symbols: symbol_sweep seeded on the legend symbol under E-<device> (E-DUP, E-SW, E-DATA, FA-HORN). Read every withheld near-match before counting it.",
      "Tagged light fixtures: sweep_schedule_row from the light fixture schedule under E-FIX-<mark>.",
      "Conduit / branch runs: measure_line under E-<run> (E-BR-20A, E-FEED-P1). Drops to devices: edit_condition drop_ft, so every run carries them.",
      "electrical_rollup {runs: [{condition, conductors}], devices, fixtures}: wire LF per run, couplings, straps, boxes and plates per device, fixture whips; apply:true writes them as material rows so they land in the estimate.",
      "Panel schedules: find_schedule. Circuits the drawings leave unclear go to the person, not into the total.",
    ].join("\n"),
    presets: [
      { tag: "E-<device>", measure: "count", what: "legend devices (receptacles, switches, data, fire alarm)" },
      { tag: "E-FIX-<mark>", measure: "count", what: "light fixtures by schedule mark" },
      { tag: "E-<run>", measure: "line", what: "conduit / branch runs" },
    ],
  },
]);

const BY_ID = new Map(TRADE_SUITES.map((s) => [s.id, s]));

export function suiteById(id: string): TradeSuite | undefined {
  return BY_ID.get(id);
}

/** Two-digit division ("7", "07", "07 46 00", "Div 26") → its suites. */
export function suitesForDivision(raw: string): TradeSuite[] {
  const m = String(raw).match(/(\d{1,2})/);
  if (!m) return [];
  const div = m[1].padStart(2, "0");
  return TRADE_SUITES.filter((s) => s.divisions.includes(div));
}

/** Every tool any suite adds, sorted. */
export const SUITE_TOOL_NAMES: readonly string[] = Object.freeze([...new Set(TRADE_SUITES.flatMap((s) => s.tools))].sort());

/** The suite that owns a suite tool. */
export function suiteOfTool(tool: string): TradeSuite | undefined {
  return TRADE_SUITES.find((s) => s.tools.includes(tool));
}

/** The catalog an agent reads before opening anything: one line per suite. */
export function suiteCatalogLines(): string[] {
  return TRADE_SUITES.map((s) => `${s.id} (Div ${s.divisions.join("/")}): ${s.summary}`);
}

// ── The canvas trade view ──────────────────────────────────────────────────
// A condition's trade is its own `trade` field when that names a suite, else
// the suite whose tag prefix it carries (RF-…, SD-…), else Finishes: a takeoff
// from before suites existed is a finishes takeoff. The view is a filter only:
// it hides other trades' conditions and shapes, never a quantity.

export const ALL_TRADES = "all";

export function conditionTrade(c: { trade?: unknown; finish_tag?: unknown } | null | undefined): string {
  if (c && typeof c.trade === "string" && BY_ID.has(c.trade)) return c.trade;
  const tag = String(c?.finish_tag ?? "").trim().toUpperCase();
  for (const s of TRADE_SUITES) if (s.prefixes.some((p) => tag.startsWith(p))) return s.id;
  return "finishes";
}

/** Ids of the conditions a trade view hides ("all" hides none). */
export function tradeHiddenIds(conditions: readonly { id: string; trade?: unknown; finish_tag?: unknown }[], view: string): Set<string> {
  if (!view || view === ALL_TRADES || !BY_ID.has(view)) return new Set();
  return new Set(conditions.filter((c) => conditionTrade(c) !== view).map((c) => c.id));
}

/** Conditions per trade, for the picker's counts. */
export function tradeCounts(conditions: readonly { trade?: unknown; finish_tag?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of conditions) { const t = conditionTrade(c); out[t] = (out[t] ?? 0) + 1; }
  return out;
}

/** A stored view value, or "all" for anything that is not a suite id. */
export function sanitizeViewTrade(raw: unknown): string {
  return typeof raw === "string" && BY_ID.has(raw) ? raw : ALL_TRADES;
}
