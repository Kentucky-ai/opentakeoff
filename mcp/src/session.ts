// One-document session state: the loaded plan, per-sheet scale + lazy geometry
// caches, and the in-memory takeoff (conditions + shapes). All coordinates are
// image px at RENDER_SCALE = 2.0 (PDF pt × 2, origin top-left, y down) — the
// browser canvas's native space. Shapes and conditions are field-identical to
// what the canvas commits (web/src/pages/TakeoffCanvas.jsx), so an exported
// takeoff round-trips into the app.
import path from "node:path";
import { openPdf, positionedText, textSpans, textItemsInRegion, OPS, type DocHandle, type PageHandle, type TextSpan, type OcgEntry } from "./pdf.ts";
import { expandForScaleNotes, mixedScaleWarning } from "./scalewarn.ts";
import { classifyLayerName, layerRoleCodes, segRoles, type LayerInfo } from "../../web/src/lib/layers.ts";
import { buildSheetGraph, resolveTag, type SheetGraph, type SheetSpans } from "../../web/src/lib/sheetgraph.ts";
import { UserError, round1, round2 } from "./format.ts";
import { STANDARD_SCALES, RENDER_SCALE, detectScale, extractSheetNumber, type DetectedScale } from "../../web/src/lib/sheets.ts";
import {
  extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea,
  hatchFamilies, MASK_MAX_DIM, SENS_BALANCED, type FloodResult, type MaskObj, type VectorGeometry, type Point, type HatchFamily,
} from "../../web/src/lib/oneclick.ts";
// The canvas's raster-mask engine (#154), imported as-is — the scanned-sheet
// fallback is the SAME Bradley-threshold module the canvas floods with, so an
// agent's raster trace and a click's raster trace can never binarize differently.
import { buildRasterMask, RASTER_MIN_IMG_FRAC, RASTER_MIN_SEGS, RASTER_RDP_EPS } from "../../web/src/lib/rastermask.ts";
import { ROOM_LABEL_RE, seedLadderPx, isLabelBubblePx, type LabelBBox } from "../../web/src/lib/detectRooms.ts";
import { sweepSymbols, SWEEP_TOL_PX, type SweepOptions } from "../../web/src/lib/symbolsweep.ts";
import { buildSnapGrid, nearestSnap, closedMetrics, openLen } from "../../web/src/lib/geometry.js";
// The approvals family (#176) — the canvas's own pure module, imported as-is
// (the markedset.js/importTakeoff.js precedent), so a verdict this server
// mints and a seal the canvas mints share ONE implementation of minting,
// load-gating, and exact-restore inverses.
import { sanitizeApprovals as sanitizeApprovalsJs, applyApprovalCommand as applyApprovalCommandJs } from "../../web/src/lib/approvals.js";
import { conditionTotals, grandTotals, sheetTotals, reportJson } from "../../web/src/lib/totals.js";
import { hasRollSetup, mintRollSetup, computeRollTakeoff, rollReportRows } from "../../web/src/lib/rollTakeoff.js";
import { gridPxPerFoot, drawGrid, drawShapes, type Ctx2D, type ToCanvas } from "./view.ts";

// Copied from the canvas (web/src/pages/TakeoffCanvas.jsx) so conditions and
// snap behavior minted here are identical to the browser's. PALETTE/HATCH_IDS
// are user data — never re-theme them.
const SNAP_CELL = 24; // snap-grid bucket, raster px
const SNAP_TOL = 7;   // one-click vertex-snap tolerance, image px
const PALETTE = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2"];
// (2026-07: dropped a drifted "fleur" entry that never existed in this app's
// HATCHES, restoring "dots", and appended the signal-set ids.)
const HATCH_IDS = ["solid", "diag", "diag2", "cross", "diagdense", "horiz", "vert", "grid", "brick", "plank", "herring", "basket", "checker", "wave", "dots", "speckle", "iso", "honeycomb", "scan", "plus", "circuit", "topo"];
// uid mirrors web/src/lib/provenance.js mintUuid: crypto.randomUUID is a
// global in Node 20+, with the same non-secure-context fallback the browser
// build carries so the two sides mint identically-shaped ids.
const mintUuid = (): string =>
  (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const uid = (p: string): string => `${p}-${mintUuid()}`;

export const ANN_SCHEMA = "opentakeoff.takeoff_canvas.v1"; // web/src/lib/store.js

export type MeasureRole = "floor_area" | "deduct" | "linear" | "surface_area" | "count";

/** Supporting-materials row (field-identical to the canvas's addMaterial —
 * web/src/pages/TakeoffCanvas.jsx). Quantity is deterministic: basis ÷ per,
 * rounded up to whole purchase units unless round:false (totals.js). basis
 * "area" reads the condition's total SF, "linear" its LF, "count" its EA. */
export interface MaterialRow {
  id: string;
  name: string;
  per: number;
  basis: "area" | "linear" | "count";
  unit: string;
  round: boolean;
  note?: string;
}

export interface Condition {
  id: string;
  finish_tag: string;
  color: string;
  fill: string;
  hatch: string;
  multiplier: number;
  waste_pct: number;
  /** Wall height in feet — the canvas's H knob; surface_area = traced LF × this. */
  height_ft?: number;
  /** Roll-goods opt-in (#136): presence of a usable setup is what makes the
   * condition roll goods — material class + the packing engine's spec fields,
   * exactly the object the canvas persists (web/src/lib/rollTakeoff.js). */
  roll_setup?: Record<string, unknown>;
  materials: MaterialRow[];
}

/** Shape provenance (contribution.v2 vocabulary — mirrors the canvas +
 * web/src/lib/provenance.js). Truthfulness rules: `actor` is omitted for a
 * human at the canvas and "agent" for MCP/automation; `reviewed` is true ONLY
 * after a human affirmed the shape at an explicit review gate — this server
 * has no such gate, so everything it commits is reviewed: false. */
export interface ShapeOrigin {
  method: "manual" | "one_click_v1" | "agent_v1" | "symbol_sweep";
  /** Omitted = human. "agent" = the shape was produced by MCP/automation. */
  actor?: "agent";
  /** A human affirmed this shape at an explicit review gate. */
  reviewed?: boolean;
  /** one_click: the flood-fill seed, normalized to sheet dims. */
  seed_norm?: [number, number];
  hatch_filtered?: true;
  /** one_click: the seal ladder bridged a drafting pinhole this many px wide
   * to close the region (engine `gapBridged` — canvas parity: the rescue rides
   * provenance rather than passing itself off as a clean fill). */
  gap_bridged_px?: number;
  /** one_click (#85): the flood ran against a mask whose boundary was STATED
   * by the sheet's PDF layers (visible boundary/structure roles present) —
   * categorically stronger evidence than a pitch-heuristic boundary. */
  layer_bounded?: true;
  raster_traced?: true;
  fill_sensitivity?: number;
  /** derive_base (#148): this linear shape was derived from a floor shape's
   * perimeter — the source, the gross figure, and the openings the agent
   * STATED (its claim to make; the tool never guesses doors). */
  derived?: { from_shape_id: string; gross_lf: number; openings_lf: number };
  /** Where the shape's finish ASSIGNMENT came from (0.9.18): "schedule" =
   * resolved from the room's own schedule row (room_tag / surface /
   * schedule_sheet carry the citation), "asserted" = the agent chose the tag
   * itself. Stamped centrally in commit(), so no agent commit path can ship
   * without a verdict; human canvas commits carry nothing, mirroring the
   * `actor` convention. */
  assignment?: { source: "schedule" | "asserted"; room_tag?: string; surface?: string; schedule_sheet?: string };
  /** Machine's original trace, frozen on first human edit (provenance.js). */
  proposed_verts_norm?: [number, number][];
  edited?: boolean;
  edited_before_create?: boolean;
  copied?: boolean;
  /** Per-kind tally of human corrections (provenance.js). */
  edits?: Record<string, number>;
  /** How many times the AGENT revised its own shape (edit_shape). Deliberately
   * separate from `edited`/`edits`, which mean "a human corrected the machine"
   * — a machine correcting itself is a different event, and merging the two
   * would corrupt the correction signal the capture layer grades on. */
  agent_edits?: number;
  /** symbol_sweep: how this count marker matched the seed exemplar — the
   * evidence that made it a commit (score against the commit bar, and the
   * symmetry-group element it matched under). */
  symbol?: { score: number; rotation: number; mirrored: boolean };
}

export interface Shape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role: MeasureRole;
  verts_norm: [number, number][];
  /** count shapes carry {count} alone (canvas commitCount) — recompute skips
   * them, so they never grow area fields; every other role carries both. */
  computed: { area_sf?: number; perimeter_lf?: number; count?: number };
  /** surface_area only: the height this shape was quantified at (canvas
   * commitSurface snapshots the condition's H onto the shape). */
  height_ft?: number;
  origin?: ShapeOrigin;
}

/** An annotation — a note ABOUT the work, never a measurement of it.
 *
 *  Field-identical to the canvas's markup (web/src/pages/TakeoffCanvas.jsx), so
 *  what an agent writes here loads in the app unchanged and vice versa. Coords
 *  are NORMALIZED 0..1 of the sheet, matching shapes' verts_norm — the tools
 *  take image px and convert at the boundary, which is the same contract every
 *  other tool honours.
 *
 *  condition_id is what makes an annotation part of a scope rather than a
 *  floating note: it takes that condition's colour on canvas and in the marked
 *  set, and travels with it into the report (#112). "" means unattached, which
 *  is a legitimate state — a note about the sheet, not about a finish. */
export interface Markup {
  id: string;
  sheet_id: string;
  type: "cloud" | "text" | "callout" | "highlight" | "arrow" | "bubble" | "dimension";
  text: string;
  condition_id: string;
  rfi_id: string;
  at?: [number, number];
  target?: [number, number];
  rect?: [[number, number], [number, number]];
  /** arrow + dimension: the two endpoints, normalized like at/target. */
  from?: [number, number];
  to?: [number, number];
  /** bubble: radius normalized to sheet WIDTH (the canvas/marked-set frame —
   * uniform scale off width keeps the circle round on any page). */
  r?: number;
  /** dimension: the measured length in real feet, snapshotted at annotate
   * time from the sheet scale — the renderers (canvas, marked set) draw the
   * label from this, so neither needs scale plumbing of its own. */
  len_ft?: number;
  created_at?: string;
}

/** An approval-family record (web/src/lib/approvals.js, PR #176) — the record
 *  of a VERDICT, its own family beside shapes and markups. Two actors, one
 *  hard line: "estimator" is the human's APPROVED ring, minted only by the
 *  canvas's Approve tool — NO path through this server can produce one;
 *  "agent" is the AGENT diamond, the machine's pencil-signature on its own
 *  work, and the only actor mark_verdict is capable of writing. Rides the
 *  annotations payload additively (`approvals`), so it round-trips through
 *  export_takeoff/import_takeoff and the app's own saves unchanged. */
export interface Approval {
  id: string;
  actor: "estimator" | "agent";
  /** ISO-8601 mint time — optional on the type because the canvas load gate
   * (sanitizeApprovals) doesn't require it of imported records; everything
   * minted here carries it. */
  ts?: string;
  sheet_id: string;
  /** Render anchor, normalized to the sheet (the markup convention). The
   * glyph ALWAYS draws here, so a later shape delete never orphans it. */
  at: [number, number];
  /** Present when the verdict targets a committed shape — provenance (WHAT
   * was marked), never where it draws. */
  shape_id?: string;
  /** The agent's optional short note. Unknown fields pass the canvas load
   * gate verbatim, so it survives every round-trip. */
  text?: string;
}

/** The pure apply's command vocabulary (approvals.js) — what the journal
 * stores as the exact-restore inverse of a verdict mutation. */
export type ApprovalCommand =
  | { type: "add"; approvals: (Omit<Approval, "id"> & { id?: string })[]; restore?: boolean; at?: number[] }
  | { type: "delete"; ids: string[] };

// untyped canvas JS — typed facades state the contract at the boundary
// (the marked.ts/importing.ts convention)
export const sanitizeApprovals = sanitizeApprovalsJs as unknown as (raw: unknown) => Approval[];
const applyApprovalCommand = applyApprovalCommandJs as unknown as
  (approvals: Approval[], cmd: ApprovalCommand) => { approvals: Approval[]; inverse: ApprovalCommand };

interface SheetState {
  key: string;
  /** 1-based position in load order across ALL documents — what addresses
   * resources (#152: pageNum collides across files; ord never does, and for a
   * single document ord === pageNum so existing URIs are unchanged). */
  ord: number;
  pageNum: number;
  widthPt: number;
  heightPt: number;
  widthPx: number;
  heightPx: number;
  sheetNumber: string | null;
  detected: DetectedScale | null;
  /** real feet per image px at RENDER_SCALE; null until set_scale */
  upp: number | null;
  /** how the scale was set — report provenance (export_report scale_source),
   * canvas vocabulary: "standard" | "upp" | "calibrated" | "detected" */
  scaleSource?: string;
  text: { str: string; x: number; y: number }[];
  page: PageHandle;
  // lazy per-sheet caches (built once, reused by identity)
  geo?: VectorGeometry;
  snap?: ReturnType<typeof buildSnapGrid>;
  /** undefined = not built yet; null = sheet has zero vector segments (a scan) */
  mask?: MaskObj | null;
  /** raster-fallback mask (#154): the sheet's rendered pixels thresholded by
   * rastermask.ts — built on first raster-path flood, cached like `mask` */
  rmask?: MaskObj;
  /** rendered-page PNG at IMAGE_MAX_EDGE, built on first resource read */
  png?: Uint8Array;
  /** hatch-family instances (image px), built with geo on first sheet_context */
  hatch?: HatchFamily[];
  /** text as bbox spans (image px), built on first sheet_context */
  spans?: TextSpan[];
  /** the sheet's Optional Content layers (#85), classified — built with geo;
   * [] = no layers survived export (the silent, invisible fallback) */
  layers?: LayerInfo[];
}

/** sheet_context decimation defaults (issue #29) — declared and stable, never
 * adaptive: an agent that receives a silently-truncated geometry set measures
 * confidently and is wrong, so every reply carries the counts. */
export const CONTEXT_MIN_LEN_PX = 2.0;   // one PDF point at render scale 2.0 — below any pen width
export const CONTEXT_MAX_SEGMENTS = 4000; // cap, applied longest-first (walls survive, hatch strokes go)
export const CONTEXT_MAX_SEGMENTS_CEIL = 20000;

