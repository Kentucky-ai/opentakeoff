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

/** The sealed engine's account of one trace (RFC #60) — shared verbatim by
 * one_click and each detect_rooms room, and mirrored 1:1 onto the committed
 * shape's origin (commit() stamps both from one mapping, so the reply and the
 * export can never disagree about how a shape was made). */
const traceProvenance = {
  confidence: z.number().optional().describe("0..1 — the trace scored from the engine's own signals (sealed openings, door wedges, min-passage rule, hatch tier, raster boundary, mask coarseness, implausible size). A review PRIORITIZER, not a verification: 1.0 means every signal came back clean, never that the trace is right. A low score is a view_sheet {overlay:true} audit prompt, not a fact to bid from"),
  confidence_factors: z.array(z.string()).optional().describe("The named factors behind a sub-1.0 confidence (e.g. \"sealed-opening(10% synthetic boundary)\") — each names the edge worth putting eyes on; absent when every signal ran clean"),
  gap_sealed_px: z.number().optional().describe("Present when the seal ladder closed a genuine OPENING this many mask px wide (doorway-scale — scaled by the sheet's feet, distinct from gap_bridged_px's drafting-pinhole rescue). Part of the boundary is synthetic, and confidence deducts by that share; rides origin.gap_sealed_px on the committed shape"),
  min_pass_px: z.number().optional().describe("The feet-true minimum-passage rule (openings under ~0.5 ft never connect two spaces) ran at this dilation radius AND changed the answer — present only with min_pass_delta"),
  min_pass_delta: z.number().optional().describe("Fraction of the verbatim flood the minimum-passage rule removed; 1 means the drawn linework bounds nothing here and the rule is the only reason there is a measurement — audit before trusting"),
  door_wedges: z.number().int().optional().describe("Door-swing wedges annexed into the region under grow-but-verify — how many doorways' swings were included, the canvas's own door handling; rides origin.door_wedges"),
  ring_interiors: z.number().int().optional().describe("Of those wedges, how many were a CLOSED ring's interior (round column, callout bubble) rather than a door swing — annexed floor you may want as a deduct instead"),
};

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
  file: z.string().describe("The document just loaded (basename)"),
  files: z.array(z.string()).describe("Every document in the working set, load order (#152 — one entry unless merge was used)"),
  page_count: z.number().int().describe("Total sheets across the working set"),
  sheets: z.array(z.object(sheetSummary)).describe("EVERY sheet in the working set, not just the file loaded by this call"),
  note: z.string(),
};

export const sheetInfoOutput = {
  ...sheetSummary,
  seg_count: z.number().int().describe("Vector segment count"),
  has_vector_linework: z.boolean().describe("one_click needs vector linework"),
  scale_set: z.boolean(),
  upp: z.number().optional().describe("Real feet per image px at render scale 2.0 — present once the scale is set"),
  shape_count: z.number().int().describe("Committed shapes on this sheet"),
  multiple_scales: z.literal(true).optional().describe("Several DISTINCT scale notes on this sheet (#153) — enlarged plans/details likely"),
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
  warning: z.string().optional().describe("Present when the sheet carries MULTIPLE distinct scale notes (#153) — enlarged plans/details likely; region measurements under a disagreeing note will warn"),
};

/** one_click replies in one of two modes: with the sheet's scale set,
 * area_sf/perimeter_lf (+ shape_id when committed); without it, a px-only
 * preview (area_px2/perimeter_px + warning) that commits nothing. */
export const oneClickOutput = {
  status: z.literal("ok"),
  nverts: z.number().int().describe("Vertex count of the traced polygon"),
  ...traceProvenance,
  hatch_filtered: z.literal(true).optional().describe("Present when hatch/pattern linework was classified out of the boundary"),
  gap_bridged_px: z.number().optional().describe("Present when the seal ladder bridged a drafting pinhole this many px wide to close the region — the rescue rides provenance (origin.gap_bridged_px) rather than passing as a clean fill"),
  raster_traced: z.literal(true).optional().describe("Present when the region was bounded by the sheet's RENDERED PIXELS (the scanned-sheet raster fallback, #154) rather than vector linework — absent means the vector path ran. Rides origin.raster_traced on the committed shape; a raster ring's corners are unsnapped (a scan has no true endpoints), so audit it with view_sheet overlay before trusting the total"),
  verts: z.array(point).optional().describe("Traced polygon vertices (image px), when return_verts was set"),
  area_sf: z.number().optional().describe("Scaled mode: traced area in SF"),
  perimeter_lf: z.number().optional().describe("Scaled mode: traced perimeter in LF"),
  shape_id: z.string().optional().describe("Scaled mode: id of the committed shape, when condition was passed"),
  area_px2: z.number().optional().describe("Preview mode (no scale): raw area in px²"),
  perimeter_px: z.number().optional().describe("Preview mode (no scale): raw perimeter in px"),
  warning: z.string().optional().describe("Preview mode (no scale): why quantities are unavailable — OR, in scaled mode, a mixed-scale warning (#153): a scale note disagreeing with the sheet's sits in the measured region (enlarged plan/detail viewport likely)"),
};

