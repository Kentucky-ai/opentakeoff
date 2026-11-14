// Trade suites over MCP — open_suite plus one tool per trade that needs one.
//
// The registry is web/src/lib/tradeSuites.ts and the math is
// web/src/lib/suiteMath.ts, both pure, so the canvas can reuse them. This file
// only wires them to the session.
//
// Context budget, by design:
//   - initialize instructions: one line naming open_suite
//   - open_suite's description: one line per suite (the catalog)
//   - a suite's own tools are registered DISABLED and appear in tools/list
//     only after open_suite enables them (tools/list_changed), so an agent
//     doing a roof never carries the plumbing schemas
//   - a suite's method is returned once, by open_suite, not on every turn
//   - the long form lives in takeoff://wiki/suites
// A client that cannot refresh its tool list can pre-open suites with
// OPENTAKEOFF_MCP_SUITES=roofing,siding (or =all).
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, UserError, type ToolReply } from "./format.ts";
import { traceToolCall } from "./trace.ts";
import type { Session, MeasureRole } from "./session.ts";
import {
  TRADE_SUITES, DIVISIONS, SUITE_TOOL_NAMES, suiteById, suitesForDivision, suiteOfTool, suiteCatalogLines, type TradeSuite,
} from "../../web/src/lib/tradeSuites.ts";
import { M_PER_FT, MM_PER_IN, SUITE_UNIT_PAIRS, suiteMetricName, suiteMetricReply } from "../../web/src/lib/units.ts";
import {
  parsePitch, roofQuantities, slopeFactor, hipValleyFactor, sidingQuantities, bottomEdges, starterRuns, soffitQuantities,
  glazingOpening, electricalRollup, plumbingRollup, ringPerimeter, type Pt,
} from "../../web/src/lib/suiteMath.ts";

export { SUITE_TOOL_NAMES };

const SUITE_IDS = TRADE_SUITES.map((s) => s.id) as [string, ...string[]];

/** One line for the initialize instructions. */
export const SUITE_INSTRUCTIONS =
  "TRADE SUITES: roofing, siding, soffit & fascia, glazing, plumbing and electrical tools stay hidden until you call open_suite {suite} or {division:\"07\"}; it enables that trade's tools and returns its method. Open only the trade you are taking off.";

const run = (tool: string, fn: (args: any) => unknown | Promise<unknown>) =>
  async (args: any): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try { reply = ok(await fn(args)); } catch (e) { reply = fail(e); }
    traceToolCall(tool, args, startedAt, reply);
    return reply;
  };

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── units (#620) ─────────────────────────────────────────────────────────────
// Inside, every suite tool works in feet, inches and SF. `units: "metric"`
// changes only the edges: arguments named in mm, m and m², and a reply in m²
// and m (web/src/lib/units.ts holds the one table). Stored quantities are the
// same either way. The server holds no project unit setting (exportPayload
// writes imperial), so a call that names none is imperial, as before.
type Units = "imperial" | "metric";
const unitsArg = z.enum(["imperial", "metric"]).optional()
  .describe('"metric": arguments in mm, mm², m and m² (overhang_mm, piece_length_m) and a reply in the same units, without roofing or siding squares. Absent = imperial');

/** The imperial value of a unit-bearing argument, given under its imperial name or, with units "metric",
 *  its metric one. A name from the other system is refused, naming the right one. */
function unitArg(args: Record<string, unknown> | undefined, name: string, units: Units, path = ""): number | undefined {
  const metric = suiteMetricName(name)!;
  const factor = SUITE_UNIT_PAIRS.find((p) => name.endsWith(p.imperial))!.factor;
  if (units === "metric" && args?.[name] !== undefined) throw new UserError(`${path}${name} is imperial; with units "metric" pass ${path}${metric}.`);
  if (units === "imperial" && args?.[metric] !== undefined) throw new UserError(`${path}${metric} is metric; pass units: "metric" with it, or use ${path}${name}.`);
  const v = args?.[units === "metric" ? metric : name];
  return typeof v === "number" ? (units === "metric" ? v / factor : v) : undefined;
}

/** The arguments a tool's schema does not name, with their paths ("vent.attic_sqft"). */
function unknownArgs(value: unknown, schema: z.ZodType, path = ""): string[] {
  let s: any = schema;
  while (["optional", "default", "nullable", "prefault"].includes(s?.def?.type)) s = s.def.innerType;
  if (s?.def?.type === "array" && Array.isArray(value)) return value.flatMap((v, i) => unknownArgs(v, s.def.element, `${path}[${i}]`));
  if (s?.def?.type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const at = path ? `${path}.${k}` : k;
    return Object.hasOwn(s.def.shape, k) ? unknownArgs(v, s.def.shape[k], at) : [at];
  });
}

/** A suite tool's handler: the reply in the caller's units, which it always names, and the arguments it
 *  ignored named back instead of dropped, in a refusal too (a misplaced argument often causes one). */
const suiteRun = (tool: string, schema: z.ZodType, fn: (args: any, units: Units) => Record<string, unknown>) =>
  run(tool, (a: any) => {
    const units: Units = a.units ?? "imperial";
    const ignored = unknownArgs(a, schema);
    const note = `Not ${tool} arguments, so ignored: ${ignored.join(", ")}.`;
    let reply: Record<string, unknown>;
    try { reply = fn(a, units); } catch (e) {
      if (ignored.length && e instanceof UserError) e.message += ` ${note}`;
      throw e;
    }
    const out = (units === "metric" ? suiteMetricReply(reply) : reply) as Record<string, unknown>;
    if (!ignored.length) return { ...out, units };
    return { ...out, units, unknown_args: ignored, next: `${note} ${out.next}` };
  });

/** A length for a material row's note, in the units the caller named it in. */
const noteLen = (ft: number, units: Units) => (units === "metric" ? `${r2(ft * M_PER_FT)} m` : `${ft} LF`);
const lenPx = (pts: Pt[]) => { let n = 0; for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return n; };
/** A linear shape's plan length (its legs left out). */
const planLf = (c: { plan_lf?: number; perimeter_lf?: number }) => c.plan_lf ?? c.perimeter_lf ?? 0;

