// DXF export — the takeoff's geometry as native CAD entities, so a marked
// floor lands in AutoCAD (or any DXF reader) as real polylines on named
// layers, not as a picture. One file per sheet: a sheet IS a drawing.
//
// Coordinates: the sheet's own frame, in real units. verts_norm normalizes
// against the pdf.js viewport at RENDER_SCALE (`dims`, the same frame
// computeShapeMetrics prices against), and `upp` is feet per px at that same
// baseline — so x = nx·w·upp, y = (1−ny)·h·upp puts the origin at the sheet's
// BOTTOM-left with Y up (CAD convention; the sheet's Y grows downward), and a
// polygon's area here equals its area in the Report to rounding. Feet by
// default ($INSUNITS 2); `units: "m"` writes metres ($INSUNITS 6).
//
// Layers carry the finish: `OT-<TAG>` for floor rings, with role suffixes
// (-DEDUCT, -HOLE, -WALL, -LINEAR, -COUNT) so a CAD user can isolate any
// bucket with one layer filter. Each condition gets its own ACI color; the
// suffix layers share it. Room labels (#112) land as TEXT on OT-LABELS at the
// ring's centroid. A deduct that was reconciled INTO a parent as a hole
// (cuts_shape_id) is skipped — its ring already ships as that parent's -HOLE.
//
// Format: DXF R2000 (AC1015) — the oldest version that carries LWPOLYLINE,
// and the one every reader from AutoCAD 2000 to LibreCAD accepts. R2000
// wants handles on every table, record, block and entity, a root dictionary,
// and a plot-style placeholder for the layer table; all of that is written
// here so the file passes a strict audit (ezdxf's), not just AutoCAD's
// lenient loader. Pure: no DOM, no React — node tests and the MCP server
// both call it.

import { flattenCurve } from "./curve.js";

export interface DxfShape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role: "floor_area" | "deduct" | "surface_area" | "linear" | "count" | string;
  verts_norm: [number, number][];
  verts_norm_holes?: [number, number][][];
  curved?: boolean;
  cuts_shape_id?: string;
  label?: string;
}

export interface DxfCondition {
  id: string;
  finish_tag?: string;
  name?: string;
}

export interface DxfSheetInput {
  sheet_id: string;
  /** Human sheet name for the header comment (title-block number, tab label). */
  label?: string;
  /** Logical image size — pdf.js viewport at RENDER_SCALE, the verts_norm frame. */
  dims: { w: number; h: number };
  /** Feet per px at that same frame. */
  upp: number;
  shapes: DxfShape[];
  conditions: DxfCondition[];
}

export interface DxfOptions {
  /** Output units. Feet (default) or metres. */
  units?: "ft" | "m";
  /** Room-label text height in output units (default 1 ft / 0.3 m). */
  text_height?: number;
}

export interface DxfBuild {
  dxf: string;
  /** Layer names in table order (excluding "0"). */
  layers: string[];
  /** Entities written to model space (polylines, circles, texts). */
  entities: number;
  /** Shapes that produced at least one entity. */
  shapes: number;
  /** Shapes left out, with the reason — a DXF that silently drops a ring is a lie. */
  skipped: { id: string; reason: string }[];
  /** Model-space extents in output units, or null when nothing was written. */
  extents: { min: [number, number]; max: [number, number] } | null;
}

/** First line of every DXF this module writes — the authorship stamp the MCP
 * overwrite guard (safewrite.ts) recognizes, and plain provenance. */
export const DXF_STAMP = "OpenTakeoff DXF export";
export const DXF_MIME = "application/dxf";

const FT_PER_M = 1 / 0.3048;

// ACI palette per condition — distinct, all visible on black and white
// model space. Index 7 (white/black) deliberately absent from the cycle.
const CONDITION_COLORS = [5, 3, 1, 2, 4, 6, 30, 40, 90, 150, 200, 210, 32, 92, 172, 12];
const COLOR_LABELS = 7;
const COLOR_HOLE = 8;

/** A finish tag as a DXF layer name: the characters R2000 forbids in symbol
 * names (<>/\":;?*|,=`) become "-", runs collapse, upper-cased, capped, and an
 * empty tag lands on UNTAGGED rather than on layer "0" (which would hide the
 * takeoff among the plan's own linework). */
export function dxfLayerName(tag: string | undefined | null, suffix?: string): string {
  let base = String(tag ?? "").trim().replace(/[<>\/\\":;?*|,=`]+/g, "-").replace(/\s+/g, " ").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").toUpperCase();
  if (!base) base = "UNTAGGED";
  if (base.length > 48) base = base.slice(0, 48).replace(/-$/, "");
  return suffix ? `OT-${base}-${suffix}` : `OT-${base}`;
}

// ---------------------------------------------------------------------------
// writer

const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return (Object.is(r, -0) ? 0 : r).toString();
};