/** One batch-detected room — same per-room shape as oneClickOutput's scaled/
 * preview modes, minus `status` (the batch already withheld anything that
 * didn't trace cleanly) and plus `label`, the room-number text it was seeded
 * from. */
const detectedRoom = z.object({
  label: z.string().describe("The room-number text the seed was read from (e.g. \"104\", \"139A\")"),
  nverts: z.number().int().describe("Vertex count of the traced polygon"),
  merged_labels: z.array(z.string()).optional().describe("Other labels that flooded to this same region — the area is counted once, under `label`"),
  ...traceProvenance,
  hatch_filtered: z.literal(true).optional().describe("Present when hatch/pattern linework was classified out of the boundary"),
  gap_bridged_px: z.number().optional().describe("Present when the seal ladder bridged a drafting pinhole this many px wide to close the region"),
  raster_traced: z.literal(true).optional().describe("Present when the room was bounded by rendered pixels (scanned-sheet raster fallback, #154) rather than vector linework — sheet-wide per sweep, and it rides origin.raster_traced on the committed shape"),
  verts: z.array(point).optional().describe("Traced polygon vertices (image px), when return_verts was set"),
  area_sf: z.number().optional().describe("Scaled mode: traced area in SF"),
  perimeter_lf: z.number().optional().describe("Scaled mode: traced perimeter in LF"),
  shape_id: z.string().optional().describe("Scaled mode: id of the committed shape, when condition was passed"),
  condition: z.string().optional().describe("The finish tag this room committed under — the passed condition, or in assign mode the FLOOR finish its own schedule row states. Present exactly when shape_id is"),
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
    unresolved: z.number().int().describe("Assign mode: rooms the schedule could not answer for (no row, no FLOOR cell, or a compound cell) — withheld into unresolved[], never committed under a guess. Always present; 0 outside assign mode"),
    min_area_sf: z.number().optional().describe("The plausibility floor applied (scaled mode only)"),
  }).describe("What detection skipped and why — a withheld room is a question the caller can ask; a silently dropped one is a hole in a bid"),
  unresolved: z.array(z.object({
    label: z.string().describe("The room tag as drawn"),
    reason: z.string().describe("WHY the schedule could not answer — resolveTag's own reason, \"states no FLOOR finish\", or \"ambiguous: …\" for a compound cell"),
    area_sf: z.number().describe("The room's real traced area — withheld from committing, not from reporting"),
    perimeter_lf: z.number(),
    seed: z.tuple([z.number(), z.number()]).describe("The flood seed (image px) — once the estimator answers, one_click here with the stated condition commits it"),
  })).optional().describe("Assign mode only, empty array included: [] is the positive claim that every detected room resolved against its own schedule row"),
  note: z.string().optional().describe("Human-readable summary of what was withheld, when anything was"),
  multiple_scales: z.literal(true).optional().describe("Several DISTINCT scale notes on this sheet (#153) — rooms inside an enlarged viewport may be figured at the wrong scale"),
  warning: z.string().optional().describe("Preview mode (no scale): why quantities are unavailable and what to do"),
};

export const measurePolygonOutput = {
  area_sf: z.number(),
  perimeter_lf: z.number(),
  nverts: z.number().int(),
  shape_id: z.string().optional().describe("Present when condition was passed and the shape committed"),
  warning: z.string().optional().describe("Mixed-scale warning (#153): a scale note disagreeing with the sheet's sits in the measured region — verify before trusting these numbers"),
};

/** measure_surface (#146) — wall SF: traced LF × the condition's height. */
export const measureSurfaceOutput = {
  condition: z.string(),
  height_ft: z.number().describe("The height this shape was quantified at (snapshotted on the shape)"),
  length_lf: z.number().describe("The traced run's open length"),
  area_sf: z.number().describe("length_lf × height_ft — the wall SF committed"),
  npts: z.number().int(),
  shape_id: z.string(),
};

/** place_count (#146) — EA markers, one shape per point, scale-free. */
export const placeCountOutput = {
  committed: z.number().int().describe("Count shapes committed by this call — one per point"),
  shape_ids: z.array(z.string()),
  condition: z.string(),
  ea_total: z.number().describe("The condition's total EA after this call"),
};

/** symbol_sweep — one row per found placement; withheld rows carry the reason. */
const sweepPlacement = {
  at: z.tuple([z.number(), z.number()]).describe("The placed symbol's centroid (image px) — the point a commit places its count marker at"),
  score: z.number().describe("Length-weighted fraction of the seed's segments matched within tolerance, 0..1"),
  rotation: z.number().describe("Detected rotation in degrees (0 | 90 | 180 | 270)"),
  mirrored: z.boolean(),
};

