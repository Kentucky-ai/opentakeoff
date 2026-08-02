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
import pkg from "./package.json" with { type: "json" };

export function buildServer(session: Session = new Session()): McpServer {
  const server = new McpServer({ name: "opentakeoff", version: pkg.version }, {
    // Served to every client at initialize — the discipline that makes agent
    // takeoffs land as reviewable work instead of a bare numbers report.
    instructions: [
      "OpenTakeoff: quantity takeoff on construction plan PDFs.",
      "A takeoff's deliverable is the marked-up planset, not a numbers report. Standard finish for ANY takeoff:",
      "1. load_plan, then set_scale on each sheet you measure (quantities are px-only until the scale is set).",
      "2. Commit shapes under finish-tag conditions (one_click / detect_rooms / measure_polygon / measure_line with `condition`; when the set carries a room-finish schedule, prefer detect_rooms assign_from_schedule so each room commits under its OWN row).",
      "3. DERIVE what follows from the rooms instead of re-measuring it: derive_base for base LF (perimeter − the door openings YOU state), derive_transitions for the line where two finishes meet. Both read committed floor shapes, so they come after step 2 and their output is audited in step 4 like anything else.",
      "4. LOOK at what landed with view_sheet overlay:true and fix misses with edit_shape before trusting totals — crop the work region tight (full-sheet renders downsample too far to audit a ring).",
      "5. Finish by writing the marked-up planset with export_marked_pdf and give the user its file path, alongside export_report for the numbers. Never end a takeoff with numbers alone.",
      "WITHHELD IS NOT A FAILURE — IT IS THE ANSWER. detect_rooms, symbol_sweep, sweep_schedule_row and derive_transitions all measure things they then decline to commit, and say why: a near-match in the score band, a room the schedule cannot answer for, adjacency across a WALL rather than a butt joint. Read those arrays, view_sheet the coordinates they hand you, and resolve them or report them. A withheld item you ignore is a hole in the bid; one you never mention is worse.",
    ].join("\n"),
  });
  registerTools(server, session);
  registerResources(server, session);
  return server;
}

// Connect stdio only when run as the entry point (tests import buildServer and
// wire an in-memory transport instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildServer().connect(new StdioServerTransport());
}