class Dxf {
  private out: string[] = [];
  private seed = 0x20;
  handle(): string { return (this.seed++).toString(16).toUpperCase(); }
  peek(): string { return this.seed.toString(16).toUpperCase(); }
  add(code: number | string, value: string | number): void { this.out.push(String(code), String(value)); }
  text(): string { return this.out.join("\n") + "\n"; }
}

function polygonCentroid(pts: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    // degenerate — fall back to the vertex mean so the label still lands
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

export function buildSheetDxf(sheet: DxfSheetInput, opts: DxfOptions = {}): DxfBuild {
  const units = opts.units === "m" ? "m" : "ft";
  const k = units === "m" ? 1 / FT_PER_M : 1;               // output units per foot
  const textH = opts.text_height ?? (units === "m" ? 0.3 : 1);
  const { w, h } = sheet.dims;
  const upp = sheet.upp;
  if (!(w > 0) || !(h > 0)) throw new Error(`DXF: sheet ${sheet.sheet_id} has no image dimensions`);
  if (!(upp > 0)) throw new Error(`DXF: sheet ${sheet.sheet_id} has no scale — set the scale before exporting to CAD`);

  const toXY = ([nx, ny]: [number, number]): [number, number] => [nx * w * upp * k, (1 - ny) * h * upp * k];
  const toPx = ([nx, ny]: [number, number]): [number, number] => [nx * w, ny * h];
  const fromPx = ([px, py]: [number, number]): [number, number] => [px * upp * k, (h - py) * upp * k];

  const condById = new Map(sheet.conditions.map((c) => [c.id, c]));
  const condColor = new Map<string, number>();
  sheet.conditions.forEach((c, i) => condColor.set(c.id, CONDITION_COLORS[i % CONDITION_COLORS.length]));

  // Pass 1 — resolve every shape on this sheet into entities, collecting the
  // layer set first (the LAYER table precedes ENTITIES in the file).
  type Ent =
    | { kind: "lwpoly"; layer: string; pts: [number, number][]; closed: boolean }
    | { kind: "circle"; layer: string; c: [number, number]; r: number }
    | { kind: "text"; layer: string; at: [number, number]; text: string; height: number };
  const ents: Ent[] = [];
  const layers = new Map<string, number>();   // name → ACI color, insertion-ordered
  const useLayer = (name: string, color: number) => { if (!layers.has(name)) layers.set(name, color); return name; };
  const skipped: DxfBuild["skipped"] = [];
  let shapesOut = 0;
  const ext = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = ([x, y]: [number, number]) => { if (x < ext.minX) ext.minX = x; if (x > ext.maxX) ext.maxX = x; if (y < ext.minY) ext.minY = y; if (y > ext.maxY) ext.maxY = y; };

  for (const s of sheet.shapes) {
    if (s.sheet_id !== sheet.sheet_id) continue;
    const cond = condById.get(s.condition_id);
    const tag = cond?.finish_tag || cond?.name || "";
    const color = condColor.get(s.condition_id) ?? COLOR_LABELS;
    const verts = Array.isArray(s.verts_norm) ? s.verts_norm : [];
    const role = s.measure_role;
    const before = ents.length;

    if (role === "count") {
      const c = verts[0];
      if (!c) { skipped.push({ id: s.id, reason: "count mark without a position" }); continue; }
      const at = toXY(c);
      ents.push({ kind: "circle", layer: useLayer(dxfLayerName(tag, "COUNT"), color), c: at, r: 0.5 * k });
      grow([at[0] - 0.5 * k, at[1] - 0.5 * k]); grow([at[0] + 0.5 * k, at[1] + 0.5 * k]);
    } else if (role === "surface_area" || role === "linear") {
      if (verts.length < 2) { skipped.push({ id: s.id, reason: `${role} shape with fewer than 2 vertices` }); continue; }
      const px = verts.map(toPx);
      const run = role === "linear" && s.curved ? flattenCurve(px) : px;
      const pts = run.map(fromPx);
      pts.forEach(grow);
      ents.push({ kind: "lwpoly", layer: useLayer(dxfLayerName(tag, role === "linear" ? "LINEAR" : "WALL"), color), pts, closed: false });
    } else if (role === "floor_area" || role === "deduct") {
      if (role === "deduct" && s.cuts_shape_id) { skipped.push({ id: s.id, reason: `deduct reconciled into ${s.cuts_shape_id} — ships as that ring's hole` }); continue; }
      if (verts.length < 3) { skipped.push({ id: s.id, reason: `${role} ring with fewer than 3 vertices` }); continue; }
      const pts = verts.map(toXY);
      pts.forEach(grow);
      const layer = useLayer(role === "deduct" ? dxfLayerName(tag, "DEDUCT") : dxfLayerName(tag), color);
      ents.push({ kind: "lwpoly", layer, pts, closed: true });
      for (const ring of s.verts_norm_holes || []) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        const hp = ring.map(toXY);
        hp.forEach(grow);
        ents.push({ kind: "lwpoly", layer: useLayer(dxfLayerName(tag, "HOLE"), COLOR_HOLE), pts: hp, closed: true });
      }
      if (role === "floor_area" && s.label && String(s.label).trim()) {
        ents.push({ kind: "text", layer: useLayer("OT-LABELS", COLOR_LABELS), at: polygonCentroid(pts), text: String(s.label).trim(), height: textH });
      }
    } else {
      skipped.push({ id: s.id, reason: `unknown measure_role "${role}"` });
      continue;
    }
    if (ents.length > before) shapesOut++;
  }

  const hasExt = Number.isFinite(ext.minX);
  const extents: DxfBuild["extents"] = hasExt ? { min: [ext.minX, ext.minY], max: [ext.maxX, ext.maxY] } : null;

  // Pass 2 — write. Handles first for the records other records point at.
  const d = new Dxf();
  const H = {
    vportTbl: d.handle(), vportActive: d.handle(),
    ltypeTbl: d.handle(), ltByBlock: d.handle(), ltByLayer: d.handle(), ltCont: d.handle(),
    layerTbl: d.handle(), layer0: d.handle(),
    styleTbl: d.handle(), styleStd: d.handle(),
    viewTbl: d.handle(), ucsTbl: d.handle(),
    appidTbl: d.handle(), appidAcad: d.handle(),
    dimTbl: d.handle(), dimStd: d.handle(),
    brTbl: d.handle(), brModel: d.handle(), brPaper: d.handle(),
    blkModel: d.handle(), endModel: d.handle(), blkPaper: d.handle(), endPaper: d.handle(),
    rootDict: d.handle(), groupDict: d.handle(), plotDict: d.handle(), plotPlaceholder: d.handle(),
  };
  const layerHandles = new Map<string, string>();
  for (const name of layers.keys()) layerHandles.set(name, d.handle());
  const entHandles = ents.map(() => d.handle());

  // comment stamp — first line, so a 4 KB head read identifies our own file
  d.add(999, `${DXF_STAMP} — sheet ${sheet.label || sheet.sheet_id} — units ${units === "m" ? "metres" : "feet"} — origin bottom-left of sheet, Y up`);

  // HEADER
  d.add(0, "SECTION"); d.add(2, "HEADER");
  d.add(9, "$ACADVER"); d.add(1, "AC1015");
  d.add(9, "$HANDSEED"); d.add(5, d.peek());
  d.add(9, "$INSUNITS"); d.add(70, units === "m" ? 6 : 2);
  d.add(9, "$MEASUREMENT"); d.add(70, units === "m" ? 1 : 0);
  d.add(9, "$LUNITS"); d.add(70, units === "m" ? 2 : 4);
  d.add(9, "$EXTMIN"); d.add(10, fmt(hasExt ? ext.minX : 0)); d.add(20, fmt(hasExt ? ext.minY : 0)); d.add(30, 0);
  d.add(9, "$EXTMAX"); d.add(10, fmt(hasExt ? ext.maxX : w * upp * k)); d.add(20, fmt(hasExt ? ext.maxY : h * upp * k)); d.add(30, 0);
  d.add(9, "$LIMMIN"); d.add(10, 0); d.add(20, 0);
  d.add(9, "$LIMMAX"); d.add(10, fmt(w * upp * k)); d.add(20, fmt(h * upp * k));
  d.add(9, "$CLAYER"); d.add(8, "0");
  d.add(9, "$PDMODE"); d.add(70, 0);
  d.add(0, "ENDSEC");

  // CLASSES (empty — nothing here needs a custom class)
  d.add(0, "SECTION"); d.add(2, "CLASSES"); d.add(0, "ENDSEC");

  // TABLES
  d.add(0, "SECTION"); d.add(2, "TABLES");
  const table = (name: string, handle: string, count: number) => {
    d.add(0, "TABLE"); d.add(2, name); d.add(5, handle); d.add(330, "0"); d.add(100, "AcDbSymbolTable"); d.add(70, count);
  };
  const record = (type: string, handle: string, owner: string, sub: string) => {
    d.add(0, type); d.add(5, handle); d.add(330, owner); d.add(100, "AcDbSymbolTableRecord"); d.add(100, sub);
  };
  const endtab = () => d.add(0, "ENDTAB");

  // VPORT — one *Active viewport centred on the drawing so "open" shows the takeoff
  table("VPORT", H.vportTbl, 1);
  record("VPORT", H.vportActive, H.vportTbl, "AcDbViewportTableRecord");
  d.add(2, "*Active"); d.add(70, 0);
  d.add(10, 0); d.add(20, 0); d.add(11, 1); d.add(21, 1);
  const cx = hasExt ? (ext.minX + ext.maxX) / 2 : (w * upp * k) / 2;
  const cy = hasExt ? (ext.minY + ext.maxY) / 2 : (h * upp * k) / 2;
  const vh = hasExt ? Math.max(ext.maxY - ext.minY, (ext.maxX - ext.minX) / 1.6, 1) * 1.1 : h * upp * k;
  d.add(12, fmt(cx)); d.add(22, fmt(cy));
  d.add(13, 0); d.add(23, 0); d.add(14, 10); d.add(24, 10); d.add(15, 10); d.add(25, 10);
  d.add(16, 0); d.add(26, 0); d.add(36, 1); d.add(17, 0); d.add(27, 0); d.add(37, 0);
  d.add(40, fmt(vh)); d.add(41, 1.6); d.add(42, 50); d.add(43, 0); d.add(44, 0); d.add(50, 0); d.add(51, 0);
  d.add(71, 0); d.add(72, 100); d.add(73, 1); d.add(74, 3); d.add(75, 0); d.add(76, 0); d.add(77, 0); d.add(78, 0);
  endtab();

  table("LTYPE", H.ltypeTbl, 3);
  for (const [hd, name, desc] of [[H.ltByBlock, "ByBlock", ""], [H.ltByLayer, "ByLayer", ""], [H.ltCont, "Continuous", "Solid line"]] as const) {
    record("LTYPE", hd, H.ltypeTbl, "AcDbLinetypeTableRecord");
    d.add(2, name); d.add(70, 0); d.add(3, desc); d.add(72, 65); d.add(73, 0); d.add(40, 0);
  }
  endtab();

  table("LAYER", H.layerTbl, layers.size + 1);
  const layerRec = (hd: string, name: string, color: number) => {
    record("LAYER", hd, H.layerTbl, "AcDbLayerTableRecord");
    d.add(2, name); d.add(70, 0); d.add(62, color); d.add(6, "Continuous"); d.add(370, -3); d.add(390, H.plotPlaceholder);
  };
  layerRec(H.layer0, "0", 7);
  for (const [name, color] of layers) layerRec(layerHandles.get(name)!, name, color);
  endtab();

  table("STYLE", H.styleTbl, 1);
  record("STYLE", H.styleStd, H.styleTbl, "AcDbTextStyleTableRecord");
  d.add(2, "Standard"); d.add(70, 0); d.add(40, 0); d.add(41, 1); d.add(50, 0); d.add(71, 0); d.add(42, 0.2); d.add(3, "txt"); d.add(4, "");
  endtab();

  table("VIEW", H.viewTbl, 0); endtab();
  table("UCS", H.ucsTbl, 0); endtab();

  table("APPID", H.appidTbl, 1);
  record("APPID", H.appidAcad, H.appidTbl, "AcDbRegAppTableRecord");
  d.add(2, "ACAD"); d.add(70, 0);
  endtab();

  // DIMSTYLE — the table record's handle rides group 105, not 5
  d.add(0, "TABLE"); d.add(2, "DIMSTYLE"); d.add(5, H.dimTbl); d.add(330, "0"); d.add(100, "AcDbSymbolTable"); d.add(70, 1); d.add(100, "AcDbDimStyleTable");
  d.add(0, "DIMSTYLE"); d.add(105, H.dimStd); d.add(330, H.dimTbl); d.add(100, "AcDbSymbolTableRecord"); d.add(100, "AcDbDimStyleTableRecord");
  d.add(2, "Standard"); d.add(70, 0); d.add(340, H.styleStd);
  endtab();

  table("BLOCK_RECORD", H.brTbl, 2);
  for (const [hd, name] of [[H.brModel, "*Model_Space"], [H.brPaper, "*Paper_Space"]] as const) {
    record("BLOCK_RECORD", hd, H.brTbl, "AcDbBlockTableRecord");
    d.add(2, name); d.add(340, "0");
  }
  endtab();
  d.add(0, "ENDSEC");

  // BLOCKS — the two mandatory layout blocks, empty
  d.add(0, "SECTION"); d.add(2, "BLOCKS");
  const block = (name: string, br: string, begin: string, end: string, paper: boolean) => {
    d.add(0, "BLOCK"); d.add(5, begin); d.add(330, br); d.add(100, "AcDbEntity"); if (paper) d.add(67, 1); d.add(8, "0"); d.add(100, "AcDbBlockBegin");
    d.add(2, name); d.add(70, 0); d.add(10, 0); d.add(20, 0); d.add(30, 0); d.add(3, name); d.add(1, "");
    d.add(0, "ENDBLK"); d.add(5, end); d.add(330, br); d.add(100, "AcDbEntity"); if (paper) d.add(67, 1); d.add(8, "0"); d.add(100, "AcDbBlockEnd");
  };
  block("*Model_Space", H.brModel, H.blkModel, H.endModel, false);
  block("*Paper_Space", H.brPaper, H.blkPaper, H.endPaper, true);
  d.add(0, "ENDSEC");

  // ENTITIES — model space
  d.add(0, "SECTION"); d.add(2, "ENTITIES");
  ents.forEach((e, i) => {
    const hd = entHandles[i];
    if (e.kind === "lwpoly") {
      d.add(0, "LWPOLYLINE"); d.add(5, hd); d.add(330, H.brModel); d.add(100, "AcDbEntity"); d.add(8, e.layer); d.add(100, "AcDbPolyline");
      d.add(90, e.pts.length); d.add(70, e.closed ? 1 : 0); d.add(43, 0);
      for (const [x, y] of e.pts) { d.add(10, fmt(x)); d.add(20, fmt(y)); }
    } else if (e.kind === "circle") {
      d.add(0, "CIRCLE"); d.add(5, hd); d.add(330, H.brModel); d.add(100, "AcDbEntity"); d.add(8, e.layer); d.add(100, "AcDbCircle");
      d.add(10, fmt(e.c[0])); d.add(20, fmt(e.c[1])); d.add(30, 0); d.add(40, fmt(e.r));
    } else {
      d.add(0, "TEXT"); d.add(5, hd); d.add(330, H.brModel); d.add(100, "AcDbEntity"); d.add(8, e.layer); d.add(100, "AcDbText");
      d.add(10, fmt(e.at[0])); d.add(20, fmt(e.at[1])); d.add(30, 0); d.add(40, fmt(e.height)); d.add(1, e.text.replace(/[\r\n]+/g, " "));
      d.add(72, 1); d.add(11, fmt(e.at[0])); d.add(21, fmt(e.at[1])); d.add(31, 0);
      d.add(100, "AcDbText"); d.add(73, 2);
    }
  });
  d.add(0, "ENDSEC");

  // OBJECTS — root dictionary, the group dictionary, and the plot-style
  // placeholder the layer records point at
  d.add(0, "SECTION"); d.add(2, "OBJECTS");
  d.add(0, "DICTIONARY"); d.add(5, H.rootDict); d.add(330, "0"); d.add(100, "AcDbDictionary"); d.add(281, 1);
  d.add(3, "ACAD_GROUP"); d.add(350, H.groupDict);
  d.add(3, "ACAD_PLOTSTYLENAME"); d.add(350, H.plotDict);
  d.add(0, "DICTIONARY"); d.add(5, H.groupDict); d.add(330, H.rootDict); d.add(100, "AcDbDictionary"); d.add(281, 1);
  d.add(0, "ACDBDICTIONARYWDFLT"); d.add(5, H.plotDict); d.add(330, H.rootDict); d.add(100, "AcDbDictionary"); d.add(281, 1);
  d.add(3, "Normal"); d.add(350, H.plotPlaceholder); d.add(100, "AcDbDictionaryWithDefault"); d.add(340, H.plotPlaceholder);
  d.add(0, "ACDBPLACEHOLDER"); d.add(5, H.plotPlaceholder); d.add(330, H.plotDict);
  d.add(0, "ENDSEC");
  d.add(0, "EOF");

  return { dxf: d.text(), layers: [...layers.keys()], entities: ents.length, shapes: shapesOut, skipped, extents };
}

/** File name for a sheet's DXF: `<project>_<sheet>.dxf`, filesystem-safe. */
export function dxfFileName(base: string, sheetLabel: string): string {
  const clean = (s: string) => String(s || "").trim().replace(/[\/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").replace(/^\.+/, "");
  const b = clean(base) || "takeoff";
  const s = clean(sheetLabel);
  return s ? `${b}_${s}.dxf` : `${b}.dxf`;
}
