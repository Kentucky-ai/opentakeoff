// The eleven tools — thin zod-validated handlers over the Session. Replies are
// compact JSON (format.ts); failures are isError results, never thrown
// protocol errors.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, UserError, type ToolReply } from "./format.ts";
import type { Session } from "./session.ts";
import { traceToolCall } from "./trace.ts";
import {
  loadPlanOutput, sheetInfoOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput,
} from "./outputs.ts";

// The coordinate contract, stated on every tool so any agent reading any one
// description knows the space it is working in.
const COORDS = "Coordinates are image px at render scale 2.0: PDF pt × 2, origin top-left, y down (the browser canvas's native space). Sheet payloads carry dims in both px and pt.";

const pointSchema = z.tuple([z.number(), z.number()]);
const roleSchema = z.enum(["floor_area", "deduct"]).default("floor_area");

const run = (tool: string, fn: (args: any) => unknown | Promise<unknown>) =>
  async (args: any): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      reply = ok(await fn(args));
    } catch (e) {
      reply = fail(e);
    }
    traceToolCall(tool, args, startedAt, reply);
    return reply;
  };

export function registerTools(server: McpServer, session: Session): void {
  server.registerTool("load_plan", {
    description: `Open a plan PDF from disk and replace the whole session (previous document, scales, conditions, and shapes are cleared). Returns file, page_count, and one entry per sheet: dims, title-block sheet_number, and the detected drawn scale where present. The loaded sheets also become browsable resources (takeoff://sheets). ${COORDS}`,
    inputSchema: { path: z.string().describe("Path to a plan PDF on disk") },
    outputSchema: loadPlanOutput,
  }, run("load_plan", async ({ path }) => {
    const loaded = await session.loadPlan(path);
    server.sendResourceListChanged(); // the resource surface just changed under every subscriber
    return loaded;
  }));

  server.registerTool("sheet_info", {
    description: `Sheet detail: dims (px and pt), vector segment count, whether the sheet has vector linework (one_click needs it), scale status, the detected scale suggestion, and this sheet's committed shape count. ${COORDS}`,
    inputSchema: { sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101")') },
    outputSchema: sheetInfoOutput,
  }, run("sheet_info", ({ sheet }) => session.sheetInfo(sheet)));

  server.registerTool("set_scale", {
    description: `Set a sheet's scale — exactly ONE of: label (a standard scale, e.g. '1/4" = 1'-0"'), upp (real feet per image px), calibrate (two points along a known dimension plus its real feet), or use_detected (adopt the drawn scale note read off the sheet). The detected scale is never applied automatically — setting it is always this explicit call. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      label: z.string().optional().describe("A standard scale label, exactly as listed in the error on a miss"),
      upp: z.number().optional().describe("Real feet per image px at render scale 2.0"),
      calibrate: z.object({ p1: pointSchema, p2: pointSchema, feet: z.number() }).optional()
        .describe("Two points (image px) a known real distance apart, and that distance in feet"),
      use_detected: z.literal(true).optional().describe("true = adopt the sheet's detected scale"),
    },
    outputSchema: setScaleOutput,
  }, run("set_scale", (a) => {
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
    outputSchema: oneClickOutput,
  }, run("one_click", (a) => session.oneClick(a.sheet, a.x, a.y, { condition: a.condition, role: a.role, returnVerts: a.return_verts })));

  server.registerTool("detect_rooms", {
    description: `Batch room detection: reads every room-number label off the sheet's text layer (e.g. "134", "OFFICE 101") and runs One-Click at each — one call instead of read_sheet_text + reasoning + N one_click calls. Only cleanly-traced rooms are returned; a label that leaked or landed in dense linework is silently withheld, never reported as a bad room. With the sheet's scale set, returns area_sf/perimeter_lf per room; pass condition to commit every detected room under that finish tag (role "deduct" makes them subtract). Without a scale, returns px-only quantities per room and commits nothing. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      condition: z.string().optional().describe("Finish tag to commit every detected room under (minted on first use)"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include each traced polygon's vertices (image px)"),
    },
    outputSchema: detectRoomsOutput,
  }, run("detect_rooms", (a) => session.detectRooms(a.sheet, { condition: a.condition, role: a.role, returnVerts: a.return_verts })));

  server.registerTool("measure_polygon", {
    description: `Measure a closed polygon you supply (min 3 vertices, image px): area_sf and perimeter_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it; role "deduct" subtracts. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      verts: z.array(pointSchema).min(3),
      condition: z.string().optional(),
      role: roleSchema,
    },
    outputSchema: measurePolygonOutput,
  }, run("measure_polygon", (a) => session.measurePolygon(a.sheet, a.verts, { condition: a.condition, role: a.role })));

  server.registerTool("measure_line", {
    description: `Measure an open polyline (min 2 points, image px): length_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it as a linear shape (base, transitions, feature strips). ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      pts: z.array(pointSchema).min(2),
      condition: z.string().optional(),
    },
    outputSchema: measureLineOutput,
  }, run("measure_line", (a) => session.measureLine(a.sheet, a.pts, { condition: a.condition })));

  server.registerTool("takeoff_summary", {
    description: `Per-condition totals (floor/wall/border SF, LF, EA, SY, with and without waste) plus grand totals — the Report's numbers, computed by the same rules. ${COORDS}`,
    inputSchema: {},
    outputSchema: takeoffSummaryOutput,
  }, run("takeoff_summary", () => session.summary()));

  server.registerTool("export_takeoff", {
    description: `The full "opentakeoff.takeoff_canvas.v1" annotations payload — exactly what the app autosaves, importable by it. Returned inline; pass path to also write it to disk as JSON. ${COORDS}`,
    inputSchema: { path: z.string().optional().describe("File path to write the payload to") },
    outputSchema: exportTakeoffOutput,
  }, run("export_takeoff", async ({ path: outPath }) => {
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
    outputSchema: deleteShapeOutput,
  }, run("delete_shape", ({ shape_id }) => session.deleteShape(shape_id)));

  server.registerTool("read_sheet_text", {
    description: `The sheet's text with positions — items [{str, x, y}] in image px plus the joined text. Optionally restrict to a region {x0, y0, x1, y1}. Use it to read title blocks, room labels, finish schedules, and scale notes. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
    },
    outputSchema: readSheetTextOutput,
  }, run("read_sheet_text", (a) => session.readSheetText(a.sheet, a.region)));
}
