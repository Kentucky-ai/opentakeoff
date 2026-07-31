// One-document session state: the loaded plan, per-sheet scale + lazy geometry
// caches, and the in-memory takeoff (conditions + shapes). All coordinates are
// image px at RENDER_SCALE = 2.0 (PDF pt × 2, origin top-left, y down) — the
// browser canvas's native space. Shapes and conditions are field-identical to
// what the canvas commits (web/src/pages/TakeoffCanvas.jsx), so an exported
// takeoff round-trips into the app.
import path from "node:path";
import { openPdf, positionedText, textSpans, OPS, type DocHandle, type PageHandle, type TextSpan, type OcgEntry } from "./pdf.ts";
import { classifyLayerName, layerRoleCodes, segRoles, type LayerInfo } from "../../web/src/lib/layers.ts";
import { buildSheetGraph, resolveTag, type SheetGraph, type SheetSpans } from "../../web/src/lib/sheetgraph.ts";
import { UserError, round1, round2 } from "./format.ts";
import { STANDARD_SCALES, RENDER_SCALE, detectScale, extractSheetNumber, type DetectedScale } from "../../web/src/lib/sheets.ts";
import {
  extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea,
  hatchFamilies, MASK_MAX_DIM, SENS_BALANCED, type MaskObj, type VectorGeometry, type Point, type HatchFamily,
} from "../../web/src/lib/oneclick.ts";
import { ROOM_LABEL_RE, seedLadderPx, isLabelBubblePx, type LabelBBox } from "../../web/src/lib/detectRooms.ts";
import { buildSnapGrid, nearestSnap, closedMetrics, openLen } from "../../web/src/lib/geometry.js";
import { conditionTotals, grandTotals, sheetTotals, reportJson } from "../../web/src/lib/totals.js";
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
  materials: MaterialRow[];
}

/** Shape provenance (contribution.v2 vocabulary — mirrors the canvas +
 * web/src/lib/provenance.js). Truthfulness rules: `actor` is omitted for a
 * human at the canvas and "agent" for MCP/automation; `reviewed` is true ONLY
 * after a human affirmed the shape at an explicit review gate — this server
 * has no such gate, so everything it commits is reviewed: false. */
export interface ShapeOrigin {
  method: "manual" | "one_click_v1" | "agent_v1";
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
  type: "cloud" | "text" | "callout" | "highlight";
  text: string;
  condition_id: string;
  rfi_id: string;
  at?: [number, number];
  target?: [number, number];
  rect?: [[number, number], [number, number]];
  created_at?: string;
}

interface SheetState {
  key: string;
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
  | { op: "condition"; tool: string; condition_id: string; before: { waste_pct: number; multiplier: number; height_ft?: number } };

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
  /** Absolute path the plan was loaded from — the marked-set export re-reads
   * the source bytes here to vector-copy pages (pdf.js never hands them back). */
  filePath: string | null = null;
  private doc: DocHandle | null = null;
  private sheets = new Map<string, SheetState>();
  conditions: Condition[] = [];
  markups: Markup[] = [];
  shapes: Shape[] = [];

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

  /** load_plan replaces the session's document: the old doc is destroyed and
   * ALL state — scales, caches, conditions, shapes — is cleared. */
  async loadPlan(filePath: string) {
    if (this.doc) await this.doc.destroy().catch(() => {});
    this.doc = null;
    this.sheets.clear();
    this.conditions = [];
    this.shapes = [];
    this.markups = [];
    this.file = null;
    this.filePath = null;
    // the journal's entries reference shapes that no longer exist — undoing
    // across a document swap would be a lie, so the history goes with them
    this.journal = [];
    this.pendingCommits = [];
    this.graph = null;   // the sheet graph (#87) indexes the OLD document

    const doc = await openPdf(filePath);
    this.doc = doc;
    this.file = path.basename(filePath);
    this.filePath = path.resolve(filePath);
    for (let n = 1; n <= doc.numPages; n++) {
      const ph = await doc.page(n);
      // sheet-key codec: page 1 = bare file name, pages 2+ = "name#page"
      // (parseSheetKey in web/src/lib/sheets.ts is the inverse)
      const key = n === 1 ? this.file : `${this.file}#${n}`;
      this.sheets.set(key, {
        key,
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
      });
    }
    return {
      file: this.file,
      page_count: doc.numPages,
      sheets: [...this.sheets.values()].map(sheetSummary),
      note: "Replaced the previous session — all prior scales, conditions, and shapes were cleared.",
    };
  }

