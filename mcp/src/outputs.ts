// Output schemas — the typed half of the tool contract. Each tool declares
// outputSchema at registration and returns the same payload as structuredContent
// (format.ts ok()), so clients get machine-validated results instead of parsing
// JSON out of a text item. The SDK enforces these on every call: a reply that
// drifts from its schema is a server bug and fails loudly, not silently.
//
// Shapes mirror session.ts exactly. Objects that mirror the web engine's JS
// output (summary rows, export payload) use .passthrough() so a field added
// upstream widens the reply instead of failing validation.
import { z } from "zod";

const point = z.tuple([z.number(), z.number()]);

/** sheetSummary in session.ts — one sheet's identity + dims. */
const sheetSummary = {
  sheet: z.string().describe('Sheet key: page 1 is the bare file name ("plan.pdf"), pages 2+ are "plan.pdf#2"'),
  page: z.number().int().describe("1-based page number"),
  width_pt: z.number(),
  height_pt: z.number(),
  width_px: z.number().describe("Image px at render scale 2.0 — the coordinate space every tool speaks"),
  height_px: z.number(),
  sheet_number: z.string().optional().describe('Title-block sheet number ("A-101") where detected'),
  detected_scale: z.string().optional().describe("Drawn scale note read off the sheet — a suggestion, never auto-applied"),
};

export const loadPlanOutput = {
  file: z.string(),
  page_count: z.number().int(),
  sheets: z.array(z.object(sheetSummary)),
  note: z.string(),
};

export const sheetInfoOutput = {
  ...sheetSummary,
  seg_count: z.number().int().describe("Vector segment count"),
  has_vector_linework: z.boolean().describe("one_click needs vector linework"),
  scale_set: z.boolean(),
  upp: z.number().optional().describe("Real feet per image px at render scale 2.0 — present once the scale is set"),
  shape_count: z.number().int().describe("Committed shapes on this sheet"),
  layers: z.array(z.object({
    id: z.string().describe("Optional Content Group id — pass to one_click/detect_rooms layers.include/exclude"),
    name: z.string().describe("The CAD layer name as exported (e.g. A-WALL-FULL)"),
    role: z.enum(["boundary", "finish-pattern", "annotation", "structure", "demolition", "unknown"]).describe("What this layer's linework IS to a takeoff (lib/layers.ts) — boundary/structure plot hard, pattern/annotation/demolition are excluded, unknown falls back to the hatch heuristics"),
    confidence: z.number().describe("0..1 — how sure the name classifier is"),
    visible: z.boolean().describe("Default-config visibility — a hidden layer's ink is excluded outright (or you trace demolition)"),
    seg_count: z.number().int().describe("Segments this layer owns on this sheet"),
  })).describe("The sheet's PDF layer table (#85) — [] when no Optional Content survived export (every engine path then runs the heuristics unchanged)"),
};

export const setScaleOutput = {
  sheet: z.string(),
  upp: z.number().describe("Real feet per image px at render scale 2.0"),
  label: z.string().optional().describe("The standard scale label, when set by label or detected note"),
  source: z.enum(["label", "upp", "calibrate", "detected"]),
};

/** one_click replies in one of two modes: with the sheet's scale set,
 * area_sf/perimeter_lf (+ shape_id when committed); without it, a px-only
 * preview (area_px2/perimeter_px + warning) that commits nothing. */