/** Pre-opened suites: an explicit option wins, then OPENTAKEOFF_MCP_SUITES. */
export function preopenedSuites(opt?: string[] | "all"): string[] {
  const raw = opt ?? (process.env.OPENTAKEOFF_MCP_SUITES ? process.env.OPENTAKEOFF_MCP_SUITES.split(",").map((s) => s.trim()).filter(Boolean) : []);
  if (raw === "all" || (Array.isArray(raw) && raw.includes("all"))) return TRADE_SUITES.map((s) => s.id);
  return (raw as string[]).filter((id) => suiteById(id));
}

// ── outputs (loose: the payloads are the suiteMath records) ─────────────────
const anyRecord = z.record(z.string(), z.unknown());
const openSuiteOutput = {
  opened: z.array(z.string()).describe("Suites opened by this call (empty when listing)"),
  tools_enabled: z.array(z.string()).describe("Tools that just became available"),
  open_suites: z.array(z.string()),
  catalog: z.array(anyRecord).optional().describe("Every suite, one row each, when called without suite/division"),
  suites: z.array(anyRecord).optional().describe("Each opened suite's method and condition presets"),
  next: z.string(),
};
const deriveOutput = {
  units: z.enum(["imperial", "metric"]).describe("The unit system of the arguments and this reply"),
  unknown_args: z.array(z.string()).optional().describe("Arguments this tool does not take, ignored"),
  committed: z.number().int().describe("Shapes this call committed (0 for a preview)"),
  undo_steps: z.number().int().describe("undo_last {n} that takes this whole call back"),
  next: z.string(),
};

