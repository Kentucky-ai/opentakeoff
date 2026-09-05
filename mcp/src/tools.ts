// The tools (TOOL_NAMES in staging.ts) — thin zod-validated handlers over the Session. Replies are
// compact JSON (format.ts); view_sheet alone replies with an image content
// item plus a JSON meta text item. Failures are isError results, never thrown
// protocol errors.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, okImage, fail, UserError, type ToolReply } from "./format.ts";
import { oneClickEnabled, GATE_HINT } from "./gate.ts";
import { UNDO_CAP, CONTEXT_MIN_LEN_PX, CONTEXT_MAX_SEGMENTS, CONTEXT_MAX_SEGMENTS_CEIL, VECTORS_DEFAULT_LIMIT, VECTORS_LIMIT_CEIL, type Session } from "./session.ts";
import { traceToolCall } from "./trace.ts";
import {
  loadPlanOutput, sheetInfoOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, measureSurfaceOutput, placeCountOutput, symbolSweepOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput,
  editShapeOutput, undoLastOutput, sheetContextOutput,
  findTextOutput, editMaterialsOutput, editConditionOutput, exportReportOutput,
  duplicateConditionOutput, splitConditionOutput,
  exportMarkedPdfOutput, listShapesOutput, deriveBaseOutput, deriveTransitionsOutput, importTakeoffOutput, applyRulesOutput, cutOutOutput,
  annotateOutput, listAnnotationsOutput, linkAnnotationOutput,
  markVerdictOutput, deleteVerdictOutput,
  createRfiOutput, listRfisOutput, resolveRfiOutput, deleteRfiOutput,
  sheetGraphOutput, resolveTagOutput, findScheduleOutput, sweepScheduleRowOutput, countMarksOutput,
  exportDxfOutput, getSheetVectorsOutput,
  proposeTakeoffOutput, reviseProposalOutput, withdrawProposalOutput,
  proposeConditionEditOutput, withdrawConditionEditOutput,
  scopeDuplicatesOutput, scopeMergeOutput,
} from "./outputs.ts";
import { exportMarkedPdf } from "./marked.ts";
import { assertWritable, OVERWRITE_DESC } from "./safewrite.ts";
import { importTakeoff } from "./importing.ts";

// The coordinate contract, stated on every tool so any agent reading any one
// description knows the space it is working in.
const COORDS = "Coordinates are image px at render scale 2.0: PDF pt × 2, origin top-left, y down (the browser canvas's native space). Sheet payloads carry dims in both px and pt.";

const pointSchema = z.tuple([z.number(), z.number()]);
const roleSchema = z.enum(["floor_area", "deduct"]).default("floor_area");
// #85 — per-call layer overrides on the flood mask. sheet_info's layer table
// is the vocabulary; include forces a layer's ink to plot as hard boundary,
// exclude drops it outright. An unknown name errors with the sheet's actual
// layer list; on an unlayered sheet the filter errors rather than no-ops.
const layersFilterSchema = z.object({
  include: z.array(z.string()).optional().describe("Layer names or ids whose ink must plot as HARD boundary"),
  exclude: z.array(z.string()).optional().describe("Layer names or ids whose ink must not block the flood at all"),
}).optional().describe("Override the sheet's classified layer roles for THIS call (see sheet_info.layers)");

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