const sweepCandidates = z.object({
  considered: z.number().int(),
  dropped: z.number().int().describe("Placements never scored because the work cap bit — always disclosed, never silent"),
});

/** What a stated size ratio (#186) cost on one sheet. Present ONLY when the
 * ratio was not 1 — a same-scale sweep is the reply it always was. */
const sweepScaled = z.object({
  ratio: z.number().describe("Seed-sheet px per target-sheet px, computed from the two sheets' own committed scales (upp_seed / upp_target) — stated, never scale-searched"),
  segments: z.number().int().describe("Fingerprint segments that survived the resize and were actually searched for"),
  sub_pixel_dropped: z.number().int().describe("Seed segments that fell below matchable length when scaled down — excluded from the score rather than depressing it, so a score here is a fraction of what survived, not of the whole seed"),
  footprint_px: z.number().describe("The symbol's size on THIS sheet after the resize"),
  tol_px: z.number().describe("The endpoint tolerance actually applied — it rides the ratio up when the seed is magnified (its drawn jitter magnifies too) and never down"),
}).describe("#186: present only when the seed was resized for this sheet");

const sweepScaleAssumed = z.string().describe("#186: present when the true ratio is UNKNOWN (a scale is missing on the seed sheet or this one) and the sweep ran at 1:1 — an unstated ratio plus a zero count is not evidence of absence");

/** One plan sheet's results inside a set-wide sweep — its own match/withheld
 * lists, its own cap accounting, its own wall-clock. */
const sweepSheetBlock = z.object({
  sheet: z.string(),
  found: z.number().int(),
  matches: z.array(z.object(sweepPlacement)),
  withheld: z.array(z.object({ ...sweepPlacement, reason: z.string() })),
  candidates: sweepCandidates.describe("The work cap applies PER SHEET; dropped > 0 here names exactly where the count is incomplete"),
  elapsed_ms: z.number().describe("Wall-clock for this sheet's sweep"),
  scaled: sweepScaled.optional(),
  scale_assumed: sweepScaleAssumed.optional(),
});

/** Sheets excluded from counting, disclosed one by one — a symbol drawn in a
 * detail, legend, or schedule is a reference drawing, never installed work. */
const sweepSkipped = z.array(z.object({
  sheet: z.string(),
  role: z.string().describe("The sheet's graph role (plan / schedule / legend / detail / …)"),
  reason: z.string(),
}));

export const symbolSweepOutput = {
  scope: z.enum(["sheet", "set"]).describe('"sheet" = the swept sheet alone (matches/withheld/candidates at top level); "set" = every PLAN-role sheet in the working set (per-sheet results in sheets[], exclusions in skipped[])'),
  found: z.number().int().describe("Placements that cleared the commit bar — across every swept sheet in set scope"),
  matches: z.array(z.object(sweepPlacement)).optional().describe("Sheet scope only. Deterministic reading order (y, then x). The seed's own location is never listed here"),
  withheld: z.array(z.object({ ...sweepPlacement, reason: z.string() })).optional()
    .describe("Sheet scope only. Near-matches in the [0.75, 0.92) band — reported with a reason, NEVER committed. A withheld placement is a question you can answer with view_sheet; a hidden one is a miscount"),
  seed: z.object({
    sheet: z.string().describe("The sheet the seed rect was marqueed on"),
    role: z.string().optional().describe("Set scope: the seed sheet's graph role — a non-plan seed sheet is the fingerprint SOURCE and is excluded from counting"),
    segments: z.number().int().describe("Vector segments fully inside the seed rect — the fingerprint"),
    center: z.tuple([z.number(), z.number()]).describe("The seed instance's own centroid (image px) — reported here, never double-committed as a match"),
    rect: z.array(z.number()).length(4).describe("The seed rect actually used, post-clamp [x0, y0, x1, y1]"),
    length_px: z.number().describe("Total seed linework length, image px"),
  }),
  candidates: sweepCandidates.optional().describe("Sheet scope only — set scope accounts per sheet in sheets[]"),
  sheets: z.array(sweepSheetBlock).optional().describe("Set scope only: one entry per swept PLAN-role sheet, load order"),
  skipped: sweepSkipped.optional().describe("Set scope only: every sheet excluded from counting, with role and reason — including the seed's own sheet when it is not a plan"),
  committed: z.number().int().optional().describe("commit mode: count shapes committed — one per match"),
  shape_ids: z.array(z.string()).optional(),
  condition: z.string().optional().describe("commit mode: the finish tag the markers counted under"),
  ea_total: z.number().optional().describe("commit mode: the condition's total EA after this call"),
  note: z.string().optional(),
  warning: z.string().optional().describe("Present when the work cap dropped candidates — what a tighter seed rect would recover"),
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
    measure_role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
    verts_norm: z.array(point).describe("Vertices normalized to sheet dims (0–1)"),
    computed: z.object({ area_sf: z.number().optional(), perimeter_lf: z.number().optional(), count: z.number().optional() }).passthrough()
      .describe("count shapes carry {count} alone; every other role carries area_sf + perimeter_lf"),
    origin: z.object({}).passthrough().optional().describe("Provenance: method (manual|one_click_v1), actor (omitted=human, 'agent'=MCP/automation), reviewed (human affirmed at an explicit gate), assignment (where the finish tag came from — {source: 'schedule', room_tag, surface, schedule_sheet} when the room's own schedule row decided it, {source: 'asserted'} when the agent chose; stamped on every agent commit), and correction fields (edited, edited_before_create, copied, proposed_verts_norm, edits)"),
  }).passthrough()),
  markups: z.array(z.unknown()),
  approvals: z.array(z.unknown()).optional().describe("Approval-family records (#176) — the estimator's APPROVED seals and the agent's verdict marks {id, actor, ts, sheet_id, at:[nx,ny], shape_id?, text?}. Present only when any exist (the canvas payload's own convention), so a verdict-free export stays byte-identical"),
  sheet_group: z.array(z.unknown()),
  last_group: z.array(z.unknown()),
  sheet_tabs: z.array(z.unknown()),
  sheet_levels: z.object({}).passthrough(),
};

