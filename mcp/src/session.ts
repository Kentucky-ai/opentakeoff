// One-document session state: the loaded plan, per-sheet scale + lazy geometry
// caches, and the in-memory takeoff (conditions + shapes). All coordinates are
// image px at RENDER_SCALE = 2.0 (PDF pt × 2, origin top-left, y down) — the
// browser canvas's native space. Shapes and conditions are field-identical to
// what the canvas commits (web/src/pages/TakeoffCanvas.jsx), so an exported
// takeoff round-trips into the app.
import path from "node:path";
import { openPdf, positionedText, textSpans, OPS, type DocHandle, type PageHandle, type TextSpan } from "./pdf.ts";
import { UserError, round1, round2 } from "./format.ts";
import { STANDARD_SCALES, RENDER_SCALE, detectScale, extractSheetNumber, type DetectedScale } from "../../web/src/lib/sheets.ts";
import {
  extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea,
  hatchFamilies, MASK_MAX_DIM, SENS_BALANCED, type MaskObj, type VectorGeometry, type Point, type HatchFamily,
} from "../../web/src/lib/oneclick.ts";
import { ROOM_LABEL_RE, seedLadderPx, isLabelBubblePx, type LabelBBox } from "../../web/src/lib/detectRooms.ts";
import { buildSnapGrid, nearestSnap, closedMetrics, openLen } from "../../web/src/lib/geometry.js";
import { conditionTotals, grandTotals } from "../../web/src/lib/totals.js";
import { gridPxPerFoot, drawGrid, drawShapes, type Ctx2D, type ToCanvas } from "./view.ts";

// Copied from the canvas (web/src/pages/TakeoffCanvas.jsx) so conditions and
// snap behavior minted here are identical to the browser's. PALETTE/HATCH_IDS
// are user data — never re-theme them.
const SNAP_CELL = 24; // snap-grid bucket, raster px
const SNAP_TOL = 7;   // one-click vertex-snap tolerance, image px
const PALETTE = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2"];
const HATCH_IDS = ["solid", "diag", "diag2", "cross", "diagdense", "horiz", "vert", "grid", "brick", "plank", "herring", "basket", "checker", "wave", "fleur", "speckle"];
// uid mirrors web/src/lib/provenance.js mintUuid: crypto.randomUUID is a
// global in Node 20+, with the same non-secure-context fallback the browser
// build carries so the two sides mint identically-shaped ids.
const mintUuid = (): string =>
  (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const uid = (p: string): string => `${p}-${mintUuid()}`;

export const ANN_SCHEMA = "opentakeoff.takeoff_canvas.v1"; // web/src/lib/store.js

export type MeasureRole = "floor_area" | "deduct" | "linear";

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
  computed: { area_sf: number; perimeter_lf: number };
  origin?: ShapeOrigin;
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
  | { op: "materials"; tool: string; condition_id: string; before: MaterialRow[] };

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
  private doc: DocHandle | null = null;
  private sheets = new Map<string, SheetState>();
  conditions: Condition[] = [];
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
    this.file = null;
    // the journal's entries reference shapes that no longer exist — undoing
    // across a document swap would be a lie, so the history goes with them
    this.journal = [];
    this.pendingCommits = [];

    const doc = await openPdf(filePath);
    this.doc = doc;
    this.file = path.basename(filePath);
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
    }
    return s.geo;
  }

  /** v1 masks come from the sheet's vector linework only. Raster seam: a scanned
   * sheet would render via a node canvas into a future rastermask module that
   * returns this same MaskObj shape. */
  async ensureMask(name: string): Promise<MaskObj | null> {
    const s = this.sheet(name);
    if (s.mask === undefined) {
      const geo = await this.ensureGeometry(s);
      s.mask = geo.segs.length ? buildMask(geo.segs, s.widthPx, s.heightPx, MASK_MAX_DIM, geo.meta) : null;
    }
    return s.mask;
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

  async oneClick(name: string, x: number, y: number, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean; sensitivity?: number }) {
    const s = this.sheet(name);
    const mask = await this.ensureMask(name);
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
  async detectRooms(name: string, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean; minAreaSf?: number; sensitivity?: number }) {
    const s = this.sheet(name);
    const mask = await this.ensureMask(name);
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
    type Cand = { label: string; ring: Point[]; areaPx2: number; perimPx: number; seed: readonly [number, number] | number[]; hatch: boolean; merged: string[] };
    const byRing = new Map<string, Cand>();
    const order: Cand[] = [];
    for (const lb of labels) {
      let ring: Point[] | null = null, hatch = false, seed: [number, number] | null = null;
      let sawBubble = false, sawDegenerate = false;
      for (const probe of seedLadderPx(lb.bbox)) {
        const f = floodRegion(mask, probe[0], probe[1], opts.sensitivity ?? SENS_BALANCED);
        if (f.status !== "ok") continue;
        const r = snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
        if (r.length < 3) { sawDegenerate = true; continue; }
        if (isLabelBubblePx(r as [number, number][], lb.bbox)) { sawBubble = true; continue; }
        ring = r; hatch = !!f.hatchFiltered; seed = probe;
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
        seed, hatch, merged: [],
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
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    const upp = s.upp;
    const role = patch.role ?? cur.measure_role;

    // Geometry: either the supplied verts or the shape's own, back in image px.
    const vertsPx: Point[] = patch.verts
      ?? cur.verts_norm.map(([x, y]) => [x * s.widthPx, y * s.heightPx] as Point);
    const minPts = role === "linear" ? 2 : 3;
    if (vertsPx.length < minPts) {
      throw new UserError(`A ${role === "linear" ? "linear shape needs at least 2 points" : "closed shape needs at least 3 vertices"} — got ${vertsPx.length}.`);
    }

    // Quantities are always recomputed from the resulting geometry AND role, so
    // a role flip alone re-measures correctly (open length vs closed area).
    const computed = role === "linear"
      ? { area_sf: 0, perimeter_lf: round2(openLen(vertsPx) * upp) }
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
      markups: [],
      sheet_group: [],
      last_group: [],
      sheet_tabs: [],
      sheet_levels: {},
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