// Returns every RegisteredTool by name so staged exposure (#230) can disable
// and re-enable groups after the fact. The wrapper keeps all forty call sites
// below byte-identical: `server` here is a recording facade over the real one.
export function registerTools(realServer: McpServer, session: Session, opts: { oneClick?: boolean } = {}): Map<string, RegisteredTool> {
  // The TEMPORARY One-Click gate (src/gate.ts): on a default build one_click and
  // detect_rooms are not registered at all, and every description that used to
  // point an agent at them points at measure_polygon instead.
  const oneClick = oneClickEnabled(opts.oneClick);
  const registered = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, meta: unknown, handler: unknown): RegisteredTool {
      const tool = (realServer.registerTool as (n: string, m: unknown, h: unknown) => RegisteredTool)(name, meta, handler);
      registered.set(name, tool);
      return tool;
    },
    sendResourceListChanged: () => realServer.sendResourceListChanged(),
  };
  server.registerTool("load_plan", {
    description: `Open a plan PDF from disk. Default: replace the whole session (previous documents, scales, conditions, and shapes are cleared). merge: true ADDS the document to the working set instead (#152) — a bid set is plans + schedule + addenda, not one PDF — keeping every scale, condition, and shape; sheet keys carry file names so documents never collide, the sheet graph spans the whole set (resolve_tag can chain a plan tag on one file to a schedule row in another), and the marked set covers every worked sheet. Re-loading an already-merged file is refused — reload = replace, deliberately. Returns file, files, page_count, and one entry per sheet. The loaded sheets also become browsable resources (takeoff://sheets). ${COORDS}`,
    inputSchema: {
      path: z.string().describe("Path to a plan PDF on disk"),
      merge: z.boolean().optional().describe("true = ADD this document to the working set, keeping all existing work (merge into an empty session is just a load)"),
    },
    outputSchema: loadPlanOutput,
  }, run("load_plan", async ({ path, merge }) => {
    const loaded = await session.loadPlan(path, { merge });
    server.sendResourceListChanged(); // the resource surface just changed under every subscriber
    return loaded;
  }));

  server.registerTool("sheet_info", {
    description: `Sheet detail: dims (px and pt), vector segment count, whether the sheet has vector linework (${oneClick ? "one_click floods it when present; a scanned sheet falls back to rendered pixels, disclosed as raster_traced" : "measure_polygon runs on it; get_sheet_vectors returns the strokes"}), scale status, the detected scale suggestion, and this sheet's committed shape count. ${COORDS}`,
    inputSchema: { sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101")') },
    outputSchema: sheetInfoOutput,
  }, run("sheet_info", ({ sheet }) => session.sheetInfo(sheet)));

  server.registerTool("set_scale", {
    description: `Set a sheet's scale — exactly ONE of: label (a standard scale, e.g. '1/4" = 1'-0"'), upp (real feet per image px), calibrate (two points along a known dimension plus its real feet), or use_detected (adopt the drawn scale note read off the sheet). The detected scale is never applied automatically — setting it is always this explicit call. Changing an existing scale recomputes measurements and cutout restore quantities from geometry and records one undo_last step. Counts are unchanged. Human-reviewed dimensional work must be recalibrated in the canvas; scales must be finite and positive. ${COORDS}`,
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

  if (oneClick) {
  server.registerTool("one_click", {
    description: `One-Click Area: click inside a room (image px) and the plan's vector linework bounds it — the sealed flood engine (RFC #60), contour trace, vertices snapped to true PDF endpoints. The engine's arguments are FEET-TRUE through the sheet's scale, exactly the canvas's: gap sealing bridges up to a door-width opening (disclosed as gap_sealed_px — that much boundary is synthetic), door-swing wedges annex the swing a doorway sweeps (door_wedges), and the minimum-passage rule keeps sub-half-foot slits from conjoining two rooms (min_pass_px/min_pass_delta). Every trace carries the engine's own account of itself: confidence (0..1, with confidence_factors naming what deducted) — a review PRIORITIZER, never a verification. 1.0 means every signal ran clean, not that the trace is right; a LOW confidence is a view_sheet {overlay: true} audit prompt, not a fact to bid from — put eyes on the flagged edge before the total means anything. SCANNED sheets work too (#154): where vectors can't bound the room (an image-only scan, or a scan wrapper whose only linework is the title block), the flood falls back automatically to the sheet's rendered pixels — same engine the canvas uses — and the reply plus the committed shape's origin carry raster_traced: true so a pixel-bounded ring is never mistaken for a vector-snapped one. Vector always wins where it works; a raster ring's corners are unsnapped, so audit it with view_sheet {overlay: true} before trusting the total. With the sheet's scale set, returns area_sf / perimeter_lf; pass condition (a finish tag, e.g. "CPT-1") to commit the traced shape to the takeoff — the full engine account rides the committed shape's origin, so the export tells the truth about how each shape was made. Without a scale it returns px-only quantities with a warning and commits nothing (the engine also degrades to its scale-blind fallbacks — a weaker measurement, one more reason set_scale comes first). role "deduct" makes the committed shape subtract. After committing, LOOK at what landed — view_sheet {overlay: true} — and fix an overshot ring with edit_shape before trusting any total. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      x: z.number(),
      y: z.number(),
      condition: z.string().optional().describe("Finish tag to commit under (minted on first use)"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include the traced polygon's vertices (image px)"),
      sensitivity: z.number().min(0).max(1).optional().describe("Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing"),
      layers: layersFilterSchema,
    },
    outputSchema: oneClickOutput,
  }, run("one_click", (a) => session.oneClick(a.sheet, a.x, a.y, { condition: a.condition, role: a.role, returnVerts: a.return_verts, sensitivity: a.sensitivity, layers: a.layers })));

  server.registerTool("detect_rooms", {
    description: `Batch room detection: reads every room-number label off the sheet's text layer (e.g. "134", "OFFICE 101") and runs One-Click at each — one call instead of read_sheet_text + reasoning + N one_click calls. An OCR'd scan (text layer, no vector linework) floods the rendered pixels instead (#154), disclosed per room and on origin as raster_traced. A seed is only reported as a room once it survives three gates, and everything skipped is counted and reasoned in \`withheld\` — never dropped silently, because a room the tool tells you it skipped is a question you can ask, while one it hides is a hole in a bid. The gates: a flood that leaked or landed in dense linework never becomes a region; two labels flooding the SAME region commit once (the extra labels ride on \`merged_labels\` — double-counting an area is the worst failure an estimating tool has); and a flood that is enclosed and clean but smaller than min_area_sf is a room-number bubble, a door swing, or a wall cavity rather than a room. Every room floods through the SAME sealed engine a single one_click runs (RFC #60 — feet-true gap sealing, door-swing wedges, the minimum-passage rule), so a batch detection and a click at the same seed measure the same square footage; each room carries the engine's account of its own trace (confidence + confidence_factors, gap_sealed_px, door_wedges, min_pass_px/min_pass_delta), and the same account rides origin on everything committed. Confidence is a review prioritizer, never a verification — a low-confidence room is a view_sheet {overlay: true} audit prompt, not a fact to bid from. With the sheet's scale set, returns area_sf/perimeter_lf per room. Every committed room carries the room number it was traced from as the shape's \`label\`, so a sweep arrives already sliced by room — that field is what the Report's per-room grouping and the workbook's floor × room tab read, and it is the one thing about a batch that cannot be recovered downstream if it is dropped. TO COMMIT, choose the honest source of the finish tag: assign_from_schedule: true routes every room through its OWN room-finish schedule row and commits each under the FLOOR finish that row states — when a schedule exists in the set, THIS is the default move, because one agent-chosen tag across N rooms flattens real finish variety into a wrong bid; condition commits every room under that one stated tag (only right when the rooms genuinely share it; role "deduct" makes them subtract). Without a scale, returns px-only quantities per room and commits nothing — the plausibility floor needs real units, so it only applies once a scale is set. A batch commit is NOT finished until you have LOOKED at it: view_sheet {overlay: true}, audit every ring against the walls, fix misses with edit_shape / delete_shape — before the totals mean anything. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      condition: z.string().optional().describe("Finish tag to commit every detected room under (minted on first use). Mutually exclusive with assign_from_schedule"),
      assign_from_schedule: z.boolean().default(false).describe("Commit each room under the FLOOR finish its OWN room-finish schedule row states (resolve_tag's chain, per room): the citation rides origin.assignment, and rooms the schedule cannot answer for — no row, no FLOOR cell, a compound cell like \"CPT-1/VCT-1\" — are returned in unresolved[] with reasons and seeds instead of committed under a guess. Needs the sheet's scale and a room-finish schedule in the working set (merge the schedule sheet in with load_plan first). Mutually exclusive with condition"),
      role: roleSchema,
      return_verts: z.boolean().default(false).describe("Include each traced polygon's vertices (image px)"),
      min_area_sf: z.number().positive().default(5).describe("Plausibility floor: enclosed non-bubble regions smaller than this are withheld as cavities, not rooms. Default 5 SF — below any real finished space (a broom closet is ~10 SF). Lower it to inspect what was skipped."),
      sensitivity: z.number().min(0).max(1).optional().describe("Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing"),
      layers: layersFilterSchema,
    },
    outputSchema: detectRoomsOutput,
  }, run("detect_rooms", (a) => {
    // the set_scale "exactly one of" convention: both sources of a finish tag
    // at once is a contradiction, refused before any flooding
    if (a.assign_from_schedule && a.condition !== undefined) {
      throw new UserError("Provide at most one of: condition (every room under one stated tag) or assign_from_schedule (each room's own schedule row decides).");
    }
    return session.detectRooms(a.sheet, { condition: a.condition, role: a.role, returnVerts: a.return_verts, minAreaSf: a.min_area_sf, sensitivity: a.sensitivity, layers: a.layers, assignFromSchedule: a.assign_from_schedule });
  }));
  }

  server.registerTool("propose_takeoff", {
    description: `Open a PROPOSAL — a named batch of the shapes you are about to commit, with one identity (#365). Every shape you commit from here on (${oneClick ? "one_click, detect_rooms, " : ""}measure_polygon, measure_line, measure_surface, place_count, the sweeps, the derives, cut_out) attaches to it until you open another proposal or withdraw this one; the estimator then sees ONE Accept pill for the whole batch instead of one per shape — a forty-room pass becomes one decision, not forty. Use it BEFORE the work, the way an estimator titles a takeoff before tracing: "Level 2 rooms per finish schedule A-601", "Base derived from CPT-1 rooms". label is what the estimator reads on the pill; rationale is what decided the batch (the schedule row, the sheet, the rule) — both required, neither is a comment. Nothing here commits geometry or changes a total: an empty proposal is just a heading. The batch is what revise_proposal replaces and withdraw_proposal removes; shapes the estimator has already accepted leave the batch and no agent verb reaches them. takeoff_summary carries the ledger (pending / accepted / withdrawn per batch).`,
    inputSchema: {
      label: z.string().min(1).describe("The batch's title, as the estimator will read it on the Accept pill"),
      rationale: z.string().min(1).describe("What decided the batch — cite the schedule row, sheet, or rule"),
    },
    outputSchema: proposeTakeoffOutput,
  }, run("propose_takeoff", (a) => session.proposeTakeoff(a.label, a.rationale)));

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

  server.registerTool("cut_out", {
    description: `Cut a REAL hole in a committed floor_area shape (#206) — the way the canvas cuts one (#137): the same lib/cutout.js boolean subtract, so the two surfaces can never disagree about what a hole holds. The parent keeps its outer ring plus the reconciled hole(s) (verts_norm_holes), its computed nets for real — N cuts compose, overlap between cuts never double-deducts (set subtraction), a hole ADDS perimeter — and the deduct commits carrying cuts_shape_id so the report and legend read the reconciled number, never a second arithmetic pass. This is the verb for a column, a floor drain, an island of casework INSIDE a room; an independent measure_polygon role:"deduct" stays the tool for a deduction that isn't a hole in one parent. Refusal over guessing: the ring must sit FULLY inside the parent's outer ring (an edge-crossing cut is a boundary correction — edit_shape the parent instead), and a cut that would erase the parent or split it in two refuses whole (trace the pieces as rooms). One journal entry — undo_last restores parent and hole together; delete_shape on the deduct later reverts the cut too (a multi-cut parent rebuilds from the chain's pristine snapshot minus the survivors). AN OPEN RUN IS CLIPPED, NOT SUBTRACTED: wall tile (surface_area) and base/transitions (linear) are polylines traced in plan, so the ring removes the stretch it covers, the run keeps its id and takes what survives, and a cut through the MIDDLE leaves the far side as its own shape (same condition, same height) — quantities ride the surviving length, which is exact, since wall SF is LF × height and a border's SF is LF × thickness. No deduct is minted for a run: there is no area for one to sit on, and a deduct's SF counts against the FLOOR total a run never fills. A ring that misses the run, one that swallows it whole (delete_shape it), and a curved run (its verts are control points) all refuse. ${COORDS}`,
    inputSchema: {
      parent_shape_id: z.string().describe("A committed floor_area shape id, or an open run (surface_area / linear) to clip (list_shapes)"),
      verts: z.array(pointSchema).min(3).describe("The ring, image px — fully inside the parent for an area; over the stretch to remove for a run"),
    },
    outputSchema: cutOutOutput,
  }, run("cut_out", (a) => session.cutOut(a)));

  server.registerTool("measure_line", {
    description: `Measure an open polyline (min 2 points, image px): length_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it as a linear shape (base, transitions, feature strips). ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      pts: z.array(pointSchema).min(2),
      condition: z.string().optional(),
    },
    outputSchema: measureLineOutput,
  }, run("measure_line", (a) => session.measureLine(a.sheet, a.pts, { condition: a.condition })));

  server.registerTool("measure_surface", {
    description: `Surface Area — wall SF (#146): trace an OPEN run along the wall in plan view (min 2 points, image px) and the quantity is traced LF × height. This is how wall tile, wainscot, and wall systems are taken off — the quantity family ${oneClick ? "one_click and " : ""}measure_polygon cannot produce. Height lives on the CONDITION (the canvas's H knob): pass height_ft to set it on this call (journals as its own undo step, like typing H before tracing), or set it once with edit_condition; with neither, this refuses and mints nothing. The shape snapshots the height it was quantified at. Requires the sheet's scale. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      pts: z.array(pointSchema).min(2).describe("The wall run, an open polyline (image px)"),
      condition: z.string().describe("Finish tag to commit under (minted on first use), e.g. 'CT-W1'"),
      height_ft: z.number().positive().optional().describe("Wall height in feet — written to the condition's H knob first, then used"),
    },
    outputSchema: measureSurfaceOutput,
  }, run("measure_surface", (a) => session.measureSurface(a.sheet, a.pts, { condition: a.condition, height_ft: a.height_ft })));

  server.registerTool("place_count", {
    description: `Count markers — EA (#146): one point, one each. Thresholds, stair nosings, floor boxes, entrance mats — the scale-free quantity family. Commits one count shape per point (computed {count: 1}, exactly the canvas's Count tool), NO scale required, and the whole call is ONE undo step${oneClick ? " like a detect_rooms sweep" : ""}. takeoff_summary reports them as ea; the marked set draws each marker. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      points: z.array(pointSchema).min(1).describe("Marker positions (image px), one committed count shape each"),
      condition: z.string().describe("Finish tag to commit under (minted on first use), e.g. 'TR-1'"),
    },
    outputSchema: placeCountOutput,
  }, run("place_count", (a) => session.placeCount(a.sheet, a.points, { condition: a.condition })));

  server.registerTool("symbol_sweep", {
    description: `Find EVERY instance of a repeated plan symbol from ONE example — drains, thresholds, fixtures, transition markers: marquee a tight seed_rect around a single instance and the vector linework is searched for every other placement of that same segment cluster. Deterministic geometry, not vision: each placement scores as the length-weighted fraction of the seed's segments reproduced within tolerance_px, under translation plus 0/90/180/270 rotation and mirroring (symbols rotate on plans — both ON by default; turn them off to pin orientation). Score ≥ 0.92 is a match; the 0.75–0.92 band comes back in \`withheld\` with a reason — a near-match is a question you answer by LOOKING (view_sheet at its \`at\`), never a silent commit and never a silent drop. RICHER VARIANTS are named, never silent: a placement that reproduces the whole seed but carries >30% extra linework fully inside its footprint (a register against a grille seed — the same outline plus louvers) comes back with its measured \`extra\` fraction on the row — LOOK at those first, they are the classic mislabel; background lines CROSSING the symbol and coincident duplicate ink never trip this. By default such placements still COUNT, because the contained-seed workflow below depends on supersets matching (seed a bare sub-shape, count the richer symbols that contain it, exclude what you don't mean). Pass \`variant_guard: true\` when your seed is the WHOLE symbol — grilles, drains, fixtures marqueed complete — and extra-ink placements demote to \`withheld\` as questions instead of counting; the guard stands down automatically when \`exclude\` counter-examples are in play, since supplying negatives is manual variant discrimination. The seed's own location is reported in \`seed\` and never double-committed. Every proposed placement is scored up to a hard work ceiling sized for pathological sheets, and the reply says which it was: complete true means the count is a total; complete false (with candidates.dropped > 0) means the count is a FLOOR — some placements were never scored — so tighten the seed rect around more distinctive geometry rather than trusting it as a total. Marquee discipline: the rect must hug ONE instance — only segments FULLY inside it define the symbol, so a loose rect that swallows wall linework fingerprints the wall, not the symbol. scope "set" sweeps the WHOLE working set, counting on PLAN-role sheets only (the sheet graph decides): a symbol drawn in a detail, legend, or schedule is a reference drawing and never counts itself — which is also how you seed from one: marquee the assembly on the detail sheet and its plan-sheet occurrences are counted while the detail stays excluded (the exclusion disclosed in \`skipped\`, per-sheet results with per-sheet caps and wall-clock in \`sheets\`). Scale across sheets: the fingerprint is size-true and is never scale-SEARCHED, so a detail drawn at 1-1/2" = 1'-0" is 12× the size of the same mark on a 1/8" plan — when BOTH sheets have a scale set, the exact ratio is computed from them and the seed is resized before matching (reported per sheet as \`scaled\`); when a scale is missing, the sweep runs at 1:1 and SAYS so (\`scale_assumed\`), because an unknown ratio plus a zero count is not evidence of absence. Seeding from a detail/legend/schedule sheet REFUSES outright until both scales are set — that is the case where an unstated ratio silently finds nothing. commit: true (requires condition) commits every match center as an EA count marker through the same path as place_count — the whole sweep (set-wide included) is ONE undo step, each marker carries origin.method "symbol_sweep" with its score, transform, and seed source, and withheld placements are NEVER committed. The SEED instance is not in that count (#296) — in sheet scope it is almost always installed work, so pass commit_seed: true to mint it into the same batch (the reply reminds you whenever a sheet-scope commit leaves it out; ea_total one short of the hand tally is exactly this). The COUNT is scale-free (EA), but matching across sheets of different scales is not — set_scale on the sheets involved is what turns the ratio from an assumption into arithmetic. Counter-examples (#259): drafting reuses one generic shape for different devices — a wall-mounted data outlet drawn as a plain triangle, the flush-floor variant the SAME triangle inside a square, keynote callouts a triangle with a letter in it — so the seed legitimately matches things you do not mean, and seeding more geometry only works where the drawing offers more to capture. \`exclude\` takes rects around instances you do NOT mean, marqueed exactly like the seed. You never choose a mechanism; the rect's contents decide, because both are the same gesture: a rect holding EXTRA linework beyond the seed rejects placements where that extra linework is present too (the box, the letter), and a rect holding no extra linework of its own is read as the line running THROUGH it — a bare ceiling-grid tile whose grid line a real fixture, drawn over it, would BREAK. That second mechanic is not expressible as a seed: only segments fully INSIDE a rect define a symbol, and background structure is long by nature. Every rejection is disclosed in rejected[] — which negative, what fraction of its evidence was found, and the placement — and NEVER counted in found: an exclusion is a judgement, so look at it and reinstate any you disagree with using place_count at its \`at\`. A counter-example that holds no instance of the seed, or holds the seed with nothing extra, is REFUSED rather than silently doing nothing. Stroke luminance (#260): a flattened export strips the layer tree and flattens every pen, but the file still STATES stroke color — a black fixture outline over a grey ceiling grid is unambiguous there even when the geometry is identical (two empty 2 ft grid tiles reproduce a 2×4 fixture's outline exactly). luminance_tolerance (0–254) gates on it: a sheet segment only answers for a seed segment when their stroke luminances are within the stated tolerance (Rec. 709, 0 = black, 255 = white; 32–64 separates black from grey without touching anti-aliasing wobble). OPT-IN and disclosed, in the spirit of tolerance_px — omitted, sweeps score exactly as before; stated, the reply's lum_gate says the seed's own luminance band and names every placement the geometry would have committed and the pen did not, so you can LOOK at what a stated gate cost. Prefer geometry (a counter-example, a tighter seed) where the drawing offers it — color is the fallback for exports where nothing else survived. Labels (#308): for a LABELED family — fixtures, tagged equipment, keyed devices — the drawing already names every instance, and the sweep reads those names: a fixture token written beside a placement, or connected to it by a drawn leader line (leader-following arms only on multi-pen sheets, where the annotation pen separates from the work), comes back as \`label\` + \`label_via\` on the row, and the seed's own tag rides \`seed.label\`. Disclosure in both directions, never a recount: a committed match with NO label while the family is labeled was counted on shape alone (measured case: two 0.97 matches that were valve internals, not drains — LOOK at those first), a withheld row carrying the seed's own tag is the drawing vouching for a near-miss (look, then place_count), and a withheld row named a DIFFERENT tag is a sibling fixture answered, not a missed count. After any batch commit, LOOK at what landed — view_sheet {overlay: true} over the swept area — and audit the markers against the drawing before trusting the EA total. ${COORDS}`,
    inputSchema: {
      sheet: z.string().describe("The sheet the seed rect sits on — in scope 'set' it may be ANY sheet (a detail/legend seed sheet is fingerprint source only, never counted)"),
      seed_rect: z.tuple([pointSchema, pointSchema])
        .describe("Marquee around ONE example instance, [[x0,y0],[x1,y1]] in image px — tight: segments fully inside define the symbol"),
      condition: z.string().optional().describe("Finish tag to commit match markers under (minted on first use), e.g. 'FD-1'. Required when commit is true"),
      commit: z.boolean().default(false).describe("Commit every MATCH center as one EA count marker (withheld placements never commit)"),
      commit_seed: z.boolean().default(false).describe("Sheet scope + commit only (#296): also commit the SEED instance — in sheet scope the seed is almost always installed work, and a count that excludes it bids one short. Joins the same one-undo-step batch, origin score 1. Refused in set scope, where a detail/legend seed is a reference drawing"),
      scope: z.enum(["sheet", "set"]).default("sheet").describe('"sheet" = this sheet only; "set" = every PLAN-role sheet in the working set (needs a text layer for the sheet graph; non-plan sheets are excluded and disclosed)'),
      rotations: z.boolean().default(true).describe("Also match 90/180/270-rotated placements"),
      mirror: z.boolean().default(true).describe("Also match mirrored placements"),
      tolerance_px: z.number().positive().max(20).default(2).describe("Endpoint match tolerance in image px (default 2 — CAD jitter, not drift)"),
      variant_guard: z.boolean().default(false).describe("Whole-symbol mode: demote richer-variant placements (>30% extra linework inside the footprint) to withheld instead of counting them with an `extra` disclosure. Use when the seed is a COMPLETE symbol (a grille, a drain); leave off when seeding a contained sub-shape. Stands down when exclude counter-examples are passed"),
      exclude: z.array(z.tuple([pointSchema, pointSchema])).optional()
        .describe("Counter-examples: rects around instances you do NOT mean, same gesture as seed_rect — 'count the triangles, not the keynote ones'. Marquee the LOOKALIKE ITSELF (the flush-floor variant with its box, the keynote triangle with its letter) or an EMPTY position whose background line a real instance would break (a bare ceiling grid tile). You never say which kind it is: the rect's own contents decide. Every rejection comes back in rejected[] with which negative did it and what it saw"),
      luminance_tolerance: z.number().int().min(0).max(254).optional()
        .describe("Stroke-luminance gate, 0–254 (#260): a sheet segment only answers for a seed segment when their stroke luminances (Rec. 709, 0 black – 255 white) are within this. For flattened exports where a black device and its grey background twin are geometrically identical — 32–64 separates black from grey. Omit to score on geometry alone; stated, the reply's lum_gate discloses the seed's luminance band and every placement the gate pulled under the commit bar"),
    },
    outputSchema: symbolSweepOutput,
  }, run("symbol_sweep", (a) => session.symbolSweep(a.sheet, {
    seedRect: a.seed_rect,
    condition: a.condition,
    commit: a.commit,
    scope: a.scope,
    rotations: a.rotations,
    mirror: a.mirror,
    tolerancePx: a.tolerance_px,
    variantGuard: a.variant_guard,
    exclude: a.exclude,
    luminanceTolerance: a.luminance_tolerance,
    commitSeed: a.commit_seed,
  })));

  server.registerTool("sweep_schedule_row", {
    description: `Take off a schedule row's mark from the row itself — the estimator's own gesture: a transition type sometimes exists only as a schedule row plus tag markers scattered across the plan sheets, and this tool mints the condition FROM the row and finds every occurrence. Pass the row's key (e.g. 'T1') and the tool (1) reads the row from the set's schedule tables (the sheet_graph/find_schedule machinery — the row is the condition's cited source), (2) anchors a geometric fingerprint on the marker the tag is DRAWN as on a plan sheet (a deterministic pad ladder around the tag text; where the tag occurs more than once the fingerprint must recur at a second occurrence before it is trusted — \`anchor.corroborated\`), and (3) sweeps every PLAN-role sheet for it. The count is geometry AND text agreeing: drafting reuses one bubble shape across many marks, so a match counts ONLY when the row's own tag sits within the marker footprint (its bbox rides the match as \`tag_at\` evidence); a match labeled with a SIBLING row's tag is excluded and says whose it is, an unlabeled match is withheld as a question, and a tag drawn with no matching marker is disclosed as text_only. REFUSAL over guessing, with the reason and the fix: no such row; the same key in two tables (ambiguous); a tag drawn on no plan sheet; no repeatable marker linework around the tag — a fingerprint is never guessed from text alone (the fallback is always: marquee one instance with symbol_sweep). commit: true commits the counted matches as EA markers under the row's own key — one undo step for the whole set-wide sweep, every marker carrying origin.assignment {source: "schedule"} plus the anchor and row citation on origin.symbol.seed. The COUNT is scale-free (EA), but matching is not: where the anchor sheet and a target sheet both carry a scale, the marker is resized by their exact ratio before matching (\`scaled\` per sheet), and where one does not, the sweep runs at 1:1 and discloses it (\`scale_assumed\`) rather than reporting a confident zero. After committing, LOOK: view_sheet {overlay: true} over each swept sheet. ${COORDS} LABEL-FIRST for devices (any trade): when the marker cannot be fingerprinted or does not reach a drawn tag amid linework — a heater bar or fan drawn to its own size, tagged by a leader — every such tag on a plan sheet counts as ONE instance BY LABEL, disclosed in found_by_label / label_only / counted_by; a bare mention in a note (no linework near it) is text_only, never a count. Rows come from every schedule family the sheet graph reads: room-finish, finish/material, and equipment (mechanical, electrical, plumbing, fire).`,
    inputSchema: {
      tag: z.string().min(1).describe("The schedule row's key exactly as drawn, e.g. 'T1', 'TR-2' — it becomes the condition tag on commit"),
      commit: z.boolean().default(false).describe("Commit every counted match as one EA count marker (excluded/withheld/text_only never commit)"),
      rotations: z.boolean().default(true).describe("Also match 90/180/270-rotated markers"),
      mirror: z.boolean().default(true).describe("Also match mirrored markers"),
      tolerance_px: z.number().positive().max(20).default(2).describe("Endpoint match tolerance in image px (default 2 — CAD jitter, not drift)"),
    },
    outputSchema: sweepScheduleRowOutput,
  }, run("sweep_schedule_row", (a) => session.sweepScheduleRow(a.tag, {
    commit: a.commit,
    rotations: a.rotations,
    mirror: a.mirror,
    tolerancePx: a.tolerance_px,
  })));

  server.registerTool("count_marks", {
    description: `The COUNT TAKEOFF in one deterministic call — no seeds, no model, seconds: census every VALUE-ANNOTATED mark tag on the plan-role sheets, counted per schedule mark, committed as EA markers when asked. The identity rule is the annotated-device drafting pattern: a device is drawn as its mark tag with a value under it ("S1" over "200" — CFM on air devices, GPM on fixtures, a rating on equipment), so a tag WITH a paired value counts, a tag inside a schedule table's own region is a row label (excluded, tallied), and every other occurrence is WITHHELD with a reason and coordinates — a tag amid linework but unvalued may be a real device (view_sheet it), a bare tag is probably a note mention. Marks default to the set's schedule row keys (a compound row "R1 / E1" answers for R1 AND E1; each mark cites its row), or state them: {marks: ["S1","R1"]}. The complement to sweep_schedule_row: THAT tool is for marks drawn ON their marker with no value (finish tags in bubbles) and matches geometry; this one is for annotated devices and needs no fingerprint at all. Refusal-honest: scans refuse (no text layer), a set with no mark-shaped rows refuses unless marks are stated, non-plan sheets are skipped with the role that excused them. commit: true commits every counted occurrence under its mark's own tag — ONE undo step for the whole census, schedule citation on origin. Counts are scale-free (EA) — no set_scale needed. Then AUDIT: view_sheet {overlay: true} where the markers landed, and read every withheld entry — a withheld item you ignore is a hole in the bid. ${COORDS} EQUIPMENT marks (a row in an equipment/device schedule — fans, pumps, heaters, fixtures, panels) follow the leader-tag convention instead: a scheduled mark drawn amid linework with no value under it is counted BY LABEL (occurrence by: "label", counted_by_label on the mark); a bare mention in a note still withholds.`,
    inputSchema: {
      marks: z.array(z.string().min(1)).optional()
        .describe('The marks to census, e.g. ["S1", "R1"] — omit to take them from the schedule tables\' row keys'),
      commit: z.boolean().default(false).describe("Commit every counted occurrence as one EA count marker under its mark (withheld/excluded never commit)"),
    },
    outputSchema: countMarksOutput,
  }, run("count_marks", (a) => session.countMarks({ marks: a.marks, commit: a.commit })));

  server.registerTool("derive_base", {
    description: `Mint the wall base from committed rooms (#148) — the estimator's most mechanical derivation: base LF = room perimeter − stated door openings. For every floor_area shape of source_condition, commits ONE linear shape under condition (e.g. 'RB-1') tracing that room's boundary, quantified NET of the openings you state per room. The openings are YOUR claim to make — look at the doors with view_sheet, state {shape_id, lf} per room (repeat a shape_id to stack openings); the tool never guesses, and your claim is recorded on origin.derived (from_shape_id, gross_lf, openings_lf). All-or-nothing: an unknown shape_id, a negative lf, or openings meeting a room's whole perimeter refuses the call before anything commits. The whole derivation is ONE undo step. Deriving onto the source condition is refused — base lands on its own tag.`,
    inputSchema: {
      source_condition: z.string().describe("Finish tag whose floor_area rooms the base derives from, e.g. 'CPT-1'"),
      condition: z.string().describe("Finish tag the base commits under (minted on first use), e.g. 'RB-1'"),
      openings: z.array(z.object({
        shape_id: z.string().describe("A floor_area shape id of source_condition (list_shapes)"),
        lf: z.number().min(0).describe("Door/opening width to deduct from that room's perimeter, in feet"),
      })).optional().describe("Stated openings per room — omit for gross perimeters"),
    },
    outputSchema: deriveBaseOutput,
  }, run("derive_base", (a) => session.deriveBase(a)));

  server.registerTool("derive_transitions", {
    description: `Mint the transition where two finishes MEET (#202) — the derivation that follows derive_base, and the line an estimator draws by hand on every job. Pass the two finish tags and the tag the transition commits under (e.g. condition_a 'CPT-1', condition_b 'PT-1', condition 'T-1'), and every committed room of each is compared against every committed room of the other.\n\nWHAT THE GEOMETRY ACTUALLY IS, because it decides what you get back: flood-traced rooms DO NOT SHARE EDGES. A trace fills to the wall linework, so two rooms across a partition are separated by four to eight inches of nothing — testing for a shared edge finds zero transitions on a real planset. What is there is proximity, in two flavours that mean completely different things:\n\n• BUTT JOINT — the two rings run together inside ONE open space (a lobby that changes from carpet to tile with no wall between). The transition IS that run, and it commits as a linear shape under your tag, origin.derived naming both parent shapes and the measured gap.\n\n• WALL-SEPARATED — the rings run parallel across a partition. The rooms are adjacent, but the transition is NOT the shared wall: it is a threshold, in the doorway, and NOTHING in the trace record says where the doorway is (the flood engine seals openings and reports how MUCH boundary it synthesised, never where). Committing 34 LF of threshold because two rooms share 34 LF of wall would be a wrong bid with a machine's confidence behind it. These come back in \`withheld\` — measured, with their length, their gap in inches, and an \`at\` point — as questions you answer by LOOKING (view_sheet at \`at\`, then measure_line or place_count the threshold yourself). The symbol_sweep doctrine: a near-match is never a silent commit and never a silent drop.\n\nTuning: max_gap_in (default 12) is how far apart two rings can be and still count as adjacent at all — raise it for thick walls, and every extra inch turns more of the plan into wall_separated questions, never into committed LF. min_run_in (default 12) drops corner artifacts. The butt-joint threshold is fixed at one inch and is not a knob: "these two finishes touch" is not a judgement call.\n\nAll-or-nothing, like derive_base: an unknown tag, a transition landing on either source tag, the same tag twice, or a sheet without a scale refuses the whole call before anything commits. The whole sweep is ONE undo step. After it, LOOK — view_sheet {overlay: true} over each run — before trusting total_lf. ${COORDS}`,
    inputSchema: {
      condition_a: z.string().describe("First finish tag, e.g. 'CPT-1' — its committed rooms are walked, and runs are traced along their boundaries"),
      condition_b: z.string().describe("Second finish tag, e.g. 'PT-1'"),
      condition: z.string().describe("Finish tag the transitions commit under (minted on first use), e.g. 'T-1'. Must differ from both sources"),
      max_gap_in: z.number().positive().optional().describe("How far apart two rings can be and still count as adjacent, in inches (default 12 — a thick partition). Wider only produces more wall_separated QUESTIONS, never more committed LF"),
      min_run_in: z.number().positive().optional().describe("Shortest run worth reporting, in inches (default 12) — below this is a corner where two rooms clip, not a transition"),
    },
    outputSchema: deriveTransitionsOutput,
  }, run("derive_transitions", (a) => session.deriveTransitions(a)));

  server.registerTool("takeoff_summary", {
    description: `Per-condition totals (floor/wall/border SF, LF, EA, SY, with and without waste) plus grand totals — the Report's numbers, computed by the same rules. Numbers only: the deliverable that SHOWS the work on the drawings is export_marked_pdf. ${COORDS}`,
    inputSchema: {},
    outputSchema: takeoffSummaryOutput,
  }, run("takeoff_summary", () => session.summary()));

  server.registerTool("export_takeoff", {
    description: `The full "opentakeoff.takeoff_canvas.v1" annotations payload — exactly what the app autosaves, importable by it. Returned inline; pass path to also write it to disk as JSON. ${COORDS}`,
    inputSchema: {
      path: z.string().optional().describe("File path to write the payload to"),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESC),
    },
    outputSchema: exportTakeoffOutput,
  }, run("export_takeoff", async ({ path: outPath, overwrite }) => {
    const payload = session.exportPayload();
    if (outPath) {
      await assertWritable(outPath, "json", overwrite);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outPath, JSON.stringify(payload));
    }
    return payload;
  }));

  server.registerTool("export_dxf", {
    description: `The takeoff as a CAD drawing — a DXF (R2000) AutoCAD, BricsCAD, LibreCAD and Revit import as native geometry, not a picture. ONE sheet per file, like a DWG: every committed shape on that sheet becomes an LWPOLYLINE (floor rings CLOSED, walls and linear runs open, count marks a 1-ft circle), on a layer named for its finish — OT-<TAG>, with -DEDUCT / -HOLE / -WALL / -LINEAR / -COUNT suffix layers so a CAD user isolates any bucket with one layer filter, and room labels as TEXT on OT-LABELS. Coordinates are real units in the sheet's own frame: origin at the sheet's BOTTOM-left, Y up (CAD convention), feet by default ($INSUNITS 2) or metres with units:"m"; a ring's area in CAD equals its area in export_report to rounding, so the drawing IS the audit. Requires the sheet's scale (refuses otherwise — pixels in a DXF are worse than nothing); with several sheets carrying shapes, pass sheet to choose the drawing (the refusal lists them). The reply names every shape left out and why — a reconciled deduct ships as its parent's -HOLE ring, never twice. Writes to path (required — a DXF lives on disk, next to the DWG it aligns to); pair with export_marked_pdf for the reviewed planset.`,
    inputSchema: {
      path: z.string().describe("File path to write the .dxf to"),
      sheet: z.string().optional().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101"). Optional only when exactly one calibrated sheet carries shapes'),
      units: z.enum(["ft", "m"]).optional().describe('Output units — "ft" (default) or "m"'),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESC),
    },
    outputSchema: exportDxfOutput,
  }, run("export_dxf", async ({ path: outPath, sheet, units, overwrite }) => {
    const { sheet: s, build } = session.exportDxf(sheet, units ?? "ft");
    await assertWritable(outPath, "dxf", overwrite);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, build.dxf, "utf8");
    return {
      path: outPath,
      sheet: s.key,
      sheet_number: s.sheetNumber ?? null,
      units: units ?? "ft",
      layers: build.layers,
      entities: build.entities,
      shapes: build.shapes,
      skipped: build.skipped,
      extents: build.extents,
      bytes: Buffer.byteLength(build.dxf, "utf8"),
    };
  }));

  server.registerTool("export_report", {
    description: `The computed Report document — "opentakeoff.report.v1", the same schema the canvas Report's JSON export writes. Everything a pricing consumer needs without re-implementing the app's math: per-condition quantities with waste and multiplier applied (gross and *_net), the computed materials BUY LIST per condition (order quantity = basis ÷ coverage rate, rounded up to whole purchase units) plus the project-wide roll-up summed by (name, unit), per-sheet BASE subtotals, scale provenance per sheet, and annotations. Contrast: export_takeoff is the raw canvas payload (materials as CONFIG rows, no computed quantities) and takeoff_summary strips materials for a compact reply — when the numbers are leaving for pricing, consume this. A report alone is HALF the deliverable: pair it with export_marked_pdf, because a takeoff is reviewed on marked drawings, not on numbers. Returned inline; pass path to also write it to disk as JSON.`,
    inputSchema: {
      path: z.string().optional().describe("File path to write the document to"),
      project_name: z.string().optional().describe("Label for the document's project_name field (a headless session has no project of its own; omitted → null)"),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESC),
    },
    outputSchema: exportReportOutput,
  }, run("export_report", async ({ path: outPath, project_name: projectName, overwrite }) => {
    const doc = session.exportReport(projectName);
    if (outPath) {
      await assertWritable(outPath, "json", overwrite);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outPath, JSON.stringify(doc));
    }
    return doc;
  }));

  server.registerTool("import_takeoff", {
    description: `The way BACK IN (#151): load an "opentakeoff.takeoff_canvas.v1" file — a prior export_takeoff, or the app's own save — into this session, through the SAME tested merge rules as the app's Sheet-menu import: finish-tag identity joins imported conditions onto this session's own (their knobs win), new ids append, duplicate ids skip (re-import is idempotent), and THIS session's calibration wins per sheet. An uncalibrated empty session adopts the file wholesale. New dimensional shapes refuse atomically if their source scale differs from the session calibration or is missing; align scales and re-export, or use a fresh session. Counts and duplicate IDs are exempt. Legacy agent traces without review flags arrive reviewed:false. Resume yesterday's work, extend a takeoff a human already reviewed (their ink stays ink — reviewed shapes arrive untouchable by agent verbs), or audit someone else's export with list_shapes/takeoff_summary. Requires a loaded plan; shapes referencing OTHER files ride along and count in totals but can't be viewed against this document — the reply's unknown_files names them. Approval marks ride the file too — transport, not minting: an estimator seal arriving by import stays estimator ink, listable but untouchable here. undo_last removes the imported SHAPES as one step; adopted conditions, scales, annotations, and approval marks stay.`,
    inputSchema: {
      path: z.string().describe("Path to a takeoff_canvas.v1 JSON file on disk"),
    },
    outputSchema: importTakeoffOutput,
  }, run("import_takeoff", (a) => importTakeoff(session, a.path)));

  server.registerTool("apply_rules", {
    description: `Re-run the correction rules the takeoff arrived with (#207) — the lessons an estimator TAUGHT the canvas (#88): "every room like this loses the mechanical chase." A rule is a deterministic predicate (enclosed linework islands under a size cap, inside the rule's condition's rooms), never a re-prompt. Evaluation is the same pure rules.ts engine the canvas Preview runs; the commit is the one batch the canvas's Apply makes — ONE journal entry, undo_last takes the whole batch back. Everything lands reviewed: false (this server has no review gate), and the reply's per-rule disclosure — what each rule produced, what was skipped, with ids — IS your preview: read it, then view_sheet overlay:true. Idempotent by construction: any candidate an existing deduct already covers is dropped by the engine, so re-running after new rooms commit is the intended workflow and never double-deducts. Rules arrive ONLY via import_takeoff (minting a new rule is an estimator's correction and stays behind the canvas's human Preview→Apply gate); with none imported this refuses. Pass sheet to scan one sheet; omit it to scan every sheet holding the rules' rooms. Uncalibrated and scanned-raster sheets come back in skipped_sheets, named.`,
    inputSchema: {
      sheet: z.string().optional().describe("Scan only this sheet (default: every sheet holding the rules' conditions' rooms)"),
    },
    outputSchema: applyRulesOutput,
  }, run("apply_rules", (a) => session.applyRules(a)));

  server.registerTool("export_marked_pdf", {
    description: `The MARKED-UP PLANSET — the deliverable of every takeoff. Writes a distribution-ready PDF to disk: a legend cover (per-condition totals, swatches, a by-sheet breakdown) followed by every sheet that carries takeoff shapes or annotations, vector-copied from the source plan with the work burned in as drawn — condition colors and hatches, a quantity chip on every shape, annotation clouds/callouts/highlights, and approval marks (the estimator's APPROVED rings, the agent's AGENT diamonds — the cover tallies the split). Built by the same module as the canvas's MARKED SET button, so agent output and app output are one implementation. A construction takeoff is no good without markup: finish EVERY takeoff by writing this file and giving the user its path (export_report carries the numbers for pricing; this carries the evidence). When the shapes were machine-traced and unreviewed, the document says so on its last page — the review path is importing the export_takeoff payload into the app, where agent shapes arrive as pencil proposals. Default path: next to the loaded plan as "<plan> - marked set.pdf". Needs no native canvas — pure vector copy, so it works even where view_sheet cannot render. The one source it refuses: an ENCRYPTED plan PDF (owner password, empty user password — it opens everywhere, but its pages cannot be vector-copied and there is no canvas here to render them); the refusal names the sheet — export the marked set from the app, or supply an unencrypted PDF.`,
    inputSchema: {
      path: z.string().optional().describe('Where to write the PDF (default: "<plan dir>/<plan> - marked set.pdf")'),
      project_name: z.string().optional().describe("Cover-page project name (default: the plan file's name)"),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESC),
    },
    outputSchema: exportMarkedPdfOutput,
  }, run("export_marked_pdf", (a) => exportMarkedPdf(session, a)));

  server.registerTool("list_shapes", {
    description: `The mid-session shape inventory (#149): every committed shape's id, sheet, condition tag, role, quantities, room label, vertex count, and review state in one compact read — the ids edit_shape and delete_shape assume you have, without pulling the whole export_takeoff payload to find one shape. Filter by sheet, by condition, or both; filters narrow, an empty list is a result, not an error.`,
    inputSchema: {
      sheet: z.string().optional().describe("Only shapes on this sheet"),
      condition: z.string().optional().describe("Only shapes under this finish tag (must exist)"),
    },
    outputSchema: listShapesOutput,
  }, run("list_shapes", (a) => session.listShapes(a)));

  server.registerTool("delete_shape", {
    description: `Remove a committed shape by the id returned when it was committed. ${COORDS}`,
    inputSchema: { shape_id: z.string() },
    outputSchema: deleteShapeOutput,
  }, run("delete_shape", ({ shape_id }) => session.deleteShape(shape_id)));

  server.registerTool("scope_duplicates", {
    description: `Two conditions claiming the same floor, as a list (#366). Every pair of committed floor_area shapes on one sheet whose EXACT polygon intersection exceeds min_fraction of the smaller shape — with the shared SF, which condition each belongs to, whether the estimator already affirmed either, and a look region to pass to view_sheet {overlay: true}. Pairs on DIFFERENT conditions are collisions: every total downstream counts that floor twice. Pairs on the SAME condition are a double trace (a different bug) and come back in duplicates. shared_floor_sf is the whole compared set's Σ areas − union, counted once per cell no matter how many shapes pile on it — the number takeoff_summary carries and the one that has to read 0 before any total means anything. Deducts and runs are not claims. Read-only; a shape on an unscaled sheet or with a degenerate ring is listed in unmeasured, never counted as zero. Same rule as the room eval's shared-floor gate (iou ≥ 0.5 = the same space claimed twice). ${COORDS}`,
    inputSchema: {
      sheet: z.string().optional().describe("Restrict to one sheet; default every sheet with floor shapes"),
      min_fraction: z.number().min(0).max(1).optional().describe("List a pair only when shared ÷ smaller ≥ this (default 0.05 — rings that merely kiss along a wall are not claims; 0 lists everything that shares floor)"),
    },
    outputSchema: scopeDuplicatesOutput,
  }, run("scope_duplicates", (a) => session.scopeDuplicates({ sheet: a.sheet, min_fraction: a.min_fraction })));

  server.registerTool("scope_merge", {
    description: `Resolve ONE collision (#366): given a pair of floor shapes and the winner, the loser gives up the shared floor — TRIMMED to its remainder by an exact boolean difference (the cut_out module's own arithmetic; its quantities re-measured from the result), or DELETED outright when the overlap is near-total (≥ 98% of the loser: the same space claimed twice, not a room with a sliver left). One journal step either way; undo_last restores the loser verbatim. Who wins: state winner; with it omitted the reviewed shape wins over a pending one, and the verb refuses when neither is reviewed (it does not guess which condition the floor belongs to) or when BOTH are (that is the estimator's call — the collision shows on both condition rows in the canvas). The ink rule is absolute: a loser the estimator affirmed is refused whoever you name. A trim that would split the loser into disjoint pieces refuses — that is a re-trace decision, not a merge — and a loser carrying reconciled cutouts refuses (delete the cuts first).`,
    inputSchema: {
      shape_a: z.string().describe("One shape of the pair (from scope_duplicates)"),
      shape_b: z.string().describe("The other"),
      winner: z.string().optional().describe("Which of the two keeps the shared floor; omit to let the reviewed one win"),
    },
    outputSchema: scopeMergeOutput,
  }, run("scope_merge", (a) => session.scopeMerge({ shape_a: a.shape_a, shape_b: a.shape_b, winner: a.winner })));

  server.registerTool("revise_proposal", {
    description: `Replace EVERY still-pending shape in a proposal with a new set, as ONE journal step (#365) — the move for "I re-measured and got a better batch". The old pending shapes go, the replacements commit under the same proposal, and undo_last puts the previous batch back exactly. All-or-nothing: the whole replacement is validated (sheet, scale, vertex count, a height for surface_area) before the first pending shape is removed, so a malformed last shape leaves the batch untouched and the error says which entry and why. Shapes the estimator already accepted are ink — they stay, and they are not part of what this replaces. verts are image px like every other tool; roles and minimums match the measure tools (floor_area/deduct ≥3, linear/surface_area ≥2, count 1). An empty shapes list is refused — withdraw_proposal is the verb for that. ${COORDS}`,
    inputSchema: {
      proposal_id: z.string().describe("The batch, from propose_takeoff"),
      shapes: z.array(z.object({
        sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number'),
        condition: z.string().describe("Finish tag — minted on first touch, like measure_polygon"),
        role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
        verts: z.array(pointSchema).min(1).describe("Geometry in image px: a ring for areas, a run for linear/surface, one point for a count"),
        label: z.string().optional().describe("The room this shape belongs to (per-room reporting)"),
        height_ft: z.number().positive().optional().describe("surface_area only — the height to quantify at when the condition has none"),
      })).min(1),
    },
    outputSchema: reviseProposalOutput,
  }, run("revise_proposal", (a) => session.reviseProposal(a.proposal_id, a.shapes)));

  server.registerTool("withdraw_proposal", {
    description: `Take a proposal back (#365): every still-pending shape in the batch is removed in ONE journal step, the record stays marked withdrawn (its label is history the estimator may still read), and new commits stop attaching to it. Shapes the estimator already accepted are ink and stay — the reply counts them. This is the honest exit for "that batch was wrong" — one call instead of N delete_shape calls, and undo_last restores the whole batch.`,
    inputSchema: { proposal_id: z.string().describe("The batch, from propose_takeoff") },
    outputSchema: withdrawProposalOutput,
  }, run("withdraw_proposal", ({ proposal_id }) => session.withdrawProposal(proposal_id)));

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

  server.registerTool("get_sheet_vectors", {
    description: `The STROKES — the sheet's vector layer exactly as the engine is fed it, so you can run your own geometry against what the app sees (#367). view_sheet lets you look, read_sheet_text lets you read, sheet_context classifies a region; this returns the raw extractor output that all of them and every shape verb (${oneClick ? "one_click's flood, " : ""}the wall network's pen weights, symbol_sweep's matching) work from: flat points [x1, y1, x2, y2, …] in image px, one meta byte per segment (low nibble flags: 1 curve chord, 2 clip-only, 4 fill-only, 8 polyline arc; pen width = meta >> 4), per-segment stroke luminance, the drawn figure each segment belongs to (subpath ordinal), the sheet's placed-image area, and its PDF layer table with a per-segment layer index (sheet_info.layers names and classifies the same ids). Nothing is classified, decimated, or merged here — segments arrive whole, in extraction order, undecimated, which is the point: a reader can build its own room finder, symbol matcher, or wall classifier on the same array and commit through the existing verbs with provenance intact. Paged, never clipped silently: a dense sheet runs to hundreds of thousands of segments, so the reply carries limit (default ${VECTORS_DEFAULT_LIMIT} segments, ceiling ${VECTORS_LIMIT_CEIL}) and the ledger offset + returned + dropped === total on every page; dropped is exactly what passing next_cursor as cursor recovers. region keeps every segment that intersects the rect (endpoints untouched — the same keep test sheet_context uses, so total here equals sheet_context's total_in_region) and echoes it post-clamp. Read-only and stateless — no shape, condition, or scale is touched. A scan has no strokes: the verb refuses and names view_sheet as the path. ${COORDS}`,
    inputSchema: {
      sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101")'),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional()
        .describe("Rect in image px (origin top-left, y down); omit for the full sheet. A segment is kept when it intersects the rect"),
      limit: z.number().int().min(1).max(VECTORS_LIMIT_CEIL).default(VECTORS_DEFAULT_LIMIT)
        .describe(`Page size in segments (default ${VECTORS_DEFAULT_LIMIT}, max ${VECTORS_LIMIT_CEIL}) — about 1 MB of JSON per ${VECTORS_DEFAULT_LIMIT}`),
      cursor: z.number().int().min(0).optional()
        .describe("A previous reply's next_cursor — resume paging there. Omit for the first page"),
    },
    outputSchema: getSheetVectorsOutput,
  }, run("get_sheet_vectors", (a) => session.sheetVectors(a.sheet, { region: a.region, limit: a.limit, cursor: a.cursor })));

  server.registerTool("edit_shape", {
    description: `REVISE a shape you already committed, instead of deleting it and starting over: pass new verts to move the geometry, condition to reassign it to a different finish tag, role to switch between floor_area / deduct / linear, label to name the room it belongs to, or any combination. Quantities are recomputed from the result — a role flip alone re-measures (closed area vs open length). The loop this is for: ${oneClick ? "one_click or " : ""}measure_polygon to commit, view_sheet with overlay:true to LOOK at what landed, then edit_shape to fix the two vertices that overshot into the corridor. label is the per-room reporting seam: ${oneClick ? "detect_rooms already stamps the room number it traced from, so " : ""}this is how a shape traced by hand — or one whose room number the sweep read wrong — joins the same per-room breakdown the Report and the workbook's floor × room tab group by. Shapes a human affirmed (origin.reviewed) are ink and are refused — an agent revises its own pencil and nothing else. Agent self-revision is tallied on origin.agent_edits, kept deliberately separate from the human-correction fields. ${COORDS}`,
    inputSchema: {
      shape_id: z.string().describe("Id returned when the shape was committed"),
      verts: z.array(pointSchema).optional().describe("Replacement geometry (image px): ≥3 vertices for an area shape, ≥2 points for a linear/surface run, ≥1 for a count marker"),
      condition: z.string().optional().describe("Reassign to this finish tag (minted on first use)"),
      role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]).optional().describe("Switch what the shape measures — flipping INTO surface_area needs a height on the shape or its condition"),
      label: z.string().optional().describe('The room (or phase/area) this shape belongs to, e.g. "134" or "OFFICE 101" — what per-room reporting groups by. Pass "" to clear it'),
    },
    outputSchema: editShapeOutput,
  }, run("edit_shape", (a) => session.editShape(a.shape_id, { verts: a.verts, condition: a.condition, role: a.role, label: a.label })));

  server.registerTool("edit_materials", {
    description: `Add, remove, or patch supporting-materials rows on a condition — the coverage-rate lines that turn a measured area/length/count into an order quantity (adhesive at N sf/gal, grout at N lf/bag, …), matching the canvas's per-condition Supporting Materials panel. Each row is {name, per, basis, unit, round, note}: quantity = the condition's basis total (area/linear/count/seam_lf) ÷ per, rounded up to whole purchase units unless round:false. basis "seam_lf" is the one basis that is FIGURED rather than measured: it is the length where two cuts meet on the floor, read off the condition's roll layout (set roll_setup with edit_condition), which is what a heat-weld rod or a carpet seam tape is bought by. A 20-ft-wide room off a 12-ft roll seams once down its length; the same square footage as two 10-ft rooms seams not at all, and no percentage of the area or the perimeter can tell those two jobs apart. Without a roll_setup — or with no committed floor shapes to lay out — a seam_lf row reads 0, which is the honest state rather than a guess. condition names an existing OR NEW finish tag (minted on first touch, same as ${oneClick ? "one_click/" : ""}measure_polygon) — add alone is enough to seed materials on a condition before you've traced anything. remove/patch target existing row ids from this reply or export_takeoff (takeoff_summary strips materials for a compact quantities-only reply); a bad id 404s the WHOLE call before anything is written, and referencing an id on a tag with no condition yet errors rather than silently minting an empty one. No review gate here — materials rows are quantity config, not traced geometry, so this edits directly; undo_last reverses a call in one step (the condition's whole materials array, snapshotted before the write, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag, e.g. 'CPT-1'"),
      add: z.array(z.object({
        name: z.string().min(1),
        per: z.number().min(0).optional().describe("Coverage rate — basis units per purchase unit, e.g. 250 for 1 gal / 250 sf. Default 0 (quantity 0 until set)"),
        basis: z.enum(["area", "linear", "count", "seam_lf"]).optional().describe("Which of the condition's totals this row divides against — default 'area' (total SF). 'seam_lf' is the figured roll-layout seam length (weld rod, seam tape), 0 until the condition carries a roll_setup"),
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
    description: `Set a condition's quantity knobs — waste %, multiplier, height_ft (the H knob measure_surface quantifies against), and/or roll_setup (the roll-goods opt-in: seams and order footage figured from the committed rooms, #147). takeoff_summary emits waste-adjusted *_net order quantities and a per-condition multiplier, and every export carries both, but conditions minted through the measure tools start at waste 0 / multiplier 1 — without this tool an agent's takeoff always ships net === gross (#131). waste_pct is the estimator's cut-waste percentage (carpet commonly 5–10); multiplier scales every quantity on the condition (×N identical floors — takeoff_summary applies it before waste). condition must resolve to an EXISTING finish tag — a typo'd tag errors rather than minting an empty condition (the edit_materials remove/patch rule, not its add rule: these knobs mean nothing on a condition that doesn't exist yet). No review gate — quantity config, not traced geometry; undo_last reverses a call in one step (both knobs snapshotted together, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag of an existing condition, e.g. 'CPT-1'"),
      waste_pct: z.number().min(0).optional().describe("Waste percentage applied to net order quantities, e.g. 10 for 10%"),
      multiplier: z.number().positive().optional().describe("Quantity multiplier (×N identical areas). Note: the canvas treats 0 as 1, so 0 is rejected here rather than silently meaning 'off'"),
      height_ft: z.number().positive().optional().describe("Wall height in feet — the canvas's H knob; measure_surface quantifies traced LF × this"),
      roll_setup: z.union([
        z.null().describe("Opt the condition OUT of roll goods"),
        z.object({
          material: z.enum(["carpet", "sheet_vinyl", "rubber"]).optional().describe("Material class — fresh opt-ins and material changes start from this class's engine defaults (carpet sells sy, others sf)"),
          roll_width_ft: z.number().positive().optional(),
          roll_length_ft: z.number().min(0).optional().describe("Physical roll length; 0 = unlimited"),
          seam_allowance_in: z.number().min(0).optional(),
          wall_overage_in: z.number().min(0).optional(),
          doorway_overage_in: z.number().min(0).optional(),
          direction: z.enum(["auto", "ns", "ew"]).optional().describe("Run direction; auto lets the engine pick per room"),
          price_unit: z.enum(["sy", "sf", "lf"]).optional().describe("Sell unit the order quantity is figured in"),
        }),
      ]).optional().describe("Roll-goods opt-in (#147): presence of a setup is what makes the condition roll goods — seams figured, cuts packed, order footage beside the measured quantities. Same-material partial edits patch the existing setup; null opts out. The reply echoes the figured order (cuts, order_lf, rolls, order_qty) whenever floor shapes exist on scaled sheets, and export_report's roll_goods block carries the same rows"),
    },
    outputSchema: editConditionOutput,
  }, run("edit_condition", (a) => session.editCondition(a.condition, { waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, roll_setup: a.roll_setup })));

  server.registerTool("propose_condition_edit", {
    description: `PROPOSE a change to a condition instead of making it (#365): a diff — a new finish tag (rename), waste %, ×N multiplier, height_ft, roll_setup — held PENDING until the estimator accepts it from the panel. edit_condition is the wrong power for "I think this condition is wrong": a tag rename or a knob change should be a decision the estimator makes, not one they discover. Until acceptance NOTHING changes — takeoff_summary and export_report keep computing from the current values and carry the diff beside them (proposed_condition_edits), and once accepted the report is byte-for-byte what a direct edit_condition would have produced (the same write path). Only fields that differ from the current value are recorded; a proposal that changes nothing is refused, and a rename onto a tag another condition already carries is refused (two conditions on one tag would make one unreachable). One pending diff per condition — proposing again replaces the earlier one (undo_last restores it). rationale is required: the estimator accepts a reason.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of an EXISTING condition, e.g. 'CPT-1'"),
      finish_tag: z.string().min(1).optional().describe("Proposed new tag (a rename)"),
      waste_pct: z.number().min(0).optional(),
      multiplier: z.number().positive().optional(),
      height_ft: z.number().positive().optional(),
      roll_setup: z.union([z.null(), z.object({}).passthrough()]).optional().describe("Proposed roll-goods setup, or null to propose opting out"),
      rationale: z.string().min(1).describe("Why — the schedule row, the spec section, the sheet note that decided it"),
    },
    outputSchema: proposeConditionEditOutput,
  }, run("propose_condition_edit", (a) => session.proposeConditionEdit(a.condition, { finish_tag: a.finish_tag, waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, roll_setup: a.roll_setup }, a.rationale)));

  server.registerTool("withdraw_condition_edit", {
    description: `Drop a pending condition-edit proposal (#365) without touching the condition. undo_last re-seats it.`,
    inputSchema: { proposal_id: z.string().describe("From propose_condition_edit, or takeoff_summary's proposed_condition_edits") },
    outputSchema: withdrawConditionEditOutput,
  }, run("withdraw_condition_edit", ({ proposal_id }) => session.withdrawConditionEdit(proposal_id)));

  server.registerTool("duplicate_condition", {
    description: `Twin a condition — the same finish measured somewhere else, with its own supporting materials. One finish in two areas is not two conditions and it is not one either: the same sheet goods over a slab and over a raised deck take the same field material and different preparation underneath (one wants a moisture barrier, the other a primer and a different adhesive). The twin arrives carrying the original's whole materials list and keeps FOLLOWING it — change a coverage rate on the original and every twin that has not touched that row gets it; edit a row on the twin and only THAT row stops following. \`label\` is REQUIRED and becomes the tag suffix ('CPT-1' + 'Level 2' → 'CPT-1 – Level 2'), because every tool in this server resolves a condition by finish tag and takes the FIRST match: two conditions sharing a tag would make one permanently unreachable, and a takeoff re-import collapses them last-wins. A label already in use is refused rather than de-collided. No takeoffs come along — measure the new area against the returned condition_id. Reversible with undo_last; use split_condition to end the inheritance permanently.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of the condition to twin, e.g. 'CPT-1'"),
      label: z.string().describe("What makes this one different, usually the area: 'Level 2', 'Building B', 'Phase 2'"),
    },
    outputSchema: duplicateConditionOutput,
  }, run("duplicate_condition", (a) => session.duplicateCondition(a.condition, a.label)));

  server.registerTool("split_condition", {
    description: `Cut a twin loose from its family: every following material row freezes at its current values and edits to the original stop reaching it. It keeps its finish tag and still groups with its siblings — only the inheritance ends. Use when two variants have diverged far enough that following one another is wrong. A condition that already owns its materials returns split:false rather than erroring. Reversible with undo_last.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of the twin to split, e.g. 'CPT-1 – Level 2'"),
    },
    outputSchema: splitConditionOutput,
  }, run("split_condition", (a) => session.splitCondition(a.condition)));

  server.registerTool("undo_last", {
    description: `Step back over your OWN last n mutations, newest first — ${oneClick ? "a committed one_click, a whole detect_rooms sweep" : "a committed measure_polygon"}, an edit_shape, a delete_shape, an edit_materials call, an edit_condition call, or an RFI verb (create_rfi / resolve_rfi / delete_rfi). Each step is reversed exactly (a commit is removed, an edit is restored verbatim, a delete is re-inserted where it was, a materials edit's whole array is restored, a condition edit's waste/multiplier pair is restored), so this restores state rather than approximating it. Reads are never journaled, so n counts gestures that changed something, not tool calls you made. Use it when a sweep committed against the wrong condition or a batch went in on the wrong sheet — one call instead of N deletes. Scope: this session's own history only. It is not the browser canvas's undo stack, and load_plan clears it along with the shapes it refers to.`,
    inputSchema: {
      n: z.number().int().min(1).max(UNDO_CAP).default(1).describe(`How many steps to reverse (1–${UNDO_CAP})`),
    },
    outputSchema: undoLastOutput,
  }, run("undo_last", ({ n }) => session.undoLast(n)));

  server.registerTool("sheet_graph", {
    description: `The plan-set INDEX (#87): every sheet's role (plan / schedule / legend / …, with confidence and the title evidence), the schedule tables found (kind, row count, region — a schedule CONTINUED across sheets ("… SCHEDULE — CONT'D") reads as ONE table, the continuation fragment naming its base in "continues"; rotated column headers are read at their quarter-turn and flagged), every number CORROBORATED as a room (with the stacked room NAME when one exists, the room's BUILDING on multi-building sets, and "corroboration" saying why it counts as a room) plus "unmatched_tags" — the numbers that are NOT rooms (keynote hexagons, detail markers, dimension fragments, legend rows), each with a reason, listed and never dropped; READ those reasons, one of them may be a room the schedule left out, the detail callouts (3/A-601 → sheet edges), the set's building designators, every REVISION marker the set carries (text markers "Δ2"/"REV 2" AND drawn deltas — a bare digit inside a triangle of linework, proven from vector geometry and flagged drawn — in "revisions", and attached to the schedule row / room tag they sit on), and named indexing gaps in "notes". Built once per document from the text layer and cached. This is how an agent decides WHAT to measure without a human enumerating the rooms: list the rooms here, resolve each with resolve_tag, then measure with ${oneClick ? "one_click/detect_rooms" : "measure_polygon on its wall faces"}. A scanned set (no text layer) returns available: false — unavailable, never half-populated. ${COORDS}`,
    inputSchema: {},
    outputSchema: sheetGraphOutput,
  }, run("sheet_graph", () => session.sheetGraph()));

  server.registerTool("resolve_tag", {
    description: `Resolve ONE room tag across the set (#87): the plan tag → its room-finish schedule row → each finish code's definition in the finish/material schedule, EVERY edge carrying an evidence pointer (sheet + literal text + bbox — pass a bbox to view_sheet to look at the source). Rows carried by a continuation sheet ("… SCHEDULE — CONT'D") resolve exactly like base-sheet rows, citing the sheet the ink is on. The doctrine is refusal over guessing: a room that appears on the plan with no schedule row returns status "unresolved" with the reason (and still cites the plan tag); reused room numbers return "ambiguous" rather than picking one — on a multi-building set the refusal LISTS the candidate rows per building, and a building-qualified tag ("A-134") picks the building the set names. A delta triangle or REV tag on the answering row (or the plan bubble) rides the result as "revisions": the codes returned are the POST-revision answer, but the ink changed under that delta — view_sheet the marker's bbox and check the addendum before pricing. ${COORDS}`,
    inputSchema: { tag: z.string().describe('The room tag as drawn, e.g. "134" or "139A" — or building-qualified on a multi-building set, e.g. "A-134" (building A, room 134)') },
    outputSchema: resolveTagOutput,
  }, run("resolve_tag", ({ tag }) => session.resolveRoomTag(tag)));

  server.registerTool("find_schedule", {
    description: `Locate a schedule table in the set (#87): pass a kind ("room finish", "material"/"finish") and get every matching table's sheet, title, headers, TOTAL row count, and REGION — sized for a view_sheet look or a read_sheet_text pull of exactly the table. A schedule continued across sheets is ONE match whose "parts" list every fragment (base first) with its own viewable region; tables read through rotated headers say so; a table answering for one building carries "building"; a table with delta/REV-marked rows says how many in "revised_rows". Errors with what WAS found when the asked-for kind isn't in the set. ${COORDS}`,
    inputSchema: { kind: z.string().describe('"room finish" (rooms → surface finishes), "finish"/"material" (codes → products), or "equipment" (MEP device schedules — fans, pumps, heaters, AHUs, VAVs, diffusers/grilles/registers — keyed by mark, proven by a powered or air-device column)') },
    outputSchema: findScheduleOutput,
  }, run("find_schedule", ({ kind }) => session.findSchedule(kind)));

  server.registerTool("read_sheet_text", {
    description: `The sheet's text with positions — items [{str, x, y}] in image px plus the joined text. Optionally restrict to a region {x0, y0, x1, y1}. Use it to read title blocks, room labels, finish schedules, and scale notes. ${COORDS}`,
    inputSchema: {
      sheet: z.string(),
      region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
    },
    outputSchema: readSheetTextOutput,
  }, run("read_sheet_text", (a) => session.readSheetText(a.sheet, a.region)));

  server.registerTool("find_text", {
    description: `LOCATE a known string on a sheet — the complement to read_sheet_text (which returns what a region SAYS; this finds WHERE a string you already know sits). Case-insensitive substring match against each pdf.js text run, so a room label split across runs ("OFFICE" then "134" as separate items) needs a find_text call per fragment, or read_sheet_text over a region to see the whole thing joined. ${oneClick ? "Every hit's center feeds straight into one_click as the seed — the locate-then-trace workflow: find_text the room number, one_click at (or just past) its center." : "Every hit tells you which room a polygon belongs to — the locate-then-trace workflow: find_text the room number, then " + GATE_HINT + " on that room's wall faces."} Optionally restrict to a region {x0, y0, x1, y1}; results cap at limit (default 200), with count/truncated telling you exactly how much a tighter region or higher limit would recover. ${COORDS}`,
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
    description: `SEE the sheet — render the page (or a crop of it) to a PNG image. This is your eyes on the plan, so CROP, DON'T SQUINT: the render downsamples to the px budget (≤2000 long side), which on an E-size sheet is ~4 sheet pixels per returned pixel — a full-sheet render finds WHERE things are, and only a tight region crop can tell you what the linework and labels actually say. Never audit a trace or read a dimension off a full-sheet render. region is in image px — the same space as every other tool — so a feature at pixel (ix, iy) of the returned image sits at x = region_x0 + ix × (region_x1 − region_x0) / img_w (same for y), and those coordinates go straight into ${oneClick ? "one_click, " : ""}measure_polygon, or read_sheet_text. overlay:true burns the session's committed shapes into the render (human-affirmed ink solid red, unreviewed machine shapes dashed blue) — render again after committing to verify your geometry landed where you intended, and sanity-check what you see: a fixture-sized ring where a room should be means the seed landed inside a stall or casework; an outsized ring means the flood escaped through an opening. To MEASURE rather than guess, pass grid: a calibrated measuring grid is burned in — thin lines every 1 ft, heavy blue every 5 ft, foot labels along the crop edges, feet counted from the crop's top-left corner. Count grid cells between walls exactly like an estimator scaling a plan; never derive a dimension by eye when the grid can give it to you. grid "auto" uses the sheet's set scale; before set_scale, pass the drawing scale read off the title block as inches-per-foot — "1/4" for a 1/4" = 1'-0" plan, "3/16", "0.25". marks (#297) burns DISCLOSURE layers into the render, so what a reply names, the picture shows: pass the coordinate lists a tool disclosed — question: withheld placements (orange ?-circles), struck: rejections a counter-example or luminance gate refused (magenta struck ×), ring: reference points like the sweep's own seed (violet double ring). The colors sit deliberately off the common CAD pens so they cannot vanish into color-plotted work. An overlay audit without marks shows only committed ink — the validation trap where 37 disclosed near-misses read as "it missed them". Rendering needs the optional native canvas (@napi-rs/canvas); where it isn't installed this tool errors cleanly and every other tool still works. ${COORDS}`,
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
      marks: z.object({
        question: z.array(pointSchema).optional().describe("Open questions — withheld placements, spots to look at. Orange ?-in-circle"),
        struck: z.array(pointSchema).optional().describe("Refusals — rejected[] placements, lum_gate.at. Magenta struck ×"),
        ring: z.array(pointSchema).optional().describe("Reference points — the sweep's seed.center, an anchor. Violet double ring"),
      }).optional().describe("Disclosure marks to burn into the render (#297): what the reply names, the picture shows. Coordinates in image px"),
    },
  }, async (a: { sheet: string; region?: { x0: number; y0: number; x1: number; y1: number }; px?: number; overlay?: boolean; grid?: string; marks?: { question?: [number, number][]; struck?: [number, number][]; ring?: [number, number][] } }): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      const { png, meta } = await session.viewSheet(a.sheet, { region: a.region, px: a.px, overlay: a.overlay, grid: a.grid, marks: a.marks });
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
    description: `Place an annotation on a sheet — a note ABOUT the work, never a measurement of it. Types: cloud and highlight take rect:[[x0,y0],[x1,y1]] (a revision cloud around an area, a highlight box over it), text takes at:[x,y], callout takes at:[x,y] plus target:[x,y] (the point its leader aims at), arrow takes from:[x,y] and to:[x,y] (tail and head — plank/seam direction, the markup flooring drawings use most; #150), bubble takes at:[x,y] plus optional r (a keynote/detail circle carrying centered text), dimension takes from:[x,y] and to:[x,y] (its two measured endpoints) and labels itself with the length between them at the sheet's scale — drawn as a dimension line with end ticks and the measurement centered. A dimension states a REAL length, so it is the one annotation the scale gate applies to: on an unscaled sheet it refuses exactly like the measure tools (set_scale first) rather than dressing a px figure up as feet. It still touches no quantity — a dimension is a note about a distance, not a takeoff line item.\n\nPass condition to attach the note to a finish tag, which is what makes it part of that SCOPE rather than a floating remark: it then wears the condition's colour on the canvas and in the marked-set PDF, and travels with it into the report. The tag is minted on first touch like ${oneClick ? "one_click/" : ""}measure_polygon, so you can annotate CPT-1 before anything is traced for it. Omit condition for a note about the sheet itself. \n\nNo review gate: the pencil-not-ink rule exists to stop an agent inventing geometry, and a cloud reading "verify substrate" is not geometry. It touches no quantity. ${COORDS}`,
    inputSchema: {
      sheet: z.string().describe("Sheet name or number, as sheet_info reports it"),
      type: z.enum(["cloud", "text", "callout", "highlight", "arrow", "bubble", "dimension"]).describe("cloud/highlight need rect; text/callout/bubble need at; callout also needs target; arrow and dimension need from + to"),
      text: z.string().default("").describe("The note. A cloud with no text still reads as 'look here'; a bubble's text draws centered in the circle; a dimension appends it after the measured length"),
      condition: z.string().optional().describe("Finish tag to attach this note to, e.g. 'CPT-1' (minted on first use). Omit for an unattached sheet note"),
      at: pointSchema.optional().describe("Anchor point (image px) — text, callout, and bubble (the circle's center)"),
      target: pointSchema.optional().describe("What a callout's leader line points at (image px)"),
      rect: z.tuple([pointSchema, pointSchema]).optional().describe("Corners (image px) — cloud and highlight"),
      from: pointSchema.optional().describe("Arrow tail / dimension start (image px)"),
      to: pointSchema.optional().describe("Arrow head / dimension end (image px)"),
      r: z.number().positive().optional().describe("Bubble radius (image px); omitted → the canvas default (2% of sheet width)"),
    },
    outputSchema: annotateOutput,
  }, run("annotate", (a) => session.annotate(a)));
  // (arrow/bubble/dimension ride the same handler — the Session validates per type)

  server.registerTool("list_annotations", {
    description: `Every annotation on the takeoff, with condition_id RESOLVED to its finish tag so you can act on the reply without joining against conditions[]. Filter by sheet, by condition, or both. Coordinates come back in image px (the same frame you passed in), not the normalized form they're stored as. \`unattached\` counts the notes carrying no condition — the candidates for link_annotation. \`verdicts\` is the approval family's inventory (mark_verdict/delete_verdict): every mark with its actor stated — the estimator's APPROVED ring or the agent's AGENT diamond — under the same filters, a condition filter reaching a verdict through its target shape. ${COORDS}`,
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

  // ── verdict marks (#176) — the agent half of the approval family ───────────
  // The canvas's Approve tool mints the estimator's APPROVED ring: ink, human-
  // only, deliberately unreachable from here. These two verbs are the other
  // actor — the AGENT diamond — and they take no actor input at all, so the
  // pencil/ink line is structural, not a convention.
  server.registerTool("mark_verdict", {
    description: `Mark the agent's VERDICT on work — the pencil half of the approval family, and the only half an agent can mint. Two actors exist on the record: the estimator's APPROVED ring is ink, minted solely by a human's click at the canvas's Approve tool; this tool mints the AGENT diamond and structurally nothing else — it takes no actor input to misuse. Target the work either way: shape_id anchors the mark ON a committed shape (a room at its area centroid, a run at its on-path midpoint, a count marker at its point) and records WHAT was marked — the shape_id stays on the record as provenance, and the glyph keeps its own anchor even if the shape is later deleted; or sheet + at drops the mark at a sheet point (image px). Exactly one target. Optional text rides the record through every export; the glyph itself always reads AGENT. A verdict touches no quantity and gates nothing: it is the agent's signed claim that it checked this work — pencil beside the estimator's ink, never in its place. The mark renders as the graphite AGENT diamond on the canvas and in the marked set, the marked-set cover tallies the split ("Approval stamps: N estimator-approved · M agent-marked"), and the record rides the annotations payload through export_takeoff / import_takeoff and the app's own saves. One mark per shape (re-mark = delete_verdict, then mark again); list_annotations returns the inventory in verdicts[]; undo_last steps over a mark exactly like any other mutation. ${COORDS}`,
    inputSchema: {
      shape_id: z.string().optional().describe("Mark a committed shape (list_shapes has the ids) — anchored on the shape, recorded as provenance. Exactly one target: this OR sheet + at"),
      sheet: z.string().optional().describe("Sheet-point mode: the sheet, together with at"),
      at: pointSchema.optional().describe("Sheet-point mode: where the AGENT diamond renders (image px)"),
      text: z.string().optional().describe("Optional short note riding the record and every export — the glyph always reads AGENT"),
    },
    outputSchema: markVerdictOutput,
  }, run("mark_verdict", (a) => {
    // the set_scale convention: one target, stated exactly, refused otherwise
    const byShape = a.shape_id !== undefined;
    const byPoint = a.sheet !== undefined || a.at !== undefined;
    if (byShape === byPoint) throw new UserError("Provide exactly one target: shape_id (mark a committed shape), or sheet + at (mark a sheet point).");
    if (byPoint && (a.sheet === undefined || a.at === undefined)) throw new UserError("A sheet-point verdict needs BOTH sheet and at: [x, y] (image px).");
    return session.markVerdict({ shape_id: a.shape_id, sheet: a.sheet, at: a.at, text: a.text });
  }));

  server.registerTool("delete_verdict", {
    description: `Lift an agent verdict mark by id (mark_verdict's reply, or list_annotations verdicts[]). Agent marks only: the estimator's APPROVED seal is human ink and is refused — the same line edit_shape holds on reviewed shapes. Journaled like every mutation, so undo_last re-seats a lifted mark exactly where it was.`,
    inputSchema: {
      verdict_id: z.string().describe("Record id from mark_verdict or list_annotations verdicts[]"),
    },
    outputSchema: deleteVerdictOutput,
  }, run("delete_verdict", ({ verdict_id }) => session.deleteVerdict(verdict_id)));

  // ── RFIs (#364) — raise, list, answer, withdraw a question on the sheet ────
  // The canvas's RFI register (RfiPanel), reachable by an agent: same store,
  // same numbering, same link rule. What the agent raises is PENDING until an
  // estimator accepts it in the register — an RFI goes to the architect, and
  // nothing sends without a human. Every verb journals; undo_last takes it back.
  server.registerTool("create_rfi", {
    description: `Raise an RFI — a Request For Information — when the drawing set contradicts itself or cannot answer a question you need answered to take the work off: a room-finish schedule row that names a tag the plan never draws, a room label the schedule has no row for, a finish called out two ways, a scale that disagrees with a stated dimension. It lands in the estimator's RFI register (the canvas's RFI panel) with the next number in that register's own sequence (RFI-001, RFI-002, …), status open, dated today, on the sheet you name. You raise it as the agent: the record carries origin {actor: "agent", reviewed: false} and is PENDING — pencil — until the estimator accepts it in the register, because an RFI goes to the architect and nothing sends without a human. It still prints in the marked set's RFI schedule like any other RFI, so the question is on the deliverable. Pass markup_ids to pin it to annotations already on the sheet (annotate a cloud or callout at the conflict first, then link it here) — a linked markup carries the RFI number on the canvas and in the marked set, and list_rfis reports which finish tags the question touches through those links. Prefer this to describing the conflict in prose: a question in the register is tracked, numbered, and answered; a sentence in a reply is lost. Journaled; undo_last takes it back.`,
    inputSchema: {
      title: z.string().describe("The one-line subject the register and the RFI schedule print — what the question is about"),
      question: z.string().describe("What you are asking the architect to answer, stated so a reply can settle it"),
      sheet: z.string().describe("Sheet name or number the question is about, as sheet_info reports it"),
      markup_ids: z.array(z.string()).optional().describe("Annotation ids (annotate / list_annotations) to link — they carry this RFI's number on the sheet"),
    },
    outputSchema: createRfiOutput,
  }, run("create_rfi", (a) => session.createRfi(a)));

  server.registerTool("list_rfis", {
    description: `Every RFI in the register with its status, sheet, who raised it (actor) and whether an agent-raised one is still pending the estimator's acceptance, its linked markup ids, and the finish tags those markups are attached to — the scopes the question touches. withdrawn[] lists the numbers delete_rfi tombstoned, so a gap in the sequence is explained rather than silent. Read this before raising a question the register already holds.`,
    inputSchema: {},
    outputSchema: listRfisOutput,
  }, run("list_rfis", () => session.listRfis()));

  server.registerTool("resolve_rfi", {
    description: `Answer an OPEN RFI: the answer lands as its response, status becomes answered (the register's own state for "response in"), and the response date stamps exactly as the panel's would, plus an ISO timestamp of the resolve. Only an open RFI resolves — an answered, closed, or void one is refused rather than re-answered or quietly revived (undo_last reverses your own resolve if the answer was wrong). Record the answer the drawings or the architect actually gave; an RFI is not resolved by guessing.`,
    inputSchema: {
      rfi_id: z.string().describe("Record id from create_rfi or list_rfis"),
      answer: z.string().describe("The response — what settles the question"),
    },
    outputSchema: resolveRfiOutput,
  }, run("resolve_rfi", ({ rfi_id, answer }) => session.resolveRfi(rfi_id, answer)));

  server.registerTool("delete_rfi", {
    description: `Withdraw an RFI. A TOMBSTONE, never a renumber: the record stays with its number reserved, so the register and the marked set keep printing a gap where it was and the next RFI takes the next number — an RFI number that went out and then meant something else would be a lie. Every markup linked to it keeps its note and loses the link (the canvas's own delete rule). Withdraw a question you raised in error; a question the architect answered is closed in the register, not deleted. Journaled; undo_last puts the record and its links back.`,
    inputSchema: {
      rfi_id: z.string().describe("Record id from create_rfi or list_rfis"),
    },
    outputSchema: deleteRfiOutput,
  }, run("delete_rfi", ({ rfi_id }) => session.deleteRfi(rfi_id)));

  return registered;
}
