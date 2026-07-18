// In-canvas takeoff agent — the TOOL REGISTRY. Pure-ish and Node-testable:
// every tool is a name + JSON schema + an execute(ctx, args) that closes over
// canvas-provided CAPABILITIES (the `ctx` contract below), so the registry
// itself never touches React, the DOM, or pdf.js. The model never invents
// geometry — it aims these tools, and the app's own deterministic engines
// (text layer, scheduleParse, the one-click flood fill) compute everything.
//
// Hard rules enforced HERE, not left to the model:
//   - scale gate: a tool that needs real-world units refuses on an uncalibrated
//     sheet with the same refusal the MCP scale gate uses — the agent proposes,
//     never assumes scale;
//   - propose_shapes STAGES proposals only (ctx.proposeShapes lands them in the
//     canvas's agentProposals state, never the committed shapes array) — every
//     shape passes the human accept gate;
//   - evidence is a WHITELIST (pickAgentEvidence): exactly the matched
//     schedule/room token and/or seed, strings truncated, junk keys dropped —
//     and a proposal with no surviving evidence is rejected;
//   - unknown tool or bad args → an { error } RESULT, never a throw (a bad
//     model turn must not crash the loop).
//
// ctx capability contract (the canvas builds this; tests stub it):
//   listSheets(): [{ sheet, title, width, height, scale_set, scale_source?, detected_label? }]
//   uppFor(sheet): number | null        // feet-per-px; null = no scale set
//   sheetDims(sheet): { w, h } | null   // null = sheet not open on the canvas
//   detectedLabel(sheet): string | ""   // drawn-scale note read off the page, if any
//   readSheetText(sheet, region|null): Promise<[{ text, x, y }]>  (normalized coords)
//   readSchedule(sheet, region): Promise<ScheduleRow[]>
//   viewRegion(sheet, region): Promise<{ image_data_url, width, height }>
//   oneClick(sheet, x, y): Promise<{ verts_norm, area_sf, perimeter_lf, ... } | { error }>
//   getConditions(): [{ id, finish_tag, ... }]
//   createCondition(finish_tag): { id, finish_tag }
//   proposeShapes(shapes): { staged }   // already-whitelisted proposals

// ── evidence whitelist ───────────────────────────────────────────────────────
// Mirrors contribute.js's wire-side deep whitelist byte-for-byte: applying it
// at STAGE time too means junk never even enters app state. matched_text is
// the schedule/room token the agent matched — never arbitrary sheet text.
export const AGENT_EVIDENCE_FIELDS = ["schedule_row_tag", "matched_text", "seed_norm"];
export const EVIDENCE_MAX_CHARS = 80;

/** @returns {Record<string, any> | null} whitelisted evidence, or null when nothing survives */
export function pickAgentEvidence(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of AGENT_EVIDENCE_FIELDS) {
    const v = ev[k];
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v.slice(0, EVIDENCE_MAX_CHARS) : v;
  }
  return Object.keys(out).length ? out : null;
}

// ── scale gate ───────────────────────────────────────────────────────────────
// Same refusal the MCP scale gate speaks (mcp/src/session.ts scaleGate), with
// the tail adapted to this surface: the canvas agent has no set_scale tool —
// scale is the estimator's call, made in the Scale menu or with Calibrate.
export function agentScaleGate(sheet, detectedLabel) {
  return `Set the scale for ${sheet} first — the agent never assumes a scale; ask the estimator to set it (Scale menu or Calibrate)${detectedLabel ? ` (detected: ${detectedLabel})` : ""}.`;
}

// ── minimal JSON-schema validation (the subset the registry uses) ────────────
// Checks required keys and primitive types (string/number/array/object) one
// level deep plus array item types — enough to reject a malformed model call
// with a message it can act on, without a schema-validator dependency.
const typeOf = (v) =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

export function validateToolArgs(schema, args) {
  if (!schema || schema.type !== "object") return null;
  if (args == null || typeOf(args) !== "object") return "arguments must be a JSON object";
  for (const key of schema.required || []) {
    if (args[key] === undefined) return `missing required argument: ${key}`;
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type && typeOf(v) !== spec.type) return `argument ${key} must be a ${spec.type}`;
    if (spec.type === "object" && spec.required) {
      for (const rk of spec.required) if (v[rk] === undefined) return `argument ${key} is missing ${rk}`;
    }
    if (spec.type === "array" && spec.items?.type) {
      for (const item of v) {
        if (typeOf(item) !== spec.items.type) return `argument ${key} items must be ${spec.items.type}s`;
      }
    }
    if (spec.type === "number" && spec.minimum !== undefined && v < spec.minimum) return `argument ${key} must be >= ${spec.minimum}`;
    if (spec.type === "number" && spec.maximum !== undefined && v > spec.maximum) return `argument ${key} must be <= ${spec.maximum}`;
  }
  return null;
}

