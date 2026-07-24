// The fifteen tools — thin zod-validated handlers over the Session. Replies are
// compact JSON (format.ts); view_sheet alone replies with an image content
// item plus a JSON meta text item. Failures are isError results, never thrown
// protocol errors.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, okImage, fail, UserError, type ToolReply } from "./format.ts";
import { UNDO_CAP, CONTEXT_MIN_LEN_PX, CONTEXT_MAX_SEGMENTS, CONTEXT_MAX_SEGMENTS_CEIL, type Session } from "./session.ts";
import { traceToolCall } from "./trace.ts";
import {
  loadPlanOutput, sheetInfoOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput,
  editShapeOutput, undoLastOutput, sheetContextOutput,
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
    description: `Batch room detection: reads every room-number label off the sheet's text layer (e.g. "134", "OFFICE 101") and runs One-Click at each — one call instead of read_sheet_text + reasoning + N one_click calls. A seed is only reported as a room once it survives three gates, and everything skipped is counted and reasoned in \`withheld\` — never dropped silently, because a room the tool tells you it skipped is a question you can ask, while one it hides is a hole in a bid. The gates: a flood that leaked or landed in dense linework never becomes a region; two labels flooding the SAME region commit once (the extra labels ride on \`merged_labels\` — double-counting an area is the worst failure an estimating tool has); and a flood that is enclosed and clean but smaller than min_area_sf is a room-number bubble, a door swing, or a wall cavity rather than a room. With the sheet's scale set, returns area_sf/perimeter_lf per room; pass condition to commit every detected room under that finish tag (role "deduct" makes them subtract). Without a scale, returns px-only quantities per room and commits nothing — the plausibility floor needs real units, so it only applies once a scale is set. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      condition: z.string().optional().describe("Finish tag to commit every detected room under (minted on first use)"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include each traced polygon's vertices (image px)"),
      min_area_sf: z.number().positive().default(5).describe("Plausibility floor: enclosed regions smaller than this are withheld as label bubbles/cavities, not rooms. Default 5 SF — below any real finished space (a broom closet is ~10 SF). Lower it to inspect what was skipped."),
    },
    outputSchema: detectRoomsOutput,
  }, run("detect_rooms", (a) => session.detectRooms(a.sheet, { condition: a.condition, role: a.role, returnVerts: a.return_verts, minAreaSf: a.min_area_sf })));

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

  server.registerTool("sheet_context", {
    description: `The sheet's STRUCTURE in one call and one frame: the classified vector segments, the positioned text spans, and the hatch-family instances of a region — everything the engine itself floods against, exposed as data instead of pixels. Use it when you need to REASON about a region rather than look at it: which lines bound this space and at what pen weight, what the region says, and which periodic fill pattern covers it. The join is the point — all three arrive in image px with no reconciliation left to do, and the reply echoes the post-clamp region so passing that same rect to view_sheet gives you the matching render by construction. Hatch families carry a content-derived id (same pattern spec ⇒ same id, anywhere on the sheet), so matching a plan region to a legend swatch is comparing two ids, not guessing from a render — read the legend region, read the room region, match ids, and cite both bboxes as evidence. Decimation is declared, ordered, and counted on every reply: segments shorter than min_len_px drop first (invisible ink), then a max_segments cap applies LONGEST-FIRST so walls survive and hatch strokes go; kept + dropped always reconciles to total_in_region, and whole segments drop with their meta intact — nothing is ever simplified or merged, because these are classified segments and a merge would rewrite the classification. A scan returns has_vector_linework: false with empty vectors — absence of linework, never a claim the region is blank. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional()
        .describe("Rect in image px (origin top-left, y down); omit for the full sheet"),
      min_len_px: z.number().min(0).default(CONTEXT_MIN_LEN_PX)
        .describe(`Drop segments shorter than this (default ${CONTEXT_MIN_LEN_PX} — one PDF point at render scale 2.0, below any pen width). 0 keeps everything`),
      max_segments: z.number().int().min(1).max(CONTEXT_MAX_SEGMENTS_CEIL).default(CONTEXT_MAX_SEGMENTS)
        .describe(`Segment cap, applied longest-first (default ${CONTEXT_MAX_SEGMENTS}). The reply's dropped.cap says exactly what a smaller region would recover`),
    },
    outputSchema: sheetContextOutput,
  }, run("sheet_context", (a) => session.sheetContext(a.sheet, { region: a.region, min_len_px: a.min_len_px, max_segments: a.max_segments })));

  server.registerTool("edit_shape", {
    description: `REVISE a shape you already committed, instead of deleting it and starting over: pass new verts to move the geometry, condition to reassign it to a different finish tag, role to switch between floor_area / deduct / linear, or any combination. Quantities are recomputed from the result — a role flip alone re-measures (closed area vs open length). The loop this is for: one_click or measure_polygon to commit, view_sheet with overlay:true to LOOK at what landed, then edit_shape to fix the two vertices that overshot into the corridor. Shapes a human affirmed (origin.reviewed) are ink and are refused — an agent revises its own pencil and nothing else. Agent self-revision is tallied on origin.agent_edits, kept deliberately separate from the human-correction fields. ${COORDS}`,
    inputSchema: {
      shape_id: z.string().describe("Id returned when the shape was committed"),
      verts: z.array(pointSchema).optional().describe("Replacement geometry (image px): ≥3 vertices for an area shape, ≥2 points for a linear one"),
      condition: z.string().optional().describe("Reassign to this finish tag (minted on first use)"),
      role: z.enum(["floor_area", "deduct", "linear"]).optional().describe("Switch what the shape measures"),
    },
    outputSchema: editShapeOutput,
  }, run("edit_shape", (a) => session.editShape(a.shape_id, { verts: a.verts, condition: a.condition, role: a.role })));

  server.registerTool("undo_last", {
    description: `Step back over your OWN last n mutations, newest first — a committed one_click, a whole detect_rooms sweep, an edit_shape, or a delete_shape. Each step is reversed exactly (a commit is removed, an edit is restored verbatim, a delete is re-inserted where it was), so this restores state rather than approximating it. Reads are never journaled, so n counts gestures that changed something, not tool calls you made. Use it when a sweep committed against the wrong condition or a batch went in on the wrong sheet — one call instead of N deletes. Scope: this session's own history only. It is not the browser canvas's undo stack, and load_plan clears it along with the shapes it refers to.`,
    inputSchema: {
      n: z.number().int().min(1).max(UNDO_CAP).default(1).describe(`How many steps to reverse (1–${UNDO_CAP})`),
    },
    outputSchema: undoLastOutput,
  }, run("undo_last", ({ n }) => session.undoLast(n)));

  server.registerTool("read_sheet_text", {
    description: `The sheet's text with positions — items [{str, x, y}] in image px plus the joined text. Optionally restrict to a region {x0, y0, x1, y1}. Use it to read title blocks, room labels, finish schedules, and scale notes. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
    },
    outputSchema: readSheetTextOutput,
  }, run("read_sheet_text", (a) => session.readSheetText(a.sheet, a.region)));

  server.registerTool("view_sheet", {
    description: `SEE the sheet — render the page (or a crop of it) to a PNG image. This is your eyes on the plan: full-sheet overview first, then tight crops at higher px until dimension strings and room labels read cleanly. region is in image px — the same space as every other tool — so a feature at pixel (ix, iy) of the returned image sits at x = region_x0 + ix × (region_x1 − region_x0) / img_w (same for y), and those coordinates go straight into one_click, measure_polygon, or read_sheet_text. overlay:true burns the session's committed shapes into the render (human-affirmed ink solid red, unreviewed machine shapes dashed blue) — render again after committing to verify your geometry landed where you intended, and sanity-check what you see: a fixture-sized ring where a room should be means the seed landed inside a stall or casework; an outsized ring means the flood escaped through an opening. To MEASURE rather than guess, pass grid: a calibrated measuring grid is burned in — thin lines every 1 ft, heavy blue every 5 ft, foot labels along the crop edges, feet counted from the crop's top-left corner. Count grid cells between walls exactly like an estimator scaling a plan; never derive a dimension by eye when the grid can give it to you. grid "auto" uses the sheet's set scale; before set_scale, pass the drawing scale read off the title block as inches-per-foot — "1/4" for a 1/4" = 1'-0" plan, "3/16", "0.25". Rendering needs the optional native canvas (@napi-rs/canvas); where it isn't installed this tool errors cleanly and every other tool still works. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional()
        .describe("Crop rect in image px (origin top-left, y down); omit for the full sheet"),
      px: z.number().int().min(200).max(2000).optional()
        .describe("Long-side pixel budget of the returned image (default 1400) — small region + high px = readable dimension strings"),
      overlay: z.boolean().optional()
        .describe("Burn committed shapes into the render (solid = human-affirmed, dashed = unreviewed)"),
      grid: z.string().optional()
        .describe('Burn in a calibrated 1-ft/5-ft measuring grid: "auto" = the sheet\'s set scale; otherwise the drawing scale as inches-per-foot, e.g. "1/4", "3/16", "0.25"'),
    },
  }, async (a: { sheet: string; region?: { x0: number; y0: number; x1: number; y1: number }; px?: number; overlay?: boolean; grid?: string }): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      const { png, meta } = await session.viewSheet(a.sheet, { region: a.region, px: a.px, overlay: a.overlay, grid: a.grid });
      reply = okImage(png, meta);
    } catch (e) {
      reply = fail(e);
    }
    traceToolCall("view_sheet", a, startedAt, reply);
    return reply;
  });
}
