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
    implausible: z.number().int().describe("Enclosed and clean, but smaller than min_area_sf — a label bubble, door swing, or wall cavity rather than a room"),
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
    op: z.enum(["commit", "edit", "delete"]),
    tool: z.string().describe("The tool call this step came from"),
    shapes: z.number().int().describe("Shapes affected by reversing this step"),
  })).describe("Newest first"),
  shape_count: z.number().int().describe("Committed shapes after the undo"),
  remaining: z.number().int().describe("Steps still available to undo"),
  note: z.string().optional(),
};

export const readSheetTextOutput = {
  sheet: z.string(),
  items: z.array(z.object({ str: z.string(), x: z.number(), y: z.number() })).describe("Positioned text items (image px)"),
  text: z.string().describe("The items joined with spaces"),
};