/** import_takeoff (#151) — the merge receipt, field-identical to the app's. */
export const importTakeoffOutput = {
  file: z.string().describe("Basename of the imported file"),
  replaced: z.boolean().describe("true = the session was empty and adopted the file wholesale"),
  shapes_added: z.number().int(),
  shapes_pending: z.number().int().describe("Of the added shapes, how many are unreviewed machine pencil"),
  conditions_merged: z.number().int().describe("Imported conditions that joined an existing finish tag (its knobs won)"),
  conditions_added: z.number().int(),
  scales_adopted: z.number().int().describe("Sheets whose calibration came from the file (this session's own always wins)"),
  unknown_files: z.array(z.string()).describe("Files referenced by imported shapes that this document doesn't have — they count in totals but can't be viewed here"),
  rules_imported: z.number().int().describe("Correction rules (#88) that arrived with the file — apply_rules re-runs them"),
  shapes_total: z.number().int(),
  note: z.string(),
};

/** apply_rules (#207) — the per-rule disclosure IS the preview an agent gets. */
export const applyRulesOutput = {
  rules: z.array(z.object({
    rule_id: z.string(),
    label: z.string().describe("The rule's own plain-language statement, minted at creation"),
    condition: z.string().describe("The finish tag whose rooms were scanned"),
    produced: z.number().int(),
    shape_ids: z.array(z.string()).describe("The committed deducts — reviewed: false, one batch"),
    deduct_sf: z.number(),
  })),
  committed: z.number().int().describe("Deducts committed across all rules — 0 is a result (idempotence)"),
  total_deduct_sf: z.number(),
  skipped_rules: z.array(z.object({
    rule_id: z.string(),
    label: z.string(),
    reason: z.enum(["inactive", "condition_not_in_session"]),
  })).describe("Rules not evaluated, named — never silently dropped"),
  skipped_sheets: z.array(z.object({
    sheet_id: z.string(),
    reason: z.enum(["no_scale", "no_vector_mask"]),
  })).describe("Sheets that could not be scanned (uncalibrated, or scanned raster with no linework mask)"),
  note: z.string(),
};

/** derive_base (#148) — per-room receipts for the perimeter → base derivation. */
export const deriveBaseOutput = {
  condition: z.string().describe("The tag the base committed under"),
  source_condition: z.string(),
  rooms: z.array(z.object({
    source_shape_id: z.string(),
    base_shape_id: z.string().describe("The committed linear base shape"),
    sheet: z.string(),
    gross_lf: z.number().describe("The room's full perimeter"),
    openings_lf: z.number().describe("The openings you stated for this room"),
    net_lf: z.number().describe("gross − openings — the committed quantity"),
  })),
  committed: z.number().int(),
  total_lf: z.number().describe("Sum of net_lf across rooms"),
  note: z.string(),
};

/** derive_transitions (#202) — what committed, and what came back as a question.
 *  The two arrays carry the SAME row shape on purpose: a withheld run is not a
 *  lesser record, it is a run the tool measured and declined to bid. */