// Normalized region rect — the shared sub-schema. All agent coordinates are
// normalized 0..1 against the sheet (render-scale-free, same frame as
// verts_norm), so nothing the agent says depends on raster resolution.
const REGION_SCHEMA = {
  type: "object",
  description: "Region of the sheet in normalized coordinates (0..1, origin top-left).",
  properties: {
    x0: { type: "number", minimum: 0, maximum: 1 },
    y0: { type: "number", minimum: 0, maximum: 1 },
    x1: { type: "number", minimum: 0, maximum: 1 },
    y1: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["x0", "y0", "x1", "y1"],
};

// ── the registry ─────────────────────────────────────────────────────────────
export const AGENT_TOOL_DEFS = [
  {
    name: "list_sheets",
    description: "List the sheets open on the canvas: key, title, pixel dimensions, and scale status. Tools only work on open sheets. A sheet without a scale set cannot be measured — say so and stop rather than guessing.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_sheet_text",
    description: "Read the positioned text items on a sheet (the PDF text layer): room tags, schedule cells, notes. Optionally restrict to a normalized region. Returns [{text, x, y}] with normalized coordinates.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "Sheet key from list_sheets." },
        region: { ...REGION_SCHEMA, description: "Optional region; omit for the whole sheet." },
      },
      required: ["sheet"],
    },
  },
  {
    name: "read_schedule",
    description: "Parse a finish/material schedule table inside a region of a sheet into structured rows (code, description, manufacturer, style, color, size). Draw the region around the table including its CODE / MATERIAL / ... header.",
    input_schema: {
      type: "object",
      properties: { sheet: { type: "string" }, region: REGION_SCHEMA },
      required: ["sheet", "region"],
    },
  },
  {
    name: "view_region",
    description: "Render a region of the sheet as an image and look at it. Use this for scanned sheets, hatched/ambiguous areas, or to visually confirm what a room contains before proposing.",
    input_schema: {
      type: "object",
      properties: { sheet: { type: "string" }, region: REGION_SCHEMA },
      required: ["sheet", "region"],
    },
  },
  {
    name: "one_click",
    description: "Run the deterministic flood-fill takeoff engine at a seed point inside a room (normalized coordinates). Returns the traced boundary ring (verts_norm), area_sf, perimeter_lf, and trace flags WITHOUT committing anything. This is how you measure a room — never invent geometry yourself.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        x: { type: "number", minimum: 0, maximum: 1, description: "Seed x, normalized 0..1." },
        y: { type: "number", minimum: 0, maximum: 1, description: "Seed y, normalized 0..1." },
      },
      required: ["sheet", "x", "y"],
    },
  },
  {
    name: "get_conditions",
    description: "List the takeoff conditions (finish tags) that exist in this workspace, with their ids. Proposals must reference an existing condition_id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_condition",
    description: "Create a new takeoff condition for a finish tag (e.g. CPT-1) when no existing condition matches. Returns its condition_id.",
    input_schema: {
      type: "object",
      properties: { finish_tag: { type: "string", description: "Finish code, e.g. LVT-1." } },
      required: ["finish_tag"],
    },
  },
  {
    name: "propose_shapes",
    description: "Stage takeoff proposals for human review. Each shape needs the sheet, the boundary ring from one_click (verts_norm), a condition_id, a measure_role (floor_area or deduct), and EVIDENCE: the schedule row tag and/or the matched room/finish text token and/or the one_click seed. Proposals render as dashed pencil outlines the estimator accepts or rejects — nothing you stage is committed.",
    input_schema: {
      type: "object",
      properties: {
        shapes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sheet: { type: "string" },
              verts_norm: { type: "array", description: "Boundary ring [[x,y],...] normalized 0..1 — use the ring one_click returned." },
              condition_id: { type: "string" },
              measure_role: { type: "string", description: "floor_area or deduct" },
              evidence: {
                type: "object",
                description: "Why this shape: {schedule_row_tag?, matched_text?, seed_norm?}. matched_text is the matched token only (a room tag or schedule cell), never a transcription.",
                properties: {
                  schedule_row_tag: { type: "string" },
                  matched_text: { type: "string" },
                  seed_norm: { type: "array" },
                },
              },
            },
            required: ["sheet", "verts_norm", "condition_id", "measure_role", "evidence"],
          },
        },
      },
      required: ["shapes"],
    },
  },
];

const DEFS_BY_NAME = Object.fromEntries(AGENT_TOOL_DEFS.map((d) => [d.name, d]));

const clampRegion = (r) => ({
  x0: Math.max(0, Math.min(1, Math.min(r.x0, r.x1))),
  y0: Math.max(0, Math.min(1, Math.min(r.y0, r.y1))),
  x1: Math.max(0, Math.min(1, Math.max(r.x0, r.x1))),
  y1: Math.max(0, Math.min(1, Math.max(r.y0, r.y1))),
});

const MEASURE_ROLES = new Set(["floor_area", "deduct"]);