  sheet(name: string): SheetState {
    if (!this.doc) throw new UserError("No plan loaded — call load_plan first.");
    const hit = this.sheets.get(name);
    if (hit) return hit;
    // convenience: accept the title-block sheet number (e.g. "A-101") too
    const wanted = name.toUpperCase().replace(/\s+/g, "");
    for (const s of this.sheets.values()) if (s.sheetNumber === wanted) return s;
    throw new UserError(`Unknown sheet "${name}" — loaded sheets: ${[...this.sheets.keys()].join(", ")}.`);
  }

  /** Resource-URI addressing: sheets by 1-based page number. */
  sheetForPage(page: number): SheetState {
    if (!this.doc) throw new UserError("No plan loaded — call load_plan first.");
    for (const s of this.sheets.values()) if (s.pageNum === page) return s;
    throw new UserError(`No page ${page} — the loaded plan has pages 1–${this.sheets.size}.`);
  }

  /** Every loaded sheet, in page order — [] before any plan loads. */
  sheetList(): SheetState[] {
    return [...this.sheets.values()].sort((a, b) => a.pageNum - b.pageNum);
  }

  /** The takeoff://sheets index payload — cheap (no geometry is built). */
  index() {
    if (!this.doc) {
      return { file: null, page_count: 0, sheets: [], hint: "No plan loaded — call the load_plan tool with a PDF path, then list resources again." };
    }
    return {
      file: this.file,
      page_count: this.sheets.size,
      sheets: this.sheetList().map((s) => ({
        ...sheetSummary(s),
        scale_set: s.upp != null,
        shape_count: this.shapes.filter((x) => x.sheet_id === s.key).length,
      })),
    };
  }

