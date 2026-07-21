// One-document session state: the loaded plan, per-sheet scale + lazy geometry
// caches, and the in-memory takeoff (conditions + shapes). All coordinates are
// image px at RENDER_SCALE = 2.0 (PDF pt × 2, origin top-left, y down) — the
// browser canvas's native space. Shapes and conditions are field-identical to
// what the canvas commits (web/src/pages/TakeoffCanvas.jsx), so an exported
// takeoff round-trips into the app.
import path from "node:path";
import { openPdf, positionedText, OPS, type DocHandle, type PageHandle } from "./pdf.ts";
import { UserError, round1, round2 } from "./format.ts";
import { STANDARD_SCALES, RENDER_SCALE, detectScale, extractSheetNumber, type DetectedScale } from "../../web/src/lib/sheets.ts";
import {
  extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea,
  MASK_MAX_DIM, type MaskObj, type VectorGeometry, type Point,
} from "../../web/src/lib/oneclick.ts";
import { roomLabelSeeds, detectRegions } from "../../web/src/lib/detectRooms.ts";
import { buildSnapGrid, nearestSnap, closedMetrics, openLen } from "../../web/src/lib/geometry.js";
import { conditionTotals, grandTotals } from "../../web/src/lib/totals.js";

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

export interface Condition {
  id: string;
  finish_tag: string;
  color: string;
  fill: string;
  hatch: string;
  multiplier: number;
  waste_pct: number;
  materials: unknown[];
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
}

/** Resource images cap their long edge here: the largest edge the mainstream
 * vision models take without downscaling — these renders exist to be looked at
 * by agents, so this is the native resolution of that audience. */
export const IMAGE_MAX_EDGE = 1568;

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

  /** load_plan replaces the session's document: the old doc is destroyed and
   * ALL state — scales, caches, conditions, shapes — is cleared. */
  async loadPlan(filePath: string) {
    if (this.doc) await this.doc.destroy().catch(() => {});
    this.doc = null;
    this.sheets.clear();
    this.conditions = [];
    this.shapes = [];
    this.file = null;

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
    return shape;
  }

  async oneClick(name: string, x: number, y: number, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean }) {
    const s = this.sheet(name);
    const mask = await this.ensureMask(name);
    if (!mask) throw new UserError("This sheet has no vector linework (likely a scan); raster fallback not yet available in the MCP server.");
    const f = floodRegion(mask, x, y);
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
      }).id;
    }
    return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id } : {}) };
  }

  /** Batch room detection: read every room-number label off the sheet's text
   *  layer, seed the existing One-Click flood at each, and trace/commit
   *  exactly like oneClick — just N of them from one call instead of N
   *  reasoning-heavy round-trips. Same contract as oneClick: no scale → a
   *  px-only preview per room; no condition → nothing commits (a review
   *  pass, not a proposal-acceptance gate — this server has none). A region
   *  that traces to a degenerate ring (<3 verts) is dropped from the batch
   *  rather than failing the whole call — one bad label must not sink every
   *  other clean detection on the sheet. */
  async detectRooms(name: string, opts: { condition?: string; role: "floor_area" | "deduct"; returnVerts: boolean }) {
    const s = this.sheet(name);
    const mask = await this.ensureMask(name);
    if (!mask) throw new UserError("This sheet has no vector linework (likely a scan); raster fallback not yet available in the MCP server.");
    const seeds = roomLabelSeeds(s.text);
    const regions = detectRegions(mask, seeds);
    const rooms = regions
      .map((r) => {
        const ring = snapVertices(traceRegion(r.flood), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
        if (ring.length < 3) return null; // couldn't trace into a polygon — drop, don't sink the batch
        const areaPx2 = ringArea(ring);
        const perimPx = closedMetrics(ring).perim;
        const common = {
          label: r.str,
          nverts: ring.length,
          ...(r.flood.hatchFiltered ? { hatch_filtered: true as const } : {}),
          ...(opts.returnVerts ? { verts: ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
        };
        if (s.upp == null) {
          return { ...common, area_px2: round1(areaPx2), perimeter_px: round1(perimPx) };
        }
        const upp = s.upp;
        const area_sf = round2(areaPx2 * upp * upp);
        const perimeter_lf = round2(perimPx * upp);
        let shape_id: string | undefined;
        if (opts.condition) {
          shape_id = this.commit(s, opts.condition, opts.role, ring, { area_sf, perimeter_lf }, {
            method: "one_click_v1",
            actor: "agent",
            seed_norm: [r.seed[0] / s.widthPx, r.seed[1] / s.heightPx],
            reviewed: false,
            ...(r.flood.hatchFiltered ? { hatch_filtered: true as const } : {}),
          }).id;
        }
        return { ...common, area_sf, perimeter_lf, ...(shape_id ? { shape_id } : {}) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return {
      detected: rooms.length,
      rooms,
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
    return { area_sf, perimeter_lf, nverts: verts.length, ...(shape_id ? { shape_id } : {}) };
  }

  measureLine(name: string, pts: Point[], opts: { condition?: string }) {
    const s = this.sheet(name);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    const length_lf = round2(openLen(pts) * s.upp);
    let shape_id: string | undefined;
    // area_sf stays 0 — the canvas only mints border SF when the condition has a thickness
    if (opts.condition) shape_id = this.commit(s, opts.condition, "linear", pts, { area_sf: 0, perimeter_lf: length_lf }, { method: "manual", actor: "agent" }).id;
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
    this.shapes.splice(i, 1);
    return { deleted: id, shape_count: this.shapes.length };
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
}
