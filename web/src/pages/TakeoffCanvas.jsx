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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { store, isStaleTabError, STALE_TAB_MESSAGE } from "../lib/store.js";
import { seedStampLibrary, instantiateStamp, markupToStampElement } from "../lib/stamps.js";
import { extractSvgPrimitives, svgToStamp } from "../lib/svgImport.js";
import { transformPath, svgPlacedBox } from "../lib/svgpath.js";
import { ingestFiles } from "../lib/ingest.js";
import ToolMenu from "../components/ToolMenu.jsx";
import SheetGallery from "../components/SheetGallery.jsx";
import ReportPanel from "../components/ReportPanel.jsx";
import SnapshotPanel from "../components/SnapshotPanel.jsx";
import TakeoffsPanel, { clampPanelW } from "../components/TakeoffsPanel.jsx";
import { HATCHES, PALETTE, NO_FILL, HatchPattern, HatchSwatch } from "../components/hatches.jsx";
import { Icon } from "../brand/icons.jsx";
import { RENDER_SCALE, MAX_GROUP, STANDARD_SCALES, parseSheetKey, compareSheetKeys, extractSheetNumber, detectScale } from "../lib/sheets";
import { extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea, MASK_MAX_DIM, SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE } from "../lib/oneclick";
import { conditionTotals, verticalWallSf } from "../lib/totals.js";
import { sanitizeConditionColumns, sanitizeConditionAttrs, renameColumnValue, columnLabel } from "../lib/conditionColumns.js";
import { buildMarkedSetPdf, downloadBytes } from "../lib/markedset.js";
import { loadCompany } from "../lib/identity.js";
import { starPath, cloudPath, buildSnapGrid, nearestSnap, ANGLE_TOL, angleSnap, closedMetrics, openLen, pointInPoly, hitShape, arrowheadPath, distToSeg } from "../lib/geometry.js";
import { dashArrayFor, boostForDark, clampWeight, snapWeight, LINE_STYLES, LINE_STYLE_IDS, WEIGHT_STEPS } from "../lib/lineStyles.js";
import { nextRfiNumber } from "../lib/rfi.js";
import RfiPanel from "../components/RfiPanel.jsx";
import StampPanel from "../components/StampPanel.jsx";

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
// Hatch templates, palette, NO_FILL, and the HatchPattern/HatchSwatch pieces
// live in components/hatches.jsx — shared with the TakeoffsPanel.

// Docked Takeoffs panel geometry — per-user UI prefs (localStorage, diff-only
// overrides like the report column prefs), NEVER in the takeoff payload: panel
// width inside buildPayload would show up as noise in every snapshot diff.
// (The width clamp (clampPanelW, wrapping PANEL_MIN_W/PANEL_MAX_W) is exported
// by the panel itself — ONE clamp, so a future range change can't diverge
// between the panel's own drag clamp and the load-time clamp here.)
const PANEL_PREFS_KEY = "opentakeoff_panel";
const PANEL_DEFAULTS = { w: 320, collapsed: false, strip: false, az: false, group: false };

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

