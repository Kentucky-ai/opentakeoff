// The resource surface — the "agent eyes" half of AI-native: browse a plan
// set (index → metadata → text → rendered image) before ever measuring.
//
// URI scheme (issue #29):
//   takeoff://sheets              the plan index — always listed, sensible when empty
//   takeoff://sheet/{page}        one sheet's metadata (JSON), 1-based page number
//   takeoff://sheet/{page}/text   the sheet's text, joined (text/plain)
//   takeoff://sheet/{page}/image  the rendered page (PNG, long edge ≤ IMAGE_MAX_EDGE)
//
// Pages — not sheet keys — address resources: page numbers are URI-safe no
// matter what the PDF is named. The human-facing key ("plan.pdf#2") and
// title-block number ("A-101") ride along as resource name/title instead.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "./session.ts";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function parsePage(session: Session, raw: string | string[]) {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(s ?? "")) throw new Error(`Sheet resources are addressed by page number — got ${JSON.stringify(s)}.`);
  return session.sheetForPage(Number(s));
}

export function registerResources(server: McpServer, session: Session): void {
  const sheetEntries = (suffix: string, mimeType: string, what: string) => () => ({
    resources: session.sheetList().map((s) => ({
      uri: `takeoff://sheet/${s.pageNum}${suffix}`,
      name: `${s.key}${suffix.replace("/", " · ")}`,
      ...(s.sheetNumber ? { title: `${s.sheetNumber} — ${what}` } : { title: `page ${s.pageNum} — ${what}` }),
      description: `${what} for ${s.key}${s.sheetNumber ? ` (${s.sheetNumber})` : ""}`,
      mimeType,
    })),
  });

  server.registerResource(
    "sheet-index",
    "takeoff://sheets",
    {
      title: "Sheet index",
      description: "The loaded plan set at a glance: file, page count, and every sheet's dims, title-block number, detected scale, scale state, and shape count. Read this first.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(session.index()) }],
    }),
  );

  server.registerResource(
    "sheet",
    new ResourceTemplate("takeoff://sheet/{page}", { list: sheetEntries("", "application/json", "sheet metadata") }),
    {
      title: "Sheet metadata",
      description: "One sheet: dims (px and pt), title-block sheet number, detected scale, scale state, committed shape count. JSON.",
      mimeType: "application/json",
    },
    async (uri, { page }) => {
      const s = parsePage(session, page);
      const idx = session.index();
      const row = idx.sheets.find((x) => x.page === s.pageNum);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(row) }] };
    },
  );

  server.registerResource(
    "sheet-text",
    new ResourceTemplate("takeoff://sheet/{page}/text", { list: sheetEntries("/text", "text/plain", "sheet text") }),
    {
      title: "Sheet text",
      description: "The sheet's text content, reading order, joined — title block, room labels, schedules, scale notes. For positions use the read_sheet_text tool.",
      mimeType: "text/plain",
    },
    async (uri, { page }) => {
      const s = parsePage(session, page);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: session.readSheetText(s.key).text }] };
    },
  );

  server.registerResource(
    "sheet-image",
    new ResourceTemplate("takeoff://sheet/{page}/image", { list: sheetEntries("/image", "image/png", "rendered page") }),
    {
      title: "Rendered page",
      description: "The page rendered to PNG, long edge capped at 1568 px — sized for vision-model eyes. Coordinates in the image scale linearly to the tool coordinate space (image px at render scale 2.0).",
      mimeType: "image/png",
    },
    async (uri, { page }) => {
      const s = parsePage(session, page);
      const png = await session.renderSheetPng(s.pageNum);
      return { contents: [{ uri: uri.href, mimeType: "image/png", blob: toBase64(png) }] };
    },
  );
}