const transitionRun = {
  sheet: z.string(),
  between_shape_ids: z.array(z.string()).describe("The two floor_area shapes this run separates"),
  length_lf: z.number().describe("Run length along the first shape's boundary"),
  gap_in: z.number().describe("Median distance between the two rings across the run, in inches — 0-ish is one open space, 4-8 is a partition"),
  at: z.array(z.number()).describe("Run midpoint (image px) — pass to view_sheet to look at it"),
};
export const deriveTransitionsOutput = {
  condition: z.string().describe("The tag the transitions committed under"),
  between: z.array(z.string()).describe("The two finish tags"),
  committed: z.number().int(),
  total_lf: z.number().describe("Sum of committed run lengths — butt joints only"),
  runs: z.array(z.object({ ...transitionRun, shape_id: z.string() })),
  withheld: z.array(z.object({
    ...transitionRun,
    reason: z.literal("wall_separated"),
    detail: z.string(),
  })).describe("Adjacency across a wall: real, measured, and NOT committed — the transition there is a threshold at a doorway this cannot locate"),
  withheld_lf: z.number().describe("Shared-wall length held back — never part of total_lf"),
  note: z.string(),
};

/** list_shapes (#149) — the compact inventory; quantities appear per role. */
export const listShapesOutput = {
  shapes: z.array(z.object({
    id: z.string(),
    sheet: z.string(),
    condition: z.string(),
    measure_role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
    area_sf: z.number().optional(),
    perimeter_lf: z.number().optional(),
    count: z.number().optional(),
    height_ft: z.number().optional().describe("surface_area shapes — the height they were quantified at"),
    label: z.string().optional().describe("The room (or phase/area) this shape belongs to — detect_rooms stamps the room number it traced from; edit_shape sets or clears it. Absent when unlabeled"),
    nverts: z.number().int(),
    reviewed: z.boolean().describe("true = human-affirmed ink, refused by every agent mutation"),
    assignment: z.enum(["schedule", "asserted"]).optional().describe('Where the finish tag came from: "schedule" = resolved from the room\'s own schedule row, "asserted" = the agent chose it. origin.assignment in export_takeoff carries the citation. Absent on human canvas shapes'),
    agent_edits: z.number().int().optional().describe("Present when the agent has revised this shape"),
  })),
  count: z.number().int(),
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
  changed: z.array(z.enum(["verts", "condition", "role", "label"])).describe("Which fields this call actually changed"),
  measure_role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
  nverts: z.number().int(),
  area_sf: z.number().optional().describe("0 for linear shapes; LF × height for surface_area; absent for count"),
  perimeter_lf: z.number().optional().describe("Length for linear/surface runs, perimeter for closed ones; absent for count"),
  count: z.number().optional().describe("count shapes only — the marker's EA (preserved across the edit)"),
  label: z.string().optional().describe("The shape's room/phase label after this call — absent when it carries none (a cleared label reports as absent, not as an empty string)"),
  agent_edits: z.number().int().describe("How many times the agent has revised this shape — separate from the human-correction tally"),
};

/** undo_last: what was actually stepped back. `undone` may be fewer than
 * requested when the journal ran out; the note says so rather than pretending. */
