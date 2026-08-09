// #230 — the phase map an opt-in staged mode reads to hold most of the forty
// tools back until an agent asks for the phase it's actually in. The default
// server (env unset) is unchanged: all forty enabled on connect, exactly the
// contract every currently-published client already expects. The four groups
// mirror the workflow the server's own `initialize` instructions already
// describe in prose (load/scale → commit → derive/look → export) — this
// makes that structural instead of just advisory text an agent can ignore.
export type ToolStageKey = "measure" | "revise" | "handoff";

export interface ToolStage {
  key: ToolStageKey;
  title: string;
  summary: string;
  tools: readonly string[];
}

export const TOOL_STAGES: readonly ToolStage[] = [
  {
    key: "measure",
    title: "Measure & derive",
    summary: "Commit shapes and derive what follows from them: One-Click and its batch/sweep variants, the manual measure tools, cut_out, derive_base, derive_transitions.",
    tools: ["one_click", "detect_rooms", "measure_polygon", "cut_out", "measure_line", "measure_surface", "place_count", "symbol_sweep", "sweep_schedule_row", "derive_base", "derive_transitions"],
  },
  {
    key: "revise",
    title: "Revise & review",
    summary: "Look at what landed and fix it: the shape/materials/condition editors, undo, the inventory reads, annotations, and the agent verdict marks.",
    tools: ["list_shapes", "delete_shape", "edit_shape", "edit_materials", "edit_condition", "duplicate_condition", "split_condition", "undo_last", "annotate", "list_annotations", "link_annotation", "mark_verdict", "delete_verdict"],
  },
  {
    key: "handoff",
    title: "Handoff & export",
    summary: "Turn committed work into a deliverable: totals, the takeoff/report exports, resuming a prior session, and the marked-up planset.",
    tools: ["takeoff_summary", "export_takeoff", "export_report", "import_takeoff", "apply_rules", "export_marked_pdf"],
  },
];

// Always enabled, staged or not — an agent needs these before anything else
// on the sheet is answerable. Listed here only so open_tool_stage can name
// what's already open without re-deriving it from TOOL_STAGES' absence.
export const SETUP_STAGE_TOOLS: readonly string[] = [
  "load_plan", "sheet_info", "set_scale", "sheet_graph", "resolve_tag",
  "find_schedule", "read_sheet_text", "find_text", "sheet_context", "view_sheet",
];

export const STAGED_TOOLS_ENV = "OPENTAKEOFF_MCP_STAGED_TOOLS";

export function stagedToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STAGED_TOOLS_ENV] === "1";
}
