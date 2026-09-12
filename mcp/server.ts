// OpenTakeoff MCP server — the takeoff engine on stdio for your MCP client.
// Run: node --import tsx server.ts   (tsx is a runtime dependency: the engine
// is imported straight from web/src/lib as TypeScript).
import "./src/hush.ts"; // must stay the FIRST import — static imports hoist, and pdf.js logs via console.log (see src/hush.ts)
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./src/session.ts";
import { registerTools } from "./src/tools.ts";
import { registerResources } from "./src/resources.ts";
import { applyStagedTools, STAGED_INSTRUCTIONS } from "./src/staging.ts";
import { oneClickEnabled, GATE_NOTE } from "./src/gate.ts";
import pkg from "./package.json" with { type: "json" };

export function buildServer(
  session: Session = new Session(),
  // #230 — staged exposure is opt-in: every published client expects the flat
  // forty and gets it by default. The option exists so tests don't mutate env.
  // oneClick — the TEMPORARY gate (src/gate.ts): false on a default build, so
  // one_click / detect_rooms are not registered; true puts them back.
  opts: { stagedTools?: boolean; oneClick?: boolean } = {},
): McpServer {
  const staged = opts.stagedTools ?? process.env.OPENTAKEOFF_MCP_STAGED_TOOLS === "1";
  const oneClick = oneClickEnabled(opts.oneClick);
  const server = new McpServer({ name: "opentakeoff", version: pkg.version }, {
    // Served to every client at initialize — the discipline that makes agent
    // takeoffs land as reviewable work instead of a bare numbers report.
    instructions: [
      "OpenTakeoff: quantity takeoff on construction plan PDFs.",
      "Knowledge: read takeoff://wiki for the task router, then only the relevant takeoff://wiki/{page}. Pages cover capability limits, architecture, protocol, workflows, MCP routing and domain knowledge; takeoff://wiki/tool-index lists tool stages and required inputs. These resources work before loading a plan and do not change the session.",
      "A takeoff's deliverable is the marked-up planset, not a numbers report. Standard finish for ANY takeoff:",
      "1. load_plan, then set_scale on each sheet you measure (quantities are px-only until the scale is set).",
      oneClick
        ? "2. Commit shapes under finish-tag conditions (one_click / detect_rooms / measure_polygon / measure_line with `condition`; when the set carries a room-finish schedule, prefer detect_rooms assign_from_schedule so each room commits under its OWN row; a traced ring sits on the INNERMOST wall faces from get_sheet_vectors, crosses doors on the wall centerline, wraps columns and stubs, never follows hatch or a door leaf, and is checked on a tight view_sheet overlay crop before the next room — takeoff://wiki/workflows has the rule set). A COUNT takeoff of value-annotated device marks (GRDs, fixtures, equipment — the tag-over-value pattern) starts with count_marks {commit: true}: the whole census in one deterministic call, then audit its withheld entries — reach for the agent-driven per-mark tools only where it refuses or withholds."
        : "2. Commit shapes under finish-tag conditions (measure_polygon / measure_line with `condition`; a room's polygon is its INNERMOST wall faces — read the strokes with get_sheet_vectors over a tight region, put every vertex on a face stroke, cross each door or cased opening on the wall's centerline so both rooms share that segment, run straight past windows, wrap columns, chases and wall stubs, never trace hatch, casework or a door leaf, then view_sheet a tight crop with overlay:true and fix the ring with edit_shape before the next room; take the finish tag from the room's own schedule row via resolve_tag; takeoff://wiki/workflows has the full rule set). A COUNT takeoff of value-annotated device marks (GRDs, fixtures, equipment — the tag-over-value pattern) starts with count_marks {commit: true}: the whole census in one deterministic call, then audit its withheld entries — reach for the agent-driven per-mark tools only where it refuses or withholds.",
      "3. DERIVE what follows from the rooms instead of re-measuring it: derive_base for base LF (perimeter − the door openings YOU state), derive_transitions for the line where two finishes meet. Both read committed floor shapes, so they come after step 2. derive_base draws the whole perimeter even where LF is deducted: when the handoff needs actual installed runs, use measure_line on the physical base segments and cut_out for located gaps. Do not clip a derived base that already carries numeric openings. Inspect finish splits, alcoves, jambs and withheld transitions in step 4.",
      "4. LOOK at what landed with view_sheet overlay:true and fix misses with edit_shape before trusting totals — crop the work region tight (full-sheet renders downsample too far to audit a ring).",
      "5. Finish by writing the marked-up planset with export_marked_pdf and give the user its file path, alongside export_report for the numbers. Never end a takeoff with numbers alone.",
      "A floor split across sheets at a MATCH LINE: there is no stitch verb, deliberately — joining and aligning a match line is human judgment in the canvas (a sloppy join silently skews every seam-crossing quantity). Measure each member sheet as its own surface and tell the user a seam-crossing room needs their stitch in the app; never approximate one by combining sheets yourself.",
      `WITHHELD IS NOT A FAILURE — IT IS THE ANSWER. ${oneClick ? "detect_rooms, " : ""}symbol_sweep, sweep_schedule_row, count_marks and derive_transitions all measure things they then decline to commit, and say why: a near-match in the score band, a room the schedule cannot answer for, adjacency across a WALL rather than a butt joint. Read those arrays, view_sheet the coordinates they hand you, and resolve them or report them. A withheld item you ignore is a hole in the bid; one you never mention is worse.`,
      "For annotation cleanup, list_annotations gives ids and edit_annotation changes only text with undo. RFI-linked notes require review in the browser register; annotation edits cannot create approval.",
      "When the DRAWINGS are the problem — a schedule row the plan never draws, a room the schedule has no row for, a finish called out two ways — raise it with create_rfi (annotate a cloud at the conflict first and link it) instead of describing it in prose: the question lands numbered in the estimator's RFI register and prints in the marked set, pending their acceptance before it goes to the architect.",
      ...(oneClick ? [] : [GATE_NOTE]),
      ...(staged ? [STAGED_INSTRUCTIONS] : []),
    ].join("\n"),
  });
  const registered = registerTools(server, session, { oneClick });
  registerResources(server, session);
  if (staged) applyStagedTools(server, registered, oneClick);
  return server;
}

// Connect stdio only when run as the entry point (tests import buildServer and
// wire an in-memory transport instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildServer().connect(new StdioServerTransport());
}
