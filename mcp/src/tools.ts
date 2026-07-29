// The seventeen tools — thin zod-validated handlers over the Session. Replies are
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
  findTextOutput, editMaterialsOutput, editConditionOutput, exportReportOutput,
  annotateOutput, listAnnotationsOutput, linkAnnotationOutput,
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
      sensitivity: z.number().min(0).max(1).optional().describe("Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing"),
    },
    outputSchema: oneClickOutput,
  }, run("one_click", (a) => session.oneClick(a.sheet, a.x, a.y, { condition: a.condition, role: a.role, returnVerts: a.return_verts, sensitivity: a.sensitivity })));

  server.registerTool("detect_rooms", {
    description: `Batch room detection: reads every room-number label off the sheet's text layer (e.g. "134", "OFFICE 101") and runs One-Click at each — one call instead of read_sheet_text + reasoning + N one_click calls. A seed is only reported as a room once it survives three gates, and everything skipped is counted and reasoned in \`withheld\` — never dropped silently, because a room the tool tells you it skipped is a question you can ask, while one it hides is a hole in a bid. The gates: a flood that leaked or landed in dense linework never becomes a region; two labels flooding the SAME region commit once (the extra labels ride on \`merged_labels\` — double-counting an area is the worst failure an estimating tool has); and a flood that is enclosed and clean but smaller than min_area_sf is a room-number bubble, a door swing, or a wall cavity rather than a room. With the sheet's scale set, returns area_sf/perimeter_lf per room; pass condition to commit every detected room under that finish tag (role "deduct" makes them subtract). Without a scale, returns px-only quantities per room and commits nothing — the plausibility floor needs real units, so it only applies once a scale is set. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      condition: z.string().optional().describe("Finish tag to commit every detected room under (minted on first use)"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include each traced polygon's vertices (image px)"),
      min_area_sf: z.number().positive().default(5).describe("Plausibility floor: enclosed non-bubble regions smaller than this are withheld as cavities, not rooms. Default 5 SF — below any real finished space (a broom closet is ~10 SF). Lower it to inspect what was skipped."),
      sensitivity: z.number().min(0).max(1).optional().describe("Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing"),
    },
    outputSchema: detectRoomsOutput,
  }, run("detect_rooms", (a) => session.detectRooms(a.sheet, { condition: a.condition, role: a.role, returnVerts: a.return_verts, minAreaSf: a.min_area_sf, sensitivity: a.sensitivity })));

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

  server.registerTool("export_report", {
    description: `The computed Report document — "opentakeoff.report.v1", the same schema the canvas Report's JSON export writes. Everything a pricing consumer needs without re-implementing the app's math: per-condition quantities with waste and multiplier applied (gross and *_net), the computed materials BUY LIST per condition (order quantity = basis ÷ coverage rate, rounded up to whole purchase units) plus the project-wide roll-up summed by (name, unit), per-sheet BASE subtotals, scale provenance per sheet, and annotations. Contrast: export_takeoff is the raw canvas payload (materials as CONFIG rows, no computed quantities) and takeoff_summary strips materials for a compact reply — when the numbers are leaving for pricing, consume this. Returned inline; pass path to also write it to disk as JSON.`,
    inputSchema: { path: z.string().optional().describe("File path to write the document to") },
    outputSchema: exportReportOutput,
  }, run("export_report", async ({ path: outPath }) => {
    const doc = session.exportReport();
    if (outPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outPath, JSON.stringify(doc));
    }
    return doc;
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

  server.registerTool("edit_materials", {
    description: `Add, remove, or patch supporting-materials rows on a condition — the coverage-rate lines that turn a measured area/length/count into an order quantity (adhesive at N sf/gal, grout at N lf/bag, …), matching the canvas's per-condition Supporting Materials panel. Each row is {name, per, basis, unit, round, note}: quantity = the condition's basis total (area/linear/count) ÷ per, rounded up to whole purchase units unless round:false. condition names an existing OR NEW finish tag (minted on first touch, same as one_click/measure_polygon) — add alone is enough to seed materials on a condition before you've traced anything. remove/patch target existing row ids from this reply or export_takeoff (takeoff_summary strips materials for a compact quantities-only reply); a bad id 404s the WHOLE call before anything is written, and referencing an id on a tag with no condition yet errors rather than silently minting an empty one. No review gate here — materials rows are quantity config, not traced geometry, so this edits directly; undo_last reverses a call in one step (the condition's whole materials array, snapshotted before the write, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag, e.g. 'CPT-1'"),
      add: z.array(z.object({
        name: z.string().min(1),
        per: z.number().min(0).optional().describe("Coverage rate — basis units per purchase unit, e.g. 250 for 1 gal / 250 sf. Default 0 (quantity 0 until set)"),
        basis: z.enum(["area", "linear", "count"]).optional().describe("Which of the condition's totals this row divides against — default 'area' (total SF)"),
        unit: z.string().optional().describe("Purchase unit, e.g. 'gal', 'bag', 'roll'"),
        round: z.boolean().optional().describe("Round up to whole purchase units — default true"),
        note: z.string().optional(),
      })).optional().describe("New rows to add"),
      remove: z.array(z.string()).optional().describe("Existing row ids to remove"),
      patch: z.array(z.object({
        id: z.string(),
        fields: z.record(z.union([z.string(), z.number(), z.boolean()])).describe("Field:value pairs — name/per/basis/unit/round/note only"),
      })).optional().describe("Field changes on existing rows"),
    },
    outputSchema: editMaterialsOutput,
  }, run("edit_materials", (a) => session.editMaterials(a.condition, { add: a.add, remove: a.remove, patch: a.patch })));

  server.registerTool("edit_condition", {
    description: `Set a condition's quantity knobs — waste % and/or multiplier. takeoff_summary emits waste-adjusted *_net order quantities and a per-condition multiplier, and every export carries both, but conditions minted through the measure tools start at waste 0 / multiplier 1 — without this tool an agent's takeoff always ships net === gross (#131). waste_pct is the estimator's cut-waste percentage (carpet commonly 5–10); multiplier scales every quantity on the condition (×N identical floors — takeoff_summary applies it before waste). condition must resolve to an EXISTING finish tag — a typo'd tag errors rather than minting an empty condition (the edit_materials remove/patch rule, not its add rule: these knobs mean nothing on a condition that doesn't exist yet). No review gate — quantity config, not traced geometry; undo_last reverses a call in one step (both knobs snapshotted together, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag of an existing condition, e.g. 'CPT-1'"),
      waste_pct: z.number().min(0).optional().describe("Waste percentage applied to net order quantities, e.g. 10 for 10%"),
      multiplier: z.number().positive().optional().describe("Quantity multiplier (×N identical areas). Note: the canvas treats 0 as 1, so 0 is rejected here rather than silently meaning 'off'"),
    },
    outputSchema: editConditionOutput,
  }, run("edit_condition", (a) => session.editCondition(a.condition, { waste_pct: a.waste_pct, multiplier: a.multiplier })));

  server.registerTool("undo_last", {
    description: `Step back over your OWN last n mutations, newest first — a committed one_click, a whole detect_rooms sweep, an edit_shape, a delete_shape, an edit_materials call, or an edit_condition call. Each step is reversed exactly (a commit is removed, an edit is restored verbatim, a delete is re-inserted where it was, a materials edit's whole array is restored, a condition edit's waste/multiplier pair is restored), so this restores state rather than approximating it. Reads are never journaled, so n counts gestures that changed something, not tool calls you made. Use it when a sweep committed against the wrong condition or a batch went in on the wrong sheet — one call instead of N deletes. Scope: this session's own history only. It is not the browser canvas's undo stack, and load_plan clears it along with the shapes it refers to.`,
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

  server.registerTool("find_text", {
    description: `LOCATE a known string on a sheet — the complement to read_sheet_text (which returns what a region SAYS; this finds WHERE a string you already know sits). Case-insensitive substring match against each pdf.js text run, so a room label split across runs ("OFFICE" then "134" as separate items) needs a find_text call per fragment, or read_sheet_text over a region to see the whole thing joined. Every hit's center feeds straight into one_click as the seed — the locate-then-trace workflow: find_text the room number, one_click at (or just past) its center. Optionally restrict to a region {x0, y0, x1, y1}; results cap at limit (default 200), with count/truncated telling you exactly how much a tighter region or higher limit would recover. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      q: z.string().min(1).describe("Text to find — a room number ('134'), a label fragment ('RECEPTION'), a schedule tag ('CPT-1')"),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional()
        .describe("Rect in image px (origin top-left, y down); omit for the full sheet"),
      limit: z.number().int().min(1).max(2000).default(200).describe("Max hits returned"),
    },
    outputSchema: findTextOutput,
  }, run("find_text", (a) => session.findText(a.sheet, a.q, { region: a.region, limit: a.limit })));

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

  // ── annotations (#114) — the agent half of markup.condition_id (#112) ──────
  // A human could attach a note to a scope; an agent could not even SEE one
  // (session.exportPayload hardcoded markups: []). These three close that.
  server.registerTool("annotate", {
    description: `Place an annotation on a sheet — a note ABOUT the work, never a measurement of it. Types: cloud and highlight take rect:[[x0,y0],[x1,y1]] (a revision cloud around an area, a highlight box over it), text takes at:[x,y], callout takes at:[x,y] plus target:[x,y] (the point its leader aims at). \n\nPass condition to attach the note to a finish tag, which is what makes it part of that SCOPE rather than a floating remark: it then wears the condition's colour on the canvas and in the marked-set PDF, and travels with it into the report. The tag is minted on first touch like one_click/measure_polygon, so you can annotate CPT-1 before anything is traced for it. Omit condition for a note about the sheet itself. \n\nNo review gate: the pencil-not-ink rule exists to stop an agent inventing geometry, and a cloud reading "verify substrate" is not geometry. It touches no quantity. ${COORDS}`,
    inputSchema: {
      sheet: z.string().describe("Sheet name or number, as sheet_info reports it"),
      type: z.enum(["cloud", "text", "callout", "highlight"]).describe("cloud/highlight need rect; text/callout need at; callout also needs target"),
      text: z.string().default("").describe("The note. A cloud with no text still reads as 'look here'"),
      condition: z.string().optional().describe("Finish tag to attach this note to, e.g. 'CPT-1' (minted on first use). Omit for an unattached sheet note"),
      at: pointSchema.optional().describe("Anchor point (image px) — text and callout"),
      target: pointSchema.optional().describe("What a callout's leader line points at (image px)"),
      rect: z.tuple([pointSchema, pointSchema]).optional().describe("Corners (image px) — cloud and highlight"),
    },
    outputSchema: annotateOutput,
  }, run("annotate", (a) => session.annotate(a)));

  server.registerTool("list_annotations", {
    description: `Every annotation on the takeoff, with condition_id RESOLVED to its finish tag so you can act on the reply without joining against conditions[]. Filter by sheet, by condition, or both. Coordinates come back in image px (the same frame you passed in), not the normalized form they're stored as. \`unattached\` counts the notes carrying no condition — the candidates for link_annotation. ${COORDS}`,
    inputSchema: {
      sheet: z.string().optional().describe("Only annotations on this sheet"),
      condition: z.string().optional().describe("Only annotations attached to this finish tag"),
    },
    outputSchema: listAnnotationsOutput,
  }, run("list_annotations", (a) => session.listAnnotations(a)));

  server.registerTool("link_annotation", {
    description: `Attach an existing annotation to a condition, or detach it by passing an empty condition — the canvas's Attach/Detach control, reachable by an agent. Use it to tie up notes left unattached (list_annotations reports how many), or to move one to the finish it actually concerns. Attaching mints the tag on first use.`,
    inputSchema: {
      annotation_id: z.string().describe("Id from annotate or list_annotations"),
      condition: z.string().describe("Finish tag to attach to; empty string detaches"),
    },
    outputSchema: linkAnnotationOutput,
  }, run("link_annotation", (a) => session.linkAnnotation(a.annotation_id, a.condition)));
}
