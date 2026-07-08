// Takeoff Canvas — Phase 1 (+ pan/zoom + standard scales).
// Persistent, condition-driven 2D takeoff. Pick a color-coded condition (finish
// tag), click to trace areas; each shape computes SF + perimeter from geometry ×
// calibrated scale. Drawings + scale autosave per project and reload on return.
// Commit sums each condition into ScopeItem.measure and re-runs the takeoff.
//
// Pan/zoom is written DIRECTLY to the DOM (tfRef → style.transform) so dragging
// never triggers a React render — smooth on large sheets. Trackpad two-finger
// scroll pans (any tool); pinch (ctrl-wheel) zooms; Space-drag / middle-drag pan.
// Geometry math reads tfRef (always current), so drawing stays accurate.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { store, isStaleTabError, STALE_TAB_MESSAGE } from "../lib/store.js";
import { ingestFiles } from "../lib/ingest.js";
import ToolMenu from "../components/ToolMenu.jsx";
import SheetGallery from "../components/SheetGallery.jsx";
import ReportPanel from "../components/ReportPanel.jsx";
import SnapshotPanel from "../components/SnapshotPanel.jsx";
import { Icon } from "../brand/icons.jsx";
import { RENDER_SCALE, MAX_GROUP, STANDARD_SCALES, parseSheetKey, compareSheetKeys, extractSheetNumber, detectScale } from "../lib/sheets";
import { extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea, MASK_MAX_DIM } from "../lib/oneclick";
import { conditionTotals, verticalWallSf } from "../lib/totals.js";
import { sanitizeConditionColumns, sanitizeConditionAttrs, renameColumnValue, attrValue, columnLabel } from "../lib/conditionColumns.js";
import { buildMarkedSetPdf, downloadBytes } from "../lib/markedset.js";
import { loadCompany } from "../lib/identity.js";
import { starPath, cloudPath, buildSnapGrid, nearestSnap, ANGLE_TOL, angleSnap, closedMetrics, openLen, pointInPoly, hitShape } from "../lib/geometry.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.03;
const MAX_SCALE = 32;  // stage zoom is in raster px — with the 28MP base budget this keeps ≈ the old deep-zoom ceiling (detail view carries the crispness)
const PANEL_GAP = 48;  // px between side-by-side sheets in a multi-sheet group
// Base raster: enough density for fit-to-view + the first stretch of zoom; sharpness
// past 1:1 comes from the DETAIL VIEW (region re-render), never from a giant full-sheet
// bitmap. Rastering to the browser caps would put a 36×24" sheet at 179MP ≈ 716MB of
// backing store per panel — a 4-up ≈ 2.9GB, which Chrome silently fails to keep
// composited (blank sheet at zoom-out, evicted chrome). Quantities are scale-free
// (verts are normalized and the render factor cancels in the area math), so the budget
// only trades memory for base-layer sharpness. Hi-Res opts a sheet INTO the auto
// budget per-user (the default stays the lean baseline raster).
const QUALITY_CEILING = 8.0;                  // hard cap on render scale (≈576 px/in) — binds only on small pages now
const MAX_CANVAS_DIM  = 16384;                // safe max side for a single canvas (Chrome/Firefox/Safari desktop)
const MAX_CANVAS_AREA = 16384 * 16384 * 0.9;  // per-canvas pixel cap — the DETAIL view's density factor uses this
const MAX_PANEL_AREA  = 28e6;                 // base-raster pixel budget per panel (~112MB RGBA; 4-up ≈ 450MB)
// Largest pdf.js render scale a wPt×hPt-point page can use within the base budget;
// never below the baseline RENDER_SCALE, never above the ceiling.
const autoRenderScale = (wPt, hPt) => {
  if (!(wPt > 0 && hPt > 0)) return RENDER_SCALE;
  const byDim  = Math.min(MAX_CANVAS_DIM / wPt, MAX_CANVAS_DIM / hPt);
  const byArea = Math.sqrt(MAX_PANEL_AREA / (wPt * hPt));
  return Math.max(RENDER_SCALE, Math.min(QUALITY_CEILING, byDim, byArea));
};
// Detail view: once zoomed past the base raster's 1:1 IN DEVICE PIXELS, we overlay a
// crop of JUST the visible region, re-rendered from the PDF vectors at the current zoom —
// Bluebeam/AutoCAD-style. Crispness becomes unbounded (up to the per-region canvas cap)
// without ever holding a giant full-sheet bitmap; the region is ~viewport-sized so the cap
// effectively never binds. Engage compares t.scale × devicePixelRatio (softness starts
// when the raster is upscaled in device px — on a 2× display that's t.scale 0.5, not 1).
const DETAIL_ENGAGE = 1.15;  // engage once stage zoom × dpr passes ~1.15 (base raster starts to soften)
const DETAIL_MARGIN = 0.5;   // render this much extra region beyond the viewport so small pans don't expose the soft base at the edges
const SYNC_MS = 90;          // React tf-mirror sync cadence during gestures (~11Hz)
const GESTURE_MS = 140;      // wheel/pinch quiet window before the detail view re-renders
const COLORS = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#475569"];

// Architectural / flooring hatch templates. Each condition gets a line color, a
// fill color (or No Fill), and one hatch style — rendered as an SVG <pattern> so
// finishes read like a real drawing.
const HATCHES = [
  { id: "solid", label: "Solid" },
  { id: "diag", label: "Diagonal" },
  { id: "diag2", label: "Diagonal reverse" },
  { id: "cross", label: "Crosshatch" },
  { id: "diagdense", label: "Diagonal dense" },
  { id: "horiz", label: "Horizontal" },
  { id: "vert", label: "Vertical" },
  { id: "grid", label: "Square / tile" },
  { id: "brick", label: "Brick / running bond" },
  { id: "plank", label: "Plank / wood" },
  { id: "herring", label: "Herringbone" },
  { id: "basket", label: "Basketweave" },
  { id: "checker", label: "Checker" },
  { id: "wave", label: "Wave / scallop" },
  { id: "dots", label: "Sand / dots" },
  { id: "speckle", label: "Terrazzo / speckle" },
];
const PALETTE = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2"];
const NO_FILL = "none";

// Docked Takeoffs panel geometry — per-user UI prefs (localStorage, diff-only
// overrides like the report column prefs), NEVER in the takeoff payload: panel
// width inside buildPayload would show up as noise in every snapshot diff.
const PANEL_PREFS_KEY = "opentakeoff_panel";
const PANEL_DEFAULTS = { w: 320, collapsed: false, strip: false, az: false, group: false };
// tag family = the text before the dash (CPT-1 → CPT) — the grouping key for
// the panel's grouped view. VIEW-ONLY, like sort and search: the conditions
// array order is canonical (1–9 hotkeys are positional and the payload
// serializes it), so nothing here ever reorders the array itself.
const tagFamily = (t) => (String(t || "").split("-")[0].trim().toUpperCase() || "—");
const natCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
const PANEL_MIN_W = 240;
const PANEL_MAX_W = 560;

// SVG <pattern> for a condition (userSpaceOnUse → scales with the plan, CAD-style).
// Invert a canvas's pixels in place: one difference-with-white pass (an
// involution — applying it again flips back). This is how the negative/dark
// view works: pixel inversion costs one pass at draw time, where a CSS
// `filter: invert(1)` would make every sheet canvas a permanently-filtered
// compositor layer re-processed on every frame — with several panels open on
// a hi-Hz display that chain overloads the compositor (layer eviction =
// flicker/void glitches).
function invertCanvasPixels(cv) {
  if (!cv || !cv.width || !cv.height) return;
  const ctx = cv.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // raw device px — ignore any render transform
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();
}

function HatchPattern({ id, type, line, fill, dark }) {
  const sw = 1.1;
  // dark mode legibility comes from brighter alphas baked into the pattern —
  // never a CSS filter over the shape overlay (that re-rasterizes the whole
  // layer on every sync)
  const bg = fill && fill !== NO_FILL ? <rect width={10} height={10} fill={fill} opacity={dark ? 0.32 : 0.18} /> : null;
  const s = (d) => <path d={d} stroke={line} strokeWidth={sw} fill="none" />;
  const wrap = (kids) => <pattern id={id} patternUnits="userSpaceOnUse" width={10} height={10}>{bg}{kids}</pattern>;
  switch (type) {
    case "diag": return wrap(s("M0,10 L10,0 M-3,3 L3,-3 M7,13 L13,7"));
    case "diag2": return wrap(s("M0,0 L10,10 M-3,7 L3,13 M7,-3 L13,3"));
    case "cross": return wrap(<>{s("M0,10 L10,0 M-3,3 L3,-3 M7,13 L13,7")}{s("M0,0 L10,10 M-3,7 L3,13 M7,-3 L13,3")}</>);
    case "diagdense": return wrap(s("M0,5 L5,0 M0,10 L10,0 M5,10 L10,5 M-2.5,2.5 L2.5,-2.5 M7.5,12.5 L12.5,7.5"));
    case "horiz": return wrap(s("M0,3 L10,3 M0,7 L10,7"));
    case "vert": return wrap(s("M3,0 L3,10 M7,0 L7,10"));
    case "grid": return wrap(s("M0,3 L10,3 M0,7 L10,7 M3,0 L3,10 M7,0 L7,10"));
    case "brick": return wrap(<>{s("M0,3 L10,3 M0,7 L10,7")}{s("M5,0 L5,3 M0,3 L0,7 M10,3 L10,7 M5,7 L5,10")}</>);
    case "plank": return wrap(<>{s("M0,0 L10,0 M0,5 L10,5 M0,10 L10,10")}{s("M3,0 L3,5 M7,5 L7,10")}</>);
    case "herring": return wrap(<>{s("M0,5 L5,0 L10,5")}{s("M0,10 L5,5 L10,10")}</>);
    case "basket": return wrap(<>{s("M0,2 L5,2 M0,4 L5,4")}{s("M7,0 L7,5 M9,0 L9,5")}{s("M2,5 L2,10 M4,5 L4,10")}{s("M5,7 L10,7 M5,9 L10,9")}</>);
    case "checker": return wrap(<>{<rect x={0} y={0} width={5} height={5} fill={line} opacity={0.4} />}{<rect x={5} y={5} width={5} height={5} fill={line} opacity={0.4} />}</>);
    case "wave": return wrap(<>{s("M0,4 Q2.5,1 5,4 T10,4")}{s("M0,8 Q2.5,5 5,8 T10,8")}</>);
    case "dots": return wrap(<>{[2, 6].map((y) => [2, 6].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} fill={line} />))}</>);
    case "speckle": return wrap(<>{[[1.5, 2, 1.3], [6, 1.5, 0.8], [3.5, 5, 1], [8, 5.5, 1.4], [1.5, 8, 0.9], [6.5, 8.5, 1.2]].map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fill={line} />)}</>);
    default: return wrap(null);  // solid: only the fill bg
  }
}

// Preview swatch — renders the ACTUAL pattern so the picker always matches the draw.
function HatchSwatch({ type, line, fill }) {
  const fc = fill && fill !== NO_FILL ? fill : null;
  const pid = `sw-${type}-${String(line).replace("#", "")}-${String(fill).replace("#", "")}`;
  return (
    <svg width="26" height="18" style={{ display: "block", overflow: "hidden" }}>
      {type !== "solid" && <defs><HatchPattern id={pid} type={type} line={line} fill={fill} /></defs>}
      <rect x="0.5" y="0.5" width="25" height="17" stroke="#a39e8d"
        fill={type === "solid" ? (fc || "#fff") : `url(#${pid})`}
        fillOpacity={type === "solid" ? (fc ? 0.45 : 1) : 1} />
    </svg>
  );
}