  /** Rendered-page PNG, long edge capped at IMAGE_MAX_EDGE (never above the
   * canvas-native RENDER_SCALE), cached per sheet until the next load_plan. */
  async renderSheetPng(page: number): Promise<Uint8Array> {
    const s = this.sheetForPage(page);
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
      if (layerIds.length && this.doc) {
        const byId = new Map((await this.doc.layers()).map((g) => [g.id, g]));
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

  /** v1 masks come from the sheet's vector linework only. Raster seam: a scanned
   * sheet would render via a node canvas into a future rastermask module that
   * returns this same MaskObj shape. Layer roles (#85) ride in as the stated
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

  async sheetInfo(name: string) {
    const s = this.sheet(name);
    const geo = await this.ensureGeometry(s);
    return {
      ...sheetSummary(s),
      seg_count: geo.segs.length >> 2,
      has_vector_linework: geo.segs.length > 0,
      scale_set: s.upp != null,
      ...(s.upp != null ? { upp: s.upp } : {}),
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
    return { sheet: s.key, upp, ...(label ? { label } : {}), source };
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
    const mask = await this.maskWithLayers(name, opts.layers);
    if (!mask) throw new UserError("This sheet has no vector linework (likely a scan); raster fallback not yet available in the MCP server.");
    const f = floodRegion(mask, x, y, opts.sensitivity ?? SENS_BALANCED);
    if (f.status === "leak") throw new UserError("That space isn't enclosed on the plan linework — the fill spilled through a gap or opening.");
    if (f.status !== "ok") throw new UserError("Landed in dense linework (hatching or text).");
    const ring = snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
    if (ring.length < 3) throw new UserError("Couldn't trace that space into a polygon.");
    const areaPx2 = ringArea(ring);
    const perimPx = closedMetrics(ring).perim;
    const common = {
      status: "ok" as const,
      nverts: ring.length,
      ...(f.hatchFiltered ? { hatch_filtered: true } : {}),
      ...(f.gapBridged ? { gap_bridged_px: f.gapBridged } : {}),
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
        // #85 — a trace bounded by DECLARED boundary layers is categorically
        // stronger evidence than one bounded by a pitch heuristic
        ...((s.layers || []).some((l) => l.visible && (l.role === "boundary" || l.role === "structure")) ? { layer_bounded: true as const } : {}),
        // canvas-parity provenance: a non-default fill sensitivity is part of
        // how the shape was made (ShapeOrigin.fill_sensitivity)
        ...(opts.sensitivity !== undefined && opts.sensitivity !== SENS_BALANCED ? { fill_sensitivity: opts.sensitivity } : {}),
      }).id;
    }
    this.flushCommits("one_click");
    return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id } : {}) };
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
  async detectRooms(name: string, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean; minAreaSf?: number; sensitivity?: number; layers?: { include?: string[]; exclude?: string[] } }) {
    const s = this.sheet(name);
    const mask = await this.maskWithLayers(name, opts.layers);
    if (!mask) throw new UserError("This sheet has no vector linework (likely a scan); raster fallback not yet available in the MCP server.");
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
    const withheld = { degenerate: 0, duplicate: 0, bubble: 0, implausible: 0 };
    type Cand = { label: string; ring: Point[]; areaPx2: number; perimPx: number; seed: readonly [number, number] | number[]; hatch: boolean; gap: number; merged: string[] };
    const byRing = new Map<string, Cand>();
    const order: Cand[] = [];
    for (const lb of labels) {
      let ring: Point[] | null = null, hatch = false, gap = 0, seed: [number, number] | null = null;
      let sawBubble = false, sawDegenerate = false;
      for (const probe of seedLadderPx(lb.bbox)) {
        const f = floodRegion(mask, probe[0], probe[1], opts.sensitivity ?? SENS_BALANCED);
        if (f.status !== "ok") continue;
        const r = snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
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
          ...(opts.returnVerts ? { verts: c.ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
        };
        if (upp == null) {
          return { ...common, area_px2: round1(c.areaPx2), perimeter_px: round1(c.perimPx) };
        }
        const area_sf = round2(c.areaPx2 * upp * upp);
        if (area_sf < minAreaSf) { withheld.implausible++; return null; }
        const perimeter_lf = round2(c.perimPx * upp);
        let shape_id: string | undefined;
        if (opts.condition) {
          shape_id = this.commit(s, opts.condition, opts.role, c.ring, { area_sf, perimeter_lf }, {
            method: "one_click_v1",
            actor: "agent",
            seed_norm: [c.seed[0] / s.widthPx, c.seed[1] / s.heightPx],
            reviewed: false,
            ...(c.hatch ? { hatch_filtered: true as const } : {}),
            ...(c.gap ? { gap_bridged_px: c.gap } : {}),
          }).id;
        }
        return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id } : {}) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    this.flushCommits("detect_rooms"); // the whole sweep is one reversible step
    const withheldTotal = withheld.degenerate + withheld.duplicate + withheld.bubble + withheld.implausible;
    return {
      detected: rooms.length,
      rooms,
      withheld: {
        total: withheldTotal,
        ...withheld,
        ...(upp != null ? { min_area_sf: minAreaSf } : {}),
      },
      ...(withheldTotal
        ? { note: `${withheldTotal} seed(s) withheld — ${withheld.duplicate} duplicate region(s), ${withheld.bubble} label-bubble(s), ${withheld.implausible} under ${minAreaSf} SF, ${withheld.degenerate} untraceable.` }
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
    return { area_sf, perimeter_lf, nverts: verts.length, ...(shape_id ? { shape_id } : {}) };
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

  /** Count markers — the canvas's Count tool (commitCount): one point, one EA,
   * computed {count: 1}, NO scale required (EA is scale-free; the canvas's
   * recompute skips count shapes for the same reason). One shape per point,
   * the whole call one journal gesture — undoing a placement sweep is one step,
   * matching detect_rooms. */
  placeCount(name: string, points: Point[], opts: { condition: string }) {
    const s = this.sheet(name);
    const ids = points.map(([x, y]) => this.commit(s, opts.condition, "count", [[x, y]], { count: 1 }, { method: "manual", actor: "agent" }).id);
    this.flushCommits("place_count");
    const c = this.conditions.find((x) => x.finish_tag === opts.condition)!;
    const ea_total = this.shapes
      .filter((x) => x.condition_id === c.id && x.measure_role === "count")
      .reduce((n, x) => n + (x.computed.count || 1), 0);
    return { committed: ids.length, shape_ids: ids, condition: c.finish_tag, ea_total };
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
      ...(cur.origin ? { origin: { ...cur.origin, agent_edits: (cur.origin.agent_edits ?? 0) + 1 } } : {}),
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
  editCondition(tag: string, opts: { waste_pct?: number; multiplier?: number; height_ft?: number }) {
    if (opts.waste_pct === undefined && opts.multiplier === undefined && opts.height_ft === undefined) {
      throw new UserError("Nothing to change — pass at least one of waste_pct, multiplier, height_ft.");
    }
    const c = this.conditions.find((x) => x.finish_tag === tag);
    if (!c) {
      const known = this.conditions.map((x) => x.finish_tag);
      throw new UserError(`No condition ${JSON.stringify(tag)}.${known.length ? ` Known tags: ${known.join(", ")}.` : " Nothing has minted a condition yet — commit a measurement or add materials first."}`);
    }
    const before = { waste_pct: c.waste_pct, multiplier: c.multiplier, height_ft: c.height_ft };
    if (opts.waste_pct !== undefined) c.waste_pct = opts.waste_pct;
    if (opts.multiplier !== undefined) c.multiplier = opts.multiplier;
    if (opts.height_ft !== undefined) c.height_ft = opts.height_ft;
    this.record({ op: "condition", tool: "edit_condition", condition_id: c.id, before });
    return { condition: tag, condition_id: c.id, waste_pct: c.waste_pct, multiplier: c.multiplier, ...(c.height_ft !== undefined ? { height_ft: c.height_ft } : {}) };
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
        }
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
  annotate(a: { sheet: string; type: Markup["type"]; text: string; at?: Point; target?: Point; rect?: [Point, Point]; condition?: string }): Record<string, unknown> {
    const s = this.sheet(a.sheet);
    const n = ([x, y]: Point): [number, number] => [x / s.widthPx, y / s.heightPx];
    if ((a.type === "cloud" || a.type === "highlight") && !a.rect) throw new UserError(`a ${a.type} needs rect: [[x0,y0],[x1,y1]] in image px`);
    if ((a.type === "text" || a.type === "callout") && !a.at) throw new UserError(`a ${a.type} needs at: [x,y] in image px`);
    if (a.type === "callout" && !a.target) throw new UserError("a callout needs target: [x,y] — the point the leader line aims at");
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
    };
    this.markups.push(m);
    return {
      id: m.id, sheet: s.key, type: m.type, text: m.text,
      condition: cond?.finish_tag ?? "", condition_id: m.condition_id,
      note: cond
        ? `Attached to ${cond.finish_tag} — it wears that condition's colour on the canvas and in the marked set.`
        : "Unattached — a note about the sheet. Pass condition to tie it to a scope.",
    };
  }

  /** Read annotations, optionally narrowed to a sheet and/or a condition.
   *  Resolves condition_id to its finish tag so a caller can act on the reply
   *  without joining against the conditions array. */
  listAnnotations(f: { sheet?: string; condition?: string } = {}): Record<string, unknown> {
    const tagById = new Map(this.conditions.map((c) => [c.id, c.finish_tag]));
    let rows = this.markups;
    if (f.sheet) { const s = this.sheet(f.sheet); rows = rows.filter((m) => m.sheet_id === s.key); }
    if (f.condition) {
      const c = this.conditions.find((x) => x.finish_tag === f.condition);
      if (!c) throw new UserError(`no condition "${f.condition}" — tags: ${this.conditions.map((x) => x.finish_tag).join(", ") || "(none)"}`);
      rows = rows.filter((m) => m.condition_id === c.id);
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
      })),
      count: rows.length,
      unattached: rows.filter((m) => !m.condition_id).length,
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

  /** The exact browser save payload (TakeoffCanvas.jsx autosave + the schema key
   * store.saveAnnotations stamps) — importable by the app. */
  exportPayload() {
    if (!this.doc) throw new UserError("No plan loaded — call load_plan first.");
    return {
      schema: ANN_SCHEMA,
      project_name: "",
      units: "imperial",
      sheets: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({ sheet_id: s.key, units_per_px: s.upp })),
      conditions: this.conditions,
      shapes: this.shapes,
      markups: this.markups,
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
    if (!this.doc) throw new UserError("No plan loaded — call load_plan first.");
    const rows = (conditionTotals(this.conditions, this.shapes) as Record<string, unknown>[]).filter((r) => (r.shape_count as number) > 0);
    return reportJson({
      projectName,
      rows,
      bySheet: sheetTotals(this.conditions, this.shapes),
      scaleInfo: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({ sheet_id: s.key, scale_source: s.scaleSource ?? "unknown" })),
      markups: this.markups,
      rfis: [],
    });
  }