export const oneClickOutput = {
  status: z.literal("ok"),
  nverts: z.number().int().describe("Vertex count of the traced polygon"),
  hatch_filtered: z.literal(true).optional().describe("Present when hatch/pattern linework was classified out of the boundary"),
  gap_bridged_px: z.number().optional().describe("Present when the seal ladder bridged a drafting pinhole this many px wide to close the region — the rescue rides provenance (origin.gap_bridged_px) rather than passing as a clean fill"),
  verts: z.array(point).optional().describe("Traced polygon vertices (image px), when return_verts was set"),
  area_sf: z.number().optional().describe("Scaled mode: traced area in SF"),
  perimeter_lf: z.number().optional().describe("Scaled mode: traced perimeter in LF"),
  shape_id: z.string().optional().describe("Scaled mode: id of the committed shape, when condition was passed"),
  area_px2: z.number().optional().describe("Preview mode (no scale): raw area in px²"),
  perimeter_px: z.number().optional().describe("Preview mode (no scale): raw perimeter in px"),
  warning: z.string().optional().describe("Preview mode (no scale): why quantities are unavailable and what to do"),
};

/** One batch-detected room — same per-room shape as oneClickOutput's scaled/
 * preview modes, minus `status` (the batch already withheld anything that
 * didn't trace cleanly) and plus `label`, the room-number text it was seeded
 * from. */
const detectedRoom = z.object({
  label: z.string().describe("The room-number text the seed was read from (e.g. \"104\", \"139A\")"),
  nverts: z.number().int().describe("Vertex count of the traced polygon"),
  merged_labels: z.array(z.string()).optional().describe("Other labels that flooded to this same region — the area is counted once, under `label`"),
  hatch_filtered: z.literal(true).optional().describe("Present when hatch/pattern linework was classified out of the boundary"),
  gap_bridged_px: z.number().optional().describe("Present when the seal ladder bridged a drafting pinhole this many px wide to close the region"),
  verts: z.array(point).optional().describe("Traced polygon vertices (image px), when return_verts was set"),
  area_sf: z.number().optional().describe("Scaled mode: traced area in SF"),
  perimeter_lf: z.number().optional().describe("Scaled mode: traced perimeter in LF"),
  shape_id: z.string().optional().describe("Scaled mode: id of the committed shape, when condition was passed"),
  area_px2: z.number().optional().describe("Preview mode (no scale): raw area in px²"),
  perimeter_px: z.number().optional().describe("Preview mode (no scale): raw perimeter in px"),
});

/** detect_rooms: one flood per room-number label found on the sheet's text
 * layer, kept only when it traces cleanly (a leak/tiny/boundary flood is
 * silently withheld, not reported as a room). Same scaled-vs-preview split as
 * one_click, applied per room; `warning` appears once for the whole sheet
 * when no scale is set. */
export const detectRoomsOutput = {
  detected: z.number().int().describe("Count of cleanly-detected rooms — may be fewer than the labels found on the sheet"),
  rooms: z.array(detectedRoom),
  withheld: z.object({
    total: z.number().int().describe("Seeds found on the sheet but not reported as rooms"),
    degenerate: z.number().int().describe("Traced to fewer than 3 vertices"),
    duplicate: z.number().int().describe("Flooded to a region another label already claimed — counted once, never twice"),
    bubble: z.number().int().describe("Labels whose every clean flood was their own label BUBBLE (ring bbox ≈ label bbox — plans box their room numbers). Scale-free, so it guards unscaled previews too"),
    implausible: z.number().int().describe("Enclosed, clean, non-bubble, but smaller than min_area_sf — a door swing or wall cavity rather than a room"),
    min_area_sf: z.number().optional().describe("The plausibility floor applied (scaled mode only)"),
  }).describe("What detection skipped and why — a withheld room is a question the caller can ask; a silently dropped one is a hole in a bid"),
  note: z.string().optional().describe("Human-readable summary of what was withheld, when anything was"),
  warning: z.string().optional().describe("Preview mode (no scale): why quantities are unavailable and what to do"),
};

export const measurePolygonOutput = {
  area_sf: z.number(),
  perimeter_lf: z.number(),
  nverts: z.number().int(),
  shape_id: z.string().optional().describe("Present when condition was passed and the shape committed"),
};

export const measureLineOutput = {
  length_lf: z.number(),
  npts: z.number().int(),
  shape_id: z.string().optional().describe("Present when condition was passed and the shape committed"),
};

