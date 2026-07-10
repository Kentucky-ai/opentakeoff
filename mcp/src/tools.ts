// The ten tools — thin zod-validated handlers over the Session. Replies are
// compact JSON (format.ts); failures are isError results, never thrown
// protocol errors.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, UserError, type ToolReply } from "./format.ts";
import type { Session } from "./session.ts";

// The coordinate contract, stated on every tool so any agent reading any one
// description knows the space it is working in.
const COORDS = "Coordinates are image px at render scale 2.0: PDF pt × 2, origin top-left, y down (the browser canvas's native space). Sheet payloads carry dims in both px and pt.";

const pointSchema = z.tuple([z.number(), z.number()]);
const roleSchema = z.enum(["floor_area", "deduct"]).default("floor_area");

const run = (fn: (args: any) => unknown | Promise<unknown>) =>
  async (args: any): Promise<ToolReply> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

export function registerTools(server: McpServer, session: Session): void {
  server.registerTool("load_plan", {
    description: `Open a plan PDF from disk and replace the whole session (previous document, scales, conditions, and shapes are cleared). Returns file, page_count, and one entry per sheet: dims, title-block sheet_number, and the detected drawn scale where present. ${COORDS}`,
    inputSchema: { path: z.string().describe("Path to a plan PDF on disk") },
  }, run(({ path }) => session.loadPlan(path)));

  server.registerTool("sheet_info", {
    description: `Sheet detail: dims (px and pt), vector segment count, whether the sheet has vector linework (one_click needs it), scale status, the detected scale suggestion, and this sheet's committed shape count. ${COORDS}`,
    inputSchema: { sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101")') },
  }, run(({ sheet }) => session.sheetInfo(sheet)));

  server.registerTool("set_scale", {
    description: `Set a sheet's scale — exactly ONE of: label (a standard scale, e.g. '1/4" = 1'-0"'), upp (real feet per image px), calibrate (two points along a known dimension plus its real feet), or use_detected (adopt the drawn scale note read off the sheet). The detected scale is never applied automatically — setting it is always this explicit call. Changing the scale re-prices the sheet's committed shapes at the new scale (the response reports repriced: N) — earlier takeoff_summary results for that sheet are stale after this call. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      label: z.string().optional().describe("A standard scale label, exactly as listed in the error on a miss"),
      upp: z.number().optional().describe("Real feet per image px at render scale 2.0"),
      calibrate: z.object({ p1: pointSchema, p2: pointSchema, feet: z.number() }).optional()
        .describe("Two points (image px) a known real distance apart, and that distance in feet"),
      use_detected: z.literal(true).optional().describe("true = adopt the sheet's detected scale"),
    },
  }, run((a) => {
    const given = [a.label !== undefined, a.upp !== undefined, a.calibrate !== undefined, a.use_detected !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UserError("Provide exactly one of: label, upp, calibrate, use_detected.");
    return session.setScale(a.sheet, a);
  }));

  server.registerTool("one_click", {
    description: `One-Click Area: click inside a room (image px) and the plan's vector linework bounds it — flood fill, contour trace, vertices snapped to true PDF endpoints. With the sheet's scale set, returns area_sf / perimeter_lf; pass condition (a finish tag, e.g. "CPT-1") to commit the traced shape to the takeoff. Without a scale it returns px-only quantities with a warning and commits nothing. role "deduct" makes the committed shape subtract. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      x: z.number(),
      y: z.number(),
      condition: z.string().optional().describe("Finish tag to commit under (minted on first use)"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include the traced polygon's vertices (image px)"),
    },
  }, run((a) => session.oneClick(a.sheet, a.x, a.y, { condition: a.condition, role: a.role, returnVerts: a.return_verts })));

  server.registerTool("measure_polygon", {
    description: `Measure a closed polygon you supply (min 3 vertices, image px): area_sf and perimeter_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it; role "deduct" subtracts. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      verts: z.array(pointSchema).min(3),
      condition: z.string().optional(),
      role: roleSchema,
    },
  }, run((a) => session.measurePolygon(a.sheet, a.verts, { condition: a.condition, role: a.role })));

  server.registerTool("measure_line", {
    description: `Measure an open polyline (min 2 points, image px): length_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it as a linear shape (base, transitions, feature strips). ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      pts: z.array(pointSchema).min(2),
      condition: z.string().optional(),
    },
  }, run((a) => session.measureLine(a.sheet, a.pts, { condition: a.condition })));

  server.registerTool("takeoff_summary", {
    description: `Per-condition totals (floor/wall/border SF, LF, EA, SY, with and without waste) plus grand totals — the Report's numbers, computed by the same rules. ${COORDS}`,
    inputSchema: {},
  }, run(() => session.summary()));

  server.registerTool("export_takeoff", {
    description: `The full "opentakeoff.takeoff_canvas.v1" annotations payload — exactly what the app autosaves, importable by it. Returned inline; pass path to also write it to disk as JSON. ${COORDS}`,
    inputSchema: { path: z.string().optional().describe("File path to write the payload to") },
  }, run(async ({ path: outPath }) => {
    const payload = session.exportPayload();
    if (outPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outPath, JSON.stringify(payload));
    }
    return payload;
  }));

  server.registerTool("delete_shape", {
    description: `Remove a committed shape by the id returned when it was committed. ${COORDS}`,
    inputSchema: { shape_id: z.string() },
  }, run(({ shape_id }) => session.deleteShape(shape_id)));

  server.registerTool("read_sheet_text", {
    description: `The sheet's text with positions — items [{str, x, y}] in image px plus the joined text. Optionally restrict to a region {x0, y0, x1, y1}. Use it to read title blocks, room labels, finish schedules, and scale notes. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
    },
  }, run((a) => session.readSheetText(a.sheet, a.region)));
}