let _idn = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(_idn++).toString(36)}`;
const clamp = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
// Pure geometry helpers (star/cloud paths, snap grid, angle lock, metrics,
// hit-testing) live in lib/geometry.js — byte-identical with Spline's copy.
const SNAP_CELL = 24;   // snap-grid bucket, raster px (Spline runs 12 — its budgeted raster is denser)

// toolbar menus — STACK-style: the menu face shows the armed tool
const MEASURE_TOOLS = [
  { id: "oneclick", icon: "oneClick", label: "One-Click Area", shortcut: "O" },
  { id: "area", icon: "area", label: "Area", shortcut: "A" },
  { id: "rect", icon: "rectTool", label: "Rectangle", shortcut: "R" },
  { id: "linear", icon: "linear", label: "Linear", shortcut: "L" },
  { id: "surface", icon: "surface", label: "Surface Area", shortcut: "S" },
  { id: "count", icon: "count", label: "Count", shortcut: "C" },
];
const CUT_TOOLS = [
  { id: "deduct", icon: "deduct", label: "Deduct shape", shortcut: "D" },
  { id: "deduct-rect", icon: "deductRect", label: "Deduct rectangle", shortcut: "⇧D" },
];
const MARKUP_TOOLS = [
  { id: "cloud", icon: "cloud", label: "Revision cloud" },
  { id: "callout", icon: "callout", label: "Callout" },
  { id: "text", icon: "textNote", label: "Text note" },
];
const MARKUP_IDS = MARKUP_TOOLS.map((t) => t.id);

// Flooring-first starter conditions seeded on a fresh workspace — line color +
// hatch chosen to read like the real finish; waste % is a sensible default you
// can change per condition (it's never auto-applied to the live readout, only
// the Report). Delete any you don't need.
// Each default also carries a couple of editable starter materials — quantities
// derive deterministically from measured area/linear ÷ a coverage rate you set
// (off the product data sheet). Delete/edit freely; they're just sensible seeds.
// Adhesive coverage by trowel notch, SF per gallon. Typical wood-adhesive range is
// ~40–70 SF/gal: a wider/coarser notch lays more glue and covers less per gallon.
// Picking a notch fills the coverage rate + notes it. Always verify against the
// current product data sheet for your subfloor + flooring type.
const TROWEL_PRESETS = [
  { label: "fine",     per: 70 },
  { label: "medium",   per: 58 },
  { label: "standard", per: 50 },
  { label: "coarse",   per: 40 },
];
const isAdhesive = (name) => /adhes|glue|bond|mastic/i.test(name || "");

const FLOORING_DEFAULTS = [
  { tag: "CPT-1", color: "#2f7d54", hatch: "speckle", waste: 5,  mats: [{ name: "Adhesive", per: 250, basis: "area", unit: "gal" }] },                                    // Carpet tile
  { tag: "BRD-1", color: "#be185d", hatch: "dots",    waste: 10, mats: [{ name: "Adhesive", per: 120, basis: "area", unit: "gal" }] },                                    // Broadloom carpet (roll goods)
  { tag: "LVT-1", color: "#b8860b", hatch: "plank",   waste: 8,  mats: [{ name: "Adhesive", per: 250, basis: "area", unit: "gal" }] },                                    // Luxury vinyl plank/tile
  { tag: "WD-1",  color: "#9a3412", hatch: "plank",   waste: 10, mats: [                                                                                                  // Unfinished 2.25″ solid red oak — glue-down + site-finished
    { name: "Adhesive (wood, SMP)",     per: 50,  basis: "area", unit: "gal", note: "standard notch · SMP, solid wood" },
    { name: "Sealer (primer coat)",     per: 400, basis: "area", unit: "gal", note: "1 prime coat (~10 m²/L)" },
    { name: "Polyurethane (2K finish)", per: 136, basis: "area", unit: "gal", note: "≈3 coats @ ~408 SF/gal/coat (2K 10:1)" },
  ] },
  { tag: "VCT-1", color: "#2563eb", hatch: "checker", waste: 5,  mats: [{ name: "Adhesive", per: 350, basis: "area", unit: "gal" }] },                                    // Vinyl composition tile
  { tag: "SV-1",  color: "#0d9488", hatch: "solid",   waste: 10, mats: [{ name: "Adhesive", per: 150, basis: "area", unit: "gal" }] },                                    // Sheet vinyl
  { tag: "CT-1",  color: "#9333ea", hatch: "grid",    waste: 10, mats: [{ name: "Thinset", per: 95, basis: "area", unit: "bag" }, { name: "Grout", per: 120, basis: "area", unit: "bag" }] }, // Ceramic / porcelain tile
  { tag: "RB-1",  color: "#475569", hatch: "horiz",   waste: 5,  mats: [{ name: "Cove base adhesive", per: 40, basis: "linear", unit: "tube" }] },                        // Rubber / resilient wall base (linear)
  { tag: "TR-1",  color: "#c96442", hatch: "vert",    waste: 0,  mats: [] },                                                                                              // Transitions / reducers (linear)
];
// A template is a condition minus ids (finish_tag, colors, hatch, waste,
// H/T params, materials) — instantiation mints fresh condition/material ids.
const instantiateTemplate = (t) => ({
  id: uid("cnd"), finish_tag: t.finish_tag || "?",
  color: t.color || PALETTE[0], fill: t.fill ?? t.color ?? PALETTE[0],
  hatch: t.hatch || "solid", multiplier: 1, waste_pct: Number(t.waste_pct) || 0,
  ...(t.height_ft != null ? { height_ft: t.height_ft } : {}),
  ...(t.thickness_in != null ? { thickness_in: t.thickness_in } : {}),
  materials: (t.materials || []).map((m) => ({ round: true, ...m, id: uid("mat") })),
});
// Fresh-workspace seeding reads the user's template library first; the
// built-in flooring defaults are only the empty-library fallback.
function seedConditions(library) {
  if (Array.isArray(library) && library.length) return library.map(instantiateTemplate);
  return FLOORING_DEFAULTS.map((d) => ({
    id: uid("cnd"), finish_tag: d.tag, color: d.color, fill: d.color,
    hatch: d.hatch, multiplier: 1, waste_pct: d.waste,
    materials: (d.mats || []).map((m) => ({ id: uid("mat"), round: true, ...m })),
  }));
}

// Editable supporting-materials rows — the assembly behind a condition. Shared
// by the top-bar editor and the Takeoffs side panel so the two never drift.
function MaterialsEditor({ materials, onAdd, onUpdate, onRemove }) {
  const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
  return (
    <>
      {(materials || []).map((m) => (
        <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          <input value={m.name} onChange={(e) => onUpdate(m.id, { name: e.target.value })} placeholder="Material (e.g. Adhesive)" style={{ ...ip, width: 160 }} />
          <span style={{ color: "var(--ink-muted)" }}>1</span>
          <input value={m.unit} onChange={(e) => onUpdate(m.id, { unit: e.target.value })} placeholder="unit" style={{ ...ip, width: 60 }} />
          <span style={{ color: "var(--ink-muted)" }}>per</span>
          <input type="number" min="0" step="any" value={m.per || ""} onChange={(e) => onUpdate(m.id, { per: Math.max(0, parseFloat(e.target.value) || 0) })} placeholder="0" style={{ ...ip, width: 66 }} />
          <select value={m.basis || "area"} onChange={(e) => onUpdate(m.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)" }}>
            <option value="area">floor SF</option>
            <option value="linear">linear LF</option>
            <option value="count">each</option>
          </select>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-muted)" }} title="Round up to whole units (you buy whole buckets/bags)">
            <input type="checkbox" checked={m.round !== false} onChange={(e) => onUpdate(m.id, { round: e.target.checked })} />round up
          </label>
          {isAdhesive(m.name) && (m.basis || "area") === "area" && (
            <select value={TROWEL_PRESETS.some((t) => t.label === m.note) ? m.note : ""}
              onChange={(e) => { const t = TROWEL_PRESETS.find((x) => x.label === e.target.value); if (t) onUpdate(m.id, { note: t.label, per: t.per }); }}
              title="Trowel notch — sets the adhesive coverage (SF/gal). Verify against the data sheet."
              style={{ ...ip, background: "var(--paper-bright)" }}>
              <option value="">trowel…</option>
              {TROWEL_PRESETS.map((t) => <option key={t.label} value={t.label}>{t.label} · {t.per} SF/gal</option>)}
            </select>
          )}
          <input value={m.note || ""} onChange={(e) => onUpdate(m.id, { note: e.target.value })} placeholder="note (coats, trowel…)" style={{ ...ip, width: 150 }} />
          <button onClick={() => onRemove(m.id)} title="Remove this material"
            style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
      ))}
      <button onClick={onAdd}
        style={{ marginTop: 2, padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+ add material</button>
    </>
  );
}

// Per-condition custom-column assignment — one select per defined column.
// Shared by the edit-bar strip and the Takeoffs side panel so the two never
// drift. Unassigned = attrs key absent; a value deleted from the vocabulary
// keeps the condition's string, shown as "<value> (removed)".
function ColumnSelects({ columns, cond, onAssign }) {
  const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, background: "var(--paper-bright)" };
  return (
    <>
      {columns.map((cc) => {
        const v = attrValue(cond?.attrs, cc.id);   // the shared assigned-value rule (hydrate sanitizes, this keeps the display consistent)
        return (
          <label key={cc.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 12, marginBottom: 6 }}>
            <span style={{ color: "var(--ink-muted)" }}>{columnLabel(cc)}</span>
            <select value={v} onChange={(e) => onAssign(cc.id, e.target.value)} style={ip}>
              <option value="">Unassigned</option>
              {cc.values.map((val) => <option key={val} value={val}>{val}</option>)}
              {v && !cc.values.includes(v) && <option value={v}>{v} (removed)</option>}
            </select>
          </label>
        );
      })}
    </>
  );
}

// add-value input for the column manager — local draft state, commit on Enter/+
function AddValueInput({ onAdd }) {
  const [v, setV] = useState("");
  const commit = () => { const t = v.trim(); if (t) onAdd(t); setV(""); };
  const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && commit()} placeholder="add value" style={{ ...ip, width: 90 }} />
      <button onClick={commit} title="Add this value to the list"
        style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+</button>
    </span>
  );
}

export default function TakeoffCanvas() {
  // Client-only: a single local workspace in this browser (no project id, no backend).
  const [sheets, setSheets] = useState([]);
  const [active, setActive] = useState("");      // active source PDF file name
  const [page, setPage] = useState(1);           // 1-based page within the active PDF
  const [pageCount, setPageCount] = useState(1); // pages in the active PDF
  const [view, setView] = useState("canvas");    // "gallery" overlays the canvas (gallery-first on empty projects)
  const [openTabs, setOpenTabs] = useState([]);   // sheetKeys open as tabs across the top
  const [galleryLabels, setGalleryLabels] = useState({}); // sheetKey → title-block number, all files
  const [pageLabels, setPageLabels] = useState({}); // { pageNum: "A003" } from the title block
  const [sheetGroup, setSheetGroup] = useState([]);   // sheetKeys shown side-by-side; [] = single-sheet mode
  const [lastGroup, setLastGroup] = useState([]);     // most recent side-by-side composition — "Regroup" restores it
  const [focusKey, setFocusKey] = useState("");         // panel of the last click — scale/calibrate target in group mode
  const [hatchOpen, setHatchOpen] = useState(false);         // hatch picker popover (declutters the properties block)
  const [markups, setMarkups] = useState([]);                // cloud/callout/text annotations (separate from measurement shapes)
  const [markupDraft, setMarkupDraft] = useState(null);      // in-progress markup first point (cloud/callout)
  const [showMarkupPanel, setShowMarkupPanel] = useState(false);
  // Docked Takeoffs panel (right side, reflows the canvas): width + collapsed
  // persist per user in localStorage as diffs against PANEL_DEFAULTS.
  const [panelPrefs, setPanelPrefs] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}");
      return { ...PANEL_DEFAULTS, ...(p && typeof p === "object" && !Array.isArray(p) ? p : {}) };
    } catch { return { ...PANEL_DEFAULTS }; }
  });
  const [panelMatOpen, setPanelMatOpen] = useState(false);    // assemblies editor expanded inline under the active row in the Takeoffs panel
  const [condQuery, setCondQuery] = useState("");             // live filter over the panel's condition list (transient, never persisted)
  const [closedGroups, setClosedGroups] = useState(() => new Set()); // collapsed tag-family groups in the panel's grouped view
  // multi-select for bulk edit — VIEW STATE ONLY, never persisted. ⌘/ctrl-click
  // toggles a row into the set, ⇧-click ranges from the last toggle in the
  // current view order, plain click clears (and activates, as always).
  const [checkedConds, setCheckedConds] = useState(() => new Set());
  const [bulkWaste, setBulkWaste] = useState("");
  const checkAnchorRef = useRef(null);
  const [panelTab, setPanelTab] = useState("takeoffs");       // "takeoffs" | "library" — the docked panel's tabs
  const [templates, setTemplates] = useState([]);             // condition template library (browser-global, meta store)
  const templatesRef = useRef([]);                            // readable inside hydrate (seeding a fresh workspace)
  const labeledFileRef = useRef("");             // which file we've already title-block-scanned
  const wantSheetRef = useRef(new URLSearchParams(window.location.search).get("sheet") || "");
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");

  const [tool, setTool] = useState("pan");
  const [panelImgs, setPanelImgs] = useState({}); // { sheetKey: {w,h} } rendered bitmap dims per panel
  const [tf, setTf] = useState({ x: 0, y: 0, scale: 1 }); // render mirror of tfRef

  const [scales, setScales] = useState({});
  const [scaleSources, setScaleSources] = useState({}); // scale provenance for the report — typically "calibrated" | "standard" | "detected", but any string a newer build wrote is kept verbatim; sheets that predate the flag export "unknown"
  const [detectedScales, setDetectedScales] = useState({}); // { sheetKey: {upp,label,multi} } read off the plan text
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem("opentakeoff_dark") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("opentakeoff_dark", darkMode ? "1" : "0"); } catch { /* private mode */ } }, [darkMode]);
  // diff-only prefs (cf. reportColumns): only keys that differ from the
  // defaults persist, so a future default change reaches existing users
  useEffect(() => {
    try {
      const diff = {};
      for (const k of Object.keys(PANEL_DEFAULTS)) if (panelPrefs[k] !== PANEL_DEFAULTS[k]) diff[k] = panelPrefs[k];
      localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(diff));
    } catch { /* private mode */ }
  }, [panelPrefs]);
  const panelW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Number(panelPrefs.w) || PANEL_DEFAULTS.w));
  const takeoffsOpen = !panelPrefs.collapsed;
  const toggleTakeoffs = () => setPanelPrefs((p) => ({ ...p, collapsed: !p.collapsed }));
  // Resize by dragging the panel's left edge. Each width change reflows the
  // canvas container — coordinate math is safe (pointer→image reads the rect
  // at event time; the stage transform is anchored top-left, so content stays
  // put and we deliberately do NOT re-fit) — but the hi-res detail crop only
  // re-renders on transform change, so the detail effect also keys on panelW/
  // takeoffsOpen below. Mid-drag we hold the gesture window (like wheel zoom)
  // so the crop re-renders once on settle, not per pointermove.
  const panelDragRef = useRef(null);
  const onPanelResizeDown = (e) => {
    e.preventDefault();
    panelDragRef.current = { sx: e.clientX, sw: panelW };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanelResizeMove = (e) => {
    const d = panelDragRef.current; if (!d) return;
    gestureUntilRef.current = performance.now() + GESTURE_MS;
    const w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, d.sw + (d.sx - e.clientX)));
    setPanelPrefs((p) => (p.w === w ? p : { ...p, w }));
  };
  const onPanelResizeUp = (e) => {
    panelDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  };
  // negative view is baked into the canvas PIXELS (invertCanvasPixels), never a
  // CSS filter — track which canvases currently hold inverted pixels (only
  // canvases that finished a render get an entry), + darkMode readable from
  // async render chains
  const canvasInvertedRef = useRef(new Map());
  const darkModeRef = useRef(darkMode);
  const [hiResKeys, setHiResKeys] = useState(() => {        // per-sheet hi-res raster — per user (localStorage)
    try { return JSON.parse(localStorage.getItem("opentakeoff_hires") || "[]"); } catch { return []; }
  });
  const [calib, setCalib] = useState([]);
  const [pendingLen, setPendingLen] = useState("");

  const [conditions, setConditions] = useState([]);
  const [conditionColumns, setConditionColumns] = useState([]);  // project-level custom-column vocabulary [{ id, name, values }] — assignments live on c.attrs
  const [activeCond, setActiveCond] = useState("");
  const [shapes, setShapes] = useState([]);
  const [poly, setPoly] = useState([]);
  const [proposal, setProposal] = useState(null);  // One-Click selection under review: { key, regions: [{kind:'pos'|'neg', seed, poly, area_sf, perim_lf}] } — panel-LOCAL px
  const [selectedId, setSelectedId] = useState(null);   // selected shape (Select tool)

  const [snapOn, setSnapOn] = useState(false);   // snap-to-vector (beta) — off until calibrated on real plans
  const [angleOn, setAngleOn] = useState(true);  // 45°/90° angle guides (polar tracking) — on by default; ⇧ = hard lock
  const [saveState, setSaveState] = useState("idle");
  const [commitMsg, setCommitMsg] = useState("");   // transient status line (misnamed for history; just the message bar)
  const [showReport, setShowReport] = useState(false);  // Reports overlay (STACK-style breakdown + export)
  const [showSnapshots, setShowSnapshots] = useState(false); // Snapshots modal (save / compare / restore)
  const [projectName, setProjectName] = useState("");   // optional label for the report header
  const [clientInfo, setClientInfo] = useState({});      // per-project client/job fields for branded output; additive payload field
  const fileInputRef = useRef(null);                    // hidden <input type=file> for "Open PDF"

  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const panelCanvasRefs = useRef(new Map()); // sheetKey → <canvas>
  const pageObjsRef = useRef(new Map());     // sheetKey → pdf.js page object (kept for on-demand detail-view re-render)
  const renderScalesRef = useRef(new Map()); // sheetKey → base raster pdf scale (detail view renders at a multiple of it)
  const detailCanvasRef = useRef(null);      // single high-res viewport detail canvas (positioned imperatively)
  const detailTaskRef = useRef(null);        // in-flight detail render task (cancel stale on re-zoom)
  const detailBackRef = useRef(null);        // offscreen back buffer — the visible crop is never wiped mid-render
  const detailKeyRef = useRef("");           // last requested crop — identical re-requests are dropped (sync churn fires the effect several times per settle)
  const renderTasksRef = useRef(new Map());  // sheetKey → pdf.js RenderTask
  const pdfDocsRef = useRef(new Map());      // file name → pdf.js loading task (doc cache)
  const renderSeqRef = useRef(0);            // monotonic token — stale render chains bail out
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const crossVRef = useRef(null);
  const crossHRef = useRef(null);
  const rubberRef = useRef(null);
  const rectRef = useRef(null);
  const cloudRef = useRef(null);       // live cloud preview (first corner → cursor)
  const snapRef = useRef(null);        // current snapped image point (or null)
  const snapGridsRef = useRef(new Map()); // sheetKey → {cell, map} spatial hash of vector endpoints
  const vectorSegsRef = useRef(new Map()); // sheetKey → flat [x1,y1,x2,y2,…] linework segments (One-Click boundary source)
  const segMetaRef = useRef(new Map());    // sheetKey → per-segment meta bytes (hatch classification input)
  const maskCacheRef = useRef(new Map());  // sheetKey → built boundary mask (lazy, dropped on re-render)
  const snapMarkRef = useRef(null);    // SVG snap indicator
  const angleRef = useRef(null);       // current angle-locked image point (or null) — the click commits it
  const aimMarkRef = useRef(null);     // four floating liquid-glass pickets thickening the crosshair crossing
  const aimChipRef = useRef(null);     // readout chip by the cursor (locked angle · live segment length)
  const dragRef = useRef(null);        // {kind:'move'|'vertex', shapeId, vIndex?, start:[x,y], orig:verts_norm}
  const lastPtrRef = useRef(null);     // last pointer CLIENT coords — paste targets the sheet under the cursor
  const pendingClickRef = useRef(null); // deferred draw click {p,cx,cy} — drag >5px converts to a pan
  const hoverRef = useRef(null);        // hover tooltip div (DOM-direct like the crosshair)
  const hoverIdRef = useRef("");        // shape id currently described by the tooltip
  const lastMeasureRef = useRef("area"); // last armed measure tool — shown on the Measure menu face
  const menuDepthRef = useRef(0);      // >0 while a toolbar menu is open (letter shortcuts pause)
  const thumbCacheRef = useRef(new Map()); // sheetKey → thumbnail dataURL — survives gallery close
  const legacyPinnedRef = useRef(null);    // old `pinned` page numbers awaiting their one-shot tab migration
  const tabInitRef = useRef(false);        // snap to the first restored tab exactly once
  const statusRef = useRef("loading");     // mirror for the gallery's thumbnail worker
  const viewRef = useRef("canvas");        // mirror for the keyboard handlers
  const hydrated = useRef(false);
  const tfRef = useRef({ x: 0, y: 0, scale: 1 });
  const syncRaf = useRef(0);
  const lastSyncRef = useRef(0);       // last tf mirror sync (perf.now) — scheduleSync throttles against it
  const gestureUntilRef = useRef(0);   // wheel/pinch activity horizon — the detail view waits it out
  const panRafRef = useRef(0);         // rAF token coalescing drag-pan pointermoves into one transform write per frame
  const saveDataRef = useRef(null);    // latest serialized annotations — flushed on unmount
  const saveStateRef = useRef("idle"); // mirror of saveState for the unmount/beforeunload guard

  // page 1 keeps the bare file name (pre-paging takeoffs still load); pages 2+ → "name#page"
  const sheetKey = page > 1 ? `${active}#${page}` : active;
  // toggle a sheet in/out of the side-by-side group; first toggle from single
  // mode seeds the group with the sheet currently on screen
  const toggleInGroup = (key) => setSheetGroup((g) => {
    if (g.includes(key)) { const f = g.filter((k) => k !== key); return f.length >= 2 ? f : []; }
    if (g.length >= MAX_GROUP) return g;
    const base = g.length ? g : (key === sheetKey ? [] : [sheetKey]);
    return base.includes(key) ? base : [...base, key];
  });
  // Ungroup lands you on the sheet you were last working (the focused panel),
  // not whatever sheet the pager held before you grouped — shapes/markups all
  // carry their own sheet_id, so nothing is lost either way.
  const ungroup = () => {
    const k = (focusKey && sheetGroup.includes(focusKey)) ? focusKey : (sheetGroup[0] || sheetKey);
    const t = parseSheetKey(k);
    setSheetGroup([]);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
  };
  // Regroup restores the last side-by-side composition — the common flow is
  // ungroup, set each sheet's scale one at a time, then want the combined
  // canvas back without re-picking every sheet in the gallery.
  const regroup = () => {
    if (lastGroup.length < 2) return;
    setOpenTabs((t) => { const m = [...t]; for (const k of lastGroup) if (!m.includes(k)) m.push(k); return m; });
    setSheetGroup(lastGroup);
    setFocusKey(lastGroup.includes(sheetKey) ? sheetKey : lastGroup[0]);
  };
  // single-view a sheet by key (tab click, gallery View, tab restore)
  function goToSheet(key) {
    const t = parseSheetKey(key);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
    setSheetGroup([]);
  }
  // gallery open: every key becomes a tab; side-by-side also groups (2–4)
  function openSheets(keys, sideBySide) {
    if (!keys.length) return;
    setOpenTabs((t) => { const merged = [...t]; for (const k of keys) if (!merged.includes(k)) merged.push(k); return merged; });
    if (sideBySide && keys.length >= 2) { setSheetGroup(keys.slice(0, MAX_GROUP)); setFocusKey(keys[0]); }
    else goToSheet(keys[0]);
    setView("canvas");
  }
  function closeTab(key) {
    const i = openTabs.indexOf(key);
    const next = openTabs.filter((k) => k !== key);
    setOpenTabs(next);
    if (sheetGroup.includes(key)) { const f = sheetGroup.filter((k) => k !== key); setSheetGroup(f.length >= 2 ? f : []); }
    if (!next.length) { setView("gallery"); return; }
    if (!sheetGroup.length && key === sheetKey) { const nb = next[Math.min(Math.max(i, 0), next.length - 1)]; if (nb) goToSheet(nb); }
  }
  const tabLabel = (k) => {
    if (galleryLabels[k]) return galleryLabels[k];
    const t = parseSheetKey(k);
    if (t.file === active && pageLabels[t.page]) return pageLabels[t.page];
    const base = t.file.replace(/\.pdf$/i, "");
    return t.page > 1 ? `${base} · ${t.page}` : base;
  };

  // ── panels: the ONE rendering model — single-sheet mode is a group of one ──
  // Every coordinate on screen lives in "stage space": panel i's image px plus
  // its xOffset. With one panel xOffset is 0, so stage space IS image space and
  // all the original single-sheet math is unchanged.
  const groupKeys = sheetGroup.length ? sheetGroup : [sheetKey];
  const groupSig = JSON.stringify(groupKeys);
  let _px = 0;
  const panels = groupKeys.map((key) => {
    const dims = panelImgs[key] || { w: 0, h: 0 };
    const p = { key, ...parseSheetKey(key), img: dims, xOffset: _px };
    if (dims.w) _px += dims.w + PANEL_GAP;
    return p;
  });
  const stage = panels.reduce((a, p) => ({ w: Math.max(a.w, p.xOffset + p.img.w), h: Math.max(a.h, p.img.h) }), { w: 0, h: 0 });
  const panelByKey = (k) => panels.find((p) => p.key === k) || panels[0];
  // never null: a click in a gap (or off the row) routes to the NEAREST panel,
  // matching the old behavior of happily returning out-of-bounds image coords
  const panelAt = (sx) => {
    let best = panels[0], bd = Infinity;
    for (const p of panels) {
      if (sx >= p.xOffset && sx < p.xOffset + p.img.w) return p;
      const d = sx < p.xOffset ? p.xOffset - sx : sx - (p.xOffset + p.img.w);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const panelKeySet = new Set(groupKeys);
  const visibleShapes = shapes.filter((s) => panelKeySet.has(s.sheet_id));
  // scale is PER PAGE (plan sets are never one uniform scale) — set it once per
  // sheet and it's remembered. In group mode the scale dropdown and hints target
  // the FOCUSED panel (the one last clicked); single mode focuses the lone panel.
  const focusPanel = (focusKey && groupKeys.includes(focusKey) && panelByKey(focusKey)) || panels[0];
  const unitsPerPx = scales[focusPanel.key] ?? null;
  const labelFor = (p) => (p.file === active && pageLabels[p.page]) || (p.page > 1 ? `Sheet ${p.page}` : p.file);
  // Stored scales are ALWAYS feet-per-pixel at the baseline RENDER_SCALE. A hi-res
  // sheet is rastered at autoRenderScale, so its bitmap has factorFor× the baseline
  // pixels — geometry must divide by that factor (uppFor) and calibration must multiply
  // back to baseline, or a quantity would drift with the render resolution. Shape verts
  // are normalized to the panel, so positions are scale-free; only the px→feet factor
  // moves. factorFor reads the scale ACTUALLY rastered (renderScalesRef), so it always
  // matches the bitmap currently on screen.
  const hiResOn = (key) => hiResKeys.includes(key);
  const factorFor = (key) => (renderScalesRef.current.get(key) || RENDER_SCALE) / RENDER_SCALE;
  const uppFor = (key) => {
    const u = scales[key];
    return u == null ? null : u / factorFor(key);
  };
  const toggleHiRes = () => {
    const k = focusPanel.key;
    setHiResKeys((arr) => {
      const next = arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k];
      try { localStorage.setItem("opentakeoff_hires", JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // ── transform: tfRef is source of truth; write straight to the DOM ─────────
  const applyTf = useCallback(() => {
    const { x, y, scale } = tfRef.current;
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);
  // Re-apply after every React render so an unrelated re-render mid-drag can't
  // snap the transform back to a stale value.
  useLayoutEffect(() => { applyTf(); });
  // Leading+trailing ~90ms throttle, not per-frame and not trailing-only: the React
  // mirror feeds screen-relative sizes (handle radii, stroke widths, label text, the
  // low-zoom tint switch), so it must track a CONTINUOUS gesture — the old trailing
  // debounce left labels scaling with the stage and shapes flashing sub-pixel until
  // 80ms after the gesture ended. ~11Hz keeps the overlay honest for a trivial render
  // cost; the DOM transform still updates per-event/per-frame.
  const scheduleSync = useCallback(() => {
    if (syncRaf.current) return;                       // a queued tick reads the freshest tfRef
    const wait = Math.max(0, SYNC_MS - (performance.now() - lastSyncRef.current));
    syncRaf.current = setTimeout(() => {
      syncRaf.current = 0; lastSyncRef.current = performance.now();
      setTf({ ...tfRef.current });
    }, wait);
  }, []);
  const setTfNow = useCallback((next) => { tfRef.current = next; applyTf(); setTf({ ...next }); }, [applyTf]);

  // ── local PDFs (dropped into this browser) ─────────────────────────────────
  const refreshSheets = useCallback(async () => {
    const list = await store.listSheets();
    setSheets(list);
    return list;
  }, []);
  // open dropped/picked files of any kind: PDFs, images, and .zip plan sets all
  // get turned into PDF sheets (in-browser) by ingestFiles, then stashed locally
  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    setCommitMsg("Reading files…");
    let pdfs = [], skipped = [];
    try { ({ pdfs, skipped } = await ingestFiles(incoming, { onProgress: setCommitMsg })); }
    catch (e) { setCommitMsg(`Couldn't read those files: ${e.message || e}`); return; }
    if (!pdfs.length) {
      setCommitMsg(skipped.length
        ? `Nothing to open — ${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped. OpenTakeoff reads PDFs, images, and .zip plan sets.`
        : "No supported files found. Drop a PDF, an image, or a .zip plan set.");
      return;
    }
    for (const f of pdfs) { try { await store.addPdf(f); } catch (e) { setCommitMsg(`Couldn't open ${f.name}: ${e.message || e}`); } }
    await refreshSheets();
    const names = pdfs.map((f) => f.name);
    const tail = skipped.length ? ` · ${skipped.length} skipped` : "";
    if (names.length === 1) {
      setOpenTabs((t) => (t.includes(names[0]) ? t : [...t, names[0]]));
      goToSheet(names[0]);
      setView("canvas");
    } else {
      setView("gallery");   // a plan set → land in the gallery to pick sheets
    }
    setCommitMsg(`Opened ${names.length} sheet${names.length === 1 ? "" : "s"}${tail}.`);
  }
  useEffect(() => {
    let off = false;
    setStatus("loading");
    store.listSheets()
      .then((list) => { if (off) return; setSheets(list); if (list.length) setActive(list[0].name); else { setStatus("empty"); setView("gallery"); } })
      .catch((e) => !off && (setErr(String(e.message || e)), setStatus("error")));
    return () => { off = true; };
  }, []);

  // ── load saved annotations once per project ───────────────────────────────
  // hydrate applies a saved payload to state — shared by the mount load and by
  // Load in the Snapshots panel, so a restored snapshot walks the same
  // defensive path as a page reload.
  const hydrate = (a) => {
    setProjectName(a.project_name || "");
    // string fields only — a corrupted record must not put an object where
    // the report masthead renders a React child
    setClientInfo(Object.fromEntries(Object.entries(
      a.client_info && typeof a.client_info === "object" && !Array.isArray(a.client_info) ? a.client_info : {}
    ).filter(([, v]) => typeof v === "string")));
    setConditionColumns(sanitizeConditionColumns(a.condition_columns));   // non-array/malformed → [] (unconditional set: snapshot load must not inherit pre-load columns)
    const conds = sanitizeConditionAttrs(a.conditions || []);   // strips corrupt attrs values so every reader can trust them (the client_info precedent)
    if (conds.length) { setConditions(conds); setActiveCond(conds[0].id); }
    else { const seeded = seedConditions(templatesRef.current); setConditions(seeded); setActiveCond(seeded[0].id); }   // library templates first, flooring defaults as fallback
    setShapes(a.shapes || []);
    setMarkups(Array.isArray(a.markups) ? a.markups : []);
    const grp = Array.isArray(a.sheet_group) ? a.sheet_group.slice(0, MAX_GROUP) : [];
    setSheetGroup(grp);
    const lg = Array.isArray(a.last_group) ? a.last_group.slice(0, MAX_GROUP) : grp;
    // else-clear matters at runtime (snapshot load): a payload without groups/
    // tabs must not inherit the pre-load ones — autosave would persist a hybrid
    setLastGroup(lg.length >= 2 ? lg : []);
    // gallery-first: tabs restore directly; legacy pinned pages migrate once
    // (over in the sheets effect, where file names are known); nothing open → gallery
    const tabs = Array.isArray(a.sheet_tabs) ? a.sheet_tabs : [];
    if (tabs.length) setOpenTabs(tabs);
    else if (Array.isArray(a.pinned) && a.pinned.length) legacyPinnedRef.current = a.pinned;
    else { setOpenTabs([]); setView("gallery"); }
    const sc = {};
    const src = {};
    for (const s of a.sheets || []) if (s.sheet_id && s.units_per_px) {
      sc[s.sheet_id] = s.units_per_px;
      // provenance is additive — old projects lack it (report shows "unknown").
      // Any non-empty string passes through, not just today's known values: a
      // whitelist would silently strip a future value on load and the next
      // autosave would persist the loss. Display already falls back safely.
      if (typeof s.scale_source === "string" && s.scale_source) src[s.sheet_id] = s.scale_source;
    }
    setScales(sc);
    setScaleSources(src);
  };
  useEffect(() => {
    let off = false;
    // templates load BEFORE annotations: hydrate's fresh-workspace seeding
    // reads templatesRef, so the library must be in hand first
    store.loadTemplates().catch(() => []).then((tpl) => {
      if (!off) { templatesRef.current = tpl; setTemplates(tpl); }
      return store.loadAnnotations();
    }).then((a) => {
      if (off) return;
      hydrate(a);
      hydrated.current = true;
    }).catch((e) => {
      // stale-tab failure: leave autosave DISARMED (hydrated stays false). If a
      // blocked tab recovered here with hydrated=true, its still-empty defaults
      // would autosave straight over the other tab's real data. The reload
      // message is the whole story for this tab.
      if (isStaleTabError(e)) { setCommitMsg(STALE_TAB_MESSAGE); return; }
      hydrated.current = true;
    });
    return () => { off = true; };
  }, []);

  // remember every live composition so Regroup works after ANY exit from group
  // mode (Ungroup button, tab click, gallery View) — not just the last Ungroup
  useEffect(() => { if (sheetGroup.length >= 2) setLastGroup(sheetGroup); }, [sheetGroup]);

  // a persisted group may reference a since-deleted file — drop those keys; a
  // group of one collapses back to single-sheet mode
  useEffect(() => {
    if (!sheets.length) return;
    const names = new Set(sheets.map((s) => s.name));
    const liveKeys = (g) => {
      const f = g.filter((k) => names.has(parseSheetKey(k).file));
      return f.length === g.length ? g : (f.length >= 2 ? f : []);
    };
    setSheetGroup(liveKeys);
    setLastGroup(liveKeys);
    // one-shot migration: legacy `pinned` page numbers were relative to the
    // load-time active file (sheets[0]) — they become tabs, then never resurrect
    if (legacyPinnedRef.current) {
      const file = sheets[0].name;
      const tabs = legacyPinnedRef.current.map((n) => (n > 1 ? `${file}#${n}` : file));
      legacyPinnedRef.current = null;
      setOpenTabs((t) => (t.length ? t : tabs));
    }
    setOpenTabs((t) => { const f = t.filter((k) => names.has(parseSheetKey(k).file)); return f.length === t.length ? t : f; });
  }, [sheets]);

  // land on the first restored tab (the sheet-list effect defaults to sheets[0])
  useEffect(() => {
    if (tabInitRef.current || !openTabs.length || !sheets.length || sheetGroup.length) return;
    tabInitRef.current = true;
    goToSheet(openTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs, sheets]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { viewRef.current = view; }, [view]);

  // one pdf.js document per file, cached for the life of the project view —
  // the canvas render AND the gallery thumbnails share this cache
  // Bytes come from the local store (IndexedDB); pdf.js needs them up front, so
  // the cache holds a PROMISE of the loading task (not the task itself).
  const docFor = useCallback((file) => {
    let t = pdfDocsRef.current.get(file);
    if (!t) {
      t = store.loadPdfData(file).then((data) => pdfjsLib.getDocument({ data }));
      pdfDocsRef.current.set(file, t);
    }
    return t.then((task) => task.promise);
  }, []);

  // dark toggle: flip the pixels of every rendered canvas in place — instant,
  // no pdf.js re-render. Canvases without a map entry haven't rendered yet
  // (their chain applies the current mode when it finishes) — skip those, or
  // difference-fill would paint transparent backing stores white.
  useEffect(() => {
    darkModeRef.current = darkMode;
    const flip = (cv) => {
      if (cv && canvasInvertedRef.current.has(cv) && canvasInvertedRef.current.get(cv) !== darkMode) {
        invertCanvasPixels(cv);
        canvasInvertedRef.current.set(cv, darkMode);
      }
    };
    for (const [, cv] of panelCanvasRefs.current) flip(cv);
    flip(detailCanvasRef.current);
  }, [darkMode]);

  // ── render the sheet group (a single sheet is a group of one) ──────────────
  // Two phases: (A) resolve every panel's dimensions — no raster — so the row
  // layout is final before any pixel paints, then (B) raster sequentially left
  // to right. A monotonic token is checked after EVERY await so a stale chain
  // can never paint, resize, or cancel a newer chain's work (the old code had
  // that race between document-load and render).
  useEffect(() => {
    if (!active) return;
    const seq = ++renderSeqRef.current;
    const stale = () => seq !== renderSeqRef.current;
    setStatus("rendering"); setErr(""); setPoly([]); setCalib([]); setPendingLen(""); setSelectedId(null); setProposal(null);
    for (const [, rt] of renderTasksRef.current) { try { rt.cancel(); } catch { /* done */ } }
    renderTasksRef.current.clear();
    snapGridsRef.current.clear();
    vectorSegsRef.current.clear();
    segMetaRef.current.clear();
    maskCacheRef.current.clear();
    canvasInvertedRef.current.clear();
    pageObjsRef.current.clear();
    renderScalesRef.current.clear();
    try { detailTaskRef.current?.cancel(); } catch { /* done */ }
    if (detailCanvasRef.current) detailCanvasRef.current.style.display = "none";
    (async () => {
      // phase A — dimensions for every panel
      const metas = [];
      for (const key of groupKeys) {
        const { file, page: pn } = parseSheetKey(key);
        const pdf = await docFor(file); if (stale()) return;
        if (file === active) setPageCount(pdf.numPages || 1);
        const pageNum = Math.min(Math.max(1, pn), pdf.numPages || 1);
        const pageObj = await pdf.getPage(pageNum); if (stale()) return;
        const base = pageObj.getViewport({ scale: 1 });   // page size in PDF points
        const rs = hiResKeys.includes(key) ? autoRenderScale(base.width, base.height) : RENDER_SCALE;
        const viewport = pageObj.getViewport({ scale: rs });
        pageObjsRef.current.set(key, pageObj);     // kept for on-demand detail-view re-render
        renderScalesRef.current.set(key, rs);      // base raster scale — detail view renders at a multiple of it
        metas.push({ key, file, pageNum, pageObj, viewport, w: Math.ceil(viewport.width), h: Math.ceil(viewport.height) });
      }
      setPanelImgs(Object.fromEntries(metas.map((m) => [m.key, { w: m.w, h: m.h }])));
      let rw = 0, rh = 0;
      for (const m of metas) { rw += (rw ? PANEL_GAP : 0) + m.w; rh = Math.max(rh, m.h); }
      fitToView(rw, rh);
      // phase B — raster left to right (the canvases mount when panelImgs commits;
      // give React a frame or two for the refs of newly added panels)
      for (const m of metas) {
        let canvas = panelCanvasRefs.current.get(m.key);
        for (let t = 0; !canvas && t < 10; t++) {
          await new Promise((r) => requestAnimationFrame(r)); if (stale()) return;
          canvas = panelCanvasRefs.current.get(m.key);
        }
        if (!canvas) continue;
        canvas.width = m.w; canvas.height = m.h;
        // dark: pdf.js paints light pixels progressively — keep the canvas hidden
        // and reveal it already-inverted, or every render flashes white-on-dark
        canvas.style.visibility = darkModeRef.current ? "hidden" : "";
        const rt = m.pageObj.render({ canvasContext: canvas.getContext("2d"), viewport: m.viewport });
        renderTasksRef.current.set(m.key, rt);
        await rt.promise; if (stale()) return;
        if (darkModeRef.current) invertCanvasPixels(canvas);   // negative view baked into pixels
        canvasInvertedRef.current.set(canvas, !!darkModeRef.current);
        canvas.style.visibility = "";
        // snap-to-vector index per panel (best-effort; off until the user enables it)
        m.pageObj.getOperatorList().then((ol) => {
          if (stale()) return;
          const { points, segs, meta } = extractVectorGeometry(ol, m.viewport.transform, pdfjsLib.OPS);
          snapGridsRef.current.set(m.key, buildSnapGrid(points, SNAP_CELL));
          vectorSegsRef.current.set(m.key, segs);
          segMetaRef.current.set(m.key, meta);
        }).catch(() => {});
        // read the drawn scale note off this panel's page text (best-effort)
        m.pageObj.getTextContent().then((tc) => {
          if (stale()) return;
          const det = detectScale(tc, m.viewport);
          if (det) setDetectedScales((d) => (d[m.key]?.label === det.label ? d : { ...d, [m.key]: det }));
        }).catch(() => {});
      }
      setStatus("ready");
      // title-block labels — current page now, then once per file scan the rest so
      // the pager + pinned tabs + provenance deep-jump can show real sheet numbers
      const lead = metas.find((m) => m.file === active);
      if (!lead) return;
      lead.pageObj.getTextContent().then((tc) => {
        if (stale()) return;
        const lbl = extractSheetNumber(tc, lead.viewport);
        if (lbl) setPageLabels((m) => (m[lead.pageNum] === lbl ? m : { ...m, [lead.pageNum]: lbl }));
      }).catch(() => {});
      if (labeledFileRef.current !== active) {
        labeledFileRef.current = active;
        setPageLabels((m) => (m[lead.pageNum] ? { [lead.pageNum]: m[lead.pageNum] } : {})); // drop other file's labels
        (async () => {
          const pdf = await docFor(active);
          const found = {};
          for (let n = 1; n <= (pdf.numPages || 1); n++) {
            if (stale()) return;
            if (n === lead.pageNum) continue;
            try {
              const p2 = await pdf.getPage(n);
              const tc = await p2.getTextContent();
              const vp2 = p2.getViewport({ scale: RENDER_SCALE });
              const lbl = extractSheetNumber(tc, vp2);
              if (lbl) { found[n] = lbl; if (Object.keys(found).length % 8 === 0) setPageLabels((m) => ({ ...found, ...m })); }
              const det = detectScale(tc, vp2);
              if (det) {
                const key = n > 1 ? `${active}#${n}` : active;
                setDetectedScales((d) => (d[key]?.label === det.label ? d : { ...d, [key]: det }));
              }
            } catch { /* skip */ }
          }
          if (!stale() && Object.keys(found).length) setPageLabels((m) => ({ ...found, ...m }));
        })();
      }
    })().catch((e) => { if (stale() || e?.name === "RenderingCancelledException") return; setErr(String(e.message || e)); setStatus("error"); });
    return () => { renderSeqRef.current++; for (const [, rt] of renderTasksRef.current) { try { rt.cancel(); } catch { /* done */ } } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSig, hiResKeys.join(" ")]);

  // ── detail view: re-render the visible region at the current zoom ───────────
  // The base panel bitmap is the fast first paint and the zoomed-out view. Once
  // zoomed past DETAIL_ENGAGE we overlay a crop of JUST what's on screen (+margin),
  // rendered from the PDF vectors at the current zoom, so linework stays razor-sharp
  // with no giant full-sheet bitmap. `tf` only updates after the ~80ms pan/zoom settle
  // (scheduleSync), so this is naturally debounced. Pixels only — markup is an SVG
  // sibling ABOVE this canvas, and quantities never touch render pixels: both untouched.
  useEffect(() => {
    const cv = detailCanvasRef.current, cont = containerRef.current, fp = focusPanel;
    const hide = () => { if (cv) cv.style.display = "none"; detailKeyRef.current = ""; };
    if (!cv || !cont || status !== "ready" || !fp || !fp.img.w) return hide();
    const t = tfRef.current;
    if (window.__OT_DETAIL_DEBUG) console.log("[detail] tick " + JSON.stringify({ scale: +t.scale.toFixed(2), dpr: window.devicePixelRatio, pan: !!panRef.current, hold: +(gestureUntilRef.current - performance.now()).toFixed(0) }));
    if (t.scale * (window.devicePixelRatio || 1) <= DETAIL_ENGAGE) return hide();
    // Mid-gesture bail: `cv.width = bw` below WIPES the crop and reallocs tens of MB —
    // doing that on every ~90ms sync while pinching/panning would flash the region
    // blank and storm pdf.js with cancelled renders. The previous crop lives in stage
    // space, so leaving it painted keeps it correctly anchored while the gesture runs;
    // scheduleSync self-polls so the settle render is guaranteed once the window expires.
    if (panRef.current || performance.now() < gestureUntilRef.current) { scheduleSync(); return; }
    const pageObj = pageObjsRef.current.get(fp.key), rs = renderScalesRef.current.get(fp.key);
    if (!pageObj || !rs) return hide();

    // visible region of THIS panel, in image px (stage space minus the panel's xOffset)
    const r = cont.getBoundingClientRect();
    let x0 = Math.max((-t.x) / t.scale, fp.xOffset) - fp.xOffset;
    let y0 = Math.max((-t.y) / t.scale, 0);
    let x1 = Math.min((r.width - t.x) / t.scale, fp.xOffset + fp.img.w) - fp.xOffset;
    let y1 = Math.min((r.height - t.y) / t.scale, fp.img.h);
    if (x1 <= x0 || y1 <= y0) return hide();           // panel off-screen
    const mw = (x1 - x0) * DETAIL_MARGIN, mh = (y1 - y0) * DETAIL_MARGIN;
    x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh);
    x1 = Math.min(fp.img.w, x1 + mw); y1 = Math.min(fp.img.h, y1 + mh);
    const regW = x1 - x0, regH = y1 - y0;

    // density: enough backing px that the stage's CSS scale (×t.scale) isn't upscaling.
    // Capped by canvas limits, but the region is ~viewport-sized so the cap ~never binds.
    const dpr = window.devicePixelRatio || 1;
    let factor = Math.min(t.scale * dpr, MAX_CANVAS_DIM / regW, MAX_CANVAS_DIM / regH, Math.sqrt(MAX_CANVAS_AREA / (regW * regH)));
    factor = Math.max(1, factor);
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));

    // pdf scale yielding factor× the base raster density; shift the region's top-left to (0,0)
    const vp = pageObj.getViewport({ scale: rs * factor });
    // Double-buffer: render into an offscreen canvas and swap AFTER the pixels
    // exist. Writing cv.width here would clear the visible crop synchronously
    // while pdf.js paints the replacement async — a crisp→blank→crisp blink on
    // every pan/zoom settle (worse the deeper the zoom, since renders run longer).
    // The old crop is still correctly anchored in stage space, so it stays up
    // until the swap; the back store is released right after (width = 0).
    // one render per distinct crop — the sync loop re-fires this effect several
    // times around a settle with identical inputs, and each redundant pass is a
    // full-viewport pdf.js render (in dark mode plus a full-canvas inversion)
    const renderKey = `${fp.key}|${x0.toFixed(1)},${y0.toFixed(1)}|${bw}x${bh}`;
    if (renderKey === detailKeyRef.current) return;
    detailKeyRef.current = renderKey;
    const back = detailBackRef.current || (detailBackRef.current = document.createElement("canvas"));
    back.width = bw; back.height = bh;
    try { detailTaskRef.current?.cancel(); } catch { /* done */ }
    const rt = pageObj.render({ canvasContext: back.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor] });
    detailTaskRef.current = rt;
    rt.promise.then(() => {
      if (darkModeRef.current) invertCanvasPixels(back);   // negative view baked into pixels before it's ever visible
      cv.style.left = `${fp.xOffset + x0}px`; cv.style.top = `${y0}px`;
      cv.style.width = `${regW}px`; cv.style.height = `${regH}px`;
      cv.width = bw; cv.height = bh;
      cv.getContext("2d").drawImage(back, 0, 0);           // clear + repaint inside one task: no blank frame
      back.width = back.height = 0;
      canvasInvertedRef.current.set(cv, !!darkModeRef.current);
      cv.style.display = "block"; cv.style.visibility = "";
      if (window.__OT_DETAIL_DEBUG) console.log("[detail] swapped", bw, "x", bh);
    }).catch((e) => {   // RenderingCancelledException on rapid re-zoom is expected
      if (detailKeyRef.current === renderKey) detailKeyRef.current = "";   // let the next tick retry this crop
      if (e?.name !== "RenderingCancelledException") console.error("[detail] render failed:", e);
    });
    // panelW/takeoffsOpen: docking or resizing the Takeoffs panel changes the
    // container rect without a transform change — re-run so the crop resyncs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, groupSig, status, focusKey, panelW, takeoffsOpen]);

  // the doc cache holds whole PDFs in the worker — tear it down when the
  // project view unmounts or the project changes
  useEffect(() => () => {
    for (const [, t] of pdfDocsRef.current) { t.then((task) => { try { task.destroy(); } catch { /* already gone */ } }).catch(() => {}); }
    pdfDocsRef.current.clear();
  }, []);

  // provenance deep-jump: if the URL named a sheet (?sheet=A003), jump once its page is known
  useEffect(() => {
    const want = (wantSheetRef.current || "").toUpperCase().replace(/\s+/g, "");
    if (!want) return;
    const hit = Object.entries(pageLabels).find(([, lbl]) => lbl === want);
    if (hit) { setPage(parseInt(hit[0], 10)); wantSheetRef.current = ""; }
  }, [pageLabels]);

  // ── autosave (debounced) ──────────────────────────────────────────────────
  // buildPayload is the single serializer — autosave and snapshots must write
  // identical records for the same state (byte-stability matters downstream).
  const buildPayload = () => ({ project_name: projectName, ...(Object.values(clientInfo).some((v) => v && String(v).trim()) ? { client_info: clientInfo } : {}), sheets: Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, ...(scaleSources[sheet_id] ? { scale_source: scaleSources[sheet_id] } : {}) })), conditions, ...(conditionColumns.length ? { condition_columns: conditionColumns } : {}), shapes, markups, sheet_group: sheetGroup, last_group: lastGroup, sheet_tabs: openTabs });
  // markups MUST be in the deps (a cloud/callout/text or an RFI link is real work);
  // omitting it dropped markup saves and could persist a stale markups array.
  useEffect(() => {
    if (!hydrated.current) return;
    const payload = buildPayload();
    saveDataRef.current = payload;          // keep the freshest payload for an unmount flush
    setSaveState("saving");
    const t = setTimeout(() => {
      store.saveAnnotations(payload).then(() => setSaveState("saved")).catch((e) => {
        if (isStaleTabError(e)) setCommitMsg(STALE_TAB_MESSAGE);
        setSaveState("idle");
      });
    }, 700);
    return () => clearTimeout(t);
  }, [shapes, conditions, conditionColumns, scales, scaleSources, markups, sheetGroup, lastGroup, openTabs, projectName, clientInfo]);
  useEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  // Flush a pending debounced save on navigate-away (unmount), and warn before a
  // tab close while a save is in flight — so the tail of a tracing session is never lost.
  useEffect(() => {
    const onBeforeUnload = (e) => { if (saveStateRef.current === "saving") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (hydrated.current && saveStateRef.current === "saving" && saveDataRef.current) {
        store.saveAnnotations(saveDataRef.current).catch(() => {});   // best-effort flush
      }
    };
  }, []);

  function fitToView(w, h) {
    const el = containerRef.current;
    if (!el) return setTfNow({ x: 0, y: 0, scale: 1 });
    const r = el.getBoundingClientRect();
    const scale = Math.min((r.width - 40) / w, (r.height - 40) / h, 1);
    setTfNow({ x: (r.width - w * scale) / 2, y: (r.height - h * scale) / 2, scale });
  }

  const toImage = useCallback((cx, cy) => {
    const r = containerRef.current.getBoundingClientRect();
    const t = tfRef.current;
    return [(cx - r.left - t.x) / t.scale, (cy - r.top - t.y) / t.scale];
  }, []);

  function zoomAround(cx, cy, factor) {
    const t = tfRef.current;
    const next = clamp(t.scale * factor);
    const k = next / t.scale;
    tfRef.current = { scale: next, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    applyTf(); scheduleSync();
  }

  // wheel: zoom toward the cursor — plain scroll wheel and trackpad pinch alike.
  // A mouse notch is one big discrete delta; gliding it over a few frames keeps
  // the zoom continuous instead of stepping. Pinch (ctrl/meta) deltas are already
  // continuous, so those apply immediately at the original pinch sensitivity.
  // Shift+wheel pans (Space-drag and middle-drag still pan as before).
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    let glide = 0, gx = 0, gy = 0, raf = 0;
    const step = () => {
      raf = 0;
      const d = Math.abs(glide) < 0.002 ? glide : glide * 0.35;
      glide -= d;
      if (d) {
        const r = el.getBoundingClientRect();
        zoomAround(gx - r.left, gy - r.top, Math.exp(d));
      }
      if (glide) {
        gestureUntilRef.current = performance.now() + GESTURE_MS;  // glide still moving = still a gesture
        raf = requestAnimationFrame(step);
      }
    };
    const onWheel = (e) => {
      e.preventDefault();
      gestureUntilRef.current = performance.now() + GESTURE_MS;  // detail view waits for wheel quiet
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      if (e.shiftKey) {
        const t = tfRef.current;
        tfRef.current = { ...t, x: t.x - e.deltaX * unit, y: t.y - e.deltaY * unit };
        applyTf(); scheduleSync();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAround(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
        return;
      }
      glide += -e.deltaY * unit * 0.0012;            // one notch (~100) ≈ 12% zoom
      glide = Math.max(-1.2, Math.min(1.2, glide));  // cap queued zoom per direction
      gx = e.clientX; gy = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); if (raf) cancelAnimationFrame(raf); };
  }, [applyTf, scheduleSync]);

  // Space = temporary pan (any tool)
  useEffect(() => {
    const down = (e) => { if (e.code === "Space" && !e.repeat && e.target.tagName !== "INPUT") { spaceRef.current = true; if (containerRef.current) containerRef.current.style.cursor = "grab"; } };
    const up = (e) => { if (e.code === "Space") { spaceRef.current = false; if (containerRef.current) containerRef.current.style.cursor = ""; } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Single-letter tool shortcuts (STACK-style) — suppressed while typing or
  // while a toolbar menu is open. ⌘-combos and 1–9 live in their own handlers.
  useEffect(() => {
    const onKey = (e) => {
      const tg = e.target.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (menuDepthRef.current > 0) return;
      if (e.key === "Enter") {
        if (tool === "oneclick" && proposal?.regions.length) { e.preventDefault(); createProposal(); return; }
        const ok = ((tool === "area" || tool === "deduct") && poly.length >= 3) || ((tool === "linear" || tool === "surface") && poly.length >= 2);
        if (ok) { e.preventDefault(); finishShape(); }
        return;
      }
      const lower = e.key.toLowerCase();
      if (viewRef.current === "gallery") return;
      if (lower === "g") { setView("gallery"); return; }
      if (e.key === "D" && e.shiftKey) { setTool("deduct-rect"); return; }
      const map = { p: "pan", v: "select", a: "area", r: "rect", l: "linear", s: "surface", c: "count", d: "deduct", o: "oneclick" };
      const t = map[lower];
      if (t) setTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, poly, proposal, activeCond, sheetGroup, sheetKey]);

  // remember the last armed measure tool — the Measure menu face shows it
  useEffect(() => { if (MEASURE_TOOLS.some((t) => t.id === tool)) lastMeasureRef.current = tool; }, [tool]);

  // Number keys 1–9 switch the active condition (material) fast.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9 && conditions[n - 1]) { setActiveCond(conditions[n - 1].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conditions]);

  // Undo a wrong click: Backspace/Delete (or Cmd/Ctrl+Z) removes the last placed
  // point; Escape cancels the whole in-progress shape.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target.tagName;
      if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
      if (viewRef.current === "gallery") return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (poly.length) { setPoly((q) => q.slice(0, -1)); setCalib((c) => c.slice(0, -1)); }
        else if (proposal?.regions.length) { setProposal((pr) => { const rg = pr.regions.slice(0, -1); return rg.length ? { ...pr, regions: rg } : null; }); }
        else if (selectedId) { setShapes((ss) => ss.filter((s) => s.id !== selectedId)); setSelectedId(null); }
        else setCalib((c) => c.slice(0, -1));
      } else if (e.key === "Escape") { setPoly([]); setCalib([]); setSelectedId(null); setMarkupDraft(null); setProposal(null); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); setPoly((q) => (q.length ? q.slice(0, -1) : q)); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { if (selectedId) { e.preventDefault(); copySelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { if (clipRef.current.length) { e.preventDefault(); pasteClipboard(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { if (selectedId) { e.preventDefault(); duplicateSelected(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, poly, proposal, shapes, sheetKey, groupSig, scales, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pointer ────────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (status !== "ready") return;
    // Pan WITHOUT leaving the draw tool: middle-drag, right-drag, Space-drag, or Pan tool.
    if (tool === "pan" || e.button === 1 || e.button === 2 || spaceRef.current) {
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: tfRef.current.x, oy: tfRef.current.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;   // only left-click places points
    const p = (snapOn && snapRef.current) ? snapRef.current
      : (angleOn && angleRef.current) ? angleRef.current
        : toImage(e.clientX, e.clientY);
    const fp = panelAt(p[0]);
    if (fp.key !== focusKey) setFocusKey(fp.key);
    if (tool === "select") { selectAt(p, e); return; }
    // every point-placing tool DEFERS to pointer-up: hold-and-drag (mouse left
    // or one-finger trackpad press) pans mid-measurement instead of placing
    pendingClickRef.current = { p, cx: e.clientX, cy: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  // the deferred click — runs on pointer-up when the press didn't become a pan
  function performClick(p, ev) {
    if (tool === "calibrate") setCalib((c) => (c.length >= 2 ? [p] : [...c, p]));
    else if (tool === "oneclick") oneClickAt(p, !!(ev && ev.altKey));
    else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface") setPoly((q) => [...q, p]);
    else if (tool === "count") commitCount(p);
    else if (tool === "rect" || tool === "deduct-rect") {
      if (poly.length === 0) setPoly([p]);
      else { const a = poly[0]; commitPoly([[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], tool === "deduct-rect"); setPoly([]); }
    }
    else if (tool === "cloud" || tool === "callout" || tool === "text") placeMarkup(p);
  }
  // Select tool: pick a shape (or a vertex of the selected one) and start dragging
  // it. Every shape hit-tests in ITS panel's local frame (stage x minus xOffset).
  function selectAt(p, e) {
    const thr = 8 / tfRef.current.scale;
    if (selectedId) {
      const sel = shapes.find((s) => s.id === selectedId);
      const sp = sel && panelKeySet.has(sel.sheet_id) ? panelByKey(sel.sheet_id) : null;
      if (sel && sp && sel.measure_role !== "count") {
        const pts = sel.verts_norm.map(([nx, ny]) => [nx * sp.img.w + sp.xOffset, ny * sp.img.h]);
        const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) < thr * 1.6) {
            if (e.altKey) {
              // ⌥-click removes the point (a polygon keeps ≥3, a run keeps ≥2)
              const min = closed ? 3 : 2;
              if (sel.verts_norm.length > min) {
                setShapes((ss) => ss.map((s) => {
                  if (s.id !== sel.id) return s;
                  const vn = s.verts_norm.filter((_, j) => j !== i);
                  return { ...s, verts_norm: vn, computed: recomputeShape({ ...s, verts_norm: vn }) };
                }));
              } else setCommitMsg(closed ? "A shape needs at least 3 points." : "A run needs at least 2 points.");
              return;
            }
            dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i };
            e.currentTarget.setPointerCapture(e.pointerId); return;
          }
        }
        // midpoint handles: click an edge's midpoint to INSERT a new lever point
        // and drag it away in the same gesture
        const edges = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < edges; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if (Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]) < thr * 1.4) {
            const nv = [(p[0] - sp.xOffset) / sp.img.w, p[1] / sp.img.h];
            setShapes((ss) => ss.map((s) => {
              if (s.id !== sel.id) return s;
              const vn = [...s.verts_norm.slice(0, i + 1), nv, ...s.verts_norm.slice(i + 1)];
              return { ...s, verts_norm: vn, computed: recomputeShape({ ...s, verts_norm: vn }) };
            }));
            dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i + 1 };
            e.currentTarget.setPointerCapture(e.pointerId); return;
          }
        }
      }
      if (sel && sp && hitShape(sel, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr)) {
        dragRef.current = { kind: "move", shapeId: selectedId, start: p, orig: sel.verts_norm };
        e.currentTarget.setPointerCapture(e.pointerId); return;
      }
    }
    const hit = [...visibleShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShape(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
    });
    setSelectedId(hit ? hit.id : null);
    if (hit) { dragRef.current = { kind: "move", shapeId: hit.id, start: p, orig: hit.verts_norm }; e.currentTarget.setPointerCapture(e.pointerId); }
  }
  // Geometry from the shape's OWN sheet: its panel's pixel dims × that sheet's
  // scale. This is what makes cross-sheet paste and group-mode edits honest.
  function recomputeShape(s) {
    const sp = panelByKey(s.sheet_id);
    const pts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
    const u = uppFor(s.sheet_id) || 0;
    if (s.measure_role === "count") return { count: 1 };
    if (s.measure_role === "surface_area") {
      // the wall keeps the height it was DRAWN at; the condition H is only the
      // default for new traces (and the fallback for legacy shapes without one).
      // An explicit override wins outright — even 0 (a zero-height wall is a
      // deliberate statement, not an invitation to fall back to the condition).
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      const LF = openLen(pts) * u;
      return { area_sf: +(LF * h).toFixed(2), perimeter_lf: +LF.toFixed(2) };
    }
    if (s.measure_role === "linear") {
      const LF = openLen(pts) * u;
      const tIn = Number(condById[s.condition_id]?.thickness_in) || 0;
      return { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 };
    }
    const met = closedMetrics(pts);
    return { area_sf: +(met.area * u * u).toFixed(2), perimeter_lf: +(met.perim * u).toFixed(2) };
  }
  function moveCrosshair(e) {
    if (tool === "pan" || tool === "select" || status !== "ready" || !containerRef.current) return;
    // snap-to-vector: nearest PDF endpoint within threshold becomes the active
    // point — looked up in the hovered panel's grid, in that panel's local frame
    let cur = toImage(e.clientX, e.clientY);
    snapRef.current = null;
    if (snapMarkRef.current) snapMarkRef.current.style.display = "none";
    if (snapOn && !panRef.current && snapGridsRef.current.size) {
      const sc = tfRef.current.scale;
      const sp = panelAt(cur[0]);
      const grid = snapGridsRef.current.get(sp.key);
      const hit = grid ? nearestSnap(grid, cur[0] - sp.xOffset, cur[1], 11 / sc) : null;
      if (hit) {
        const pt = [hit[0] + sp.xOffset, hit[1]];
        snapRef.current = pt; cur = pt;
        if (snapMarkRef.current) { snapMarkRef.current.setAttribute("d", starPath(pt[0], pt[1], 5.5 / sc)); snapMarkRef.current.style.display = "block"; }
      }
    }

    // rubber-band preview: last point → cur (area/deduct); rect preview: corner → cur
    const drawing = (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface");

    // polar tracking: endpoint snap wins (osnap beats polar); otherwise pull the
    // rubber band onto the 45° family. ⇧ forces the lock at any angle. The click
    // path commits angleRef, so the placed vertex is exactly on-axis — not just
    // the preview. The lock reads as a QUIET state change (crosshair brightens,
    // rubber band thickens, chip shows the angle) — no extra chrome on the sheet.
    const anchor = (drawing && poly.length > 0) ? poly[poly.length - 1]
      : (tool === "calibrate" && calib.length === 1 ? calib[0] : null);
    angleRef.current = null;
    let lock = null;
    if (angleOn && anchor && !snapRef.current && !panRef.current) {
      const sc = tfRef.current.scale;
      if (Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) >= 12 / sc)
        lock = angleSnap(anchor, cur, e.shiftKey);
      if (lock) { angleRef.current = lock.pt; cur = lock.pt; }
    }

    // the crosshair IS the cursor — re-assert cursor:none every move because the
    // pan/space handlers restore style.cursor to "" (computed auto) on release
    if (!panRef.current && !spaceRef.current && containerRef.current.style.cursor !== "none")
      containerRef.current.style.cursor = "none";

    // aim visuals ride the EFFECTIVE point (locked/snapped), not the raw mouse
    const t = tfRef.current;
    const ex = cur[0] * t.scale + t.x, ey = cur[1] * t.scale + t.y;
    const lockState = lock ? "1" : "";
    for (const [el, prop, val] of [[crossVRef.current, "left", ex], [crossHRef.current, "top", ey]]) {
      if (!el) continue;
      el.style[prop] = `${val}px`; el.style.display = "block";
      if (el.__lock !== lockState) {
        el.__lock = lockState;
        el.style.background = lock ? "rgba(31,63,199,.85)" : "rgba(31,63,199,.55)";
        el.style.boxShadow = lock
          ? "0 0 0 0.5px rgba(255,255,255,.6), 0 0 6px rgba(31,63,199,.5)"
          : "0 0 0 0.5px rgba(255,255,255,.55), 0 0 4px rgba(31,63,199,.3)";
      }
    }
    if (aimMarkRef.current) {
      const el = aimMarkRef.current;
      el.style.transform = `translate3d(${ex}px, ${ey}px, 0)`;
      if (el.__lock !== lockState) {
        el.__lock = lockState;
        const star = el.firstChild;
        if (star) {
          star.style.transform = lock ? "scale(1.3)" : "scale(1)";
          star.style.filter = lock ? "drop-shadow(0 0 5px rgba(31,63,199,.6)) drop-shadow(0 1px 2px rgba(14,26,46,.3))" : "drop-shadow(0 1px 2px rgba(14,26,46,.3))";
        }
      }
      el.style.display = "block";
    }
    if (aimChipRef.current) {
      const chip = aimChipRef.current;
      let txt = "";
      if (lock) {
        txt = `${lock.deg}°`;
        if (anchor && liveUpp) txt += ` · ${num(Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) * liveUpp)}′`;
      } else if (snapRef.current) txt = "snap";
      if (txt) {
        if (chip.__t !== txt) { chip.textContent = txt; chip.__t = txt; }
        chip.style.transform = `translate3d(${ex + 14}px, ${ey + 18}px, 0)`;
        chip.style.display = "block";
      } else chip.style.display = "none";
    }
    if (rubberRef.current) {
      if (!panRef.current && drawing && poly.length > 0) {
        const last = poly[poly.length - 1];
        rubberRef.current.setAttribute("x1", last[0]); rubberRef.current.setAttribute("y1", last[1]);
        rubberRef.current.setAttribute("x2", cur[0]); rubberRef.current.setAttribute("y2", cur[1]);
        rubberRef.current.setAttribute("stroke-width", lock ? 3 : 1.5);  // the lock reads in the band itself
        rubberRef.current.style.display = "block";
      } else rubberRef.current.style.display = "none";
    }
    if (rectRef.current) {
      if (!panRef.current && (tool === "rect" || tool === "deduct-rect") && poly.length === 1) {
        const a = poly[0];
        rectRef.current.setAttribute("x", Math.min(a[0], cur[0])); rectRef.current.setAttribute("y", Math.min(a[1], cur[1]));
        rectRef.current.setAttribute("width", Math.abs(cur[0] - a[0])); rectRef.current.setAttribute("height", Math.abs(cur[1] - a[1]));
        rectRef.current.style.display = "block";
      } else rectRef.current.style.display = "none";
    }
    // live cloud preview: first corner (markupDraft, stage px) → cursor
    if (cloudRef.current) {
      if (!panRef.current && tool === "cloud" && markupDraft) {
        cloudRef.current.setAttribute("d", cloudPath(markupDraft[0], markupDraft[1], cur[0], cur[1]));
        cloudRef.current.style.display = "block";
      } else cloudRef.current.style.display = "none";
    }
  }
  function hideCrosshair() {
    for (const ref of [crossVRef, crossHRef, rubberRef, rectRef, cloudRef, snapMarkRef, aimMarkRef, aimChipRef]) if (ref.current) ref.current.style.display = "none";
    if (hoverRef.current) hoverRef.current.style.display = "none";
    hoverIdRef.current = "";
    angleRef.current = null;
  }
  function describeShape(s) {
    const tag = condById[s.condition_id]?.finish_tag || "?";
    const a = s.computed?.area_sf || 0, lf = s.computed?.perimeter_lf || 0;
    if (s.measure_role === "count") return `${tag} · ${num(s.computed?.count || 1, 0)} EA`;
    if (s.measure_role === "deduct") return `${tag} · −${num(a)} SF deduct`;
    if (s.measure_role === "surface_area") {
      // same height semantics as recomputeShape: an override wins outright (even 0)
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      return `${tag} · ${num(a)} SF wall (${num(lf)} LF × ${num(h, 2)}′)`;
    }
    if (s.measure_role === "linear") return `${tag} · ${num(lf)} LF${a > 0 ? ` · ${num(a)} SF border` : ""}`;
    return `${tag} · ${num(a)} SF · ${num(a / 9)} SY`;
  }
  // STACK-style hover readout: small, follows the cursor, gone on hover-off
  function updateHover(e) {
    const el = hoverRef.current;
    if (!el) return;
    if (panRef.current || dragRef.current || pendingClickRef.current || status !== "ready") { el.style.display = "none"; hoverIdRef.current = ""; return; }
    const pt = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    const hit = [...visibleShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShape(s, pt[0] - sp.xOffset, pt[1], sp.img.w, sp.img.h, thr);
    });
    if (!hit) { el.style.display = "none"; hoverIdRef.current = ""; return; }
    if (hoverIdRef.current !== hit.id) { el.textContent = describeShape(hit); hoverIdRef.current = hit.id; }
    const r = containerRef.current.getBoundingClientRect();
    el.style.left = `${e.clientX - r.left + 14}px`;
    el.style.top = `${e.clientY - r.top + 16}px`;
    el.style.display = "block";
  }
  function onPointerMove(e) {
    lastPtrRef.current = [e.clientX, e.clientY];   // paste targets the sheet under the cursor
    moveCrosshair(e);                 // full-page aim guide (draw modes), always tracks hover
    // a held draw-click that moves becomes a pan (point placement waits for up)
    if (pendingClickRef.current && !panRef.current) {
      const pc = pendingClickRef.current;
      if (Math.hypot(e.clientX - pc.cx, e.clientY - pc.cy) > 5) {
        panRef.current = { sx: pc.cx, sy: pc.cy, ox: tfRef.current.x, oy: tfRef.current.y };
        pendingClickRef.current = null;
        if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      }
    }
    updateHover(e);
    if (dragRef.current) {
      const d = dragRef.current;
      const p = (snapOn && snapRef.current) ? snapRef.current : toImage(e.clientX, e.clientY);
      if (d.kind === "vertex") {
        setShapes((ss) => ss.map((s) => {
          if (s.id !== d.shapeId) return s;
          const sp = panelByKey(s.sheet_id);
          const vn = s.verts_norm.map((v, i) => (i === d.vIndex ? [(p[0] - sp.xOffset) / sp.img.w, p[1] / sp.img.h] : v));
          return { ...s, verts_norm: vn, computed: recomputeShape({ ...s, verts_norm: vn }) };
        }));
      } else if (d.kind === "move") {
        setShapes((ss) => ss.map((s) => {
          if (s.id !== d.shapeId) return s;
          // start and p are both stage px, so xOffset cancels in the delta —
          // only the normalizing divisor is the shape's own panel
          const sp = panelByKey(s.sheet_id);
          const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
          return { ...s, verts_norm: d.orig.map(([nx, ny]) => [nx + dx, ny + dy]) };
        }));
      }
      return;
    }
    if (!panRef.current) return;
    // rAF-coalesced: pointermove can outrun the display (120Hz+ mice/trackpads) — keep
    // the latest position and write the transform once per frame. Still no React render.
    panRef.current.lx = e.clientX; panRef.current.ly = e.clientY;
    if (!panRafRef.current) panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = 0;
      const pr = panRef.current; if (!pr) return;
      tfRef.current = { ...tfRef.current, x: pr.ox + (pr.lx - pr.sx), y: pr.oy + (pr.ly - pr.sy) };
      applyTf();
      scheduleSync();   // keeps the tf mirror (labels/strokes) honest during long pans
    });
  }
  function onPointerUp(e) {
    if (pendingClickRef.current) {
      const { p } = pendingClickRef.current;
      pendingClickRef.current = null;
      performClick(p, e);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (dragRef.current) { dragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ } return; }
    if (panRef.current) {
      panRef.current = null;
      setTf({ ...tfRef.current });   // sync once at end
      if (containerRef.current) containerRef.current.style.cursor = spaceRef.current ? "grab" : "";
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    }
  }

  function applyCalibration() {
    const feet = parseFloat(pendingLen);
    if (!(feet > 0) || calib.length !== 2) return;
    const pa = panelAt(calib[0][0]), pb = panelAt(calib[1][0]);
    if (pa.key !== pb.key) {
      setCommitMsg("Calibrate on one sheet — those two clicks landed on different sheets.");
      setCalib([]); setPendingLen(""); return;
    }
    const px = Math.hypot(calib[1][0] - calib[0][0], calib[1][1] - calib[0][1]);
    if (px <= 0) return;
    // store at BASELINE resolution — the auto hi-res raster has factorFor× denser pixels
    const toBase = factorFor(pa.key);
    setScales((s) => ({ ...s, [pa.key]: (feet / px) * toBase })); // per page — remembered for this sheet
    setScaleSources((s) => ({ ...s, [pa.key]: "calibrated" }));
    setCalib([]); setPendingLen("");
  }

  // A shape belongs to the panel of its FIRST point — verts normalize against
  // that panel's dims, quantities use that sheet's scale.
  function commitPoly(points, asDeduct) {
    if (points.length < 3) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const met = closedMetrics(points);
    setShapes((s) => [...s, {
      id: uid("shp"), sheet_id: tp.key, condition_id: activeCond,
      measure_role: asDeduct ? "deduct" : "floor_area",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
      origin: { method: "manual" },
    }]);
  }
  function commitLinear(points) {
    if (points.length < 2) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const LF = openLen(points) * upp;
    const tIn = Number(aCond?.thickness_in) || 0; // borders/feature strips: SF = LF × T/12
    setShapes((s) => [...s, {
      id: uid("shp"), sheet_id: tp.key, condition_id: activeCond, measure_role: "linear",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 },
      origin: { method: "manual" },
    }]);
  }
  // Surface Area — trace the wall run in plan; SF = traced LF × the condition's
  // height. The wall-tile "stack" workflow: set tile height once, trace walls.
  function commitSurface(points) {
    if (points.length < 2) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const h = Number(aCond?.height_ft) || 0;
    if (!(h > 0)) { setCommitMsg(`Set a height for ${aCond?.finish_tag || "this condition"} (H in the Takeoffs panel) — Surface Area = traced LF × height.`); return; }
    const LF = openLen(points) * upp;
    setShapes((s) => [...s, {
      id: uid("shp"), sheet_id: tp.key, condition_id: activeCond, measure_role: "surface_area", height_ft: h,
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(LF * h).toFixed(2), perimeter_lf: +LF.toFixed(2) },
      origin: { method: "manual" },
    }]);
  }
  function commitCount(p) {
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const tp = panelAt(p[0]);
    setShapes((s) => [...s, {
      id: uid("shp"), sheet_id: tp.key, condition_id: activeCond, measure_role: "count",
      verts_norm: [[(p[0] - tp.xOffset) / tp.img.w, p[1] / tp.img.h]], computed: { count: 1 }, origin: { method: "manual" },
    }]);
  }

  // ── One-Click Area — click inside a room; the linework bounds it ──────────
  // Flood-fill on a downscaled raster of THIS panel's vector segments (the same
  // op-list walk that feeds snap), traced + RDP-simplified, vertices snapped to
  // true PDF endpoints. Clicks accumulate a PROPOSAL the estimator reviews:
  // click = add a space, ⌥-click = carve an enclosed cutout (column/shaft) —
  // a carve must sit INSIDE a selected space, and mints a deduct. Nothing is a
  // takeoff until Create (⏎) — the gate where provenance is minted (origin on
  // each shape). Mask + proposal live in panel-LOCAL px; a proposal is bound to
  // one panel and dies on sheet change (render effect resets it).
  function ensureMask(key) {
    let mo = maskCacheRef.current.get(key);
    if (!mo) {
      const segs = vectorSegsRef.current.get(key);
      const dims = panelImgs[key];
      if (!segs || !segs.length || !dims?.w) return null;
      mo = buildMask(segs, dims.w, dims.h, MASK_MAX_DIM, segMetaRef.current.get(key));
      maskCacheRef.current.set(key, mo);
    }
    return mo;
  }
  function oneClickAt(p, negative) {
    const tp = panelAt(p[0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    if (proposal && proposal.key !== tp.key) { setCommitMsg(`Finish the selection on ${labelFor(panelByKey(proposal.key))} first — ⏎ creates it, Esc discards.`); return; }
    const mo = ensureMask(tp.key);
    if (!mo) { setCommitMsg("Still reading this sheet's linework — try again in a second."); return; }
    const local = [p[0] - tp.xOffset, p[1]];
    const f = floodRegion(mo, local[0], local[1]);
    if (f.status !== "ok") {
      setCommitMsg(f.status === "leak"
        ? "That space isn't enclosed on the plan linework — the fill spilled. Click a more enclosed spot, or trace it with Area (A)."
        : "Landed in dense linework (hatching/text). Zoom in and click an open spot, or trace it with Area (A).");
      return;
    }
    const grid = snapGridsRef.current.get(tp.key);
    const ring = snapVertices(traceRegion(f), (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null), 7);
    if (ring.length < 3) { setCommitMsg("Couldn't trace that space — trace it with Area (A)."); return; }
    const regions = proposal?.regions || [];
    if (regions.some((r) => r.kind === (negative ? "neg" : "pos") && pointInPoly(local[0], local[1], r.poly))) {
      setCommitMsg(negative ? "That cutout is already carved." : "Already selected — ⌥-click carves an enclosed cutout; ⏎ creates."); return;
    }
    if (negative && !regions.some((r) => r.kind === "pos" && pointInPoly(local[0], local[1], r.poly))) {
      setCommitMsg("⌥-click carves an enclosed area INSIDE the selection (a column or shaft) — click its room first."); return;
    }
    const area_sf = +(ringArea(ring) * upp * upp).toFixed(2);
    const perim_lf = +(closedMetrics(ring).perim * upp).toFixed(2);
    setProposal({ key: tp.key, regions: [...regions, { kind: negative ? "neg" : "pos", seed: local, poly: ring, area_sf, perim_lf, hf: !!f.hatchFiltered }] });
    setCommitMsg("");
  }
  function createProposal() {
    if (!proposal || !proposal.regions.length) return;
    const tp = panelByKey(proposal.key);
    const made = proposal.regions.map((r) => ({
      id: uid("shp"), sheet_id: tp.key, condition_id: activeCond,
      measure_role: r.kind === "neg" ? "deduct" : "floor_area",
      verts_norm: r.poly.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
      computed: { area_sf: r.area_sf, perimeter_lf: r.perim_lf },
      // the provenance receipt: machine-proposed, human-reviewed at the Create gate
      origin: { method: "one_click_v1", seed_norm: [r.seed[0] / tp.img.w, r.seed[1] / tp.img.h], reviewed: true, ...(r.hf ? { hatch_filtered: true } : {}) },
    }));
    setShapes((s) => [...s, ...made]);
    const sf = proposal.regions.reduce((n, r) => n + (r.kind === "neg" ? -r.area_sf : r.area_sf), 0);
    setCommitMsg(`Created ${made.length} takeoff${made.length === 1 ? "" : "s"} — ${sf.toLocaleString(undefined, { maximumFractionDigits: 1 })} SF ${condById[activeCond]?.finish_tag || ""}. Click the next room.`);
    setProposal(null);
  }

  // ── copy / paste / duplicate — "draw once, drop it again", same sheet or the
  // one under the cursor. The clipboard carries verts + provenance, never the old
  // computed numbers: every paste recomputes against the TARGET panel's dims and
  // that sheet's scale (this also fixes the legacy bug where pasting after a
  // rescale kept the stale SF).
  const clipRef = useRef([]);
  const cloneOrigin = (o) => (o ? { origin: { ...o, ...(o.seed_norm ? { seed_norm: [...o.seed_norm] } : {}) } } : {});
  // the clipboard payload for one shape: verts deep-copied, provenance kept,
  // `from` remembers the source sheet so paste knows same-sheet vs cross-sheet
  const clipEntry = (sel) => ({ condition_id: sel.condition_id, measure_role: sel.measure_role,
                                verts_norm: sel.verts_norm.map((v) => [...v]), from: sel.sheet_id, height_ft: sel.height_ft,
                                ...(sel.height_override ? { height_override: true } : {}), ...cloneOrigin(sel.origin) });
  function copySelected() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel) { setCommitMsg("Select a takeoff to copy."); return; }
    clipRef.current = [clipEntry(sel)];
    setCommitMsg("Copied — ⌘V pastes onto the sheet under your cursor.");
  }
  function pasteClipboard(offset = 0.03) {
    if (!clipRef.current.length) return;
    const tp = lastPtrRef.current ? panelAt(toImage(lastPtrRef.current[0], lastPtrRef.current[1])[0]) : focusPanel;
    const needsScale = clipRef.current.some((c) => c.measure_role !== "count");
    if (needsScale && !uppFor(tp.key)) { setCommitMsg(`Set the scale for ${labelFor(tp)} first — paste recomputes SF/LF there.`); return; }
    let cross = false;
    const made = clipRef.current.map((c) => {
      const same = c.from === tp.key;
      cross = cross || !same;
      // same sheet: nudge so the copy is visible; other sheet: same relative spot
      const vn = c.verts_norm.map(([x, y]) => (same ? [Math.min(0.999, x + offset), Math.min(0.999, y + offset)] : [x, y]));
      // != null, not truthy: an overridden height of 0 must survive the paste
      const s = { id: uid("shp"), sheet_id: tp.key, condition_id: c.condition_id, measure_role: c.measure_role, verts_norm: vn, ...(c.height_ft != null ? { height_ft: c.height_ft } : {}), ...(c.height_override ? { height_override: true } : {}), ...cloneOrigin(c.origin) };
      return { ...s, computed: recomputeShape(s) };
    });
    setShapes((s) => [...s, ...made]);
    setSelectedId(made[made.length - 1].id);
    setTool("select");
    setCommitMsg(`Pasted ${made.length} takeoff${made.length === 1 ? "" : "s"}${cross ? ` onto ${labelFor(tp)}` : ""} — drag to position.`);
  }
  function duplicateSelected() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel) { setCommitMsg("Select a takeoff to duplicate."); return; }
    clipRef.current = [clipEntry(sel)];
    pasteClipboard();
  }
  // ── markup (cloud / callout / text) — annotations, not measurements ─────────
  // markupDraft holds STAGE px (so the live preview spans panels); a markup
  // belongs to the panel of its FIRST click and normalizes against that panel.
  function addMarkup(m, key) {
    setMarkups((ms) => [...ms, { id: uid("mk"), sheet_id: key, rfi_id: "", ...m }]);
    setShowMarkupPanel(true);
  }
  // Marked-set PDF: every sheet carrying takeoffs/markups, work burned in as
  // drawn, legend cover with net totals — built fully in the browser
  // (lib/markedset.js). Exports in the CURRENT view: dark canvas → dark PDF.
  async function exportMarkedSet() {
    try {
      setCommitMsg("Building the marked set…");
      const keys = [...new Set([...shapes.map((s) => s.sheet_id), ...markups.map((m) => m.sheet_id)])];
      const sheetMeta = keys.map((key) => {
        const { file, page } = parseSheetKey(key);
        return { key, file, page, label: tabLabel(key) };
      }).sort((a, b) => compareSheetKeys(a.key, b.key));   // canonical sheet order — shared comparator
      const { bytes, filename } = await buildMarkedSetPdf({
        projectName, clientInfo, company: loadCompany(),
        dark: darkMode, sheets: sheetMeta, shapes, markups, conditions,
        getPage: async (file, pageNum) => (await docFor(file)).getPage(pageNum),
        loadPdfData: (file) => store.loadPdfData(file),
      });
      downloadBytes(filename, bytes);
      setCommitMsg(`Marked set downloaded — ${filename}`);
    } catch (e) {
      setCommitMsg(`Marked set failed: ${e.message || e}`);
    }
  }

  function placeMarkup(p) {
    const tp = panelAt(p[0]);
    const norm = (q, panel) => [(q[0] - panel.xOffset) / panel.img.w, q[1] / panel.img.h];
    if (tool === "text") {
      const t = window.prompt("Text note:");
      if (t && t.trim()) addMarkup({ type: "text", at: norm(p, tp), text: t.trim() }, tp.key);
    } else if (tool === "cloud") {
      if (!markupDraft) { setMarkupDraft(p); }
      else {
        const note = window.prompt("Cloud note (optional):") || "";
        const dp = panelAt(markupDraft[0]);
        addMarkup({ type: "cloud", rect: [norm(markupDraft, dp), norm(p, dp)], text: note.trim() }, dp.key);
        setMarkupDraft(null);
      }
    } else if (tool === "callout") {
      if (!markupDraft) { setMarkupDraft(p); }   // first click = the thing you're pointing at
      else {
        const t = window.prompt("Callout text:");
        const dp = panelAt(markupDraft[0]);
        if (t && t.trim()) addMarkup({ type: "callout", target: norm(markupDraft, dp), at: norm(p, dp), text: t.trim() }, dp.key);
        setMarkupDraft(null);
      }
    }
  }
  function updateMarkup(mid, patch) { setMarkups((ms) => ms.map((m) => (m.id === mid ? { ...m, ...patch } : m))); }
  function deleteMarkup(mid) { setMarkups((ms) => ms.filter((m) => m.id !== mid)); }

  function finishShape() { if (tool === "surface") commitSurface(poly); else if (tool === "linear") commitLinear(poly); else commitPoly(poly, tool === "deduct"); setPoly([]); }
  function deleteSelected() { if (selectedId) { setShapes((ss) => ss.filter((s) => s.id !== selectedId)); setSelectedId(null); } }
  function reassignSelected(condId) { if (selectedId) setShapes((ss) => ss.map((s) => (s.id === selectedId ? { ...s, condition_id: condId } : s))); }

  // pan/zoom the canvas to fit a condition's takeoffs on the open sheets —
  // the panel's ⌖ / double-click navigation. Fit zoom is capped so a lone
  // count marker doesn't slam the view to maximum magnification.
  function locateCondition(id) {
    const el = containerRef.current;
    if (!el) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false;
    for (const s of visibleShapes) {
      if (s.condition_id !== id) continue;
      const sp = panelByKey(s.sheet_id);
      for (const [nx, ny] of s.verts_norm) {
        const x = nx * sp.img.w + sp.xOffset, y = ny * sp.img.h;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        found = true;
      }
    }
    if (!found) { setCommitMsg(`No takeoffs for ${condById[id]?.finish_tag || "this condition"} on the open sheet${groupKeys.length > 1 ? "s" : ""} yet.`); return; }
    const r = el.getBoundingClientRect();
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1), pad = 90;
    const scale = clamp(Math.min((r.width - pad) / w, (r.height - pad) / h, 1.5));
    setTfNow({ x: (r.width - w * scale) / 2 - x0 * scale, y: (r.height - h * scale) / 2 - y0 * scale, scale });
  }

  function addCondition() {
    const tag = (window.prompt("Finish tag for this condition (e.g. LVT-1):") || "").trim();
    if (!tag) return;
    // auto-vary line color AND hatch so each new finish reads distinctly, like a drawing
    const lc = PALETTE[conditions.length % PALETTE.length];
    const c = {
      id: uid("cnd"), finish_tag: tag,
      color: lc,            // line color
      fill: lc,             // fill color (NO_FILL for outline-only)
      hatch: HATCHES[1 + (conditions.length % (HATCHES.length - 1))].id,
      multiplier: 1,        // ×N for identical repeated units (measure one, multiply)
      waste_pct: 0,         // flooring waste allowance (manual) — applied in the Report
      materials: [],        // supporting materials (adhesive, grout, …) with coverage rates
    };
    setConditions((cs) => [...cs, c]); setActiveCond(c.id);
  }
  const updateCond = (patch) => setConditions((cs) => cs.map((c) => (c.id === activeCond ? { ...c, ...patch } : c)));

  // delete a condition entirely (and its takeoffs); pick a new active one
  function deleteCondition(id) {
    const c = condById[id];
    if (!c) return;
    const owned = shapes.filter((s) => s.condition_id === id);
    if (owned.length && !window.confirm(`Delete ${c.finish_tag} and its ${owned.length} takeoff${owned.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    const next = conditions.filter((x) => x.id !== id);
    if (owned.length) setShapes((ss) => ss.filter((s) => s.condition_id !== id));
    setConditions(next);
    if (activeCond === id) setActiveCond(next[0]?.id || "");
    setCommitMsg(`Deleted ${c.finish_tag}${owned.length ? ` and ${owned.length} takeoff${owned.length === 1 ? "" : "s"}` : ""}.`);
  }

  // custom columns: project-scoped vocabulary editing + per-condition assignment.
  // Snapshot-compare asymmetry, accepted: the diff (COND_FIELDS quantities) is
  // blind to attrs/definition changes, yet Load restores them — an assignments-
  // only change diffs as "unchanged". Known, not a bug.
  const assignAttr = (colId, v) => {
    // hydrate sanitizes attrs (sanitizeConditionAttrs), so spreading is safe;
    // an absent attrs spreads to {}
    const attrs = { ...aCond?.attrs };
    if (v) attrs[colId] = v; else delete attrs[colId];   // Unassigned = key absent, never ""
    updateCond({ attrs });
  };
  const addColumn = () => setConditionColumns((cols) => [...cols, { id: uid("col"), name: "", values: [] }]);
  const renameColumn = (colId, name) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, name } : cc)));   // id stays — assignments follow automatically
  const addColumnValue = (colId, v) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId && !cc.values.includes(v) ? { ...cc, values: [...cc.values, v] } : cc)));
  const removeColumnValue = (colId, v) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, values: cc.values.filter((x) => x !== v) } : cc)));   // assigned conditions keep the string — selects show "(removed)"
  const renameColumnVal = (colId, oldV) => {
    const newV = (window.prompt("Rename value:", oldV) || "").trim();
    if (!newV || newV === oldV) return;
    // rename into an existing value = merge (values are unique — they key the chips and the select options)
    setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, values: cc.values.includes(newV) ? cc.values.filter((x) => x !== oldV) : cc.values.map((x) => (x === oldV ? newV : x)) } : cc)));
    setConditions((cs) => renameColumnValue(cs, colId, oldV, newV));   // assignments follow the vocabulary
  };
  const deleteColumn = (colId) => {
    const cc = conditionColumns.find((c) => c.id === colId);
    if (!window.confirm(`Delete column "${columnLabel(cc)}" for the whole project? Conditions keep their values but they're no longer shown or exported.`)) return;
    setConditionColumns((cols) => cols.filter((c) => c.id !== colId));   // orphaned attrs[colId] stay behind — harmless, nothing iterates raw attrs
  };

  // supporting-materials editing (operates on the active condition)
  const addMaterial = () => updateCond({ materials: [...(aCond?.materials || []), { id: uid("mat"), name: "", per: 0, basis: "area", unit: "", round: true }] });
  const updateMaterial = (mid, patch) => updateCond({ materials: (aCond?.materials || []).map((m) => (m.id === mid ? { ...m, ...patch } : m)) });
  const removeMaterial = (mid) => updateCond({ materials: (aCond?.materials || []).filter((m) => m.id !== mid) });
  // Height/Thickness are LIVE parameters (Kreo-style): changing them re-flows
  // every dependent shape on this condition — wall SF tracks the tile height.
  const setCondParam = (field, raw) => {
    const v = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
    updateCond({ [field]: v });
    setShapes((ss) => ss.map((s) => {
      // height: existing walls KEEP their drawn height (the condition H only
      // seeds new traces — Michael: 4-ft wainscot stays 4 ft when the next
      // wall goes full height). Thickness still re-flows linears live.
      if (s.condition_id !== activeCond) return s;
      if (!(field === "thickness_in" && s.measure_role === "linear")) return s;
      const sp = panelByKey(s.sheet_id);
      const u = uppFor(s.sheet_id) || 0;
      const LF = openLen(s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h])) * u;
      return { ...s, computed: { perimeter_lf: +LF.toFixed(2), area_sf: v > 0 ? +((LF * v) / 12).toFixed(2) : 0 } };
    }));
  };
  function undoLast() { setShapes((s) => { const mine = s.filter((x) => panelKeySet.has(x.sheet_id)); if (!mine.length) return s; const last = mine[mine.length - 1]; return s.filter((x) => x !== last); }); }

  const condById = Object.fromEntries(conditions.map((c) => [c.id, c]));
  const aCond = condById[activeCond];
  const activeColor = aCond?.color || "#c96442";
  // Pattern id encodes the appearance so a hatch/color change yields a NEW paint
  // server — otherwise browsers keep painting the cached old pattern (the "it
  // reverted" bug). Shapes and <defs> use the same id.
  const patId = (c) => `hx-${c.id}-${c.hatch || "solid"}-${String(c.color).slice(1)}-${String(c.fill || "n").slice(1)}${darkMode ? "-d" : ""}`;
  // Fill for a committed shape. Hatch tiles are 10 stage-units — once the zoom
  // puts a tile under ~4 screen px the pattern aliases into subpixel mush
  // (worst over the inverted dark sheet), so overview zoom swaps to a solid
  // tint and every condition still reads as a clear color block. Dark mode gets
  // its legibility from brighter alphas here, NOT from a CSS filter on the
  // overlay — filtering that whole layer re-rasterizes it on every sync.
  const shapeFill = (cond) => {
    if (!cond) return "none";
    const solid = cond.fill && cond.fill !== NO_FILL ? cond.fill : null;
    if (tf.scale < 0.35) return (solid || cond.color) + (darkMode ? "59" : "40");
    if (cond.hatch && cond.hatch !== "solid") return `url(#${patId(cond)})`;
    return solid ? solid + (darkMode ? "4d" : "33") : "none";
  };
  const mm = closedMetrics(poly);
  // the live readout prices the IN-PROGRESS poly with its own panel's scale
  const liveUpp = poly.length ? uppFor(panelAt(poly[0][0]).key) : uppFor(focusPanel.key);
  const liveArea = liveUpp ? mm.area * liveUpp * liveUpp : null;
  const livePerim = liveUpp ? mm.perim * liveUpp : null;
  const condMult = aCond?.multiplier || 1;
  // HUD + Takeoffs panel are sheet-scoped ("this sheet"): they total the
  // VISIBLE shapes through the same conditionTotals rules the Report uses —
  // one source of role math, two scopes.
  const visRows = conditionTotals(conditions, visibleShapes);
  const visRowById = new Map(visRows.map((r) => [r.id, r]));
  const condRow = visRowById.get(activeCond);
  const condTotal = condRow?.floor_sf || 0;
  const lfTotal = condRow?.lf || 0;
  const countTotal = condRow?.ea || 0;
  const wallTotal = condRow?.wall_sf || 0;
  const borderTotal = condRow?.border_sf || 0;
  // display-only Kreo-style derived metric: floor-area perimeters × the condition height
  const condH = Number(aCond?.height_ft) || 0; // the live-readout JSX below still reads this
  const vertTotal = verticalWallSf(visibleShapes, activeCond, aCond?.height_ft, condMult);
  const num = (v, d = 1) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  const stdValue = unitsPerPx ? (STANDARD_SCALES.find((s) => Math.abs(s.upp - unitsPerPx) < 1e-9)?.label || "") : "";

  const markupCount = markups.filter((m) => panelKeySet.has(m.sheet_id)).length;
  const selShape = selectedId ? visibleShapes.find((s) => s.id === selectedId) : null;
  const setShapeHeight = (raw) => {
    const v = Math.max(0, parseFloat(raw) || 0);
    setShapes((ss) => ss.map((s) => {
      if (s.id !== selectedId) return s;
      const next = { ...s, height_ft: v, height_override: true };
      return { ...next, computed: recomputeShape(next) };
    }));
  };
  const clearShapeHeight = () => {
    setShapes((ss) => ss.map((s) => {
      if (s.id !== selectedId) return s;
      const next = { ...s, height_ft: Number(condById[s.condition_id]?.height_ft) || 0, height_override: false };
      return { ...next, computed: recomputeShape(next) };
    }));
  };
  const measureActive = MEASURE_TOOLS.some((t) => t.id === tool);
  const faceTool = MEASURE_TOOLS.find((t) => t.id === (measureActive ? tool : lastMeasureRef.current)) || MEASURE_TOOLS[0];
  const finishOk = ((tool === "area" || tool === "deduct") && poly.length >= 3) || ((tool === "linear" || tool === "surface") && poly.length >= 2);

  // compact icon button — chrome on the brand tokens; active = cobalt
  const iconBtn = (key, iconName, label, hint, showLabel = true) => (
    <button key={key} onClick={() => { setTool(key); if (MARKUP_IDS.includes(key)) setMarkupDraft(null); }} title={hint || label}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${tool === key ? "var(--cobalt)" : "var(--ink-faint)"}`, background: tool === key ? "var(--cobalt)" : "transparent", color: tool === key ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
      <Icon name={iconName} size={15} />{showLabel ? label : null}
    </button>
  );
  // panel-toggle for the right-edge rail — square like the zoom cluster, count as a
  // tiny mono line under the icon. Lives on the canvas, costs the toolbar zero rows.
  const panelBtn = (onClick, iconName, label, isOn, count) => (
    <button onClick={onClick} title={label}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, width: 34, minHeight: 34, padding: "5px 0 4px", border: `1px solid ${isOn ? "var(--ink)" : "var(--ink-faint)"}`, background: isOn ? "var(--ink)" : "var(--paper-bright)", color: isOn ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, lineHeight: 1 }}>
      <Icon name={iconName} size={15} />{count ? <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5 }}>{count}</span> : null}
    </button>
  );
  const vRule = <span style={{ width: 1, alignSelf: "stretch", background: "var(--ink-faint)", margin: "0 3px" }} />;

  // ── panel condition list: VIEW-ONLY search / natural sort / grouping ──────
  // (c, i) pairs keep each condition's ORIGINAL index so the hotkey badge
  // stays honest under any view — 1–9 always map to array positions.
  const condView = (() => {
    let v = conditions.map((c, i) => ({ c, i }));
    const q = condQuery.trim().toLowerCase();
    if (q) v = v.filter(({ c }) => (c.finish_tag || "").toLowerCase().includes(q));
    if (panelPrefs.az) v = [...v].sort((a, b) => natCompare(a.c.finish_tag, b.c.finish_tag));
    return v;
  })();
  const condGroups = (() => {
    if (!panelPrefs.group) return [{ name: null, items: condView }];
    const by = new Map();
    for (const it of condView) {
      const fam = tagFamily(it.c.finish_tag);
      if (!by.has(fam)) by.set(fam, []);
      by.get(fam).push(it);
    }
    return [...by.entries()].sort((a, b) => natCompare(a[0], b[0])).map(([name, items]) => ({ name, items }));
  })();
  const searchMiss = conditions.length > 0 && condView.length === 0;

  // bulk selection helpers — ranges follow the DISPLAYED order (current view,
  // skipping collapsed groups), which is what ⇧-click means visually
  const visibleCondOrder = condGroups.flatMap((g) => (g.name != null && closedGroups.has(g.name) ? [] : g.items.map((it) => it.c.id)));
  const toggleChecked = (id) => {
    setCheckedConds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    checkAnchorRef.current = id;
  };
  const rangeCheck = (id) => {
    const a = checkAnchorRef.current;
    const ai = a ? visibleCondOrder.indexOf(a) : -1, bi = visibleCondOrder.indexOf(id);
    if (ai < 0 || bi < 0) { toggleChecked(id); return; }
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    setCheckedConds((s) => { const n = new Set(s); for (let k = lo; k <= hi; k++) n.add(visibleCondOrder[k]); return n; });
  };
  const bulkPatch = (patch) => setConditions((cs) => cs.map((c) => (checkedConds.has(c.id) ? { ...c, ...patch } : c)));
  const applyBulkWaste = () => {
    const v = Math.max(0, parseFloat(bulkWaste));
    if (!Number.isFinite(v)) return;
    bulkPatch({ waste_pct: v });
    setCommitMsg(`Waste set to ${v}% on ${checkedConds.size} condition${checkedConds.size === 1 ? "" : "s"}.`);
  };
  const bulkDelete = () => {
    const ids = checkedConds;
    if (!ids.size) return;
    const owned = shapes.filter((s) => ids.has(s.condition_id)).length;
    if (!window.confirm(`Delete ${ids.size} condition${ids.size === 1 ? "" : "s"}${owned ? ` and their ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}? This can't be undone.`)) return;
    setConditions((cs) => cs.filter((c) => !ids.has(c.id)));
    if (owned) setShapes((ss) => ss.filter((s) => !ids.has(s.condition_id)));
    if (ids.has(activeCond)) setActiveCond(conditions.find((c) => !ids.has(c.id))?.id || "");
    setCheckedConds(new Set());
    setCommitMsg(`Deleted ${ids.size} condition${ids.size === 1 ? "" : "s"}${owned ? ` and ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}.`);
  };

  // ── condition template library ops (browser-global; store meta key) ───────
  const persistTemplates = (next) => {
    templatesRef.current = next; setTemplates(next);
    store.saveTemplates(next).catch((e) => setCommitMsg(`Couldn't save the library: ${e.message || e}`));
  };
  const condToTemplate = (c) => ({
    finish_tag: c.finish_tag, color: c.color, fill: c.fill, hatch: c.hatch || "solid",
    waste_pct: c.waste_pct || 0,
    ...(c.height_ft != null ? { height_ft: c.height_ft } : {}),
    ...(c.thickness_in != null ? { thickness_in: c.thickness_in } : {}),
    materials: (c.materials || []).map(({ id: _id, ...m }) => m),   // ids are minted on instantiation
  });
  const saveActiveAsTemplate = () => {
    if (!aCond) return;
    const tpl = condToTemplate(aCond);
    const at = templates.findIndex((t) => t.finish_tag === tpl.finish_tag);
    if (at >= 0 && !window.confirm(`A “${tpl.finish_tag}” template is already in the library — replace it?`)) return;
    persistTemplates(at >= 0 ? templates.map((t, i) => (i === at ? tpl : t)) : [...templates, tpl]);
    setCommitMsg(`Saved ${tpl.finish_tag} to the library.`);
  };
  const applyTemplate = (t) => {
    const c = instantiateTemplate(t);
    setConditions((cs) => [...cs, c]);
    setActiveCond(c.id);
    setPanelTab("takeoffs");
    setCommitMsg(`Added ${c.finish_tag} from the library.`);
  };
  const renameTemplate = (idx) => {
    const t = templates[idx];
    const tag = (window.prompt("Template tag:", t.finish_tag) || "").trim();
    if (!tag || tag === t.finish_tag) return;
    persistTemplates(templates.map((x, i) => (i === idx ? { ...x, finish_tag: tag } : x)));
  };
  const deleteTemplate = (idx) => {
    const t = templates[idx];
    if (!window.confirm(`Remove the ${t.finish_tag} template from the library? Existing conditions are unaffected.`)) return;
    persistTemplates(templates.filter((_, i) => i !== idx));
  };

  const renderCondRow = (c, i) => {
    const row = visRowById.get(c.id);
    const mult = c.multiplier || 1;
    const sf = row?.floor_sf || 0, lf = row?.lf || 0, ea = row?.ea || 0, wsf = row?.wall_sf || 0;
    const shapeCount = row?.shape_count || 0;
    const on = c.id === activeCond;
    const matOn = on && panelMatOpen;
    const reassigning = tool === "select" && selectedId;
    const checked = checkedConds.has(c.id);
    return (
      <div key={c.id} style={{ borderTop: "1px solid var(--ink-faint)", background: checked ? "#e8eefc" : on ? "#f3f8f4" : "transparent", borderLeft: on ? `3px solid ${c.color}` : checked ? "3px solid #1f3fc7" : "3px solid transparent" }}>
        <div onClick={(e) => {
            if (e.metaKey || e.ctrlKey) { toggleChecked(c.id); return; }
            if (e.shiftKey) { rangeCheck(c.id); return; }
            if (reassigning) reassignSelected(c.id);
            setActiveCond(c.id);
            if (checkedConds.size) setCheckedConds(new Set());
          }}
          onDoubleClick={() => locateCondition(c.id)}
          title={reassigning ? "Reassign selected shape to this condition" : "Make this the active condition (double-click zooms to its takeoffs · ⌘-click / ⇧-click selects for bulk edit)"}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", outline: reassigning ? "1px dashed #1f3fc7" : "none", outlineOffset: -3, userSelect: "none" }}>
          {i < 9 && <span style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", borderRadius: 3, padding: "0 3px", flexShrink: 0 }}>{i + 1}</span>}
          <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: on ? 700 : 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.finish_tag}{mult > 1 ? <span style={{ color: "var(--ink-muted)", fontWeight: 500 }}> ×{mult}</span> : null}</div>
            <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 11, color: "var(--ink-muted)" }}>
              {sf ? `${num(sf)} SF` : ""}{wsf ? `${sf ? " · " : ""}${num(wsf)} SF wall` : ""}{lf ? `${sf || wsf ? " · " : ""}${num(lf)} LF` : ""}{ea ? `${sf || wsf || lf ? " · " : ""}${num(ea, 0)} EA` : ""}{!sf && !wsf && !lf && !ea ? "—" : ""}
            </div>
          </div>
          <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)", flexShrink: 0 }}>{shapeCount}▦</span>
          <button onClick={(e) => { e.stopPropagation(); locateCondition(c.id); }} title="Zoom the canvas to this condition's takeoffs"
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>⌖</button>
          <button onClick={(e) => { e.stopPropagation(); setActiveCond(c.id); setPanelMatOpen((v) => (on ? !v : true)); }}
            title="Assemblies — supporting materials for this condition"
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: matOn ? "var(--ink)" : "transparent", color: matOn ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>
            <Icon name="product" size={11} />{c.materials?.length ? c.materials.length : ""}
          </button>
          <button onClick={(e) => { e.stopPropagation(); deleteCondition(c.id); }} title="Delete this condition (and its takeoffs)"
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        {/* properties for the ACTIVE condition — the appearance editing
            that used to live in its own toolbar row above the canvas */}
        {on && (
          <div style={{ padding: "4px 12px 10px", display: "flex", flexDirection: "column", gap: 7, fontSize: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input value={c.finish_tag} onChange={(e) => updateCond({ finish_tag: e.target.value })}
                title="Rename this condition / finish tag"
                style={{ width: 88, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, color: "var(--ink)" }} />
              <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Multiply this condition by N identical units (measure one, ×N)">
                <span style={{ color: "var(--ink-muted)" }}>×</span>
                <input type="number" min="1" step="1" value={c.multiplier || 1}
                  onChange={(e) => updateCond({ multiplier: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  style={{ width: 46, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Waste % — a flooring allowance added on top of the measured quantity in the Report. You choose it per condition (e.g. ~8% straight-lay LVP, ~15% diagonal, ~20% herringbone).">
                <span style={{ color: "var(--ink-muted)" }}>Waste</span>
                <input type="number" min="0" step="1" value={c.waste_pct ?? 0}
                  onChange={(e) => updateCond({ waste_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
                  style={{ width: 50, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
                <span style={{ color: "var(--ink-muted)" }}>%</span>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ color: "var(--ink-muted)", width: 26 }}>Line</span>
              {PALETTE.map((p) => <button key={p} title={p} onClick={() => updateCond({ color: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, border: c.color === p ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ color: "var(--ink-muted)", width: 26 }}>Fill</span>
              <button title="No fill" onClick={() => updateCond({ fill: NO_FILL })} style={{ width: 16, height: 16, borderRadius: 4, background: "var(--paper-bright)", border: c.fill === NO_FILL ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 9, lineHeight: "12px", color: "#b03a26" }}>⦸</button>
              {PALETTE.map((p) => <button key={p} title={p} onClick={() => updateCond({ fill: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, opacity: 0.55, border: c.fill === p ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
                <button onClick={() => setHatchOpen((v) => !v)} title="Choose a hatch pattern"
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 7px 2px 2px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}>
                  <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
                  <span style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1 }}>{(HATCHES.find((h) => h.id === (c.hatch || "solid")) || {}).label || "Solid"} ▾</span>
                </button>
                {hatchOpen && (
                  <div style={{ position: "absolute", top: 26, left: 0, zIndex: 30, display: "grid", gridTemplateColumns: "repeat(6, auto)", gap: 4, padding: 8, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)" }}>
                    {HATCHES.map((h) => {
                      const hOn = (c.hatch || "solid") === h.id;
                      return <button key={h.id} title={h.label} onClick={() => { updateCond({ hatch: h.id }); setHatchOpen(false); }} style={{ padding: 1, borderRadius: 0, border: hOn ? `2px solid ${activeColor}` : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}><HatchSwatch type={h.id} line={c.color} fill={c.fill} /></button>;
                    })}
                  </div>
                )}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Height (ft) — the default for NEW wall traces (SF = LF × H) and the vertical-SF display on floor areas. Walls keep the height they were drawn at — select a wall to change just that one.">
                <Icon name="height" size={13} /><span style={{ color: "var(--ink-muted)" }}>H</span>
                <input type="number" min="0" step="0.25" value={c.height_ft ?? ""} placeholder="ft"
                  onChange={(e) => setCondParam("height_ft", e.target.value)}
                  style={{ width: 54, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Thickness (in) — a Linear run with thickness also computes border/feature-strip SF = LF × T/12. Changing it re-flows existing linear runs.">
                <Icon name="thickness" size={13} /><span style={{ color: "var(--ink-muted)" }}>T</span>
                <input type="number" min="0" step="0.25" value={c.thickness_in ?? ""} placeholder="in"
                  onChange={(e) => setCondParam("thickness_in", e.target.value)}
                  style={{ width: 50, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              </span>
            </div>
            {conditionColumns.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 2 }} title="Classify this condition — the Report can group and export by these (manage columns in the Columns tab)">
                <ColumnSelects columns={conditionColumns} cond={c} onAssign={assignAttr} />
              </div>
            )}
          </div>
        )}
        {matOn && (
          <div style={{ padding: "8px 12px 10px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)", fontSize: 11.5 }}>
            <div style={{ marginBottom: 6, color: "var(--ink-muted)" }}>Assemblies — order qty = measured ÷ coverage, rounded up.</div>
            <MaterialsEditor materials={c.materials} onAdd={addMaterial} onUpdate={updateMaterial} onRemove={removeMaterial} />
          </div>
        )}
      </div>
    );
  };

  return (
    // .app-shell: the print stylesheet collapses this 100vh flex column while the report is open
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files); }}
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* toolbar — open/sheets | modes | tool menus | scale | actions | panels */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", padding: "8px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--ink)", letterSpacing: "-0.02em" }}>open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span></strong>
        <input ref={fileInputRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed" multiple style={{ display: "none" }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} title="Open plans — PDF, image, or a .zip plan set (or just drag them onto the canvas)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="plus" size={14} />Open</button>
        <button type="button" onClick={() => setView("gallery")}
          title="Plan set — the visual gallery; open one or several sheets (G)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${sheetGroup.length ? "var(--cobalt)" : "var(--ink-faint)"}`, background: sheetGroup.length ? "var(--cobalt)" : "transparent", color: sheetGroup.length ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="sheets" size={15} />Sheets{sheetGroup.length ? ` (${sheetGroup.length})` : ""}
        </button>
        {sheetGroup.length > 0 && (
          <button type="button" onClick={ungroup} title="Back to one sheet — you land on the sheet you were last working; every sheet keeps its takeoffs and markups"
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12.5 }}>Ungroup</button>
        )}
        {!sheetGroup.length && lastGroup.length >= 2 && (
          <button type="button" onClick={regroup} title={`Side-by-side again with the same ${lastGroup.length} sheets — each keeps its own scale, takeoffs and markups`}
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12.5 }}>Regroup ({lastGroup.length})</button>
        )}
        {sheets.length > 1 && !sheetGroup.length && (
          <select value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }} style={{ padding: 6, border: "1px solid var(--ink-faint)", background: "transparent", maxWidth: 220, fontSize: 12 }}>
            {sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        )}
        {!sheetGroup.length && pageCount > 1 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={{ padding: "5px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}><Icon name="chevronLeft" size={12} /></button>
            <select value={page} onChange={(e) => setPage(parseInt(e.target.value, 10))} style={{ padding: "5px 6px", border: "1px solid var(--ink-faint)", background: "transparent", fontFamily: "var(--f-mono,monospace)", fontSize: 12 }}>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{pageLabels[n] ? `${pageLabels[n]}  ·  ${n}/${pageCount}` : `Sheet ${n} / ${pageCount}`}</option>)}
            </select>
            <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount} style={{ padding: "5px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}><Icon name="chevronRight" size={12} /></button>
          </span>
        )}
        {vRule}
        {iconBtn("pan", "pan", "", "Pan (P) — or hold right-click / Space mid-measure", false)}
        {iconBtn("select", "select", "", "Select (V) — pick a takeoff, drag points", false)}
        <ToolMenu
          title="Measure — the face shows the armed tool"
          active={measureActive}
          onOpenChange={(o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }}
          face={<><Icon name={faceTool.icon} size={15} /><span style={{ opacity: measureActive ? 1 : 0.6 }}>{faceTool.label}</span></>}
          items={MEASURE_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, onSelect: () => setTool(t.id) }))}
        />
        <ToolMenu
          title="Cut Out — subtract voids/columns (counts negative)"
          active={tool === "deduct"} accent="danger"
          onOpenChange={(o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }}
          face={<><Icon name="deduct" size={15} /><span>Cut Out</span></>}
          items={CUT_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, tint: "var(--c-danger)", onSelect: () => setTool(t.id) }))}
        />
        <ToolMenu
          title="Markup — annotations, not measurements"
          active={MARKUP_IDS.includes(tool)}
          onOpenChange={(o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }}
          face={<><Icon name="markup" size={15} /><span>Markup</span></>}
          items={MARKUP_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, active: tool === t.id, onSelect: () => { setTool(t.id); setMarkupDraft(null); } }))}
        />
        <ToolMenu
          title="Edit takeoffs"
          onOpenChange={(o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }}
          face={<span>Edit</span>}
          items={[
            { id: "copy", icon: "copy", label: "Copy", shortcut: "⌘C", disabled: !selectedId, onSelect: copySelected },
            { id: "paste", icon: "paste", label: "Paste", shortcut: "⌘V", disabled: !clipRef.current.length, onSelect: () => pasteClipboard() },
            { id: "dup", icon: "duplicate", label: "Duplicate", shortcut: "⌘D", disabled: !selectedId, onSelect: duplicateSelected },
            "divider",
            { id: "finish", icon: "check", label: `Finish shape${poly.length ? ` (${poly.length} pts)` : ""}`, shortcut: "↵", disabled: !finishOk, onSelect: finishShape },
            { id: "undopt", icon: "undo", label: "Undo last point", shortcut: "⌘Z", disabled: !poly.length, onSelect: () => setPoly((q) => q.slice(0, -1)) },
            { id: "undoshape", icon: "undo", label: "Undo last shape", disabled: !visibleShapes.length, onSelect: undoLast },
            "divider",
            { id: "del", icon: "close", label: "Delete selected", shortcut: "⌫", disabled: !selectedId, tint: "var(--c-danger)", onSelect: deleteSelected },
          ]}
        />
        <button onClick={() => setSnapOn((v) => !v)} title="Snap to plan lines/corners (beta)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${snapOn ? "var(--c-positive)" : "var(--ink-faint)"}`, background: snapOn ? "var(--c-positive)" : "transparent", color: snapOn ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="snap" size={15} />{snapOn ? "Snap ✓" : "Snap"}
        </button>
        <button onClick={() => setAngleOn((v) => !v)} title="45°/90° angle guides — the next segment locks to the 45° family as you draw (hold ⇧ to force the lock at any angle)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${angleOn ? "var(--cobalt)" : "var(--ink-faint)"}`, background: angleOn ? "var(--cobalt)" : "transparent", color: angleOn ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="angle" size={15} />{angleOn ? "45° ✓" : "45°"}
        </button>
        {vRule}
        {/* scale group: standard dropdown + plan-note chip + calibrate */}
        <select value={stdValue} onChange={(e) => { const f = STANDARD_SCALES.find((s) => s.label === e.target.value); if (f) { setScales((s) => ({ ...s, [focusPanel.key]: f.upp })); setScaleSources((s) => ({ ...s, [focusPanel.key]: "standard" })); } }}
          title={`Set the scale for ${labelFor(focusPanel)} — remembered per sheet${groupKeys.length > 1 ? " (targets the sheet you last clicked)" : ""}`}
          style={{ padding: 6, border: unitsPerPx ? "1px solid var(--c-positive)" : "1px solid var(--ink-faint)", background: "transparent", color: unitsPerPx ? "var(--c-positive)" : "var(--c-danger)", fontSize: 12 }}>
          <option value="">{unitsPerPx ? `scale set${stdValue ? "" : " · custom"} ✓` : `Set scale for ${labelFor(focusPanel)}…`}</option>
          {STANDARD_SCALES.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
        </select>
        {(() => {
          const det = detectedScales[focusPanel.key];
          if (!det) return null;
          if (!unitsPerPx) return (
            <button type="button" onClick={() => { setScales((s) => ({ ...s, [focusPanel.key]: det.upp })); setScaleSources((s) => ({ ...s, [focusPanel.key]: "detected" })); }}
              title={`The plan notes ${det.label} on ${labelFor(focusPanel)}${det.multi ? " — this sheet shows several scales (details are often larger); confirm against a known dimension" : ""}. Click to use it.`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 9px", border: "1px dashed var(--c-positive)", background: "transparent", color: "var(--c-positive)", cursor: "pointer", fontSize: 11.5, fontWeight: 600, lineHeight: 1 }}>
              <Icon name="target" size={13} />plan says {det.label}{det.multi ? " ±" : ""} — use
            </button>
          );
          if (stdValue && Math.abs(det.upp - unitsPerPx) > 1e-9) return (
            <span title={`You set ${stdValue}, but the plan notes ${det.label} on ${labelFor(focusPanel)} — double-check before tracing.`}
              style={{ fontSize: 11, color: "var(--c-danger)", fontWeight: 700 }}>≠ plan says {det.label}</span>
          );
          return null;
        })()}
        {iconBtn("calibrate", "calibrate", "", "Calibrate — click two points of a known dimension", false)}
        <button type="button" onClick={toggleHiRes}
          title={`Hi-Res rendering for ${labelFor(focusPanel)} — the sheet re-rasters at an auto quality budget (~28MP), so memory stays bounded even side-by-side; crisper when zoomed in. Saved per sheet, per user. Quantities are unaffected.`}
          style={{ display: "inline-flex", alignItems: "center", padding: "6px 9px", border: `1px solid ${hiResOn(focusPanel.key) ? "var(--cobalt)" : "var(--ink-faint)"}`, background: hiResOn(focusPanel.key) ? "var(--cobalt)" : "transparent", color: hiResOn(focusPanel.key) ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", lineHeight: 1 }}>
          <Icon name="hiRes" size={15} />
        </button>
        <div style={{ flex: 1 }} />
        {markupDraft && (tool === "cloud" || tool === "callout") && <span style={{ fontSize: 11, color: "var(--cobalt)" }}>click the {tool === "cloud" ? "opposite corner" : "label spot"}…</span>}
        {finishOk && (
          <button onClick={finishShape} title="Finish shape (↵ or double-click)" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Finish ({poly.length})</button>
        )}
        {proposal?.regions.length > 0 && (
          <button onClick={createProposal} title="Create the selected takeoff(s) (↵). ⌫ removes the last click; Esc discards the selection." style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Create ({proposal.regions.length})</button>
        )}
        <span style={{ fontSize: 11, color: "var(--ink-muted)", minWidth: 44, fontFamily: "var(--f-mono)" }}>{saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : ""}</span>
        <button onClick={() => setShowSnapshots((v) => !v)} title="Snapshots — save the takeoff as-is, then compare or restore it after an addendum"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${showSnapshots ? "var(--cobalt)" : "var(--ink-faint)"}`, background: showSnapshots ? "var(--cobalt)" : "transparent", color: showSnapshots ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="document" size={15} />Snapshots
        </button>
        <button onClick={() => setShowReport(true)} disabled={!conditions.length} title="Open the takeoff report — per-condition breakdown with waste, plus CSV / JSON export."
          style={{ padding: "8px 14px", border: "none", background: conditions.length ? "var(--ink)" : "var(--ink-faint)", color: "var(--paper-bright)", cursor: conditions.length ? "pointer" : "default", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" }}>Report</button>
      </div>

      {/* open-sheet tabs — what you opened from the gallery; click to view,
          ⊞ to side-by-side, ✕ to close; the dropdown lists every open sheet */}
      {openTabs.length > 0 && (
        <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "5px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--ink-muted)" }}>Sheets</span>
          {openTabs.slice(0, 8).map((k) => {
            const inGroup = sheetGroup.includes(k);
            const on = sheetGroup.length ? inGroup : k === sheetKey;
            const lbl = tabLabel(k);
            return (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--ink-faint)", borderBottom: on ? "2px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: on ? "var(--paper-cream)" : "transparent", padding: "3px 6px 2px 9px", maxWidth: 190 }}>
                <button onClick={() => goToSheet(k)} title={k} style={{ border: "none", background: "none", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 11.5, color: "var(--ink)", fontFamily: "var(--f-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140, padding: 0 }}>{lbl}</button>
                <button onClick={() => toggleInGroup(k)} title={inGroup ? "Remove from side-by-side" : "Side-by-side with the current sheet"} style={{ border: "none", background: "none", cursor: "pointer", color: inGroup ? "var(--cobalt)" : "var(--ink-faint)", padding: 0, display: "inline-flex" }}><Icon name="sideBySide" size={11} /></button>
                <button onClick={() => closeTab(k)} title="Close tab" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, display: "inline-flex" }}><Icon name="close" size={10} /></button>
              </span>
            );
          })}
          {openTabs.length > 1 && (
            <ToolMenu
              title="Jump to an open sheet"
              onOpenChange={(o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }}
              face={<span style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>{openTabs.length} open</span>}
              items={openTabs.map((k) => ({ id: k, icon: "document", label: tabLabel(k), active: sheetGroup.length ? sheetGroup.includes(k) : k === sheetKey, onSelect: () => goToSheet(k) }))}
            />
          )}
        </div>
      )}

      {/* compact conditions strip — OPTIONAL small-project mode. The docked
          Takeoffs panel is the primary conditions surface; the strip renders
          the same state (activate/reassign, hotkey badges, + condition) for
          users who want max panel-collapse and one-click switching. Toggled
          from the panel header, persisted with the panel prefs. */}
      {panelPrefs.strip && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-muted)" }}>Conditions</span>
          {conditions.map((c, i) => {
            const on = c.id === activeCond;
            return (
              <button key={c.id} onClick={() => { if (tool === "select" && selectedId) reassignSelected(c.id); setActiveCond(c.id); }} title={tool === "select" && selectedId ? "Reassign selected shape to this condition" : (i < 9 ? `Press ${i + 1}` : "")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 0, border: on ? `2px solid ${c.color}` : (tool === "select" && selectedId ? "1px dashed #1f3fc7" : "1px solid var(--ink-faint)"), background: on ? "#fff" : "transparent", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 12.5 }}>
                {i < 9 && <span style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", borderRadius: 3, padding: "0 3px" }}>{i + 1}</span>}
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>{c.finish_tag}
              </button>
            );
          })}
          <button onClick={addCondition} style={{ padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
        </div>
      )}

      {/* calibration prompt */}
      {tool === "calibrate" && (
        <div style={{ padding: "8px 14px", background: "var(--paper-bright)", borderBottom: "1px solid #f0d9c0", fontSize: 14 }}>
          {calib.length < 2 ? <span>Custom scale: click two points along a known dimension ({calib.length}/2). Tip: use the longest dimension. (Or just pick a standard scale above.)</span> : (
            <span>Real length:{" "}
              <input type="number" value={pendingLen} onChange={(e) => setPendingLen(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCalibration()} placeholder="feet" autoFocus style={{ width: 90, padding: 5, borderRadius: 0, border: "1px solid var(--ink-faint)" }} /> ft
              <button onClick={applyCalibration} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 0, border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer" }}>Apply</button>
              <button onClick={() => setCalib([])} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button>
            </span>
          )}
        </div>
      )}

      {/* canvas + issue desk */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
       <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div ref={containerRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={hideCrosshair} onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={() => { if (tool === "oneclick") { if (proposal?.regions.length) createProposal(); } else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface") finishShape(); }}
          style={{ position: "absolute", inset: 0, background: darkMode ? "#0b0e14" : "var(--paper-cream)", cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "none", touchAction: "none" }}>
          {/* aim crosshair (draw modes): the OS cursor is hidden on the canvas — the
              crosshair IS the cursor. Two crisp full-page hairlines riding the
              EFFECTIVE point (angle-locked / endpoint-snapped), the SPLINE STAR at
              the crossing, and a small readout chip in the house style. The 45°
              lock reads as a quiet state change (hairlines brighten, star swells
              cobalt, rubber band thickens) — no extra chrome on the sheet. All
              positioned imperatively in moveCrosshair. */}
          <div ref={crossVRef} style={{ position: "absolute", top: 0, bottom: 0, width: 1.5, background: "rgba(31,63,199,.55)", boxShadow: "0 0 0 0.5px rgba(255,255,255,.55), 0 0 4px rgba(31,63,199,.3)", pointerEvents: "none", display: "none", zIndex: 5 }} />
          <div ref={crossHRef} style={{ position: "absolute", left: 0, right: 0, height: 1.5, background: "rgba(31,63,199,.55)", boxShadow: "0 0 0 0.5px rgba(255,255,255,.55), 0 0 4px rgba(31,63,199,.3)", pointerEvents: "none", display: "none", zIndex: 5 }} />
          <div ref={aimMarkRef} style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none", display: "none", zIndex: 6, willChange: "transform" }}>
            {/* the SPLINE STAR at the crossing — the house vertex mark IS the cursor;
                it swells and glows cobalt while the 45° lock holds */}
            <svg width={22} height={22} viewBox="0 0 22 22" style={{ position: "absolute", left: -11, top: -11, transition: "transform 120ms ease, filter 120ms ease", filter: "drop-shadow(0 1px 2px rgba(14,26,46,.3))" }}>
              <path d={starPath(11, 11, 8.5)} fill="#1f3fc7" stroke="#fff" strokeWidth={1.4} />
            </svg>
          </div>
          <div ref={aimChipRef} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", display: "none", zIndex: 6, padding: "2px 8px", background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-1)", fontFamily: "var(--f-mono)", fontSize: 10.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", willChange: "transform" }} />
          {/* hover readout — what takeoff is under the cursor (DOM-direct) */}
          <div ref={hoverRef} style={{ position: "absolute", display: "none", pointerEvents: "none", zIndex: 8, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-1)", padding: "4px 8px", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)", whiteSpace: "nowrap" }} />
          <div ref={stageRef} style={{ position: "absolute", transformOrigin: "0 0", willChange: "transform", width: stage.w || undefined, height: stage.h || undefined }}>
            {panels.map((p) => (
              <canvas key={p.key} ref={(el) => { if (el) panelCanvasRefs.current.set(p.key, el); else panelCanvasRefs.current.delete(p.key); }}
                style={{ position: "absolute", left: p.xOffset, top: 0, boxShadow: "0 2px 20px rgba(0,0,0,.18)" }} />
            ))}
            {/* high-res detail overlay — a crop of the visible region re-rendered at the current zoom (see the detail-view effect) */}
            <canvas ref={detailCanvasRef} style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none" }} />
            <svg width={stage.w} height={stage.h} viewBox={`0 0 ${stage.w} ${stage.h}`} style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}>
              <defs>
                {conditions.map((c) => <HatchPattern key={patId(c)} id={patId(c)} type={c.hatch || "solid"} line={c.color} fill={c.fill} dark={darkMode} />)}
              </defs>
              {/* committed shapes + markups, one group per panel in its local frame */}
              {panels.map((p) => {
                const pShapes = shapes.filter((s) => s.sheet_id === p.key);
                const dn = (vn) => vn.map(([x, y]) => [x * p.img.w, y * p.img.h]);
                const label = labelFor(p);
                return (
                  <g key={p.key} transform={`translate(${p.xOffset},0)`}>
                    {panels.length > 1 && <text x={0} y={-26} fontSize={64} fontWeight={700} fill={darkMode ? "#9a917f" : "#6b6256"}>{label}</text>}
                    {pShapes.map((s) => {
                      const cond = condById[s.condition_id];
                      const col = cond?.color || "#888";
                      const sel = s.id === selectedId;
                      const pts = dn(s.verts_norm);
                      // Screen-constant strokes: zoom is a CSS transform on the
                      // stage div, which never enters this SVG's CTM — so
                      // vector-effect can't help and raw widths go subpixel at
                      // overview zoom (invisible conditions). Divide by scale
                      // like every other screen-relative size here.
                      const z = tf.scale;
                      const sw = (sel ? 4 : 2) / z;
                      if (s.measure_role === "count") {
                        const [cx, cy] = pts[0], r = 7 / z;
                        return <rect key={s.id} x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2 / z} fill={col + "cc"} stroke={sel ? "#1f3fc7" : "#fff"} strokeWidth={(sel ? 3 : 1.5) / z} />;
                      }
                      if (s.measure_role === "surface_area") {
                        return <polyline key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? "#1f3fc7" : col} strokeWidth={(sel ? 4.5 : 3.5) / z} strokeDasharray={`${10 / z} ${3 / z} ${2 / z} ${3 / z}`} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      if (s.measure_role === "linear") {
                        return <polyline key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? "#1f3fc7" : col} strokeWidth={(sel ? 4 : 3) / z} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      const ded = s.measure_role === "deduct";
                      return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill={ded ? "rgba(176,58,38,.28)" : shapeFill(cond)} stroke={ded ? "#b03a26" : (sel ? "#1f3fc7" : col)} strokeWidth={sw} strokeDasharray={ded ? `${6 / z} ${4 / z}` : "0"} />;
                    })}
                    {/* vertex handles for the selected shape (drag to reshape) */}
                    {selectedId && (() => {
                      const sel = pShapes.find((s) => s.id === selectedId);
                      if (!sel || sel.measure_role === "count") return null;
                      const qs = dn(sel.verts_norm);
                      const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
                      const hs = 4.5 / tf.scale, ms = 3 / tf.scale;
                      const edges = closed ? qs.length : qs.length - 1;
                      return (
                        <g>
                          {Array.from({ length: edges }, (_, i) => {
                            const a = qs[i], b = qs[(i + 1) % qs.length];
                            return <rect key={"m" + i} x={(a[0] + b[0]) / 2 - ms} y={(a[1] + b[1]) / 2 - ms} width={ms * 2} height={ms * 2} fill="#f4efe0" stroke="#1f3fc7" strokeWidth={1.4 / tf.scale} strokeDasharray={`${2 / tf.scale} ${1.5 / tf.scale}`} />;
                          })}
                          {qs.map((q, i) => <rect key={"h" + i} x={q[0] - hs} y={q[1] - hs} width={hs * 2} height={hs * 2} fill="#fff" stroke="#1f3fc7" strokeWidth={2 / tf.scale} />)}
                        </g>
                      );
                    })()}
                    {/* markup layer — clouds / callouts / text notes on this panel */}
                    {markups.filter((m) => m.sheet_id === p.key).map((m) => {
                      const mk = m.rfi_id ? "#1f3fc7" : "#c47a10";
                      if (m.type === "cloud") {
                        const [c0, c1] = m.rect;
                        return (
                          <g key={m.id}>
                            <path d={cloudPath(c0[0] * p.img.w, c0[1] * p.img.h, c1[0] * p.img.w, c1[1] * p.img.h)} fill="none" stroke={mk} strokeWidth={2 / tf.scale} />
                            {m.text && <text x={(c0[0] + c1[0]) / 2 * p.img.w} y={(c0[1] + c1[1]) / 2 * p.img.h} fill={mk} fontSize={13 / tf.scale} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.rfi_id ? "⬢ " : ""}{m.text}</text>}
                          </g>
                        );
                      }
                      if (m.type === "callout") {
                        const [tx, ty] = m.target, [ax, ay] = m.at;
                        return (
                          <g key={m.id}>
                            <line x1={tx * p.img.w} y1={ty * p.img.h} x2={ax * p.img.w} y2={ay * p.img.h} stroke={mk} strokeWidth={2 / tf.scale} />
                            <path d={starPath(tx * p.img.w, ty * p.img.h, 4 / tf.scale)} fill={mk} />
                            <rect x={ax * p.img.w} y={ay * p.img.h - 16 / tf.scale} width={(m.text.length * 7 + 10) / tf.scale} height={20 / tf.scale} fill="rgba(255,255,255,.92)" stroke={mk} strokeWidth={1 / tf.scale} rx={3 / tf.scale} />
                            <text x={(ax * p.img.w) + 5 / tf.scale} y={(ay * p.img.h) - 2 / tf.scale} fill="#0e1a2e" fontSize={12 / tf.scale}>{m.rfi_id ? "⬢ " : ""}{m.text}</text>
                          </g>
                        );
                      }
                      const [x, y] = m.at;
                      return (
                        <g key={m.id}>
                          <rect x={x * p.img.w - 3 / tf.scale} y={y * p.img.h - 14 / tf.scale} width={(m.text.length * 7 + 10) / tf.scale} height={20 / tf.scale} fill="rgba(255,247,237,.92)" stroke={mk} strokeWidth={1 / tf.scale} rx={3 / tf.scale} />
                          <text x={x * p.img.w + 2 / tf.scale} y={y * p.img.h} fill="#0e1a2e" fontSize={12 / tf.scale} fontWeight="600">{m.rfi_id ? "⬢ " : ""}{m.text}</text>
                        </g>
                      );
                    })}
                    {/* One-Click proposal preview — dashed cobalt selection, red dashed carve */}
                    {proposal && proposal.key === p.key && proposal.regions.map((r, i) => (
                      <g key={"oc" + i}>
                        <polygon points={r.poly.map((q) => q.join(",")).join(" ")}
                          fill={r.kind === "neg" ? "rgba(176,58,38,.18)" : "rgba(31,63,199,.10)"}
                          stroke={r.kind === "neg" ? "#b03a26" : "#1f3fc7"} strokeWidth={2.5 / tf.scale} strokeDasharray={`${7 / tf.scale} ${4 / tf.scale}`} />
                        <path d={starPath(r.seed[0], r.seed[1], 5 / tf.scale)} fill={r.kind === "neg" ? "#b03a26" : "#1f3fc7"} stroke="#fff" strokeWidth={1 / tf.scale} />
                      </g>
                    ))}
                  </g>
                );
              })}
              {/* IN-PROGRESS work draws in the INSTRUMENT color — the house cobalt pencil
                  (deduct keeps its danger red). Committed shapes wear the condition's own
                  color; the draft never mimics anyone's takeoff look. Solid, no dashes. */}
              <line ref={rubberRef} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={1.5 / tf.scale} strokeOpacity={0.85} strokeLinecap="round" style={{ display: "none" }} />
              <rect ref={rectRef} fill={tool === "deduct" ? "rgba(176,58,38,.22)" : shapeFill(aCond)} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={2 / tf.scale} style={{ display: "none" }} />
              <path ref={cloudRef} fill="rgba(37,99,235,.06)" stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${5 / tf.scale} ${4 / tf.scale}`} style={{ display: "none" }} />
              {poly.length >= 2 && (tool === "linear" || tool === "surface"
                ? <polyline points={poly.map((p) => p.join(",")).join(" ")} fill="none" stroke={tool === "surface" ? activeColor : "#1f3fc7"} strokeWidth={(tool === "surface" ? 3.5 : 2.5) / tf.scale} strokeDasharray={tool === "surface" ? `${10 / tf.scale} ${3 / tf.scale} ${2 / tf.scale} ${3 / tf.scale}` : undefined} strokeLinecap="round" strokeLinejoin="round" />
                : <polygon points={poly.map((p) => p.join(",")).join(" ")} fill={poly.length >= 3 ? (tool === "deduct" ? "rgba(176,58,38,.22)" : shapeFill(aCond)) : "none"} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={2 / tf.scale} />)}
              {/* bold the most recent segment so you see where you just clicked */}
              {poly.length >= 2 && (
                <line x1={poly[poly.length - 2][0]} y1={poly[poly.length - 2][1]} x2={poly[poly.length - 1][0]} y2={poly[poly.length - 1][1]}
                  stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={3.5 / tf.scale} strokeLinecap="round" />
              )}
              {poly.map((p, i) => {
                const isLast = i === poly.length - 1;
                return <path key={i} d={starPath(p[0], p[1], (isLast ? 4.5 : 3) / tf.scale)}
                  fill={isLast ? "#fff" : "#1f3fc7"} stroke="#1f3fc7" strokeWidth={(isLast ? 2 : 1) / tf.scale} />;
              })}
              {calib.length === 2 && <line x1={calib[0][0]} y1={calib[0][1]} x2={calib[1][0]} y2={calib[1][1]} stroke="#1f3fc7" strokeWidth={2 / tf.scale} />}
              {calib.map((p, i) => <path key={i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill="#1f3fc7" />)}
              {/* snap-to-vector indicator (star) */}
              <path ref={snapMarkRef} fill="#1f6b4a" stroke="#fff" strokeWidth={1 / tf.scale} style={{ display: "none" }} />
              {/* markup draft marker (first click of cloud/callout) */}
              {markupDraft && <path d={starPath(markupDraft[0], markupDraft[1], 5 / tf.scale)} fill="#1f3fc7" />}
            </svg>
          </div>

          {status !== "ready" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 15 }}>
              {status === "loading" && "Loading sheets…"}
              {status === "rendering" && "Rendering sheet…"}
              {status === "empty" && "No PDFs yet — click “Open PDF” or drag a plan onto the canvas."}
              {status === "error" && <span style={{ color: "#b03a26" }}>Error: {err}</span>}
            </div>
          )}

          {/* zoom buttons */}
          <div style={{ position: "absolute", left: 14, bottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {[["+", 1.25], ["−", 0.8]].map(([lbl, f]) => (
              <button key={lbl} onClick={() => { const r = containerRef.current.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, f); }}
                style={{ width: 34, height: 34, borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>{lbl}</button>
            ))}
            <button onClick={() => stage.w && fitToView(stage.w, stage.h)} title="Fit" style={{ width: 34, height: 34, borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>fit</button>
            <button onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Light view" : "Dark view (negative print)"}
              style={{ width: 34, height: 34, borderRadius: 0, border: `1px solid ${darkMode ? "var(--cobalt)" : "var(--ink-faint)"}`, background: darkMode ? "var(--cobalt)" : "var(--paper-bright)", color: darkMode ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontSize: 13 }}>
              {darkMode ? "☀" : "☾"}</button>
          </div>
        </div>

        {/* status line — the transient message bar (was the right end of the old
            conditions bar): floats bottom-center over the canvas, never blocks input */}
        {commitMsg && (
          <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", maxWidth: "70%", zIndex: 6, pointerEvents: "none", padding: "6px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-1)", fontSize: 12, color: commitMsg === STALE_TAB_MESSAGE || commitMsg.startsWith("Commit failed") ? "#b03a26" : "var(--c-positive)" }}>
            {commitMsg}
          </div>
        )}

        {/* live readout — top-right */}
        <div style={{ position: "absolute", right: 14, top: 14, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, padding: "12px 16px", minWidth: 200, boxShadow: "0 4px 18px rgba(0,0,0,.12)", fontVariantNumeric: "tabular-nums", zIndex: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6 }}>{aCond?.finish_tag || "No condition"}</div>
          {tool === "oneclick" && proposal?.regions.length ? (() => {
            const pos = proposal.regions.filter((r) => r.kind === "pos");
            const neg = proposal.regions.filter((r) => r.kind === "neg");
            const sf = pos.reduce((n, r) => n + r.area_sf, 0) - neg.reduce((n, r) => n + r.area_sf, 0);
            return (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#1f3fc7" }}>{num(sf)} <span style={{ fontSize: 13, fontWeight: 600 }}>SF selected</span></div>
                <div style={{ fontSize: 12.5, color: "#5b544a", marginTop: 2 }}>{pos.length} space{pos.length === 1 ? "" : "s"}{neg.length ? ` − ${neg.length} cutout${neg.length === 1 ? "" : "s"}` : ""} · {num(sf / 9)} SY</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>click adds a space · ⌥-click carves a cutout · ⏎ Create · ⌫ undo · Esc cancel</div>
              </>
            );
          })() : tool === "surface" && poly.length >= 2 && liveUpp ? (
            (() => {
              const liveLF = openLen(poly) * liveUpp;
              return condH > 0 ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#0e1a2e" }}>{num(liveLF * condH)} <span style={{ fontSize: 13, fontWeight: 600 }}>SF wall</span></div>
                  <div style={{ fontSize: 12.5, color: "#5b544a", marginTop: 2 }}>{num(liveLF)} LF × {num(condH, 2)} ft</div>
                </>
              ) : <div style={{ fontSize: 12.5, color: "#b03a26" }}>Set a height for {aCond?.finish_tag || "this condition"} — H in the Takeoffs panel</div>;
            })()
          ) : liveArea != null && poly.length >= 3 ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, color: tool === "deduct" ? "#b03a26" : "#0e1a2e" }}>{tool === "deduct" ? "−" : ""}{num(liveArea)} <span style={{ fontSize: 13, fontWeight: 600 }}>SF</span></div>
              <div style={{ fontSize: 12.5, color: "#5b544a", marginTop: 2 }}>{num(liveArea / 9)} SY &nbsp;·&nbsp; {num(livePerim)} LF perim</div>
              {condH > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>@H {num(condH, 2)}′: {num(livePerim * condH)} SF vert · {num((liveArea * condH) / 27)} CY</div>}
            </>
          ) : (
            <div style={{ fontSize: 12.5, opacity: 0.6 }}>{!unitsPerPx ? "Set scale first" : !activeCond ? "Pick a condition" : tool === "oneclick" ? "Click inside a room — it selects itself" : tool === "surface" ? "Trace the wall run" : "Click to trace an area"}</div>
          )}
          {selShape?.measure_role === "surface_area" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }} title="Height for THIS wall only — full-height tile here, 4-ft wainscot there, same condition. ↺ returns to the condition height.">
              <Icon name="height" size={12} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>this wall</span>
              <input type="number" min="0" step="0.25" value={selShape.height_ft ?? ""}
                onChange={(e) => setShapeHeight(e.target.value)}
                style={{ width: 56, padding: "2px 5px", border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>ft → {num(selShape.computed?.area_sf || 0)} SF</span>
              {condH > 0 && Number(selShape.height_ft) !== condH && (
                <button onClick={clearShapeHeight} title="Set this wall to the condition height" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0 }}>↺</button>
              )}
            </div>
          )}
          <div style={{ height: 1, background: "#eee6d8", margin: "8px 0" }} />
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.5 }}>{aCond?.finish_tag || "—"} total ({condRow?.shape_count || 0}{condMult > 1 ? ` ×${condMult}` : ""})</div>
          {condTotal !== 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(condTotal)} <span style={{ fontSize: 12, fontWeight: 600 }}>SF</span> <span style={{ fontSize: 12, fontWeight: 500, color: "#5b544a" }}>· {num(condTotal / 9)} SY</span></div>}
          {wallTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(wallTotal)} <span style={{ fontSize: 12, fontWeight: 600 }}>SF wall</span></div>}
          {borderTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(borderTotal)} <span style={{ fontSize: 12, fontWeight: 600 }}>SF border</span></div>}
          {lfTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(lfTotal)} <span style={{ fontSize: 12, fontWeight: 600 }}>LF</span></div>}
          {countTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(countTotal, 0)} <span style={{ fontSize: 12, fontWeight: 600 }}>EA</span></div>}
          {vertTotal > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }} title="Display only — floor-area perimeters × this condition's height (not committed)">{num(vertTotal)} SF vert (perim × H)</div>}
          {condTotal === 0 && lfTotal === 0 && countTotal === 0 && wallTotal === 0 && borderTotal === 0 && <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 2 }}>—</div>}
          <div style={{ fontSize: 10.5, opacity: 0.45, marginTop: 6 }}>{visibleShapes.length} shapes on {groupKeys.length > 1 ? `${groupKeys.length} sheets` : "sheet"} · zoom {(tf.scale * 100).toFixed(0)}%</div>
        </div>

        {/* panel rail — markup/takeoffs toggles on the right edge (zoom-cluster
            style). Moved out of the toolbar so it never wraps a third row; z above the
            takeoffs panel (which docks at right:56) so a lit toggle also closes it. */}
        <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 6, zIndex: 8 }}>
          {panelBtn(() => setShowMarkupPanel((v) => !v), "markup", "Markups on these sheets (clouds, callouts, notes)", showMarkupPanel, markupCount)}
          {panelBtn(toggleTakeoffs, "takeoffs", "Takeoffs — conditions + running totals", takeoffsOpen, visibleShapes.length)}
        </div>

        {/* markup panel — manage clouds/callouts/text + link or create RFIs (top-left, clear of HUD/FABs) */}
        {showMarkupPanel && (
          <div style={{ position: "absolute", left: 14, top: 14, width: 320, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid #1f3fc7", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)", zIndex: 7, fontSize: 12.5 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "#1f3fc7", color: "#fff", borderRadius: 0 }}>
              <strong>Markups · {groupKeys.length > 1 ? "these sheets" : "this sheet"}</strong>
              <button onClick={() => setShowMarkupPanel(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: "8px 10px", color: "var(--ink-muted)" }}>
              Pick <b>☁ Cloud</b>, <b>💬 Callout</b>, or <b>T Text</b> above, then click the plan to annotate it.
            </div>
            {markups.filter((m) => panelKeySet.has(m.sheet_id)).length === 0 && (
              <div style={{ padding: "4px 12px 14px", color: "var(--ink-muted)" }}>No markups {groupKeys.length > 1 ? "on these sheets" : "on this sheet"} yet.</div>
            )}
            {markups.filter((m) => panelKeySet.has(m.sheet_id)).map((m) => (
              <div key={m.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#1f3fc7", textTransform: "uppercase" }}>{m.type}</span>
                  <span style={{ flex: 1, color: "var(--ink)" }}>{m.text || <em style={{ color: "var(--ink-muted)" }}>(no text)</em>}</span>
                  <button onClick={() => { const t = window.prompt("Edit text:", m.text || ""); if (t != null) updateMarkup(m.id, { text: t.trim() }); }} title="Edit text" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)" }}>✎</button>
                  <button onClick={() => deleteMarkup(m.id)} title="Delete markup" style={{ border: "none", background: "none", cursor: "pointer", color: "#b03a26" }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

       </div>

        {/* Takeoffs panel — DOCKED in the layout row (reflows the canvas, not an
            overlay): every condition with its running totals. Click a row to make
            it active (in Select with a shape picked, it reassigns — same as the
            conditions bar). Resize by dragging the left edge; width + collapsed
            persist per user. Collapse/expand keeps the current transform — the
            stage is anchored top-left, so a re-fit would be a jarring jump. */}
        {takeoffsOpen && (
          <div style={{ width: panelW, flexShrink: 0, display: "flex", background: "var(--paper-bright)", borderLeft: "1px solid var(--ink-faint)", fontSize: 12.5 }}>
            <div onPointerDown={onPanelResizeDown} onPointerMove={onPanelResizeMove} onPointerUp={onPanelResizeUp}
              title="Drag to resize"
              style={{ width: 5, flexShrink: 0, cursor: "col-resize", touchAction: "none", background: "transparent", borderRight: "1px solid var(--ink-faint)" }} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 12px", background: "var(--ink)", color: "var(--paper-cream)", flexShrink: 0 }}>
                <span style={{ display: "inline-flex", gap: 2 }}>
                  {[["takeoffs", `Takeoffs · ${groupKeys.length > 1 ? "these sheets" : "this sheet"}`], ["library", `Library${templates.length ? ` (${templates.length})` : ""}`], ["columns", `Columns${conditionColumns.length ? ` (${conditionColumns.length})` : ""}`]].map(([id, label]) => (
                    <button key={id} onClick={() => setPanelTab(id)}
                      style={{ padding: "3px 8px", border: "none", borderBottom: panelTab === id ? "2px solid var(--paper-cream)" : "2px solid transparent", background: "none", color: "var(--paper-cream)", opacity: panelTab === id ? 1 : 0.65, cursor: "pointer", fontWeight: 700, fontSize: 12.5 }}>{label}</button>
                  ))}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => setPanelPrefs((p) => ({ ...p, strip: !p.strip }))}
                    title="Compact strip — also show the conditions as a horizontal strip above the canvas (handy on small projects with the panel collapsed)"
                    style={{ background: panelPrefs.strip ? "var(--paper-cream)" : "none", border: "1px solid var(--paper-cream)", color: panelPrefs.strip ? "var(--ink)" : "var(--paper-cream)", fontSize: 9.5, fontFamily: "var(--f-mono)", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", padding: "2px 6px", lineHeight: 1.4 }}>strip</button>
                  <button onClick={toggleTakeoffs} title="Collapse the panel (the ▦ button on the canvas edge brings it back)"
                    style={{ background: "none", border: "none", color: "#fff", fontSize: 15, cursor: "pointer", lineHeight: 1 }}>»</button>
                </span>
              </div>
              {panelTab === "takeoffs" && <>
              {/* view controls — search / natural sort / tag-family grouping.
                  All VIEW-ONLY: the array order (hotkeys, payload) never changes. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
                <input value={condQuery} onChange={(e) => setCondQuery(e.target.value)} placeholder="filter conditions…"
                  style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
                {condQuery && <button onClick={() => setCondQuery("")} title="Clear the filter" style={{ border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0 }}>×</button>}
                <button onClick={() => setPanelPrefs((p) => ({ ...p, az: !p.az }))}
                  title="Natural sort by tag (CT-2 before CT-10) — a view; hotkeys 1–9 keep their original numbering"
                  style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.az ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.az ? "var(--cobalt)" : "transparent", color: panelPrefs.az ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>A→Z</button>
                <button onClick={() => setPanelPrefs((p) => ({ ...p, group: !p.group }))}
                  title="Group by tag family (the text before the dash: CPT, LVT, CT…)"
                  style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.group ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.group ? "var(--cobalt)" : "transparent", color: panelPrefs.group ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>≡ grp</button>
              </div>
              {/* bulk actions — appear while a ⌘/⇧ multi-selection is live */}
              {checkedConds.size > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)", background: "#e8eefc", flexShrink: 0, flexWrap: "wrap", fontSize: 11 }}>
                  <strong style={{ color: "#1f3fc7" }}>{checkedConds.size} selected</strong>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the waste % on every selected condition">
                    <span style={{ color: "var(--ink-muted)" }}>Waste</span>
                    <input type="number" min="0" step="1" value={bulkWaste} onChange={(e) => setBulkWaste(e.target.value)} placeholder="%"
                      onKeyDown={(e) => e.key === "Enter" && applyBulkWaste()}
                      style={{ width: 44, padding: "2px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 11 }} />
                    <button onClick={applyBulkWaste} title="Apply waste % to the selection" style={{ padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>✓</button>
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the line color on every selected condition">
                    {PALETTE.map((p) => <button key={p} title={p} onClick={() => bulkPatch({ color: p })} style={{ width: 13, height: 13, borderRadius: 3, background: p, border: "1px solid var(--ink-faint)", cursor: "pointer", padding: 0 }} />)}
                  </span>
                  <button onClick={bulkDelete} title="Delete every selected condition (and their takeoffs)"
                    style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Delete</button>
                  <button onClick={() => setCheckedConds(new Set())} title="Clear the selection"
                    style={{ marginLeft: "auto", padding: "2px 6px", border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>✕</button>
                </div>
              )}
              <div style={{ flex: 1, overflow: "auto" }}>
                {conditions.length === 0 && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions yet — add one and start tracing.</div>}
                {condGroups.map((g) => (
                  <React.Fragment key={g.name ?? "_all"}>
                    {g.name != null && (
                      <div onClick={() => setClosedGroups((s) => { const n = new Set(s); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n; })}
                        title="Collapse / expand this tag family"
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderTop: "1px solid var(--ink-faint)", background: "var(--paper-cream)", cursor: "pointer", fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", userSelect: "none" }}>
                        <span style={{ width: 10 }}>{closedGroups.has(g.name) ? "▸" : "▾"}</span>
                        <span style={{ fontWeight: 700, color: "var(--ink)" }}>{g.name}</span>
                        <span>· {g.items.length}</span>
                      </div>
                    )}
                    {!closedGroups.has(g.name) && g.items.map(({ c, i }) => renderCondRow(c, i))}
                  </React.Fragment>
                ))}
                {searchMiss && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions match “{condQuery}”.</div>}
                <div style={{ padding: "6px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                  <button onClick={addCondition} style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
                </div>
                <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 10.5 }}>
                  Select a shape on the plan, then ⧉ Copy / ⎘ Paste (⌘C / ⌘V) — it lands on the sheet under your cursor.
                  <br />⌫ undo point · Esc cancel · scroll = zoom · pan mid-measure: press-and-drag (a click without dragging places the point).
                </div>
              </div>
              </>}
              {/* Library tab — reusable condition templates, browser-wide */}
              {panelTab === "library" && (
                <div style={{ flex: 1, overflow: "auto" }}>
                  <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
                    Reusable condition templates, shared across every plan in this browser. A fresh workspace seeds from this library (built-in flooring defaults when it's empty).
                  </div>
                  <div style={{ padding: "6px 12px 10px" }}>
                    <button onClick={saveActiveAsTemplate} disabled={!aCond}
                      title="Snapshot the active condition (appearance, waste, H/T, materials) into the library"
                      style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: aCond ? "pointer" : "default", fontSize: 12, color: aCond ? "var(--ink)" : "var(--ink-faint)" }}>
                      + save {aCond?.finish_tag || "the active condition"} to the library
                    </button>
                  </div>
                  {templates.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>No templates yet — make a condition the way you like it, then save it here.</div>}
                  {templates.map((t, idx) => (
                    <div key={`${t.finish_tag}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                      <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={t.hatch || "solid"} line={t.color} fill={t.fill} /></span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.finish_tag}</div>
                        <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>
                          {t.waste_pct || 0}% waste{t.height_ft != null ? ` · H ${t.height_ft}′` : ""}{t.thickness_in != null ? ` · T ${t.thickness_in}″` : ""}{t.materials?.length ? ` · ${t.materials.length} material${t.materials.length === 1 ? "" : "s"}` : ""}
                        </div>
                      </div>
                      <button onClick={() => applyTemplate(t)} title="Add a condition from this template to the takeoff"
                        style={{ flexShrink: 0, padding: "3px 8px", borderRadius: 0, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Apply</button>
                      <button onClick={() => renameTemplate(idx)} title="Rename this template"
                        style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                      <button onClick={() => deleteTemplate(idx)} title="Remove this template from the library"
                        style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Columns tab — the custom-columns manager (#31/#33): project-level
                  vocabulary; per-condition assignment lives in the active row's
                  properties on the Takeoffs tab */}
              {panelTab === "columns" && (
                <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
                  <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
                    Custom columns (e.g. CSI Division) classify conditions for report grouping and exports. Columns and values apply to the whole project; assign values on a condition in the Takeoffs tab.
                  </div>
                  {conditionColumns.length === 0 && <div style={{ padding: "2px 12px 8px", color: "var(--ink-muted)" }}>Add a column, e.g. CSI Division.</div>}
                  {conditionColumns.map((cc) => (
                    <div key={cc.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                        <input value={cc.name} onChange={(e) => renameColumn(cc.id, e.target.value)} placeholder="Column name (e.g. CSI Division)"
                          style={{ padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, flex: 1, minWidth: 0 }} />
                        <button onClick={() => deleteColumn(cc.id)} title="Delete this column (whole project)"
                          style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕ column</button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {cc.values.map((v) => (
                          <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                            {v}
                            <button onClick={() => renameColumnVal(cc.id, v)} title="Rename this value — assigned conditions follow"
                              style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                            <button onClick={() => removeColumnValue(cc.id, v)} title="Remove from the list — conditions keep the value, shown as (removed)"
                              style={{ padding: "0 3px", border: "none", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11 }}>✕</button>
                          </span>
                        ))}
                        <AddValueInput onAdd={(v) => addColumnValue(cc.id, v)} />
                      </div>
                    </div>
                  ))}
                  <div style={{ padding: "6px 12px", borderTop: conditionColumns.length ? "1px solid var(--ink-faint)" : "none" }}>
                    <button onClick={addColumn}
                      style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+ add column</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* gallery-first plan-set view — overlays the mounted canvas */}
      {view === "gallery" && (
        <SheetGallery
          sheets={sheets} getDoc={docFor} scales={scales} detectedScales={detectedScales}
          shapes={shapes} labels={galleryLabels}
          onLabel={(k, lbl) => setGalleryLabels((m) => (m[k] === lbl ? m : { ...m, [k]: lbl }))}
          onDetect={(k, det) => setDetectedScales((d) => (d[k]?.label === det.label ? d : { ...d, [k]: det }))}
          thumbCacheRef={thumbCacheRef} busyRef={statusRef}
          openTabs={openTabs} onOpen={openSheets} onClose={() => setView("canvas")} canClose={openTabs.length > 0}
          onAddFiles={handleFiles}
        />
      )}

      {showReport && (
        <ReportPanel
          projectName={projectName} onProjectName={setProjectName}
          clientInfo={clientInfo} onClientInfo={setClientInfo}
          conditions={conditions} shapes={shapes} markups={markups}
          conditionColumns={conditionColumns}
          scaleInfo={Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, scale_source: scaleSources[sheet_id] || "unknown" }))}
          sheetLabel={(k) => tabLabel(k)}
          onMarkedSet={exportMarkedSet} markedSetDark={darkMode}
          onClose={() => setShowReport(false)}
        />
      )}

      <SnapshotPanel
        open={showSnapshots} onClose={() => setShowSnapshots(false)}
        buildPayload={buildPayload} currentLabel={projectName}
        sheetLabel={(k) => tabLabel(k)}
        onLoadSnapshot={(payload) => {
          // a runtime load (unlike mount) can interrupt work in flight — an
          // unfinished trace/calibration/proposal must not commit into the
          // restored takeoff under a reset activeCond
          setPoly([]); setCalib([]); setPendingLen(""); setSelectedId(null); setProposal(null);
          hydrate(payload || {});
        }}
      />
    </div>
  );
}
