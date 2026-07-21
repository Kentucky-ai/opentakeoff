// Pure data constants for the Takeoff Canvas — render/zoom budgets, snap
// tuning, toolbar tool descriptors, and the flooring starter conditions.
// No DOM, no React, no functions: values only, moved verbatim from
// pages/TakeoffCanvas.jsx so the canvas and any future reader share one copy.
// (The one import is another values-only constant: the grout tile-geometry
// defaults from lib/coverage.js, so the CT-1 seed and the editor can't drift.)

import { GROUT_DEFAULTS } from "./coverage.js";

export const MIN_SCALE = 0.03;
export const MAX_SCALE = 32;  // stage zoom is in raster px — with the 28MP base budget this keeps ≈ the old deep-zoom ceiling (detail view carries the crispness)
export const PANEL_GAP = 48;  // px between side-by-side sheets in a multi-sheet group
// Base raster: enough density for fit-to-view + the first stretch of zoom; sharpness
// past 1:1 comes from the DETAIL VIEW (region re-render), never from a giant full-sheet
// bitmap. Rastering to the browser caps would put a 36×24" sheet at 179MP ≈ 716MB of
// backing store per panel — a 4-up ≈ 2.9GB, which Chrome silently fails to keep
// composited (blank sheet at zoom-out, evicted chrome). Quantities are scale-free
// (verts are normalized and the render factor cancels in the area math), so the budget
// only trades memory for base-layer sharpness. Hi-Res opts a sheet INTO the auto
// budget per-user (the default stays the lean baseline raster).
export const QUALITY_CEILING = 8.0;                  // hard cap on render scale (≈576 px/in) — binds only on small pages now
export const MAX_CANVAS_DIM  = 16384;                // safe max side for a single canvas (Chrome/Firefox/Safari desktop)
export const MAX_CANVAS_AREA = 16384 * 16384 * 0.9;  // per-canvas pixel cap — the DETAIL view's density factor uses this
export const MAX_PANEL_AREA  = 28e6;                 // base-raster pixel budget per panel (~112MB RGBA; 4-up ≈ 450MB)
// Detail view: once zoomed past the base raster's 1:1 IN DEVICE PIXELS, we overlay a
// crop of JUST the visible region, re-rendered from the PDF vectors at the current zoom —
// Bluebeam/AutoCAD-style. Crispness becomes unbounded (up to the per-region canvas cap)
// without ever holding a giant full-sheet bitmap; the region is ~viewport-sized so the cap
// effectively never binds. Engage compares t.scale × devicePixelRatio (softness starts
// when the raster is upscaled in device px — on a 2× display that's t.scale 0.5, not 1).
export const DETAIL_ENGAGE = 1.15;  // engage once stage zoom × dpr passes ~1.15 (base raster starts to soften)
export const DETAIL_MARGIN = 0.5;   // render this much extra region beyond the viewport so small pans don't expose the soft base at the edges
export const SYNC_MS = 90;          // React tf-mirror sync cadence during gestures (~11Hz)
export const GESTURE_MS = 140;      // wheel/pinch quiet window before the detail view re-renders
// A backgrounded/hidden tab can suspend pdf.js's render scheduling indefinitely (promise
// neither resolves nor rejects, no console error — Chrome throttles rAF-gated work in
// hidden tabs). The primary recovery for THAT case is the visibilitychange retry below —
// this is only a backstop for some other, unknown cause of a wedged render, so it's set
// long enough to never fire on a merely slow (not stuck) render — confirmed live: a large
// region under real CPU contention took 50+ seconds and still resolved on its own.
export const DETAIL_STALL_MS = 25000;

export const SNAP_CELL = 24;   // snap-grid bucket, raster px (Spline runs 12 — its budgeted raster is denser)

// toolbar menus — STACK-style: the menu face shows the armed tool
export const MEASURE_TOOLS = [
  { id: "oneclick", icon: "oneClick", label: "One-Click Area", shortcut: "O" },
  { id: "area", icon: "area", label: "Area", shortcut: "A" },
  { id: "rect", icon: "rectTool", label: "Rectangle", shortcut: "R" },
  { id: "linear", icon: "linear", label: "Linear", shortcut: "L" },
  { id: "curve", icon: "curve", label: "Curved Line", shortcut: "Q" },
  { id: "surface", icon: "surface", label: "Surface Area", shortcut: "S" },
  { id: "count", icon: "count", label: "Count", shortcut: "C" },
];
export const CUT_TOOLS = [
  { id: "deduct", icon: "deduct", label: "Deduct shape", shortcut: "D" },
  { id: "deduct-rect", icon: "deductRect", label: "Deduct rectangle", shortcut: "⇧D" },
];
export const MARKUP_TOOLS = [
  { id: "highlighter", icon: "highlighter", label: "Highlighter", shortcut: "H" },
  { id: "cloud", icon: "cloud", label: "Revision cloud" },
  { id: "callout", icon: "callout", label: "Callout" },
  { id: "text", icon: "textNote", label: "Text note" },
  { id: "highlight", icon: "highlight", label: "Highlight box" },
];
export const MARKUP_IDS = MARKUP_TOOLS.map((t) => t.id);
// highlighter inks — literal hex (SVG attrs; CSS vars don't resolve there).
// The freehand TOOL is "highlighter" (the two-corner "highlight" box above is
// its own tool); its strokes persist as type:"highlight" + pts, the same
// record the pre-fork canvas wrote, so old saved strokes render unchanged —
// every reader discriminates on pts (stroke) vs rect (box).
export const HL_INKS = ["#ffd60a", "#ff9f0a", "#34c759", "#3fa9ff", "#ff6ea8"];
export const HL_SIZES = [["F", 8], ["M", 14], ["B", 22]];   // screen px at draw time