export const undoLastOutput = {
  undone: z.number().int().describe("Steps actually reversed"),
  steps: z.array(z.object({
    seq: z.number().int(),
    op: z.enum(["commit", "edit", "delete", "materials", "condition", "approval", "duplicate_condition", "split_condition"]),
    tool: z.string().describe("The tool call this step came from"),
    shapes: z.number().int().describe("Shapes affected by reversing this step — 0 for a materials step (it restores a condition's supporting-materials rows, not shapes), for a condition step (it restores the waste/multiplier pair), and for an approval step (it re-seats or removes a verdict mark)"),
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
  basis: z.enum(["area", "linear", "count", "seam_lf"]).describe("Which of the condition's totals this row's quantity is computed against — 'seam_lf' is the FIGURED roll-layout seam length (weld rod, seam tape), 0 until the condition carries a roll_setup"),
  unit: z.string(),
  round: z.boolean().describe("true = round up to whole purchase units (the default — you buy whole bags/buckets)"),
  note: z.string().optional(),
  origin_id: z.string().optional().describe("On a twin: the parent row this one follows (the variants.ts family link)"),
  inherited: z.boolean().optional().describe("On a twin: true while the row still follows the family — a patch on it takes it local, split_condition freezes them all"),
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
  basis: z.enum(["area", "linear", "count", "seam_lf"]),
  round: z.boolean(),
  basis_qty: z.number().describe("The condition total this row divides (SF, LF, EA, or figured seam LF — multiplier applied, waste not)"),
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

/** export_marked_pdf — the tool writes the PDF to disk and replies with where
 * and what; the document itself is the deliverable, never inlined. */
export const exportMarkedPdfOutput = {
  path: z.string().describe("Absolute path of the written marked-set PDF — hand this to the user"),
  pages: z.number().int().describe("Legend cover + one page per marked sheet"),
  sheets_marked: z.number().int().describe("Sheets carrying shapes, annotations, or approval marks — unmarked sheets are omitted"),
  shapes_drawn: z.number().int(),
  annotations_drawn: z.number().int(),
  approvals_drawn: z.number().int().describe("Approval-family glyphs burned in (#176) — estimator APPROVED rings + agent AGENT diamonds; the cover tallies the split when any exist"),
  note: z.string(),
};

export const duplicateConditionOutput = {
  condition: z.string().describe("The twin's finish tag — base tag + the label, e.g. 'CPT-1 – Level 2'"),
  condition_id: z.string().describe("The TWIN — measure the new area against this"),
  variant_of: z.string().describe("The condition whose material rows this one follows"),
  variant_label: z.string(),
  family_id: z.string().describe("Shared by every variant of this finish — survives a split"),
  inherited_rows: z.number().int().describe("Material rows copied, all still following the original"),
  note: z.string(),
};

export const splitConditionOutput = {
  condition: z.string(),
  condition_id: z.string(),
  split: z.boolean().describe("false = it already owned its materials; nothing was following"),
  frozen_rows: z.number().int().describe("Following rows frozen at their current values"),
  family_id: z.string().optional().describe("Kept — it still groups with its siblings"),
  note: z.string(),
};

export const editConditionOutput = {
  condition: z.string().describe("The finish tag passed in"),
  condition_id: z.string(),
  waste_pct: z.number().describe("The condition's waste % after this write"),
  multiplier: z.number().describe("The condition's quantity multiplier after this write"),
  height_ft: z.number().optional().describe("The condition's wall height after this write — present once set (measure_surface multiplies traced LF by it)"),
  roll_setup: z.object({}).passthrough().optional().describe("The condition's roll-goods setup after this write — present while opted in"),
  roll: z.object({
    condition_id: z.string(), finish_tag: z.string(), material: z.string(),
    roll_width_ft: z.number(), roll_length_ft: z.number(),
    direction: z.string(), cuts: z.number().int(),
    order_lf: z.number().describe("Full-width roll footage to order, ×N applied, rounded up to the inch"),
    rolls: z.number(), order_qty: z.number(), order_unit: z.string(),
    oversize: z.boolean().describe("true when a cut exceeds the physical roll length (roll_length_ft binds)"),
  }).passthrough().optional().describe("The figured order (same row export_report's roll_goods carries) — present when the roll-goods condition has floor shapes on scaled sheets"),
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
const graphRoom = z.object({
  tag: z.string(),
  name: z.string().describe("The name span stacked over the tag ('' when none)"),
  sheet: z.string(),
  bbox: wireBox,
  building: z.string().optional().describe("The building the room belongs to, when the set names one — its plan sheet's BUILDING/BLDG context, or the tag's own qualifier ('A-134')"),
});

export const sheetGraphOutput = {
  available: z.boolean().describe("false = the set has no text layer (a scan) — the graph degrades to unavailable, never half-populates"),
  sheets: z.array(z.object({
    sheet: z.string(),
    role: z.enum(["plan", "schedule", "legend", "detail", "elevation", "demolition", "unknown"]),
    confidence: z.number().describe("0..1; mixed title signals halve it, a bare sheet-number convention stays under 0.5"),
    evidence: wireEvidence.optional(),
    building: z.string().optional().describe("The sheet's building context, when it names exactly one (BUILDING A / BLDG 2)"),
    schedules: z.array(z.object({
      kind: z.string(), title: z.string(), rows: z.number().int(), region: wireBox,
      continues: z.string().optional().describe("Present on a continuation fragment ('… SCHEDULE — CONT'D'): the sheet carrying the table's base fragment. The fragments read as ONE table — resolve_tag and find_schedule already see the union"),
      rotated_headers: z.boolean().optional().describe("true when the column headers were read at a quarter-turn"),
    })),
  })),
  rooms: z.array(graphRoom).describe("Room tags read off plan-role sheets — schedule sheets contribute rows, never phantom rooms"),
  callouts: z.array(z.object({ detail: z.string(), target_sheet: z.string(), sheet: z.string(), bbox: wireBox })).describe("Detail callouts (3/A-601) — edges to their target sheets"),
  buildings: z.array(z.string()).optional().describe("Every building designator the set names (sorted) — present only on multi-building-aware sets. Room numbers reused across these need qualified tags ('A-134')"),
  notes: z.array(z.string()).optional().describe("Named gaps found while indexing (e.g. a continuation whose rows could not be aligned) — the graph refuses silently dropping anything"),
  counts: z.object({ rooms: z.number().int(), schedules: z.number().int().describe("LOGICAL tables — a schedule continued across sheets counts once"), callouts: z.number().int() }),
};

export const resolveTagOutput = {
  status: z.enum(["resolved", "unresolved"]),
  tag: z.string(),
  room: graphRoom.nullable().describe("The plan tag, when the room appears on a plan sheet — cited even when resolution fails. null on a multi-building ambiguity: citing one building's tag would be quietly wrong"),
  building: z.string().optional().describe("resolved only — the building whose schedule row answered, when the set names buildings"),
  finishes: z.array(z.object({
    surface: z.string().describe("The schedule column: FLOOR / BASE / WALL / …"),
    code: z.string(),
    source: wireEvidence,
    definition: z.object({ cells: z.record(z.string()), source: wireEvidence }).optional()
      .describe("The finish/material-schedule row this code chains to, when one exists"),
  })).optional(),
  sources: z.array(wireEvidence).optional().describe("The chain: plan tag → schedule row (the row cites the sheet that CARRIES it — under a continuation that is the CONT'D sheet)"),
  reason: z.string().optional().describe("unresolved only — WHY (no schedule row / ambiguous / no schedule found). A room that appears on the plan with no row comes back here, never as a silent omission"),
  candidates: z.array(z.object({
    key: z.string(), building: z.string().optional(), sheet: z.string(), table: z.string(),
  })).optional().describe("unresolved only — every schedule row that COULD have answered (an ambiguous multi-building tag lists one per building; qualify the tag, e.g. \"A-134\", to pick)"),
};

export const findScheduleOutput = {
  matches: z.array(z.object({
    sheet: z.string(), kind: z.string(), title: z.string(),
    rows: z.number().int().describe("Total data rows — a continued schedule counts every fragment's rows"),
    headers: z.array(z.string()), region: wireBox.describe("Pass to view_sheet to look at the table (the BASE fragment's region when the table continues)"),
    building: z.string().optional().describe("The building this table answers for, when its title or sheet names one"),
    rotated_headers: z.boolean().optional().describe("true when the column headers were read at a quarter-turn"),
    parts: z.array(z.object({ sheet: z.string(), title: z.string(), rows: z.number().int(), region: wireBox }))
      .optional().describe("Present when the table CONTINUES across sheets ('… SCHEDULE — CONT'D'): every fragment, base first, each with its own viewable region"),
  })),
};

/** sweep_schedule_row — a schedule row's tag, anchored to its drawn marker
 * and swept across the plan sheets. A match counts ONLY when the row's own
 * tag text sits within the marker footprint; everything else is disclosed. */
const rowSweepPlacement = {
  at: z.tuple([z.number(), z.number()]).describe("The matched marker's centroid (image px)"),
  score: z.number().describe("Length-weighted fraction of the anchor's segments matched within tolerance, 0..1"),
  rotation: z.number().describe("Detected rotation in degrees (0 | 90 | 180 | 270)"),
  mirrored: z.boolean(),
};

export const sweepScheduleRowOutput = {
  tag: z.string().describe("The row key as normalized (the tag as drawn)"),
  row: z.object({
    sheet: z.string(),
    table: z.string().describe("The table's title (or kind, when untitled)"),
    key: z.string(),
    cells: z.record(z.string()).describe("The row's cells, header → text — what the schedule SAYS this mark is"),
    citation: wireEvidence,
  }).describe("The schedule row the sweep was seeded from — the condition's source"),
  anchor: z.object({
    sheet: z.string().describe("The plan sheet the fingerprint was anchored on"),
    at: z.tuple([z.number(), z.number()]).describe("The anchoring tag occurrence's center (image px)"),
    rect: z.array(z.number()).length(4).describe("The fingerprint rect actually used [x0, y0, x1, y1] — the pad ladder's winning step"),
    segments: z.number().int().describe("Vector segments in the marker fingerprint"),
    length_px: z.number(),
    corroborated: z.boolean().describe("true = the fingerprint recurred at a second tag occurrence before being trusted; false = the tag is drawn too sparsely to cross-check (see note)"),
    occurrences: z.number().int().describe("Drawn occurrences of the tag across all plan sheets"),
  }),
  found: z.number().int().describe("Matches carrying the row's own tag — the honest count, across every plan sheet"),
  sheets: z.array(z.object({
    sheet: z.string(),
    found: z.number().int(),
    matches: z.array(z.object({ ...rowSweepPlacement, tag_at: wireBox.describe("The corroborating tag text's bbox — the evidence that this marker is THIS row's") })),
    withheld: z.array(z.object({ ...rowSweepPlacement, reason: z.string() }))
      .describe("Questions, never counts: markers matching the geometry but carrying no tag (an unlabeled instance or a shared bubble shape), and near-miss scores in the [0.75, 0.92) band"),
    excluded: z.array(z.object({ at: z.tuple([z.number(), z.number()]), tag: z.string() }))
      .describe("Markers matching the geometry but labeled with a SIBLING row's tag — the bubble shape is shared across marks, so these belong to that row, not this one"),
    text_only: z.array(z.object({ at: z.tuple([z.number(), z.number()]) }))
      .describe("The tag drawn with NO matching marker geometry nearby — a note reference or a variant marker; a question, never a count"),
    candidates: z.object({ considered: z.number().int(), dropped: z.number().int() }),
    elapsed_ms: z.number().describe("Wall-clock for this sheet's sweep"),
    scaled: sweepScaled.optional(),
    scale_assumed: sweepScaleAssumed.optional(),
  })).describe("One entry per swept PLAN-role sheet, load order"),
  skipped: z.array(z.object({ sheet: z.string(), role: z.string(), reason: z.string() }))
    .describe("Sheets excluded from counting (schedule/detail/legend/unknown), each with its reason"),
  committed: z.number().int().optional().describe("commit mode: count shapes committed — one per counted match, the whole sweep ONE undo step"),
  shape_ids: z.array(z.string()).optional(),
  condition: z.string().optional().describe("commit mode: the condition minted FROM the row — its key is the tag"),
  ea_total: z.number().optional(),
  note: z.string().optional(),
  warning: z.string().optional().describe("Present when the per-sheet work cap dropped candidates"),
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
    spans: z.array(z.object({ str: z.string(), x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(), rot: z.number().optional().describe("Run direction in degrees, clockwise, y down — present only when rotated (90/270 = a quarter-turn, e.g. rotated schedule headers)") })).describe("Text with bboxes, image px, same frame as the vectors"),
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
  from: z.tuple([z.number(), z.number()]).optional().describe("Arrow tail / dimension start (image px)"),
  to: z.tuple([z.number(), z.number()]).optional().describe("Arrow head / dimension end (image px)"),
  r: z.number().optional().describe("Bubble radius (image px)"),
  length_lf: z.number().optional().describe("Dimension only: the measured length in real feet, snapshotted at annotate time from the sheet scale"),
});

export const annotateOutput = {
  id: z.string(),
  sheet: z.string(),
  type: z.string(),
  text: z.string(),
  condition: z.string(),
  condition_id: z.string(),
  length_lf: z.number().optional().describe("Dimension only: the measured length (real feet) the annotation will label itself with"),
  note: z.string(),
};

// ── verdict marks (#176) — the agent half of the approval family ─────────────
/** One approval-family record as the inventory reports it. actor is whose
 * mark it is: only "agent" records are mintable or liftable over MCP — the
 * estimator's ring appears here solely when a file carried it in. */
const verdictRow = z.object({
  id: z.string(),
  actor: z.enum(["estimator", "agent"]).describe('"estimator" = the human APPROVED ring (ink — import-borne here, never minted over MCP), "agent" = the AGENT diamond'),
  sheet: z.string(),
  at: z.tuple([z.number(), z.number()]).optional().describe("Render anchor (image px) — absent only when the record rides a sheet from a file this session hasn't loaded (#152)"),
  ts: z.string().optional().describe("ISO-8601 mint time"),
  shape_id: z.string().optional().describe("Present when the verdict targets a committed shape — WHAT was marked, not where it draws"),
  condition: z.string().describe("The targeted shape's finish tag, resolved — '' for sheet-point marks"),
  text: z.string().optional().describe("The optional short note riding the record"),
});

export const markVerdictOutput = {
  id: z.string().describe('The minted record id ("apr-…")'),
  actor: z.literal("agent").describe("Always agent — this tool is structurally incapable of minting the estimator's seal"),
  sheet: z.string(),
  at: z.tuple([z.number(), z.number()]).optional().describe("Where the AGENT diamond renders (image px) — absent only when the marked shape rides a sheet from a file this session hasn't loaded (#152)"),
  ts: z.string().describe("ISO-8601 mint time"),
  shape_id: z.string().optional().describe("Shape mode: the committed shape this verdict is about"),
  condition: z.string().optional().describe("Shape mode: the marked shape's finish tag, resolved"),
  text: z.string().optional(),
  note: z.string(),
};

export const deleteVerdictOutput = {
  deleted: z.string().describe("The lifted record's id"),
  verdicts_remaining: z.number().int().describe("Approval-family records still on the takeoff (both actors)"),
};

export const listAnnotationsOutput = {
  annotations: z.array(annotationRow),
  count: z.number().int(),
  unattached: z.number().int().describe("How many carry no condition — candidates for link_annotation"),
  verdicts: z.array(verdictRow).describe("Approval-family records (#176) under the same filters: sheet applies directly; a condition filter reaches a verdict THROUGH its target shape (a sheet-point mark carries no scope and drops out)"),
  verdict_count: z.number().int(),
};

export const linkAnnotationOutput = {
  id: z.string(),
  condition: z.string(),
  condition_id: z.string().optional(),
  note: z.string(),
};