/** conditionTotals row (web/src/lib/totals.js) minus presentation fields —
 * *_net = waste-adjusted order quantities. */
const summaryRow = z.object({
  id: z.string(),
  finish_tag: z.string(),
  multiplier: z.number(),
  waste_pct: z.number(),
  shape_count: z.number().int(),
  floor_sf: z.number(),
  wall_sf: z.number(),
  border_sf: z.number(),
  lf: z.number(),
  ea: z.number(),
  total_sf: z.number(),
  floor_sf_net: z.number(),
  wall_sf_net: z.number(),
  border_sf_net: z.number(),
  lf_net: z.number(),
  total_sf_net: z.number(),
  sy_net: z.number(),
}).passthrough();

export const takeoffSummaryOutput = {
  conditions: z.array(summaryRow),
  totals: z.object({
    total_sf: z.number(),
    total_sf_net: z.number(),
    lf: z.number(),
    lf_net: z.number(),
    ea: z.number(),
    sy_net: z.number(),
  }).passthrough(),
};

/** The app's exact save payload (opentakeoff.takeoff_canvas.v1). */
export const exportTakeoffOutput = {
  schema: z.string(),
  project_name: z.string(),
  units: z.string(),
  sheets: z.array(z.object({ sheet_id: z.string(), units_per_px: z.number() })),
  conditions: z.array(z.object({
    id: z.string(),
    finish_tag: z.string(),
    color: z.string(),
    fill: z.string(),
    hatch: z.string(),
    multiplier: z.number(),
    waste_pct: z.number(),
    materials: z.array(z.unknown()),
  }).passthrough()),
  shapes: z.array(z.object({
    id: z.string(),
    sheet_id: z.string(),
    condition_id: z.string(),
    measure_role: z.enum(["floor_area", "deduct", "linear"]),
    verts_norm: z.array(point).describe("Vertices normalized to sheet dims (0–1)"),
    computed: z.object({ area_sf: z.number(), perimeter_lf: z.number() }).passthrough(),
    origin: z.object({}).passthrough().optional().describe("Provenance: method (manual|one_click_v1), actor (omitted=human, 'agent'=MCP/automation), reviewed (human affirmed at an explicit gate), and correction fields (edited, edited_before_create, copied, proposed_verts_norm, edits)"),
  }).passthrough()),
  markups: z.array(z.unknown()),
  sheet_group: z.array(z.unknown()),
  last_group: z.array(z.unknown()),
  sheet_tabs: z.array(z.unknown()),
  sheet_levels: z.object({}).passthrough(),
};

export const deleteShapeOutput = {
  deleted: z.string().describe("The removed shape's id"),
  shape_count: z.number().int().describe("Committed shapes remaining"),
};

/** edit_shape: the revised shape's re-measured quantities. Quantities are
 * always recomputed from the resulting geometry and role, so a role flip alone
 * re-measures (closed area vs open length). */
export const editShapeOutput = {
  shape_id: z.string(),
  changed: z.array(z.enum(["verts", "condition", "role"])).describe("Which fields this call actually changed"),
  measure_role: z.enum(["floor_area", "deduct", "linear"]),
  nverts: z.number().int(),
  area_sf: z.number().describe("0 for linear shapes"),
  perimeter_lf: z.number().describe("Length for linear shapes, perimeter for closed ones"),
  agent_edits: z.number().int().describe("How many times the agent has revised this shape — separate from the human-correction tally"),
};

/** undo_last: what was actually stepped back. `undone` may be fewer than
 * requested when the journal ran out; the note says so rather than pretending. */
export const undoLastOutput = {
  undone: z.number().int().describe("Steps actually reversed"),
  steps: z.array(z.object({
    seq: z.number().int(),
    op: z.enum(["commit", "edit", "delete", "materials", "condition"]),
    tool: z.string().describe("The tool call this step came from"),
    shapes: z.number().int().describe("Shapes affected by reversing this step — 0 for a materials step (it restores a condition's supporting-materials rows, not shapes) and for a condition step (it restores the waste/multiplier pair)"),
  })).describe("Newest first"),
  shape_count: z.number().int().describe("Committed shapes after the undo"),
  remaining: z.number().int().describe("Steps still available to undo"),
  note: z.string().optional(),
};