// Flooring-first starter conditions seeded on a fresh workspace — line color +
// hatch chosen to read like the real finish; waste % is a sensible default you
// can change per condition (it's never auto-applied to the live readout, only
// the Report). Delete any you don't need.
// Each default also carries a couple of editable starter materials — quantities
// derive deterministically from measured area/linear ÷ a coverage rate you set
// (off the product data sheet). Delete/edit freely; they're just sensible seeds.
// Per-material-kind coverage presets (adhesive trowel notches, mortar trowels)
// and the grout-from-tile-geometry calculator live in lib/coverage.js —
// vendor-neutral, generic rates; always verify against the product data sheet.
// Expressed in TEMPLATE shape (finish_tag/waste_pct/materials, no fill — it
// defaults from color) so seeding and the Library run the same constructor.
export const FLOORING_DEFAULTS = [
  { finish_tag: "CPT-1", color: "#2f7d54", hatch: "speckle", waste_pct: 5,  materials: [{ name: "Adhesive", kind: "adhesive", per: 250, basis: "area", unit: "gal" }] },                  // Carpet tile
  { finish_tag: "BRD-1", color: "#be185d", hatch: "dots",    waste_pct: 10, materials: [{ name: "Adhesive", kind: "adhesive", per: 120, basis: "area", unit: "gal" }] },                  // Broadloom carpet (roll goods)
  { finish_tag: "LVT-1", color: "#b8860b", hatch: "plank",   waste_pct: 8,  materials: [{ name: "Adhesive", kind: "adhesive", per: 250, basis: "area", unit: "gal" }] },                  // Luxury vinyl plank/tile
  { finish_tag: "WD-1",  color: "#9a3412", hatch: "plank",   waste_pct: 10, materials: [                                                                                                  // Unfinished 2.25″ solid red oak — glue-down + site-finished
    { name: "Adhesive (wood, SMP)",     kind: "adhesive", per: 50,  basis: "area", unit: "gal", note: "1/4″×1/4″ V (wood)" },
    { name: "Sealer (primer coat)",     per: 400, basis: "area", unit: "gal", note: "1 prime coat (~10 m²/L)" },
    { name: "Polyurethane (2K finish)", per: 136, basis: "area", unit: "gal", note: "≈3 coats @ ~408 SF/gal/coat (2K 10:1)" },
  ] },
  { finish_tag: "VCT-1", color: "#2563eb", hatch: "checker", waste_pct: 5,  materials: [{ name: "Adhesive", kind: "adhesive", per: 350, basis: "area", unit: "gal" }] },                  // Vinyl composition tile
  { finish_tag: "SV-1",  color: "#0d9488", hatch: "solid",   waste_pct: 10, materials: [{ name: "Adhesive", kind: "adhesive", per: 150, basis: "area", unit: "gal" }] },                  // Sheet vinyl
  { finish_tag: "CT-1",  color: "#9333ea", hatch: "grid",    waste_pct: 10, materials: [                                                                                                  // Ceramic / porcelain tile
    { name: "Thinset mortar", kind: "mortar", per: 65, basis: "area", unit: "bag", note: '1/4″×3/8″×1/4″ sq' },
    { name: "Grout", kind: "grout", per: 512, basis: "area", unit: "bag", grout: { ...GROUT_DEFAULTS }, note: '12×24×3/8″ @ 1/8″ · 25 lb' },
  ] },
  { finish_tag: "RB-1",  color: "#475569", hatch: "horiz",   waste_pct: 5,  materials: [{ name: "Cove base adhesive", kind: "adhesive", per: 40, basis: "linear", unit: "tube" }] },      // Rubber / resilient wall base (linear)
  { finish_tag: "TR-1",  color: "#c96442", hatch: "vert",    waste_pct: 0,  materials: [] },                                                                                              // Transitions / reducers (linear)
];