  // ── the sheet graph (#87) ─────────────────────────────────────────────────
  // Built lazily from every sheet's text spans, cached per document (loadPlan
  // clears it). The engine is pure (web/src/lib/sheetgraph.ts); this is the
  // span plumbing plus the wire shapes.
  private graph: SheetGraph | null = null;

  private async ensureGraph(): Promise<SheetGraph> {
    if (!this.doc) throw new UserError("No plan loaded — call load_plan first.");
    if (!this.graph) {
      const inputs: SheetSpans[] = [];
      for (const s of this.sheets.values()) {
        if (!s.spans) s.spans = textSpans(s.page);
        inputs.push({
          key: s.key,
          sheet_number: s.sheetNumber,
          spans: s.spans.map((t) => ({ str: t.str, x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 })),
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
        schedules: s.schedules.map((t) => ({ kind: t.kind, title: t.title, rows: t.rows, region: Session.wireBox(t.region) })),
      })),
      rooms: g.rooms.map((r) => ({ tag: r.tag, name: r.name, sheet: r.sheet, bbox: Session.wireBox(r.bbox) })),
      callouts: g.callouts.map((c) => ({ detail: c.detail, target_sheet: c.target_sheet, sheet: c.sheet, bbox: Session.wireBox(c.bbox) })),
      counts: { rooms: g.rooms.length, schedules: g.tables.length, callouts: g.callouts.length },
    };
  }

  async resolveRoomTag(tag: string) {
    if (!tag || !tag.trim()) throw new UserError("Pass a room tag, e.g. resolve_tag { tag: \"134\" }.");
    const g = await this.ensureGraph();
    if (!g.available) throw new UserError("This set has no text layer (a scan) — the sheet graph is unavailable, not empty.");
    const res = resolveTag(g, tag);
    const room = res.room ? { tag: res.room.tag, name: res.room.name, sheet: res.room.sheet, bbox: Session.wireBox(res.room.bbox) } : null;
    if (res.status === "unresolved") return { status: "unresolved" as const, tag: res.tag, room, reason: res.reason };
    return {
      status: "resolved" as const,
      tag: res.tag,
      room,
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