/** Does the segment intersect the axis-aligned rect? Liang–Barsky boolean —
 * endpoints untouched, this is a KEEP test, never a clip-and-rewrite. */
function segIntersectsRect(x1: number, y1: number, x2: number, y2: number, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  if (Math.max(x1, x2) < r.x0 || Math.min(x1, x2) > r.x1 || Math.max(y1, y2) < r.y0 || Math.min(y1, y2) > r.y1) return false;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - r.x0], [dx, r.x1 - x1], [-dy, y1 - r.y0], [dy, r.y1 - y1]] as [number, number][]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

const rectsOverlap = (a: [number, number, number, number], r: { x0: number; y0: number; x1: number; y1: number }): boolean =>
  a[0] <= r.x1 && a[2] >= r.x0 && a[1] <= r.y1 && a[3] >= r.y0;

/** Resource images cap their long edge here: the largest edge the mainstream
 * vision models take without downscaling — these renders exist to be looked at
 * by agents, so this is the native resolution of that audience. */
export const IMAGE_MAX_EDGE = 1568;

/** view_sheet's long-edge budget: small enough to stream comfortably, large
 * enough that a tight crop resolves dimension strings. */
export const VIEW_MIN_PX = 200;
export const VIEW_DEFAULT_PX = 1400;
export const VIEW_MAX_PX = 2000;

export interface SheetSummary {
  sheet: string;
  page: number;
  width_pt: number;
  height_pt: number;
  width_px: number;
  height_px: number;
  sheet_number?: string;
  detected_scale?: string;
}

/** Bounded gesture history, not an archive — mirrors the canvas's UNDO_CAP. */
export const UNDO_CAP = 100;

/** The agent-scoped command journal. Every mutation this server performs
 * records one entry carrying enough state to invert it exactly: a commit
 * removes by id, an edit restores the pre-edit shape verbatim, a delete
 * re-inserts at the recorded index. Undo is a true inverse, never an
 * approximation, so an agent that overshot can step back instead of
 * re-deriving a whole sheet.
 *
 * Scope, stated precisely: this is the MCP session's OWN history. It is not
 * the browser canvas's undo stack, nothing is shared between them, and
 * load_plan clears it along with the shapes its entries refer to.
 *
 * One entry per TOOL CALL, not per shape — undoing a detect_rooms sweep that
 * committed 18 rooms takes back the sweep, which is the gesture the agent
 * actually made. */
export type JournalPayload =
  | { op: "commit"; tool: string; ids: string[] }
  | { op: "edit"; tool: string; before: Shape }
  | { op: "delete"; tool: string; removed: { shape: Shape; index: number }[] }
  | { op: "materials"; tool: string; condition_id: string; before: MaterialRow[] }
  | { op: "condition"; tool: string; condition_id: string; before: { waste_pct: number; multiplier: number; height_ft?: number; roll_setup?: Record<string, unknown> } }
  | { op: "approval"; tool: string; inverse: ApprovalCommand };

export type JournalEntry = JournalPayload & { seq: number };

const sheetSummary = (s: SheetState): SheetSummary => ({
  sheet: s.key,
  page: s.pageNum,
  width_pt: s.widthPt,
  height_pt: s.heightPt,
  width_px: s.widthPx,
  height_px: s.heightPx,
  ...(s.sheetNumber ? { sheet_number: s.sheetNumber } : {}),
  ...(s.detected ? { detected_scale: s.detected.label } : {}),
});

export class Session {
  file: string | null = null;
  /** Absolute path of the PRIMARY (first-loaded) plan — the marked set's
   * default output lands beside it; per-file paths live in `docs`. */
  filePath: string | null = null;
  /** The working document set (#152), by basename — one entry per load_plan,
   * several under merge: true. Source paths ride along for byte re-reads. */
  private docs = new Map<string, { doc: DocHandle; path: string }>();
  private nextOrd = 1;
  private sheets = new Map<string, SheetState>();
  conditions: Condition[] = [];
  markups: Markup[] = [];
  shapes: Shape[] = [];
  /** Approval-family records (#176) — estimator seals arrive only by import;
   * agent verdicts mint through markVerdict and nothing else. */
  approvals: Approval[] = [];
  /** The last assign-from-schedule run's unresolved rooms (0.9.18) — what the
   * marked-set cover discloses as withheld. Replaced per assign run, cleared
   * with the rest of the session on a non-merge load_plan. Seeds ride
   * normalized so the export-time staleness drop can test them against
   * committed rings in verts_norm space. */
  scheduleWithheld: { sheet_id: string; label: string; reason: string; seed_norm: [number, number] }[] = [];

  /** Newest-last. Capped at UNDO_CAP; the oldest entry falls off the front. */
  private journal: JournalEntry[] = [];
  private seq = 0;
  /** Ids minted by commit() since the last flush — one tool call may commit
   * many shapes (detect_rooms), and they journal as a single reversible step. */
  private pendingCommits: string[] = [];

  private record(entry: JournalPayload): void {
    this.journal.push({ ...entry, seq: ++this.seq });
    if (this.journal.length > UNDO_CAP) this.journal.shift();
  }

  /** Journal whatever commit() minted during this tool call, as one entry.
   * A call that committed nothing records nothing — undo steps over reads. */
  private flushCommits(tool: string): void {
    if (!this.pendingCommits.length) return;
    this.record({ op: "commit", tool, ids: this.pendingCommits });
    this.pendingCommits = [];
  }

  /** load_plan (#152): without merge, replaces the whole session — every doc
   * destroyed, ALL state (scales, caches, conditions, shapes) cleared. With
   * merge: true, ADDS a document to the working set — a bid set is plans +
   * schedule + addenda, not one PDF — keeping every scale, condition, and
   * shape already in the session. Sheet keys already carry file names
   * (plan.pdf, plan.pdf#2), so two documents never collide; loading the SAME
   * file again under merge is refused (an addendum is a new file — reloading
   * one in place is a replace-the-session decision, not a merge). */
  async loadPlan(filePath: string, opts: { merge?: boolean } = {}) {
    const base = path.basename(filePath);
    const merging = !!opts.merge && this.docs.size > 0;   // merge into empty = plain first load
    if (!merging) {
      for (const d of this.docs.values()) await d.doc.destroy().catch(() => {});
      this.docs.clear();
      this.sheets.clear();
      this.conditions = [];
      this.shapes = [];
      this.markups = [];
      this.approvals = [];
      this.file = null;
      this.filePath = null;
      this.nextOrd = 1;
      this.scheduleWithheld = [];
      // the journal's entries reference shapes that no longer exist — undoing
      // across a document swap would be a lie, so the history goes with them
      this.journal = [];
      this.pendingCommits = [];
    } else if (this.docs.has(base)) {
      throw new UserError(`${base} is already loaded — merge adds NEW documents. To reload it, call load_plan without merge (replaces the whole session).`);
    }
    this.graph = null;   // the sheet graph (#87) indexes the OLD document set

    const doc = await openPdf(filePath);
    const resolved = path.resolve(filePath);
    this.docs.set(base, { doc, path: resolved });
    if (!this.file) { this.file = base; this.filePath = resolved; }
    const added: SheetSummary[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const ph = await doc.page(n);
      // sheet-key codec: page 1 = bare file name, pages 2+ = "name#page"
      // (parseSheetKey in web/src/lib/sheets.ts is the inverse)
      const key = n === 1 ? base : `${base}#${n}`;
      const state: SheetState = {
        key,
        ord: this.nextOrd++,
        pageNum: n,
        widthPt: ph.widthPt,
        heightPt: ph.heightPt,
        widthPx: ph.viewport.width,
        heightPx: ph.viewport.height,
        sheetNumber: extractSheetNumber(ph.textContent, ph.viewport),
        detected: detectScale(ph.textContent, ph.viewport),
        upp: null,
        text: positionedText(ph),
        page: ph,
      };
      this.sheets.set(key, state);
      added.push(sheetSummary(state));
    }
    return {
      file: base,
      files: this.files,
      page_count: this.sheets.size,
      sheets: [...this.sheets.values()].map(sheetSummary),
      note: merging
        ? `Merged ${base} into the working set (${added.length} sheet${added.length === 1 ? "" : "s"} added) — every prior scale, condition, and shape kept. The sheet graph now spans ${this.docs.size} documents.`
        : "Replaced the previous session — all prior scales, conditions, and shapes were cleared.",
    };
  }

  /** Every loaded document's basename, load order. */
  get files(): string[] {
    return [...this.docs.keys()];
  }

  /** The file (basename) a sheet key belongs to — the key codec's inverse. */
  fileFor(sheetKey: string): string {
    return sheetKey.split("#")[0];
  }

  /** Absolute source path for a loaded file — the marked set re-reads bytes. */
  pathFor(file: string): string | null {
    return this.docs.get(file)?.path ?? null;
  }

  sheet(name: string): SheetState {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    const hit = this.sheets.get(name);
    if (hit) return hit;
    // convenience: accept the title-block sheet number (e.g. "A-101") too
    const wanted = name.toUpperCase().replace(/\s+/g, "");
    for (const s of this.sheets.values()) if (s.sheetNumber === wanted) return s;
    throw new UserError(`Unknown sheet "${name}" — loaded sheets: ${[...this.sheets.keys()].join(", ")}.`);
  }

  /** Like sheet(), but null for an unknown key — import adoption iterates
   * merged rows that may reference files this document doesn't have. */
  sheetOrNull(name: string): SheetState | null {
    return this.sheets.get(name) ?? null;
  }

  /** Journal an externally-assembled commit gesture (import_takeoff) as one
   * reversible step — the same entry shape commit()+flushCommits() writes. */
  journalCommit(tool: string, ids: string[]): void {
    this.record({ op: "commit", tool, ids });
  }

  /** Resource-URI addressing: 1-based position in load order across every
   * loaded document (=== page number for a single-document session). */
  sheetForPage(ord: number): SheetState {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    const hit = this.sheetList()[ord - 1];
    if (!hit) throw new UserError(`No sheet ${ord} — the working set has sheets 1–${this.sheets.size}.`);
    return hit;
  }

  /** Every loaded sheet, in page order — [] before any plan loads. */
  sheetList(): SheetState[] {
    return [...this.sheets.values()].sort((a, b) => a.ord - b.ord);
  }

  /** The takeoff://sheets index payload — cheap (no geometry is built). */
  index() {
    if (!this.docs.size) {
      return { file: null, page_count: 0, sheets: [], hint: "No plan loaded — call the load_plan tool with a PDF path, then list resources again." };
    }
    return {
      file: this.file,
      files: this.files,
      page_count: this.sheets.size,
      sheets: this.sheetList().map((s) => ({
        ...sheetSummary(s),
        ord: s.ord,
        scale_set: s.upp != null,
        shape_count: this.shapes.filter((x) => x.sheet_id === s.key).length,
      })),
    };
  }

  /** Rendered-page PNG, long edge capped at IMAGE_MAX_EDGE (never above the
   * canvas-native RENDER_SCALE), cached per sheet until the next load_plan. */
  async renderSheetPng(ord: number): Promise<Uint8Array> {
    const s = this.sheetForPage(ord);
    if (!s.png) {
      const scale = Math.min(RENDER_SCALE, IMAGE_MAX_EDGE / Math.max(s.widthPt, s.heightPt));
      s.png = await s.page.renderPng(scale);
    }
    return s.png;
  }

  /** view_sheet: render a sheet (or an image-px crop of it) to PNG, with an
   * optional committed-shapes overlay and calibrated measuring grid. The grid
   * draws under the overlay, both in canvas space after the page rasterizes. */
  async viewSheet(name: string, opts: { region?: { x0: number; y0: number; x1: number; y1: number }; px?: number; overlay?: boolean; grid?: string }) {
    const s = this.sheet(name);
    const px = Math.max(VIEW_MIN_PX, Math.min(VIEW_MAX_PX, Math.round(opts.px ?? VIEW_DEFAULT_PX)));
    const clampX = (v: number) => Math.max(0, Math.min(v, s.widthPx));
    const clampY = (v: number) => Math.max(0, Math.min(v, s.heightPx));
    const r = opts.region
      ? { x0: clampX(opts.region.x0), y0: clampY(opts.region.y0), x1: clampX(opts.region.x1), y1: clampY(opts.region.y1) }
      : { x0: 0, y0: 0, x1: s.widthPx, y1: s.heightPx };
    if (!(r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1)) {
      throw new UserError(`Empty view region — need x1 > x0 and y1 > y0 in image px inside the sheet (${s.widthPx} × ${s.heightPx}).`);
    }
    const ppf = gridPxPerFoot(opts.grid, s.upp);
    const sheetShapes = this.shapes.filter((x) => x.sheet_id === s.key);
    const { png, width, height, zoom } = await s.page.renderRegionPng(r, px, (ctx, toCanvas) => {
      if (ppf) drawGrid(ctx as Ctx2D, toCanvas as ToCanvas, r, ppf);
      if (opts.overlay) drawShapes(ctx as Ctx2D, toCanvas as ToCanvas, sheetShapes, s.widthPx, s.heightPx, px);
    });
    return {
      png,
      meta: {
        sheet: s.key,
        page: s.pageNum,
        sheet_px: [s.widthPx, s.heightPx],
        region: [round1(r.x0), round1(r.y0), round1(r.x1), round1(r.y1)],
        img_px: [width, height],
        zoom: +zoom.toFixed(4),
        overlay: !!opts.overlay,
        ...(opts.overlay ? { shapes_drawn: sheetShapes.length } : {}),
        grid_px_per_foot: ppf ? round2(ppf) : 0,
      },
    };
  }