let _idn = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(_idn++).toString(36)}`;
const clamp = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
// shared by the status-bar tone AND the auto-dismiss skip (below) — one
// definition of "this message is bad news" for both readers
const isDangerMsg = (s) => s === STALE_TAB_MESSAGE || s.startsWith("Commit failed") || s.startsWith("Couldn't");
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
  { id: "highlight", icon: "highlight", label: "Highlight box" },
];
const MARKUP_IDS = MARKUP_TOOLS.map((t) => t.id);

// Flooring-first starter conditions seeded on a fresh workspace — line color +
// hatch chosen to read like the real finish; waste % is a sensible default you
// can change per condition (it's never auto-applied to the live readout, only
// the Report). Delete any you don't need.
// Each default also carries a couple of editable starter materials — quantities
// derive deterministically from measured area/linear ÷ a coverage rate you set
// (off the product data sheet). Delete/edit freely; they're just sensible seeds.
// Expressed in TEMPLATE shape (finish_tag/waste_pct/materials, no fill — it
// defaults from color) so seeding and the Library run the same constructor.
const FLOORING_DEFAULTS = [
  { finish_tag: "CPT-1", color: "#2f7d54", hatch: "speckle", waste_pct: 5,  materials: [{ name: "Adhesive", per: 250, basis: "area", unit: "gal" }] },                                    // Carpet tile
  { finish_tag: "BRD-1", color: "#be185d", hatch: "dots",    waste_pct: 10, materials: [{ name: "Adhesive", per: 120, basis: "area", unit: "gal" }] },                                    // Broadloom carpet (roll goods)
  { finish_tag: "LVT-1", color: "#b8860b", hatch: "plank",   waste_pct: 8,  materials: [{ name: "Adhesive", per: 250, basis: "area", unit: "gal" }] },                                    // Luxury vinyl plank/tile
  { finish_tag: "WD-1",  color: "#9a3412", hatch: "plank",   waste_pct: 10, materials: [                                                                                                  // Unfinished 2.25″ solid red oak — glue-down + site-finished
    { name: "Adhesive (wood, SMP)",     per: 50,  basis: "area", unit: "gal", note: "standard notch · SMP, solid wood" },
    { name: "Sealer (primer coat)",     per: 400, basis: "area", unit: "gal", note: "1 prime coat (~10 m²/L)" },
    { name: "Polyurethane (2K finish)", per: 136, basis: "area", unit: "gal", note: "≈3 coats @ ~408 SF/gal/coat (2K 10:1)" },
  ] },
  { finish_tag: "VCT-1", color: "#2563eb", hatch: "checker", waste_pct: 5,  materials: [{ name: "Adhesive", per: 350, basis: "area", unit: "gal" }] },                                    // Vinyl composition tile
  { finish_tag: "SV-1",  color: "#0d9488", hatch: "solid",   waste_pct: 10, materials: [{ name: "Adhesive", per: 150, basis: "area", unit: "gal" }] },                                    // Sheet vinyl
  { finish_tag: "CT-1",  color: "#9333ea", hatch: "grid",    waste_pct: 10, materials: [{ name: "Thinset", per: 95, basis: "area", unit: "bag" }, { name: "Grout", per: 120, basis: "area", unit: "bag" }] }, // Ceramic / porcelain tile
  { finish_tag: "RB-1",  color: "#475569", hatch: "horiz",   waste_pct: 5,  materials: [{ name: "Cove base adhesive", per: 40, basis: "linear", unit: "tube" }] },                        // Rubber / resilient wall base (linear)
  { finish_tag: "TR-1",  color: "#c96442", hatch: "vert",    waste_pct: 0,  materials: [] },                                                                                              // Transitions / reducers (linear)
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
// built-in flooring defaults are only the empty-library fallback. Both paths
// run instantiateTemplate — ONE condition constructor, no drift.
const seedConditions = (library) => (library?.length ? library : FLOORING_DEFAULTS).map(instantiateTemplate);

// The materials/column editors (MaterialsEditor, ColumnSelects, AddValueInput)
// live in components/TakeoffsPanel.jsx — the panel is their only surface now.

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
  const [markups, setMarkups] = useState([]);                // cloud/callout/text annotations (separate from measurement shapes)
  const [markupDraft, setMarkupDraft] = useState(null);      // in-progress markup first point (cloud/callout/highlight)
  // Docked LEFT panel — one at a time, never overlapping: null | "markup" | "stamp" | "rfi".
  // The right-rail buttons switch tabs; the dock reflows the canvas (mirrors the
  // docked Takeoffs panel on the right).
  const [leftTab, setLeftTab] = useState(null);
  const [showMarkups, setShowMarkups] = useState(true);       // markup SVG layer visibility (orthogonal to the export checkbox)
  const [editor, setEditor] = useState(null);                 // inline on-canvas text editor { left, top, value, multiline, commit } (retires window.prompt; screen-space overlay, NOT an SVG child)
  const [panelEditId, setPanelEditId] = useState(null);       // markup id whose text is being edited inline in the markup panel (off-screen fallback for the ✎ button)
  // Stamp library (browser-global, meta store) — reusable annotation stamps
  // dropped click-to-place (#40). armedStamp holds the stamp picked from the
  // palette; while tool==="stamp" each canvas click instantiates it as normal,
  // editable markups. Persist mirrors the template/material library pattern.
  const [stampLib, setStampLib] = useState({ stamps: [], sets: [] });
  const stampLibRef = useRef({ stamps: [], sets: [] });       // readable outside a render (persist merges)
  const [armedStamp, setArmedStamp] = useState(null);         // stamp armed for click-to-place (tool==="stamp")
  // Docked Takeoffs panel (right side, reflows the canvas): width + collapsed
  // persist per user in localStorage as diffs against PANEL_DEFAULTS.
  const [panelPrefs, setPanelPrefs] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}");
      return { ...PANEL_DEFAULTS, ...(p && typeof p === "object" && !Array.isArray(p) ? p : {}) };
    } catch { return { ...PANEL_DEFAULTS }; }
  });
  // Panel VIEW state (tab, filter, collapsed groups, ⌘/⇧ multi-select) lives
  // in the TakeoffsPanel component. Two hooks back into it from here:
  const [panelEpoch, setPanelEpoch] = useState(0);   // bumped by hydrate — the panel clears the transients that described the replaced conditions
  const panelSelectionRef = useRef(null);            // the panel registers "dismiss the bulk selection" here; activateCondition calls it
  const [templates, setTemplates] = useState([]);             // condition template library (browser-global, meta store)
  const templatesRef = useRef([]);                            // readable inside hydrate (seeding a fresh workspace)
  const [matLib, setMatLib] = useState([]);                   // material library (browser-global; conditions COPY on attach + carry lib_id)
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
  const panelW = clampPanelW(Number(panelPrefs.w) || PANEL_DEFAULTS.w);
  const takeoffsOpen = !panelPrefs.collapsed;
  const toggleTakeoffs = () => setPanelPrefs((p) => ({ ...p, collapsed: !p.collapsed }));
  // Panel resize lives INSIDE TakeoffsPanel (mid-drag width goes straight to
  // its DOM node; the pref commits ONCE on release via setPanelPrefs). Each
  // committed width change reflows the canvas container — coordinate math is
  // safe (pointer→image reads the rect at event time; the stage transform is
  // anchored top-left, so content stays put and we deliberately do NOT
  // re-fit) — but the hi-res detail crop only re-renders on transform change,
  // so the detail effect also keys on panelW/takeoffsOpen below, and mid-drag
  // the panel holds the gesture window open through this callback (like wheel
  // zoom) so the crop re-renders once per drag, on settle.
  const holdPanelGesture = useCallback(() => { gestureUntilRef.current = performance.now() + GESTURE_MS; }, []);
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
  const [selectedMarkupId, setSelectedMarkupId] = useState(null); // selected markup — mutually exclusive with selectedId
  const [rfis, setRfis] = useState([]);                 // RFI register (Request For Information); linked to markups via markup.rfi_id === rfi.id
  // selecting a shape clears any markup selection and vice-versa — one live
  // selection at a time (bidirectional mutual exclusivity). Passing null clears both.
  const selectShape = (id) => { setSelectedId(id); setSelectedMarkupId(null); };
  const selectMarkup = (id) => { setSelectedMarkupId(id); setSelectedId(null); };
  const pendingFlyRef = useRef(null);   // fly-to target whose sheet is opening this tick (two-phase center once its bitmap loads)

  const [snapOn, setSnapOn] = useState(false);   // snap-to-vector (beta) — off until calibrated on real plans
  const [angleOn, setAngleOn] = useState(true);  // 45°/90° angle guides (polar tracking) — on by default; ⇧ = hard lock
  // One-Click fill sensitivity (0..1) — how eagerly a fill crosses a room's hatch;
  // per-user pref, defaults to the calibrated Balanced preset.
  const [fillSens, setFillSens] = useState(() => {
    try { const v = parseFloat(localStorage.getItem("opentakeoff_fill_sens")); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : SENS_BALANCED; } catch { return SENS_BALANCED; }
  });
  useEffect(() => { try { localStorage.setItem("opentakeoff_fill_sens", String(fillSens)); } catch { /* private mode */ } }, [fillSens]);
  const [saveState, setSaveState] = useState("idle");
  // internal state is { text }, minted FRESH on every setCommitMsg call — a
  // byte-identical message (e.g. two "Couldn't open X" in a row) still gets a
  // new object identity, so the effect below (keyed on this object) restarts
  // its clock instead of no-op'ing on an unchanged dep. setCommitMsg(text) is
  // a thin, stable-shaped wrapper so the ~48 call sites below stay untouched.
  const [commitMsgState, setCommitMsgState] = useState({ text: "" });
  const commitMsg = commitMsgState.text;   // misnamed for history; just the message bar
  const setCommitMsg = (text) => setCommitMsgState({ text });
  // transient means transient: every message dismisses itself after ~6s (a
  // repeat message restarts the clock — see above). Three things don't age
  // out on a timer: the stale-tab lockout (STALE_TAB_MESSAGE — sticky until
  // the user reloads; it's the only story this tab has left to tell), any
  // other failure message (isDangerMsg — "Couldn't…"/"Commit failed…" — stays
  // until the NEXT message replaces it, not a clock), and in-progress messages
  // (the file's own "…" convention — "Reading files…", "Building the marked
  // set…", ingestFiles' onProgress strings — which must not vanish mid-op;
  // grep setCommitMsg to see every message and confirm the convention holds).
  useEffect(() => {
    const text = commitMsgState.text;
    if (!text || isDangerMsg(text) || text.endsWith("…")) return;
    const t = setTimeout(() => setCommitMsg(""), 6000);
    return () => clearTimeout(t);
  }, [commitMsgState]);
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
  const highlightRef = useRef(null);   // live highlight-box preview (first corner → cursor; own translucent fill, NOT rectRef's condition fill)
  const snapRef = useRef(null);        // current snapped image point (or null)
  const snapGridsRef = useRef(new Map()); // sheetKey → {cell, map} spatial hash of vector endpoints
  const vectorSegsRef = useRef(new Map()); // sheetKey → flat [x1,y1,x2,y2,…] linework segments (One-Click boundary source)
  const segMetaRef = useRef(new Map());    // sheetKey → per-segment meta bytes (hatch classification input)
  const maskCacheRef = useRef(new Map());  // sheetKey → built boundary mask (lazy, dropped on re-render)
  const snapMarkRef = useRef(null);    // SVG snap indicator
  const angleRef = useRef(null);       // current angle-locked image point (or null) — the click commits it
  const aimMarkRef = useRef(null);     // four floating liquid-glass pickets thickening the crosshair crossing
  const aimChipRef = useRef(null);     // readout chip by the cursor (locked angle · live segment length)
  const dragRef = useRef(null);        // {kind:'move'|'vertex'|'markupMove', shapeId?/markupId?, vIndex?, start:[x,y], orig:verts_norm/markup coords, moved?}
  const editingRef = useRef(false);    // true while the inline text editor is open — read in moveCrosshair/onPointerDown/wheel (a REF, never per-mousemove state) to suppress the crosshair and freeze pan/zoom
  const editorRef = useRef(null);      // mirror of the open editor object, so finishEditor can commit without a stale-closure race
  const editorInputRef = useRef(null); // the live <input> element (uncontrolled — value read on commit)
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
  // memoized: feeds the per-condition totals map the memoized TakeoffsPanel
  // takes as a prop — identity must hold across canvas-only renders. Builds
  // its own key set from sheetGroup/sheetKey (what groupKeys/panelKeySet above
  // are themselves derived from) rather than depending on groupSig or the
  // panelKeySet instance above — both are new on every render, so depending on
  // either honestly would recompute every render regardless; these are the
  // real, referentially-stable inputs.
  const visibleShapes = useMemo(() => {
    const keys = new Set(sheetGroup.length ? sheetGroup : [sheetKey]);
    return shapes.filter((s) => keys.has(s.sheet_id));
  }, [shapes, sheetGroup, sheetKey]);
  const visibleMarkups = markups.filter((m) => panelKeySet.has(m.sheet_id));
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
    // panel transients reset with the conditions they described — a snapshot
    // Load must not keep a checked set / range anchor / filter / collapsed
    // groups aimed at the PRE-load list (bulk edits would misfire on ids that
    // happen to survive). That state lives in the TakeoffsPanel now: bump its
    // epoch and it clears them in place (panel tab + width survive, as they
    // always did). On the mount load this is a no-op (fresh panel state).
    setPanelEpoch((e) => e + 1);
    setShapes(a.shapes || []);
    // normalize hydrated markups: legacy workspaces may hold markups with no id
    // (pre-dating the id field) — seed a stable id + default rfi_id so the new
    // select / edit / delete / move / RFI-link flows (all keyed on m.id) work on them.
    setMarkups(Array.isArray(a.markups) ? a.markups.map((m) => ({ ...m, id: m.id || uid("mk"), rfi_id: m.rfi_id || "" })) : []);
    setRfis(Array.isArray(a.rfis) ? a.rfis : []);   // additive — old saves without rfis load as []
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
      return store.loadMaterialLibrary().catch(() => []);
    }).then((ml) => {
      if (!off) setMatLib(ml);
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

  // Stamp library — independent of hydrate (it seeds no project state), so it
  // loads on its own. A truly empty library gets the flooring defaults, then
  // persists them once so the seeded set is exportable and survives reloads
  // (the seedConditions precedent, but written back because the library is the
  // asset itself, not a per-project derivation). Re-read on tab focus like the
  // other browser-global records.
  useEffect(() => {
    let off = false;
    store.loadStampLibrary().catch(() => ({ stamps: [], sets: [] })).then((raw) => {
      if (off) return;
      const seeded = seedStampLibrary(raw);
      const wasEmpty = !(raw?.stamps || []).length;
      stampLibRef.current = seeded; setStampLib(seeded);
      if (wasEmpty && seeded.stamps.length) store.saveStampLibrary(seeded).catch(() => { /* seed persists on next edit */ });
    });
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      store.loadStampLibrary().then((lib) => {
        if (JSON.stringify(lib) === JSON.stringify(stampLibRef.current)) return;
        // another tab edited the library — adopt it, INCLUDING an intentional
        // delete-all (an empty library must propagate, not leave stale stamps).
        // The store is shared per-origin, so a persisted empty is a real edit; the
        // first-mount seed self-heals any transient pre-save empty on next focus.
        stampLibRef.current = lib; setStampLib(lib);
        // a cross-tab edit may have removed the armed stamp — don't keep a dangling ref
        setArmedStamp((a) => (a && lib.stamps.some((s) => s.id === a.id) ? a : null));
      }).catch(() => { /* keep what we have */ });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { off = true; document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // library freshness: BOTH browser-global records — the condition template
  // library AND the material library (each sanitized at load, same as the
  // mount effect above) — may have been edited by another tab since our mount
  // load; re-read each on tab focus. Safe to swap in wholesale because every
  // library mutation persists immediately (nothing unsaved lives only in this
  // tab's state). Skip the setState when the freshly loaded list is
  // byte-identical to what we're already holding (a cheap JSON signature
  // compare) — TakeoffsPanel is memoized on these arrays' identity, and an
  // unconditional set would defeat that memo on every tab focus even when
  // nothing actually changed. This NARROWS the multi-tab last-write-wins
  // window on both records; it doesn't close it.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      store.loadTemplates().then((tpl) => {
        if (JSON.stringify(tpl) === JSON.stringify(templatesRef.current)) return;
        templatesRef.current = tpl; setTemplates(tpl);
      }).catch(() => { /* keep what we have */ });
      store.loadMaterialLibrary().then((ml) => {
        setMatLib((cur) => (JSON.stringify(ml) === JSON.stringify(cur) ? cur : ml));
      }).catch(() => { /* keep what we have */ });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // leaving the stamp tool disarms the pending stamp — a stray click under a
  // measure/select tool must never drop a stamp
  useEffect(() => { if (tool !== "stamp") setArmedStamp(null); }, [tool]);

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
    setStatus("rendering"); setErr(""); setPoly([]); setCalib([]); setPendingLen(""); selectShape(null); setProposal(null);
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

  // fly-to phase 2: a pending fly-to whose sheet just finished opening (its panel
  // now has a real bitmap) gets centered here — never on the same tick openSheets
  // was called (dims are still {0,0} then).
  useEffect(() => {
    const m = pendingFlyRef.current;
    if (!m) return;
    // drop a stale pending fly-to: the target sheet failed to render, or the markup
    // was deleted — either way it will never complete, so don't let it fire later.
    if (status === "error" || !markups.some((x) => x.id === m.id)) { pendingFlyRef.current = null; return; }
    if (status !== "ready" || !panelKeySet.has(m.sheet_id)) return;
    const sp = panels.find((p) => p.key === m.sheet_id);
    // once the panel bitmap exists, center (or give up if the markup has no anchor)
    // and clear the ref regardless, so an unanchored markup can't get stuck pending.
    if (sp && sp.img.w) { centerOnMarkup(m); pendingFlyRef.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelImgs, groupSig, status]);

  // ── autosave (debounced) ──────────────────────────────────────────────────
  // buildPayload is the single serializer — autosave and snapshots must write
  // identical records for the same state (byte-stability matters downstream).
  const buildPayload = () => ({ project_name: projectName, ...(Object.values(clientInfo).some((v) => v && String(v).trim()) ? { client_info: clientInfo } : {}), sheets: Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, ...(scaleSources[sheet_id] ? { scale_source: scaleSources[sheet_id] } : {}) })), conditions, ...(conditionColumns.length ? { condition_columns: conditionColumns } : {}), shapes, markups, rfis, sheet_group: sheetGroup, last_group: lastGroup, sheet_tabs: openTabs });
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
  }, [shapes, conditions, conditionColumns, scales, scaleSources, markups, rfis, sheetGroup, lastGroup, openTabs, projectName, clientInfo]);
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
      if (editingRef.current) return;   // freeze pan/zoom while the inline editor is pinned to its anchor
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

  // Number keys 1–9 switch the active condition (material) fast — through
  // activateCondition with reassign:false: a digit press has no visual
  // reassign affordance (unlike the panel row / strip button), so it must
  // never silently move a selected shape's quantities. It still dismisses a
  // live bulk selection, same as every activation surface.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9 && conditions[n - 1]) activateCondition(conditions[n - 1].id, { reassign: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conditions, tool, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        else if (selectedMarkupId && showMarkups) { deleteMarkup(selectedMarkupId); setSelectedMarkupId(null); }
        else setCalib((c) => c.slice(0, -1));
      } else if (e.key === "Escape") { setPoly([]); setCalib([]); selectShape(null); setMarkupDraft(null); setProposal(null); setArmedStamp(null); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); setPoly((q) => (q.length ? q.slice(0, -1) : q)); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { if (selectedId) { e.preventDefault(); copySelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { if (clipRef.current.length) { e.preventDefault(); pasteClipboard(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { if (selectedId) { e.preventDefault(); duplicateSelected(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, selectedMarkupId, showMarkups, poly, proposal, shapes, sheetKey, groupSig, scales, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pointer ────────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (status !== "ready") return;
    // inline editor open: the blur that follows this click commits it; swallow the
    // canvas interaction so pan/zoom stays frozen and no stray point is placed
    if (editingRef.current) return;
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
    else if (tool === "cloud" || tool === "callout" || tool === "text" || tool === "highlight") placeMarkup(p);
    else if (tool === "stamp") placeStamp(p);
  }
  // Markups carry no verts_norm (cloud rect / callout at+target / text at), so
  // hitShape can't test them — this is a purpose-built bbox/point test in the
  // markup's OWN panel frame. p is stage px. Labels are screen-constant, so their
  // extent divides by the current scale.
  function hitMarkup(m, p, thr) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img.w) return false;
    const W = sp.img.w, H = sp.img.h, ox = sp.xOffset;
    const X = p[0], Y = p[1], sc = tfRef.current.scale;
    if (m.type === "cloud" && m.rect) {
      const [[a0, b0], [a1, b1]] = m.rect;
      const x0 = Math.min(a0, a1) * W + ox, x1 = Math.max(a0, a1) * W + ox;
      const y0 = Math.min(b0, b1) * H, y1 = Math.max(b0, b1) * H;
      // a cloud renders hollow (fill="none"), so hit only its border band — a shape
      // (or vertex) enclosed by the cloud must stay clickable through the interior.
      const inX = X >= x0 - thr && X <= x1 + thr, inY = Y >= y0 - thr && Y <= y1 + thr;
      const onV = inX && (Math.abs(Y - y0) <= thr || Math.abs(Y - y1) <= thr);
      const onH = inY && (Math.abs(X - x0) <= thr || Math.abs(X - x1) <= thr);
      return onV || onH;
    }
    if (m.type === "callout" && m.at) {
      const ax = m.at[0] * W + ox, ay = m.at[1] * H;
      const lw = ((m.text?.length || 1) * 7 + 14) / sc;
      if (X >= ax - thr && X <= ax + lw && Y >= ay - 18 / sc - thr && Y <= ay + thr) return true;
      if (m.target) {
        const tx = m.target[0] * W + ox, ty = m.target[1] * H;
        if (Math.hypot(X - tx, Y - ty) < thr * 2) return true;
        if (distToSeg(X, Y, tx, ty, ax, ay) < thr) return true;
      }
      return false;
    }
    if (m.type === "text" && m.at) {
      const ax = m.at[0] * W + ox, ay = m.at[1] * H;
      const lw = ((m.text?.length || 1) * 7 + 14) / sc;
      return X >= ax - thr && X <= ax + lw && Y >= ay - 16 / sc - thr && Y <= ay + thr;
    }
    if (m.type === "highlight" && m.rect) {
      // a highlight is FILLED and meant to be grabbed — hit its interior (with a
      // small margin) so it selects; precedence in selectAt keeps other markups
      // under it clickable.
      const [[a0, b0], [a1, b1]] = m.rect;
      const x0 = Math.min(a0, a1) * W + ox, x1 = Math.max(a0, a1) * W + ox;
      const y0 = Math.min(b0, b1) * H, y1 = Math.max(b0, b1) * H;
      return X >= x0 - thr && X <= x1 + thr && Y >= y0 - thr && Y <= y1 + thr;
    }
    if (m.type === "arrow" && m.from && m.to) {
      // a stamp-placed leader — hit its shaft (endpoint tolerance folds into the band)
      const fx = m.from[0] * W + ox, fy = m.from[1] * H, tx = m.to[0] * W + ox, ty = m.to[1] * H;
      return distToSeg(X, Y, fx, fy, tx, ty) < thr * 1.5;
    }
    if (m.type === "bubble" && m.at) {
      // a filled circle — hit its disc; r is normalized to sheet WIDTH
      const cx = m.at[0] * W + ox, cy = m.at[1] * H, rad = (Number(m.r) > 0 ? Number(m.r) : 0.02) * W;
      return Math.hypot(X - cx, Y - cy) < rad + thr;
    }
    if (m.type === "svg" && m.at && Array.isArray(m.vb)) {
      // a vector symbol — hit its placed bbox (same uniform scale off the LONGER
      // viewBox extent the renderer uses, so hit size == render size).
      const { bw, bh } = svgPlacedBox(m.vb, m.w, W);
      const cx = m.at[0] * W + ox, cy = m.at[1] * H;
      return X >= cx - bw / 2 - thr && X <= cx + bw / 2 + thr && Y >= cy - bh / 2 - thr && Y <= cy + bh / 2 + thr;
    }
    return false;
  }
  // Select tool: pick a shape (or a vertex of the selected one) and start dragging
  // it. Every shape hit-tests in ITS panel's local frame (stage x minus xOffset).
  function selectAt(p, e) {
    const thr = 8 / tfRef.current.scale;
    const sel = selectedId ? shapes.find((s) => s.id === selectedId) : null;
    const selSp = sel && panelKeySet.has(sel.sheet_id) ? panelByKey(sel.sheet_id) : null;
    // 1. Handles of the ALREADY-selected shape win first, so a shape (or vertex)
    //    enclosed by a markup — e.g. a revision cloud drawn around a room — stays
    //    editable rather than being shielded by the markup's hit area.
    if (sel && selSp && sel.measure_role !== "count") {
      const pts = sel.verts_norm.map(([nx, ny]) => [nx * selSp.img.w + selSp.xOffset, ny * selSp.img.h]);
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
          const nv = [(p[0] - selSp.xOffset) / selSp.img.w, p[1] / selSp.img.h];
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
    // 2. markups render ON TOP of shapes (:2137 > :2093), so a markup hit wins over a
    //    plain shape click — but NOT over the selected shape's handles above.
    //    When the markup layer is hidden (showMarkups false), skip the search
    //    entirely — you can't select/delete/fly-to an invisible markup.
    if (showMarkups) {
      const rev = [...visibleMarkups].reverse();
      // a NON-highlight markup hit beats a highlight at the same point (test
      // highlights last), so a linked cloud/callout under a highlight stays
      // clickable; a highlight still wins over a plain shape (it shields it).
      const mHit = rev.find((m) => m.type !== "highlight" && hitMarkup(m, p, thr))
                || rev.find((m) => m.type === "highlight" && hitMarkup(m, p, thr));
      if (mHit) {
        selectMarkup(mHit.id);
        // arm a move drag — snapshot the markup's current normalized coords (all four
        // shapes: cloud/highlight rect, callout at+target, text at). The move stays a
        // no-op until it passes the threshold in onPointerMove, so a pure click (or the
        // first click of a double-click re-edit) never nudges the markup.
        const orig = (mHit.type === "cloud" || mHit.type === "highlight") ? { rect: mHit.rect }
          : mHit.type === "callout" ? { at: mHit.at, target: mHit.target }
            : mHit.type === "arrow" ? { from: mHit.from, to: mHit.to }
              : { at: mHit.at };   // text + bubble
        // raw start (markups don't snap/angle-lock; matches the raw tracking point in
        // onPointerMove so the delta can't be contaminated by a stale snap/angle ref)
        dragRef.current = { kind: "markupMove", markupId: mHit.id, sheetId: mHit.sheet_id, start: toImage(e.clientX, e.clientY), orig, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    // 3. move the selected shape if its body (not a handle) was hit
    if (sel && selSp && hitShape(sel, p[0] - selSp.xOffset, p[1], selSp.img.w, selSp.img.h, thr)) {
      dragRef.current = { kind: "move", shapeId: selectedId, start: p, orig: sel.verts_norm };
      e.currentTarget.setPointerCapture(e.pointerId); return;
    }
    // 4. otherwise pick a shape (or clear the selection)
    const hit = [...visibleShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShape(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
    });
    selectShape(hit ? hit.id : null);
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
    if (editingRef.current) return;   // inline editor open — no aim crosshair (ref check, never per-mousemove state)
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
    // live highlight preview: a translucent box, first corner → cursor (its own
    // ref, NOT rectRef which carries the active condition fill)
    if (highlightRef.current) {
      if (!panRef.current && tool === "highlight" && markupDraft) {
        highlightRef.current.setAttribute("x", Math.min(markupDraft[0], cur[0]));
        highlightRef.current.setAttribute("y", Math.min(markupDraft[1], cur[1]));
        highlightRef.current.setAttribute("width", Math.abs(cur[0] - markupDraft[0]));
        highlightRef.current.setAttribute("height", Math.abs(cur[1] - markupDraft[1]));
        highlightRef.current.style.display = "block";
      } else highlightRef.current.style.display = "none";
    }
  }
  function hideCrosshair() {
    for (const ref of [crossVRef, crossHRef, rubberRef, rectRef, cloudRef, highlightRef, snapMarkRef, aimMarkRef, aimChipRef]) if (ref.current) ref.current.style.display = "none";
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
      } else if (d.kind === "markupMove") {
        // raw cursor point — markups aren't snapped/angle-locked, and this matches the
        // raw d.start so the delta can't jump from a stale snap/angle ref.
        const mp = toImage(e.clientX, e.clientY);
        // dblclick-safe: stay inert until the pointer travels past the ~5px pan
        // threshold, so a click / first click of a double-click never moves it
        const sc = tfRef.current.scale;
        if (!d.moved && Math.hypot(mp[0] - d.start[0], mp[1] - d.start[1]) < 5 / sc) return;
        d.moved = true;
        const sp = panelByKey(d.sheetId);
        if (!sp || !sp.img.w) return;
        // start and mp are both stage px, so xOffset cancels in the delta; normalize
        // by the markup's OWN panel dims. Live setMarkups each move (mirrors the shape
        // `move` pattern; NOT commit-on-release). Persistence is automatic.
        const dx = (mp[0] - d.start[0]) / sp.img.w, dy = (mp[1] - d.start[1]) / sp.img.h;
        const o = d.orig;
        setMarkups((ms) => ms.map((m) => {
          if (m.id !== d.markupId) return m;
          if (o.rect) return { ...m, rect: [[o.rect[0][0] + dx, o.rect[0][1] + dy], [o.rect[1][0] + dx, o.rect[1][1] + dy]] };
          if (o.target) return { ...m, at: [o.at[0] + dx, o.at[1] + dy], target: [o.target[0] + dx, o.target[1] + dy] };
          if (o.from) return { ...m, from: [o.from[0] + dx, o.from[1] + dy], to: [o.to[0] + dx, o.to[1] + dy] };
          return { ...m, at: [o.at[0] + dx, o.at[1] + dy] };   // text + bubble
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
    const f = floodRegion(mo, local[0], local[1], fillSens);
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
    selectShape(made[made.length - 1].id);
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
    // Drawing a markup by hand surfaces the Markups tab. But a STAMP places several
    // markups via addMarkup — don't yank the user off the Stamps tab mid-placement
    // (keep the current tab, or open Markups only if nothing's open).
    setLeftTab((t) => (tool === "stamp" ? (t ?? "markup") : "markup"));
  }
  // Marked-set PDF: every sheet carrying takeoffs/markups, work burned in as
  // drawn, legend cover with net totals — built fully in the browser
  // (lib/markedset.js). Exports in the CURRENT view: dark canvas → dark PDF.
  // includeMarkups (from the ReportPanel checkbox, default true) is ORTHOGONAL to
  // the canvas layer-hide (showMarkups): only this flag drops markups from the
  // PDF. Off → pass []; the RFI-only export still works (empty-guard unaffected).
  async function exportMarkedSet(includeMarkups = true) {
    try {
      setCommitMsg("Building the marked set…");
      const exportMarkups = includeMarkups ? markups : [];
      const keys = [...new Set([...shapes.map((s) => s.sheet_id), ...exportMarkups.map((m) => m.sheet_id)])];
      const sheetMeta = keys.map((key) => {
        const { file, page } = parseSheetKey(key);
        return { key, file, page, label: tabLabel(key) };
      }).sort((a, b) => compareSheetKeys(a.key, b.key));   // canonical sheet order — shared comparator
      const { bytes, filename } = await buildMarkedSetPdf({
        projectName, clientInfo, company: loadCompany(),
        dark: darkMode, sheets: sheetMeta, shapes, markups: exportMarkups, rfis, conditions,
        getPage: async (file, pageNum) => (await docFor(file)).getPage(pageNum),
        loadPdfData: (file) => store.loadPdfData(file),
      });
      downloadBytes(filename, bytes);
      setCommitMsg(`Marked set downloaded — ${filename}`);
    } catch (e) {
      setCommitMsg(`Marked set failed: ${e.message || e}`);
    }
  }

  // ── inline text editor — a screen-space <input> overlay (retires window.prompt).
  // An HTML input can't live in the zoom/pan-transformed SVG group, so it is
  // absolutely positioned in CONTAINER px, converting the anchor (stage px) through
  // tfRef. Pan/zoom is frozen while editing (onPointerDown / onWheel bail on
  // editingRef) so the overlay stays pinned to its anchor; the crosshair is
  // suppressed via the same ref inside moveCrosshair. Keys are handled on the
  // input's OWN onKeyDown/onBlur — the global window keydown returns early for
  // INPUT targets, so it never interferes.
  function markupAnchorStage(m) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img.w) return null;
    let nx, ny;
    if ((m.type === "cloud" || m.type === "highlight") && m.rect) { nx = (m.rect[0][0] + m.rect[1][0]) / 2; ny = (m.rect[0][1] + m.rect[1][1]) / 2; }
    else if (m.type === "arrow" && m.from && m.to) { nx = (m.from[0] + m.to[0]) / 2; ny = (m.from[1] + m.to[1]) / 2; }
    else if (m.at) { nx = m.at[0]; ny = m.at[1]; }   // text + bubble + callout
    else return null;
    return [nx * sp.img.w + sp.xOffset, ny * sp.img.h];
  }
  function openTextEditor({ anchorStage, value = "", multiline = false, commit }) {
    const el = containerRef.current;
    if (!el) return;
    const t = tfRef.current;
    hideCrosshair();                 // the OS cursor / aim crosshair steps aside while you type
    editingRef.current = true;
    const ed = { left: anchorStage[0] * t.scale + t.x, top: anchorStage[1] * t.scale + t.y, value, multiline, commit };
    editorRef.current = ed;
    setEditor(ed);
  }
  // commit=true → run the editor's commit with the current input text; either way
  // tear down. Guarded on editingRef so the blur that fires when we unmount the
  // focused input (after Enter/Esc) is a harmless no-op — no double commit.
  function finishEditor(commit) {
    if (!editingRef.current) return;
    editingRef.current = false;
    const ed = editorRef.current;
    const val = editorInputRef.current ? editorInputRef.current.value : (ed ? ed.value : "");
    editorRef.current = null;
    setEditor(null);
    if (commit && ed && ed.commit) ed.commit(val);
  }
  // defense-in-depth: editingRef locks pan/zoom/crosshair while the overlay is up.
  // If the input ever unmounts by a route other than finishEditor, this keeps the
  // ref from stranding true and freezing the canvas.
  useEffect(() => { if (!editor) editingRef.current = false; }, [editor]);
  // double-click a markup (Select tool) to edit its text in place — find the target
  // via toImage + hitMarkup (non-highlight beats highlight, mirroring selectAt) and
  // open the overlay at its anchor.
  function editMarkupAt(e) {
    if (!showMarkups) return;
    const p = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    const rev = [...visibleMarkups].reverse();
    const m = rev.find((mm) => mm.type !== "highlight" && hitMarkup(mm, p, thr))
      || rev.find((mm) => mm.type === "highlight" && hitMarkup(mm, p, thr));
    if (!m) return;
    // an svg symbol carries no text — select it, but don't open a dead-end editor
    if (m.type === "svg") { selectMarkup(m.id); return; }
    const anchor = markupAnchorStage(m);
    if (!anchor) return;
    selectMarkup(m.id);
    openTextEditor({ anchorStage: anchor, value: m.text || "", commit: (t) => updateMarkup(m.id, { text: (t || "").trim() }) });
  }

  function placeMarkup(p) {
    const tp = panelAt(p[0]);
    const norm = (q, panel) => [(q[0] - panel.xOffset) / panel.img.w, q[1] / panel.img.h];
    if (tool === "text") {
      // empty text is not committed (preserves the old `if (t && t.trim())` reject)
      openTextEditor({ anchorStage: p, commit: (t) => { const tx = (t || "").trim(); if (tx) addMarkup({ type: "text", at: norm(p, tp), text: tx }, tp.key); } });
    } else if (tool === "cloud") {
      if (!markupDraft) { setMarkupDraft(p); }
      else {
        const dp = panelAt(markupDraft[0]);
        const rect = [norm(markupDraft, dp), norm(p, dp)];
        setMarkupDraft(null);
        // create the cloud NOW (like highlight) so Esc/cancel in the note editor
        // keeps the drawn box — only the optional note is discarded, not the geometry
        const id = uid("mk");
        addMarkup({ id, type: "cloud", rect, text: "" }, dp.key);
        openTextEditor({ anchorStage: p, commit: (t) => updateMarkup(id, { text: (t || "").trim() }) });
      }
    } else if (tool === "highlight") {
      // two-corner like the cloud, but no note prompt — a highlight is a pure
      // translucent box you drop over an area; text/color/line_style come later.
      if (!markupDraft) { setMarkupDraft(p); }
      else {
        const dp = panelAt(markupDraft[0]);
        addMarkup({ type: "highlight", rect: [norm(markupDraft, dp), norm(p, dp)], text: "" }, dp.key);
        setMarkupDraft(null);
      }
    } else if (tool === "callout") {
      if (!markupDraft) { setMarkupDraft(p); }   // first click = the thing you're pointing at
      else {
        const dp = panelAt(markupDraft[0]);
        const target = norm(markupDraft, dp), at = norm(p, dp);
        setMarkupDraft(null);
        // empty callout text is not committed (preserves the old reject)
        openTextEditor({ anchorStage: p, commit: (t) => { const tx = (t || "").trim(); if (tx) addMarkup({ type: "callout", target, at, text: tx }, dp.key); } });
      }
    }
  }
  function updateMarkup(mid, patch) { setMarkups((ms) => ms.map((m) => (m.id === mid ? { ...m, ...patch } : m))); }
  function deleteMarkup(mid) { setMarkups((ms) => ms.filter((m) => m.id !== mid)); }

  // ── stamps — reusable annotations dropped click-to-place (#40). The library
  // is browser-global (persists across projects); placed instances are NORMAL
  // markups. Persist mirrors persistTemplates: ref + state + fire-and-forget
  // save, sanitized at the store boundary.
  const persistStampLib = (next) => {
    stampLibRef.current = next; setStampLib(next);
    store.saveStampLibrary(next).catch((e) => setCommitMsg(`Couldn't save the stamp library: ${e.message || e}`));
  };
  // Arm a stamp for placement: switch to the stamp tool and hold it in
  // armedStamp. Repeated clicks place multiple copies until you pick another
  // tool or press Escape.
  const armStamp = (stamp) => { setArmedStamp(stamp); setTool("stamp"); setMarkupDraft(null); };
  // Instantiate the armed stamp at the click point — every element becomes a
  // normal markup on the clicked panel's sheet. A `_prompt` element (a bubble
  // whose number you fill in) opens the text editor on the placed instance.
  function placeStamp(p) {
    if (!armedStamp) return;
    const tp = panelAt(p[0]);
    const cx = (p[0] - tp.xOffset) / tp.img.w, cy = p[1] / tp.img.h;
    const instances = instantiateStamp(armedStamp, [cx, cy]);
    if (!instances.length) { setCommitMsg("This stamp has no placeable elements."); return; }
    let promptId = null;
    for (const inst of instances) {
      const { _prompt, ...m } = inst;
      const id = uid("mk");
      addMarkup({ ...m, id }, tp.key);
      if (_prompt && !promptId) promptId = id;
    }
    setCommitMsg(`Placed “${armedStamp.name}”.`);
    if (promptId) openTextEditor({ anchorStage: p, commit: (t) => updateMarkup(promptId, { text: (t || "").trim() }) });
  }
  // Save the selected markup as a single-element stamp (the palette's define
  // flow). markupToStampElement re-expresses its coords as anchor-relative
  // offsets so the stamp is position independent.
  function saveMarkupAsStamp(m) {
    const el = markupToStampElement(m);
    if (!el) { setCommitMsg("This markup can't be saved as a stamp."); return; }
    const name = (window.prompt("Name this stamp:", (m.text || el.type).trim() || "Stamp") || "").trim();
    if (!name) return;
    const stamp = { id: uid("stmp"), name, elements: [el] };
    persistStampLib({ ...stampLibRef.current, stamps: [...stampLibRef.current.stamps, stamp] });
    setCommitMsg(`Saved stamp “${name}”.`);
    setLeftTab("stamp");
  }
  const deleteStamp = (id) => {
    const lib = stampLibRef.current;
    persistStampLib({
      stamps: lib.stamps.filter((s) => s.id !== id),
      sets: lib.sets.map((set) => ({ ...set, stampIds: set.stampIds.filter((sid) => sid !== id) })),
    });
    if (armedStamp?.id === id) setArmedStamp(null);
  };
  const renameStamp = (id, name) => {
    const nm = (name || "").trim();
    if (!nm) return;
    persistStampLib({ ...stampLibRef.current, stamps: stampLibRef.current.stamps.map((s) => (s.id === id ? { ...s, name: nm } : s)) });
  };
  // Export the whole library as JSON (a crew shares one standard set); import
  // MERGES a file's stamps/sets in, replacing same-id entries so a re-import is
  // idempotent. The store sanitizes on save, so a malformed file can't wedge us.
  function exportStamps() {
    const data = JSON.stringify({ schema: "opentakeoff.stamp_library.v1", ...stampLibRef.current }, null, 2);
    downloadBytes("opentakeoff-stamps.json", new TextEncoder().encode(data), "application/json");
  }
  async function importStamps(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const cur = stampLibRef.current;
      const inStamps = Array.isArray(parsed?.stamps) ? parsed.stamps : [];
      const inSets = Array.isArray(parsed?.sets) ? parsed.sets : [];
      const inIds = new Set(inStamps.map((s) => s?.id));
      const inSetIds = new Set(inSets.map((s) => s?.id));
      const merged = {
        stamps: [...cur.stamps.filter((s) => !inIds.has(s.id)), ...inStamps],
        sets: [...cur.sets.filter((s) => !inSetIds.has(s.id)), ...inSets],
      };
      persistStampLib(merged);   // persistStampLib → store sanitizes, dropping any malformed items
      setCommitMsg(`Imported ${inStamps.length} stamp${inStamps.length === 1 ? "" : "s"}.`);
      setLeftTab("stamp");
    } catch (e) {
      setCommitMsg(`Couldn't import stamps: ${e.message || e}`);
    }
  }
  // Import a real .svg FILE as a stamp: the browser's DOMParser extracts the
  // drawable primitives (extractSvgPrimitives, with the security gate), then the
  // pure svgToStamp bakes them into vector-path elements. A new stamp is minted
  // and added to the library — mirroring saveMarkupAsStamp.
  async function importSvgStamp(file) {
    try {
      const text = await file.text();
      const base = (file.name || "Imported SVG").replace(/\.svg$/i, "");
      const extracted = extractSvgPrimitives(text, { name: base });
      const stamp = extracted && svgToStamp(extracted);
      if (!stamp || !stamp.elements.length) { setCommitMsg("Couldn't read that SVG — no drawable vector shapes found."); return; }
      persistStampLib({ ...stampLibRef.current, stamps: [...stampLibRef.current.stamps, { id: uid("stmp"), name: stamp.name, elements: stamp.elements }] });
      setCommitMsg(`Imported “${stamp.name}” as a stamp.`);
      setLeftTab("stamp");
    } catch (e) {
      setCommitMsg(`Couldn't import SVG: ${e.message || e}`);
    }
  }

  // ── RFI register — the dormant markup.rfi_id hook made real. One RFI ↔ many
  // markups (markup.rfi_id === rfi.id); linked markups are DERIVED, never stored
  // twice. rfi.js stays PURE — every date is stamped HERE, at the event, so no
  // renderer computes an RFI field with new Date().
  function raiseRfi(markup) {
    if (!markup) return;
    const id = uid("rfi");
    const number = nextRfiNumber(rfis);
    const rec = {
      id, number, subject: (markup.text || "").trim(), question: "", status: "open",
      to: "", priority: "normal", cost_impact: false, schedule_impact: false,
      date: new Date().toISOString().slice(0, 10), response: "", response_date: "",
      sheet_id: markup.sheet_id,
    };
    setRfis((rs) => [...rs, rec]);
    updateMarkup(markup.id, { rfi_id: id });
    setLeftTab("rfi");
    setCommitMsg(`Raised ${number}.`);
  }
  const linkRfi = (markup, rfiId) => { if (markup && rfiId) updateMarkup(markup.id, { rfi_id: rfiId }); };
  const unlinkRfi = (markup) => { if (markup) updateMarkup(markup.id, { rfi_id: "" }); };
  // hard delete: drop the record AND clear the dangling pointer on every linked
  // markup (void is a status; delete removes — both must leave no orphan link)
  function deleteRfi(id) {
    setRfis((rs) => rs.filter((r) => r.id !== id));
    setMarkups((ms) => ms.map((m) => (m.rfi_id === id ? { ...m, rfi_id: "" } : m)));
  }
  // parent-owned update path: the status→response_date auto-stamp lives HERE (not
  // in the view) so the date is data, stamped once on the transition into Answered.
  function updateRfi(id, patch) {
    setRfis((rs) => rs.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      if (patch.status && next.status === "answered" && r.status !== "answered" && !next.response_date) {
        next.response_date = new Date().toISOString().slice(0, 10);
      }
      return next;
    }));
  }

  // Fly to a linked markup from the register. Two-phase because openSheets only
  // fires state setters and a sheet's bitmap dims load async: if the target sheet
  // isn't open, stash it in pendingFlyRef + openSheets, and the effect below
  // centers once the panel has non-zero img.w. If already open, center inline.
  function centerOnMarkup(m) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img.w) return false;
    let anchor;
    if ((m.type === "cloud" || m.type === "highlight") && m.rect) anchor = [(m.rect[0][0] + m.rect[1][0]) / 2, (m.rect[0][1] + m.rect[1][1]) / 2];
    else if (m.type === "callout") anchor = m.at || m.target;
    else if (m.type === "arrow" && m.from && m.to) anchor = [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2];
    else anchor = m.at;   // text + bubble
    if (!anchor) return false;
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const scale = tfRef.current.scale;
    const sx = anchor[0] * sp.img.w + sp.xOffset, sy = anchor[1] * sp.img.h;
    setTfNow({ x: r.width / 2 - sx * scale, y: r.height / 2 - sy * scale, scale });
    selectMarkup(m.id);
    return true;
  }
  function flyToMarkup(m) {
    if (!m) return;
    setShowMarkups(true);   // flying to a markup reveals the layer, so you never land on an invisible selection
    if (!panelKeySet.has(m.sheet_id)) { pendingFlyRef.current = m; openSheets([m.sheet_id], false); return; }
    // open already, but its bitmap may still be mid-render (img.w === 0) — if the
    // inline center can't run yet, hand off to the phase-2 effect below.
    if (!centerOnMarkup(m)) pendingFlyRef.current = m;
  }

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
    setConditions((cs) => [...cs, c]);
    activateCondition(c.id, { reassign: false });   // no reassign affordance on +condition; still dismisses a live bulk selection
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
    // no bulk-selection pruning needed here: the panel derives liveness from
    // the conditions prop (liveChecked = conditions ∩ checked), so a deleted
    // id left in its checked set is inert by construction
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
  // one source of role math, two scopes. Memoized: visRowById is a prop of the
  // memoized panel, so its identity must only change when the totals can.
  const visRows = useMemo(() => conditionTotals(conditions, visibleShapes), [conditions, visibleShapes]);
  const visRowById = useMemo(() => new Map(visRows.map((r) => [r.id, r])), [visRows]);
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

  // The panel's condition-list VIEW (search / natural sort / grouping / the
  // ⌘/⇧ multi-select) lives in components/TakeoffsPanel.jsx.

  // one activation path — the panel row, the compact strip, the 1–9 hotkeys,
  // +condition, and Library Apply all funnel here so the reassign-in-Select
  // and clear-multi-select semantics can never drift between surfaces. Only
  // surfaces with a VISIBLE reassign affordance (the panel row and the strip
  // button — both show the "reassign selected shape" hint once a shape is
  // selected) actually reassign; { reassign: false } is for keyboard/
  // programmatic activations (hotkeys, +condition, Library Apply) that offer
  // no such affordance — a digit press or an Apply click must never silently
  // move a selected shape's quantities. EVERY activation surface, reassigning
  // or not, dismisses a live bulk selection.
  const activateCondition = (id, { reassign = true } = {}) => {
    if (reassign && tool === "select" && selectedId) reassignSelected(id);
    setActiveCond(id);
    panelSelectionRef.current?.();   // plain activation dismisses a live bulk selection (panel view state)
  };

  // Bulk mutations — the multi-selection is TakeoffsPanel view state; every
  // callback takes the LIVE id set the panel computed (conditions ∩ checked),
  // so counts and names here can never claim rows the list already lost.
  const bulkWasteConditions = (ids, v) => {
    setConditions((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, waste_pct: v } : c)));
    setCommitMsg(`Waste set to ${v}% on ${ids.size} condition${ids.size === 1 ? "" : "s"}.`);
  };
  const bulkColorConditions = (ids, color) => setConditions((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, color } : c)));
  // returns whether the delete went through — the panel clears its selection only then
  const bulkDeleteConditions = (ids) => {
    const live = conditions.filter((c) => ids.has(c.id));
    if (!live.length) return false;
    const owned = shapes.filter((s) => ids.has(s.condition_id)).length;
    // name what dies while the list still reads at a glance (≤5); count beyond
    const what = live.length <= 5 ? live.map((c) => c.finish_tag).join(", ") : `${live.length} conditions`;
    if (!window.confirm(`Delete ${what}${owned ? ` and their ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}? This can't be undone.`)) return false;
    setConditions((cs) => cs.filter((c) => !ids.has(c.id)));
    if (owned) setShapes((ss) => ss.filter((s) => !ids.has(s.condition_id)));
    if (ids.has(activeCond)) setActiveCond(conditions.find((c) => !ids.has(c.id))?.id || "");
    setCommitMsg(`Deleted ${live.length} condition${live.length === 1 ? "" : "s"}${owned ? ` and ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}.`);
    return true;
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
    // reassign:false — Library Apply has no visual reassign affordance, but it
    // still dismisses a live bulk selection like every other activation surface
    activateCondition(c.id, { reassign: false });
    // the panel switches itself back to the Takeoffs tab (its Apply handler)
    setCommitMsg(`Added ${c.finish_tag} from the library.`);
  };
  // idx addresses the template BY POSITION (the panel's plain templates.map
  // index — it doesn't filter/sort). The focus-refresh above now skips the
  // setState when the loaded library is unchanged, which closes off the
  // common way idx would go stale mid-session; a same-length edit landing
  // from another tab in the sub-second window between render and click can
  // still retarget these by position — accepted residual risk, not fully
  // closed. Guard the deref so a stale idx (list shrank out from under us)
  // reports rather than throwing.
  const renameTemplate = (idx) => {
    const t = templates[idx];
    if (!t) { setCommitMsg("The library changed in another tab — try again."); return; }
    const tag = (window.prompt("Template tag:", t.finish_tag) || "").trim();
    if (!tag || tag === t.finish_tag) return;
    persistTemplates(templates.map((x, i) => (i === idx ? { ...x, finish_tag: tag } : x)));
  };
  const deleteTemplate = (idx) => {
    const t = templates[idx];
    if (!t) { setCommitMsg("The library changed in another tab — try again."); return; }
    if (!window.confirm(`Remove the ${t.finish_tag} template from the library? Existing conditions are unaffected.`)) return;
    persistTemplates(templates.filter((_, i) => i !== idx));
  };

  // ── material library ops (#47: copy-on-attach with a live link) ───────────
  // Conditions always own fully materialized material lines; lib_id is an
  // ADDITIVE link. Nothing here can affect totals, exports, or old snapshots
  // unless the user explicitly pushes an update.
  // memoized: both derivations feed the memoized TakeoffsPanel as props, so
  // they must hold identity across canvas-only renders (tf mirror, crosshair)
  const matLibById = useMemo(() => Object.fromEntries(matLib.map((m) => [m.id, m])), [matLib]);
  const persistMatLib = (next) => {
    setMatLib(next);
    store.saveMaterialLibrary(next).catch((e) => setCommitMsg(`Couldn't save the material library: ${e.message || e}`));
  };
  const libFields = (lm) => ({ name: lm.name || "", unit: lm.unit || "", per: lm.per || 0, basis: lm.basis || "area", round: lm.round !== false, note: lm.note || "" });
  // overridden = this line's field differs from its linked library entry
  const matFieldOverridden = (m, lm, f) => {
    if (!lm) return false;
    const L = libFields(lm);
    if (f === "per") return (Number(m.per) || 0) !== L.per;
    if (f === "round") return (m.round !== false) !== L.round;
    if (f === "basis") return (m.basis || "area") !== L.basis;   // absent basis means "area" everywhere else — don't flag it
    return String(m[f] || "") !== String(L[f] || "");
  };
  const attachLibMaterial = (libId) => {
    const lm = matLibById[libId];
    if (!lm || !aCond) return;
    updateCond({ materials: [...(aCond.materials || []), { id: uid("mat"), ...libFields(lm), lib_id: lm.id }] });
  };
  const promoteMaterial = (m) => {
    if (!m.name) { setCommitMsg("Name the material before saving it to the library."); return; }
    const entry = { id: uid("lib"), ...libFields(m) };
    persistMatLib([...matLib, entry]);
    updateMaterial(m.id, { lib_id: entry.id });
    setCommitMsg(`Saved ${m.name} to the material library.`);
  };
  const revertMatField = (m, f) => {
    const lm = matLibById[m.lib_id];
    if (lm) updateMaterial(m.id, { [f]: libFields(lm)[f] });
  };
  const updateLibMaterial = (id, patch) => persistMatLib(matLib.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  // one pass per conditions change, not per library row — the Materials tab reads this per row
  const linkedCountById = useMemo(() => {
    const by = {};
    for (const c of conditions) for (const m of c.materials || []) if (m.lib_id) by[m.lib_id] = (by[m.lib_id] || 0) + 1;
    return by;
  }, [conditions]);
  const linkedCount = (libId) => linkedCountById[libId] || 0;
  const pushLibUpdate = (libId) => {
    const lm = matLibById[libId];
    if (!lm) return;
    const n = linkedCount(libId);
    if (!n) { setCommitMsg("No condition lines link this material yet."); return; }
    if (!window.confirm(`Update ${n} linked line${n === 1 ? "" : "s"} across conditions to the library values? Overrides on those lines are replaced.`)) return;
    setConditions((cs) => cs.map((c) => ({ ...c, materials: (c.materials || []).map((m) => (m.lib_id === libId ? { ...m, ...libFields(lm) } : m)) })));
    setCommitMsg(`Updated ${n} linked line${n === 1 ? "" : "s"} from the library.`);
  };
  const deleteLibMaterial = (libId) => {
    const lm = matLibById[libId];
    const n = linkedCount(libId);
    if (!window.confirm(`Remove ${lm?.name || "this material"} from the library?${n ? (n === 1 ? " 1 linked line keeps its values — only the link is removed." : ` ${n} linked lines keep their values — only the links are removed.`) : ""}`)) return;
    persistMatLib(matLib.filter((x) => x.id !== libId));
    if (n) setConditions((cs) => cs.map((c) => ({ ...c, materials: (c.materials || []).map((m) => { if (m.lib_id !== libId) return m; const { lib_id: _l, ...rest } = m; return rest; }) })));
    // condition templates carry lib_id too (so applying re-links to a live
    // entry) — detach them here as well, or a deleted entry would leave
    // dangling links inside saved templates
    if (templates.some((t) => (t.materials || []).some((m) => m.lib_id === libId))) {
      persistTemplates(templates.map((t) => ({ ...t, materials: (t.materials || []).map((m) => { if (m.lib_id !== libId) return m; const { lib_id: _l, ...rest } = m; return rest; }) })));
    }
  };
  const addLibMaterial = () => persistMatLib([...matLib, { id: uid("lib"), name: "", unit: "", per: 0, basis: "area", round: true, note: "" }]);

  // ── TakeoffsPanel wiring ───────────────────────────────────────────────────
  // The docked panel is memoized (React.memo) so canvas-only renders — the
  // ~11Hz tf mirror during pan/zoom, crosshair/status churn — skip its whole
  // subtree. That only works if its props hold identity, and the handlers
  // above close over fresh state every render; so the panel gets STABLE
  // forwarders (minted once) that read the current handler through this ref
  // at call time. Add a handler here and it's automatically stable.
  const panelHandlersRef = useRef(null);
  panelHandlersRef.current = {
    onActivate: activateCondition, onLocate: locateCondition,
    onAddCondition: addCondition, onDeleteCondition: deleteCondition,
    onUpdateCond: updateCond, onSetCondParam: setCondParam, onAssignAttr: assignAttr,
    onAddMaterial: addMaterial, onUpdateMaterial: updateMaterial, onRemoveMaterial: removeMaterial,
    onBulkWaste: bulkWasteConditions, onBulkColor: bulkColorConditions, onBulkDelete: bulkDeleteConditions,
    onSaveTemplate: saveActiveAsTemplate, onApplyTemplate: applyTemplate,
    onRenameTemplate: renameTemplate, onDeleteTemplate: deleteTemplate,
    onAddColumn: addColumn, onRenameColumn: renameColumn, onDeleteColumn: deleteColumn,
    onAddColumnValue: addColumnValue, onRemoveColumnValue: removeColumnValue, onRenameColumnValue: renameColumnVal,
    onAttachLibMaterial: attachLibMaterial, onPromoteMaterial: promoteMaterial, onRevertMatField: revertMatField,
    onUpdateLibMaterial: updateLibMaterial, onPushLibUpdate: pushLibUpdate,
    onDeleteLibMaterial: deleteLibMaterial, onAddLibMaterial: addLibMaterial,
    matFieldOverridden,   // pure helper, not an event handler — the forwarder returns its result
    onToggleCollapse: toggleTakeoffs,
    // these three are ALREADY stable on their own (setState identity, and
    // holdPanelGesture is a useCallback with an empty dep array) — routed
    // through the registry anyway so the memo contract has exactly ONE
    // convention to audit, not "stable via the registry, except these three"
    onPanelPrefs: setPanelPrefs, onSetActive: setActiveCond, onHoldGesture: holdPanelGesture,
  };
  const [panelHandlers] = useState(() => {
    const stable = {};
    for (const k of Object.keys(panelHandlersRef.current)) stable[k] = (...a) => panelHandlersRef.current[k](...a);
    return stable;
  });

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
        {tool === "oneclick" && (() => {
          // Fill sensitivity — how eagerly One-Click crosses a room's hatch. Detents
          // at Strict / Balanced / Aggressive; the slider still tunes 0–100% freely,
          // snapping to a notch when released near one.
          // detents come from oneclick's canonical presets so UI and flood math
          // can't drift if a preset is ever retuned.
          const NOTCHES = [SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE];
          const label = fillSens === SENS_STRICT ? "Strict" : fillSens === SENS_BALANCED ? "Balanced" : fillSens === SENS_AGGRESSIVE ? "Aggressive" : `${Math.round(fillSens * 100)}%`;
          const snap = (v) => { for (const n of NOTCHES) if (Math.abs(v - n) <= 0.06) return n; return v; };
          return (
            <span title={"One-Click fill sensitivity — how far a fill reaches past a room's hatch pattern.\nStrict: stop at the linework (original behavior).\nBalanced: recover hatch-lined rooms to the walls (default).\nAggressive: cross more pattern and tolerate more growth.\nLower it if fills spill; raise it if hatched rooms come up short."}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 10px", border: "1px solid var(--ink-faint)", lineHeight: 1 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Fill</span>
              <input type="range" min={SENS_STRICT} max={SENS_AGGRESSIVE} step={0.01} value={fillSens} list="fill-sens-notches"
                onChange={(e) => setFillSens(snap(parseFloat(e.target.value)))}
                style={{ width: 108, accentColor: "var(--cobalt)", cursor: "pointer" }} />
              <datalist id="fill-sens-notches"><option value={SENS_STRICT} /><option value={SENS_BALANCED} /><option value={SENS_AGGRESSIVE} /></datalist>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--cobalt)", minWidth: 62 }}>{label}</span>
            </span>
          );
        })()}
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
        {markupDraft && (tool === "cloud" || tool === "callout" || tool === "highlight") && <span style={{ fontSize: 11, color: "var(--cobalt)" }}>click the {tool === "callout" ? "label spot" : "opposite corner"}…</span>}
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
              <button key={c.id} onClick={() => activateCondition(c.id)} title={tool === "select" && selectedId ? "Reassign selected shape to this condition" : (i < 9 ? `Press ${i + 1}` : "")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 0, border: on ? `2px solid ${c.color}` : (tool === "select" && selectedId ? "1px dashed #1f3fc7" : "1px solid var(--ink-faint)"), background: on ? "#fff" : "transparent", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 12.5 }}>
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
       {/* docked LEFT panel — one of Markups/Stamps/RFIs at a time. Reflows the
           canvas (a flex sibling), mirroring the docked Takeoffs panel on the right. */}
       {leftTab && (
         <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--ink-faint)", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
           {/* tab strip */}
           <div style={{ display: "flex", alignItems: "stretch", background: "#1f3fc7", color: "#fff" }}>
             {[{ id: "markup", label: "Markups", n: markupCount }, { id: "stamp", label: "Stamps", n: stampLib.stamps.length }, { id: "rfi", label: "RFIs", n: rfis.length }].map((t) => (
               <button key={t.id} onClick={() => setLeftTab(t.id)} title={t.label}
                 style={{ flex: 1, padding: "9px 6px", border: "none", borderBottom: leftTab === t.id ? "2px solid #fff" : "2px solid transparent", background: leftTab === t.id ? "rgba(255,255,255,.18)" : "transparent", color: "#fff", cursor: "pointer", fontWeight: leftTab === t.id ? 700 : 500, fontSize: 12 }}>
                 {t.label}{t.n ? ` · ${t.n}` : ""}
               </button>
             ))}
             <button onClick={() => setLeftTab(null)} title="Close panel" style={{ padding: "0 12px", border: "none", background: "transparent", color: "#fff", fontSize: 16, cursor: "pointer" }}>×</button>
           </div>
           {/* body of the active tab */}
           <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
             {leftTab === "markup" && (
               <div>
                 {/* layer show/hide — hides the on-canvas markup layer AND its hit-testing
                     (can't select/delete/fly-to an invisible markup); orthogonal to the
                     marked-set export, which still includes markups. */}
                 <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
                   <button
                     onClick={() => { const nv = !showMarkups; setShowMarkups(nv); if (!nv) setSelectedMarkupId(null); }}
                     title={showMarkups ? "Hide the markup layer on the canvas" : "Show the markup layer on the canvas"}
                     style={{ background: "transparent", border: "1px solid var(--ink-faint)", color: "var(--ink)", fontSize: 11, cursor: "pointer", padding: "2px 7px" }}>
                     {showMarkups ? "Hide layer" : "Show layer"}
                   </button>
                 </div>
                 <div style={{ padding: "8px 10px", color: "var(--ink-muted)" }}>
                   Pick <b>☁ Cloud</b>, <b>▨ Highlight</b>, <b>💬 Callout</b>, or <b>T Text</b> above, then click the plan to annotate it.
                 </div>
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).length === 0 && (
                   <div style={{ padding: "4px 12px 14px", color: "var(--ink-muted)" }}>No markups {groupKeys.length > 1 ? "on these sheets" : "on this sheet"} yet.</div>
                 )}
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).map((m) => (
                   <div key={m.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                     <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                       <span style={{ fontSize: 10, fontWeight: 700, color: "#1f3fc7", textTransform: "uppercase" }}>{m.type}</span>
                       {/* inline edit — the panel's fallback for the canvas overlay, since a
                           markup here may be off-screen or on another sheet (no click point).
                           Enter/blur commit, Esc cancels; INPUT is guarded from the global keys. */}
                       {panelEditId === m.id ? (
                         <input autoFocus defaultValue={m.text || ""}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); } else if (e.key === "Escape") { e.preventDefault(); e.currentTarget.value = m.text || ""; setPanelEditId(null); } }}
                           onBlur={(e) => { updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); }}
                           style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "1px 4px", border: "1px solid #1f3fc7", borderRadius: 0, outline: "none" }} />
                       ) : (
                         <span style={{ flex: 1, color: "var(--ink)" }}>{m.type === "svg" ? <em style={{ color: "var(--ink-muted)" }}>(vector symbol)</em> : (m.text || <em style={{ color: "var(--ink-muted)" }}>(no text)</em>)}</span>
                       )}
                       {m.type !== "svg" && <button onClick={() => setPanelEditId((id) => (id === m.id ? null : m.id))} title="Edit text" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)" }}>✎</button>}
                       <button onClick={() => deleteMarkup(m.id)} title="Delete markup" style={{ border: "none", background: "none", cursor: "pointer", color: "#b03a26" }}>🗑</button>
                     </div>
                     {/* appearance — per-markup color (reuse PALETTE) + line style; both
                         additive: unset color falls back to the cobalt(linked)/amber default,
                         unset style to solid. The RFI ⬢/number badge stays cobalt regardless. */}
                     <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 7, flexWrap: "wrap" }}>
                       <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginRight: 2 }}>Color</span>
                       <button title="Auto (linkage color)" onClick={() => updateMarkup(m.id, { color: "" })} style={{ width: 26, height: 15, borderRadius: 4, background: "var(--paper-bright)", border: !m.color ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 8.5, lineHeight: "11px", color: "var(--ink-muted)" }}>auto</button>
                       {PALETTE.map((c) => <button key={c} title={c} onClick={() => updateMarkup(m.id, { color: c })} style={{ width: 15, height: 15, borderRadius: 4, background: c, border: m.color === c ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
                       <select value={m.line_style || "solid"} onChange={(e) => updateMarkup(m.id, { line_style: e.target.value })} title="Line style" style={{ marginLeft: 4, fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
                         {LINE_STYLE_IDS.map((id) => <option key={id} value={id}>{LINE_STYLES[id].label}</option>)}
                       </select>
                       {/* line weight — a multiplier over the element's base stroke width (default
                           ×1, clamped 0.5–3); additive, absent = ×1 so legacy markups are unchanged */}
                       <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginLeft: 4 }}>Weight</span>
                       <select value={String(snapWeight(m.weight))} onChange={(e) => updateMarkup(m.id, { weight: Number(e.target.value) })} title="Line weight (× base)" style={{ fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
                         {WEIGHT_STEPS.map((wv) => <option key={wv} value={wv}>{wv}×</option>)}
                       </select>
                       {/* revision-delta △n — clouds only; blank clears it (no delta drawn) */}
                       {m.type === "cloud" && (
                         <>
                           <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginLeft: 4 }} title="Revision-delta number (△) drawn at a cloud corner">Rev △</span>
                           <input type="number" min="0" step="1" value={Number.isFinite(m.rev) ? m.rev : ""} placeholder="—"
                             onChange={(e) => { const raw = e.target.value; updateMarkup(m.id, { rev: raw === "" ? undefined : Math.max(0, Math.floor(Number(raw) || 0)) }); }}
                             title="Revision number for the △ delta (blank = none)"
                             style={{ width: 40, fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }} />
                         </>
                       )}
                     </div>
                     {/* RFI controls — raise a fresh RFI, link an existing one, or unlink */}
                     {(() => {
                       const linked = m.rfi_id ? rfis.find((r) => r.id === m.rfi_id) : null;
                       const ctrl = { padding: "2px 7px", border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 };
                       return (
                         <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                           {linked ? (
                             <>
                               <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 700, color: "#1f3fc7" }}>⬢ {String(linked.number ?? "")}</span>
                               <button onClick={() => { setLeftTab("rfi"); }} style={{ ...ctrl, color: "#1f3fc7" }} title="Open the RFI register">Open</button>
                               <button onClick={() => unlinkRfi(m)} style={{ ...ctrl, color: "var(--ink-muted)" }} title="Unlink this markup from its RFI">Unlink</button>
                             </>
                           ) : (
                             <>
                               <button onClick={() => raiseRfi(m)} style={{ ...ctrl, color: "#1f3fc7", fontWeight: 600 }} title="Create a new RFI from this markup">Raise RFI</button>
                               {rfis.length > 0 && (
                                 <select value="" onChange={(e) => { if (e.target.value) linkRfi(m, e.target.value); }}
                                   title="Link this markup to an existing RFI" style={{ ...ctrl, background: "var(--paper-bright)", maxWidth: 150 }}>
                                   <option value="">Link existing…</option>
                                   {rfis.map((r) => <option key={r.id} value={r.id}>{r.number}{r.subject ? ` · ${r.subject}` : ""}</option>)}
                                 </select>
                               )}
                             </>
                           )}
                         </div>
                       );
                     })()}
                   </div>
                 ))}
               </div>
             )}
             {leftTab === "stamp" && (
               <StampPanel
                 docked
                 library={stampLib} armedStamp={armedStamp}
                 selectedMarkup={selectedMarkupId ? markups.find((m) => m.id === selectedMarkupId) : null}
                 onArm={armStamp} onSaveSelected={saveMarkupAsStamp} onDelete={deleteStamp} onRename={renameStamp}
                 onExport={exportStamps} onImport={importStamps} onImportSvg={importSvgStamp} onClose={() => setLeftTab(null)}
               />
             )}
             {leftTab === "rfi" && (
               <RfiPanel
                 docked
                 rfis={rfis} markups={markups}
                 onUpdateRfi={updateRfi} onDeleteRfi={deleteRfi} onFlyTo={flyToMarkup}
                 sheetLabel={(k) => tabLabel(k)} onClose={() => setLeftTab(null)}
               />
             )}
           </div>
         </div>
       )}
       <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div ref={containerRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp} onPointerLeave={hideCrosshair} onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={(e) => { if (tool === "oneclick") { if (proposal?.regions.length) createProposal(); } else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface") finishShape(); else if (tool === "select") editMarkupAt(e); }}
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
          {/* inline on-canvas text editor — a screen-space overlay pinned to its anchor
              (pan/zoom is frozen while open). Enter commits, Esc cancels, blur commits;
              all on the input's OWN handlers so the global keydown (which returns early
              for INPUT) never interferes. cursor:text overrides the stage's cursor:none. */}
          {editor && (
            <input ref={editorInputRef} autoFocus defaultValue={editor.value}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finishEditor(true); } else if (e.key === "Escape") { e.preventDefault(); finishEditor(false); } }}
              onBlur={() => finishEditor(true)}
              placeholder="Type, Enter to place · Esc cancels"
              style={{ position: "absolute", left: editor.left, top: editor.top, zIndex: 9, minWidth: 160, padding: "3px 6px", font: "13px var(--f-body, sans-serif)", color: "var(--ink)", background: "var(--paper-bright)", border: "1px solid #1f3fc7", boxShadow: "0 2px 10px rgba(0,0,0,.18)", borderRadius: 0, cursor: "text", outline: "none" }} />
          )}
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
                        // line_style governs linear outlines (surface_area keeps its dash-dot identity above)
                        return <polyline key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? "#1f3fc7" : col} strokeWidth={(sel ? 4 : 3) / z} strokeDasharray={dashArrayFor(cond?.line_style || "solid", z)} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      const ded = s.measure_role === "deduct";
                      // deduct keeps its danger-red dashing (a safety signal, wins over line_style); positive floor_area follows the condition's line_style
                      return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill={ded ? "rgba(176,58,38,.28)" : shapeFill(cond)} stroke={ded ? "#b03a26" : (sel ? "#1f3fc7" : col)} strokeWidth={sw} strokeDasharray={ded ? `${6 / z} ${4 / z}` : dashArrayFor(cond?.line_style || "solid", z)} />;
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
                    {/* markup layer — highlights / clouds / callouts / text notes on this
                        panel. Highlights draw FIRST (behind) so their translucent fill never
                        dims the linework above. A selected markup wears a CONTRASTING halo
                        (white outer ring + cobalt inner). Per-markup color drives the STROKE/
                        FILL (dark-boosted on the dark canvas); RFI linkage is an unconditional
                        ⬢/number badge, independent of the note text. Layer hides via showMarkups. */}
                    {showMarkups && markups.filter((m) => m.sheet_id === p.key)
                      .slice().sort((a, b) => (a.type === "highlight" ? 0 : 1) - (b.type === "highlight" ? 0 : 1))
                      .map((m) => {
                      const z = tf.scale;
                      const base = m.color || (m.rfi_id ? "#1f3fc7" : "#c47a10");
                      const mk = darkMode ? boostForDark(base) : base;   // literal — SVG attrs don't resolve CSS vars
                      const dash = dashArrayFor(m.line_style || "solid", z);
                      const w = clampWeight(m.weight);   // stroke-width multiplier over each element's base, default ×1
                      const selM = m.id === selectedMarkupId;
                      // linkage badge — unconditional for any linked markup (a note-less
                      // recolored cloud still reads as linked); kept in cobalt for legibility
                      // regardless of the user's color, pinned clear of the halo.
                      const linked = m.rfi_id ? rfis.find((r) => r.id === m.rfi_id) : null;
                      const badgeCol = darkMode ? boostForDark("#1f3fc7") : "#1f3fc7";
                      const badge = (bx, by) => (m.rfi_id ? (
                        <text x={bx} y={by} fill={badgeCol} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{"⬢"}{linked && linked.number != null && linked.number !== "" ? " " + linked.number : ""}</text>
                      ) : null);
                      // revision-delta △n — a small numbered triangle at a cloud corner,
                      // clear of the halo, the top-left RFI badge, and the centered note.
                      // Absent/zero m.rev → nothing (legacy clouds render unchanged).
                      // the triangle backing is ALWAYS white, so stroke/number it in the
                      // UN-boosted color (mk's dark boost is tuned to contrast the dark
                      // canvas, and would wash out on white).
                      const revTri = (rx, ry) => (Number.isFinite(m.rev) && m.rev > 0 ? (
                        <g style={{ pointerEvents: "none" }}>
                          <path d={`M${rx},${ry - 9 / z} L${rx + 8 / z},${ry + 6 / z} L${rx - 8 / z},${ry + 6 / z} Z`} fill="#fff" stroke={base} strokeWidth={1.4 / z} />
                          <text x={rx} y={ry + 2.5 / z} fill={base} fontSize={9 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central">{m.rev}</text>
                        </g>
                      ) : null);
                      // halo ring widths scale with weight so a heavy stroke never overruns them
                      const halo = (x0, y0, x1, y1) => (selM ? (
                        <>
                          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#fff" strokeWidth={(5 * w) / z} />
                          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#1f3fc7" strokeWidth={(2 * w) / z} />
                        </>
                      ) : null);
                      if (m.type === "highlight") {
                        const [c0, c1] = m.rect;
                        const hx0 = Math.min(c0[0], c1[0]) * p.img.w, hy0 = Math.min(c0[1], c1[1]) * p.img.h;
                        const hx1 = Math.max(c0[0], c1[0]) * p.img.w, hy1 = Math.max(c0[1], c1[1]) * p.img.h;
                        const pad = (5 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
                            <rect x={hx0} y={hy0} width={hx1 - hx0} height={hy1 - hy0} fill={mk} fillOpacity={0.18} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={(hx0 + hx1) / 2} y={(hy0 + hy1) / 2} fill={mk} fontSize={13 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(hx0, hy0 - pad - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "cloud") {
                        const [c0, c1] = m.rect;
                        const pad = (5 * w) / z;
                        const bx0 = Math.min(c0[0], c1[0]) * p.img.w - pad, by0 = Math.min(c0[1], c1[1]) * p.img.h - pad;
                        const bx1 = Math.max(c0[0], c1[0]) * p.img.w + pad, by1 = Math.max(c0[1], c1[1]) * p.img.h + pad;
                        return (
                          <g key={m.id}>
                            {halo(bx0, by0, bx1, by1)}
                            <path d={cloudPath(c0[0] * p.img.w, c0[1] * p.img.h, c1[0] * p.img.w, c1[1] * p.img.h)} fill="none" stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={(c0[0] + c1[0]) / 2 * p.img.w} y={(c0[1] + c1[1]) / 2 * p.img.h} fill={mk} fontSize={13 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(bx0, by0 - 9 / z)}
                            {revTri(bx1, by0 - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "callout") {
                        const [tx, ty] = m.target, [ax, ay] = m.at;
                        const lw = ((m.text?.length || 1) * 7 + 10) / z;
                        return (
                          <g key={m.id}>
                            {halo(ax * p.img.w - 4 / z, ay * p.img.h - 18 / z, ax * p.img.w + lw + 4 / z, ay * p.img.h + 4 / z)}
                            <line x1={tx * p.img.w} y1={ty * p.img.h} x2={ax * p.img.w} y2={ay * p.img.h} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {/* arrowhead at the target end — replaces the old vertex star */}
                            <path d={arrowheadPath(ax * p.img.w, ay * p.img.h, tx * p.img.w, ty * p.img.h, 9 / z)} fill={mk} />
                            <rect x={ax * p.img.w} y={ay * p.img.h - 16 / z} width={lw} height={20 / z} fill="rgba(255,255,255,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} rx={3 / z} />
                            <text x={(ax * p.img.w) + 5 / z} y={(ay * p.img.h) - 2 / z} fill="#0e1a2e" fontSize={12 / z}>{m.text}</text>
                            {badge(ax * p.img.w, ay * p.img.h - 24 / z)}
                          </g>
                        );
                      }
                      if (m.type === "arrow") {
                        const [fx, fy] = [m.from[0] * p.img.w, m.from[1] * p.img.h];
                        const [tx, ty] = [m.to[0] * p.img.w, m.to[1] * p.img.h];
                        const midx = (fx + tx) / 2, midy = (fy + ty) / 2;
                        const hx0 = Math.min(fx, tx), hy0 = Math.min(fy, ty), hx1 = Math.max(fx, tx), hy1 = Math.max(fy, ty);
                        const pad = (6 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
                            <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} strokeLinecap="round" />
                            {/* filled arrowhead at the `to` end */}
                            <path d={arrowheadPath(fx, fy, tx, ty, 11 / z)} fill={mk} />
                            {m.text && <text x={midx} y={midy - 6 / z} fill={mk} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(hx0, hy0 - pad - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "bubble") {
                        const cx = m.at[0] * p.img.w, cy = m.at[1] * p.img.h;
                        const rad = (Number(m.r) > 0 ? Number(m.r) : 0.02) * p.img.w;
                        const pad = (5 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(cx - rad - pad, cy - rad - pad, cx + rad + pad, cy + rad + pad)}
                            <circle cx={cx} cy={cy} r={rad} fill={darkMode ? "rgba(12,15,20,.85)" : "rgba(255,255,255,.85)"} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={cx} y={cy} fill={mk} fontSize={Math.min(13, rad * z * 0.9) / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(cx + rad, cy - rad - 4 / z)}
                          </g>
                        );
                      }
                      if (m.type === "svg" && m.path && Array.isArray(m.vb)) {
                        // a vector symbol (imported .svg or saved-as-stamp art). The
                        // path is baked local→image px through a uniform scale off the
                        // LONGER viewBox extent so it never distorts and a one-axis
                        // symbol can't blow up; stroke/fill are the symbol's OWN color
                        // (dark-boosted), not the linkage tint.
                        const { s: sx, bw, bh } = svgPlacedBox(m.vb, m.w, p.img.w);
                        if (!(sx > 0)) return null;
                        const x0 = m.at[0] * p.img.w - bw / 2, y0 = m.at[1] * p.img.h - bh / 2;
                        const d = transformPath(m.path, (lx, ly) => [x0 + lx * sx, y0 + ly * sx]);
                        const fillOn = m.fill && m.fill !== "none";
                        const fcol = fillOn ? (darkMode ? boostForDark(m.fill) : m.fill) : "none";
                        return (
                          <g key={m.id}>
                            {halo(x0, y0, x0 + bw, y0 + bh)}
                            <path d={d} fill={fcol} fillOpacity={fillOn ? 0.9 : undefined} stroke={mk} strokeWidth={(1.6 * w) / z} strokeLinejoin="round" style={{ pointerEvents: "none" }} />
                            {badge(x0, y0 - 9 / z)}
                          </g>
                        );
                      }
                      const [x, y] = m.at;
                      const lw = ((m.text?.length || 1) * 7 + 10) / z;
                      return (
                        <g key={m.id}>
                          {halo(x * p.img.w - 5 / z, y * p.img.h - 16 / z, x * p.img.w + lw + 3 / z, y * p.img.h + 6 / z)}
                          <rect x={x * p.img.w - 3 / z} y={y * p.img.h - 14 / z} width={lw} height={20 / z} fill="rgba(255,247,237,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} rx={3 / z} />
                          <text x={x * p.img.w + 2 / z} y={y * p.img.h} fill="#0e1a2e" fontSize={12 / z} fontWeight="600">{m.text}</text>
                          {badge(x * p.img.w, y * p.img.h - 22 / z)}
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
              <rect ref={highlightRef} fill="rgba(196,122,16,.18)" stroke="#c47a10" strokeWidth={2 / tf.scale} style={{ display: "none" }} />
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
          <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", maxWidth: "70%", zIndex: 6, pointerEvents: "none", padding: "6px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-1)", fontSize: 12, color: isDangerMsg(commitMsg) ? "#b03a26" : "var(--c-positive)" }}>
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
            style). Moved out of the toolbar so it never wraps a third row. The
            takeoffs toggle mirrors the DOCKED panel's collapsed pref — the rail
            rides the canvas edge, so it stays visible either way. */}
        <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 6, zIndex: 8 }}>
          {panelBtn(() => setLeftTab((t) => (t === "markup" ? null : "markup")), "markup", "Markups on these sheets (clouds, callouts, notes)", leftTab === "markup", markupCount)}
          {panelBtn(() => setLeftTab((t) => (t === "stamp" ? null : "stamp")), "stamp", "Stamps — reusable annotations dropped click-to-place", leftTab === "stamp", stampLib.stamps.length)}
          {panelBtn(() => setLeftTab((t) => (t === "rfi" ? null : "rfi")), "rfi", "RFI register — raise, track, and export Requests For Information", leftTab === "rfi", rfis.length)}
          {panelBtn(toggleTakeoffs, "takeoffs", "Takeoffs — conditions + running totals", takeoffsOpen, visibleShapes.length)}
        </div>

       </div>

        {/* Takeoffs panel — DOCKED in the layout row (reflows the canvas, not an
            overlay): every condition with its running totals, plus the Library,
            Materials, and Columns tabs. Extracted to components/TakeoffsPanel.jsx and
            ALWAYS mounted (it renders null while collapsed) so its view state —
            tab, filter, multi-select — survives a collapse/expand round-trip
            exactly as it did as canvas state. Collapse/expand keeps the current
            transform — the stage is anchored top-left, so a re-fit would be a
            jarring jump. */}
        <TakeoffsPanel
          open={takeoffsOpen}
          width={panelW}
          multiSheet={groupKeys.length > 1}
          conditions={conditions}
          activeCond={activeCond}
          visRowById={visRowById}
          conditionColumns={conditionColumns}
          templates={templates}
          matLib={matLib}
          matLibById={matLibById}
          linkedCountById={linkedCountById}
          panelPrefs={panelPrefs}
          reassigning={tool === "select" && !!selectedId}
          epoch={panelEpoch}
          clearSelectionRef={panelSelectionRef}
          {...panelHandlers}
        />
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
          conditions={conditions} shapes={shapes} markups={markups} rfis={rfis}
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
          setPoly([]); setCalib([]); setPendingLen(""); selectShape(null); setProposal(null);
          hydrate(payload || {});
        }}
      />
    </div>
  );
}