/** findText — the complement to readSheetTextOutput: WHERE a known string
 * sits, not what a region says. */
export const findTextOutput = {
  sheet: z.string(),
  q: z.string(),
  count: z.number().int().describe("Total matches before the limit cap"),
  truncated: z.boolean().describe("true = count exceeds hits.length; narrow the region or raise limit"),
  hits: z.array(z.object({
    str: z.string().describe("The matched pdf.js text run, verbatim (may be shorter than the full label — runs aren't merged into lines)"),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[x0, y0, x1, y1] image px"),
    center: z.tuple([z.number(), z.number()]).describe("Bbox center, image px — feed straight into one_click's seed"),
  })),
};

/** editMaterials — session.ts's MaterialRow, verbatim. */
const materialRow = z.object({
  id: z.string(),
  name: z.string(),
  per: z.number().describe("Coverage rate: basis ÷ per = order quantity"),
  basis: z.enum(["area", "linear", "count"]).describe("Which of the condition's totals this row's quantity is computed against"),
  unit: z.string(),
  round: z.boolean().describe("true = round up to whole purchase units (the default — you buy whole bags/buckets)"),
  note: z.string().optional(),
});

export const editMaterialsOutput = {
  condition: z.string().describe("The finish tag passed in"),
  condition_id: z.string(),
  changed: z.object({
    added: z.array(z.string()).describe("Ids of newly added rows"),
    removed: z.array(z.string()).describe("Ids removed"),
    patched: z.array(z.string()).describe("Ids whose fields changed"),
  }),
  materials: z.array(materialRow).describe("The condition's full materials array after this write"),
};

/** One computed materials line inside a report condition row — the buy list.
 * conditionTotals (web/src/lib/totals.js) computes qty = basis_qty ÷ per,
 * rounded UP to whole purchase units unless round is false. */
const reportMaterialLine = z.object({
  name: z.string(),
  unit: z.string().describe("Purchase unit, e.g. 'gal', 'bag'"),
  per: z.number().describe("Coverage rate — basis units per purchase unit"),
  basis: z.enum(["area", "linear", "count"]),
  round: z.boolean(),
  basis_qty: z.number().describe("The condition total this row divides (SF, LF, or EA — multiplier applied, waste not)"),
  qty: z.number().describe("Computed order quantity"),
}).passthrough();

/** export_report: the canvas Report's own JSON document (totals.js reportJson,
 * schema "opentakeoff.report.v1", additive-only). The authority on the shape
 * is the web export — this mirror pins what a pricing consumer relies on and
 * passes the additive tail through. */
export const exportReportOutput = {
  schema: z.literal("opentakeoff.report.v1"),
  project_name: z.string().nullable(),
  generated_with: z.string(),
  sheets: z.array(z.object({ sheet_id: z.string(), sheet: z.string(), scale_source: z.string() }).passthrough()).describe("Scale provenance per sheet — how each scale was set"),
  conditions: z.array(summaryRow.extend({ materials: z.array(reportMaterialLine) }).passthrough()).describe("conditionTotals rows: gross + *_net quantities AND the computed materials buy list"),
  by_sheet: z.array(z.object({ sheet_id: z.string(), sheet: z.string(), rows: z.array(z.record(z.unknown())) }).passthrough()).describe("BASE per-sheet subtotals — multiplier NOT applied, no waste, no materials"),
  totals: z.object({
    total_sf: z.number(), total_sf_net: z.number(),
    lf: z.number(), lf_net: z.number(),
    ea: z.number(), sy_net: z.number(),
  }).passthrough(),
  materials: z.array(z.object({ name: z.string(), unit: z.string(), qty: z.number() }).passthrough()).describe("Project-wide buy list — condition rows summed by (name, unit)"),
  markups: z.array(z.record(z.unknown())),
  rfis: z.array(z.record(z.unknown())),
  condition_columns: z.array(z.record(z.unknown())),
  shape_labels: z.array(z.string()),
  by_label: z.array(z.record(z.unknown())),
  units: z.string(),
  display_units: z.string(),
  roll_goods: z.array(z.record(z.unknown())).describe("Roll-goods order rows (#136) — order_lf / rolls / order_qty per roll-goods condition, ×N applied; empty when no condition carries a roll_setup (always the case for a headless session today)"),
};