  /** sheet_context (issue #29): the classified vectors, the positioned text,
   * and the hatch-family instances of ONE region, in ONE frame — image px,
   * the space every other tool already speaks. There is deliberately no
   * transform in this method: everything below is a containment test against
   * a rect, so frame agreement with view_sheet is a contract on the echoed
   * region, not on a second renderer.
   *
   * Decimation is declared and ordered (issue #29 design comment): clip to
   * region → drop segments shorter than min_len_px → cap at max_segments
   * LONGEST-FIRST (walls are long, hatch strokes are short — truncation
   * degrades toward structure). Whole segments drop with their meta intact;
   * nothing is simplified or merged, because these are CLASSIFIED segments
   * and a merge would silently rewrite the classification. The counts ride
   * on every reply, truncated or not. */
  async sheetContext(name: string, opts: { region?: { x0: number; y0: number; x1: number; y1: number }; min_len_px?: number; max_segments?: number }) {
    const s = this.sheet(name);
    const clampX = (v: number) => Math.max(0, Math.min(v, s.widthPx));
    const clampY = (v: number) => Math.max(0, Math.min(v, s.heightPx));
    const r = opts.region
      ? { x0: clampX(opts.region.x0), y0: clampY(opts.region.y0), x1: clampX(opts.region.x1), y1: clampY(opts.region.y1) }
      : { x0: 0, y0: 0, x1: s.widthPx, y1: s.heightPx };
    if (!(r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1)) {
      throw new UserError(`Empty context region — need x1 > x0 and y1 > y0 in image px inside the sheet (${s.widthPx} × ${s.heightPx}).`);
    }
    const minLen = opts.min_len_px ?? CONTEXT_MIN_LEN_PX;
    const cap = opts.max_segments ?? CONTEXT_MAX_SEGMENTS;

    const geo = await this.ensureGeometry(s);
    const hasVectors = geo.segs.length > 0;
    if (!s.hatch) s.hatch = hasVectors ? hatchFamilies(geo.segs, geo.meta) : [];
    if (!s.spans) s.spans = textSpans(s.page);

    // family membership index → id, for the per-segment annotation
    const famBySeg = new Map<number, string>();
    for (const f of s.hatch) for (const i of f.memberIdx) famBySeg.set(i, f.id);

    // 1. clip to region (keep test, endpoints untouched)
    const inRegion: { i: number; len: number }[] = [];
    const nSeg = geo.segs.length >> 2;
    for (let i = 0; i < nSeg; i++) {
      const x1 = geo.segs[i * 4], y1 = geo.segs[i * 4 + 1], x2 = geo.segs[i * 4 + 2], y2 = geo.segs[i * 4 + 3];
      if (segIntersectsRect(x1, y1, x2, y2, r)) inRegion.push({ i, len: Math.hypot(x2 - x1, y2 - y1) });
    }
    // 2. drop invisible ink
    const visible = inRegion.filter((e) => e.len >= minLen);
    const droppedShort = inRegion.length - visible.length;
    // 3. cap, longest-first
    let kept = visible;
    let droppedCap = 0;
    if (visible.length > cap) {
      kept = visible.slice().sort((a, b) => b.len - a.len).slice(0, cap);
      droppedCap = visible.length - cap;
    }

    const segments: number[][] = [], metaOut: number[] = [], family: (string | null)[] = [];
    for (const { i } of kept) {
      segments.push([
        round1(geo.segs[i * 4]), round1(geo.segs[i * 4 + 1]),
        round1(geo.segs[i * 4 + 2]), round1(geo.segs[i * 4 + 3]),
      ]);
      metaOut.push(geo.meta[i]);
      family.push(famBySeg.get(i) ?? null);
    }

    const spans = s.spans.filter((sp) => sp.x0 <= r.x1 && sp.x1 >= r.x0 && sp.y0 <= r.y1 && sp.y1 >= r.y0);
    const keptIdx = new Set(kept.map((k) => k.i));
    const families = s.hatch
      .filter((f) => rectsOverlap(f.bbox, r))
      .map(({ memberIdx, ...f }) => ({
        ...f,
        segments_in_region: memberIdx.reduce((acc, i) => acc + (keptIdx.has(i) ? 1 : 0), 0),
      }));

    return {
      sheet: s.key,
      page: s.pageNum,
      sheet_px: [s.widthPx, s.heightPx],
      region: [round1(r.x0), round1(r.y0), round1(r.x1), round1(r.y1)],
      has_vector_linework: hasVectors,
      vectors: {
        segments, meta: metaOut, family,
        kept: kept.length,
        total_in_region: inRegion.length,
        truncated: droppedShort + droppedCap > 0,
        dropped: { short: droppedShort, cap: droppedCap },
        ...(droppedCap > 0 ? { note: `Region exceeds max_segments — the ${droppedCap} SHORTEST segments were dropped, so structure (walls) survives and fill (hatch) goes first. Narrow the region or raise max_segments for the full set.` } : {}),
      },
      text: { spans, count: spans.length },
      hatch: { families, count: families.length },
    };
  }

  private async ensureGeometry(s: SheetState): Promise<VectorGeometry> {
    if (!s.geo) {
      const opList = await s.page.operatorList();
      s.geo = extractVectorGeometry(opList, s.page.viewport.transform, OPS);
      s.snap = buildSnapGrid(s.geo.points, SNAP_CELL);
      // classify this sheet's Optional Content layers (#85): the doc declares
      // id → (name, default visibility); the geometry attributes segments; the
      // pure normalizer states each layer's ROLE. Only layers that actually
      // own segments on this sheet are reported — an empty table is the
      // unlayered case and every consumer falls through to the heuristics.
      const layerIds = s.geo.layerIds || [];
      if (layerIds.length && this.docs.size) {
        const owner = this.docs.get(this.fileFor(s.key));
        const byId = new Map(owner ? (await owner.doc.layers()).map((g) => [g.id, g] as const) : []);
        const counts = new Map<number, number>();
        const lo = s.geo.layerOf;
        if (lo) for (let i = 0; i < lo.length; i++) if (lo[i] >= 0) counts.set(lo[i], (counts.get(lo[i]) || 0) + 1);
        s.layers = layerIds.map((id, k) => {
          const g = byId.get(id);
          const name = g?.name || "";
          const { role, confidence } = classifyLayerName(name);
          return { id, name, role, confidence, visible: g ? g.visible : true, seg_count: counts.get(k) || 0 };
        });
      } else {
        s.layers = [];
      }
    }
    return s.geo;
  }

  /** Per-layer role codes for buildMask (#85), with optional include/exclude
   * OVERRIDES (by layer name or id, case-insensitive): include forces hard
   * boundary, exclude drops the layer outright — the agent's judgment beats
   * the table's. Unknown names error with the sheet's actual layer list
   * (resolve-or-error, never a silent no-op). */
  private rolesFor(s: SheetState, geo: VectorGeometry, layersOpt?: { include?: string[]; exclude?: string[] }): Uint8Array | null {
    const infos = s.layers || [];
    if (!infos.length || !geo.layerIds?.length) {
      if (layersOpt && (layersOpt.include?.length || layersOpt.exclude?.length)) {
        throw new UserError(`${s.key} has no PDF layers (no Optional Content survived export) — layers.include/exclude can't apply here.`);
      }
      return null;
    }
    const infoById = new Map(infos.map((l) => [l.id, { role: l.role, visible: l.visible }]));
    if (layersOpt) {
      const resolve = (ref: string): LayerInfo => {
        const needle = ref.trim().toLowerCase();
        const hit = infos.find((l) => l.id.toLowerCase() === needle || l.name.toLowerCase() === needle);
        if (!hit) throw new UserError(`No layer ${JSON.stringify(ref)} on ${s.key}. Layers: ${infos.map((l) => l.name || l.id).join(" | ")}`);
        return hit;
      };
      for (const ref of layersOpt.include || []) { const l = resolve(ref); infoById.set(l.id, { role: "boundary", visible: true }); }
      for (const ref of layersOpt.exclude || []) { const l = resolve(ref); infoById.set(l.id, { role: l.role, visible: false }); }
    }
    return segRoles(geo.layerOf, layerRoleCodes(geo.layerIds, infoById));
  }

  /** v1 masks come from the sheet's vector linework only; a scanned sheet
   * (zero segments) is null here and the measuring tools fall back to
   * ensureRasterMask (#154). Layer roles (#85) ride in as the stated
   * short-circuit; an unlayered sheet builds the identical pre-#85 mask. */
  async ensureMask(name: string): Promise<MaskObj | null> {
    const s = this.sheet(name);
    if (s.mask === undefined) {
      const geo = await this.ensureGeometry(s);
      s.mask = geo.segs.length ? buildMask(geo.segs, s.widthPx, s.heightPx, MASK_MAX_DIM, geo.meta, this.rolesFor(s, geo)) : null;
    }
    return s.mask;
  }

  /** The mask honoring per-call layer overrides — a fresh build when overrides
   * are given (never cached: the default mask stays authoritative), the cached
   * default otherwise. */
  async maskWithLayers(name: string, layersOpt?: { include?: string[]; exclude?: string[] }): Promise<MaskObj | null> {
    if (!layersOpt || (!layersOpt.include?.length && !layersOpt.exclude?.length)) return this.ensureMask(name);
    const s = this.sheet(name);
    const geo = await this.ensureGeometry(s);
    if (!geo.segs.length) return null;
    return buildMask(geo.segs, s.widthPx, s.heightPx, MASK_MAX_DIM, geo.meta, this.rolesFor(s, geo, layersOpt));
  }

  /** The raster-fallback mask (#154): a dedicated render of the sheet at mask
   * scale (the view_sheet machinery — pdf.ts + @napi-rs/canvas), thresholded
   * by the canvas's own rastermask engine into the same MaskObj shape
   * buildMask emits, so floodRegion/traceRegion run unchanged on scans.
   * Cached per sheet like geo/mask; where the optional native canvas never
   * installed, renderRgba throws its plain install-hint Error and the tool
   * reply carries it — a stated inability, never a guessed polygon. */
  private async ensureRasterMask(s: SheetState): Promise<MaskObj> {
    if (!s.rmask) {
      const ws = Math.min(1, MASK_MAX_DIM / Math.max(s.widthPx, s.heightPx, 1));
      const mw = Math.max(2, Math.ceil(s.widthPx * ws));
      const mh = Math.max(2, Math.ceil(s.heightPx * ws));
      const rgba = await s.page.renderRgba(RENDER_SCALE * ws, mw, mh);
      s.rmask = buildRasterMask(rgba, mw, mh, ws);
    }
    return s.rmask;
  }

  /** The canvas's trigger policy (#154), verbatim (TakeoffCanvas.jsx /
   * rastermask.ts constants): raster-ELIGIBLE = placed-image area covers
   * ≥ RASTER_MIN_IMG_FRAC of the sheet (a scan wrapper or photo underlay);
   * vector-VIABLE = enough segments that the vector mask can bound rooms.
   * Vector is exact and always wins where it works — a pure-vector sheet
   * never touches pixels; a scan wrapper with near-zero linework runs raster
   * primary; a mixed sheet retries on pixels only after the vector flood
   * fails. */
  private rasterPolicy(s: SheetState, geo: VectorGeometry): { rasterEligible: boolean; vectorViable: boolean } {
    const sheetArea = s.widthPx * s.heightPx;
    return {
      rasterEligible: sheetArea > 0 && geo.imageArea / sheetArea >= RASTER_MIN_IMG_FRAC,
      vectorViable: (geo.segs.length >> 2) >= RASTER_MIN_SEGS,
    };
  }

  /** Layer overrides (#85) name PDF Optional Content — scan pixels carry
   * none, so a raster-path call that stated them is refused rather than
   * silently no-opped (the rolesFor resolve-or-error doctrine). */
  private refuseLayersOnRaster(layersOpt?: { include?: string[]; exclude?: string[] }): void {
    if (layersOpt && (layersOpt.include?.length || layersOpt.exclude?.length)) {
      throw new UserError("Layer overrides can't apply here — this flood runs on the sheet's rendered pixels (raster fallback), and scan ink carries no PDF layers. Retry without layers.");
    }
  }

  async sheetInfo(name: string) {
    const s = this.sheet(name);
    const geo = await this.ensureGeometry(s);
    return {
      ...sheetSummary(s),
      seg_count: geo.segs.length >> 2,
      has_vector_linework: geo.segs.length > 0,
      scale_set: s.upp != null,
      ...(s.upp != null ? { upp: s.upp } : {}),
      ...(s.detected?.multi ? { multiple_scales: true as const } : {}),
      shape_count: this.shapes.filter((x) => x.sheet_id === s.key).length,
      // the sheet's PDF layer table (#85) — always emitted; [] = no Optional
      // Content survived export and every engine path runs the heuristics
      layers: (s.layers || []).map((l) => ({ id: l.id, name: l.name, role: l.role, confidence: l.confidence, visible: l.visible, seg_count: l.seg_count })),
    };
  }

  private scaleGate(s: SheetState): string {
    return `Set the scale for ${s.key} first — use set_scale${s.detected ? ` (detected: ${s.detected.label})` : ""}.`;
  }

  setScale(name: string, mode: { label?: string; upp?: number; calibrate?: { p1: [number, number]; p2: [number, number]; feet: number }; use_detected?: boolean }) {
    const s = this.sheet(name);
    let upp: number;
    let label: string | undefined;
    let source: string;
    if (mode.label !== undefined) {
      const sc = STANDARD_SCALES.find((x) => x.label === mode.label);
      if (!sc) throw new UserError(`Unknown scale label ${JSON.stringify(mode.label)}. Valid labels: ${STANDARD_SCALES.map((x) => x.label).join(" | ")}`);
      upp = sc.upp;
      label = sc.label;
      source = "label";
    } else if (mode.upp !== undefined) {
      if (!(mode.upp > 0)) throw new UserError("upp must be a positive number (real feet per image px at render scale 2.0).");
      upp = mode.upp;
      source = "upp";
    } else if (mode.calibrate !== undefined) {
      const { p1, p2, feet } = mode.calibrate;
      const px = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (!(px > 0)) throw new UserError("Calibration points are identical — click two points along a known dimension.");
      if (!(feet > 0)) throw new UserError("Calibration feet must be positive.");
      upp = feet / px;
      source = "calibrate";
    } else if (mode.use_detected) {
      if (!s.detected) throw new UserError(`No detected scale for ${s.key} — read the title block with read_sheet_text, or calibrate from a known dimension.`);
      upp = s.detected.upp;
      label = s.detected.label;
      source = "detected";
    } else {
      throw new UserError("Provide exactly one of: label, upp, calibrate, use_detected.");
    }
    s.upp = upp;
    // the tool reply keeps this session's source vocabulary; the stored value
    // uses the canvas's report vocabulary so export_report's scale_source
    // reads the same as an app-side report.v1
    s.scaleSource = source === "label" ? "standard" : source === "calibrate" ? "calibrated" : source;
    return {
      sheet: s.key, upp, ...(label ? { label } : {}), source,
      // #153 — several DISTINCT scale notes on one sheet means enlarged plans
      // or details are likely; region measurements will warn when a
      // disagreeing note sits inside them, but say it up front too
      ...(s.detected?.multi ? { warning: "This sheet carries MULTIPLE distinct scale notes — enlarged plans/details likely. Measurements inside a viewport whose note disagrees with this scale will carry a warning; calibrate or re-set_scale before trusting them." } : {}),
    };
  }

