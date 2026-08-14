// Staged tool exposure (#230) — opt-in via OPENTAKEOFF_MCP_STAGED_TOOLS=1.
// The flat forty stay the default for every published client; behind the flag
// only the setup stage starts enabled and `open_tool_stage` grows the surface
// on demand, so an agent session pays for the tool descriptions it actually
// uses. The stage map is the same phase structure the initialize instructions
// already describe in prose: orient → measure → revise → hand off.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, UserError } from "./format.ts";

/** Every tool the server registers, by workflow stage. The four lists must
 * partition the full tool set exactly — enforced by a test, so a new tool
 * that skips this table fails CI instead of silently landing stageless. */
export const TOOL_STAGES: Record<string, readonly string[]> = {
  // Always enabled: an agent needs these to orient before anything else is useful.
  setup: [
    "load_plan", "sheet_info", "set_scale", "sheet_graph", "resolve_tag",
    "find_schedule", "read_sheet_text", "find_text", "sheet_context", "view_sheet",
  ],
  measure: [
    "one_click", "detect_rooms", "measure_polygon", "cut_out", "measure_line",
    "measure_surface", "place_count", "symbol_sweep", "sweep_schedule_row",
    "derive_base", "derive_transitions",
  ],
  revise: [
    "list_shapes", "delete_shape", "edit_shape", "edit_materials", "edit_condition",
    "duplicate_condition", "split_condition", "undo_last", "annotate",
    "list_annotations", "link_annotation", "mark_verdict", "delete_verdict",
  ],
  handoff: [
    "takeoff_summary", "export_takeoff", "export_report", "import_takeoff",
    "apply_rules", "export_marked_pdf",
  ],
};

const OPENABLE = ["measure", "revise", "handoff"] as const;

export const openToolStageOutput = {
  stage: z.string().describe("The stage that was opened"),
  enabled: z.array(z.string()).describe("Tool names enabled by this call (empty if the stage was already open)"),
  open_stages: z.array(z.string()).describe("Every stage currently enabled, setup included"),
  closed_stages: z.array(z.string()).describe("Stages still closed — open them here when the work reaches them"),
};

/** One line appended to the initialize instructions when staging is on, so an
 * agent learns the surface grows on demand before it ever lists tools. */
export const STAGED_INSTRUCTIONS =
  "TOOL EXPOSURE IS STAGED: only the setup tools are enabled at start. Before measuring, call open_tool_stage {stage:\"measure\"}; likewise \"revise\" for edit/annotate/verdict tools and \"handoff\" for summaries and exports. Opening a stage is instant, idempotent, and never closes anything.";

/**
 * Disable everything outside `setup` and register `open_tool_stage`.
 * RegisteredTool.enable() fires the tools/list_changed notification itself
 * (the SDK no-ops it before a transport connects), so a client that supports
 * dynamic tool lists sees the group appear the moment the agent asks for it.
 */
export function applyStagedTools(server: McpServer, registered: Map<string, RegisteredTool>): void {
  const openStages = new Set<string>(["setup"]);
  for (const stage of OPENABLE) {
    for (const name of TOOL_STAGES[stage]) registered.get(name)?.disable();
  }

  server.registerTool("open_tool_stage", {
    description: `Enable a stage of this server's tools. Tool exposure is staged to match the takeoff workflow: "setup" (orient: load, scale, read the set) is always enabled; "measure" (commit shapes: one_click, detect_rooms, measure_*, sweeps and derives), "revise" (edit, annotate, verdict-mark, undo), and "handoff" (summaries, exports, the marked set) start closed and open here on demand. Opening a stage is idempotent and never closes another — the surface only grows. Call it the moment the work reaches a closed stage; the reply lists exactly which tools just became available.`,
    inputSchema: {
      stage: z.enum(OPENABLE).describe('Which stage to enable: "measure", "revise", or "handoff"'),
    },
    outputSchema: openToolStageOutput,
  }, async ({ stage }: { stage: (typeof OPENABLE)[number] }) => {
    try {
      const names = TOOL_STAGES[stage];
      const enabled: string[] = [];
      for (const name of names) {
        const tool = registered.get(name);
        if (!tool) throw new UserError(`Stage table names an unregistered tool: ${name}`);
        if (!tool.enabled) {
          tool.enable();
          enabled.push(name);
        }
      }
      openStages.add(stage);
      return ok({
        stage,
        enabled,
        open_stages: Object.keys(TOOL_STAGES).filter((s) => openStages.has(s)),
        closed_stages: Object.keys(TOOL_STAGES).filter((s) => !openStages.has(s)),
      });
    } catch (e) {
      return fail(e);
    }
  });
}