export function registerSuites(stageServer: { registerTool: (n: string, m: unknown, h: unknown) => RegisteredTool }, realServer: McpServer, session: Session, opts: { suites?: string[] | "all" } = {}): Map<string, RegisteredTool> {
  const suiteTools = new Map<string, RegisteredTool>();
  const open = new Set<string>();
  const reg = (name: string, meta: unknown, handler: unknown) => {
    const t = (realServer.registerTool as (n: string, m: unknown, h: unknown) => RegisteredTool)(name, meta, handler);
    suiteTools.set(name, t);
    return t;
  };

  const openOne = (s: TradeSuite): string[] => {
    const enabled: string[] = [];
    for (const name of s.tools) {
      const t = suiteTools.get(name);
      if (t && !t.enabled) { t.enable(); enabled.push(name); }
    }
    open.add(s.id);
    return enabled;
  };

  stageServer.registerTool("open_suite", {
    description: [
      "Open a trade suite: enables that trade's tools (they are hidden until opened) and returns its method and condition names. Open only the trade you are taking off; opening is idempotent and never closes anything. No arguments = the catalog. Suites:",
      ...suiteCatalogLines().map((l) => `- ${l}`),
      "division opens every suite of a CSI division (\"07\" = roofing + siding + soffit_fascia).",
    ].join("\n"),
    inputSchema: {
      suite: z.enum(SUITE_IDS).optional().describe("Suite id"),
      division: z.string().optional().describe('CSI division, e.g. "07", "08", "22", "26"'),
    },
    outputSchema: openSuiteOutput,
  }, run("open_suite", ({ suite, division }: { suite?: string; division?: string }) => {
    let picked: TradeSuite[] = [];
    if (suite) picked.push(suiteById(suite)!);
    if (division) {
      const d = suitesForDivision(division);
      if (!d.length) throw new UserError(`No suite answers to division ${JSON.stringify(division)}. Divisions with suites: ${Object.entries(DIVISIONS).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
      picked.push(...d);
    }
    picked = [...new Set(picked)];
    if (!picked.length) {
      return {
        opened: [], tools_enabled: [], open_suites: [...open],
        catalog: TRADE_SUITES.map((s) => ({ id: s.id, label: s.label, divisions: s.divisions, summary: s.summary, tools: s.tools, open: open.has(s.id) })),
        next: "Call open_suite {suite} for the trade you are taking off.",
      };
    }
    const enabled = picked.flatMap(openOne);
    return {
      opened: picked.map((s) => s.id),
      tools_enabled: enabled,
      open_suites: [...open],
      suites: picked.map((s) => ({ id: s.id, label: s.label, divisions: s.divisions, tools: s.tools, method: s.method, presets: s.presets })),
      next: picked.some((s) => s.tools.length)
        ? "Follow the method. If the new tools are not in your tool list yet, your client did not refresh it: ask the person to restart it with OPENTAKEOFF_MCP_SUITES set."
        : "This trade uses core tools only; follow the method.",
    };
  }));

  const conditionOrError = (tag: string, what: string) => {
    if (!session.hasCondition(tag)) throw new UserError(`No ${what} condition ${JSON.stringify(tag)} yet — measure it first (open_suite returns the method), or pass the tag you used.`);
  };
  /** Shapes of `tag` already derived by `tool` from each source id — re-runs skip them. */
  const derivedFrom = (tool: string, tags: string[]) => {
    const seen = new Set<string>();
    for (const t of tags) for (const { shape } of session.suiteShapes(t)) {
      const d = shape.origin?.derived as { suite_tool?: string; from_shape_id?: string } | undefined;
      if (d?.suite_tool === tool && d.from_shape_id) seen.add(`${t}|${d.from_shape_id}`);
    }
    return seen;
  };

  // ── roofing ───────────────────────────────────────────────────────────────
  const roofInput = z.looseObject({
    pitch: z.union([z.string(), z.number()]).describe('Slope from the drawings: "6/12", 6, "1/4 per ft", "2%", "22.5 deg", "1:48", or "1/4:12"'),
    field: z.string().default("RF-FIELD").describe("Condition holding the roof planes (plan view)"),
    eave: z.string().default("RF-EAVE"), rake: z.string().default("RF-RAKE"), ridge: z.string().default("RF-RIDGE"),
    hip: z.string().default("RF-HIP"), valley: z.string().default("RF-VALLEY"),
    waste_pct: z.number().min(0).max(50).optional().describe("Field waste; absent = suite allowance (10, or 15 with hips/valleys), reported as an allowance"),
    ice_water: z.looseObject({
      eave_ft: z.number().positive().optional(), valley_ft: z.number().positive().optional(),
      eave_m: z.number().positive().optional(), valley_m: z.number().positive().optional(),
    }).optional().describe("Self-adhered underlayment band widths up the slope, from the spec or code (feet, or metres with units metric)"),
    buildings: z.number().int().positive().default(1).describe("Identical buildings: folded into the multipliers"),
    apply: z.boolean().default(true).describe("false = report only"),
    units: unitsArg,
  });
  reg("roof_takeoff", {
    description: "Roofing suite. Turns the traced plan-view roof into true quantities for ONE pitch: sloped SF and squares (with waste), true rake / hip / valley LF, drip edge, starter, ridge cap, underlayment, ice & water when band widths are given. apply (default true) puts the slope factor on the field and rake conditions and the hip/valley factor on hip and valley so every total reads true, sets the field waste, and commits drip edge (RF-DRIP), starter (RF-STARTER) and ridge cap (RF-CAP) runs at true length. Re-running skips runs it already derived. pitch must come from the drawings.",
    inputSchema: roofInput,
    outputSchema: { ...deriveOutput, sloped_sf: z.number().optional(), sloped_m2: z.number().optional(), squares: z.number().optional() },
  }, suiteRun("roof_takeoff", roofInput, (a, units) => {
    const pitch = parsePitch(a.pitch);
    if (pitch === null) throw new UserError(`Cannot read pitch ${JSON.stringify(a.pitch)} — pass "6/12", 6, "1/4 per ft", "2%", "22.5 deg", "1:48", or "1/4:12" as printed on the roof plan.`);
    conditionOrError(a.field, "roof field");
    const field = session.suiteShapes(a.field, ["floor_area", "deduct"]);
    const planSf = field.reduce((n, { shape }) => n + (shape.measure_role === "deduct" ? (shape.cuts_shape_id ? 0 : -1) : 1) * (shape.computed.area_sf ?? 0), 0);
    if (!(planSf > 0)) throw new UserError(`${a.field} has no roof area — measure_polygon the roof planes under it first.`);
    const edgeTags = { eave: a.eave, rake: a.rake, ridge: a.ridge, hip: a.hip, valley: a.valley } as Record<string, string>;
    const edgeShapes = Object.fromEntries(Object.entries(edgeTags).map(([k, t]) => [k, session.suiteShapes(t, ["linear"])]));
    const edges = Object.fromEntries(Object.entries(edgeShapes).map(([k, list]) => [k, list.reduce((n, { shape }) => n + planLf(shape.computed), 0)])) as { eave: number; rake: number; ridge: number; hip: number; valley: number };
    const iceWater = a.ice_water && {
      eave_ft: unitArg(a.ice_water, "eave_ft", units, "ice_water."),
      valley_ft: unitArg(a.ice_water, "valley_ft", units, "ice_water."),
    };
    const q = roofQuantities({ pitch, plan_sf: planSf, edges, waste_pct: a.waste_pct, ice_water: iceWater });
    let committed = 0, steps = 0;
    const applied: Record<string, number> = {};
    if (a.apply) {
      const sf = slopeFactor(pitch), hf = hipValleyFactor(pitch), n = a.buildings;
      session.editCondition(a.field, { multiplier: r2c(sf * n), waste_pct: q.waste_pct }); steps++; applied[a.field] = r2c(sf * n);
      // level edges (eave, ridge) are already true: they get a write only to carry identical buildings
      for (const [k, factor] of [["rake", sf], ["hip", hf], ["valley", hf], ["eave", 1], ["ridge", 1]] as const) {
        if (!session.hasCondition(edgeTags[k]) || !edgeShapes[k].length || (factor === 1 && n === 1)) continue;
        session.editCondition(edgeTags[k], { multiplier: r2c(factor * n) }); steps++; applied[edgeTags[k]] = r2c(factor * n);
      }
      const done = derivedFrom("roof_takeoff", ["RF-DRIP", "RF-STARTER", "RF-CAP"]);
      const items: Parameters<Session["suiteCommit"]>[1] = [];
      const add = (tag: string, kind: string, factor: number) => {
        for (const { shape, px } of edgeShapes[kind]) {
          if (done.has(`${tag}|${shape.id}`)) continue;
          const lf = r2(planLf(shape.computed) * factor);
          items.push({ sheet_id: shape.sheet_id, tag, role: "linear", px, computed: { area_sf: 0, perimeter_lf: lf }, derived: { from_shape_id: shape.id, edge: kind, pitch: q.pitch, factor: r2c(factor) } });
        }
      };
      add("RF-DRIP", "eave", 1); add("RF-DRIP", "rake", sf);
      add("RF-STARTER", "eave", 1);
      add("RF-CAP", "ridge", 1); add("RF-CAP", "hip", hf);
      if (items.length) { session.suiteCommit("roof_takeoff", items); committed = items.length; steps++; }
    }
    return {
      ...q, pitch_as_given: a.pitch, committed, undo_steps: steps, ...(a.apply ? { multipliers_set: applied } : {}),
      next: a.apply
        ? "view_sheet overlay:true on the roof to check the derived runs; count penetrations under RF-PEN-<type>; export_report carries the true totals."
        : "Report only — call again with apply:true to write the slope factors and commit the accessory runs.",
    };
  }));

  // ── siding ────────────────────────────────────────────────────────────────
  const sidingInput = z.looseObject({
    walls: z.string().default("SD-WALL"), openings: z.string().default("SD-OPEN"),
    outside_corners: z.string().default("SD-OSC"), inside_corners: z.string().default("SD-ISC"),
    door_openings: z.array(z.string()).default([]).describe("Shape ids of DOOR openings (trimmed on 3 sides)"),
    waste_pct: z.number().min(0).max(50).optional().describe("Absent = 10 % suite allowance, reported as an allowance"),
    exposure_in: z.number().positive().optional().describe("Lap reveal, inches"),
    piece_length_ft: z.number().positive().optional().describe("Piece length, feet"),
    exposure_mm: z.number().positive().optional().describe("Lap reveal, mm (units metric)"),
    piece_length_m: z.number().positive().optional().describe("Piece length, m (units metric)"),
    apply: z.boolean().default(true),
    units: unitsArg,
  });
  reg("siding_takeoff", {
    description: "Siding suite. From elevation shapes: gross and net wall SF, squares with waste, opening trim LF (doors 3 sides, windows 4), starter LF along each wall's bottom edge, corner LF, and lap pieces when exposure_in and piece_length_ft are given. Openings are deduct shapes on the wall condition and/or shapes on the openings condition. apply (default true) sets the wall waste, adds a deduct on the wall condition for each opening traced under the openings condition (so the estimate is net), and commits opening trim (SD-TRIM) and starter (SD-STARTER) runs. Re-running skips what it already derived.",
    inputSchema: sidingInput,
    outputSchema: { ...deriveOutput, net_sf: z.number().optional(), net_m2: z.number().optional(), squares: z.number().optional() },
  }, suiteRun("siding_takeoff", sidingInput, (a, units) => {
    conditionOrError(a.walls, "wall");
    const walls = session.suiteShapes(a.walls, ["floor_area"]);
    if (!walls.length) throw new UserError(`${a.walls} has no wall faces — measure_polygon each elevation face under it.`);
    const separate = session.suiteShapes(a.openings, ["floor_area", "deduct"]);
    // a deduct this tool copied from a separately traced opening is that opening, not a second one
    const sepIds = new Set(separate.map((o) => o.shape.id));
    const deducts = session.suiteShapes(a.walls, ["deduct"])
      .filter((d) => !sepIds.has(String((d.shape.origin?.derived as { from_shape_id?: string } | undefined)?.from_shape_id ?? "")));
    const doors = new Set<string>(a.door_openings);
    const known = new Set([...deducts, ...separate].map((o) => o.shape.id));
    const bad = a.door_openings.filter((id: string) => !known.has(id));
    if (bad.length) throw new UserError(`door_openings ${bad.join(", ")} are not opening shapes — list_shapes for the ids under ${a.walls} (deduct) or ${a.openings}.`);
    const openings = [...deducts, ...separate];
    const q = sidingQuantities({
      walls: walls.map((w) => ({ id: w.shape.id, ring: w.ft, sheet: w.shape.sheet_id })),
      openings: openings.map((o) => ({ id: o.shape.id, ring: o.ft, sides: doors.has(o.shape.id) ? 3 : 4, sheet: o.shape.sheet_id })),
      outside_corner_lf: session.suiteTotals(a.outside_corners)?.lf,
      inside_corner_lf: session.suiteTotals(a.inside_corners)?.lf,
      waste_pct: a.waste_pct, exposure_in: unitArg(a, "exposure_in", units), piece_length_ft: unitArg(a, "piece_length_ft", units),
    });
    let committed = 0, steps = 0;
    if (a.apply) {
      session.editCondition(a.walls, { waste_pct: q.waste_pct }); steps++;
      const done = derivedFrom("siding_takeoff", [a.walls, "SD-TRIM", "SD-STARTER"]);
      const items: Parameters<Session["suiteCommit"]>[1] = [];
      for (const o of separate) {
        if (done.has(`${a.walls}|${o.shape.id}`)) continue;
        items.push({ sheet_id: o.shape.sheet_id, tag: a.walls, role: "deduct", px: o.px, computed: { area_sf: o.shape.computed.area_sf ?? 0, perimeter_lf: o.shape.computed.perimeter_lf ?? 0 }, derived: { from_shape_id: o.shape.id, opening: true } });
      }
      for (const o of openings) {
        if (done.has(`SD-TRIM|${o.shape.id}`)) continue;
        for (const path of trimPaths(o.px, doors.has(o.shape.id), 0.5 / o.upp)) {
          items.push({ sheet_id: o.shape.sheet_id, tag: "SD-TRIM", role: "linear", px: path, computed: { area_sf: 0, perimeter_lf: r2(lenPx(path) * o.upp) }, derived: { from_shape_id: o.shape.id, sides: doors.has(o.shape.id) ? 3 : 4 } });
        }
      }
      for (const w of walls) {
        if (done.has(`SD-STARTER|${w.shape.id}`)) continue;
        const doorPx = openings.filter((o) => doors.has(o.shape.id) && o.shape.sheet_id === w.shape.sheet_id).map((o) => o.px);
        for (const [p, q2] of starterRuns(w.px, doorPx, 0.5 / w.upp)) {
          items.push({ sheet_id: w.shape.sheet_id, tag: "SD-STARTER", role: "linear", px: [p, q2], computed: { area_sf: 0, perimeter_lf: r2(lenPx([p, q2]) * w.upp) }, derived: { from_shape_id: w.shape.id } });
        }
      }
      if (items.length) { session.suiteCommit("siding_takeoff", items); committed = items.length; steps++; }
    }
    // the piece text quotes the reveal and length; in metric, as the caller gave them
    const piece = units === "metric" && q.piece ? { piece: `${a.exposure_mm} mm reveal × ${a.piece_length_m} m piece, waste included` } : {};
    return { ...q, ...piece, committed, undo_steps: steps,
      next: "view_sheet overlay:true on each elevation: starter must sit on wall bottoms and trim around every opening. Corners not measured read 0 — measure_line them under the corner tags." };
  }));

  // ── soffit & fascia ───────────────────────────────────────────────────────
  const soffitInput = z.looseObject({
    eave: z.string().default("RF-EAVE"), rake: z.string().default("RF-RAKE"),
    overhang_in: z.number().positive().optional().describe("Eave soffit depth, inches, wall face to fascia (wall section / eave detail); required, or overhang_mm with units metric"),
    rake_overhang_in: z.number().positive().optional().describe("Rake soffit depth, inches; absent = rake soffit not figured"),
    overhang_mm: z.number().positive().optional().describe("Eave soffit depth, mm (units metric)"),
    rake_overhang_mm: z.number().positive().optional().describe("Rake soffit depth, mm (units metric)"),
    pitch: z.union([z.string(), z.number()]).optional().describe('Roof pitch for true rake length: "6/12", 6, "1/4 per ft", "2%", "22.5 deg", "1:48", or "1/4:12"'),
    outside_corners: z.number().int().min(0).optional(),
    waste_pct: z.number().min(0).max(50).optional().describe("Absent = 10 % suite allowance"),
    vent: z.looseObject({
      attic_sf: z.number().positive().optional(), attic_m2: z.number().positive().optional(),
      attic_condition: z.string().optional().describe("Condition whose floor SF is the attic area"),
      ratio: z.number().positive().describe("150 or 300, per code/spec"), intake_share: z.number().min(0).max(1).optional(),
      nfa_in2_per_lf: z.number().positive().optional().describe("Vented soffit net free area per LF, from the product data"),
      nfa_mm2_per_m: z.number().positive().optional().describe("Vented soffit net free area per m (units metric)"),
    }).optional(),
    apply: z.boolean().default(true),
    units: unitsArg,
  });
  reg("soffit_takeoff", {
    description: "Soffit & fascia suite. From eave and rake runs (the roofing tags by default) and the soffit depth from the wall section: soffit SF (eave LF × depth, rake soffit when rake_overhang_in is given, outside-corner squares), fascia LF (true rake length with pitch), wall receiver LF, and the attic intake vent area when vent is given. apply (default true) commits the soffit as surface shapes (run × depth) under SF-SOFFIT with its waste and the fascia runs under SF-FASCIA. Re-running skips what it already derived.",
    inputSchema: soffitInput,
    outputSchema: { ...deriveOutput, soffit_sf: z.number().optional(), soffit_m2: z.number().optional(), fascia_lf: z.number().optional(), fascia_m: z.number().optional() },
  }, suiteRun("soffit_takeoff", soffitInput, (a, units) => {
    const overhangIn = unitArg(a, "overhang_in", units);
    if (overhangIn === undefined) throw new UserError(`soffit_takeoff needs the eave soffit depth: ${units === "metric" ? "overhang_mm" : "overhang_in"}, from the wall section or eave detail.`);
    const rakeOverhangIn = unitArg(a, "rake_overhang_in", units);
    conditionOrError(a.eave, "eave");
    const eaves = session.suiteShapes(a.eave, ["linear"]);
    const rakes = session.suiteShapes(a.rake, ["linear"]);
    let pitch: number | undefined;
    if (a.pitch !== undefined) {
      const p = parsePitch(a.pitch);
      if (p === null) throw new UserError(`Cannot read pitch ${JSON.stringify(a.pitch)} — pass "6/12", 6, "1/4 per ft", "2%", "22.5 deg", "1:48", or "1/4:12" as printed on the roof plan.`);
      pitch = p;
    }
    let vent: { attic_sf: number; ratio: number; intake_share?: number; nfa_in2_per_lf?: number } | undefined;
    if (a.vent) {
      const attic = unitArg(a.vent, "attic_sf", units, "vent.") ?? (a.vent.attic_condition ? session.suiteTotals(a.vent.attic_condition)?.floor_sf : undefined);
      if (!attic) throw new UserError(`vent needs ${units === "metric" ? "attic_m2" : "attic_sf"} or an attic_condition with floor area.`);
      vent = { attic_sf: attic, ratio: a.vent.ratio, intake_share: a.vent.intake_share, nfa_in2_per_lf: unitArg(a.vent, "nfa_in2_per_lf", units, "vent.") };
    }
    const eaveLf = eaves.reduce((n, { shape }) => n + planLf(shape.computed), 0);
    const rakeLf = rakes.reduce((n, { shape }) => n + planLf(shape.computed), 0);
    const q = soffitQuantities({ eave_lf: eaveLf, rake_plan_lf: rakeLf, overhang_in: overhangIn, rake_overhang_in: rakeOverhangIn, pitch, outside_corners: a.outside_corners, waste_pct: a.waste_pct, vent });
    let committed = 0, steps = 0;
    if (a.apply) {
      const rf = pitch !== undefined ? slopeFactor(pitch) : 1;
      const done = derivedFrom("soffit_takeoff", ["SF-SOFFIT", "SF-FASCIA"]);
      const items: Parameters<Session["suiteCommit"]>[1] = [];
      const d = overhangIn / 12, rd = (rakeOverhangIn ?? 0) / 12;
      for (const { shape, px } of eaves) {
        const lf = planLf(shape.computed);
        if (!done.has(`SF-SOFFIT|${shape.id}`)) items.push({ sheet_id: shape.sheet_id, tag: "SF-SOFFIT", role: "surface_area", px, computed: { area_sf: r2(lf * d), perimeter_lf: r2(lf) }, height_ft: r2c(d), derived: { from_shape_id: shape.id, depth_in: overhangIn } });
        if (!done.has(`SF-FASCIA|${shape.id}`)) items.push({ sheet_id: shape.sheet_id, tag: "SF-FASCIA", role: "linear", px, computed: { area_sf: 0, perimeter_lf: r2(lf) }, derived: { from_shape_id: shape.id } });
      }
      for (const { shape, px } of rakes) {
        const lf = planLf(shape.computed) * rf;
        if (rd > 0 && !done.has(`SF-SOFFIT|${shape.id}`)) items.push({ sheet_id: shape.sheet_id, tag: "SF-SOFFIT", role: "surface_area", px, computed: { area_sf: r2(lf * rd), perimeter_lf: r2(lf) }, height_ft: r2c(rd), derived: { from_shape_id: shape.id, depth_in: rakeOverhangIn, rake: true } });
        if (!done.has(`SF-FASCIA|${shape.id}`)) items.push({ sheet_id: shape.sheet_id, tag: "SF-FASCIA", role: "linear", px, computed: { area_sf: 0, perimeter_lf: r2(lf) }, derived: { from_shape_id: shape.id, rake: true, factor: r2c(rf) } });
      }
      if (items.length) { session.suiteCommit("soffit_takeoff", items); committed = items.length; steps++; }
      if (session.hasCondition("SF-SOFFIT")) { session.editCondition("SF-SOFFIT", { waste_pct: q.waste_pct }); steps++; }
    }
    return { ...q, committed, undo_steps: steps,
      next: q.corner_sf > 0 ? "Corner squares (corner_sf) are reported, not drawn: add them to the soffit order. view_sheet overlay:true to check the runs." : "view_sheet overlay:true to check the runs." };
  }));

  // ── glazing ───────────────────────────────────────────────────────────────
  const glazingInput = z.looseObject({
    condition: z.string().describe("The frame condition, e.g. GL-SF1"),
    grid: z.array(z.looseObject({ shape_id: z.string(), bays: z.number().int().positive(), rows: z.number().int().positive() })).default([]),
    default_bays: z.number().int().positive().default(1), default_rows: z.number().int().positive().default(1),
    sightline_in: z.number().min(0).optional().describe("Mullion face width, inches (spec section); absent = 2"),
    sightline_mm: z.number().min(0).optional().describe("Mullion face width, mm (units metric); absent = 50.8"),
    sealant_sides: z.number().int().min(1).max(2).default(2).describe("Perimeter beads: 1 exterior only, 2 both sides"),
    mullion_condition: z.string().default("GL-MULLION"),
    apply: z.boolean().default(true),
    units: unitsArg,
  });
  reg("glazing_takeoff", {
    description: "Glazing suite. Per storefront / curtain-wall frame traced on an elevation: width, height, lites, lite size (daylight opening), glass SF, vertical and horizontal mullion LF and perimeter sealant LF, plus totals. The grid (bays across, rows up) is read off the elevation per shape; unlisted shapes use default_bays/default_rows. apply (default true) commits equal-spaced mullion lines under mullion_condition so they show on the marked set (fix unequal spacing with edit_shape). Re-running skips frames it already derived.",
    inputSchema: glazingInput,
    outputSchema: { ...deriveOutput, totals: anyRecord },
  }, suiteRun("glazing_takeoff", glazingInput, (a, units) => {
    const sightlineIn = unitArg(a, "sightline_in", units) ?? 2;
    conditionOrError(a.condition, "frame");
    const frames = session.suiteShapes(a.condition, ["floor_area"]);
    if (!frames.length) throw new UserError(`${a.condition} has no frames — measure_polygon each frame opening on the elevation under it.`);
    const byId = new Map<string, { bays: number; rows: number }>(a.grid.map((g: { shape_id: string; bays: number; rows: number }) => [g.shape_id, g]));
    const bad = [...byId.keys()].filter((id) => !frames.some((f) => f.shape.id === id));
    if (bad.length) throw new UserError(`grid names ${bad.join(", ")}, which are not frames of ${a.condition} — list_shapes for the ids.`);
    const rows = frames.map((f) => {
      const g = byId.get(f.shape.id) ?? { bays: a.default_bays, rows: a.default_rows };
      return { f, o: glazingOpening({ id: f.shape.id, ring: f.ft, bays: g.bays, rows: g.rows, sightline_in: sightlineIn, sealant_sides: a.sealant_sides }) };
    });
    let committed = 0, steps = 0;
    if (a.apply) {
      const done = derivedFrom("glazing_takeoff", [a.mullion_condition]);
      const items: Parameters<Session["suiteCommit"]>[1] = [];
      for (const { f, o } of rows) {
        if (done.has(`${a.mullion_condition}|${f.shape.id}`)) continue;
        for (const [p, q] of o.mullions) {
          const px: Pt[] = [[p[0] / f.upp, p[1] / f.upp], [q[0] / f.upp, q[1] / f.upp]];
          items.push({ sheet_id: f.shape.sheet_id, tag: a.mullion_condition, role: "linear", px, computed: { area_sf: 0, perimeter_lf: r2(lenPx(px) * f.upp) }, derived: { from_shape_id: f.shape.id, equal_spacing: true } });
        }
      }
      if (items.length) { session.suiteCommit("glazing_takeoff", items); committed = items.length; steps++; }
    }
    // the daylight opening is text in inches; in metric, in mm
    const dlo = (t: string) => (units === "metric" ? t.replace(/(\d+(?:\.\d+)?)"/g, (_m, n) => `${Math.round(Number(n) * MM_PER_IN)} mm`) : t);
    const openings = rows.map(({ o }) => { const { mullions: _m, ...rest } = o; return { ...rest, lite_dlo: dlo(rest.lite_dlo) }; });
    const sum = (k: keyof (typeof openings)[number]) => r2(openings.reduce((n, o) => n + Number(o[k]), 0));
    return {
      openings,
      totals: { frames: openings.length, frame_sf: sum("frame_sf"), lites: sum("lites"), glass_sf: sum("glass_sf"), vertical_mullion_lf: sum("vertical_mullion_lf"), horizontal_mullion_lf: sum("horizontal_mullion_lf"), sealant_lf: sum("sealant_lf") },
      non_rectangular: openings.filter((o) => !o.rectangular).map((o) => o.id),
      committed, undo_steps: steps,
      next: "view_sheet overlay:true on each elevation: mullions are drawn at equal spacing; edit_shape any that differ. Non-rectangular frames use their bounding box for the grid.",
    };
  }));

  // ── electrical ────────────────────────────────────────────────────────────
  const electricalInput = z.looseObject({
    runs: z.array(z.looseObject({
      condition: z.string(), conductors: z.number().int().positive().default(3).describe("Conductors per set incl. neutral and ground (default 3)"),
      sets: z.number().int().positive().default(1), slack_pct: z.number().min(0).max(50).default(10).describe("Makeup and slack allowance"),
    })).default([]),
    devices: z.array(z.string()).default([]).describe("Count conditions that get a box and plate each"),
    fixtures: z.array(z.looseObject({
      condition: z.string(),
      whip_ft: z.number().positive().optional().describe("Whip per fixture, feet; absent = 6"),
      whip_m: z.number().positive().optional().describe("Whip per fixture, m (units metric); absent = 1.83"),
    })).default([]),
    coupling_every_ft: z.number().positive().optional().describe("Conduit stick length, feet; absent = 10"),
    strap_every_ft: z.number().positive().optional().describe("Support spacing (spec / code), feet; absent = 10"),
    coupling_every_m: z.number().positive().optional().describe("Conduit stick length, m (units metric); absent = 3.05"),
    strap_every_m: z.number().positive().optional().describe("Support spacing, m (units metric); absent = 3.05"),
    apply: z.boolean().default(true),
    units: unitsArg,
  });
  reg("electrical_rollup", {
    description: "Electrical suite. From committed runs, device counts and fixture counts: wire LF per run (conduit LF incl. rise/drop × conductors × sets × slack), couplings and straps, a box and plate per device, fixture whip LF. apply (default true) writes these as material rows on each condition (updating rows it wrote before, never duplicating), so they land in the report and estimate. Conductors, slack, whip length and spacing are arguments with stated defaults; take them from the drawings and spec.",
    inputSchema: electricalInput,
    outputSchema: { ...deriveOutput, totals: anyRecord },
  }, suiteRun("electrical_rollup", electricalInput, (a, units) => {
    const couplingEvery = unitArg(a, "coupling_every_ft", units) ?? 10;
    const strapEvery = unitArg(a, "strap_every_ft", units) ?? 10;
    const whips = a.fixtures.map((x: Record<string, unknown>, i: number) => unitArg(x, "whip_ft", units, `fixtures[${i}].`) ?? 6);
    if (!a.runs.length && !a.devices.length && !a.fixtures.length) throw new UserError("Nothing to roll up — pass runs, devices and/or fixtures (condition tags).");
    for (const r of a.runs) conditionOrError(r.condition, "run");
    for (const d of a.devices) conditionOrError(d, "device");
    for (const x of a.fixtures) conditionOrError(x.condition, "fixture");
    const q = electricalRollup({
      runs: a.runs.map((r: { condition: string; conductors: number; sets: number; slack_pct: number }) => ({ tag: r.condition, conduit_lf: session.suiteTotals(r.condition)!.lf, conductors: r.conductors, sets: r.sets, slack_pct: r.slack_pct })),
      devices: a.devices.map((d: string) => ({ tag: d, ea: session.suiteTotals(d)!.ea })),
      fixtures: a.fixtures.map((x: { condition: string }, i: number) => ({ tag: x.condition, ea: session.suiteTotals(x.condition)!.ea, whip_ft: whips[i] })),
      coupling_every_ft: couplingEvery, strap_every_ft: strapEvery,
    });
    let steps = 0;
    if (a.apply) {
      for (const r of a.runs) {
        const n = r.conductors * r.sets;
        steps += upsertRows(session, r.condition, [
          { name: `Wire, ${r.conductors} conductors${r.sets > 1 ? ` × ${r.sets} sets` : ""}`, basis: "linear", per: 1 / (n * (1 + r.slack_pct / 100)), unit: "LF", round: false, note: `conduit ${units === "metric" ? "length" : "LF"} × ${n} × ${1 + r.slack_pct / 100} slack (electrical_rollup)` },
          { name: "Conduit couplings", basis: "linear", per: couplingEvery, unit: "EA", round: true, note: `1 per ${noteLen(couplingEvery, units)} (electrical_rollup)` },
          { name: "Conduit straps", basis: "linear", per: strapEvery, unit: "EA", round: true, note: `1 per ${noteLen(strapEvery, units)} (electrical_rollup)` },
        ]);
      }
      for (const d of a.devices) {
        steps += upsertRows(session, d, [
          { name: "Device box", basis: "count", per: 1, unit: "EA", round: true, note: "1 per device (electrical_rollup)" },
          { name: "Cover plate", basis: "count", per: 1, unit: "EA", round: true, note: "1 per device (electrical_rollup)" },
        ]);
      }
      a.fixtures.forEach((x: { condition: string }, i: number) => {
        steps += upsertRows(session, x.condition, [
          { name: "Fixture whip", basis: "count", per: 1 / whips[i], unit: "LF", round: false, note: `${noteLen(whips[i], units)} per fixture (electrical_rollup)` },
        ]);
      });
    }
    return { ...q, committed: 0, undo_steps: steps,
      next: a.apply ? "export_report shows the rows in each condition's buy list; set_pricing prices them." : "Report only — apply:true writes the material rows." };
  }));

  // ── plumbing ──────────────────────────────────────────────────────────────
  const plumbingInput = z.looseObject({
    fixtures: z.array(z.looseObject({ condition: z.string(), schedule_qty: z.number().int().min(0).optional().describe("QTY column of the fixture schedule") })).default([]),
    pipes: z.array(z.looseObject({
      condition: z.string(),
      hanger_every_ft: z.number().positive().optional(), hanger_every_m: z.number().positive().optional().describe("Hanger spacing, m (units metric)"),
      fittings_per_100_lf: z.number().positive().optional().describe("Fittings allowance per 100 LF"),
      fittings_per_100_m: z.number().positive().optional().describe("Fittings allowance per 100 m (units metric)"),
      insulate: z.boolean().optional(),
    })).default([]),
    apply: z.boolean().default(true),
    units: unitsArg,
  });
  reg("plumbing_rollup", {
    description: "Plumbing suite. Fixture counts checked against the fixture schedule's QTY (carries the plan count; the schedule QTY only when no tag was counted; every difference listed in needs_you), and per pipe run: LF, hangers at the spec spacing, a fittings allowance, insulation LF. apply (default true) writes hangers / fittings / insulation as material rows on each pipe condition (updating rows it wrote before). Hanger spacing and insulation come from the spec: a run without hanger_every_ft is reported as not figured.",
    inputSchema: plumbingInput,
    outputSchema: { ...deriveOutput, totals: anyRecord },
  }, suiteRun("plumbing_rollup", plumbingInput, (a, units) => {
    const pipes = a.pipes.map((p: { condition: string; insulate?: boolean }, i: number) => ({
      condition: p.condition, insulate: p.insulate,
      hanger_every_ft: unitArg(p, "hanger_every_ft", units, `pipes[${i}].`),
      fittings_per_100_lf: unitArg(p, "fittings_per_100_lf", units, `pipes[${i}].`),
      // the allowance as the caller gave it, for the row's note
      fittings_note: units === "metric" ? `${(p as Record<string, unknown>).fittings_per_100_m} per 100 m` : `${(p as Record<string, unknown>).fittings_per_100_lf} per 100 LF`,
    }));
    if (!a.fixtures.length && !a.pipes.length) throw new UserError("Nothing to roll up — pass fixtures and/or pipes (condition tags).");
    for (const x of a.fixtures) conditionOrError(x.condition, "fixture");
    for (const p of pipes) conditionOrError(p.condition, "pipe");
    const q = plumbingRollup({
      fixtures: a.fixtures.map((x: { condition: string; schedule_qty?: number }) => ({ tag: x.condition, counted: session.suiteTotals(x.condition)!.ea, schedule_qty: x.schedule_qty })),
      pipes: pipes.map((p: { condition: string; hanger_every_ft?: number; fittings_per_100_lf?: number; insulate?: boolean }) => ({ tag: p.condition, lf: session.suiteTotals(p.condition)!.lf, hanger_every_ft: p.hanger_every_ft, fittings_per_100_lf: p.fittings_per_100_lf, insulate: p.insulate })),
    });
    let steps = 0;
    if (a.apply) {
      for (const p of pipes) {
        const rows: MatRow[] = [];
        if (p.hanger_every_ft) rows.push({ name: "Pipe hangers", basis: "linear", per: p.hanger_every_ft, unit: "EA", round: true, note: `1 per ${noteLen(p.hanger_every_ft, units)} (plumbing_rollup)` });
        if (p.fittings_per_100_lf) rows.push({ name: "Fittings allowance", basis: "linear", per: 100 / p.fittings_per_100_lf, unit: "EA", round: true, note: `${p.fittings_note} (plumbing_rollup)` });
        if (p.insulate) rows.push({ name: "Pipe insulation", basis: "linear", per: 1, unit: "LF", round: false, note: "full run (plumbing_rollup)" });
        if (rows.length) steps += upsertRows(session, p.condition, rows);
      }
    }
    return { ...q, committed: 0, undo_steps: steps,
      next: q.needs_you.length ? "Settle needs_you with the estimator (or create_rfi) before the counts go out." : "Counts agree with the schedule." };
  }));

  // hidden until opened, unless pre-opened
  for (const t of suiteTools.values()) t.disable();
  for (const id of preopenedSuites(opts.suites)) openOne(suiteById(id)!);
  nameTheSuiteInRefusals(realServer);
  return suiteTools;
}

/** Six-place rounding for factors written to a condition (four places drifts a 1,000 SF roof by 0.03 SF). */
const r2c = (n: number) => Math.round(n * 1e6) / 1e6;

type MatRow = { name: string; basis: "area" | "linear" | "count"; per: number; unit: string; round: boolean; note: string };

/** Add the rows, or patch the ones this suite wrote before (same name). One journal step per condition. */
function upsertRows(session: Session, tag: string, rows: MatRow[]): number {
  const existing = session.conditionMaterials(tag);
  const add: MatRow[] = [], patch: { id: string; fields: Partial<MatRow> }[] = [];
  for (const r of rows) {
    const hit = existing.find((m) => m.name === r.name);
    if (hit) patch.push({ id: hit.id, fields: { per: r.per, basis: r.basis, unit: r.unit, round: r.round, note: r.note } });
    else add.push(r);
  }
  session.editMaterials(tag, { add, patch });
  return 1;
}

/** An opening ring as trim paths: the whole closed ring, or (a door) the ring with its bottom edge left out. */
function trimPaths(ring: Pt[], door: boolean, tolPx: number): Pt[][] {
  const p = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (!door) return [[...p, p[0]]];
  const bottoms = new Set(bottomEdges(p, tolPx).map(([a]) => p.findIndex((q) => q[0] === a[0] && q[1] === a[1])));
  if (!bottoms.size) return [[...p, p[0]]];
  const start = [...bottoms][0];
  const paths: Pt[][] = [];
  let cur: Pt[] = [];
  for (let k = 1; k <= p.length; k++) {
    const i = (start + k) % p.length;            // edge i runs p[i] → p[i+1]
    if (bottoms.has(i)) { if (cur.length > 1) paths.push(cur); cur = []; continue; }
    if (!cur.length) cur.push(p[i]);
    cur.push(p[(i + 1) % p.length]);
  }
  if (cur.length > 1) paths.push(cur);
  return paths;
}

/** A disabled suite tool's refusal names its suite and the opener (the SDK's bare "Tool X disabled" names nothing). */
function nameTheSuiteInRefusals(server: McpServer): void {
  try {
    const low = server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
    const handlers = low._requestHandlers;
    const inner = handlers?.get("tools/call");
    if (!handlers || typeof inner !== "function") return;
    const msg = (name: string) => { const s = suiteOfTool(name)!; return `Tool ${name} belongs to the ${s.label} suite, which is not open. Call open_suite {suite:"${s.id}"} and then call ${name} again.`; };
    handlers.set("tools/call", async (req: unknown, extra: unknown) => {
      const name = (req as { params?: { name?: string } })?.params?.name;
      const mine = !!name && SUITE_TOOL_NAMES.includes(name);
      const bare = new RegExp(`Tool ${name} disabled$`);
      try {
        const res = await inner(req, extra);
        const r = res as { isError?: boolean; content?: { type: string; text?: string }[] };
        if (mine && r?.isError) for (const c of r.content ?? []) if (c.type === "text" && typeof c.text === "string" && bare.test(c.text)) c.text = msg(name!);
        return res;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (mine && bare.test(m)) (e as Error).message = msg(name!);
        throw e;
      }
    });
  } catch { /* a better refusal must never break the server */ }
}

/** Exported for tests. */
export const _internal = { trimPaths, ringPerimeter };
export type { MeasureRole };