  /** Mixed-scale check (#153): does the measured region carry a scale note
   * that DISAGREES with the scale these quantities were figured at? Runs the
   * sheet-level detector on a region-filtered text set — same detector, no
   * second regex. Returns the warning to ride the reply, or undefined. */
  private scaleWarningFor(s: SheetState, ptsPx: Point[]): string | undefined {
    if (s.upp == null || !ptsPx.length) return undefined;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ptsPx) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const region = expandForScaleNotes({ x0, y0, x1, y1 });
    const adoptedLabel = s.detected && Math.abs(s.detected.upp - s.upp) / s.upp <= 1e-6 ? s.detected.label : undefined;
    return mixedScaleWarning(textItemsInRegion(s.page, region), s.page.viewport, s.upp, adoptedLabel);
  }

  private conditionFor(tag: string): Condition {
    let c = this.conditions.find((x) => x.finish_tag === tag);
    if (!c) {
      // field-identical to the canvas's addCondition, palette rotation included
      const lc = PALETTE[this.conditions.length % PALETTE.length];
      c = {
        id: uid("cnd"),
        finish_tag: tag,
        color: lc,
        fill: lc,
        hatch: HATCH_IDS[1 + (this.conditions.length % (HATCH_IDS.length - 1))],
        multiplier: 1,
        waste_pct: 0,
        materials: [],
      };
      this.conditions.push(c);
    }
    return c;
  }

  private commit(s: SheetState, tag: string, role: MeasureRole, vertsPx: Point[], computed: Shape["computed"], origin?: Shape["origin"]): Shape {
    // assignment provenance (0.9.18) defaults HERE, not at the seven call
    // sites: an agent commit that stated no source asserted the tag itself,
    // and stamping centrally means no future commit path can ship unstamped.
    if (origin?.actor === "agent" && !origin.assignment) origin = { ...origin, assignment: { source: "asserted" } };
    const c = this.conditionFor(tag);
    const shape: Shape = {
      id: uid("shp"),
      sheet_id: s.key,
      condition_id: c.id,
      measure_role: role,
      verts_norm: vertsPx.map(([x, y]) => [x / s.widthPx, y / s.heightPx]),
      computed,
      ...(origin ? { origin } : {}),
    };
    this.shapes.push(shape);
    this.pendingCommits.push(shape.id);
    return shape;
  }

  async oneClick(name: string, x: number, y: number, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean; sensitivity?: number; layers?: { include?: string[]; exclude?: string[] } }) {
    const s = this.sheet(name);
    // Trigger policy — canvas parity (#154, see rasterPolicy): vector first
    // wherever it can work, raster only where it can't; the vector path below
    // is byte-identical to the pre-#154 behavior on any pure-vector sheet.
    const { rasterEligible, vectorViable } = this.rasterPolicy(s, await this.ensureGeometry(s));
    let f: Extract<FloodResult, { status: "ok" }> | null = null;
    let raster = false;
    if (!rasterEligible || vectorViable) {
      const mask = await this.maskWithLayers(name, opts.layers);
      if (!mask && !rasterEligible) throw new UserError("This sheet has no vector linework and no scan image to flood — nothing here bounds a region. Trace the space with measure_polygon instead.");
      if (mask) {
        const r = floodRegion(mask, x, y, opts.sensitivity ?? SENS_BALANCED);
        if (r.status === "ok") f = r;
        else if (!rasterEligible) {
          if (r.status === "leak") throw new UserError("That space isn't enclosed on the plan linework — the fill spilled through a gap or opening.");
          throw new UserError("Landed in dense linework (hatching or text).");
        }
      }
    }
    if (!f) {
      // Raster fallback (#154): flood the sheet's rendered pixels with the
      // canvas's own engine. The raster mask is single-tier (softCount 0), so
      // floodRegion's hatch escalation — and the sensitivity knob with it —
      // is structurally inert here; no sensitivity is passed.
      this.refuseLayersOnRaster(opts.layers);
      const rmask = await this.ensureRasterMask(s);
      const r = floodRegion(rmask, x, y);
      if (r.status === "leak") throw new UserError("That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Seed a more enclosed spot, or trace it with measure_polygon.");
      if (r.status !== "ok") throw new UserError("Landed on dense scan ink (text or hatching). Seed an open spot inside the room.");
      f = r;
      raster = true;
    }
    // Raster trace differences, canvas parity: a looser RDP eps (scan
    // contours wobble) and NO vertex snapping — a scan has no true endpoints,
    // and pulling room corners onto the title block's few vector endpoints
    // would corrupt the ring.
    const ring = raster
      ? traceRegion(f, RASTER_RDP_EPS)
      : snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
    if (ring.length < 3) throw new UserError("Couldn't trace that space into a polygon.");
    const areaPx2 = ringArea(ring);
    const perimPx = closedMetrics(ring).perim;
    const common = {
      status: "ok" as const,
      nverts: ring.length,
      ...(f.hatchFiltered ? { hatch_filtered: true } : {}),
      ...(f.gapBridged ? { gap_bridged_px: f.gapBridged } : {}),
      // which path ran, disclosed both ways (#154): present = pixels bounded
      // this trace, absent = the vector linework did
      ...(raster ? { raster_traced: true as const } : {}),
      ...(opts.returnVerts ? { verts: ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
    };
    if (s.upp == null) {
      // preview only — px quantities, never committed without a scale
      return {
        ...common,
        area_px2: round1(areaPx2),
        perimeter_px: round1(perimPx),
        warning: `No scale set for ${s.key} — quantities unavailable. Call set_scale${s.detected ? ` (detected: ${s.detected.label})` : ""}.`,
      };
    }
    const upp = s.upp;
    const area_sf = round2(areaPx2 * upp * upp);
    const perimeter_lf = round2(perimPx * upp);
    let shape_id: string | undefined;
    if (opts.condition) {
      // actor + reviewed: false — this is a machine-proposed trace no human
      // has affirmed; only an explicit human review gate may set reviewed.
      shape_id = this.commit(s, opts.condition, opts.role, ring, { area_sf, perimeter_lf }, {
        method: "one_click_v1",
        actor: "agent",
        seed_norm: [x / s.widthPx, y / s.heightPx],
        reviewed: false,
        ...(f.hatchFiltered ? { hatch_filtered: true as const } : {}),
        ...(f.gapBridged ? { gap_bridged_px: f.gapBridged } : {}),
        // #154 — a trace whose boundary was scan PIXELS is a different claim
        // than one bounded by vector linework; the record says which (the
        // canvas's raster_traced vocabulary, contribution.v2)
        ...(raster ? { raster_traced: true as const } : {}),
        // #85 — a trace bounded by DECLARED boundary layers is categorically
        // stronger evidence than one bounded by a pitch heuristic (vector
        // path only: the raster mask never saw the layer table)
        ...(!raster && (s.layers || []).some((l) => l.visible && (l.role === "boundary" || l.role === "structure")) ? { layer_bounded: true as const } : {}),
        // canvas-parity provenance: a non-default fill sensitivity is part of
        // how the shape was made (ShapeOrigin.fill_sensitivity) — vector path
        // only; the knob is inert on a single-tier raster mask
        ...(!raster && opts.sensitivity !== undefined && opts.sensitivity !== SENS_BALANCED ? { fill_sensitivity: opts.sensitivity } : {}),
      }).id;
    }
    this.flushCommits("one_click");
    const mixed = this.scaleWarningFor(s, ring);
    return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id } : {}), ...(mixed ? { warning: mixed } : {}) };
  }

  /** Batch room detection: read every room-number label off the sheet's text
   *  layer, seed the existing One-Click flood at each, and trace/commit
   *  exactly like oneClick — just N of them from one call instead of N
   *  reasoning-heavy round-trips. Same contract as oneClick: no scale → a
   *  px-only preview per room; no condition → nothing commits (a review
   *  pass, not a proposal-acceptance gate — this server has none).
   *
   *  Withholding — nothing is committed until it survives all three, and the
   *  batch NEVER silently drops work: every withheld seed is counted and
   *  reasoned in `withheld`, because a room the tool knows it skipped is a
   *  question the caller can ask, while a room it skipped silently is a hole
   *  in a bid.
   *    1. degenerate — traced to fewer than 3 vertices.
   *    2. duplicate — two labels flooding one region (a room tagged twice, or
   *       a legend number landing in the same space) trace to an identical
   *       ring. Committing both double-counts the area with no signal, which
   *       is the worst failure mode an estimating tool has. One region commits
   *       once; the collapsed labels ride along on `merged_labels`.
   *    3. bubble — plans draw room numbers inside little boxes, and a seed at
   *       the label floods the label's own BUBBLE: fully enclosed, traces
   *       clean at label size, and is not a room (found live: 25 of 26). Each
   *       label runs a SEED LADDER (anchor first, then label-height offsets)
   *       and bubble rings are rejected scale-free (ring bbox ≈ label bbox) —
   *       so the guard holds even before any scale is set. A label whose
   *       every clean flood was its bubble counts here.
   *    4. implausible — enclosed, clean, non-bubble, and still smaller than
   *       `minAreaSf` (default 5 SF — smaller than any real finished space; a
   *       broom closet is ~10 SF): a door swing or wall cavity. Only applied
   *       once a scale exists, since without one there is no real area to
   *       judge and nothing commits anyway. */
  async detectRooms(name: string, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean; minAreaSf?: number; sensitivity?: number; layers?: { include?: string[]; exclude?: string[] }; assignFromSchedule?: boolean }) {
    const s = this.sheet(name);
    // assign-from-schedule (0.9.18): each detected room commits under the
    // FLOOR finish its OWN schedule row states, and rooms the schedule cannot
    // answer for are withheld into `unresolved[]` instead of committed under a
    // guess. The mode exists to COMMIT, so the whole-set preflights refuse up
    // front — before a single flood; per-room failures stay per-room below.
    const assign = !!opts.assignFromSchedule;
    let graph: SheetGraph | null = null;
    if (assign) {
      if (s.upp == null) throw new UserError(this.scaleGate(s));   // no silent px-only preview wearing a success reply
      graph = await this.ensureGraph();
      if (!graph.available) throw new UserError("This set has no text layer (a scan) — the sheet graph is unavailable, not empty.");
      if (!graph.tables.some((t) => t.kind === "room-finish")) {
        throw new UserError("No room-finish schedule in the working set — load_plan the schedule sheet with merge: true, or pass condition to commit every room under one tag.");
      }
    }
    // Mask resolution (#154) — one mask for the whole sweep, canvas trigger
    // policy (rasterPolicy): vector wherever it can bound rooms, raster only
    // where it can't (an OCR'd scan has a text layer to seed from but no
    // linework to flood). Deliberately NO per-seed vector→raster retry: a
    // batch that mixed boundary sources within one sweep would commit rings
    // whose provenance disagrees on what bounded them.
    const geo = await this.ensureGeometry(s);
    const { rasterEligible, vectorViable } = this.rasterPolicy(s, geo);
    let mask: MaskObj | null = null;
    let raster = false;
    if (!rasterEligible || vectorViable) mask = await this.maskWithLayers(name, opts.layers);
    if (!mask) {
      if (!rasterEligible) throw new UserError("This sheet has no vector linework and no scan image to flood — nothing here bounds a region. Trace rooms with measure_polygon instead.");
      this.refuseLayersOnRaster(opts.layers);
      mask = await this.ensureRasterMask(s);
      raster = true;
    }
    const minAreaSf = opts.minAreaSf ?? 5;
    if (!s.spans) s.spans = textSpans(s.page);
    // labels with BBOXES: same tokenization as roomLabelSeeds, but the ladder
    // and the bubble test need the label's box, not just its anchor
    const labels: { str: string; bbox: LabelBBox }[] = [];
    for (const sp of s.spans) {
      const num = (sp.str || "").trim().split(/\s+/).find((tok) => ROOM_LABEL_RE.test(tok));
      if (num) labels.push({ str: num, bbox: sp });
    }

    // Trace every label first (ladder + bubble guard per label). Nothing
    // commits in this pass — withholding has to be decided across the whole
    // batch (dedupe needs to see every ring).
    const withheld = { degenerate: 0, duplicate: 0, bubble: 0, implausible: 0, unresolved: 0 };
    const unresolved: { label: string; reason: string; area_sf: number; perimeter_lf: number; seed: [number, number] }[] = [];
    type Cand = { label: string; ring: Point[]; areaPx2: number; perimPx: number; seed: readonly [number, number] | number[]; hatch: boolean; gap: number; merged: string[] };
    const byRing = new Map<string, Cand>();
    const order: Cand[] = [];
    for (const lb of labels) {
      let ring: Point[] | null = null, hatch = false, gap = 0, seed: [number, number] | null = null;
      let sawBubble = false, sawDegenerate = false;
      for (const probe of seedLadderPx(lb.bbox)) {
        const f = floodRegion(mask, probe[0], probe[1], opts.sensitivity ?? SENS_BALANCED);
        if (f.status !== "ok") continue;
        // raster trace differences mirror oneClick (#154): looser eps, no snap
        const r = raster
          ? traceRegion(f, RASTER_RDP_EPS)
          : snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
        if (r.length < 3) { sawDegenerate = true; continue; }
        if (isLabelBubblePx(r as [number, number][], lb.bbox)) { sawBubble = true; continue; }
        ring = r; hatch = !!f.hatchFiltered; gap = f.gapBridged || 0; seed = probe;
        break;
      }
      if (!ring || !seed) {
        if (sawBubble) withheld.bubble++;            // only its own bubble ever flooded clean
        else if (sawDegenerate) withheld.degenerate++;
        // a label with no clean flood at any probe simply isn't counted as a
        // seed that traced — same as the historical single-seed gate
        continue;
      }
      const key = ring.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";");
      const seen = byRing.get(key);
      if (seen) { seen.merged.push(lb.str); withheld.duplicate++; continue; }
      const cand: Cand = {
        label: lb.str, ring, areaPx2: ringArea(ring), perimPx: closedMetrics(ring).perim,
        seed, hatch, gap, merged: [],
      };
      byRing.set(key, cand);
      order.push(cand);
    }

    const upp = s.upp;
    const rooms = order
      .map((c) => {
        const common = {
          label: c.label,
          nverts: c.ring.length,
          ...(c.merged.length ? { merged_labels: c.merged } : {}),
          ...(c.hatch ? { hatch_filtered: true as const } : {}),
          ...(c.gap ? { gap_bridged_px: c.gap } : {}),
          ...(raster ? { raster_traced: true as const } : {}),
          ...(opts.returnVerts ? { verts: c.ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
        };
        if (upp == null) {
          return { ...common, area_px2: round1(c.areaPx2), perimeter_px: round1(c.perimPx) };
        }
        const area_sf = round2(c.areaPx2 * upp * upp);
        if (area_sf < minAreaSf) { withheld.implausible++; return null; }
        const perimeter_lf = round2(c.perimPx * upp);
        // schedule resolution runs AFTER the geometric gates: a bubble is
        // reported as a bubble, and an unresolved room still reports its real
        // area — withheld, never dropped, with the seed that turns "ask the
        // estimator" into "one_click here" once they answer.
        let tag = opts.condition;
        let assignment: ShapeOrigin["assignment"];
        if (assign) {
          const hit = this.floorTagFor(graph!, c.label);
          if ("reason" in hit) {
            withheld.unresolved++;
            unresolved.push({ label: c.label, reason: hit.reason, area_sf, perimeter_lf, seed: [round1(c.seed[0]), round1(c.seed[1])] });
            return null;
          }
          tag = hit.tag;
          assignment = { source: "schedule", room_tag: c.label, surface: "FLOOR", schedule_sheet: hit.sheet };
        }
        let shape_id: string | undefined;
        if (tag) {
          shape_id = this.commit(s, tag, opts.role, c.ring, { area_sf, perimeter_lf }, {
            method: "one_click_v1",
            actor: "agent",
            seed_norm: [c.seed[0] / s.widthPx, c.seed[1] / s.heightPx],
            reviewed: false,
            ...(c.hatch ? { hatch_filtered: true as const } : {}),
            ...(c.gap ? { gap_bridged_px: c.gap } : {}),
            ...(raster ? { raster_traced: true as const } : {}),
            ...(assignment ? { assignment } : {}),
          }).id;
        }
        return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id, condition: tag } : {}) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    this.flushCommits("detect_rooms"); // the whole sweep is one reversible step
    // each assign run REPLACES the disclosure state: the marked set reports
    // the latest sweep's unresolved rooms, and only those (export-time
    // staleness drops any the agent has since committed by hand)
    if (assign) {
      this.scheduleWithheld = unresolved.map((u) => ({
        sheet_id: s.key, label: u.label, reason: u.reason,
        seed_norm: [u.seed[0] / s.widthPx, u.seed[1] / s.heightPx] as [number, number],
      }));
    }
    const withheldTotal = withheld.degenerate + withheld.duplicate + withheld.bubble + withheld.implausible + withheld.unresolved;
    return {
      detected: rooms.length,
      rooms,
      withheld: {
        total: withheldTotal,
        ...withheld,
        ...(upp != null ? { min_area_sf: minAreaSf } : {}),
      },
      // assign mode always states the answer, empty array included: [] is the
      // positive claim "every detected room resolved against its own row"
      ...(assign ? { unresolved } : {}),
      ...(s.detected?.multi ? { multiple_scales: true as const } : {}),
      ...(withheldTotal
        ? { note: `${withheldTotal} seed(s) withheld — ${withheld.duplicate} duplicate region(s), ${withheld.bubble} label-bubble(s), ${withheld.implausible} under ${minAreaSf} SF, ${withheld.degenerate} untraceable${assign ? `, ${withheld.unresolved} unresolved against the schedule (see unresolved[])` : ""}.` }
        : {}),
      ...(s.upp == null ? { warning: `No scale set for ${s.key} — quantities unavailable. Call set_scale${s.detected ? ` (detected: ${s.detected.label})` : ""}.` } : {}),
    };
  }

  measurePolygon(name: string, verts: Point[], opts: { condition?: string; role: "floor_area" | "deduct" }) {
    const s = this.sheet(name);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    const met = closedMetrics(verts);
    const area_sf = round2(met.area * s.upp * s.upp);
    const perimeter_lf = round2(met.perim * s.upp);
    let shape_id: string | undefined;
    // agent-supplied coordinates are a hand trace by a machine hand: manual
    // method, agent actor — and never reviewed (no human affirmed anything).
    if (opts.condition) shape_id = this.commit(s, opts.condition, opts.role, verts, { area_sf, perimeter_lf }, { method: "manual", actor: "agent" }).id;
    this.flushCommits("measure_polygon");
    const mixed = this.scaleWarningFor(s, verts);
    return { area_sf, perimeter_lf, nverts: verts.length, ...(shape_id ? { shape_id } : {}), ...(mixed ? { warning: mixed } : {}) };
  }

  measureLine(name: string, pts: Point[], opts: { condition?: string }) {
    const s = this.sheet(name);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    const length_lf = round2(openLen(pts) * s.upp);
    let shape_id: string | undefined;
    // area_sf stays 0 — the canvas only mints border SF when the condition has a thickness
    if (opts.condition) shape_id = this.commit(s, opts.condition, "linear", pts, { area_sf: 0, perimeter_lf: length_lf }, { method: "manual", actor: "agent" }).id;
    this.flushCommits("measure_line");
    return { length_lf, npts: pts.length, ...(shape_id ? { shape_id } : {}) };
  }

  /** Surface Area — the canvas's Surface tool (commitSurface): an OPEN run
   * traced along the wall in plan view, quantified as traced LF × height.
   * Height lives on the CONDITION (the canvas's H knob); an explicit height_ft
   * here writes that knob first, exactly like typing H before tracing — and
   * that write journals as its own condition step, so undo stays exact.
   * The refusal path mints nothing: no height, no condition side effects. */
  measureSurface(name: string, pts: Point[], opts: { condition: string; height_ft?: number }) {
    const s = this.sheet(name);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    const existing = this.conditions.find((x) => x.finish_tag === opts.condition);
    const h = opts.height_ft ?? (Number(existing?.height_ft) || 0);
    if (!(h > 0)) {
      throw new UserError(`Set a height for ${opts.condition} first — Surface Area = traced LF × height. Pass height_ft on this call, or set it with edit_condition.`);
    }
    const c = this.conditionFor(opts.condition);
    if (opts.height_ft !== undefined && c.height_ft !== opts.height_ft) {
      this.record({ op: "condition", tool: "measure_surface", condition_id: c.id, before: { waste_pct: c.waste_pct, multiplier: c.multiplier, height_ft: c.height_ft } });
      c.height_ft = opts.height_ft;
    }
    const LF = openLen(pts) * s.upp;
    const shape = this.commit(s, opts.condition, "surface_area", pts, { area_sf: round2(LF * h), perimeter_lf: round2(LF) }, { method: "manual", actor: "agent" });
    shape.height_ft = h;
    this.flushCommits("measure_surface");
    return { condition: c.finish_tag, height_ft: h, length_lf: round2(LF), area_sf: round2(LF * h), npts: pts.length, shape_id: shape.id };
  }

  /** derive_base (#148): the estimator's most mechanical derivation — wall
   * base LF = room perimeter − stated door openings — minted as committed
   * linear shapes from the floor shapes an agent (or detect_rooms) already
   * traced. Every committed floor shape carries its perimeter; the openings
   * stay the CALLER'S stated claim per room (it can see the doors in
   * view_sheet) — refusal over guessing, and the claim rides provenance.
   * Geometry: each base shape re-uses its source ring CLOSED (ring + the
   * first vertex again) so the run traces the whole room boundary on the
   * canvas and in the marked set. NOTE: quantities are assigned at derive
   * time (net of openings); a later edit_shape re-measure of the polyline is
   * the gross boundary again — the openings deduction lives here and in
   * origin.derived, not in the geometry. */
  deriveBase(opts: { source_condition: string; condition: string; openings?: { shape_id: string; lf: number }[] }) {
    const src = this.conditions.find((x) => x.finish_tag === opts.source_condition);
    if (!src) {
      throw new UserError(`No condition ${JSON.stringify(opts.source_condition)} — tags: ${this.conditions.map((x) => x.finish_tag).join(", ") || "(none)"}.`);
    }
    if (opts.condition === opts.source_condition) {
      throw new UserError("Base must land on its OWN condition (e.g. 'RB-1') — deriving onto the source would add its perimeter to the same tag's LF.");
    }
    const floors = this.shapes.filter((x) => x.condition_id === src.id && x.measure_role === "floor_area");
    if (!floors.length) {
      throw new UserError(`${src.finish_tag} has no floor_area shapes to derive from — commit rooms first (one_click / detect_rooms).`);
    }
    const byShape = new Map<string, number>();
    for (const [i, o] of (opts.openings ?? []).entries()) {
      const hit = floors.find((f) => f.id === o.shape_id);
      if (!hit) throw new UserError(`openings[${i}]: ${JSON.stringify(o.shape_id)} is not a floor_area shape of ${src.finish_tag} — list_shapes for real ids.`);
      if (!(o.lf >= 0)) throw new UserError(`openings[${i}]: lf must be >= 0.`);
      byShape.set(o.shape_id, (byShape.get(o.shape_id) ?? 0) + o.lf);
    }
    // validate every net BEFORE committing anything — all-or-nothing
    for (const f of floors) {
      const open = byShape.get(f.id) ?? 0;
      const gross = f.computed.perimeter_lf ?? 0;
      if (open >= gross) {
        throw new UserError(`Shape ${f.id}: stated openings (${round2(open)} LF) meet or exceed its perimeter (${round2(gross)} LF) — nothing would remain.`);
      }
    }
    const rooms = floors.map((f) => {
      const s = this.sheet(f.sheet_id);
      const gross = f.computed.perimeter_lf ?? 0;
      const open = byShape.get(f.id) ?? 0;
      const net = round2(gross - open);
      const ringPx: Point[] = f.verts_norm.map(([x, y]) => [x * s.widthPx, y * s.heightPx]);
      const shape = this.commit(s, opts.condition, "linear", [...ringPx, ringPx[0]], { area_sf: 0, perimeter_lf: net }, {
        method: "agent_v1",
        actor: "agent",
        reviewed: false,
        derived: { from_shape_id: f.id, gross_lf: round2(gross), openings_lf: round2(open) },
      });
      return { source_shape_id: f.id, base_shape_id: shape.id, sheet: f.sheet_id, gross_lf: round2(gross), openings_lf: round2(open), net_lf: net };
    });
    this.flushCommits("derive_base");
    return {
      condition: opts.condition,
      source_condition: src.finish_tag,
      rooms,
      committed: rooms.length,
      total_lf: round2(rooms.reduce((n, r) => n + r.net_lf, 0)),
      note: "Base runs trace each room's boundary; openings are your stated claim, recorded on origin.derived. Verify with view_sheet overlay:true.",
    };
  }

  /** Count markers — the canvas's Count tool (commitCount): one point, one EA,
   * computed {count: 1}, NO scale required (EA is scale-free; the canvas's
   * recompute skips count shapes for the same reason). One shape per point,
   * the whole call one journal gesture — undoing a placement sweep is one step,
   * matching detect_rooms.
   *
   * `origins` (optional, aligned with points) lets a derived tool commit
   * through this same path while telling the truth about the method —
   * symbol_sweep stamps `{method: "symbol_sweep", …, symbol: {score, …}}` per
   * marker; a bare place_count stays exactly the manual agent gesture it is. */
  placeCount(name: string, points: Point[], opts: { condition: string; origins?: ShapeOrigin[]; tool?: string }) {
    const s = this.sheet(name);
    const ids = points.map(([x, y], i) =>
      this.commit(s, opts.condition, "count", [[x, y]], { count: 1 },
        opts.origins?.[i] ? { ...opts.origins[i] } : { method: "manual", actor: "agent" }).id);
    this.flushCommits(opts.tool ?? "place_count");
    const c = this.conditions.find((x) => x.finish_tag === opts.condition)!;
    const ea_total = this.shapes
      .filter((x) => x.condition_id === c.id && x.measure_role === "count")
      .reduce((n, x) => n + (x.computed.count || 1), 0);
    return { committed: ids.length, shape_ids: ids, condition: c.finish_tag, ea_total };
  }

  /** symbol_sweep — every placement of ONE example symbol, from the linework.
   * The engine is pure (web/src/lib/symbolsweep.ts): fingerprint the seed
   * rect's segments, propose placements by constellation anchoring under the
   * square symmetry group, score each as the length-weighted fraction of seed
   * segments reproduced within tolerance. This method is the plumbing plus
   * the wire shapes: rect clamping, the scan refusal, and the commit path —
   * match centers through placeCount (ONE undo step, EA scale-free), origins
   * telling the truth (`method: "symbol_sweep"`, per-match score/transform),
   * withheld placements NEVER committed. */
  async symbolSweep(name: string, opts: {
    seedRect: [Point, Point];
    condition?: string;
    commit?: boolean;
    rotations?: boolean;
    mirror?: boolean;
    tolerancePx?: number;
  }) {
    const s = this.sheet(name);
    if (opts.commit && !opts.condition) {
      throw new UserError("commit: true needs a condition — the finish tag the match markers count under (e.g. 'FD-1').");
    }
    const geo = await this.ensureGeometry(s);
    if (!geo.segs.length) {
      throw new UserError("This sheet has no vector linework (likely a scan) — symbol matching reads the drawn segments; raster fallback not yet available in the MCP server.");
    }
    const clampX = (v: number) => Math.max(0, Math.min(v, s.widthPx));
    const clampY = (v: number) => Math.max(0, Math.min(v, s.heightPx));
    const rect: [Point, Point] = [
      [clampX(opts.seedRect[0][0]), clampY(opts.seedRect[0][1])],
      [clampX(opts.seedRect[1][0]), clampY(opts.seedRect[1][1])],
    ];
    if (!(Math.abs(rect[1][0] - rect[0][0]) >= 1 && Math.abs(rect[1][1] - rect[0][1]) >= 1)) {
      throw new UserError(`Empty seed rect — need two distinct corners in image px inside the sheet (${s.widthPx} × ${s.heightPx}).`);
    }
    const sweepOpts: SweepOptions = {
      rotations: opts.rotations ?? true,
      mirror: opts.mirror ?? true,
      tolPx: opts.tolerancePx ?? SWEEP_TOL_PX,
    };
    let res;
    try {
      res = sweepSymbols(geo.segs, rect, sweepOpts);
    } catch (e) {
      // the engine's refusals (empty marquee, region-sized marquee) are
      // user-facing instructions, not crashes
      throw new UserError(e instanceof Error ? e.message : String(e));
    }

    let committed: { committed: number; shape_ids: string[]; condition: string; ea_total: number } | undefined;
    if (opts.commit && res.matches.length) {
      committed = this.placeCount(name, res.matches.map((m) => m.at), {
        condition: opts.condition!,
        tool: "symbol_sweep",
        origins: res.matches.map((m) => ({
          method: "symbol_sweep" as const,
          actor: "agent" as const,
          reviewed: false,
          symbol: { score: m.score, rotation: m.rotation, mirrored: m.mirrored },
        })),
      });
    }

    return {
      found: res.matches.length,
      matches: res.matches.map((m) => ({ at: [round1(m.at[0]), round1(m.at[1])], score: m.score, rotation: m.rotation, mirrored: m.mirrored })),
      withheld: res.withheld.map((w) => ({ at: [round1(w.at[0]), round1(w.at[1])], score: w.score, rotation: w.rotation, mirrored: w.mirrored, reason: w.reason })),
      seed: {
        segments: res.seed.segments,
        center: [round1(res.seed.center[0]), round1(res.seed.center[1])],
        rect: [round1(rect[0][0]), round1(rect[0][1]), round1(rect[1][0]), round1(rect[1][1])],
        length_px: res.seed.length_px,
      },
      candidates: res.candidates,
      ...(committed ? {
        committed: committed.committed,
        shape_ids: committed.shape_ids,
        condition: committed.condition,
        ea_total: committed.ea_total,
      } : {}),
      ...(opts.commit && !res.matches.length ? { note: "commit requested but nothing cleared the bar — no shapes were committed." } : {}),
      ...(res.candidates.dropped > 0 ? { warning: `Work cap: ${res.candidates.dropped} candidate placement(s) were never scored — the seed's linework is too common on this sheet for an exhaustive sweep. Tighten the seed rect around more distinctive geometry, or sweep a region at a time and reconcile the counts.` } : {}),
    };
  }

  /** The mid-session shape inventory (#149): every committed shape's id,
   * home, role, and quantities in one compact read — the ids edit_shape /
   * delete_shape assume you have, without pulling the whole export_takeoff
   * payload to find one shape. Filters narrow, they never 404 an empty list. */
  listShapes(f: { sheet?: string; condition?: string } = {}) {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    let rows = this.shapes;
    if (f.sheet) { const s = this.sheet(f.sheet); rows = rows.filter((x) => x.sheet_id === s.key); }
    if (f.condition) {
      const c = this.conditions.find((x) => x.finish_tag === f.condition);
      if (!c) throw new UserError(`No condition ${JSON.stringify(f.condition)} — tags: ${this.conditions.map((x) => x.finish_tag).join(", ") || "(none)"}.`);
      rows = rows.filter((x) => x.condition_id === c.id);
    }
    const tagById = new Map(this.conditions.map((c) => [c.id, c.finish_tag]));
    return {
      shapes: rows.map((x) => ({
        id: x.id,
        sheet: x.sheet_id,
        condition: tagById.get(x.condition_id) ?? "",
        measure_role: x.measure_role,
        ...(x.computed.area_sf !== undefined ? { area_sf: x.computed.area_sf } : {}),
        ...(x.computed.perimeter_lf !== undefined ? { perimeter_lf: x.computed.perimeter_lf } : {}),
        ...(x.computed.count !== undefined ? { count: x.computed.count } : {}),
        ...(x.height_ft !== undefined ? { height_ft: x.height_ft } : {}),
        nverts: x.verts_norm.length,
        reviewed: x.origin?.reviewed === true,
        ...(x.origin?.assignment ? { assignment: x.origin.assignment.source } : {}),
        ...(x.origin?.agent_edits ? { agent_edits: x.origin.agent_edits } : {}),
      })),
      count: rows.length,
    };
  }

  summary() {
    const rows = conditionTotals(this.conditions, this.shapes) as Record<string, unknown>[];
    // strip presentation fields for a compact agent-facing reply
    const lean = rows.map(({ color, fill, hatch, materials, ...rest }) => rest);
    return { conditions: lean, totals: grandTotals(rows) };
  }

  deleteShape(id: string) {
    const i = this.shapes.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError(`No shape with id ${JSON.stringify(id)}.`);
    const [shape] = this.shapes.splice(i, 1);
    this.record({ op: "delete", tool: "delete_shape", removed: [{ shape, index: i }] });
    return { deleted: id, shape_count: this.shapes.length };
  }

  /** Revise a committed shape in place: new geometry, a different condition, a
   * different role, or any combination. This is the verb that turns the agent
   * from an appender into an editor — it can propose a ring, look at the
   * overlay, see it overshot into the corridor, and move the two offending
   * vertices, instead of deleting and re-deriving the whole room.
   *
   * The review gate is absolute: a shape a human affirmed (origin.reviewed ===
   * true) is ink, and no agent verb touches ink. This server never sets that
   * flag itself, so the guard is inert here today — it is the contract that
   * makes this surface portable to a host that DOES have a review gate, and it
   * belongs in the code rather than in a host's good intentions.
   *
   * Provenance: agent self-revision bumps origin.agent_edits and touches
   * NOTHING in the human-correction vocabulary (edited / edits /
   * proposed_verts_norm — see web/src/lib/provenance.js). Those fields grade a
   * human's correction of a machine proposal; an agent fixing its own work is
   * not that, and conflating the two would poison the exact signal the capture
   * layer exists to collect. Freezing proposed_verts_norm stays correct on the
   * human's first edit, because the geometry a reviewer saw IS the agent's
   * final revision, not its first draft. */
  editShape(id: string, patch: { verts?: Point[]; condition?: string; role?: MeasureRole }) {
    const i = this.shapes.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError(`No shape with id ${JSON.stringify(id)}.`);
    const cur = this.shapes[i];
    if (cur.origin?.reviewed === true) {
      throw new UserError(`Shape ${JSON.stringify(id)} was affirmed by a human — reviewed work is ink, not pencil, and cannot be edited by an agent.`);
    }
    if (patch.verts === undefined && patch.condition === undefined && patch.role === undefined) {
      throw new UserError("Nothing to change — pass at least one of verts, condition, role.");
    }
    const s = this.sheet(cur.sheet_id);
    const role = patch.role ?? cur.measure_role;
    // count is scale-free (EA), exactly as commit-time: moving a marker on an
    // unscaled sheet must not trip the scale gate
    if (role !== "count" && s.upp == null) throw new UserError(this.scaleGate(s));
    const upp = s.upp ?? 0;

    // Geometry: either the supplied verts or the shape's own, back in image px.
    const vertsPx: Point[] = patch.verts
      ?? cur.verts_norm.map(([x, y]) => [x * s.widthPx, y * s.heightPx] as Point);
    const minPts = role === "count" ? 1 : role === "linear" || role === "surface_area" ? 2 : 3;
    if (vertsPx.length < minPts) {
      throw new UserError(`A ${role === "count" ? "count marker needs at least 1 point" : role === "linear" || role === "surface_area" ? `${role} shape needs at least 2 points` : "closed shape needs at least 3 vertices"} — got ${vertsPx.length}.`);
    }

    // Quantities are always recomputed from the resulting geometry AND role, so
    // a role flip alone re-measures correctly (open length vs closed area).
    // surface_area re-measures at its height: the shape's snapshot, else the
    // condition's H knob — flipping INTO surface with neither is refused.
    const heightFor = (): number => {
      const condId = patch.condition !== undefined ? this.conditionFor(patch.condition).id : cur.condition_id;
      const cond = this.conditions.find((x) => x.id === condId);
      const h = Number(cur.height_ft) || Number(cond?.height_ft) || 0;
      if (!(h > 0)) throw new UserError(`Surface Area needs a height — set height_ft on ${cond?.finish_tag ?? "the condition"} with edit_condition first.`);
      return h;
    };
    const computed =
      role === "count" ? { count: cur.computed.count ?? 1 }
      : role === "linear" ? { area_sf: 0, perimeter_lf: round2(openLen(vertsPx) * upp) }
      : role === "surface_area" ? (() => {
          const LF = openLen(vertsPx) * upp;
          return { area_sf: round2(LF * heightFor()), perimeter_lf: round2(LF) };
        })()
      : (() => {
          const met = closedMetrics(vertsPx);
          return { area_sf: round2(met.area * upp * upp), perimeter_lf: round2(met.perim * upp) };
        })();

    const before: Shape = structuredClone(cur);
    const condition_id = patch.condition !== undefined ? this.conditionFor(patch.condition).id : cur.condition_id;
    this.shapes[i] = {
      ...cur,
      condition_id,
      measure_role: role,
      verts_norm: vertsPx.map(([x, y]) => [x / s.widthPx, y / s.heightPx]),
      computed,
      ...(role === "surface_area" ? { height_ft: Number(cur.height_ft) || heightFor() } : {}),
      ...(cur.origin ? { origin: {
        ...cur.origin,
        agent_edits: (cur.origin.agent_edits ?? 0) + 1,
        // a reassign onto a different tag is the agent choosing the finish —
        // keeping "schedule" (and its citation) past that point would be a lie
        ...(patch.condition !== undefined && cur.origin.assignment?.source === "schedule"
          ? { assignment: { source: "asserted" as const } } : {}),
      } } : {}),
    };
    this.record({ op: "edit", tool: "edit_shape", before });

    const changed = [
      ...(patch.verts !== undefined ? ["verts"] : []),
      ...(patch.condition !== undefined ? ["condition"] : []),
      ...(patch.role !== undefined ? ["role"] : []),
    ];
    return {
      shape_id: id,
      changed,
      measure_role: role,
      nverts: vertsPx.length,
      ...computed,
      agent_edits: this.shapes[i].origin?.agent_edits ?? 0,
    };
  }

  /** Add/remove/patch supporting-materials rows on a condition, in one call.
   * Unlike editShape there is no review gate to check — materials rows carry
   * no origin/reviewed field, because they are quantity CONFIG (a coverage
   * rate), not geometry a human traced. Validated all-or-nothing before
   * anything is written: a bad id anywhere in remove/patch throws and nothing
   * changes, same discipline as the shapes tools. Reversible with undo_last —
   * one journal entry snapshots the condition's whole materials array before
   * the call, restored verbatim on undo (same pattern as editShape's `before`
   * capture, simpler here because there is no per-row provenance to preserve). */
  editMaterials(tag: string, opts: {
    add?: { name: string; per?: number; basis?: MaterialRow["basis"]; unit?: string; round?: boolean; note?: string }[];
    remove?: string[];
    patch?: { id: string; fields: Partial<Omit<MaterialRow, "id">> }[];
  }) {
    const add = opts.add ?? [], remove = opts.remove ?? [], patch = opts.patch ?? [];
    if (!add.length && !remove.length && !patch.length) {
      throw new UserError("Nothing to change — pass at least one of add, remove, patch.");
    }
    for (let i = 0; i < add.length; i++) {
      if (!add[i].name.trim()) throw new UserError(`add[${i}]: name required.`);
    }
    // Validate remove/patch against whatever condition already exists, WITHOUT
    // minting one — conditionFor() below creates on first touch (same as every
    // other condition-bearing tool), and a validation failure must leave no
    // trace: an unknown tag + a bad row id should error, not mint an empty
    // condition as a side effect of the error.
    const existingMaterials = this.conditions.find((x) => x.finish_tag === tag)?.materials ?? [];
    const byId = new Map(existingMaterials.map((m) => [m.id, m]));
    for (const id of remove) {
      if (!byId.has(id)) throw new UserError(`remove: no material row ${JSON.stringify(id)} on condition ${JSON.stringify(tag)}.`);
    }
    for (let i = 0; i < patch.length; i++) {
      if (!byId.has(patch[i].id)) throw new UserError(`patch[${i}]: no material row ${JSON.stringify(patch[i].id)} on condition ${JSON.stringify(tag)}.`);
      if (!Object.keys(patch[i].fields).length) throw new UserError(`patch[${i}]: fields must be non-empty.`);
    }

    const c = this.conditionFor(tag);
    const before = structuredClone(c.materials);
    const added: string[] = [];
    for (const a of add) {
      const row: MaterialRow = {
        id: uid("mat"), name: a.name.trim(), per: Math.max(0, a.per ?? 0),
        basis: a.basis ?? "area", unit: a.unit ?? "", round: a.round ?? true,
        ...(a.note ? { note: a.note } : {}),
      };
      c.materials.push(row);
      added.push(row.id);
    }
    const removed = new Set(remove);
    if (removed.size) c.materials = c.materials.filter((m) => !removed.has(m.id));
    const patched: string[] = [];
    for (const p of patch) {
      const m = c.materials.find((x) => x.id === p.id)!;
      Object.assign(m, p.fields);
      patched.push(p.id);
    }
    this.record({ op: "materials", tool: "edit_materials", condition_id: c.id, before });

    return {
      condition: tag, condition_id: c.id,
      changed: { added, removed: [...removed], patched },
      materials: c.materials,
    };
  }

  /** Set a condition's quantity knobs — waste % and multiplier. Both are
   * emitted by takeoff_summary (`waste_pct`, the `*_net` order quantities) and
   * carried by every export, but nothing in the tool surface could set them,
   * so an agent's takeoff always shipped net === gross (#131). Same class as
   * editMaterials — quantity config, not traced geometry, so no review gate —
   * but resolve-or-error rather than mint-on-first-touch: these knobs only
   * mean anything on a condition that exists, and a typo'd tag must error,
   * not create an empty condition as a side effect. One journal entry
   * snapshots both knobs; undo restores them verbatim. */
  /** dimsFor / uppFor as computeRollTakeoff wants them — bitmap px and real
   * feet per px, null for sheets that can't participate. */
  private rollInputs() {
    return {
      dimsFor: (sheetId: string) => { const s = this.sheets.get(sheetId); return s ? { w: s.widthPx, h: s.heightPx } : null; },
      uppFor: (sheetId: string) => this.sheets.get(sheetId)?.upp ?? null,
    };
  }

  editCondition(tag: string, opts: { waste_pct?: number; multiplier?: number; height_ft?: number; roll_setup?: Record<string, unknown> | null }) {
    if (opts.waste_pct === undefined && opts.multiplier === undefined && opts.height_ft === undefined && opts.roll_setup === undefined) {
      throw new UserError("Nothing to change — pass at least one of waste_pct, multiplier, height_ft, roll_setup.");
    }
    const c = this.conditions.find((x) => x.finish_tag === tag);
    if (!c) {
      const known = this.conditions.map((x) => x.finish_tag);
      throw new UserError(`No condition ${JSON.stringify(tag)}.${known.length ? ` Known tags: ${known.join(", ")}.` : " Nothing has minted a condition yet — commit a measurement or add materials first."}`);
    }
    const before = {
      waste_pct: c.waste_pct, multiplier: c.multiplier, height_ft: c.height_ft,
      roll_setup: c.roll_setup ? structuredClone(c.roll_setup) : undefined,
    };
    if (opts.waste_pct !== undefined) c.waste_pct = opts.waste_pct;
    if (opts.multiplier !== undefined) c.multiplier = opts.multiplier;
    if (opts.height_ft !== undefined) c.height_ft = opts.height_ft;
    if (opts.roll_setup !== undefined) {
      if (opts.roll_setup === null) {
        delete c.roll_setup; // opt out — the condition is trade-agnostic again
      } else {
        const given = Object.fromEntries(Object.entries(opts.roll_setup).filter(([, v]) => v !== undefined));
        const prevMaterial = (c.roll_setup as { material?: string } | undefined)?.material;
        const material = (given.material as string | undefined) ?? prevMaterial ?? "carpet";
        // a material change (or a fresh opt-in) starts from the engine's
        // defaults for that class — the canvas's opt-in select does the same;
        // a same-material partial edit patches the existing setup
        const base = hasRollSetup(c) && material === prevMaterial ? (c.roll_setup as object) : (mintRollSetup(material) as object);
        c.roll_setup = { ...base, ...given, material };
      }
    }
    this.record({ op: "condition", tool: "edit_condition", condition_id: c.id, before });

    // when the condition is roll goods AND floor shapes exist on scaled sheets,
    // echo the figured order right on the reply — the agent should not need an
    // export round-trip to learn what its knob just did
    let roll: Record<string, unknown> | undefined;
    if (hasRollSetup(c)) {
      const { dimsFor, uppFor } = this.rollInputs();
      const { byCond } = computeRollTakeoff([c], this.shapes, dimsFor, uppFor) as { byCond: Map<string, unknown> };
      const rows = conditionTotals([c], this.shapes) as Record<string, unknown>[];
      roll = (rollReportRows(byCond, rows) as Record<string, unknown>[])[0];
    }
    return {
      condition: tag, condition_id: c.id, waste_pct: c.waste_pct, multiplier: c.multiplier,
      ...(c.height_ft !== undefined ? { height_ft: c.height_ft } : {}),
      ...(c.roll_setup ? { roll_setup: c.roll_setup } : {}),
      ...(roll ? { roll } : {}),
    };
  }

  /** Step back over this session's own last n mutations, newest first. Each
   * entry's inverse is exact (see JournalEntry), so this restores state rather
   * than approximating it. Reads are not journaled, so undo never has to step
   * over a look — n counts gestures that changed something. */
  undoLast(n: number) {
    const undone: { seq: number; op: JournalEntry["op"]; tool: string; shapes: number }[] = [];
    for (let k = 0; k < n; k++) {
      const e = this.journal.pop();
      if (!e) break;
      if (e.op === "commit") {
        const dead = new Set(e.ids);
        this.shapes = this.shapes.filter((x) => !dead.has(x.id));
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: e.ids.length });
      } else if (e.op === "edit") {
        const i = this.shapes.findIndex((x) => x.id === e.before.id);
        // the shape may have been deleted after the edit; undoing the edit of a
        // shape that is gone is a no-op on geometry, not an error
        if (i >= 0) this.shapes[i] = e.before;
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: i >= 0 ? 1 : 0 });
      } else if (e.op === "materials") {
        const c = this.conditions.find((x) => x.id === e.condition_id);
        // the condition itself is never deleted (no delete_condition tool), so
        // this only misses if a fresh session's journal outlived a load_plan —
        // which load_plan already clears the journal for.
        if (c) c.materials = e.before;
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "condition") {
        const c = this.conditions.find((x) => x.id === e.condition_id);
        if (c) {
          c.waste_pct = e.before.waste_pct;
          c.multiplier = e.before.multiplier;
          if (e.before.height_ft === undefined) delete c.height_ft;
          else c.height_ft = e.before.height_ft;
          if (e.before.roll_setup === undefined) delete c.roll_setup;
          else c.roll_setup = e.before.roll_setup;
        }
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "approval") {
        // the stored inverse came from the canvas's own pure apply — exact
        // restore, array order included (a lifted verdict returns to its
        // recorded index; a minted one is removed, id and all)
        this.approvals = applyApprovalCommand(this.approvals, e.inverse).approvals;
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else {
        for (const { shape, index } of e.removed) {
          this.shapes.splice(Math.min(index, this.shapes.length), 0, shape);
        }
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: e.removed.length });
      }
    }
    return {
      undone: undone.length,
      steps: undone,
      shape_count: this.shapes.length,
      remaining: this.journal.length,
      ...(undone.length < n ? { note: `Only ${undone.length} step(s) were available to undo.` } : {}),
    };
  }

  /** Place an annotation. A note ABOUT the work — it never measures anything
   *  and never touches a quantity, which is why there is no review gate here:
   *  the pencil-not-ink rule exists to stop an agent inventing GEOMETRY, and a
   *  cloud saying "verify substrate" is not geometry.
   *
   *  `condition` attaches it to a scope by finish tag, minting the condition on
   *  first touch exactly like one_click/measure_polygon — so an agent can note
   *  something about CPT-1 before anything is traced for CPT-1. Omit it for a
   *  note about the sheet rather than about a finish. */
  annotate(a: { sheet: string; type: Markup["type"]; text: string; at?: Point; target?: Point; rect?: [Point, Point]; from?: Point; to?: Point; r?: number; condition?: string }): Record<string, unknown> {
    const s = this.sheet(a.sheet);
    const n = ([x, y]: Point): [number, number] => [x / s.widthPx, y / s.heightPx];
    if ((a.type === "cloud" || a.type === "highlight") && !a.rect) throw new UserError(`a ${a.type} needs rect: [[x0,y0],[x1,y1]] in image px`);
    if ((a.type === "text" || a.type === "callout" || a.type === "bubble") && !a.at) throw new UserError(`a ${a.type} needs at: [x,y] in image px`);
    if (a.type === "callout" && !a.target) throw new UserError("a callout needs target: [x,y] — the point the leader line aims at");
    if ((a.type === "arrow" || a.type === "dimension") && (!a.from || !a.to)) {
      throw new UserError(a.type === "arrow"
        ? "an arrow needs from: [x,y] and to: [x,y] — tail and head, in image px"
        : "a dimension needs from: [x,y] and to: [x,y] — its two measured endpoints, in image px");
    }
    // a dimension LABELS a real length, so it is the one annotation the scale
    // gate applies to — same refusal the measure tools give, never a px label
    // dressed up as feet
    let len_ft: number | undefined;
    if (a.type === "dimension") {
      if (s.upp == null) throw new UserError(this.scaleGate(s));
      len_ft = round2(Math.hypot(a.to![0] - a.from![0], a.to![1] - a.from![1]) * s.upp);
    }
    const cond = a.condition ? this.conditionFor(a.condition) : null;
    const m: Markup = {
      id: uid("mk"),
      sheet_id: s.key,
      type: a.type,
      text: a.text || "",
      condition_id: cond?.id ?? "",
      rfi_id: "",
      created_at: new Date().toISOString(),
      ...(a.at ? { at: n(a.at) } : {}),
      ...(a.target ? { target: n(a.target) } : {}),
      ...(a.rect ? { rect: [n(a.rect[0]), n(a.rect[1])] as [[number, number], [number, number]] } : {}),
      ...(a.from ? { from: n(a.from) } : {}),
      ...(a.to ? { to: n(a.to) } : {}),
      // bubble radius: px → fraction of sheet WIDTH (marked-set frame); the
      // canvas default is 0.02 when unset — stored explicitly so exports agree
      ...(a.type === "bubble" ? { r: a.r != null ? a.r / s.widthPx : 0.02 } : {}),
      // dimension: the measured length rides the markup so the renderers
      // (canvas, marked set) draw the label without scale plumbing
      ...(len_ft !== undefined ? { len_ft } : {}),
    };
    this.markups.push(m);
    return {
      id: m.id, sheet: s.key, type: m.type, text: m.text,
      condition: cond?.finish_tag ?? "", condition_id: m.condition_id,
      ...(len_ft !== undefined ? { length_lf: len_ft } : {}),
      note: cond
        ? `Attached to ${cond.finish_tag} — it wears that condition's colour on the canvas and in the marked set.`
        : "Unattached — a note about the sheet. Pass condition to tie it to a scope.",
    };
  }

  /** Read annotations, optionally narrowed to a sheet and/or a condition.
   *  Resolves condition_id to its finish tag so a caller can act on the reply
   *  without joining against the conditions array.
   *
   *  Verdict marks (#176) ride the same inventory as their own block: the
   *  sheet filter applies directly (a record renders on its sheet), and a
   *  condition filter reaches a verdict THROUGH its target shape — a verdict
   *  on a CPT-1 shape is about CPT-1 work, while a sheet-point mark carries
   *  no scope and drops out of any condition filter. */
  listAnnotations(f: { sheet?: string; condition?: string } = {}): Record<string, unknown> {
    const tagById = new Map(this.conditions.map((c) => [c.id, c.finish_tag]));
    let rows = this.markups;
    let seals = this.approvals;
    if (f.sheet) {
      const s = this.sheet(f.sheet);
      rows = rows.filter((m) => m.sheet_id === s.key);
      seals = seals.filter((a) => a.sheet_id === s.key);
    }
    const shapeById = new Map(this.shapes.map((x) => [x.id, x]));
    if (f.condition) {
      const c = this.conditions.find((x) => x.finish_tag === f.condition);
      if (!c) throw new UserError(`no condition "${f.condition}" — tags: ${this.conditions.map((x) => x.finish_tag).join(", ") || "(none)"}`);
      rows = rows.filter((m) => m.condition_id === c.id);
      seals = seals.filter((a) => a.shape_id !== undefined && shapeById.get(a.shape_id)?.condition_id === c.id);
    }
    const s0 = this.sheets;
    const px = (m: Markup, p?: [number, number]): [number, number] | undefined => {
      const sh = s0.get(m.sheet_id); if (!p || !sh) return undefined;
      return [round1(p[0] * sh.widthPx), round1(p[1] * sh.heightPx)];
    };
    return {
      annotations: rows.map((m) => ({
        id: m.id, sheet: m.sheet_id, type: m.type, text: m.text,
        condition: tagById.get(m.condition_id) ?? "", condition_id: m.condition_id,
        ...(m.at ? { at: px(m, m.at) } : {}),
        ...(m.target ? { target: px(m, m.target) } : {}),
        ...(m.rect ? { rect: [px(m, m.rect[0]), px(m, m.rect[1])] } : {}),
        ...(m.from ? { from: px(m, m.from) } : {}),
        ...(m.to ? { to: px(m, m.to) } : {}),
        ...(m.r != null ? { r: round1(m.r * (s0.get(m.sheet_id)?.widthPx ?? 0)) } : {}),
        ...(m.len_ft != null ? { length_lf: m.len_ft } : {}),
      })),
      count: rows.length,
      unattached: rows.filter((m) => !m.condition_id).length,
      verdicts: seals.map((a) => {
        const sh = s0.get(a.sheet_id);
        const target = a.shape_id !== undefined ? shapeById.get(a.shape_id) : undefined;
        return {
          id: a.id,
          actor: a.actor,
          sheet: a.sheet_id,
          ...(sh ? { at: [round1(a.at[0] * sh.widthPx), round1(a.at[1] * sh.heightPx)] as [number, number] } : {}),
          ...(a.ts ? { ts: a.ts } : {}),
          ...(a.shape_id !== undefined ? { shape_id: a.shape_id } : {}),
          condition: target ? (tagById.get(target.condition_id) ?? "") : "",
          ...(typeof a.text === "string" && a.text ? { text: a.text } : {}),
        };
      }),
      verdict_count: seals.length,
    };
  }

  /** Attach an existing annotation to a condition, or detach it with "". The
   *  canvas's Attach/Detach, reachable by an agent. */
  linkAnnotation(id: string, condition: string): Record<string, unknown> {
    const m = this.markups.find((x) => x.id === id);
    if (!m) throw new UserError(`no annotation "${id}" — call list_annotations for real ids`);
    if (!condition) {
      m.condition_id = "";
      return { id: m.id, condition: "", note: "Detached — now a note about the sheet." };
    }
    const c = this.conditionFor(condition);
    m.condition_id = c.id;
    return { id: m.id, condition: c.finish_tag, condition_id: c.id, note: `Attached to ${c.finish_tag}.` };
  }

  // ── verdict marks (#176) — the agent half of the approval family ───────────

  /** Where a shape-targeted verdict draws, in the space of the verts given.
   * The anchor is a render decision, not a measurement: a closed room anchors
   * at its area centroid, an open run at its on-path midpoint (a bent run's
   * centroid can sit off the work; the midpoint never does), a count marker
   * at the marker itself. Callers pass SHEET-PX verts so the midpoint is the
   * drawn run's true midpoint — arc length does not commute with the
   * non-uniform norm↔px map (centroids do, so they'd be safe either way).
   * Degenerate geometry falls back to the vertex mean. */
  private static verdictAnchor(v: [number, number][], role: MeasureRole): [number, number] {
    if (v.length === 1) return [v[0][0], v[0][1]];
    const closed = role === "floor_area" || role === "deduct";
    if (closed && v.length >= 3) {
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < v.length; i++) {
        const [x1, y1] = v[i], [x2, y2] = v[(i + 1) % v.length];
        const w = x1 * y2 - x2 * y1;
        a += w; cx += (x1 + x2) * w; cy += (y1 + y2) * w;
      }
      if (Math.abs(a) > 1e-12) return [cx / (3 * a), cy / (3 * a)];
    } else if (!closed && v.length >= 2) {
      const lens: number[] = [];
      let total = 0;
      for (let i = 1; i < v.length; i++) {
        const l = Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1]);
        lens.push(l); total += l;
      }
      let walk = total / 2;
      for (let i = 0; i < lens.length; i++) {
        if (walk <= lens[i] && lens[i] > 0) {
          const t = walk / lens[i];
          return [v[i][0] + (v[i + 1][0] - v[i][0]) * t, v[i][1] + (v[i + 1][1] - v[i][1]) * t];
        }
        walk -= lens[i];
      }
    }
    const n = v.length || 1;
    return [v.reduce((s, p) => s + p[0], 0) / n, v.reduce((s, p) => s + p[1], 0) / n];
  }

  /** Mint the agent's verdict mark. actor is the string literal "agent" on
   * the one line that writes the record — there is no actor parameter on this
   * method, on the tool, or anywhere between, so no MCP path can produce the
   * estimator's APPROVED seal (that ink stays behind the canvas's human-only
   * Approve tool). The mutation and its exact-restore inverse both come from
   * the canvas's pure apply, so a mark here undoes and hydrates exactly like
   * a mark made in the app. Touches no quantity. */
  markVerdict(a: { shape_id?: string; sheet?: string; at?: Point; text?: string }): Record<string, unknown> {
    let sheetId: string;
    let atNorm: [number, number];
    let shape: Shape | undefined;
    if (a.shape_id !== undefined) {
      shape = this.shapes.find((x) => x.id === a.shape_id);
      if (!shape) throw new UserError(`No shape with id ${JSON.stringify(a.shape_id)} — list_shapes has the real ids.`);
      // one mark per shape: a second identical diamond stacked on the same
      // anchor is invisible duplication, the same failure class the canvas's
      // click-to-lift toggle prevents. Re-mark = delete_verdict + mark_verdict.
      const dup = this.approvals.find((x) => x.actor === "agent" && x.shape_id === shape!.id);
      if (dup) throw new UserError(`Shape ${shape.id} already carries an agent verdict (${dup.id}) — one mark per shape. delete_verdict it first to re-mark.`);
      sheetId = shape.sheet_id;
      // anchor in sheet px, normalized back for storage; a shape riding a
      // file this session hasn't loaded (#152) anchors in normalized space —
      // still on the work, just without the true-aspect midpoint
      const dims = this.sheets.get(sheetId);
      if (dims) {
        const px = shape.verts_norm.map(([nx, ny]) => [nx * dims.widthPx, ny * dims.heightPx] as [number, number]);
        const [ax, ay] = Session.verdictAnchor(px, shape.measure_role);
        atNorm = [ax / dims.widthPx, ay / dims.heightPx];
      } else {
        atNorm = Session.verdictAnchor(shape.verts_norm, shape.measure_role);
      }
    } else {
      const s = this.sheet(a.sheet!);
      sheetId = s.key;
      atNorm = [a.at![0] / s.widthPx, a.at![1] / s.heightPx];
    }
    const text = (a.text ?? "").trim();
    const { approvals, inverse } = applyApprovalCommand(this.approvals, {
      type: "add",
      approvals: [{
        actor: "agent",   // hardcoded — the structural impossibility, not a default
        sheet_id: sheetId,
        at: atNorm,
        ...(shape ? { shape_id: shape.id } : {}),
        ...(text ? { text } : {}),
      }],
    });
    this.approvals = approvals;
    this.record({ op: "approval", tool: "mark_verdict", inverse });
    const minted = this.approvals[this.approvals.length - 1];
    const sh = this.sheets.get(sheetId);
    const tag = shape ? (this.conditions.find((c) => c.id === shape!.condition_id)?.finish_tag ?? "") : undefined;
    return {
      id: minted.id,
      actor: "agent" as const,
      sheet: sheetId,
      ...(sh ? { at: [round1(atNorm[0] * sh.widthPx), round1(atNorm[1] * sh.heightPx)] as [number, number] } : {}),
      ts: minted.ts,
      ...(shape ? { shape_id: shape.id } : {}),
      ...(tag !== undefined ? { condition: tag } : {}),
      ...(text ? { text } : {}),
      note: shape
        ? `AGENT diamond anchored on ${shape.id} — the agent's pencil-signature on its own work, beside the estimator's ink, never in its place. It touches no quantity.`
        : "AGENT diamond at the sheet point — the agent's pencil-signature, beside the estimator's ink, never in its place. It touches no quantity.",
    };
  }

  /** Lift an agent verdict mark. The estimator's seal is human ink and is
   * refused — the same line editShape holds on reviewed shapes: an agent
   * retracts only its own marks. */
  deleteVerdict(id: string): Record<string, unknown> {
    const a = this.approvals.find((x) => x.id === id);
    if (!a) throw new UserError(`No verdict ${JSON.stringify(id)} — list_annotations returns the real ids in verdicts[].`);
    if (a.actor !== "agent") {
      throw new UserError(`${id} is the estimator's APPROVED seal — human ink, refused. An agent lifts only its own marks (actor "agent").`);
    }
    const { approvals, inverse } = applyApprovalCommand(this.approvals, { type: "delete", ids: [id] });
    this.approvals = approvals;
    this.record({ op: "approval", tool: "delete_verdict", inverse });
    return { deleted: id, verdicts_remaining: this.approvals.length };
  }

  /** The exact browser save payload (TakeoffCanvas.jsx autosave + the schema key
   * store.saveAnnotations stamps) — importable by the app. */
  exportPayload() {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    return {
      schema: ANN_SCHEMA,
      project_name: "",
      units: "imperial",
      sheets: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({ sheet_id: s.key, units_per_px: s.upp })),
      conditions: this.conditions,
      shapes: this.shapes,
      markups: this.markups,
      // approvals ride the payload additively (#176) — present only when any
      // exist, exactly the canvas buildPayload's convention, so a verdict-free
      // export stays byte-identical to a pre-#176 one
      ...(this.approvals.length ? { approvals: this.approvals } : {}),
      sheet_group: [],
      last_group: [],
      sheet_tabs: [],
      sheet_levels: {},
    };
  }

  /** The computed Report document — "opentakeoff.report.v1", the SAME schema
   * and math as the canvas Report's JSON export (web reportJson, totals.js):
   * per-condition quantities with waste and multiplier applied, the computed
   * materials buy list, per-sheet BASE subtotals, scale provenance. This is
   * the contract a pricing consumer reads (#130) — export_takeoff carries
   * materials as CONFIG rows and takeoff_summary strips them; only this
   * document carries the computed order quantities. */
  exportReport(projectName = "") {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    const rows = (conditionTotals(this.conditions, this.shapes) as Record<string, unknown>[]).filter((r) => (r.shape_count as number) > 0);
    // roll goods (#147): the same pure seam the canvas report uses — figured
    // here so the report.v1 block fills the moment a condition carries a setup
    const { dimsFor, uppFor } = this.rollInputs();
    const { byCond } = computeRollTakeoff(this.conditions, this.shapes, dimsFor, uppFor) as { byCond: Map<string, unknown> };
    return reportJson({
      projectName,
      rows,
      bySheet: sheetTotals(this.conditions, this.shapes),
      scaleInfo: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({ sheet_id: s.key, scale_source: s.scaleSource ?? "unknown" })),
      markups: this.markups,
      rfis: [],
      rollGoods: rollReportRows(byCond, rows),
    });
  }

  // ── the sheet graph (#87) ─────────────────────────────────────────────────
  // Built lazily from every sheet's text spans, cached per document (loadPlan
  // clears it). The engine is pure (web/src/lib/sheetgraph.ts); this is the
  // span plumbing plus the wire shapes.
  private graph: SheetGraph | null = null;

  private async ensureGraph(): Promise<SheetGraph> {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    if (!this.graph) {
      const inputs: SheetSpans[] = [];
      for (const s of this.sheets.values()) {
        if (!s.spans) s.spans = textSpans(s.page);
        inputs.push({
          key: s.key,
          sheet_number: s.sheetNumber,
          spans: s.spans.map((t) => ({ str: t.str, x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, ...(t.rot ? { rot: t.rot } : {}) })),
        });
      }
      this.graph = buildSheetGraph(inputs);
    }
    return this.graph;
  }

  private static wireBox(b: [number, number, number, number]) {
    return { x0: round1(b[0]), y0: round1(b[1]), x1: round1(b[2]), y1: round1(b[3]) };
  }
  private static wireEvidence(e: { sheet: string; text: string; bbox: [number, number, number, number] }) {
    return { sheet: e.sheet, text: e.text, bbox: Session.wireBox(e.bbox) };
  }

  async sheetGraph() {
    const g = await this.ensureGraph();
    return {
      available: g.available,
      sheets: g.sheets.map((s) => ({
        sheet: s.key, role: s.role, confidence: s.confidence,
        ...(s.evidence ? { evidence: Session.wireEvidence(s.evidence) } : {}),
        ...(s.building ? { building: s.building } : {}),
        schedules: s.schedules.map((t) => ({
          kind: t.kind, title: t.title, rows: t.rows, region: Session.wireBox(t.region),
          ...(t.continues ? { continues: t.continues } : {}),
          ...(t.rotated_headers ? { rotated_headers: true } : {}),
        })),
      })),
      rooms: g.rooms.map((r) => ({ tag: r.tag, name: r.name, sheet: r.sheet, bbox: Session.wireBox(r.bbox), ...(r.building ? { building: r.building } : {}) })),
      callouts: g.callouts.map((c) => ({ detail: c.detail, target_sheet: c.target_sheet, sheet: c.sheet, bbox: Session.wireBox(c.bbox) })),
      ...(g.buildings.length ? { buildings: g.buildings } : {}),
      ...(g.notes.length ? { notes: g.notes } : {}),
      counts: { rooms: g.rooms.length, schedules: g.tables.length, callouts: g.callouts.length },
    };
  }

  /** The FLOOR finish a room's own schedule row states — assign-from-schedule's
   * per-room resolver (0.9.18): resolveTag's chain narrowed to the one surface
   * a floor takeoff commits. Refusal over guessing, per room: an unresolved
   * tag returns resolveTag's own reason; a resolved row with no FLOOR cell
   * says so; a compound cell ("CPT-1/VCT-1") is ambiguous — committing the
   * whole room's SF under a two-finish literal would assert an area split the
   * schedule never stated. Compound detection is narrow ("/", ",", " OR "),
   * so a hyphenated code never trips it. BASE/WALL are deliberately ignored:
   * those are derive_base's and measure_surface's measures. */
  private floorTagFor(g: SheetGraph, tag: string): { tag: string; sheet: string } | { reason: string } {
    const res = resolveTag(g, tag);
    if (res.status !== "resolved") return { reason: res.reason };
    const floor = res.finishes.find((f) => f.surface === "FLOOR");
    const code = floor?.code.trim();
    if (!floor || !code) return { reason: `schedule row ${res.tag} states no FLOOR finish` };
    if (/[/,]|\bOR\b/i.test(code)) return { reason: `ambiguous: floor cell "${code}" names more than one finish with no stated split` };
    return { tag: code, sheet: floor.source.sheet };
  }

  async resolveRoomTag(tag: string) {
    if (!tag || !tag.trim()) throw new UserError("Pass a room tag, e.g. resolve_tag { tag: \"134\" }.");
    const g = await this.ensureGraph();
    if (!g.available) throw new UserError("This set has no text layer (a scan) — the sheet graph is unavailable, not empty.");
    const res = resolveTag(g, tag);
    const room = res.room ? { tag: res.room.tag, name: res.room.name, sheet: res.room.sheet, bbox: Session.wireBox(res.room.bbox), ...(res.room.building ? { building: res.room.building } : {}) } : null;
    if (res.status === "unresolved") {
      return {
        status: "unresolved" as const, tag: res.tag, room, reason: res.reason,
        ...(res.candidates?.length ? { candidates: res.candidates } : {}),
      };
    }
    return {
      status: "resolved" as const,
      tag: res.tag,
      room,
      ...(res.building ? { building: res.building } : {}),
      finishes: res.finishes.map((f) => ({
        surface: f.surface, code: f.code, source: Session.wireEvidence(f.source),
        ...(f.definition ? { definition: { cells: f.definition.cells, source: Session.wireEvidence(f.definition.source) } } : {}),
      })),
      sources: res.sources.map(Session.wireEvidence),
    };
  }

  async findSchedule(kind: string) {
    const g = await this.ensureGraph();
    if (!g.available) throw new UserError("This set has no text layer (a scan) — the sheet graph is unavailable.");
    const k = (kind || "").toLowerCase();
    const want = /room/.test(k) ? "room-finish" : /finish|material|product|code|mark/.test(k) ? "finish" : k;
    const hits = g.tables.filter((t) => t.kind === want);
    if (!hits.length) {
      const found = g.tables.map((t) => `${t.kind} on ${t.sheet}`).join(" | ");
      throw new UserError(`No ${JSON.stringify(kind)} schedule found in the set. Found: ${found || "no schedules at all"}.`);
    }
    return {
      matches: hits.map((t) => ({
        sheet: t.sheet, kind: t.kind, title: t.title?.text || "", rows: t.rows.length,
        headers: t.headers, region: Session.wireBox(t.region),
        ...(t.building ? { building: t.building } : {}),
        ...(t.rotated_headers ? { rotated_headers: true } : {}),
        ...(t.parts ? { parts: t.parts.map((p) => ({ sheet: p.sheet, title: p.title, rows: p.rows, region: Session.wireBox(p.region) })) } : {}),
      })),
    };
  }

  readSheetText(name: string, region?: { x0: number; y0: number; x1: number; y1: number }) {
    const s = this.sheet(name);
    const items = region
      ? s.text.filter((t) => t.x >= region.x0 && t.x <= region.x1 && t.y >= region.y0 && t.y <= region.y1)
      : s.text;
    return { sheet: s.key, items, text: items.map((t) => t.str).join(" ") };
  }

  /** LOCATE a known string — the complement to readSheetText (which returns
   * what a region SAYS; this finds WHERE a string you already know sits).
   * Case-insensitive substring match per pdf.js text run, so a room label
   * split across runs ("OFFICE" then "134" as separate items) needs its own
   * find_text call per fragment, or read_sheet_text over a region to see the
   * whole thing at once — this tool doesn't merge runs into lines. Reuses the
   * bbox spans sheet_context lazily builds (same cache, same textSpans()
   * call), so calling both on one sheet costs the extraction once. */
  findText(name: string, q: string, opts: { region?: { x0: number; y0: number; x1: number; y1: number }; limit?: number } = {}) {
    const query = q.trim();
    if (!query) throw new UserError("q must be a non-empty string.");
    const s = this.sheet(name);
    if (!s.spans) s.spans = textSpans(s.page);
    const r = opts.region;
    const needle = query.toLowerCase();
    const limit = opts.limit ?? 200;
    const all = s.spans.filter((sp) => sp.str.toLowerCase().includes(needle)
      && (!r || (sp.x0 <= r.x1 && sp.x1 >= r.x0 && sp.y0 <= r.y1 && sp.y1 >= r.y0)));
    const hits = all.slice(0, limit).map((sp) => ({
      str: sp.str,
      bbox: [sp.x0, sp.y0, sp.x1, sp.y1] as [number, number, number, number],
      center: [round1((sp.x0 + sp.x1) / 2), round1((sp.y0 + sp.y1) / 2)] as [number, number],
    }));
    return { sheet: s.key, q: query, count: all.length, truncated: all.length > hits.length, hits };
  }
}