export const editConditionOutput = {
  condition: z.string().describe("The finish tag passed in"),
  condition_id: z.string(),
  waste_pct: z.number().describe("The condition's waste % after this write"),
  multiplier: z.number().describe("The condition's quantity multiplier after this write"),
};

export const readSheetTextOutput = {
  sheet: z.string(),
  items: z.array(z.object({ str: z.string(), x: z.number(), y: z.number() })).describe("Positioned text items (image px)"),
  text: z.string().describe("The items joined with spaces"),
};

// ── the sheet graph (#87) ───────────────────────────────────────────────────
const wireBox = z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });
const wireEvidence = z.object({ sheet: z.string(), text: z.string(), bbox: wireBox })
  .describe("An evidence pointer — the sheet, the literal text, and where it sits (image px). Every edge in the graph carries one; pass the bbox to view_sheet to LOOK at the source.");
const graphRoom = z.object({ tag: z.string(), name: z.string().describe("The name span stacked over the tag ('' when none)"), sheet: z.string(), bbox: wireBox });

export const sheetGraphOutput = {
  available: z.boolean().describe("false = the set has no text layer (a scan) — the graph degrades to unavailable, never half-populates"),
  sheets: z.array(z.object({
    sheet: z.string(),
    role: z.enum(["plan", "schedule", "legend", "detail", "elevation", "demolition", "unknown"]),
    confidence: z.number().describe("0..1; mixed title signals halve it, a bare sheet-number convention stays under 0.5"),
    evidence: wireEvidence.optional(),
    schedules: z.array(z.object({ kind: z.string(), title: z.string(), rows: z.number().int(), region: wireBox })),
  })),
  rooms: z.array(graphRoom).describe("Room tags read off plan-role sheets — schedule sheets contribute rows, never phantom rooms"),
  callouts: z.array(z.object({ detail: z.string(), target_sheet: z.string(), sheet: z.string(), bbox: wireBox })).describe("Detail callouts (3/A-601) — edges to their target sheets"),
  counts: z.object({ rooms: z.number().int(), schedules: z.number().int(), callouts: z.number().int() }),
};

export const resolveTagOutput = {
  status: z.enum(["resolved", "unresolved"]),
  tag: z.string(),
  room: graphRoom.nullable().describe("The plan tag, when the room appears on a plan sheet — cited even when resolution fails"),
  finishes: z.array(z.object({
    surface: z.string().describe("The schedule column: FLOOR / BASE / WALL / …"),
    code: z.string(),
    source: wireEvidence,
    definition: z.object({ cells: z.record(z.string()), source: wireEvidence }).optional()
      .describe("The finish/material-schedule row this code chains to, when one exists"),
  })).optional(),
  sources: z.array(wireEvidence).optional().describe("The chain: plan tag → schedule row"),
  reason: z.string().optional().describe("unresolved only — WHY (no schedule row / ambiguous / no schedule found). A room that appears on the plan with no row comes back here, never as a silent omission"),
};

export const findScheduleOutput = {
  matches: z.array(z.object({
    sheet: z.string(), kind: z.string(), title: z.string(), rows: z.number().int(),
    headers: z.array(z.string()), region: wireBox.describe("Pass to view_sheet to look at the table"),
  })),
};

