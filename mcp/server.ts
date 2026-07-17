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
  const server = new McpServer({ name: "opentakeoff", version: pkg.version });
  registerTools(server, session);
  registerResources(server, session);
  return server;
}

// Connect stdio only when run as the entry point (tests import buildServer and
// wire an in-memory transport instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildServer().connect(new StdioServerTransport());
}