/**
 * Execute one tool call. NEVER throws — every failure comes back as an
 * `{ error }` result the loop feeds to the model as a tool result, so a bad
 * call is a correctable turn, not a crashed run.
 * @returns {Promise<Record<string, any>>}
 */
export async function executeAgentTool(ctx, name, args) {
  const def = DEFS_BY_NAME[name];
  if (!def) return { error: `Unknown tool: ${name}. Available: ${AGENT_TOOL_DEFS.map((d) => d.name).join(", ")}.` };
  const bad = validateToolArgs(def.input_schema, args);
  if (bad) return { error: `Invalid arguments for ${name}: ${bad}.` };
  try {
    switch (name) {
      case "list_sheets":
        return { sheets: ctx.listSheets() };
      case "read_sheet_text": {
        if (!ctx.sheetDims(args.sheet)) return { error: `Sheet ${args.sheet} isn't open on the canvas — ask the estimator to open it, or pick one from list_sheets.` };
        const items = await ctx.readSheetText(args.sheet, args.region ? clampRegion(args.region) : null);
        return { count: items.length, items };
      }
      case "read_schedule": {
        if (!ctx.sheetDims(args.sheet)) return { error: `Sheet ${args.sheet} isn't open on the canvas — pick one from list_sheets.` };
        const rows = await ctx.readSchedule(args.sheet, clampRegion(args.region));
        if (!rows.length) return { rows: [], note: "No schedule table found in that region — draw the region around the table including its CODE / MATERIAL / ... header, or use view_region to look at the area." };
        return { rows };
      }
      case "view_region": {
        if (!ctx.sheetDims(args.sheet)) return { error: `Sheet ${args.sheet} isn't open on the canvas — pick one from list_sheets.` };
        const img = await ctx.viewRegion(args.sheet, clampRegion(args.region));
        // image_data_url is lifted into an image block by the loop, never
        // serialized into the text result.
        return { image_data_url: img.image_data_url, width: img.width, height: img.height };
      }
      case "one_click": {
        if (!ctx.sheetDims(args.sheet)) return { error: `Sheet ${args.sheet} isn't open on the canvas — pick one from list_sheets.` };
        if (ctx.uppFor(args.sheet) == null) return { error: agentScaleGate(args.sheet, ctx.detectedLabel(args.sheet)) };
        return await ctx.oneClick(args.sheet, args.x, args.y);
      }
      case "get_conditions":
        return { conditions: ctx.getConditions() };
      case "create_condition": {
        const tag = args.finish_tag.trim();
        if (!tag) return { error: "finish_tag must be a non-empty string." };
        const existing = ctx.getConditions().find((c) => c.finish_tag.toUpperCase() === tag.toUpperCase());
        if (existing) return { condition_id: existing.id, finish_tag: existing.finish_tag, note: "already existed" };
        const made = ctx.createCondition(tag);
        return { condition_id: made.id, finish_tag: made.finish_tag };
      }
      case "propose_shapes": {
        const condIds = new Set(ctx.getConditions().map((c) => c.id));
        const clean = [];
        const rejected = [];
        for (const s of args.shapes) {
          const dims = ctx.sheetDims(s.sheet);
          if (!dims) { rejected.push(`sheet ${s.sheet} isn't open`); continue; }
          if (ctx.uppFor(s.sheet) == null) { rejected.push(agentScaleGate(s.sheet, ctx.detectedLabel(s.sheet))); continue; }
          if (!MEASURE_ROLES.has(s.measure_role)) { rejected.push(`measure_role must be floor_area or deduct (got ${JSON.stringify(s.measure_role)})`); continue; }
          if (!condIds.has(s.condition_id)) { rejected.push(`unknown condition_id ${JSON.stringify(s.condition_id)} — use get_conditions or create_condition`); continue; }
          const verts = Array.isArray(s.verts_norm)
            ? s.verts_norm.filter((v) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]))
            : [];
          if (verts.length < 3 || verts.length !== s.verts_norm.length) { rejected.push("verts_norm must be a ring of at least 3 [x,y] points — use the ring one_click returned"); continue; }
          const evidence = pickAgentEvidence(s.evidence);
          if (!evidence) { rejected.push("every proposal must cite evidence: schedule_row_tag and/or matched_text and/or seed_norm"); continue; }
          clean.push({
            sheet: s.sheet,
            verts_norm: verts.map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]),
            condition_id: s.condition_id,
            measure_role: s.measure_role,
            evidence,
          });
        }
        const staged = clean.length ? ctx.proposeShapes(clean) : { staged: 0 };
        return { staged: staged.staged, ...(rejected.length ? { rejected } : {}) };
      }
    }
  } catch (e) {
    return { error: `Tool ${name} failed: ${String((e && e.message) || e)}` };
  }
  return { error: `Unknown tool: ${name}.` }; // unreachable; keeps the contract airtight
}