/** sheet_context (issue #29): vectors + text + hatch families of one region,
 * in one frame. Structured-only by design — the raster stays view_sheet's
 * job, and frame agreement is a contract on the echoed region rect rather
 * than on a second renderer. */
const hatchFamilyRow = z.object({
  id: z.string().describe("Content hash of the quantized (angle, pitch, pen-width) signature — the SAME id for the same pattern spec anywhere on the sheet, so legend↔plan matching is id === id. Identifies a pattern, not a material; the legend maps pattern → material."),
  angle_deg: z.number().describe("Raw mean angle [0, 180) — rides beside the id for tolerance matching at bucket boundaries"),
  pitch_px: z.number().describe("Raw median row pitch, image px"),
  pen_w_px: z.number().int().describe("Modal device pen width of the members"),
  rows: z.number().int(),
  segments: z.number().int().describe("Member segments in the whole instance"),
  segments_in_region: z.number().int().describe("…of which this many were returned in vectors (post-decimation)"),
  bbox: z.array(z.number()).length(4).describe("The instance's tight bbox [x0, y0, x1, y1], image px"),
});

export const sheetContextOutput = {
  sheet: z.string(),
  page: z.number().int(),
  sheet_px: z.array(z.number()).length(2),
  region: z.array(z.number()).length(4).describe("The region actually resolved, post-clamp — pass this same rect to view_sheet and the render is in the same frame by construction"),
  has_vector_linework: z.boolean().describe("false = a scan: vectors and hatch are empty because there are none, not because the region is blank"),
  vectors: z.object({
    segments: z.array(z.array(z.number()).length(4)).describe("[x0, y0, x1, y1] per segment, image px, endpoints exactly as drawn — clipped by KEEPING whole intersecting segments, never by rewriting them"),
    meta: z.array(z.number().int()).describe("One byte per segment, aligned with segments: bit 1 = curve chord, bit 2 = clip-only, bit 4 = filled-not-stroked; high nibble = device pen width"),
    family: z.array(z.string().nullable()).describe("Aligned with segments: the hatch-family id this segment belongs to, or null for structural linework"),
    kept: z.number().int(),
    total_in_region: z.number().int().describe("Segments intersecting the region before any decimation — kept + dropped always reconciles to this"),
    truncated: z.boolean(),
    dropped: z.object({
      short: z.number().int().describe("Below min_len_px (invisible ink)"),
      cap: z.number().int().describe("Over max_segments — the SHORTEST went first, so walls survive"),
    }),
    note: z.string().optional(),
  }),
  text: z.object({
    spans: z.array(z.object({ str: z.string(), x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() })).describe("Text with bboxes, image px, same frame as the vectors"),
    count: z.number().int(),
  }),
  hatch: z.object({ families: z.array(hatchFamilyRow), count: z.number().int() }),
};

// ── annotations (#114) — notes ABOUT the work, never measurements of it ──────
const annotationRow = z.object({
  id: z.string(),
  sheet: z.string(),
  type: z.string(),
  text: z.string(),
  condition: z.string().describe("Resolved finish tag, or '' when unattached — saves joining against conditions[]"),
  condition_id: z.string(),
  at: z.tuple([z.number(), z.number()]).optional(),
  target: z.tuple([z.number(), z.number()]).optional(),
  rect: z.array(z.tuple([z.number(), z.number()]).optional()).optional(),
});

export const annotateOutput = {
  id: z.string(),
  sheet: z.string(),
  type: z.string(),
  text: z.string(),
  condition: z.string(),
  condition_id: z.string(),
  note: z.string(),
};

export const listAnnotationsOutput = {
  annotations: z.array(annotationRow),
  count: z.number().int(),
  unattached: z.number().int().describe("How many carry no condition — candidates for link_annotation"),
};

export const linkAnnotationOutput = {
  id: z.string(),
  condition: z.string(),
  condition_id: z.string().optional(),
  note: z.string(),
};
