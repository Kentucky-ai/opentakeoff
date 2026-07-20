// Takeoff Canvas — Phase 1 (+ pan/zoom + standard scales).
// Persistent, condition-driven 2D takeoff. Pick a color-coded condition (finish
// tag), click to trace areas; each shape computes SF + perimeter from geometry ×
// calibrated scale. Drawings + scale autosave per project and reload on return.
// Commit sums each condition into ScopeItem.measure and re-runs the takeoff.
//
// Pan/zoom is written DIRECTLY to the DOM (tfRef → style.transform) so dragging
// never triggers a React render — smooth on large sheets. Panning is always at
// hand on every input device: left-drag on open canvas pans (Select), a held
// draw-click that moves becomes a pan, middle-drag / right-drag / Space-drag /
// Pan tool pan always, and continuous trackpad scroll pans both axes. A
// discrete mouse-wheel notch zooms (glided), pinch (ctrl-wheel) zooms, ⇧-wheel
// pans. Geometry math reads tfRef (always current), so drawing stays accurate.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { store, isStaleTabError, STALE_TAB_MESSAGE, projectIdFromUrl } from "../lib/store.js";
import { seedStampLibrary, instantiateStamp, markupToStampElement } from "../lib/stamps.js";
import { extractSvgPrimitives, svgToStamp } from "../lib/svgImport.js";
import { transformPath, svgPlacedBox } from "../lib/svgpath.js";
import { ingestFiles } from "../lib/ingest.js";
import ToolMenu from "../components/ToolMenu.jsx";
import PlanNavigator from "../components/PlanNavigator.jsx";
import ReportPanel from "../components/ReportPanel.jsx";
import RevisionsPanel from "../components/RevisionsPanel.jsx";
import TakeoffsPanel, { clampPanelW, CONDITION_DND_MIME, ConditionAppearanceEditor } from "../components/TakeoffsPanel.jsx";
import { HATCHES, PALETTE, NO_FILL, HatchPattern, HatchSwatch } from "../components/hatches.jsx";
import { Icon } from "../brand/icons.jsx";
import { RENDER_SCALE, MAX_GROUP, STANDARD_SCALES, parseSheetKey, compareSheetKeys, extractSheetNumber, detectScale, extractRegionText } from "../lib/sheets";
import { normalizeLoadedGroups } from "../lib/sheetGroups";
import { parseSchedule, rowToSeed } from "../lib/scheduleParse";
import { normalizeScanRows, postScanWithRetry, SCAN_ENDPOINT, scanRasterScale } from "../lib/scheduleScan";
import { normalizeTag } from "../lib/scheduleEdit";
import { isGoogleConfigured, isSignedIn, isAllowedDomain, getAccessToken, orgDomainHint } from "../lib/google/auth.js";
import { extractVectorGeometry, buildMask, floodRegion, traceRegion, snapVertices, ringArea, MASK_MAX_DIM, SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE } from "../lib/oneclick";
import { buildRasterMask, RASTER_MIN_IMG_FRAC, RASTER_MIN_SEGS, RASTER_RDP_EPS } from "../lib/rastermask";
import { conditionTotals, verticalWallSf } from "../lib/totals.js";
import { shapesInZone } from "../lib/zone.js";
import { sanitizeSheetLevels } from "../lib/sheetLevels.js";
import { sanitizeConditionColumns, sanitizeConditionAttrs, renameColumnValue, columnLabel } from "../lib/conditionColumns.js";
import { sanitizeShapeLabels, sanitizeShapeLabelsOnShapes, renameShapeLabel, shapeLabelValue } from "../lib/shapeLabels.js";
import { buildMarkedSetPdf, downloadBytes } from "../lib/markedset.js";
import { loadProfiles } from "../lib/identity.js";
import { resolveBranding, loadBrandingSelection } from "../lib/branding.js";
import { starPath, cloudPath, thinStroke, strokePathD, chiselRibbon, buildSnapGrid, nearestSnap, ANGLE_TOL, angleSnap, closedMetrics, openLen, pointInPoly, hitShape, arrowheadPath, distToSeg, reflectVertsNorm } from "../lib/geometry.js";
import { dashArrayFor, boostForDark, clampWeight, snapWeight, LINE_STYLES, LINE_STYLE_IDS, WEIGHT_STEPS } from "../lib/lineStyles.js";
import { nextRfiNumber } from "../lib/rfi.js";
import { libFields, matFieldOverridden, libPushPatch, libRevertPatch, libEntryPatch, matEditPatch } from "../lib/materials.js";
import RfiPanel from "../components/RfiPanel.jsx";
import StampPanel from "../components/StampPanel.jsx";
import ImportSchedulePanel from "../components/ImportSchedulePanel.jsx";
// In-canvas takeoff agent — BYO-key tool-use loop (lib/agentLoop) aiming the
// registry of deterministic tools (lib/agentTools); this file provides the
// CAPABILITIES those tools close over and the review gate their proposals
// pass through. AiSettings is the config surface for the ai.js seam.
import AgentPanel from "../components/AgentPanel.jsx";
import AiSettings from "../components/AiSettings.jsx";
import { AGENT_TOOL_DEFS, executeAgentTool, agentScaleGate } from "../lib/agentTools.js";
import { runAgentLoop } from "../lib/agentLoop.js";
import { aiConfig, isAiConfigured } from "../lib/ai.js";
import AccountChip from "../components/AccountChip.jsx";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { getTheme, toggleTheme, onThemeChange } from "../lib/theme.js";
// Pure data constants (render/zoom budgets, snap tuning, tool descriptors,
// flooring starter conditions) live in lib/canvasConstants.js; the pure
// module-scope helpers (autoRenderScale, invertCanvasPixels, uid, clamp,
// isDangerMsg, instantiateTemplate, seedConditions) in lib/canvasUtil.js.
import {
  PANEL_GAP, MAX_CANVAS_DIM, MAX_CANVAS_AREA,
  DETAIL_ENGAGE, DETAIL_MARGIN, SYNC_MS, GESTURE_MS, DETAIL_STALL_MS, SNAP_CELL,
  MEASURE_TOOLS, CUT_TOOLS, MARKUP_TOOLS, MARKUP_IDS, HL_INKS, HL_SIZES,
} from "../lib/canvasConstants.js";
import { autoRenderScale, invertCanvasPixels, uid, clamp, isDangerMsg, instantiateTemplate, seedConditions } from "../lib/canvasUtil.js";
// Shape provenance policy now lives in ONE place: lib/shapeCommands.js. Every
// meaningful mutation of `shapes` (create / reshape / reassign / relabel /
// delete) is a COMMAND applied through dispatchShape below — the chokepoint
// that stamps created_at / stampEdit centrally, tallies deletion counters, and
// records undo/redo. Explicit NON-edits that must NOT stamp (they rewrite
// shape records without a human touching the geometry) either ride the
// `replace` command (rescaleSheet's computed re-price, hydrate) or stay as raw
// setShapes (the label-vocabulary renames, live drag PREVIEW frames, the
// hydrate-time sanitizers, per-shape height/thickness re-pricing).
// nowIso stays imported for the non-shape records (markups, RFIs, conditions).
import { nowIso, mintUuid } from "../lib/provenance.js";
import { applyShapeCommand, geomSnapshot, vertsEqual, recordCommand } from "../lib/shapeCommands.js";
import { fmtCheckLen, parseLenInput, checkVerdict, M_PER_FT, areaVal, areaUnit, lenVal, lenUnit, calInputToFeet } from "../lib/units";
import * as panelGeom from "../lib/panelGeometry.js";

// Carpet roll width — a run reaching this needs a seam. The live cursor readout
// turns amber at/past it so the estimator sees where seams fall while tracing.
const CARPET_ROLL_FT = 12;

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Hatch templates, palette, NO_FILL, and the HatchPattern/HatchSwatch pieces
// live in components/hatches.jsx — shared with the TakeoffsPanel.

// Docked Takeoffs panel geometry — per-user UI prefs (localStorage, diff-only
// overrides like the report column prefs), NEVER in the takeoff payload: panel
// width inside buildPayload would show up as noise in every snapshot diff.
// (The width clamp (clampPanelW, wrapping PANEL_MIN_W/PANEL_MAX_W) is exported
// by the panel itself — ONE clamp, so a future range change can't diverge
// between the panel's own drag clamp and the load-time clamp here.)
const PANEL_PREFS_KEY = "opentakeoff_panel";
// The docked panel now starts COLLAPSED: the top-bar palette band (pinned chips
// + the restored active-condition appearance editor) is the primary condition
// surface, so the sidebar stays out of the way until you ask for it — via the
// canvas rail toggle or by double-clicking a palette chip (openConditionInPanel).
// Prefs persist diff-only against these defaults. Because the OLD default was
// open (collapsed:false), a previously-open panel stored no diff and is
// indistinguishable from "never touched", so this flip DOES start those users
// collapsed on first load after the change (a one-time migration, not a per-user
// choice being honored). An explicit COLLAPSE made under the old default is
// preserved; any later toggle re-persists normally.
const PANEL_DEFAULTS = { w: 320, collapsed: true, strip: false, az: false, group: false };
// Top-bar quick-access condition palette: a curated handful (≤9) of pinned
// conditions for one-click activation without leaving the canvas. Palette holds
// condition ids (workspace-scoped), so it persists with the annotation payload,
// not the per-user panel prefs. Capped at 9 so it maps 1:1 onto the 1–9 hotkeys.
const PALETTE_MAX = 9;

// Pure geometry helpers (star/cloud paths, snap grid, angle lock, metrics,
// hit-testing) live in lib/geometry.js — byte-identical with Spline's copy.

// The materials/column editors (MaterialsEditor, ColumnSelects, AddValueInput)
// live in components/TakeoffsPanel.jsx — the panel is their only surface now.

export default function TakeoffCanvas() {
  // Client-only: a single local workspace in this browser (no project id, no backend).
  const [sheets, setSheets] = useState([]);
  const [active, setActive] = useState("");      // active source PDF file name
  const [page, setPage] = useState(1);           // 1-based page within the active PDF
  const [pageCount, setPageCount] = useState(1); // pages in the active PDF
  const [view, setView] = useState("canvas");    // "gallery"/"picker" overlay the canvas (gallery-first on empty projects)
  // Cloud mode = the active store is a Drive-backed cloudStore (it has listFolder;
  // localStore does not). In cloud mode an empty project shows the Drive file
  // PICKER instead of the local drag-in prompt, so we don't auto-download every
  // PDF in the folder (spec books, as-builts). Stable per mount (store is swapped
  // in before the canvas mounts).
  const cloudMode = typeof store.listFolder === "function";
  // Reactive sign-in state: the "browse team projects" toolbar link is a
  // convenience shortcut for someone ALREADY signed in — it must never appear
  // while signed out, or it'd be a second OAuth entry point (a /projects
  // sign-in wall) in the toolbar, breaking the pre-Drive local-first look.
  const { user: googleUser } = useGoogleAuth();
  // Client-side exit back to the project home (`/`) — main.jsx's gate cleanup
  // restores the local store on the way out, so this navigation is safe.
  const navigate = useNavigate();
  // Two distinct exits out of a cloud project, both needed once every sheet is
  // closed: "Close project" always works (it's just leaving `/?project=` for
  // the local canvas — main.jsx's gate cleanup restores the local store), so
  // it's the one guaranteed path out even on deployments with no Projects root
  // configured. "Browse projects" additionally jumps straight to the team's
  // project list at /projects, when the build names one.
  const closeProject = () => navigate("/");
  const browseProjects = projectHomeFolderId() ? () => navigate("/projects") : null;
  const [openTabs, setOpenTabs] = useState([]);   // sheetKeys open as tabs across the top
  const [galleryLabels, setGalleryLabels] = useState({}); // sheetKey → title-block number, all files
  const [pageLabels, setPageLabels] = useState({}); // { pageNum: "A003" } from the title block
  const [sheetGroup, setSheetGroup] = useState([]);   // sheetKeys shown side-by-side; [] = single-sheet mode
  const [sheetLevels, setSheetLevels] = useState({}); // sheetKey → level label ("L1") — persisted (additive `sheet_levels` key); groups the gallery for multi-floor sets
  const [lastGroup, setLastGroup] = useState([]);     // most recent side-by-side composition — "Regroup" restores it
  const [focusKey, setFocusKey] = useState("");         // panel of the last click — scale/calibrate target in group mode
  const [zoneCheck, setZoneCheck] = useState(null);   // ephemeral zone-check region {key, pts (norm)} — never persisted (buildPayload doesn't read it)
  const [zoneExpand, setZoneExpand] = useState(null); // zone panel: condition id with materials expanded
  // Shared reset for the two zone transients — every site that discards
  // OTHER in-flight measurement state (sheet change, snapshot load, hydrate)
  // must discard this too, or the results panel and glow can outlive the
  // region/shapes they described. See the tool-change effect below for the
  // matching `poly` (pending zone trace) reset, which has its own rule.
  const resetZone = () => { setZoneCheck(null); setZoneExpand(null); };
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
  // App chrome theme (light/dark tokens) — independent of the canvas ☾ invert
  // above. lib/theme.js owns the DOM; this state just keeps the glyph current.
  const [theme, setTheme] = useState(getTheme);
  useEffect(() => onThemeChange(setTheme), []);
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
  // Display unit system (ft/m toggle beside the scale picker) — DISPLAY LAYER
  // ONLY: all stored takeoff math stays feet (lib/units contract), so toggling
  // never rewrites a shape, a scale, or a coverage rate. Browser default via
  // localStorage; a project that saved a units field overrides on hydrate.
  const [units, setUnits] = useState(() => { try { return localStorage.getItem("opentakeoff_units") === "metric" ? "metric" : "imperial"; } catch { return "imperial"; } });
  useEffect(() => { try { localStorage.setItem("opentakeoff_units", units); } catch { /* private mode */ } }, [units]);
  const [check, setCheck] = useState([]);             // Check tool: 0–2 stage-px points along a printed dimension
  const [checkStated, setCheckStated] = useState(""); // what the drawing says that dimension is
  const [scaleGuide, setScaleGuide] = useState(null); // ephemeral calibrated ruler {key, feet, px, label, at:[x,y]} — never persisted (buildPayload doesn't read it)
  const scaleGuideTimerRef = useRef(0);
  const scaleGuidePreviewRef = useRef(false); // true while the visible guide is a hover PREVIEW of an unaccepted scale — the preview must die with the hover/menu; an accepted bar stays
  // One-slot revert stash: the scale a quantity-changing rescale replaced
  // ({key, upp, source}). An oops-hatch, not an undo history — ephemeral by
  // design (never persisted): a mistyped recalibrate is caught within a menu
  // click, not archaeologically.
  const [prevScale, setPrevScale] = useState(null);

  const [conditions, setConditions] = useState([]);
  const [conditionColumns, setConditionColumns] = useState([]);  // project-level custom-column vocabulary [{ id, name, values }] — assignments live on c.attrs
  const [shapeLabels, setShapeLabels] = useState([]);  // project-level flat vocabulary of phase/area labels (#110) — assignment lives on shape.label
  const [activeCond, setActiveCond] = useState("");
  const [activeLabel, setActiveLabel] = useState(null);   // session-only active phase/area label (#111) — new traces get it; NOT persisted (absent from buildPayload, reset on hydrate)
  const [palette, setPalette] = useState([]);   // ordered condition ids pinned to the top-bar quick-access palette (≤ PALETTE_MAX)
  const [shapes, setShapes] = useState([]);
  const [poly, setPoly] = useState([]);
  const [proposal, setProposal] = useState(null);  // One-Click selection under review: { key, regions: [{kind:'pos'|'neg', seed, poly, area_sf, perim_lf}] } — panel-LOCAL px
  // ── in-canvas takeoff agent state ──────────────────────────────────────────
  // agentProposals are NOT shapes: committed truth stays committed. Each entry
  // {id, sheet_id, condition_id, measure_role, verts_norm, evidence, seed_norm?,
  //  proposed_ts, area_sf, perim_lf} renders as a DASHED pencil outline until
  // the human accepts (→ dispatchShape add with agent_v1 origin) or rejects
  // (→ dropped LOCALLY — dismissed geometry never rides the contribution wire).
  // Ephemeral by design: never persisted (buildPayload doesn't read them).
  const [agentProposals, setAgentProposals] = useState([]);
  const [agentOpen, setAgentOpen] = useState(false);      // docked right-rail Agent panel
  const [agentLog, setAgentLog] = useState([]);           // streaming run status [{kind, text}]
  const [agentRunning, setAgentRunning] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false); // BYO-key config modal (ai.js seam)
  const agentAbortRef = useRef(null);                     // live AbortController while a run is in flight
  // Live mirror of the render-scope state the agent's capability closures read:
  // the loop runs across many awaits, so closures must read CURRENT state, not
  // the run-click render's. Updated every render (cheap object build).
  const agentStateRef = useRef({ panels: [], scales: {}, scaleSources: {}, detectedScales: {}, conditions: [], status: "loading" });
  useEffect(() => () => agentAbortRef.current?.abort(), []);   // leaving the canvas stops a live agent run
  const [ocSel, setOcSel] = useState(null);        // selected proposal vertex {ri, vi} — Delete removes just that point
  const [ocHover, setOcHover] = useState(-1);      // proposal region under the cursor — handles reveal on hover
  const [selectedId, setSelectedId] = useState(null);   // selected shape (Select tool)
  const [selVert, setSelVert] = useState(null);         // selected vertex index of the selected shape — Delete removes just that point
  const [selectedMarkupId, setSelectedMarkupId] = useState(null); // selected markup — mutually exclusive with selectedId
  const [rfis, setRfis] = useState([]);                 // RFI register (Request For Information); linked to markups via markup.rfi_id === rfi.id
  // Deletion provenance: shapes leave no record once filtered out of `shapes`,
  // so every delete COMMAND yields a per-origin-method tally (`counted`, keyed
  // by origin.method, "manual" when absent) that dispatchShape merges here.
  // Serialized as provenance_counters — omit-when-empty — so the corpus can
  // see how much machine output was thrown away, not only what survived.
  const [provCounters, setProvCounters] = useState({ shapes_deleted: {} });
  const countDeleted = (tally) => {
    const keys = Object.keys(tally);
    if (!keys.length) return;
    setProvCounters((pc) => {
      const sd = { ...pc.shapes_deleted };
      for (const k of keys) sd[k] = (sd[k] || 0) + tally[k];
      return { ...pc, shapes_deleted: sd };
    });
  };
  // ── the shape-command chokepoint ──────────────────────────────────────────
  // EVERY meaningful `shapes` mutation dispatches a command; the pure apply
  // (lib/shapeCommands.js) owns the provenance policy, this wrapper owns the
  // React side: setShapes the result, merge the deletion tally, and keep the
  // undo/redo stacks. Stacks live in refs (no render on push); applied against
  // the render's `shapes`, which a discrete event always sees current (the
  // undoLast precedent) — NEVER inside a setShapes updater (updaters can
  // double-run; counting/recording there would double-tally).
  //   record: false — apply + count but keep it off the undo stack (the
  //     condition-cascade deletes: their confirm says "can't be undone", and
  //     undoing the shapes without the condition would resurrect orphans);
  //   reset: true — clear BOTH stacks (hydrate / revision restore / rescale:
  //     a restored timeline starts fresh, and a rescale invalidates every
  //     `computed` the recorded commands froze).
  const undoStackRef = useRef([]);   // [{ cmd, inverse }]
  const redoStackRef = useRef([]);
  function dispatchShape(cmd, { record = true, reset = false } = {}) {
    const res = applyShapeCommand(shapes, cmd);
    setShapes(res.shapes);
    if (res.counted) countDeleted(res.counted);
    if (reset) { undoStackRef.current = []; redoStackRef.current = []; }
    else if (record && res.inverse) {
      const st = recordCommand(undoStackRef.current, { cmd, inverse: res.inverse });
      undoStackRef.current = st.undo;
      redoStackRef.current = st.redo;   // a new command discards the redone future
    }
    return res;
  }
  // ⌘Z / ⇧⌘Z — apply the recorded inverse (undo) or the exact-restore command
  // (redo). Undoing swaps the entry's cmd for the inverse-of-the-undo before
  // it lands on the redo stack: that command restores the undone state
  // VERBATIM (same ids, same created_at, same stamped updated_at, same array
  // indices) — replaying the ORIGINAL command would re-mint/re-stamp. Neither
  // direction feeds the deletion counters: undo's inverses are structurally
  // count-free (an add's inverse delete rides noCount, a delete's inverse is
  // a restore-add), so a delete is tallied exactly once, at first dispatch —
  // undo never decrements, redo never re-counts.
  function undoShapeCommand() {
    const entry = undoStackRef.current[undoStackRef.current.length - 1];
    if (!entry) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    const res = applyShapeCommand(shapes, entry.inverse);
    setShapes(res.shapes);
    redoStackRef.current = [...redoStackRef.current, { cmd: res.inverse, inverse: entry.inverse }];
    setSelVert(null);   // vertex counts may have changed — a stale index must not aim the next ⌫
  }
  function redoShapeCommand() {
    const entry = redoStackRef.current[redoStackRef.current.length - 1];
    if (!entry) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    const res = applyShapeCommand(shapes, entry.cmd);
    setShapes(res.shapes);
    undoStackRef.current = [...undoStackRef.current, { cmd: entry.cmd, inverse: res.inverse }];
    setSelVert(null);   // same stale-index guard as undo
  }
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
  const [loadError, setLoadError] = useState("");   // annotations load failed — autosave stays disarmed
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
  const [showRevisions, setShowRevisions] = useState(false); // Revisions overlay (save / compare any two, buy-list deltas, CSV, auto-banked restore)
  const [importRows, setImportRows] = useState(null);        // Import-from-schedule approval rows (null = dialog closed)
  const [scheduleAnchor, setScheduleAnchor] = useState(null); // first marquee corner for the "schedule" tool — ISOLATED from poly so it can never leak into a measure shape
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
  const detailWatchdogRef = useRef(0);       // recovers a render stuck by a backgrounded/throttled tab (see DETAIL_STALL_MS)
  const renderTasksRef = useRef(new Map());  // sheetKey → pdf.js RenderTask
  const pdfDocsRef = useRef(new Map());      // file name → pdf.js loading task (doc cache)
  const renderSeqRef = useRef(0);            // monotonic token — stale render chains bail out
  const scanBusyRef = useRef(false);         // a paid schedule OCR read is in flight — blocks re-fire from a rapid re-draw
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const crossVRef = useRef(null);
  const crossHRef = useRef(null);
  const rubberRef = useRef(null);
  const rectRef = useRef(null);
  const cloudRef = useRef(null);       // live cloud preview (first corner → cursor)
  const highlightRef = useRef(null);   // live highlight-box preview (first corner → cursor; own translucent fill, NOT rectRef's condition fill)
  const hlRef = useRef(null);          // in-progress highlighter stroke {pts (stage px), key}
  const hlPathRef = useRef(null);      // live highlighter preview path (imperative, WYSIWYG ink)
  const [hlStyle, setHlStyle] = useState(() => {
    try { return { color: HL_INKS[0], size: 14, tip: "chisel", ...JSON.parse(localStorage.getItem("opentakeoff_hl_style") || "{}") }; }
    catch { return { color: HL_INKS[0], size: 14, tip: "chisel" }; }
  });
  useEffect(() => { try { localStorage.setItem("opentakeoff_hl_style", JSON.stringify(hlStyle)); } catch { /* private mode */ } }, [hlStyle]);
  const snapRef = useRef(null);        // current snapped image point (or null)
  const snapGridsRef = useRef(new Map()); // sheetKey → {cell, map} spatial hash of vector endpoints
  const vectorSegsRef = useRef(new Map()); // sheetKey → flat [x1,y1,x2,y2,…] linework segments (One-Click boundary source)
  const segMetaRef = useRef(new Map());    // sheetKey → per-segment meta bytes (hatch classification input)
  const maskCacheRef = useRef(new Map());  // sheetKey → built boundary mask (lazy, dropped on re-render)
  const sheetStatsRef = useRef(new Map()); // sheetKey → {segCount, imageFrac} — raster-fallback trigger signals
  const rasterMaskCacheRef = useRef(new Map()); // sheetKey → Promise<MaskObj|null> — scan-pixel mask (lazy, shared across clicks)
  const snapMarkRef = useRef(null);    // SVG snap indicator
  const angleRef = useRef(null);       // current angle-locked image point (or null) — the click commits it
  const aimMarkRef = useRef(null);     // four floating liquid-glass pickets thickening the crosshair crossing
  const aimChipRef = useRef(null);     // readout chip by the cursor (locked angle · live segment length)
  const dragRef = useRef(null);        // {kind:'move'|'vertex'|'edge'|'markupMove', shapeId?/markupId?, vIndex?, start:[x,y], orig:verts_norm/markup coords, moved?, prev: grab-time geomSnapshot (shape drags), shape: grab-time shape, lastVerts/lastComputed: latest preview frame — the release commit's geom command payload}
  const ocDragRef = useRef(null);      // One-Click proposal edit drag: {kind:'oc-vertex'|'oc-edge', ri, vi?/i?/j?, oa?, ob?, sx?, sy?} — poly is panel-LOCAL px
  const ocHoverRef = useRef(-1);       // mirror of ocHover (region index under cursor) — compared per-move to avoid stale-closure churn
  const editingRef = useRef(false);    // true while the inline text editor is open — read in moveCrosshair/onPointerDown/wheel (a REF, never per-mousemove state) to suppress the crosshair and freeze pan/zoom
  const editorRef = useRef(null);      // mirror of the open editor object, so finishEditor can commit without a stale-closure race
  const editorInputRef = useRef(null); // the live <input> element (uncontrolled — value read on commit)
  const lastPtrRef = useRef(null);     // last pointer CLIENT coords — paste targets the sheet under the cursor
  const pendingClickRef = useRef(null); // deferred draw click {p,cx,cy} — drag >5px converts to a pan
  const hoverRef = useRef(null);        // hover tooltip div (DOM-direct like the crosshair)
  const hoverIdRef = useRef("");        // shape id currently described by the tooltip
  const lastMeasureRef = useRef("area"); // last armed measure tool — shown on the Measure menu face
  const prevToolRef = useRef("pan");   // previous armed tool — detects a LEAVE-zone transition so the shared `poly` array only clears when zone itself was left, not on every tool change
  const menuDepthRef = useRef(0);      // >0 while a toolbar menu is open (letter shortcuts pause)
  // ONE stable open/close listener for every toolbar menu — ToolMenu re-fires
  // its onOpenChange effect when the callback identity changes, so an inline
  // arrow here would re-count an open menu on every canvas render
  const onMenuDepth = useCallback((o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }, []);
  const thumbCacheRef = useRef(new Map()); // sheetKey → thumbnail dataURL — survives gallery close
  const legacyPinnedRef = useRef(null);    // old `pinned` page numbers awaiting their one-shot tab migration
  const tabInitRef = useRef(false);        // snap to the first restored tab exactly once
  const statusRef = useRef("loading");     // mirror for the gallery's thumbnail worker
  const viewRef = useRef("canvas");        // mirror for the keyboard handlers
  // live mirrors of tool/proposal — oneClickAt is an async function whose
  // closure over `tool`/`proposal` goes stale across an `await` (the user can
  // switch tools or start a proposal on another panel while a raster render is
  // in flight); the post-await guards below read these refs, never the
  // closed-over state, so a slow raster resolve can't act on a world that has
  // since moved on.
  const toolRef = useRef(tool);
  const proposalRef = useRef(proposal);
  const hydrated = useRef(false);
  // Autosave stays holstered until a user-originated edit. hydrate() flips every
  // autosave dep to a fresh identity, so the effect fires once on the post-load
  // render with no edit behind it; that lone run arms this and returns instead of
  // writing — otherwise merely opening a shared ?project= link would CREATE
  // annotations.json in the folder (see #68). Error paths that skip hydrate
  // leave BOTH hydrated and this disarmed: the in-memory state is empty there,
  // so arming would let the first edit overwrite the intact saved takeoff with
  // nothing (the loadError banner explains). A revision Restore reuses hydrate() too, but
  // mid-session it runs with this already armed, so a restore saves — unchanged
  // by this fix. (Restoring on a canvas whose mount load FAILED stays disarmed
  // and is not persisted — the #73 gap, which persists on the LEGACY cloud path.
  // On the opted-in local-first path #73 is RETIRED: loadAnnotations returns local
  // and never throws, so the mount always hydrates + arms, and a restore's setStates
  // re-fire this effect with saves armed → the restored payload persists + pushes.)
  const savesArmed = useRef(false);
  // One-shot suppression for a background reconcile (Slice 5). A remote adopt (mount
  // seed / 4c conflict resolution) re-hydrates via onRemoteUpdate mid-session, when
  // saves are already armed — that hydrate would otherwise re-fire the autosave
  // effect and push the just-adopted content back at synced_rev+1 (rev churn on a
  // seed; a spurious conflict + loser-snapshot on an adopt). Set true right before
  // the reconcile hydrate; the autosave effect swallows exactly the next run.
  // INVARIANT (load-bearing): hydrate() must dirty ≥1 autosave dep so this flag is
  // consumed on the very next commit and can't leak into a later REAL edit (it always
  // does — setConditions/setShapes/setClientInfo mint fresh values unconditionally).
  // And hydrate must not spawn a SECOND autosave-triggering commit that outlives the
  // flag — normalizeLoadedGroups keeps the lastGroup-sync effect a no-op for exactly
  // that reason. A future "skip setState if unchanged" optimization on either would
  // reopen an escape; keep both guarantees.
  const suppressNextSave = useRef(false);
  const tfRef = useRef({ x: 0, y: 0, scale: 1 });
  const syncRaf = useRef(0);
  const lastSyncRef = useRef(0);       // last tf mirror sync (perf.now) — scheduleSync throttles against it
  const lastSyncedScaleRef = useRef(1); // scale last written into `tf` — scheduleSync skips a translate-only pan tick when this is unchanged
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
    const lvl = sheetLevels[k] ? `${sheetLevels[k]} · ` : "";   // assigned floor/level rides every tab label
    if (galleryLabels[k]) return lvl + galleryLabels[k];
    const t = parseSheetKey(k);
    if (t.file === active && pageLabels[t.page]) return lvl + pageLabels[t.page];
    const base = t.file.replace(/\.pdf$/i, "");
    return lvl + (t.page > 1 ? `${base} · ${t.page}` : base);
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
  // Pure panel-row math (stage extent, nearest-panel routing, the px→feet
  // scale factors) lives in lib/panelGeometry.js; these thin wrappers bind the
  // live panels/scales so every call site below reads unchanged.
  const stage = panelGeom.stageExtent(panels);
  const panelByKey = (k) => panelGeom.panelByKey(panels, k);
  const panelAt = (sx) => panelGeom.panelAt(panels, sx);
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
  const visibleMarkups = useMemo(() => {
    const keys = new Set(sheetGroup.length ? sheetGroup : [sheetKey]);
    return markups.filter((m) => keys.has(m.sheet_id));
  }, [markups, sheetGroup, sheetKey]);
  // scale is PER PAGE (plan sets are never one uniform scale) — set it once per
  // sheet and it's remembered. In group mode the scale dropdown and hints target
  // the FOCUSED panel (the one last clicked); single mode focuses the lone panel.
  const focusPanel = (focusKey && groupKeys.includes(focusKey) && panelByKey(focusKey)) || panels[0];
  const unitsPerPx = scales[focusPanel.key] ?? null;
  const labelFor = (p) => (p.file === active && pageLabels[p.page]) || (p.page > 1 ? `Sheet ${p.page}` : p.file);
  // Scale semantics (why geometry divides by factorFor and calibration
  // multiplies back to baseline) are documented on the pure functions in
  // lib/panelGeometry.js; these wrappers bind the live scales/renderScalesRef.
  const hiResOn = (key) => hiResKeys.includes(key);
  const factorFor = (key) => panelGeom.factorFor(renderScalesRef.current, key);
  const uppFor = (key) => panelGeom.uppFor(scales, renderScalesRef.current, key);
  // keep the agent's capability closures reading LIVE state across their awaits
  useEffect(() => {
    agentStateRef.current = { panels, scales, scaleSources, detectedScales, conditions, status };
  });
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
      const t = tfRef.current;
      // Nothing in the render tree reads tf.x/tf.y — position lives entirely in
      // the CSS transform above. A pure pan (scale unchanged) only needs this
      // mirror when the detail view is engaged (it re-crops from tf on every
      // tick); below DETAIL_ENGAGE it's hidden and reads nothing. Skipping the
      // state write there avoids re-rendering the whole shape/markup overlay
      // (thousands of SVG els at overview zoom) on every ~90ms pan tick — that
      // wasted reconciliation was the zoomed-out pan flicker + toolbar lag.
      if (t.scale === lastSyncedScaleRef.current && t.scale * (window.devicePixelRatio || 1) <= DETAIL_ENGAGE) return;
      lastSyncedScaleRef.current = t.scale;
      setTf({ ...t });
    }, wait);
  }, []);
  const setTfNow = useCallback((next) => { tfRef.current = next; applyTf(); setTf({ ...next }); }, [applyTf]);

  // ── local PDFs (dropped into this browser) ─────────────────────────────────
  const refreshSheets = useCallback(async () => {
    const list = await store.listSheets();
    setSheets(list);
    return list;
  }, []);
  // Stable props for the Drive picker so its folder-load effect doesn't re-fire
  // (and re-hit Drive) on every canvas re-render. `store` is a module binding
  // read at call time, so [] deps are correct.
  const pickerListFolder = useCallback((id) => store.listFolder(id), []);
  const pickerAddSheets = useCallback((items) => store.addSheets(items), []);
  // Reconcile the canvas after a PDF leaves the working set. For a non-empty
  // result the [sheets] effect already prunes openTabs/sheetGroup, but it can't:
  //   • fix `active` when the CLOSED pdf was the one on screen (it never resets
  //     itself), so move to a surviving sheet; and
  //   • prune anything when the set is now EMPTY — that effect early-returns on
  //     `!sheets.length` (it must, to protect restored tabs during load), so the
  //     last-pdf close would otherwise strand a tab pointing at a deleted file.
  const reconcileAfterRemoval = useCallback((name, list) => {
    if (!list.length) {
      setOpenTabs([]); setSheetGroup([]); setLastGroup([]); setActive(""); setPage(1);
      setView("gallery");
      return;
    }
    if (name === active) { setActive(list[0].name); setPage(1); setSheetGroup([]); }
  }, [active]);
  // Close a PDF: drop it from the working set (cloud: manifest only, file stays
  // in Drive; local: deletes the stored bytes), refresh, then reconcile the view.
  // Shapes on the closed sheets persist in annotations and restore on re-add.
  const closePdf = useCallback(async (name) => {
    await store.removePdf(name);
    reconcileAfterRemoval(name, await refreshSheets());
  }, [refreshSheets, reconcileAfterRemoval]);
  // Remove-from-project (cloud only): the DESTRUCTIVE variant — delete the Drive
  // file, then drop it from the working set.
  const removeFromProject = useCallback(async (name) => {
    if (typeof store.removeFromProject !== "function") return;
    await store.removeFromProject(name);
    reconcileAfterRemoval(name, await refreshSheets());
  }, [refreshSheets, reconcileAfterRemoval]);
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
  // The empty-project landing view (the Drive picker for an empty cloud project,
  // else the gallery) depends on BOTH the sheet list and the annotations (open
  // tabs), which load in two racing mount effects. These flags let whichever
  // finishes LAST make the call exactly once — so the picker never flashes for a
  // project that actually has sheets, and no redundant Drive listing fires.
  const hasSheetsRef = useRef(false);
  const sheetsLoadedRef = useRef(false);
  const noTabsRef = useRef(false);
  useEffect(() => {
    let off = false;
    setStatus("loading");
    store.listSheets()
      .then((list) => {
        if (off) return;
        hasSheetsRef.current = list.length > 0;
        sheetsLoadedRef.current = true;
        setSheets(list);
        if (list.length) setActive(list[0].name);
        else setStatus("empty");
        // decide the landing only once the annotations effect has also reported
        // no open tabs (see hydrate) — avoids a picker→gallery flash + wasted list
        if (noTabsRef.current) setView(cloudMode && !hasSheetsRef.current ? "picker" : "gallery");
      })
      .catch((e) => !off && (setErr(String(e.message || e)), setStatus("error")));
    return () => { off = true; };
  }, [cloudMode]);
  // Keep hasSheetsRef current so a later re-hydration (a revision Restore after the
  // working set changed) reads the LIVE sheet count, not the mount-time value.
  // The mount sheets effect above also sets it synchronously for the initial
  // landing decision (before this post-render effect runs).
  useEffect(() => { hasSheetsRef.current = sheets.length > 0; }, [sheets]);

  // ── load saved annotations once per project ───────────────────────────────
  // hydrate applies a saved payload to state — shared by the mount load and by
  // Restore in the Revisions panel, so a restored revision walks the same
  // defensive path as a page reload.
  const hydrate = (a) => {
    // Same cross-load-transient gap as the panel epoch bump below: a revision
    // Restore runs in-place with the same sheet keys, so a surviving zoneCheck
    // would immediately re-classify the RESTORED shape set against the
    // pre-load polygon — "correct" math against the wrong region. Reset it
    // unconditionally, mirroring the sheet_group/sheet_levels else-clear rule.
    resetZone();
    // agent proposals are ephemeral review state aimed at the PRE-load
    // conditions/sheets — a loaded/restored timeline starts with none pending
    // (nothing is lost: rejected geometry records nothing by design).
    setAgentProposals([]);
    setProjectName(a.project_name || "");
    // string fields only — a corrupted record must not put an object where
    // the report masthead renders a React child
    setClientInfo(Object.fromEntries(Object.entries(
      a.client_info && typeof a.client_info === "object" && !Array.isArray(a.client_info) ? a.client_info : {}
    ).filter(([, v]) => typeof v === "string")));
    setConditionColumns(sanitizeConditionColumns(a.condition_columns));   // non-array/malformed → [] (unconditional set: snapshot load must not inherit pre-load columns)
    setShapeLabels(sanitizeShapeLabels(a.shape_labels));   // same unconditional-set rule: a snapshot load must not inherit the replaced project's label vocabulary
    setActiveLabel(null);   // active label is session-only — never carry one from the replaced project into a fresh/loaded one
    const conds = sanitizeConditionAttrs(a.conditions || []);   // strips corrupt attrs values so every reader can trust them (the client_info precedent)
    if (conds.length) { setConditions(conds); setActiveCond(conds[0].id); }
    else { const seeded = seedConditions(templatesRef.current); setConditions(seeded); setActiveCond(seeded[0].id); }   // library templates first, flooring defaults as fallback
    // palette holds condition ids — de-dupe (a hand-edited/older payload could
    // repeat one, which would collide React keys and double-map a hotkey), drop
    // any that don't resolve in the loaded set, and cap defensively; a seeded
    // fresh workspace starts with an empty palette
    setPalette(Array.isArray(a.palette) && conds.length ? [...new Set(a.palette)].filter((id) => conds.some((c) => c.id === id)).slice(0, PALETTE_MAX) : []);
    // panel transients reset with the conditions they described — a snapshot
    // Load must not keep a checked set / range anchor / filter / collapsed
    // groups aimed at the PRE-load list (bulk edits would misfire on ids that
    // happen to survive). That state lives in the TakeoffsPanel now: bump its
    // epoch and it clears them in place (panel tab + width survive, as they
    // always did). On the mount load this is a no-op (fresh panel state).
    setPanelEpoch((e) => e + 1);
    // `replace` command + reset: hydrate is a whole-array non-edit (no stamps,
    // no counters) and a loaded/restored timeline starts with EMPTY undo/redo
    // stacks — recorded inverses from the replaced project must never fire here.
    dispatchShape({ type: "replace", shapes: sanitizeShapeLabelsOnShapes(a.shapes || []) }, { reset: true });   // strip a corrupt shape.label at hydrate (identity-preserving); other shape fields untouched
    // normalize hydrated markups: legacy workspaces may hold markups with no id
    // (pre-dating the id field) — seed a stable id + default rfi_id so the new
    // select / edit / delete / move / RFI-link flows (all keyed on m.id) work on them.
    setMarkups(Array.isArray(a.markups) ? a.markups.map((m) => ({ ...m, id: m.id || uid("mk"), rfi_id: m.rfi_id || "" })) : []);
    setRfis(Array.isArray(a.rfis) ? a.rfis : []);   // additive — old saves without rfis load as []
    // additive provenance_counters — unconditional set (the else-clear rule: a
    // snapshot load must not inherit the replaced project's deletion tallies).
    // Object gate mirrors client_info; number filter keeps the counts trustable.
    const pcIn = a.provenance_counters?.shapes_deleted;
    setProvCounters({ shapes_deleted: Object.fromEntries(Object.entries(
      pcIn && typeof pcIn === "object" && !Array.isArray(pcIn) ? pcIn : {}
    ).filter(([, v]) => Number.isFinite(v) && v > 0)) });
    // additive `sheet_levels` key (multi-floor gallery grouping) — old payloads
    // lack it and must clear any pre-load levels (the sheet_group else-clear
    // rule: a snapshot load must not inherit the replaced project's levels).
    // String labels only, mirroring the client_info string-fields gate.
    // Extracted to sanitizeSheetLevels (lib/sheetLevels.js) so this gate has
    // its own unit tests independent of the reducer.
    setSheetLevels(sanitizeSheetLevels(a.sheet_levels));
    // else-clear matters at runtime (snapshot load): a payload without groups/
    // tabs must not inherit the pre-load ones — autosave would persist a hybrid.
    // In group mode sheetGroup + lastGroup share ONE instance so the lastGroup-sync
    // effect below is a reference-equal no-op — otherwise its follow-up commit would
    // escape the one-shot save suppression and spuriously re-save (see normalizeLoadedGroups).
    const { sheetGroup: grp, lastGroup: lgFinal } = normalizeLoadedGroups(a, MAX_GROUP);
    setSheetGroup(grp);
    setLastGroup(lgFinal);
    // gallery-first: tabs restore directly; legacy pinned pages migrate once
    // (over in the sheets effect, where file names are known); nothing open → gallery
    const tabs = Array.isArray(a.sheet_tabs) ? a.sheet_tabs : [];
    noTabsRef.current = false;   // accurate on every (re)hydrate; the no-tabs branch flips it true
    if (tabs.length) setOpenTabs(tabs);
    else if (Array.isArray(a.pinned) && a.pinned.length) legacyPinnedRef.current = a.pinned;
    // no tabs → the sheet chooser. Defer the picker-vs-gallery choice until the
    // sheets effect has loaded the working set (coordinated via the refs) so an
    // empty cloud project lands on the Drive picker without flashing the gallery.
    else {
      setOpenTabs([]);
      noTabsRef.current = true;
      if (sheetsLoadedRef.current) setView(cloudMode && !hasSheetsRef.current ? "picker" : "gallery");
    }
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
    // display units ride the payload (additive) — a metric project opens metric
    // on any machine; payloads without the field keep this browser's toggle
    if (a.units === "metric" || a.units === "imperial") setUnits(a.units);
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
      // Cloud project whose saved takeoff couldn't be read (Drive error / unreadable
      // annotations): same rule as a stale tab — leave autosave DISARMED so empty
      // defaults can't overwrite the real project in Drive. (cloudStore tags these.)
      if (e?.name === "CloudLoadError") { setCommitMsg(e.message || "Couldn't load this project from Drive — reload to retry."); return; }
      // Do NOT arm autosave on any other failed load either: the in-memory
      // state is empty, so the first edit would overwrite the intact saved
      // takeoff with nothing. Leave it disarmed (hydrated stays false) and say
      // so in a banner — a reload retries the read.
      setLoadError(String((e && e.message) || e || "unknown error"));
    });
    return () => { off = true; };
    // run-once mount load — hydrate is intentionally not a dep (re-running would
    // re-hydrate over live edits); the cloudMode/ref it now reads are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A One-Click proposal is only actionable while One-Click is armed (Enter
  // already requires it) — discard it on tool switch, like the stamp above.
  // Also keeps Create out of the ACTION slot while Finish occupies it, so the
  // slot's reserved width always fits its content (issue #61).
  useEffect(() => { if (tool !== "oneclick") setProposal(null); }, [tool]);
  // Proposal gone (created, discarded, sheet changed) ⇒ drop any handle selection/hover.
  useEffect(() => { if (!proposal) { setOcSel(null); ocHoverRef.current = -1; setOcHover(-1); } }, [proposal]);
  // Switching to a different shape (or clearing the selection) drops the vertex pick.
  useEffect(() => { setSelVert(null); }, [selectedId]);

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
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { proposalRef.current = proposal; }, [proposal]);

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
    setStatus("rendering"); setErr(""); setPoly([]); setCalib([]); setPendingLen(""); setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null); selectShape(null); setProposal(null); resetZone();
    for (const [, rt] of renderTasksRef.current) { try { rt.cancel(); } catch { /* done */ } }
    renderTasksRef.current.clear();
    snapGridsRef.current.clear();
    vectorSegsRef.current.clear();
    segMetaRef.current.clear();
    maskCacheRef.current.clear();
    sheetStatsRef.current.clear();
    rasterMaskCacheRef.current.clear();
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
          const { points, segs, meta, imageArea } = extractVectorGeometry(ol, m.viewport.transform, pdfjsLib.OPS);
          snapGridsRef.current.set(m.key, buildSnapGrid(points, SNAP_CELL));
          vectorSegsRef.current.set(m.key, segs);
          segMetaRef.current.set(m.key, meta);
          // raster-fallback trigger signals: how much of the sheet is placed
          // image, and whether the vector linework is dense enough to bound rooms
          sheetStatsRef.current.set(m.key, { segCount: segs.length >> 2, imageFrac: Math.min(1, imageArea / (m.w * m.h)) });
        }).catch(() => {
          if (stale()) return;
          // A rejected op-list (corrupt embedded JBIG2/CCITT — exactly the class of
          // scanned PDFs this feature serves) must not leave stats permanently
          // unset: with no sentinel, rasterEligible and vectorViable both read
          // false forever and oneClickAt is stuck on the vector branch showing
          // "try again in a second" for the sheet's whole lifetime. A sentinel that
          // reads as image-dominant/segment-empty lets the raster fallback engage
          // instead (rasterEligible true, vectorViable false).
          sheetStatsRef.current.set(m.key, { segCount: 0, imageFrac: 1 });
        });
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
    // cleanup MUST read the LIVE refs, not a mount-time copy: bumping the current
    // renderSeqRef invalidates in-flight renders, and cancelling the current
    // renderTasksRef set is the whole point. Copying to a variable (the rule's
    // suggestion) would cancel the stale mount-time set and leak the live one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    clearTimeout(detailWatchdogRef.current);
    const rt = pageObj.render({ canvasContext: back.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor] });
    detailTaskRef.current = rt;
    // Backstop watchdog — NOT the primary fix (that's the visibilitychange retry
    // below, which targets the actual documented cause). This only covers some
    // OTHER wedge with no visibility signal, so it deliberately skips firing while
    // still hidden (retrying then would just wedge the same way) and is tuned long
    // enough to never race a merely slow render.
    detailWatchdogRef.current = setTimeout(() => {
      if (detailTaskRef.current !== rt) return;              // already superseded — nothing to recover
      if (document.visibilityState !== "visible") return;    // still hidden — visibilitychange will recover it on return
      if (detailKeyRef.current === renderKey) detailKeyRef.current = "";   // let the next tick retry this crop
      if (window.__OT_DETAIL_DEBUG) console.log("[detail] stalled, retrying", renderKey);
      scheduleSync();
    }, DETAIL_STALL_MS);
    rt.promise.then(() => {
      clearTimeout(detailWatchdogRef.current);
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
      clearTimeout(detailWatchdogRef.current);
      if (detailKeyRef.current === renderKey) detailKeyRef.current = "";   // let the next tick retry this crop
      if (e?.name !== "RenderingCancelledException") console.error("[detail] render failed:", e);
    });
    // panelW/takeoffsOpen: docking or resizing the Takeoffs panel changes the
    // container rect without a transform change — re-run so the crop resyncs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, groupSig, status, focusKey, panelW, takeoffsOpen]);

  // Primary recovery for the detail-view stall: a hidden tab can suspend pdf.js's
  // render scheduling indefinitely (the promise above neither resolves nor rejects,
  // no console error — Chrome throttles rAF-gated work in hidden tabs). Retrying the
  // moment the tab is foregrounded again is immediate and, unlike a blind timeout,
  // never fights a render that's just legitimately slow while visible.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !detailKeyRef.current) return;
      detailKeyRef.current = "";   // let the next tick re-request the pending crop
      scheduleSync();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scheduleSync]);

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
  const buildPayload = () => {
    // palette holds condition ids; drop any that no longer resolve (defensive —
    // delete already prunes) and omit the key entirely when nothing survives,
    // mirroring the condition_columns omit-when-empty convention.
    const pinned = palette.filter((id) => conditions.some((c) => c.id === id));
    // units is additive and diff-only (the sheet_levels convention): imperial —
    // the default — omits the key, so an old imperial project's payload is
    // byte-identical on round-trip; only a metric project carries the field.
    return { project_name: projectName, ...(units === "metric" ? { units } : {}), ...(Object.values(clientInfo).some((v) => v && String(v).trim()) ? { client_info: clientInfo } : {}), sheets: Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, ...(scaleSources[sheet_id] ? { scale_source: scaleSources[sheet_id] } : {}) })), conditions, ...(conditionColumns.length ? { condition_columns: conditionColumns } : {}), ...(shapeLabels.length ? { shape_labels: shapeLabels } : {}), ...(pinned.length ? { palette: pinned } : {}), shapes, markups, rfis, sheet_group: sheetGroup, last_group: lastGroup, sheet_tabs: openTabs, ...(Object.keys(sheetLevels).length ? { sheet_levels: sheetLevels } : {}), ...(Object.keys(provCounters.shapes_deleted).length ? { provenance_counters: provCounters } : {}) };
  };
  // Runtime restore of a saved payload — the Revisions panel's Restore lands
  // here. A runtime load (unlike mount) can interrupt work in
  // flight: an unfinished trace/calibration/proposal must not commit into the
  // restored takeoff under a reset activeCond. The check tool and the rescale
  // stash are in that class too — a surviving prevScale would let "Revert
  // scale" re-price the RESTORED takeoff against a scale stashed from the
  // discarded timeline. Zone is in the same class: a surviving zoneCheck would
  // re-classify the RESTORED shape set against the pre-load polygon (hydrate()
  // also resets it, but this caller-side reset covers the pending in-progress
  // trace too). Mid-session, savesArmed is already true, so hydrate's setStates
  // re-fire the autosave effect and the restored payload persists (and pushes,
  // on the sync path) like any other edit.
  const restoreSavedPayload = (payload) => {
    setPoly([]); setCalib([]); setPendingLen(""); selectShape(null); setProposal(null);
    setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null);
    resetZone();
    hydrate(payload || {});
  };

  // markups MUST be in the deps (a cloud/callout/text or an RFI link is real work);
  // omitting it dropped markup saves and could persist a stale markups array.
  useEffect(() => {
    if (!hydrated.current) return;
    // Swallow the hydration echo: the first run after hydrate() carries no user
    // edit (only the fresh-identity setState from loading). Arm and skip it so a
    // link-open reads without writing; every later run is a real edit and saves.
    if (!savesArmed.current) { savesArmed.current = true; return; }
    // Swallow a reconcile re-hydrate's echo (see suppressNextSave): the adopted
    // content is already canonical locally and on Drive at its own rev — re-pushing
    // it would churn revs (seed) or spuriously conflict + loser-snapshot (adopt).
    if (suppressNextSave.current) { suppressNextSave.current = false; return; }
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
    // buildPayload is intentionally omitted: this dep list IS the exact set of
    // state it serializes, so listing buildPayload (a new identity each render)
    // would fire a save on every render instead of only on a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, conditions, conditionColumns, shapeLabels, palette, scales, scaleSources, markups, rfis, provCounters, sheetGroup, sheetLevels, lastGroup, openTabs, projectName, clientInfo, units]);
  useEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  // Flush a pending debounced save on navigate-away (unmount), and warn before a
  // tab close while a save is in flight — so the tail of a tracing session is never lost.
  useEffect(() => {
    // Pin the store this canvas mounted against: on a client-side exit from a
    // cloud project, React runs the PARENT (ProjectGate) cleanup first, which
    // resets the live `store` binding to localStore — flushing through the live
    // binding here would write the cloud project's annotations into the local
    // store. In-life saves keep the live binding (it never swaps mid-mount).
    const mountStore = store;
    const onBeforeUnload = (e) => { if (saveStateRef.current === "saving") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (hydrated.current && saveStateRef.current === "saving" && saveDataRef.current) {
        mountStore.saveAnnotations(saveDataRef.current).catch(() => {});   // best-effort flush
      }
    };
  }, []);

  // ── Local-first sync bridge (Slice 5) ──────────────────────────────────────
  // On the opted-in path the active store carries a non-enumerable `syncBridge`
  // (main.jsx). Register the canvas's reconcile handlers into it so the plain-JS
  // reconciler can re-hydrate the canvas and read in-flight state. On the legacy
  // cloud path (and anonymous local) there is no bridge → these are no-ops, so the
  // flag-off behavior is byte-identical. Handlers are nulled on unmount so a late
  // reconcile never setState()s an unmounted tree.
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge) return;
    // A remote adopt (mount seed, or a 4c conflict resolution) hands us the winning
    // annotations to render. Suppress the resulting autosave echo, then hydrate via
    // the same state-application path as mount + snapshot restore. hydrate is stable
    // (it only calls setters + reads refs), so capturing it once is safe.
    bridge.onRemoteUpdate = (data) => { suppressNextSave.current = true; hydrate(data || {}); };
    return () => { bridge.onRemoteUpdate = null; };
    // hydrate is stable for a given mount (only setters + refs + the pinned store's
    // cloudMode), so capture it once. Listing it would re-register every render —
    // opening a null window where an arriving reconcile is dropped — for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Expose current in-flight state to the reconciler's defer-gate (the store's
  // maybeFlush declines to adopt-over-local while this returns true). Re-registered
  // whenever that state changes so the store always reads a fresh predicate. The
  // full defer/queue-collapse/saveDataRef-invalidation behavior is Slice 5b.
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge) return;
    bridge.isBusy = () => (
      poly.length > 0 || calib.length > 0 || check.length > 0 ||
      !!proposal || !!scaleGuide || !!prevScale || saveStateRef.current === "saving"
    );
    return () => { bridge.isBusy = null; };
  }, [poly, calib, check, proposal, scaleGuide, prevScale]);

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

  // memoized so the wheel-zoom effect can list it as a dep and still bind its
  // listener once — a plain function would give a new identity each render and
  // re-subscribe the (passive:false) wheel handler on every render.
  const zoomAround = useCallback((cx, cy, factor) => {
    const t = tfRef.current;
    const next = clamp(t.scale * factor);
    const k = next / t.scale;
    tfRef.current = { scale: next, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    applyTf(); scheduleSync();
  }, [applyTf, scheduleSync]);

  // wheel: the DEVICE decides between pan and zoom — no toggle, no mode.
  // Continuous trackpad scroll PANS both axes (the two-finger instinct every
  // Mac user brings); a discrete mouse-wheel notch ZOOMS toward the cursor,
  // glided over a few frames so it doesn't step. Pinch (ctrl/meta) always
  // zooms at its original immediate sensitivity; ⇧+wheel always pans.
  //
  // Device telling: the burst-OPENING event decides. macOS runs mouse wheels
  // through scroll acceleration, so the classic wheelDelta ±120 signature is
  // useless there (measured on real hardware: wheelDeltaY is exactly -3×deltaY
  // for BOTH devices). What separates them is the opening magnitude: a wheel
  // notch LANDS at full delta — |deltaY|≈12 minimum on macOS (acceleration
  // floor), ≈100 on Windows — while a trackpad gesture physically RAMPS from
  // finger contact (|deltaY| 0–2 at burst start, violent flicks included).
  // Line/page deltaMode is always a mouse (Firefox wheels). Classification is
  // carried while events keep arriving <300ms apart, so momentum tails keep
  // panning and a fast spin keeps zooming.
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    let glide = 0, gx = 0, gy = 0, raf = 0;
    let kind = "", kindUntil = 0;   // per-burst wheel-device classification
    const wheelKind = (e) => {
      const now = performance.now();
      if (kind && now < kindUntil) { kindUntil = now + 300; return kind; }
      kind = (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 10) ? "mouse" : "trackpad";
      kindUntil = now + 300;
      return kind;
    };
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
      if (wheelKind(e) === "trackpad") {
        // two-finger scroll = pan, both axes — the sheet follows the fingers
        const t = tfRef.current;
        tfRef.current = { ...t, x: t.x - e.deltaX * unit, y: t.y - e.deltaY * unit };
        applyTf(); scheduleSync();
        return;
      }
      glide += -e.deltaY * unit * 0.0012;            // one notch (~100) ≈ 12% zoom
      glide = Math.max(-1.2, Math.min(1.2, glide));  // cap queued zoom per direction
      gx = e.clientX; gy = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); if (raf) cancelAnimationFrame(raf); };
  }, [applyTf, scheduleSync, zoomAround]);

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
        const ok = ((tool === "area" || tool === "deduct") && poly.length >= 3) || (tool === "zone" && poly.length >= 3 && !zoneTraceCross) || ((tool === "linear" || tool === "surface") && poly.length >= 2);
        if (ok) { e.preventDefault(); finishShape(); return; }
        // ⏎ with agent proposals pending on a visible sheet = accept them all —
        // the agent's analogue of one-click's Create gate. Only fires when no
        // trace/proposal claimed the key above, so mid-draw ⏎ is untouched.
        if (agentProposals.some((p) => panelKeySet.has(p.sheet_id))) { e.preventDefault(); acceptAllVisibleAgentProposals(); }
        return;
      }
      const lower = e.key.toLowerCase();
      if (viewRef.current === "gallery") return;
      if (lower === "g") { setView("gallery"); return; }
      if (e.key === "D" && e.shiftKey) { setTool("deduct-rect"); return; }
      const map = { p: "pan", v: "select", a: "area", r: "rect", l: "linear", s: "surface", c: "count", d: "deduct", o: "oneclick", k: "check", h: "highlighter" };
      const t = map[lower];
      if (t) setTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, poly, proposal, agentProposals, activeCond, sheetGroup, sheetKey, shapes, scales]);
  // ^ shapes/scales joined the deps with the agent accept path (the delete-handler
  //   precedent): ⏎ accept dispatches an `add` against the CURRENT array, so a
  //   shapes change with no other dep change must re-subscribe this handler.

  // remember the last armed measure tool — the Measure menu face shows it
  useEffect(() => { if (MEASURE_TOOLS.some((t) => t.id === tool)) lastMeasureRef.current = tool; }, [tool]);

  // Number keys 1–9 switch the active condition (material) fast — through
  // activateCondition with reassign:false: a digit press has no visual
  // reassign affordance (unlike the panel row / strip button), so it must
  // never silently move a selected shape's quantities. It still dismisses a
  // live bulk selection, same as every activation surface. When the palette is
  // curated the digits follow PALETTE ORDER (the cobalt badges on the chips);
  // an un-pinned workspace falls back to condition-array order, so the shortcut
  // works out of the box before anyone pins anything.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // let ⌘/Ctrl+1..9 (native tab switch) through — mirror the letter handler
      if (menuDepthRef.current > 0) return;              // a toolbar menu is open; digits are paused like the letter shortcuts
      const n = parseInt(e.key, 10);
      if (n < 1 || n > 9) return;
      const id = palette.length ? palette[n - 1] : conditions[n - 1]?.id;
      if (id) activateCondition(id, { reassign: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conditions, palette, tool, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Undo a wrong click: Backspace/Delete (or Cmd/Ctrl+Z) removes the last placed
  // point; Escape cancels the whole in-progress shape.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target.tagName;
      if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
      if (viewRef.current === "gallery") return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (poly.length) { setPoly((q) => q.slice(0, -1)); }
        else if (ocSel && proposal) { deleteSelectedOcVertex(); }
        else if (proposal?.regions.length) { setProposal((pr) => { const rg = pr.regions.slice(0, -1); return rg.length ? { ...pr, regions: rg } : null; }); }
        else if (selVert != null && selectedId) { deleteSelectedShapeVertex(); }
        else if (selectedId) { dispatchShape({ type: "delete", ids: [selectedId] }); setSelectedId(null); }
        else if (selectedMarkupId && showMarkups) { deleteMarkup(selectedMarkupId); setSelectedMarkupId(null); }
        // pop ONLY the armed tool's pending points — calibrate and check both
        // keep two-click state (calib points even render while another tool is
        // armed), and an unguarded pop used to silently cross-slice the other
        // tool's points, on-screen or hidden
        else if (tool === "calibrate") { setCalib((c) => c.slice(0, -1)); }
        else if (tool === "check") { setCheck((c) => c.slice(0, -1)); }
      } else if (e.key === "Escape") { if (ocSel) { setOcSel(null); } else if (selVert != null) { setSelVert(null); } else { setPoly([]); setCalib([]); setCheck([]); setCheckStated(""); setScaleGuide(null); selectShape(null); setMarkupDraft(null); setProposal(null); setArmedStamp(null); setScheduleAnchor(null); resetZone(); hlRef.current = null; if (hlPathRef.current) hlPathRef.current.style.display = "none"; } }
      // ⌘Z: the drawing context wins — mid-trace it still pops the last placed
      // point (with or without ⇧, matching the old behavior byte-for-byte);
      // only with no trace in progress does the command stack engage
      // (⌘Z = undo, ⇧⌘Z = redo).
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (poly.length) setPoly((q) => q.slice(0, -1));
        else if (e.shiftKey) redoShapeCommand();
        else undoShapeCommand();
      }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { if (selectedId) { e.preventDefault(); copySelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { if (clipRef.current.length) { e.preventDefault(); pasteClipboard(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { if (selectedId) { e.preventDefault(); duplicateSelected(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, selectedId, selVert, selectedMarkupId, showMarkups, poly, proposal, ocSel, shapes, sheetKey, groupSig, scales, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The typed "drawing says" value belongs to ONE completed two-point check.
  // The moment the measurement is no longer complete — third-click restart,
  // Backspace below two points — the stale value must not grade the NEXT span:
  // it would render an instant confident verdict against the previous
  // dimension's number and leave "Recalibrate to this" armed with it.
  useEffect(() => { if (check.length < 2 && checkStated) setCheckStated(""); }, [check.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the check tool discards the whole check: rendering is gated on
  // tool === "check", so surviving state would sit invisible and resurface —
  // stale points AND stale stated value — whenever K is pressed again.
  useEffect(() => { if (tool !== "check" && (check.length || checkStated)) { setCheck([]); setCheckStated(""); } }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the zone tool clears the zone the same way — the outline and its
  // readout are a reading of the armed tool, never surviving state. The
  // in-progress trace itself must go too: `poly` is the SAME shared array
  // area/deduct/linear/surface commit from, so without this, a mid-trace
  // switch away from zone (a single-letter shortcut while zone has none of
  // its own, or the Zone button re-arming "select") leaves real zone points
  // sitting in `poly` for the NEXT tool's Enter/double-click to commit as a
  // persisted, priced shape — the ephemeral tool's own "nothing is saved"
  // contract broken. Only clear `poly` when the PREVIOUS tool was zone
  // (prevToolRef), not on every tool change — poly is shared, and switching
  // e.g. area → linear must not discard a legitimate in-progress trace.
  useEffect(() => {
    if (tool !== "zone") resetZone();
    if (prevToolRef.current === "zone" && tool !== "zone") setPoly([]);
    prevToolRef.current = tool;
  }, [tool]);

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
    // snapRef/angleRef are drawing-tool aids maintained by moveCrosshair, which
    // bails for the Select tool (:1577) — so in Select they'd be STALE. Select
    // does its own endpoint snap (ocSnap) on drop, so it always uses the raw
    // cursor here; otherwise a stale ref freezes the drag or jumps it on grab.
    // schedule (marquee) wants the raw cursor like select — snapping a corner to
    // a vector vertex would shift the box off the schedule and misread the region
    const rawCursor = tool === "select" || tool === "schedule";
    const p = (!rawCursor && snapOn && snapRef.current) ? snapRef.current
      : (!rawCursor && angleOn && angleRef.current) ? angleRef.current
        : toImage(e.clientX, e.clientY);
    const fp = panelAt(p[0]);
    if (fp.key !== focusKey) setFocusKey(fp.key);
    if (tool === "highlighter") {
      // ink is freehand: raw coords (no snap/angle), drag paints — press-drag pan is
      // intentionally unavailable while armed (space/middle/right-drag still pan)
      const raw = toImage(e.clientX, e.clientY);
      hlRef.current = { pts: [raw], key: panelAt(raw[0]).key };
      if (hlPathRef.current) {
        const el = hlPathRef.current;
        const w = hlStyle.size / tfRef.current.scale;
        el.setAttribute("d", "");
        if (hlStyle.tip === "chisel") { el.setAttribute("fill", hlStyle.color); el.setAttribute("fill-opacity", darkModeRef.current ? 0.42 : 0.32); el.setAttribute("stroke", "none"); }
        else { el.setAttribute("fill", "none"); el.setAttribute("stroke", hlStyle.color); el.setAttribute("stroke-opacity", darkModeRef.current ? 0.42 : 0.32); el.setAttribute("stroke-width", w); el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); }
        el.style.display = "block";
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "select") { selectAt(p, e); return; }
    // One-Click proposal handles: a press on a corner/edge grip starts an EDIT drag
    // (select+move a vertex, move a whole edge, or Shift-click to insert a point) —
    // it must win here, before the deferred add-a-region click below.
    if (tool === "oneclick" && proposal && oneClickHandleAt(e)) return;
    // every point-placing tool DEFERS to pointer-up: hold-and-drag (mouse left
    // or one-finger trackpad press) pans mid-measurement instead of placing
    pendingClickRef.current = { p, cx: e.clientX, cy: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  // the deferred click — runs on pointer-up when the press didn't become a pan
  function performClick(p, ev) {
    if (scaleGuide) setScaleGuide(null);
    if (tool === "calibrate") setCalib((c) => (c.length >= 2 ? [p] : [...c, p]));
    else if (tool === "check") setCheck((c) => (c.length >= 2 ? [p] : [...c, p]));
    else if (tool === "oneclick") oneClickAt(p, !!(ev && ev.altKey));
    else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface" || tool === "zone") setPoly((q) => [...q, p]);
    else if (tool === "count") commitCount(p);
    else if (tool === "rect" || tool === "deduct-rect") {
      if (poly.length === 0) setPoly([p]);
      else { const a = poly[0]; commitPoly([[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], tool === "deduct-rect"); setPoly([]); }
    }
    else if (tool === "schedule") {
      // two-click marquee, isolated state: first click drops the anchor, second reads the box
      if (!scheduleAnchor) setScheduleAnchor(p);
      else { importScheduleFromRect(scheduleAnchor, p); setScheduleAnchor(null); setTool("select"); }
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
    if (m.type === "highlight" && Array.isArray(m.pts)) {
      // a freehand highlighter stroke — hit the ink band itself (reach = half the
      // stroke width, floored at the shared threshold), never a bounding box, so a
      // stroke over a room shields only what it actually covers.
      if (m.pts.length < 2) return false;
      const w = (m.w || 0.01) * W;
      const reach = Math.max(w / 2, thr);
      const ip = m.pts.map(([nx, ny]) => [nx * W + ox, ny * H]);
      for (let i = 1; i < ip.length; i++) if (distToSeg(X, Y, ip[i - 1][0], ip[i - 1][1], ip[i][0], ip[i][1]) < reach) return true;
      return false;
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
    setSelVert(null);   // default: this press clears the vertex pick (overridden below on a corner/insert hit)
    // 1. Handles of the ALREADY-selected shape win first, so a shape (or vertex)
    //    enclosed by a markup — e.g. a revision cloud drawn around a room — stays
    //    editable rather than being shielded by the markup's hit area. Same edit
    //    model as One-Click proposals: click a corner to select it (Delete removes
    //    just it), drag a corner to move it, drag an edge grip to move the whole
    //    line (both endpoints), Shift-click an edge to insert a new anchor point.
    if (sel && selSp && sel.measure_role !== "count") {
      const pts = sel.verts_norm.map(([nx, ny]) => [nx * selSp.img.w + selSp.xOffset, ny * selSp.img.h]);
      const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) < thr * 1.6) {
          setSelVert(i);   // select this corner + arm its move drag
          // prev = the grab-time snapshot the commit-on-release geom command
          // stamps/freezes from; gx/gy only gate the live PREVIEW now (the
          // zero-motion no-stamp guard is structural: no motion ⇒ no command)
          dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId); return;
        }
      }
      // edge grips: drag moves the WHOLE line (both endpoints); Shift-click drops a
      // new anchor point there and drags it out in the same gesture.
      const edges = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < edges; i++) {
        const j = (i + 1) % pts.length;
        const a = pts[i], b = pts[j];
        if (Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]) < thr * 1.4) {
          if (e.shiftKey) {
            // insert at the EXACT edge midpoint (like One-Click's oneClickHandleAt),
            // not the click point — click imprecision can't kink the edge before drag.
            // The insertion itself is gesture-start LIVE state, not a command
            // (a collinear midpoint changes no quantity and never stamped) —
            // `prev` snapshots the POST-insert shape, so a zero-motion ⇧-click
            // still leaves the unstamped anchor behind exactly as before,
            // while any drag commits ONE stamped geom command on release.
            const va = sel.verts_norm[i], vb = sel.verts_norm[j];
            const nv = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2];
            const vnIns = [...sel.verts_norm.slice(0, i + 1), nv, ...sel.verts_norm.slice(i + 1)];
            const inserted = { ...sel, verts_norm: vnIns, computed: recomputeShape({ ...sel, verts_norm: vnIns }) };
            setShapes((ss) => ss.map((s) => (s.id === sel.id ? inserted : s)));
            setSelVert(i + 1);
            dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i + 1, prev: geomSnapshot(inserted), shape: inserted, gx: e.clientX, gy: e.clientY };
          } else {
            dragRef.current = { kind: "edge", shapeId: selectedId, i, j, oaN: [...sel.verts_norm[i]], obN: [...sel.verts_norm[j]], start: p, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
          }
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
        const orig = (mHit.type === "highlight" && Array.isArray(mHit.pts)) ? { pts: mHit.pts.map((v) => [...v]) }
          : (mHit.type === "cloud" || mHit.type === "highlight") ? { rect: mHit.rect }
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
      dragRef.current = { kind: "move", shapeId: selectedId, start: p, orig: sel.verts_norm, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId); return;
    }
    // 4. otherwise pick a shape (or clear the selection)
    const hit = [...visibleShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShape(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
    });
    selectShape(hit ? hit.id : null);
    if (hit) { dragRef.current = { kind: "move", shapeId: hit.id, start: p, orig: hit.verts_norm, prev: geomSnapshot(hit), shape: hit, gx: e.clientX, gy: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); return; }
    // 5. open canvas — drag the paper to PAN (the instinct everyone brings from
    // desktop takeoff tools; no need to reach for the Pan tool). The plain
    // click (no drag) already cleared the selection above, so a stationary
    // press costs nothing.
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: tfRef.current.x, oy: tfRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (containerRef.current) containerRef.current.style.cursor = "grabbing";
  }
  // Delete just the selected corner (Delete/⌫), keeping a polygon ≥3 / a run ≥2.
  // At the floor we deselect so the NEXT ⌫ falls through to deleting the whole
  // shape — mirrors the One-Click proposal behavior.
  function deleteSelectedShapeVertex() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel || selVert == null || selVert >= sel.verts_norm.length) { setSelVert(null); return; }   // stale index (shape changed under the selection) — never dispatch a no-op edit
    const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
    const min = closed ? 3 : 2;
    if (sel.verts_norm.length <= min) {
      setCommitMsg(closed ? "A shape needs at least 3 points — ⌫ again deletes the whole shape." : "A run needs at least 2 points — ⌫ again deletes the whole run.");
      setSelVert(null); return;
    }
    // dropping a corner is as real an edit as dragging one — the vertexDelete
    // command stamps "vertex" centrally, so a machine shape corrected only
    // this way can't read as a clean accept
    const vn = sel.verts_norm.filter((_, j) => j !== selVert);
    dispatchShape({
      type: "geom", id: sel.id, editKind: "vertexDelete",
      verts_norm: vn, computed: recomputeShape({ ...sel, verts_norm: vn }), prev: geomSnapshot(sel),
    });
    setSelVert(null);
  }
  // Geometry from the shape's OWN sheet: its panel's pixel dims × that sheet's
  // scale. This is what makes cross-sheet paste and group-mode edits honest.
  // uppOverride: pass the NEW effective upp when re-pricing right after a
  // setScales — `scales` in this render's closure is still the old map.
  function recomputeShape(s, uppOverride) {
    const sp = panelByKey(s.sheet_id);
    const pts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
    const u = uppOverride ?? (uppFor(s.sheet_id) || 0);
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

    // rubber-band preview: last point → cur (area/deduct/zone); rect preview: corner → cur
    const drawing = (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface" || tool === "zone");

    // polar tracking: endpoint snap wins (osnap beats polar); otherwise pull the
    // rubber band onto the 45° family. ⇧ forces the lock at any angle. The click
    // path commits angleRef, so the placed vertex is exactly on-axis — not just
    // the preview. The lock reads as a QUIET state change (crosshair brightens,
    // rubber band thickens, chip shows the angle) — no extra chrome on the sheet.
    const anchor = (drawing && poly.length > 0) ? poly[poly.length - 1]
      : (tool === "calibrate" && calib.length === 1 ? calib[0]
      : (tool === "check" && check.length === 1 ? check[0] : null));
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
      let txt = "", over = false;
      if (tool === "check" && check.length === 1) {
        // live length to the cursor while picking the second end of the dimension.
        // No CARPET_ROLL_FT amber here — a dimension string is not a seam plan.
        const u = uppFor(panelAt(check[0][0]).key);
        if (u) txt = fmtCheckLen(Math.hypot(cur[0] - check[0][0], cur[1] - check[0][1]) * u, units) + (lock ? ` · ${lock.deg}°` : "");
      } else if ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 && liveUpp) {
        // rectangle: live W × H + area (SF and SY imperial — carpet is bought in SY)
        const a = poly[0];
        const w = Math.abs(cur[0] - a[0]) * liveUpp, h = Math.abs(cur[1] - a[1]) * liveUpp;
        const sf = w * h;
        txt = `${fmtCheckLen(w, units)} × ${fmtCheckLen(h, units)} · ${num(areaVal(sf, units))} ${areaUnit(units)}${units === "metric" ? "" : ` · ${num(sf / 9)} SY`}`;
        over = w >= CARPET_ROLL_FT - 0.02 || h >= CARPET_ROLL_FT - 0.02;
      } else if (drawing && anchor && liveUpp) {
        // line/polyline: live segment length, ALWAYS (not just under the 45° lock)
        const len = Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) * liveUpp;
        txt = lock ? `${lock.deg}° · ${fmtCheckLen(len, units)}` : fmtCheckLen(len, units);
        over = len >= CARPET_ROLL_FT - 0.02;
      } else if (lock) {
        txt = `${lock.deg}°`;
      } else if (snapRef.current) txt = "snap";
      if (txt) {
        if (chip.__t !== txt) { chip.textContent = txt; chip.__t = txt; }
        // 12 ft roll-width cue — the chip goes amber when a run reaches roll width (a seam falls here)
        const os = over ? "1" : "";
        if (chip.__over !== os) {
          chip.__over = os;
          chip.style.background = over ? "var(--c-warning)" : "var(--paper-bright)";
          chip.style.color = over ? "var(--paper-bright)" : "var(--ink)";
          chip.style.borderColor = over ? "var(--c-warning)" : "var(--ink)";
        }
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
      const schedDraw = tool === "schedule" && scheduleAnchor;
      if (!panRef.current && ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 || schedDraw)) {
        const a = schedDraw ? scheduleAnchor : poly[0];
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
    if (hlRef.current == null && hlPathRef.current) hlPathRef.current.style.display = "none";
    if (hoverRef.current) hoverRef.current.style.display = "none";
    hoverIdRef.current = "";
    angleRef.current = null;
  }
  function describeShape(s) {
    const tag = condById[s.condition_id]?.finish_tag || "?";
    const a = s.computed?.area_sf || 0, lf = s.computed?.perimeter_lf || 0;
    if (s.measure_role === "count") return `${tag} · ${num(s.computed?.count || 1, 0)} EA`;
    if (s.measure_role === "deduct") return `${tag} · −${fa(a)} deduct`;
    if (s.measure_role === "surface_area") {
      // same height semantics as recomputeShape: an override wins outright (even 0).
      // Heights stay feet in both systems — they're ENTERED in feet everywhere.
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      return `${tag} · ${fa(a)} wall (${fl(lf)} × ${num(h, 2)}′)`;
    }
    if (s.measure_role === "linear") return `${tag} · ${fl(lf)}${a > 0 ? ` · ${fa(a)} border` : ""}`;
    return `${tag} · ${faSY(a)}`;
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
    if (hlRef.current) {
      // paint: distance-thin at capture, live preview via DOM (no React render per move)
      const st = hlRef.current;
      const q = toImage(e.clientX, e.clientY);
      const last = st.pts[st.pts.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 2.5 / tfRef.current.scale && st.pts.length < 4000) st.pts.push(q);
      if (hlPathRef.current) {
        const w = hlStyle.size / tfRef.current.scale;
        hlPathRef.current.setAttribute("d", hlStyle.tip === "chisel"
          ? (st.pts.length > 1 ? "M" + chiselRibbon(st.pts, w, 45).map((v) => v.join(",")).join(" L") + " Z" : "")
          : strokePathD(st.pts));
      }
      return;
    }
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
    // One-Click proposal editing: dragging a corner/edge grip, else revealing
    // handles on the region under the cursor. Both work in panel-LOCAL px.
    if (ocDragRef.current) { ocDragMove(e); return; }
    if (tool === "oneclick" && proposal && !panRef.current && !pendingClickRef.current) ocHoverUpdate(e);
    if (dragRef.current) {
      const d = dragRef.current;
      // dragRef is armed only by selectAt (Select tool), where snapRef is stale
      // (moveCrosshair bails for Select) — track the RAW cursor; vertex/edge
      // drags apply their own endpoint snap (ocSnap), and a body move is free.
      const p = toImage(e.clientX, e.clientY);
      // Live PREVIEW only — geometry follows the cursor for feel, but nothing
      // stamps here anymore: provenance is applied exactly once, on release,
      // by the geom command in onPointerUp (whose `prev` is the grab-time
      // snapshot — so stampEdit's freeze still reads the TRUE pre-drag ring).
      // The gx/gy gate keeps a plain select-click's zero-delta pointermove
      // from writing any preview state at all: no motion ⇒ no write ⇒ no
      // command ⇒ no stamp — the old d.stamped flag guard, made structural.
      // vn is computed OUTSIDE the updater (from the grab-time snapshot, which
      // is exact: a gesture only ever moves the verts named by the drag ref)
      // and remembered on the ref (d.lastVerts/d.lastComputed) so the release
      // commit and the preview can never disagree.
      if (d.kind === "vertex" || d.kind === "edge" || d.kind === "move") {
        if (!d.moved && e.clientX === d.gx && e.clientY === d.gy) return;
        d.moved = true;
        const sp = panelByKey(d.shape.sheet_id);
        let vn;
        if (d.kind === "vertex") {
          const [slx, sly] = ocSnap(sp.key, p[0] - sp.xOffset, p[1], !!d.shape.origin?.raster_traced);   // snap the corner to true endpoints (never on a raster-traced shape — see ocSnap)
          vn = d.prev.verts_norm.map((v, i) => (i === d.vIndex ? [slx / sp.img.w, sly / sp.img.h] : v));
        } else if (d.kind === "edge") {
          // translate BOTH endpoints of the line by the drag delta; each end snaps
          // to the linework independently (normalized → local px → snap → normalized)
          const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
          const rt = !!d.shape.origin?.raster_traced;
          const snapN = (nx, ny) => { const [lx, ly] = ocSnap(sp.key, nx * sp.img.w, ny * sp.img.h, rt); return [lx / sp.img.w, ly / sp.img.h]; };
          const na = snapN(d.oaN[0] + dx, d.oaN[1] + dy), nb = snapN(d.obN[0] + dx, d.obN[1] + dy);
          vn = d.prev.verts_norm.map((v, i) => (i === d.i ? na : i === d.j ? nb : v));
        } else {
          // start and p are both stage px, so xOffset cancels in the delta —
          // only the normalizing divisor is the shape's own panel
          const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
          vn = d.orig.map(([nx, ny]) => [nx + dx, ny + dy]);
        }
        d.lastVerts = vn;
        // a translation never re-prices (same lengths/areas) — matches the old
        // move updater, which left `computed` untouched
        d.lastComputed = d.kind === "move" ? undefined : recomputeShape({ ...d.shape, verts_norm: vn });
        setShapes((ss) => ss.map((s) => (s.id !== d.shapeId ? s
          : d.kind === "move" ? { ...s, verts_norm: vn }
            : { ...s, verts_norm: vn, computed: d.lastComputed })));
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
          if (o.pts) return { ...m, pts: o.pts.map(([nx, ny]) => [nx + dx, ny + dy]) };   // highlighter stroke
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
    if (hlRef.current) {
      const st = hlRef.current;
      hlRef.current = null;
      if (hlPathRef.current) hlPathRef.current.style.display = "none";
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      if (st.pts.length >= 2) {
        const tp = panelByKey(st.key) || panelAt(st.pts[0][0]);
        const pts = thinStroke(st.pts, 2.5 / tfRef.current.scale)
          .map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]);
        // width as a FRACTION of panel width — the stroke scales with the plan like ink,
        // and survives raster-budget changes (screen px ÷ scale ÷ panel width at draw time)
        addMarkup({ type: "highlight", pts, color: hlStyle.color,
                    w: (hlStyle.size / tfRef.current.scale) / tp.img.w, tip: hlStyle.tip }, tp.key);
      }
      return;
    }
    if (pendingClickRef.current) {
      const { p } = pendingClickRef.current;
      pendingClickRef.current = null;
      performClick(p, e);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (ocDragRef.current) { ocDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ } return; }
    if (dragRef.current) {
      const d = dragRef.current;
      dragRef.current = null;
      // Commit-on-gesture-end: ONE geom command per drag, and only when the
      // geometry actually moved off the grab-time snapshot (a drag that snapped
      // back exactly is not an edit — no command, no stamp). The command's
      // canonical result supersedes the live-preview frames; `prev` carries the
      // grab-time verts/computed/provenance so the stamp freezes the true
      // pre-drag ring and undo restores it exactly. (pointercancel routes here
      // too, so an interrupted drag still lands as a stamped command, never as
      // orphaned preview state.)
      if ((d.kind === "vertex" || d.kind === "edge" || d.kind === "move")
          && d.lastVerts && !vertsEqual(d.lastVerts, d.prev.verts_norm)) {
        dispatchShape({
          type: "geom", id: d.shapeId, editKind: d.kind,
          verts_norm: d.lastVerts,
          ...(d.lastComputed !== undefined ? { computed: d.lastComputed } : {}),
          prev: d.prev,
        });
      }
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (panRef.current) {
      panRef.current = null;
      setTf({ ...tfRef.current });   // sync once at end
      if (containerRef.current) containerRef.current.style.cursor = spaceRef.current ? "grab" : "";
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    }
  }

  // Calibrated ruler bar — shows for a few seconds whenever a scale is accepted
  // (scale menu standard pick, the plan-says item, calibration, check-tool
  // recalibrate) so a grossly wrong scale is visually obvious against known
  // elements (a door is ~3′). Takes the NEW upp as an argument — never read
  // `scales` right after setScales (stale closure). Ephemeral: never persisted,
  // dismissed by the next action. `preview` marks a HOVER preview of a scale
  // that was never accepted — it must additionally die with the hover/menu
  // (clearPreviewGuide), while an accepted bar rides out its 8 s.
  function showScaleGuide(key, uppStored, label, preview = false) {
    const p = panelByKey(key);
    if (!p?.img.w || !containerRef.current) return;
    scaleGuidePreviewRef.current = preview;
    const uppBitmap = uppStored / factorFor(key);   // feet per bitmap px, matches uppFor math
    const z = tfRef.current.scale;
    // round guide length picked so the bar is legible (≥160 screen px) at the current zoom
    const CAND = units === "metric" ? [1, 2, 5, 10, 20, 50, 100].map((m) => m / M_PER_FT) : [2, 5, 10, 20, 50, 100, 200];
    const feet = CAND.find((f) => (f / uppBitmap) * z >= 160) ?? CAND[CAND.length - 1];
    const r = containerRef.current.getBoundingClientRect();
    const t = tfRef.current;
    const cx = Math.min(Math.max(((r.width / 2) - t.x) / t.scale, p.xOffset + p.img.w * 0.1), p.xOffset + p.img.w * 0.9);
    const cy = Math.min(Math.max(((r.height * 0.78) - t.y) / t.scale, p.img.h * 0.1), p.img.h * 0.92);
    setScaleGuide({ key, feet, px: feet / uppBitmap, label, at: [cx, cy] });
    clearTimeout(scaleGuideTimerRef.current);
    scaleGuideTimerRef.current = setTimeout(() => setScaleGuide(null), 8000);
  }
  useEffect(() => { setScaleGuide(null); scaleGuidePreviewRef.current = false; }, [tool, groupSig]);
  useEffect(() => () => clearTimeout(scaleGuideTimerRef.current), []);
  // Kill a hover-preview guide (and only a preview — an accepted bar stays).
  // Fired on hover-out of the plan-says item AND whenever the scale menu
  // closes (item click, Escape, outside click — the item button unmounts
  // without a mouseleave, so hover-out alone can't be trusted). Stable
  // identity: it feeds the menu's onOpenChange effect via onScaleMenuDepth.
  const clearPreviewGuide = useCallback(() => {
    if (!scaleGuidePreviewRef.current) return;
    scaleGuidePreviewRef.current = false;
    clearTimeout(scaleGuideTimerRef.current);
    setScaleGuide(null);
  }, []);
  const onScaleMenuDepth = useCallback((o) => { onMenuDepth(o); if (!o) clearPreviewGuide(); }, [onMenuDepth, clearPreviewGuide]);

  // Every user-facing scale acceptance goes through here: store the new scale
  // AND re-price the committed shapes on that sheet. `computed` is priced at
  // draw time, so without this a rescale left every existing SF/LF at the old
  // scale (the same staleness pasteClipboard calls "the legacy bug") — glaring
  // now that the check tool's one-tap recalibrate makes late rescales routine.
  // Hydrate bypasses this on purpose: saved computed matches the saved scale.
  function rescaleSheet(key, upp) {
    // stash the scale this rescale replaces, but only when it actually changes
    // committed quantities (sheet had a scale, the scale moved, shapes exist on
    // it) — that's the case worth a one-step revert (the Scale menu surfaces it)
    const prior = scales[key];
    if (prior === upp) return; // re-picking the active scale — no reprice churn, no stash (mirrors the MCP guard)
    if (prior != null && shapes.some((sh) => sh.sheet_id === key)) {
      setPrevScale({ key, upp: prior, source: scaleSources[key] || "standard" });
    }
    setScales((s) => ({ ...s, [key]: upp }));
    // STRICT panel lookup — the panelByKey wrapper falls back to panels[0], so
    // it can't detect an off-canvas sheet: a future off-canvas caller would
    // silently re-price that sheet's shapes against the wrong panel's bitmap
    // dims (and factorFor of a never-rastered key). Off-canvas the scale is
    // still stored above; the shapes keep their (now old-scale) computed until
    // a caller reprices them on canvas — wrong-but-visible beats silently-wrong.
    const sp = panels.find((p) => p.key === key);
    if (!sp?.img?.w) return; // sheet not on canvas — can't re-price without its bitmap dims
    const uEff = upp / factorFor(key);
    // count shapes keep their computed: EA has no upp dependency at all, and
    // recomputeShape's count branch would clobber a hand-edited / hydrated
    // fractional count (supported data — see totals.js accumulateRole) to 1.
    // A rescale re-price is a whole-array NON-edit (`replace`: no stamps, no
    // counters) and it RESETS both undo stacks: every recorded command froze
    // `computed` at the old scale, and undoing one afterwards would resurrect
    // stale quantities.
    dispatchShape({
      type: "replace",
      shapes: shapes.map((sh) => (sh.sheet_id === key && sh.measure_role !== "count" ? { ...sh, computed: recomputeShape(sh, uEff) } : sh)),
    }, { reset: true });
  }

  // Revert the last quantity-changing rescale (the one-slot stash above): runs
  // the same rescaleSheet back — which re-stashes the scale being replaced, so
  // a revert is itself revertible (a two-way toggle, not a history).
  function revertScale() {
    const pv = prevScale;
    if (!pv) return;
    rescaleSheet(pv.key, pv.upp);
    setScaleSources((s) => ({ ...s, [pv.key]: pv.source }));
    showScaleGuide(pv.key, pv.upp, STANDARD_SCALES.find((x) => Math.abs(x.upp - pv.upp) < 1e-9)?.label || pv.source);
  }

  function applyCalibration() {
    const feet = calInputToFeet(parseFloat(pendingLen), units);   // metric users type meters; stored scale stays feet
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
    rescaleSheet(pa.key, (feet / px) * toBase); // per page — remembered for this sheet
    setScaleSources((s) => ({ ...s, [pa.key]: "calibrated" }));
    showScaleGuide(pa.key, (feet / px) * toBase, "calibrated");
    setCalib([]); setPendingLen("");
  }

  // Check tool's one-tap recalibrate: the measured span IS a calibration line —
  // same math as applyCalibration, sourced from the check points + stated value.
  function recalibrateFromCheck() {
    const feet = parseLenInput(checkStated, units);
    if (!(feet > 0) || check.length !== 2) return;
    const pa = panelAt(check[0][0]);
    if (panelAt(check[1][0])?.key !== pa?.key) return; // cross-panel span — the UI hides the button, but keep the function safe standalone
    const px = Math.hypot(check[1][0] - check[0][0], check[1][1] - check[0][1]);
    if (px <= 0) return;
    const toBase = factorFor(pa.key);
    rescaleSheet(pa.key, (feet / px) * toBase);
    setScaleSources((s) => ({ ...s, [pa.key]: "calibrated" }));
    showScaleGuide(pa.key, (feet / px) * toBase, "calibrated");
    setCheck([]); setCheckStated("");
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
    // id + created_at are minted by the add command — the ONE creation gate
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond,
      measure_role: asDeduct ? "deduct" : "floor_area",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual" },
    }] });
  }
  function commitLinear(points) {
    if (points.length < 2) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const LF = openLen(points) * upp;
    const tIn = Number(aCond?.thickness_in) || 0; // borders/feature strips: SF = LF × T/12
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "linear",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual" },
    }] });
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
    if (!(h > 0)) { setCommitMsg(`Set a height for ${aCond?.finish_tag || "this condition"} (H in the condition editor) — Surface Area = traced LF × height.`); return; }
    const LF = openLen(points) * upp;
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "surface_area", height_ft: h,
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(LF * h).toFixed(2), perimeter_lf: +LF.toFixed(2) },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual" },
    }] });
  }
  function commitCount(p) {
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const tp = panelAt(p[0]);
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "count",
      verts_norm: [[(p[0] - tp.xOffset) / tp.img.w, p[1] / tp.img.h]], computed: { count: 1 }, ...(activeLabel ? { label: activeLabel } : {}), origin: { method: "manual" },
    }] });
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
  // Scan-pixel mask for sheets with no usable linework: a fresh dedicated pdf.js
  // render at mask scale — NEVER the panel canvas (dark mode bakes an inversion
  // into those pixels, and a hi-res panel is a 100MB+ readback) — thresholded by
  // rastermask.ts. Cached as a promise so concurrent clicks share one render.
  function ensureRasterMask(key) {
    let pr = rasterMaskCacheRef.current.get(key);
    if (!pr) {
      const pageObj = pageObjsRef.current.get(key), dims = panelImgs[key];
      if (!pageObj || !dims?.w) return Promise.resolve(null);
      const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
      const ws = Math.min(1, MASK_MAX_DIM / Math.max(dims.w, dims.h, 1));
      const mw = Math.max(2, Math.ceil(dims.w * ws)), mh = Math.max(2, Math.ceil(dims.h * ws));
      // distinct namespace from the panel's own renderTasksRef entry (keyed by
      // `key` alone) so registering this task can't clobber — or get clobbered
      // by — the panel's primary render; group-switch cleanup cancels both.
      const taskKey = `${key}:raster`;
      pr = (async () => {
        const cv = document.createElement("canvas");
        cv.width = mw; cv.height = mh;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2d canvas context unavailable"); // caught below like any other render failure — clear message over a cryptic null-deref
        const rt = pageObj.render({ canvasContext: ctx, viewport: pageObj.getViewport({ scale: rs * ws }), background: "#ffffff" });
        renderTasksRef.current.set(taskKey, rt);
        try {
          await rt.promise;
        } finally {
          renderTasksRef.current.delete(taskKey);
        }
        const px = ctx.getImageData(0, 0, mw, mh);
        cv.width = cv.height = 0;   // drop the backing store
        return buildRasterMask(px.data, mw, mh, ws);
      })().catch(() => {
        // A rejection here (pdf.js render failure — worker restart, a lazily-
        // fetched embedded image erroring; getImageData allocation failure
        // under memory pressure; a buildRasterMask throw) must NOT be cached
        // as a resolved-null forever — that would make every future click on
        // this sheet show the permanent failure message even though a retry
        // would succeed. Evict so the next ensureRasterMask call rebuilds.
        rasterMaskCacheRef.current.delete(key);
        return null;
      });
      rasterMaskCacheRef.current.set(key, pr);
    }
    return pr;
  }
  // The propose tail, shared by the vector and raster paths. Raster differences:
  // a looser RDP eps (scan contours wobble) and NO vertex snapping — there are
  // no true endpoints on a scan, and pulling room corners onto the title-block's
  // vector corners would corrupt the ring. Duplicate/carve checks run inside a
  // FUNCTIONAL setProposal so a click racing the first raster render can't
  // clobber state.
  function proposeRegion(f, tp, local, negative, raster) {
    const upp = uppFor(tp.key);
    if (!upp) return;
    let ring;
    if (raster) ring = traceRegion(f, RASTER_RDP_EPS);
    else {
      const grid = snapGridsRef.current.get(tp.key);
      ring = snapVertices(traceRegion(f), (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null), 7);
    }
    if (ring.length < 3) { setCommitMsg("Couldn't trace that space — trace it with Area (A)."); return; }
    const area_sf = +(ringArea(ring) * upp * upp).toFixed(2);
    const perim_lf = +(closedMetrics(ring).perim * upp).toFixed(2);
    // Decide accept/dup/carve-reject INSIDE the functional updater, against
    // its own authoritative `prev` — not proposalRef, which only catches up
    // on the next render's passive-effect flush (a macrotask). proposeRegion
    // can resume after an await (the raster path shares a cached
    // ensureRasterMask promise across concurrent clicks on the same panel),
    // and two continuations on that shared promise resume as back-to-back
    // MICROTASK reactions with no render/effect flush able to run in
    // between — so a second click's dedup check would read proposalRef from
    // BEFORE the first click's setProposal landed and wrongly pass.
    //
    // setCommitMsg still must not be called from inside the updater itself
    // — React may invoke it more than once (StrictMode double-invoke, or a
    // discarded concurrent render), and firing a message from inside one
    // would announce a decision that never lands. So the verdict is stashed
    // in this scope-local `outcome` var (a plain reassignment, not a
    // setState call) and acted on AFTER setProposal returns.
    //
    // That read is wrapped in flushSync rather than just trusted to be
    // synchronous: React's "run the updater eagerly, at dispatch time" fast
    // path is an internal bail-out optimization, not a public guarantee, and
    // it does NOT reliably apply here — proposeRegion's raster call always
    // resumes from a promise continuation (after `await ensureRasterMask`),
    // never a discrete DOM event, so React defers the updater to the next
    // render instead of running it inline (confirmed against the real
    // shared-promise race in this file: `outcome` read back as undefined
    // every time, in both dev and a production build, with or without a
    // second racing click). flushSync forces that render to happen, and
    // this updater to run, before setProposal returns, so `outcome` is
    // always populated by the time it's read below — for the ordinary
    // single-click case AND for two clicks racing the same shared promise
    // (the second call's setProposal, and its read of `outcome`, still runs
    // strictly after the first call's flushSync has fully committed).
    let outcome;
    flushSync(() => {
      setProposal((prev) => {
        const rs = prev && prev.key === tp.key ? prev.regions : [];
        const kind = negative ? "neg" : "pos";
        if (rs.some((r) => r.kind === kind && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "dup";
          return prev;
        }
        if (negative && !rs.some((r) => r.kind === "pos" && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "needsPos";
          return prev;
        }
        outcome = "added";
        // poly0 freezes the MACHINE trace (post-snap, pre-handle-edit) so a
        // corrected region can still report what the fill proposed; sens rides
        // only when the estimator moved the knob off Balanced (vector path
        // only — the raster mask is single-tier, sensitivity is inert there).
        return { key: tp.key, regions: [...rs, { kind, seed: local, poly: ring, poly0: ring.map(([x, y]) => [x, y]), ...(!raster && fillSens !== SENS_BALANCED ? { sens: fillSens } : {}), area_sf, perim_lf, hf: !!f.hatchFiltered, rt: !!raster }] };
      });
    });
    if (outcome === "dup") setCommitMsg(negative ? "That cutout is already carved." : "Already selected — ⌥-click carves an enclosed cutout; ⏎ creates.");
    else if (outcome === "needsPos") setCommitMsg("⌥-click carves an enclosed area INSIDE the selection (a column or shaft) — click its room first.");
    else setCommitMsg("");
  }
  async function oneClickAt(p, negative) {
    const tp = panelAt(p[0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    if (proposal && proposal.key !== tp.key) { setCommitMsg(`Finish the selection on ${labelFor(panelByKey(proposal.key))} first — ⏎ creates it, Esc discards.`); return; }
    const local = [p[0] - tp.xOffset, p[1]];
    // Trigger policy: vector is exact and always wins where it works — including
    // the fork's hatch escalation (fillSens), which runs untouched here. The
    // raster path engages only where vectors can't bound the room — a scan
    // wrapper (big placed image, near-zero linework) runs raster PRIMARY; a
    // mixed sheet (big image UNDER real linework) retries on pixels only after
    // the vector flood fails. A pure-vector sheet never touches pixels.
    const stats = sheetStatsRef.current.get(tp.key);
    const rasterEligible = !!stats && stats.imageFrac >= RASTER_MIN_IMG_FRAC;
    const vectorViable = !!stats && stats.segCount >= RASTER_MIN_SEGS;
    if (!rasterEligible || vectorViable) {
      const mo = ensureMask(tp.key);
      if (!mo && !rasterEligible) { setCommitMsg("Still reading this sheet's linework — try again in a second."); return; }
      if (mo) {
        const f = floodRegion(mo, local[0], local[1], fillSens);
        if (f.status === "ok") { proposeRegion(f, tp, local, negative, false); return; }
        if (!rasterEligible) {
          setCommitMsg(f.status === "leak"
            ? "That space isn't enclosed on the plan linework — the fill spilled. Click a more enclosed spot, or trace it with Area (A)."
            : "Landed in dense linework (hatching/text). Zoom in and click an open spot, or trace it with Area (A).");
          return;
        }
      }
    }
    setCommitMsg("Reading the scan…");
    const seq = renderSeqRef.current;
    const rmo = await ensureRasterMask(tp.key);
    if (seq !== renderSeqRef.current) { setCommitMsg(""); return; }   // sheet group changed mid-render — the new sheet must not be left showing a stale "Reading the scan…" ("…" messages never auto-expire, see commitMsg's 6s-timer effect
    // The raster render can take real time on a large scan; the user may have
    // switched tools or started a DIFFERENT panel's proposal while it was in
    // flight. renderSeq alone only catches a sheet-GROUP change — re-validate
    // against the LIVE tool/proposal (refs, not the closed-over `tool`/
    // `proposal` — this is an async continuation resuming after other renders)
    // so a late raster result can never silently replace another panel's
    // in-progress proposal or paint a ghost selection in the wrong tool.
    if (toolRef.current !== "oneclick" || (proposalRef.current && proposalRef.current.key !== tp.key)) { setCommitMsg(""); return; }
    if (!rmo) { setCommitMsg("Couldn't read this scan — trace it with Area (A)."); return; }
    // The raster mask is single-tier (softCount 0), so floodRegion's hatch
    // escalation — and with it the Fill sensitivity knob — is structurally
    // inert on scans; no sensitivity is passed.
    const f = floodRegion(rmo, local[0], local[1]);
    if (f.status !== "ok") {
      setCommitMsg(f.status === "leak"
        ? "That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Click a more enclosed spot, or trace it with Area (A)."
        : "Landed on dense scan ink (text or hatching). Zoom in and click an open spot, or trace it with Area (A).");
      return;
    }
    proposeRegion(f, tp, local, negative, true);
  }
  function createProposal() {
    if (!proposal || !proposal.regions.length) return;
    const tp = panelByKey(proposal.key);
    const made = proposal.regions.map((r) => ({
      sheet_id: tp.key, condition_id: activeCond,
      measure_role: r.kind === "neg" ? "deduct" : "floor_area",
      verts_norm: r.poly.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
      computed: { area_sf: r.area_sf, perimeter_lf: r.perim_lf },
      ...(activeLabel ? { label: activeLabel } : {}),
      // the provenance receipt: machine-proposed, human-reviewed at the Create
      // gate. A handle-corrected region (touched) records the machine's frozen
      // trace (poly0) as proposed_verts_norm — the one-click correction pair;
      // an untouched region's verts ARE the proposal, so nothing extra rides.
      // Post-Create edits are stamped by stampEdit, which freezes the same
      // field from the pre-edit ring only when Create didn't already.
      origin: { method: "one_click_v1", seed_norm: [r.seed[0] / tp.img.w, r.seed[1] / tp.img.h], reviewed: true, ...(r.hf ? { hatch_filtered: true } : {}), ...(r.rt ? { raster_traced: true } : {}), ...(r.sens != null ? { fill_sensitivity: r.sens } : {}), ...(r.touched ? { edited_before_create: true, proposed_verts_norm: r.poly0.map(([x, y]) => [x / tp.img.w, y / tp.img.h]) } : {}) },
    }));
    dispatchShape({ type: "add", shapes: made });   // Create is the creation gate — id/created_at minted by the command
    const sf = proposal.regions.reduce((n, r) => n + (r.kind === "neg" ? -r.area_sf : r.area_sf), 0);
    setCommitMsg(`Created ${made.length} takeoff${made.length === 1 ? "" : "s"} — ${fa(sf)} ${condById[activeCond]?.finish_tag || ""}. Click the next room.`);
    setProposal(null);
  }

  // ── One-Click proposal geometry editing — correct a fill BEFORE Create ──────
  // A proposal region's `poly` is panel-LOCAL px (image space of proposal.key,
  // no xOffset — same frame the preview draws in). These reuse the existing
  // recompute idiom (ringArea × upp², closedMetrics) and the endpoint snap grid,
  // so a corrected corner lands on the plan's true linework just like a hand
  // trace. Nothing here commits a takeoff — that's still the Create (⏎) gate.
  const ocMetrics = (poly, key) => {
    const upp = uppFor(key) || 0;
    return { area_sf: +(ringArea(poly) * upp * upp).toFixed(2), perim_lf: +(closedMetrics(poly).perim * upp).toFixed(2) };
  };
  // `bypass` (true for a raster region/shape) skips nearestSnap entirely — on a
  // scan wrapper the snap grid holds only the placed-image/clip-rect corners
  // and title-block linework (extractVectorGeometry's few real points, not the
  // scan ink), so snapping a dragged raster corner onto it yanks the point
  // onto geometry unrelated to the room being edited. Same rationale
  // proposeRegion already applies to the initial trace — the handles must not
  // reintroduce it.
  const ocSnap = (key, x, y, bypass) => {
    if (bypass) return [x, y];
    const grid = snapGridsRef.current.get(key);
    const hit = grid ? nearestSnap(grid, x, y, 8 / tfRef.current.scale) : null;
    return hit ? [hit[0], hit[1]] : [x, y];
  };
  // Press on a corner (select + arm move), an edge grip (arm whole-line move),
  // or Shift on an edge (insert a new anchor, arm its move). Returns true if the
  // press was consumed. Hit-tests against RAW cursor px (not the snap/angle-
  // adjusted point) so grabbing a handle is never nudged by an unrelated snap.
  function oneClickHandleAt(e) {
    if (tool !== "oneclick" || !proposal) return false;
    // ⌥ is reserved for carving a cutout (oneClickAt) — never let a handle grab
    // swallow it, or an ⌥-click near a room's own corner/edge could never carve.
    if (e.altKey) return false;
    const tp = panelByKey(proposal.key);
    if (!tp || !tp.img.w) return false;
    const raw = toImage(e.clientX, e.clientY);
    const lx = raw[0] - tp.xOffset, ly = raw[1];
    const thr = 8 / tfRef.current.scale;
    const regions = proposal.regions;
    for (let ri = 0; ri < regions.length; ri++) {          // corners win over edges
      const poly = regions[ri].poly;
      for (let i = 0; i < poly.length; i++) {
        if (Math.hypot(poly[i][0] - lx, poly[i][1] - ly) < thr * 1.6) {
          setOcSel({ ri, vi: i });
          ocDragRef.current = { kind: "oc-vertex", ri, vi: i };
          e.currentTarget.setPointerCapture(e.pointerId);
          return true;
        }
      }
    }
    for (let ri = 0; ri < regions.length; ri++) {          // edge midpoints
      const poly = regions[ri].poly;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (Math.hypot(mx - lx, my - ly) < thr * 1.5) {
          if (e.shiftKey) {                                  // insert a new anchor, then drag it
            setProposal((pr) => {
              if (!pr) return pr;
              const rgs = pr.regions.map((r, idx) => {
                if (idx !== ri) return r;
                const np = [...r.poly.slice(0, i + 1), [mx, my], ...r.poly.slice(i + 1)];
                return { ...r, poly: np, ...ocMetrics(np, pr.key) };
              });
              return { ...pr, regions: rgs };
            });
            setOcSel({ ri, vi: i + 1 });
            ocDragRef.current = { kind: "oc-vertex", ri, vi: i + 1 };
          } else {                                           // move BOTH endpoints of this line
            ocDragRef.current = { kind: "oc-edge", ri, i, j: (i + 1) % poly.length, oa: a.slice(), ob: b.slice(), sx: lx, sy: ly };
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          return true;
        }
      }
    }
    return false;
  }
  // Live drag: a corner follows the (snapped) cursor; an edge translates both its
  // endpoints by the drag delta, each end snapping independently to the linework.
  function ocDragMove(e) {
    const d = ocDragRef.current;
    const tp = panelByKey(proposal?.key);
    if (!proposal || !tp || !tp.img.w) { ocDragRef.current = null; return; }
    const raw = toImage(e.clientX, e.clientY);
    const lx = raw[0] - tp.xOffset, ly = raw[1];
    setProposal((pr) => {
      if (!pr) return pr;
      const regions = pr.regions.map((r, ri) => {
        if (ri !== d.ri) return r;
        let poly;
        if (d.kind === "oc-vertex") {
          const np = ocSnap(pr.key, lx, ly, r.rt);
          poly = r.poly.map((v, i) => (i === d.vi ? np : v));
        } else {
          const dx = lx - d.sx, dy = ly - d.sy;
          const na = ocSnap(pr.key, d.oa[0] + dx, d.oa[1] + dy, r.rt);
          const nb = ocSnap(pr.key, d.ob[0] + dx, d.ob[1] + dy, r.rt);
          poly = r.poly.map((v, i) => (i === d.i ? na : i === d.j ? nb : v));
        }
        // touched = a handle actually moved this region: Create records the
        // frozen poly0 as origin.proposed_verts_norm only for touched regions
        return { ...r, poly, ...ocMetrics(poly, pr.key), touched: true };
      });
      return { ...pr, regions };
    });
  }
  // Reveal handles on the region under the cursor (inside it, or near a corner /
  // edge grip so you can grab a corner to pull it outward). Ref-compared so we
  // only re-render when the hovered region actually changes.
  function ocHoverUpdate(e) {
    const tp = panelByKey(proposal.key);
    let hov = -1;
    if (tp && tp.img.w) {
      const raw = toImage(e.clientX, e.clientY);
      const lx = raw[0] - tp.xOffset, ly = raw[1];
      const near = 14 / tfRef.current.scale;
      for (let ri = 0; ri < proposal.regions.length && hov < 0; ri++) {
        const poly = proposal.regions[ri].poly;
        if (pointInPoly(lx, ly, poly)) { hov = ri; break; }
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          if (Math.hypot(a[0] - lx, a[1] - ly) < near || Math.hypot(mx - lx, my - ly) < near) { hov = ri; break; }
        }
      }
    }
    if (hov !== ocHoverRef.current) { ocHoverRef.current = hov; setOcHover(hov); }
  }
  // Delete just the selected corner (Delete/⌫), keeping a region ≥ 3 points —
  // never collapses the whole space (use ⌫ with nothing selected for that).
  function deleteSelectedOcVertex() {
    if (!ocSel || !proposal) return;
    const r = proposal.regions[ocSel.ri];
    if (!r) { setOcSel(null); return; }
    // Can't thin a triangle further. Deselect so the NEXT ⌫ falls through to the
    // remove-last-region branch — otherwise the ocSel guard keeps re-firing this
    // message and the space can never be dropped without an Esc first.
    if (r.poly.length <= 3) { setOcSel(null); setCommitMsg("A space needs at least 3 points — ⌫ again drops the whole space."); return; }
    setProposal((pr) => {
      if (!pr) return pr;
      const regions = pr.regions.map((rr, ri) => {
        if (ri !== ocSel.ri) return rr;
        const np = rr.poly.filter((_, i) => i !== ocSel.vi);
        // dropping a corner is a pre-Create correction too — same touched flag
        return { ...rr, poly: np, ...ocMetrics(np, pr.key), touched: true };
      });
      return { ...pr, regions };
    });
    setOcSel(null);
  }

  // ── copy / paste / duplicate — "draw once, drop it again", same sheet or the
  // one under the cursor. The clipboard carries verts + provenance, never the old
  // computed numbers: every paste recomputes against the TARGET panel's dims and
  // that sheet's scale (this also fixes the legacy bug where pasting after a
  // rescale kept the stale SF).
  const clipRef = useRef([]);
  // A clone keeps its lineage (method + flags + copied: true) but NEVER the
  // source's seed_norm / proposed_verts_norm: an offset paste would read as a
  // phantom correction (machine trace over here, shape over there). The edits
  // map is deep-copied so a stamp on the clone can't alias the source's tally.
  const cloneOrigin = (o) => {
    if (!o) return {};
    const { seed_norm: _seed, proposed_verts_norm: _pvn, ...rest } = o;
    return { origin: { ...rest, ...(rest.edits ? { edits: { ...rest.edits } } : {}), copied: true } };
  };
  // the clipboard payload for one shape: verts deep-copied, provenance kept,
  // `from` remembers the source sheet so paste knows same-sheet vs cross-sheet
  const clipEntry = (sel) => ({ condition_id: sel.condition_id, measure_role: sel.measure_role,
                                verts_norm: sel.verts_norm.map((v) => [...v]), from: sel.sheet_id, height_ft: sel.height_ft,
                                ...(sel.height_override ? { height_override: true } : {}), ...(sel.label ? { label: sel.label } : {}), ...cloneOrigin(sel.origin) });
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
      const s = { sheet_id: tp.key, condition_id: c.condition_id, measure_role: c.measure_role, verts_norm: vn, ...(c.height_ft != null ? { height_ft: c.height_ft } : {}), ...(c.height_override ? { height_override: true } : {}), ...(c.label ? { label: c.label } : {}), ...cloneOrigin(c.origin) };
      return { ...s, computed: recomputeShape(s) };
    });
    // the add command mints id/created_at; a plain add appends, so the minted
    // clones are the array's last N — select the newest one
    const res = dispatchShape({ type: "add", shapes: made });
    selectShape(res.shapes[res.shapes.length - 1].id);
    setTool("select");
    setCommitMsg(`Pasted ${made.length} takeoff${made.length === 1 ? "" : "s"}${cross ? ` onto ${labelFor(tp)}` : ""} — drag to position.`);
  }
  function duplicateSelected() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel) { setCommitMsg("Select a takeoff to duplicate."); return; }
    clipRef.current = [clipEntry(sel)];
    pasteClipboard();
  }
  // Mirror the selected shape about its own bbox center — an isometry, so SF/LF
  // never change. Routes through the same geom/vertex command path as a manual
  // vertex drag, which gives correct undo/redo and provenance stamping for free.
  function flipSelected(axis) {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel || !Array.isArray(sel.verts_norm) || sel.verts_norm.length < 2) {
      setCommitMsg("Select an area or linear takeoff to flip."); return;
    }
    const vn = reflectVertsNorm(sel.verts_norm, axis);
    dispatchShape({
      type: "geom", id: sel.id, editKind: "vertex",
      verts_norm: vn, computed: recomputeShape({ ...sel, verts_norm: vn }), prev: geomSnapshot(sel),
    });
  }
  // ── markup (cloud / callout / text) — annotations, not measurements ─────────
  // markupDraft holds STAGE px (so the live preview spans panels); a markup
  // belongs to the panel of its FIRST click and normalizes against that panel.
  function addMarkup(m, key) {
    // created_at rides the defaults so every markup path (hand-drawn, cloud's
    // pre-minted id, stamp instances) is stamped at this single creation gate
    setMarkups((ms) => [...ms, { id: uid("mk"), created_at: nowIso(), sheet_id: key, rfi_id: "", ...m }]);
    // Drawing a markup by hand surfaces the Markups tab. But a STAMP places several
    // markups via addMarkup — don't yank the user off the Stamps tab mid-placement
    // (keep the current tab, or open Markups only if nothing's open). Highlighter
    // ink flows stroke after stroke — never pop the dock per stroke.
    if (m.type === "highlight" && m.pts) return;
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
      // branding mode decides the cover identity + wordmark + parent credit;
      // resolved per-project (folderId "" ⇒ the single browser-only setting)
      const brand = resolveBranding({ ...(await loadBrandingSelection(projectIdFromUrl())), profiles: loadProfiles().profiles });
      const { bytes, filename } = await buildMarkedSetPdf({
        projectName, clientInfo, company: brand.company, credit: brand.credit, coverTitle: brand.coverTitle,
        dark: darkMode, units, sheets: sheetMeta, shapes, markups: exportMarkups, rfis, conditions,
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
    if (m.type === "highlight" && Array.isArray(m.pts) && m.pts.length) { const mid = m.pts[Math.floor((m.pts.length - 1) / 2)]; nx = mid[0]; ny = mid[1]; }
    else if ((m.type === "cloud" || m.type === "highlight") && m.rect) { nx = (m.rect[0][0] + m.rect[1][0]) / 2; ny = (m.rect[0][1] + m.rect[1][1]) / 2; }
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
    // an svg symbol carries no text — select it, but don't open a dead-end editor;
    // a highlighter stroke is pure ink (no text either), same rule
    if (m.type === "svg" || (m.type === "highlight" && Array.isArray(m.pts))) { selectMarkup(m.id); return; }
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
      id, number, created_at: nowIso(), subject: (markup.text || "").trim(), question: "", status: "open",
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
    if (m.type === "highlight" && Array.isArray(m.pts) && m.pts.length) anchor = m.pts[Math.floor((m.pts.length - 1) / 2)];
    else if ((m.type === "cloud" || m.type === "highlight") && m.rect) anchor = [(m.rect[0][0] + m.rect[1][0]) / 2, (m.rect[0][1] + m.rect[1][1]) / 2];
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

  function finishShape() {
    if (tool === "zone") {
      // ephemeral: classify, show, never save. Belongs to the panel of its first point.
      // Cross-panel span — the UI hides the Finish affordance (finishOk), but
      // keep the function safe standalone (Enter is still wired to it): a
      // point on a different panel than poly[0] would normalize to nx/ny
      // outside [0..1] for THAT panel, drawing a region that visually spans
      // a sheet it can never actually count shapes on.
      const tp = poly.length ? panelAt(poly[0][0]) : null;
      if (poly.length >= 3 && tp && poly.every((p) => panelAt(p[0]).key === tp.key)) {
        setZoneCheck({ key: tp.key, pts: poly.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]) });
        setZoneExpand(null);
      }
      setPoly([]);
      return;
    }
    if (tool === "surface") commitSurface(poly); else if (tool === "linear") commitLinear(poly); else commitPoly(poly, tool === "deduct"); setPoly([]);
  }
  function deleteSelected() { if (selectedId) { dispatchShape({ type: "delete", ids: [selectedId] }); setSelectedId(null); } }
  function reassignSelected(condId) { if (selectedId) dispatchShape({ type: "reassign", ids: [selectedId], condition_id: condId }); }
  function reassignSelectedLabel(value) { if (selectedId) dispatchShape({ type: "label", ids: [selectedId], value }); }   // Select-tool single-shape re-label (#111) — value "" / null clears it; label commands never stamp

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

  // ONE condition-minting path — the human +condition button and the agent's
  // create_condition tool both come through here, so the field set and the
  // color/hatch auto-rotation can never drift between the two.
  function mintCondition(tag) {
    // read the LIVE list (agentStateRef) — the agent can mint mid-run, when the
    // render-scope `conditions` closure is stale; the ref is updated per render
    // AND immediately below, so two mints in one model turn rotate correctly.
    const cs = agentStateRef.current.conditions;
    // auto-vary line color AND hatch so each new finish reads distinctly, like a drawing
    const lc = PALETTE[cs.length % PALETTE.length];
    const c = {
      id: uid("cnd"), created_at: nowIso(), finish_tag: tag,
      color: lc,            // line color
      fill: lc,             // fill color (NO_FILL for outline-only)
      hatch: HATCHES[1 + (cs.length % (HATCHES.length - 1))].id,
      multiplier: 1,        // ×N for identical repeated units (measure one, multiply)
      waste_pct: 0,         // flooring waste allowance (manual) — applied in the Report
      materials: [],        // supporting materials (adhesive, grout, …) with coverage rates
    };
    agentStateRef.current = { ...agentStateRef.current, conditions: [...cs, c] };
    setConditions((prev) => [...prev, c]);
    return c;
  }
  function addCondition() {
    const tag = (window.prompt("Finish tag for this condition (e.g. LVT-1):") || "").trim();
    if (!tag) return;
    const c = mintCondition(tag);
    activateCondition(c.id, { reassign: false });   // no reassign affordance on +condition; still dismisses a live bulk selection
  }

  // ── In-canvas takeoff agent — capabilities, the accept gate, and the run ────
  // The registry (lib/agentTools.js) owns schemas/validation/whitelists; these
  // are the CAPABILITIES its tools close over — each one reads live state via
  // agentStateRef (the loop spans many awaits) and reuses the app's existing
  // deterministic engines verbatim: the pdf.js text layer + extractRegionText,
  // parseSchedule, the one-click flood/trace/snap pipeline, and the detail-view
  // offscreen render. Nothing here writes to `shapes` — proposals stage into
  // agentProposals and only the accept gate below dispatches an `add` command.
  const AGENT_VIEW_MAX_EDGE = 1024;   // view_region crop cap (vision-model native range)
  const AGENT_TEXT_MAX_ITEMS = 600;   // read_sheet_text cap — a full E-size text layer would drown the context

  const agentPanelFor = (key) => {
    const p = agentStateRef.current.panels.find((x) => x.key === key);
    return p && p.img.w ? p : null;
  };
  const agentUpp = (key) => panelGeom.uppFor(agentStateRef.current.scales, renderScalesRef.current, key);

  async function agentTextTokens(key, region) {
    const p = agentPanelFor(key);
    const pageObj = pageObjsRef.current.get(key);
    if (!p || !pageObj) throw new Error(`Sheet ${key} isn't rendered yet.`);
    const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
    const vp = pageObj.getViewport({ scale: rs });
    const tc = await pageObj.getTextContent();
    const rect = region
      ? { x0: region.x0 * p.img.w, y0: region.y0 * p.img.h, x1: region.x1 * p.img.w, y1: region.y1 * p.img.h }
      : { x0: 0, y0: 0, x1: p.img.w, y1: p.img.h };
    return { tokens: extractRegionText(tc, vp, rect), p };
  }

  async function agentReadSheetText(key, region) {
    const { tokens, p } = await agentTextTokens(key, region);
    return tokens.slice(0, AGENT_TEXT_MAX_ITEMS).map((t) => ({
      text: t.str, x: +(t.x / p.img.w).toFixed(4), y: +(t.y / p.img.h).toFixed(4),
    }));
  }

  async function agentReadSchedule(key, region) {
    const { tokens } = await agentTextTokens(key, region);
    return parseSchedule(tokens);   // vector path only — same parser as Import from schedule
  }

  // Render just the asked-for crop offscreen (the rasterizeRegion idiom) and
  // hand back a PNG data URL — THE vision tool for scans and ambiguous areas.
  async function agentViewRegion(key, region) {
    const p = agentPanelFor(key);
    const pageObj = pageObjsRef.current.get(key);
    if (!p || !pageObj) throw new Error(`Sheet ${key} isn't rendered yet.`);
    const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
    const x0 = region.x0 * p.img.w, y0 = region.y0 * p.img.h;
    const regW = Math.max(1, (region.x1 - region.x0) * p.img.w);
    const regH = Math.max(1, (region.y1 - region.y0) * p.img.h);
    const factor = Math.min(1, AGENT_VIEW_MAX_EDGE / regW, AGENT_VIEW_MAX_EDGE / regH);
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));
    const cv = document.createElement("canvas");
    cv.width = bw; cv.height = bh;
    await pageObj.render({
      canvasContext: cv.getContext("2d"),
      viewport: pageObj.getViewport({ scale: rs * factor }),
      transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor],
      background: "#ffffff",   // never the panel canvas — dark mode bakes an inversion into those pixels
    }).promise;
    const image_data_url = cv.toDataURL("image/png");
    cv.width = cv.height = 0;
    return { image_data_url, width: bw, height: bh };
  }

  // The one-click engine at an agent-supplied seed — same trigger policy and
  // messages as oneClickAt, WITHOUT touching the interactive proposal state:
  // this probes and returns the ring; committing anything stays behind the gate.
  async function agentOneClickProbe(key, xn, yn) {
    const p = agentPanelFor(key);
    if (!p) return { error: `Sheet ${key} isn't rendered yet — try again in a moment.` };
    const upp = agentUpp(key);
    if (upp == null) return { error: agentScaleGate(key, agentStateRef.current.detectedScales[key]?.label || "") };
    const local = [xn * p.img.w, yn * p.img.h];
    const stats = sheetStatsRef.current.get(key);
    const rasterEligible = !!stats && stats.imageFrac >= RASTER_MIN_IMG_FRAC;
    const vectorViable = !!stats && stats.segCount >= RASTER_MIN_SEGS;
    let f = null, raster = false;
    if (!rasterEligible || vectorViable) {
      const mo = ensureMask(key);
      if (!mo && !rasterEligible) return { error: "Still reading this sheet's linework — try again in a second." };
      if (mo) {
        const r = floodRegion(mo, local[0], local[1], fillSens);
        if (r.status === "ok") f = r;
        else if (!rasterEligible) {
          return { error: r.status === "leak"
            ? "That space isn't enclosed on the plan linework — the fill spilled. Seed a more enclosed spot."
            : "Landed in dense linework (hatching/text). Seed an open spot inside the room." };
        }
      }
    }
    if (!f) {
      const rmo = await ensureRasterMask(key);
      if (!rmo) return { error: "Couldn't read this scan — the estimator will have to trace it by hand." };
      const r = floodRegion(rmo, local[0], local[1]);
      if (r.status !== "ok") {
        return { error: r.status === "leak"
          ? "That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Seed a more enclosed spot."
          : "Landed on dense scan ink (text or hatching). Seed an open spot inside the room." };
      }
      f = r; raster = true;
    }
    let ring;
    if (raster) ring = traceRegion(f, RASTER_RDP_EPS);
    else {
      const grid = snapGridsRef.current.get(key);
      ring = snapVertices(traceRegion(f), (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null), 7);
    }
    if (ring.length < 3) return { error: "Couldn't trace that space into a polygon." };
    return {
      verts_norm: ring.map(([x, y]) => [+(x / p.img.w).toFixed(5), +(y / p.img.h).toFixed(5)]),
      area_sf: +(ringArea(ring) * upp * upp).toFixed(2),
      perimeter_lf: +(closedMetrics(ring).perim * upp).toFixed(2),
      seed_norm: [+xn.toFixed(5), +yn.toFixed(5)],
      ...(f.hatchFiltered ? { hatch_filtered: true } : {}),
      ...(raster ? { raster_traced: true } : {}),
    };
  }

  // Stage already-whitelisted proposals (the registry validated + whitelisted
  // evidence before calling this). area/perim computed here for the review UI;
  // the accept gate recomputes fresh in case the estimator recalibrates first.
  function stageAgentProposals(shapes) {
    const staged = shapes.map((s) => {
      const p = agentPanelFor(s.sheet);
      const upp = agentUpp(s.sheet) || 0;
      const ringPx = s.verts_norm.map(([x, y]) => [x * p.img.w, y * p.img.h]);
      return {
        id: `agp-${mintUuid()}`,
        sheet_id: s.sheet,
        condition_id: s.condition_id,
        measure_role: s.measure_role,
        verts_norm: s.verts_norm,
        evidence: s.evidence,
        ...(Array.isArray(s.evidence.seed_norm) ? { seed_norm: s.evidence.seed_norm } : {}),
        proposed_ts: nowIso(),
        area_sf: +(ringArea(ringPx) * upp * upp).toFixed(2),
        perim_lf: +(closedMetrics(ringPx).perim * upp).toFixed(2),
      };
    });
    setAgentProposals((ps) => [...ps, ...staged]);
    return { staged: staged.length };
  }

  function buildAgentCtx() {
    return {
      listSheets: () => agentStateRef.current.panels.filter((p) => p.img.w).map((p) => ({
        sheet: p.key,
        title: tabLabel(p.key),
        width: p.img.w, height: p.img.h,
        scale_set: agentUpp(p.key) != null,
        ...(agentStateRef.current.scaleSources[p.key] ? { scale_source: agentStateRef.current.scaleSources[p.key] } : {}),
        ...(agentStateRef.current.detectedScales[p.key]?.label ? { detected_label: agentStateRef.current.detectedScales[p.key].label } : {}),
      })),
      sheetDims: (key) => { const p = agentPanelFor(key); return p ? { w: p.img.w, h: p.img.h } : null; },
      uppFor: agentUpp,
      detectedLabel: (key) => agentStateRef.current.detectedScales[key]?.label || "",
      readSheetText: agentReadSheetText,
      readSchedule: agentReadSchedule,
      viewRegion: agentViewRegion,
      oneClick: agentOneClickProbe,
      getConditions: () => agentStateRef.current.conditions.map((c) => ({ id: c.id, finish_tag: c.finish_tag, hatch: c.hatch, waste_pct: c.waste_pct })),
      createCondition: (tag) => { const c = mintCondition(tag); return { id: c.id, finish_tag: c.finish_tag }; },
      proposeShapes: stageAgentProposals,
    };
  }

  // ── the accept gate ─────────────────────────────────────────────────────────
  // Accept = the explicit human review one-click's Create models: the shape
  // commits through dispatchShape `add` (id/created_at minted there) with the
  // agent_v1 origin receipt — actor agent, reviewed true, the FROZEN proposed
  // ring, the evidence, and the propose/accept timestamps (local provenance;
  // the contribution wire whitelists evidence only, never timing). Post-accept
  // edits then grade through stampEdit exactly like one-click corrections.
  function acceptAgentProposals(ids) {
    const idSet = new Set(ids);
    const take = agentProposals.filter((p) => idSet.has(p.id));
    if (!take.length) return;
    const made = [], accepted = new Set();
    let skippedClosed = 0;
    for (const pr of take) {
      const tp = panels.find((x) => x.key === pr.sheet_id && x.img.w);
      const upp = uppFor(pr.sheet_id);
      if (!tp || !upp || !condById[pr.condition_id]) { skippedClosed++; continue; }
      const ringPx = pr.verts_norm.map(([x, y]) => [x * tp.img.w, y * tp.img.h]);
      made.push({
        sheet_id: pr.sheet_id, condition_id: pr.condition_id, measure_role: pr.measure_role,
        verts_norm: pr.verts_norm.map((v) => [...v]),
        computed: { area_sf: +(ringArea(ringPx) * upp * upp).toFixed(2), perimeter_lf: +(closedMetrics(ringPx).perim * upp).toFixed(2) },
        origin: {
          method: "agent_v1", actor: "agent", reviewed: true,
          proposed_ts: pr.proposed_ts, accepted_ts: nowIso(),
          proposed_verts_norm: pr.verts_norm.map((v) => [...v]),
          ...(pr.seed_norm ? { seed_norm: pr.seed_norm } : {}),
          ...(pr.evidence ? { evidence: pr.evidence } : {}),
        },
      });
      accepted.add(pr.id);
    }
    if (made.length) dispatchShape({ type: "add", shapes: made });   // ONE command — one undo entry for the batch
    setAgentProposals((ps) => ps.filter((p) => !accepted.has(p.id)));
    if (made.length) setCommitMsg(`Accepted ${made.length} agent proposal${made.length === 1 ? "" : "s"}.${skippedClosed ? ` ${skippedClosed} skipped — open their sheet (with its scale set) to accept.` : ""}`);
    else if (skippedClosed) setCommitMsg("Open that proposal's sheet (with its scale set) to accept it.");
  }
  const acceptAgentProposal = (id) => acceptAgentProposals([id]);
  const acceptAllVisibleAgentProposals = () => acceptAgentProposals(agentProposals.filter((p) => panelKeySet.has(p.sheet_id)).map((p) => p.id));
  // Reject = drop from the pending list, LOCAL ONLY. Dismissed-proposal
  // geometry never rides the contribution wire — no rejection records, no
  // counters, nothing for contribute.js to even see (the D34 cut-line).
  const rejectAgentProposal = (id) => setAgentProposals((ps) => ps.filter((p) => p.id !== id));
  const rejectAllAgentProposals = () => setAgentProposals([]);

  // ── the run ────────────────────────────────────────────────────────────────
  const trimJson = (v, n) => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } return s && s.length > n ? `${s.slice(0, n)}…` : s || ""; };
  function appendAgentLog(ev) {
    const entry =
      ev.type === "text" ? { kind: "text", text: ev.text }
      : ev.type === "tool_start" ? { kind: "tool", text: `→ ${ev.name} ${trimJson(ev.args, 120)}` }
      : ev.type === "tool_end" ? (ev.result?.error
          ? { kind: "error", text: `✗ ${ev.name}: ${ev.result.error}` }
          : { kind: "status", text: `✓ ${ev.name} ${trimJson({ ...ev.result, image_data_url: undefined, items: Array.isArray(ev.result?.items) ? `${ev.result.items.length} items` : undefined }, 160)}` })
      : ev.type === "error" ? { kind: "error", text: `Error: ${ev.message}` }
      : ev.type === "aborted" ? { kind: "status", text: "Stopped." }
      : ev.type === "max_iterations" ? { kind: "status", text: `Stopped at the ${ev.limit}-step cap — review what's staged.` }
      : ev.type === "done" ? { kind: "status", text: "Done — review the dashed proposals." }
      : null;
    if (entry) setAgentLog((l) => [...l.slice(-199), entry]);
  }
  async function runAgent(goal) {
    if (agentRunning) return;
    if (!isAiConfigured()) { setShowAiSettings(true); return; }
    if (agentStateRef.current.status !== "ready") { setCommitMsg("Sheet still loading — try again in a moment."); return; }
    const ctl = new AbortController();
    agentAbortRef.current = ctl;
    setAgentRunning(true);
    setAgentLog([{ kind: "status", text: `Goal: ${goal}` }]);
    const ctx = buildAgentCtx();
    try {
      await runAgentLoop({
        cfg: aiConfig(), goal, tools: AGENT_TOOL_DEFS,
        execute: (name, args) => executeAgentTool(ctx, name, args),
        onEvent: appendAgentLog,
        signal: ctl.signal,
      });
    } finally {
      setAgentRunning(false);
      agentAbortRef.current = null;
    }
  }
  const stopAgent = () => agentAbortRef.current?.abort();

  // ── Import from schedule ────────────────────────────────────────────────────
  // Read the marqueed box and open the approval dialog. Two paths, ONE contract
  // (ScheduleRow[] → the same dialog):
  //   • vector plans: the page text layer inside the box IS the extraction —
  //     no OCR, open to everyone (parseSchedule);
  //   • scanned plans: the box has no text tokens, so we rasterize it and hand
  //     the PNG to the optional AI backend (/ai/parse-schedule). That path is
  //     login-gated (see importScheduleFromScan).
  // Corners a,b are stage px (raw cursor, snapping exempted at pointer-down).
  async function importScheduleFromRect(a, b) {
    if (status !== "ready") { setCommitMsg("Sheet still loading — try again in a moment."); return; }
    const panel = panelAt(a[0]);
    if (panelAt(b[0]).key !== panel.key) { setCommitMsg("Draw the box within a single sheet, around its schedule table."); return; }
    const pageObj = pageObjsRef.current.get(panel.key);
    if (!pageObj) { setCommitMsg("Open a sheet first."); return; }
    const rs = renderScalesRef.current.get(panel.key) || RENDER_SCALE;
    const rect = { x0: a[0] - panel.xOffset, y0: a[1], x1: b[0] - panel.xOffset, y1: b[1] };
    const seq = renderSeqRef.current;                 // a sheet switch mid-await must not pop a dialog for a page you left
    let tokens;
    try {
      const vp = pageObj.getViewport({ scale: rs });
      const tc = await pageObj.getTextContent();
      if (seq !== renderSeqRef.current) return;
      tokens = extractRegionText(tc, vp, rect);
    } catch { setCommitMsg("Couldn't read that region."); return; }
    // Vector-vs-scan decision. Tokens present ⇒ TRY the text layer first (a real
    // vector schedule parses straight from it, no OCR cost). But token presence
    // isn't proof of a vector page: scanned plans often carry a stray text layer
    // (embedded OCR, a title block, dimension text) that lands in the marquee yet
    // holds no schedule. So a token-bearing box that parses to NOTHING is not a
    // dead end — fall through to the AI scan path when it's reachable, exactly as
    // a truly text-less raster page would.
    if (tokens.length) {
      const rows = parseSchedule(tokens);
      if (rows.length) { setImportRows(rows); return; }
      // Parsed nothing. If the scan reader isn't reachable — not configured, not
      // signed in, or the account is outside the org domain — the only actionable
      // advice is to re-drag around the table header. Don't fire a paid OCR call
      // and don't claim the page is scanned.
      if (!isGoogleConfigured() || !isSignedIn() || !isAllowedDomain()) {
        setCommitMsg("No schedule found in that box — drag around the finish/material schedule (its CODE / MATERIAL / … header).");
        return;
      }
      // else: the reader is available — let it read the pixels below.
    }
    await importScheduleFromScan(pageObj, rs, rect, seq, tokens.length);
  }

  // Scan/OCR fallback for a raster page: rasterize the marqueed region and POST
  // it to the optional AI backend, then feed the returned rows into the SAME
  // approval dialog. LOGIN-GATED — only a Google-configured deployment with a
  // signed-in user reaches the network (no API key ever lives in client code).
  // tokenCount is the region's text-token count at the routing site: 0 ⇒ a true
  // raster page (no text layer, AI is the only reader); >0 ⇒ the fallthrough from a
  // token-bearing box whose vector parse found nothing. We report WHICH happened
  // (#104) but never claim the >0 case is a "fixable parser gap": scanned plans
  // routinely carry a stray text layer (title block, dimension text, embedded OCR)
  // that lands in the marquee yet holds no schedule, so a token-bearing box that
  // parses to nothing is just as likely a genuine scan as a defeated vector table.
  async function importScheduleFromScan(pageObj, rs, rect, seq, tokenCount) {
    const hadTokens = tokenCount > 0;
    if (!isGoogleConfigured()) {
      setCommitMsg("No schedule found — this looks like a scanned page (no text layer). Importing from scanned plans needs the AI backend.");
      return;
    }
    if (!isSignedIn()) { setCommitMsg("Sign in to import from scanned plans."); return; }
    // Org-only: a signed-in account outside the configured domain must not reach
    // the paid reader (the server 403s it too — this just avoids the round-trip).
    if (!isAllowedDomain()) { setCommitMsg("Your sign-in doesn't have access to the scanned-schedule reader."); return; }
    // A paid read is already in flight — a rapid re-draw of the marquee must not
    // fire a second Gemini call. Surface it (the first call may not have printed
    // "Reading…" yet) so the redraw doesn't look ignored. Clears in finally below.
    if (scanBusyRef.current) { setCommitMsg("Still reading the last schedule — one moment."); return; }
    scanBusyRef.current = true;
    try {
      let png;
      try { png = await rasterizeRegion(pageObj, rs, rect); }
      catch { setCommitMsg("Couldn't read that region."); return; }
      if (seq !== renderSeqRef.current) return;
      // The token is what actually authorizes the paid read — the server verifies
      // it before spending. A missing/expired token here means re-consent, not a
      // silent public call.
      let token;
      try { token = await getAccessToken(); }
      catch { setCommitMsg("Sign in again to import from scanned plans."); return; }
      if (seq !== renderSeqRef.current) return;
      setCommitMsg("Reading the scanned schedule…");
      // #104: record WHY the paid reader was reached, right before the call fires
      // (rasterize + token succeeded), so the log correlates 1:1 with paid reads.
      // no-text-layer = truly raster (AI-only); text-present-unparsed = tokens were
      // in the box but the vector parser produced nothing (NOT asserted as a parser
      // bug — a stray-text scan is indistinguishable from a defeated vector table).
      console.info("[schedule-import] using AI reader", {
        reason: hadTokens ? "text-present-unparsed" : "no-text-layer",
        tokenCount,
      });
      try {
        // A cold serverless start + slow vision call can overrun Netlify's sync cap
        // and return a 504 gateway page; the warm retry succeeds (#102). One retry
        // only, and only on 504 — real errors (401/403/501/5xx JSON) fall through
        // to the handling below on the first response.
        const res = await postScanWithRetry(
          () => fetch(SCAN_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            // client_hd stamps this build's VITE_GOOGLE_HD so the server can warn if
            // it has drifted from the runtime ALLOWED_HD (the client org-gate would
            // then be silently no-op'ing). Diagnostic only — the server's authoritative
            // token + ALLOWED_HD gate ignores it.
            body: JSON.stringify({ image_b64: png.b64, width: png.width, height: png.height, client_hd: orgDomainHint() }),
          }),
          { onRetry: () => setCommitMsg("The reader was warming up — retrying…") },
        );
        if (seq !== renderSeqRef.current) return;
        if (res.status === 401 || res.status === 403) { setCommitMsg("Your sign-in doesn't have access to the scanned-schedule reader."); return; }
        if (res.status === 501) { setCommitMsg("Importing from scanned plans isn't enabled on this deployment."); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = normalizeScanRows(await res.json());
        if (!rows.length) {
          setCommitMsg(hadTokens
            ? "No schedule found in that box — drag around the finish/material schedule (its CODE / MATERIAL / … header)."
            : "No schedule found in that scanned region — the reader returned nothing.");
          return;
        }
        // #104: say why the AI reader ran — honest about the token-bearing case (we
        // read the pixels; we do NOT claim the vector parser has a bug).
        setCommitMsg(hadTokens
          ? `Read ${rows.length} finish${rows.length === 1 ? "" : "es"} from the image — the box had text but we couldn't read it as a table.`
          : `Read ${rows.length} finish${rows.length === 1 ? "" : "es"} — scanned page (no text layer).`);
        setImportRows(rows);
      } catch { setCommitMsg("Couldn't reach the schedule reader — try again in a moment."); }
    } finally {
      scanBusyRef.current = false;
    }
  }

  // Render just the marqueed region (rs-viewport px, the space rect lives in) to
  // an offscreen canvas and return its PNG as base64 + pixel dims. Mirrors the
  // detail-view offscreen render: shift the region's top-left to (0,0) and clamp
  // to the single-canvas caps so a huge marquee can't exceed the backing store —
  // AND to SCAN_MAX_DIM (scanRasterScale), the server's per-side cap, so a
  // near-full-sheet marquee downscales to fit instead of being rejected with a
  // 400 "invalid image dimensions". Downscales only as far as the cap, so a
  // tighter box still goes at full resolution (better read on small schedule text).
  async function rasterizeRegion(pageObj, rs, rect) {
    const x0 = Math.min(rect.x0, rect.x1), y0 = Math.min(rect.y0, rect.y1);
    const regW = Math.max(1, Math.abs(rect.x1 - rect.x0)), regH = Math.max(1, Math.abs(rect.y1 - rect.y0));
    const factor = Math.min(1, MAX_CANVAS_DIM / regW, MAX_CANVAS_DIM / regH, Math.sqrt(MAX_CANVAS_AREA / (regW * regH)), scanRasterScale(regW, regH));
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));
    const vp = pageObj.getViewport({ scale: rs * factor });
    const canvas = document.createElement("canvas");
    canvas.width = bw; canvas.height = bh;
    await pageObj.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor],
    }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    return { b64: dataUrl.split(",")[1] || "", width: bw, height: bh };
  }

  // Approved rows → conditions. Category drives color/hatch/waste (rowToSeed);
  // product spec (mfr/style/color/size) rides a plain `spec` field — NOT custom
  // columns (would hijack a user column and pollute its grouping vocabulary) and
  // NOT materials[] (those are coverage buy-list items, no coverage rate here).
  // Existing codes are skipped (shown "in use" in the dialog).
  function createFromSchedule(selected) {
    const existing = new Set(conditions.map((c) => normalizeTag(c.finish_tag)));
    const made = [];
    let idx = conditions.length;
    for (const row of selected) {
      const tag = normalizeTag(row.finish_tag);
      if (existing.has(tag)) continue;
      const seed = rowToSeed({ ...row, finish_tag: tag }, idx++, PALETTE);
      const hasSpec = Object.values(seed.spec).some(Boolean);
      made.push({
        id: uid("cnd"), created_at: nowIso(), finish_tag: seed.finish_tag, color: seed.color, fill: seed.color,
        hatch: seed.hatch, multiplier: 1, waste_pct: seed.waste_pct, materials: [],
        ...(hasSpec ? { spec: seed.spec } : {}),
      });
      existing.add(tag);
    }
    setImportRows(null);
    if (!made.length) { setCommitMsg("Those finishes already exist as conditions."); return; }
    setConditions((cs) => [...cs, ...made]);
    activateCondition(made[0].id, { reassign: false });
    setCommitMsg(`Created ${made.length} condition${made.length === 1 ? "" : "s"} from the schedule.`);
  }
  // every condition-editor save lands here — a bare updated_at is the whole
  // provenance story for conditions (no origin machinery; they're all manual)
  const updateCond = (patch) => setConditions((cs) => cs.map((c) => (c.id === activeCond ? { ...c, ...patch, updated_at: nowIso() } : c)));

  // delete a condition entirely (and its takeoffs); pick a new active one
  function deleteCondition(id) {
    const c = condById[id];
    if (!c) return;
    const owned = shapes.filter((s) => s.condition_id === id);
    if (owned.length && !window.confirm(`Delete ${c.finish_tag} and its ${owned.length} takeoff${owned.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    const next = conditions.filter((x) => x.id !== id);
    // cascade delete of the condition's OWNED shapes — counted centrally by the
    // command, but record:false keeps it off the undo stack: the confirm just
    // said "can't be undone", and ⌘Z restoring shapes without their condition
    // would resurrect orphans
    if (owned.length) dispatchShape({ type: "delete", ids: owned.map((s) => s.id), reason: "condition-delete" }, { record: false });
    setConditions(next);
    unpinFromPalette(id);   // a deleted condition can't stay pinned in the palette
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

  // shape-label vocabulary (#110): a flat project-level list; each shape carries
  // at most one, on shape.label. Mirrors the column-value family above.
  const addLabel = (v) => setShapeLabels((ls) => (ls.includes(v) ? ls : [...ls, v]));
  const removeLabel = (v) => setShapeLabels((ls) => ls.filter((x) => x !== v));   // labeled shapes keep the string — it falls into an ad-hoc report group, nothing disappears from totals
  const renameLabel = (oldV) => {
    const newV = (window.prompt("Rename label:", oldV) || "").trim();
    if (!newV || newV === oldV) return;
    // rename into an existing value = merge (labels are unique — they key the chips and the report's group headers)
    setShapeLabels((ls) => (ls.includes(newV) ? ls.filter((x) => x !== oldV) : ls.map((x) => (x === oldV ? newV : x))));
    setShapes((sh) => renameShapeLabel(sh, oldV, newV));   // assignments follow the vocabulary
  };

  // supporting-materials editing (operates on the active condition)
  const addMaterial = () => updateCond({ materials: [...(aCond?.materials || []), { id: uid("mat"), name: "", per: 0, basis: "area", unit: "", round: true }] });
  const updateMaterial = (mid, patch) => updateCond({ materials: (aCond?.materials || []).map((m) => (m.id === mid ? matEditPatch(m, patch) : m)) });   // NAME edits re-classify a geometry-less line's kind
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
  // "Undo last shape" (toolbar/⌫) is NOT ⌘Z: it stays what it always was — a
  // DELETE of the newest shape on the focused sheets (a decision, so it still
  // counts toward the deletion tally, now via the command's central tally).
  // It records on the undo stack like any delete, so ⌘Z can resurrect it.
  function undoLast() {
    const mine = shapes.filter((x) => panelKeySet.has(x.sheet_id));
    if (!mine.length) return;
    dispatchShape({ type: "delete", ids: [mine[mine.length - 1].id], reason: "undo-last" });
  }

  const condById = Object.fromEntries(conditions.map((c) => [c.id, c]));
  const aCond = condById[activeCond];
  // resolve pinned ids to live conditions for the top-bar palette (a stale id
  // renders nothing — the persisted list is pruned on save/delete, this is the
  // render-time guard)
  const paletteConds = palette.map((id) => condById[id]).filter(Boolean);
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
  // A zone trace with points on more than one panel (side-by-side group mode,
  // a gap click routing to the neighboring panel): finishShape normalizes
  // every point against the FIRST point's panel, so a second-panel point
  // would land at nx > 1 — outside that panel's own [0..1] space — and the
  // overlay would still draw the dashed region exactly where traced,
  // visually enclosing rooms on the second sheet that shapesInZone (filtered
  // to a single sheet_id) can never count. Reject it outright — mirrors the
  // check tool's checkCross guard, the same hazard on a 2-point span.
  const zoneTraceCross = tool === "zone" && poly.length >= 1 && poly.some((p) => panelAt(p[0]).key !== panelAt(poly[0][0]).key);
  const condMult = aCond?.multiplier || 1;
  // HUD + Takeoffs panel are sheet-scoped ("this sheet"): they total the
  // VISIBLE shapes through the same conditionTotals rules the Report uses —
  // one source of role math, two scopes. Memoized: visRowById is a prop of the
  // memoized panel, so its identity must only change when the totals can.
  const visRows = useMemo(() => conditionTotals(conditions, visibleShapes), [conditions, visibleShapes]);
  const visRowById = useMemo(() => new Map(visRows.map((r) => [r.id, r])), [visRows]);
  // Zone check: the SAME conditionTotals rules on the shapes whose center point
  // sits inside the traced zone (lib/zone.js) — third scope of the one role math.
  const zoneShapes = useMemo(() => (zoneCheck ? shapesInZone(shapes, zoneCheck) : null), [shapes, zoneCheck]);
  const zoneRows = useMemo(
    () => (zoneShapes ? conditionTotals(conditions, zoneShapes).filter((r) => r.shape_count > 0) : null),
    [conditions, zoneShapes]
  );
  const zoneIds = useMemo(() => (zoneShapes ? new Set(zoneShapes.map((sh) => sh.id)) : null), [zoneShapes]);
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
  // unit-system display edge: internal math is always feet (lib/units.ts)
  const fa = (sf, d = 1) => `${num(areaVal(sf, units), d)} ${areaUnit(units)}`;
  const fl = (lf, d = 1) => `${num(lenVal(lf, units), d)} ${lenUnit(units)}`;
  const faSY = (sf) => (units === "metric" ? fa(sf) : `${num(sf)} SF · ${num(sf / 9)} SY`);
  const stdValue = unitsPerPx ? (STANDARD_SCALES.find((s) => Math.abs(s.upp - unitsPerPx) < 1e-9)?.label || "") : "";
  // Check tool: measured span at the current scale vs what the drawing says
  const checkPanel = check.length ? panelAt(check[0][0]) : null;
  const checkUpp = checkPanel ? uppFor(checkPanel.key) : null;
  const checkCross = check.length === 2 && panelAt(check[1][0]).key !== checkPanel.key;
  const checkPx = check.length === 2 && !checkCross ? Math.hypot(check[1][0] - check[0][0], check[1][1] - check[0][1]) : 0;
  const checkFeet = checkUpp && checkPx ? checkPx * checkUpp : null;
  const checkStatedFeet = parseLenInput(checkStated, units);
  const checkErrPct = checkFeet && checkStatedFeet > 0 ? ((checkFeet - checkStatedFeet) / checkStatedFeet) * 100 : null;

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
  const finishOk = ((tool === "area" || tool === "deduct") && poly.length >= 3) || (tool === "zone" && poly.length >= 3 && !zoneTraceCross) || ((tool === "linear" || tool === "surface") && poly.length >= 2);

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
  // The label analogue (#111): with a shape selected in Select mode this re-labels
  // it (mirroring activateCondition's reassign-on-activate); otherwise it just sets
  // the active label for subsequent traces. value "" / null = No label / clear.
  const activateLabel = (value) => {
    if (tool === "select" && selectedId) reassignSelectedLabel(value);
    setActiveLabel(value);
  };

  // ── top-bar quick-access palette (pinned conditions) ──────────────────────
  // A palette chip is a shortcut, not a new activation path: single-click routes
  // through activateCondition (same reassign/clear-selection semantics as the
  // strip and panel row); double-click opens the docked Takeoffs panel on that
  // condition — the "don't open the sidebar unless double-clicked" contract.
  const pinToPalette = (id) => {
    if (palette.includes(id)) return;   // already pinned — silent no-op (dropping a chip back on the band)
    if (palette.length >= PALETTE_MAX) { setCommitMsg(`Palette is full (${PALETTE_MAX}) — unpin one first.`); return; }
    setPalette((p) => (p.includes(id) || p.length >= PALETTE_MAX ? p : [...p, id]));
  };
  const unpinFromPalette = (id) => setPalette((p) => p.filter((x) => x !== id));
  // togglePin: the panel row's pushpin — pin if absent (respecting the cap),
  // unpin if already pinned. movePalette: drag one chip onto another to reorder
  // it to the target index (splice out, splice back in), which also renumbers
  // the 1–9 hotkeys since they follow palette order.
  const togglePin = (id) => setPalette((p) => (p.includes(id) ? p.filter((x) => x !== id) : (p.length >= PALETTE_MAX ? p : [...p, id])));
  const movePalette = (id, toIndex) => setPalette((p) => {
    const from = p.indexOf(id);
    if (from < 0 || toIndex < 0 || toIndex >= p.length || from === toIndex) return p;
    const next = p.slice();
    next.splice(from, 1);
    next.splice(toIndex, 0, id);
    return next;
  });
  const openConditionInPanel = (id) => {
    setPanelPrefs((p) => (p.collapsed ? { ...p, collapsed: false } : p));   // reveal the docked panel; no-op if already open
    activateCondition(id);   // highlight the row (reassigns a selected shape iff Select is armed, like every activation surface)
    // scroll the docked row into view AFTER the uncollapse paints — two rAFs so
    // the panel has mounted its list (the row carries data-cond-id)
    // CSS.escape the id — hydrate accepts hand-edited/older payloads, so an id
    // with quotes/brackets must not break the attribute selector
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`[data-cond-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" })));
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
    const dead = shapes.filter((s) => ids.has(s.condition_id));
    const owned = dead.length;
    // name what dies while the list still reads at a glance (≤5); count beyond
    const what = live.length <= 5 ? live.map((c) => c.finish_tag).join(", ") : `${live.length} conditions`;
    if (!window.confirm(`Delete ${what}${owned ? ` and their ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}? This can't be undone.`)) return false;
    setConditions((cs) => cs.filter((c) => !ids.has(c.id)));
    // same cascade rule as deleteCondition: counted centrally, off the stack
    if (owned) dispatchShape({ type: "delete", ids: dead.map((s) => s.id), reason: "condition-delete" }, { record: false });
    setPalette((p) => p.filter((id) => !ids.has(id)));   // deleted conditions can't stay pinned
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
    ...(c.laborType != null ? { laborType: c.laborType } : {}),
    ...(c.subfloorType != null ? { subfloorType: c.subfloorType } : {}),
    materials: (c.materials || []).map(({ id: _id, ...m }) => (m.grout ? { ...m, grout: { ...m.grout } } : m)),   // ids are minted on instantiation; grout never shared by reference
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
  // libFields / matFieldOverridden / the push+revert patch builders live in
  // lib/materials.js (pure, tested): they carry kind and the grout tile
  // geometry through every library copy, deep-copying grout at each point.
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
    if (lm) updateMaterial(m.id, libRevertPatch(m, lm, f));   // grout-derived per/note revert together with the geometry
  };
  const updateLibMaterial = (id, patch) => persistMatLib(matLib.map((x) => (x.id === id ? libEntryPatch(x, patch) : x)));   // hand-editing per/note detaches a grout entry's geometry
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
    setConditions((cs) => cs.map((c) => ({ ...c, materials: (c.materials || []).map((m) => (m.lib_id === libId ? libPushPatch(m, lm) : m)) })));
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
    onAddLabel: addLabel, onRenameLabel: renameLabel, onRemoveLabel: removeLabel,
    onAttachLibMaterial: attachLibMaterial, onPromoteMaterial: promoteMaterial, onRevertMatField: revertMatField,
    onUpdateLibMaterial: updateLibMaterial, onPushLibUpdate: pushLibUpdate,
    onDeleteLibMaterial: deleteLibMaterial, onAddLibMaterial: addLibMaterial,
    matFieldOverridden,   // pure helper, not an event handler — the forwarder returns its result
    onToggleCollapse: toggleTakeoffs, onTogglePin: togglePin,
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

  // ── two-deck toolbar (issue #61) ───────────────────────────────────────────
  // drafting-style group caption floated above a deck-2 cluster
  const cluster = (cap, children, style) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, position: "relative", paddingTop: 2, ...style }}>
      <span style={{ position: "absolute", top: -13, left: 1, fontFamily: "var(--f-mono)", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--ink-muted)", whiteSpace: "nowrap", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{cap}</span>
      {children}
    </span>
  );
  // MODE segmented control — shared border, ink-filled active (cobalt stays
  // reserved for the armed DRAW face so only one control ever claims it)
  const segBtn = (key, iconName, hint, last = false) => (
    <button key={key} type="button" onClick={() => setTool(key)} title={hint}
      style={{ display: "inline-flex", alignItems: "center", padding: "6px 9px", border: "none", borderRight: last ? "none" : "1px solid var(--ink-faint)", background: tool === key ? "var(--ink)" : "transparent", color: tool === key ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", lineHeight: 1 }}>
      <Icon name={iconName} size={15} />
    </button>
  );

  // deck-1 sheet-nav chip — ONE home for "which sheet am I on": pages, files,
  // group/ungroup and the gallery all live in its dropdown. Ungroup/Regroup
  // are sheet-set operations, so they move in here instead of appearing
  // mid-row and shifting everything after them.
  // assigned floor/level rides the sheet chip + page entries (sheet key: page 1 is the bare file name)
  const levelOfPage = (n) => sheetLevels[n > 1 ? `${active}#${n}` : active] || "";
  const sheetChipLabel = sheetGroup.length
    ? `${sheetGroup.length} sheets side-by-side`
    : `${levelOfPage(page) ? `${levelOfPage(page)} · ` : ""}${pageLabels[page] || (pageCount > 1 ? `Sheet ${page}` : active)}${pageCount > 1 ? ` · ${page}/${pageCount}` : ""}`;
  const sheetMenuItems = [];
  if (!sheetGroup.length && pageCount > 1) {
    sheetMenuItems.push({ section: "Sheets in this set" });
    for (let n = 1; n <= pageCount; n++) sheetMenuItems.push({ id: `pg-${n}`, label: `${levelOfPage(n) ? `${levelOfPage(n)} · ` : ""}${pageLabels[n] || `Sheet ${n}`}`, shortcut: `${n}/${pageCount}`, active: n === page, onSelect: () => setPage(n) });
  }
  if (!sheetGroup.length && sheets.length > 1) {
    sheetMenuItems.push({ section: "Files" });
    for (const s of sheets) sheetMenuItems.push({ id: `f-${s.name}`, label: s.name, active: s.name === active, onSelect: () => { setActive(s.name); setPage(1); } });
  }
  if (sheetMenuItems.length && (sheetGroup.length || lastGroup.length >= 2)) sheetMenuItems.push("divider");
  if (sheetGroup.length) sheetMenuItems.push({ id: "ungroup", label: "Ungroup — back to one sheet", title: "Back to one sheet — you land on the sheet you were last working; every sheet keeps its takeoffs and markups", onSelect: ungroup });
  if (!sheetGroup.length && lastGroup.length >= 2) sheetMenuItems.push({ id: "regroup", label: `Regroup (${lastGroup.length})`, title: `Side-by-side again with the same ${lastGroup.length} sheets — each keeps its own scale, takeoffs and markups`, onSelect: regroup });
  if (sheetMenuItems.length) sheetMenuItems.push("divider");
  sheetMenuItems.push({ id: "gallery", icon: "sheets", label: "Open gallery…", shortcut: "G", onSelect: () => setView("gallery") });

  // deck-2 scale chip — the four scale controls collapsed to one status face:
  // red dashed = unset ("you can't trace yet"), green = set, warning = the
  // plan notes a different scale than the one you picked
  const scaleDet = detectedScales[focusPanel.key];
  const scaleMismatch = !!(unitsPerPx && stdValue && scaleDet && Math.abs(scaleDet.upp - unitsPerPx) > 1e-9);
  const scaleFace = !unitsPerPx ? "Set scale…" : `${scaleMismatch ? "≠" : "✓"} ${stdValue || "custom"}`;
  const scaleFaceStyle = !unitsPerPx
    ? { border: "1px dashed var(--c-danger)", color: "var(--c-danger)" }
    : scaleMismatch
      ? { border: "1px solid var(--c-warning)", color: "var(--c-warning)" }
      : { border: "1px solid var(--c-positive)", color: "var(--c-positive)" };
  const scaleTitle = scaleMismatch
    ? `You set ${stdValue}, but the plan notes ${scaleDet.label} on ${labelFor(focusPanel)} — double-check before tracing.`
    : `Set the scale for ${labelFor(focusPanel)} — remembered per sheet${groupKeys.length > 1 ? " (targets the sheet you last clicked)" : ""}`;
  const scaleItems = [];
  // one-step revert after a rescale that changed committed quantities on this
  // sheet — the oops-hatch for a mistyped recalibrate (ephemeral, one slot)
  if (prevScale && prevScale.key === focusPanel.key && scales[focusPanel.key] !== prevScale.upp) {
    const wasLabel = STANDARD_SCALES.find((x) => Math.abs(x.upp - prevScale.upp) < 1e-9)?.label
      || (prevScale.source === "calibrated" ? "calibrated" : "custom");
    scaleItems.push({
      id: "revert-scale", icon: "undo",
      label: `Revert scale (was ${wasLabel})`,
      title: `Put ${labelFor(focusPanel)} back on the scale the last rescale replaced and re-price its takeoffs. One step, kept only until the sheet view changes — reverting is itself revertible.`,
      onSelect: revertScale,
    });
    scaleItems.push("divider");
  }
  if (scaleDet) {
    scaleItems.push({ section: "From the plan" });
    scaleItems.push({
      id: "use-detected", icon: "target", tint: "var(--c-positive)",
      label: `Plan says ${scaleDet.label}${scaleDet.multi ? " ±" : ""} — use it`,
      title: `The plan notes ${scaleDet.label} on ${labelFor(focusPanel)}${scaleDet.multi ? " — this sheet shows several scales (details are often larger); confirm against a known dimension" : ""}. Hover previews a calibrated guide bar on the sheet so you can sanity-check it.`,
      onSelect: () => { rescaleSheet(focusPanel.key, scaleDet.upp); setScaleSources((s) => ({ ...s, [focusPanel.key]: "detected" })); showScaleGuide(focusPanel.key, scaleDet.upp, scaleDet.label); },
      // hover previews the guide bar behind the open menu — only while the
      // sheet is still UNSCALED (upstream's gate: on a scaled sheet the bar
      // would advertise a scale the sheet is not using, on the very affordance
      // whose job is sanity-checking bar length). The preview dies on hover-out
      // AND on menu close however it happens (onScaleMenuDepth below) — an
      // ACCEPTED bar (onSelect) is not a preview and rides out its 8 s.
      onHover: (on) => { if (on) { if (!scales[focusPanel.key]) showScaleGuide(focusPanel.key, scaleDet.upp, scaleDet.label, true); } else clearPreviewGuide(); },
    });
  }
  scaleItems.push({ section: "Standard" });
  for (const s of STANDARD_SCALES) scaleItems.push({ id: s.label, label: s.label, active: stdValue === s.label, onSelect: () => { rescaleSheet(focusPanel.key, s.upp); setScaleSources((sc) => ({ ...sc, [focusPanel.key]: "standard" })); showScaleGuide(focusPanel.key, s.upp, s.label); } });
  scaleItems.push("divider");
  scaleItems.push({ id: "calibrate", icon: "calibrate", label: "Calibrate two points…", title: "Calibrate — click two points of a known dimension", active: tool === "calibrate", onSelect: () => setTool("calibrate") });
  scaleItems.push({ id: "check", icon: "check", label: "Check a dimension…", shortcut: "K", title: "Check a dimension (K) — click both ends of a printed dimension string; compares the measured length against what the drawing says", active: tool === "check", onSelect: () => setTool("check") });
  scaleItems.push({ note: "Remembered per sheet." });

  // One-Click fill sensitivity — lives in the render menu now, so arming
  // One-Click never reshapes the toolbar. Detents at Strict / Balanced /
  // Aggressive; the slider still tunes 0–100% freely, snapping to a notch when
  // released near one. Detents come from oneclick's canonical presets so UI
  // and flood math can't drift if a preset is ever retuned.
  const fillRow = (() => {
    const NOTCHES = [SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE];
    const label = fillSens === SENS_STRICT ? "Strict" : fillSens === SENS_BALANCED ? "Balanced" : fillSens === SENS_AGGRESSIVE ? "Aggressive" : `${Math.round(fillSens * 100)}%`;
    const snap = (v) => { for (const n of NOTCHES) if (Math.abs(v - n) <= 0.06) return n; return v; };
    return (
      <div title={"One-Click fill sensitivity — how far a fill reaches past a room's hatch pattern.\nStrict: stop at the linework (original behavior).\nBalanced: recover hatch-lined rooms to the walls (default).\nAggressive: cross more pattern and tolerate more growth.\nLower it if fills spill; raise it if hatched rooms come up short.\nScanned sheets trace from pixels — sensitivity doesn't apply there."}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Fill</span>
        <input name="fill-sensitivity" type="range" min={SENS_STRICT} max={SENS_AGGRESSIVE} step={0.01} value={fillSens} list="fill-sens-notches"
          onChange={(e) => setFillSens(snap(parseFloat(e.target.value)))}
          style={{ flex: 1, accentColor: "var(--cobalt)", cursor: "pointer" }} />
        <datalist id="fill-sens-notches"><option value={SENS_STRICT} /><option value={SENS_BALANCED} /><option value={SENS_AGGRESSIVE} /></datalist>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, fontWeight: 600, color: "var(--cobalt)", minWidth: 58 }}>{label}</span>
      </div>
    );
  })();

  return (
    // .app-shell: the print stylesheet collapses this 100vh flex column while the report is open
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files); }}
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* toolbar — two fixed decks (issue #61). Deck 1 = things you do to the
          PROJECT (open, navigate, export, account); deck 2 = things you do to
          the SHEET (arm tools, toggle aids, set scale). Neither row wraps, and
          conditional UI renders only into deck 2's reserved ACTION slot, so no
          control ever changes position. */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", padding: "6px 14px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-shadow)", whiteSpace: "nowrap" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--ink)", letterSpacing: "-0.02em" }}>open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span></strong>
        {/* team cloud mode: always a way to leave this project, plus a way to
            browse the rest of the team's projects when the build names a root
            — fixed presence for the whole session (cloudMode is set before the
            canvas mounts), so neither ever shifts deck-1 mid-work */}
        {cloudMode && (
          <button type="button" onClick={closeProject} title="Close this project and return to the local canvas"
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12.5, lineHeight: 1 }}>
            Close project
          </button>
        )}
        {cloudMode && browseProjects && (
          <button type="button" onClick={browseProjects} title="Back to your team's projects"
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12.5, lineHeight: 1 }}>
            Projects
          </button>
        )}
        <input name="sheet-file" ref={fileInputRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed" multiple style={{ display: "none" }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} title="Open plans — PDF, image, or a .zip plan set (or just drag them onto the canvas)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="plus" size={14} />Open</button>
        <button type="button" onClick={() => setView("gallery")}
          title={`Plan set — the visual gallery; open one or several sheets (G)${sheetGroup.length ? ` · ${sheetGroup.length} side-by-side now` : ""}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${sheetGroup.length ? "var(--cobalt)" : "var(--ink-faint)"}`, background: sheetGroup.length ? "var(--cobalt)" : "transparent", color: sheetGroup.length ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="sheets" size={15} />Sheets
        </button>
        {sheets.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={!!sheetGroup.length || page <= 1} title="Previous sheet"
              style={{ padding: "5px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", opacity: (!!sheetGroup.length || page <= 1) ? 0.4 : 1 }}><Icon name="chevronLeft" size={12} /></button>
            <ToolMenu
              title="Sheet — the sheets in this set, files, grouping, and the gallery"
              onOpenChange={onMenuDepth}
              face={<span style={{ display: "inline-block", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sheetChipLabel}</span>}
              faceStyle={{ fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 400, padding: "6px 8px" }}
              menuStyle={{ minWidth: 260, maxHeight: "min(480px, 60vh)", overflowY: "auto" }}
              items={sheetMenuItems}
            />
            <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={!!sheetGroup.length || page >= pageCount} title="Next sheet"
              style={{ padding: "5px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", opacity: (!!sheetGroup.length || page >= pageCount) ? 0.4 : 1 }}><Icon name="chevronRight" size={12} /></button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--ink-muted)", minWidth: 44, fontFamily: "var(--f-mono)" }}>{saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : ""}</span>
        <button onClick={toggleTheme} title="App theme — light / dark chrome (sheets unaffected; use ☾ on the canvas to invert the print)"
          aria-label="App theme — light / dark chrome" aria-pressed={theme === "dark"}
          style={{ display: "inline-flex", alignItems: "center", padding: "6px 9px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>
          {theme === "dark" ? "◐" : "◑"}
        </button>
        <button onClick={() => { setScheduleAnchor(null); setTool((t) => (t === "schedule" ? "select" : "schedule")); }}
          title="Import from schedule — arm, then drag a box around the finish/material schedule to create conditions (two clicks: corner, corner)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${tool === "schedule" ? "var(--cobalt)" : "var(--ink-faint)"}`, background: tool === "schedule" ? "var(--cobalt)" : "transparent", color: tool === "schedule" ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
          <Icon name="rectTool" size={15} />Schedule
        </button>
        <button onClick={() => setShowReport(true)} disabled={!conditions.length} title="Open the takeoff report — per-condition breakdown with waste, plus CSV / JSON export."
          style={{ padding: "8px 14px", border: "none", background: conditions.length ? "var(--ink)" : "var(--text-faint)", color: "var(--paper-bright)", cursor: conditions.length ? "pointer" : "default", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" }}>Report</button>
        {/* Deliberately subtle, not a button: local-first app, cloud mode is an
            opt-in extra. Only when ALREADY signed in (never a sign-in entry
            point in the toolbar — that lives solely on the landing link), no
            cloud project is open, and the build names a Projects root. */}
        {!cloudMode && googleUser && isGoogleConfigured() && projectHomeFolderId() && (
          <Link to="/projects" style={{ fontSize: 11.5, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>
            browse team projects
          </Link>
        )}
        <AccountChip note={cloudMode ? "Synced to Google Drive" : "Local workspace"} onOpenChange={onMenuDepth} />
      </div>

      {/* deck 2 — the work bar: drafting-style captions above each cluster */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", padding: "20px 14px 8px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", whiteSpace: "nowrap" }}>
        {cluster("Mode",
          <span style={{ display: "inline-flex", border: "1px solid var(--ink-faint)" }}>
            {segBtn("pan", "pan", "Pan (P) — or hold right-click / Space mid-measure")}
            {segBtn("select", "select", "Select (V) — pick a takeoff, drag points", true)}
          </span>
        )}
        {vRule}
        {cluster("Draw", <>
          <ToolMenu
            title="Measure — the face shows the armed tool"
            active={measureActive}
            onOpenChange={onMenuDepth}
            face={<><Icon name={faceTool.icon} size={15} /><span style={{ opacity: measureActive ? 1 : 0.6 }}>{faceTool.label}</span></>}
            items={MEASURE_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, onSelect: () => setTool(t.id) }))}
          />
          <ToolMenu
            title="Cut Out — subtract voids/columns (counts negative)"
            active={tool === "deduct"} accent="danger"
            onOpenChange={onMenuDepth}
            face={<><Icon name="deduct" size={15} /><span>Cut Out</span></>}
            items={CUT_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, tint: "var(--c-danger)", onSelect: () => setTool(t.id) }))}
          />
          <span style={{ position: "relative", display: "inline-flex" }}>
            <ToolMenu
              title="Markup — annotations, not measurements"
              active={MARKUP_IDS.includes(tool)}
              onOpenChange={onMenuDepth}
              face={<><Icon name="markup" size={15} /><span>Markup</span></>}
              items={MARKUP_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, onSelect: () => { setTool(t.id); setMarkupDraft(null); } }))}
            />
            {/* highlighter style popover — visible while the tool is armed (hatch-picker chrome) */}
            {tool === "highlighter" && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", gap: 6 }} title="Ink">
                  {HL_INKS.map((c) => (
                    <button key={c} onClick={() => setHlStyle((st) => ({ ...st, color: c }))}
                      style={{ width: 16, height: 16, padding: 0, background: c, border: hlStyle.color === c ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {HL_SIZES.map(([lbl, px]) => (
                    <button key={lbl} onClick={() => setHlStyle((st) => ({ ...st, size: px }))} title={`${lbl === "F" ? "Fine" : lbl === "M" ? "Medium" : "Broad"} tip`}
                      style={{ width: 22, height: 20, padding: 0, fontFamily: "var(--f-mono)", fontSize: 10, cursor: "pointer", border: hlStyle.size === px ? "1px solid var(--ink)" : "1px solid var(--ink-faint)", background: hlStyle.size === px ? "var(--ink)" : "transparent", color: hlStyle.size === px ? "var(--paper-bright)" : "var(--ink)" }}>{lbl}</button>
                  ))}
                  <span style={{ width: 1, alignSelf: "stretch", background: "var(--ink-faint)" }} />
                  {[["chisel", "M4 16 L14 6 L18 10 L8 20 Z"], ["round", "M5 17 Q12 3 19 13"]].map(([tip, d]) => (
                    <button key={tip} onClick={() => setHlStyle((st) => ({ ...st, tip }))} title={`${tip} tip`}
                      style={{ width: 24, height: 20, padding: 1, cursor: "pointer", border: hlStyle.tip === tip ? "1px solid var(--ink)" : "1px solid var(--ink-faint)", background: "transparent" }}>
                      <svg viewBox="0 0 24 24" width="18" height="14">{tip === "chisel"
                        ? <path d={d} fill="currentColor" stroke="none" />
                        : <path d={d} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />}</svg>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
          <ToolMenu
            title="Edit takeoffs"
            onOpenChange={onMenuDepth}
            face={<span>Edit</span>}
            items={[
              { id: "copy", icon: "copy", label: "Copy", shortcut: "⌘C", disabled: !selectedId, onSelect: copySelected },
              { id: "paste", icon: "paste", label: "Paste", shortcut: "⌘V", disabled: !clipRef.current.length, onSelect: () => pasteClipboard() },
              { id: "dup", icon: "duplicate", label: "Duplicate", shortcut: "⌘D", disabled: !selectedId, onSelect: duplicateSelected },
              "divider",
              { id: "flipH", label: "Flip Horizontal", disabled: !selectedId, onSelect: () => flipSelected("h") },
              { id: "flipV", label: "Flip Vertical", disabled: !selectedId, onSelect: () => flipSelected("v") },
              "divider",
              { id: "finish", icon: "check", label: `Finish shape${poly.length ? ` (${poly.length} pts)` : ""}`, shortcut: "↵", disabled: !finishOk, onSelect: finishShape },
              { id: "undopt", icon: "undo", label: "Undo last point", shortcut: "⌘Z", disabled: !poly.length, onSelect: () => setPoly((q) => q.slice(0, -1)) },
              { id: "undoshape", icon: "undo", label: "Undo last shape", disabled: !visibleShapes.length, onSelect: undoLast },
              { id: "redo", label: "Redo", shortcut: "⇧⌘Z", onSelect: redoShapeCommand },
              "divider",
              { id: "del", icon: "close", label: "Delete selected", shortcut: "⌫", disabled: !selectedId, tint: "var(--c-danger)", onSelect: deleteSelected },
            ]}
          />
        </>)}
        {vRule}
        {cluster("Aids", <>
          <button onClick={() => setTool((t) => (t === "zone" ? "select" : "zone"))}
            title="Zone check — trace a region (an apartment, a wing) to read every condition's quantities inside it, materials included. Nothing is saved; the outline clears when you leave the tool."
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${tool === "zone" ? "var(--cobalt)" : "var(--ink-faint)"}`, background: tool === "zone" ? "var(--cobalt)" : "transparent", color: tool === "zone" ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
            <Icon name="zone" size={15} />Zone
          </button>
          <button onClick={() => setSnapOn((v) => !v)} title="Snap to plan lines/corners (beta)"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${snapOn ? "var(--c-positive)" : "var(--ink-faint)"}`, background: snapOn ? "var(--c-positive)" : "transparent", color: snapOn ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
            <Icon name="snap" size={15} />Snap
          </button>
          <button onClick={() => setAngleOn((v) => !v)} title="45°/90° angle guides — the next segment locks to the 45° family as you draw (hold ⇧ to force the lock at any angle)"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${angleOn ? "var(--cobalt)" : "var(--ink-faint)"}`, background: angleOn ? "var(--cobalt)" : "transparent", color: angleOn ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
            <Icon name="angle" size={15} />45°
          </button>
          <ToolMenu
            title="Render & fill settings — Hi-Res and One-Click fill sensitivity"
            onOpenChange={onMenuDepth}
            face={<Icon name="sliders" size={15} />}
            menuStyle={{ minWidth: 252 }}
            items={[
              {
                id: "hires", icon: "hiRes", label: "Hi-Res render (this sheet)", checked: hiResOn(focusPanel.key), stayOpen: true, onSelect: toggleHiRes,
                title: `Hi-Res rendering for ${labelFor(focusPanel)} — the sheet re-rasters at an auto quality budget (~28MP), so memory stays bounded even side-by-side; crisper when zoomed in. Saved per sheet, per user. Quantities are unaffected.`,
              },
              "divider",
              { id: "fill", custom: fillRow },
            ]}
          />
        </>)}
        {/* The caption always shows the ACTIVE label (+ the cobalt highlight keyed
            on it) so what a new trace will get is never hidden — even in Select
            mode, where the dropdown VALUE instead shows the selected shape's label
            so changing it reliably re-labels that shape (a value-always-active
            select couldn't reassign to the already-active label — onChange wouldn't fire). */}
        {shapeLabels.length > 0 && cluster(
          tool === "select" && selectedId ? `Label · ${activeLabel || "none"} → shape` : (activeLabel ? `Label · ${activeLabel}` : "Label"),
          <select
            value={tool === "select" && selectedId ? shapeLabelValue(shapes.find((s) => s.id === selectedId)) : (activeLabel || "")}
            onChange={(e) => activateLabel(e.target.value || null)}
            title="Phase/area label. The caption shows the ACTIVE label (what new takeoffs get). With a shape selected (Select tool), the dropdown shows and re-labels that shape. Manage the list in the Columns tab."
            style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, padding: "5px 6px", border: `1px solid ${activeLabel ? "var(--cobalt)" : "var(--ink-faint)"}`, background: activeLabel ? "var(--cobalt)" : "transparent", color: activeLabel ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", maxWidth: 150 }}>
            <option value="">No label</option>
            {shapeLabels.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        {cluster(`Scale — ${labelFor(focusPanel)}`,
          <>
            <button onClick={() => setUnits((u) => (u === "metric" ? "imperial" : "metric"))}
              title={units === "metric" ? "Metric display (m² / m) — click for imperial. Calibrate in meters; 1:50-style scales in the list. Display only — stored takeoffs never change." : "Imperial display (SF / LF) — click for metric (m² / m, calibrate in meters, 1:50-style scales). Display only — stored takeoffs never change."}
              style={{ padding: "6px 10px", border: `1px solid ${units === "metric" ? "var(--cobalt)" : "var(--ink-faint)"}`, background: units === "metric" ? "var(--cobalt)" : "transparent", color: units === "metric" ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, lineHeight: 1 }}>
              {units === "metric" ? "m" : "ft"}
            </button>
            <ToolMenu
              title={scaleTitle}
              onOpenChange={onScaleMenuDepth}
              face={<span>{scaleFace}</span>}
              faceStyle={{ fontFamily: "var(--f-mono)", fontSize: 11.5, ...scaleFaceStyle }}
              menuStyle={{ minWidth: 250 }}
              items={scaleItems}
            />
          </>
        )}
        {cluster("Action",
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 150 }}>
            {markupDraft && (tool === "cloud" || tool === "callout" || tool === "highlight") && <span style={{ fontSize: 11, color: "var(--cobalt)" }}>click the {tool === "callout" ? "label spot" : "opposite corner"}…</span>}
            {finishOk && (
              <button onClick={finishShape} title="Finish shape (↵ or double-click)" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Finish ({poly.length})</button>
            )}
            {proposal?.regions.length > 0 && (
              <button onClick={createProposal} title="Create the selected takeoff(s) (↵). ⌫ removes the last click; Esc discards the selection." style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Create ({proposal.regions.length})</button>
            )}
          </span>
        )}
      </div>

      {/* quick-access condition palette — its own slim band under the toolbar
          (like the sheet-tabs / conditions-strip rows), not crammed into the
          already-wrapping top bar. A curated ≤9 pinned conditions for one-click
          activation without opening the panel: drag a condition here from the
          Takeoffs panel (or the strip) to pin it, or use a row's pushpin. Each
          chip carries its 1–9 hotkey badge (cobalt); single-click activates
          (reassigning a selected shape, like every activation surface),
          double-click opens the docked panel scrolled to that row, the pushpin
          unpins, and dragging one chip onto another reorders (which renumbers
          the hotkeys). Below the chips, the active condition's appearance editor
          — the same one the docked panel row renders — so line/fill/hatch/height
          are editable without opening the sidebar. Shown once there's a
          condition to pin, so the drop zone is discoverable. */}
      {conditions.length > 0 && (
        <div
          onDragOver={(e) => { if (e.dataTransfer.types.includes(CONDITION_DND_MIME)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={(e) => { if (!e.dataTransfer.types.includes(CONDITION_DND_MIME)) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData(CONDITION_DND_MIME); if (id) pinToPalette(id); }}
          style={{ padding: "5px 14px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span title="Quick-access conditions — drag a condition here (or use a row's pushpin) to pin it, up to 9. Press 1–9 to activate by this order; click a chip to activate; double-click to open the panel."
              style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--ink-muted)" }}>Conditions</span>
            {paletteConds.length === 0 ? (
              <span style={{ fontSize: 11.5, color: "var(--ink-muted)", fontStyle: "italic", padding: "3px 8px", border: "1px dashed var(--ink-faint)" }}>drag conditions here (or pin a row) for 1-9 one-click access</span>
            ) : paletteConds.map((c) => {
              const on = c.id === activeCond;
              const reassign = tool === "select" && selectedId;
              const idx = palette.indexOf(c.id);   // palette position → the 1–9 hotkey number
              return (
                <span key={c.id} style={{ display: "inline-flex", alignItems: "center" }}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes(CONDITION_DND_MIME)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(e) => { if (!e.dataTransfer.types.includes(CONDITION_DND_MIME)) return; e.preventDefault(); e.stopPropagation(); const dragId = e.dataTransfer.getData(CONDITION_DND_MIME); if (dragId) { if (palette.includes(dragId)) movePalette(dragId, idx); else pinToPalette(dragId); } }}>
                  <button type="button" draggable
                    onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copyMove"; }}
                    onClick={() => activateCondition(c.id)}
                    onDoubleClick={() => openConditionInPanel(c.id)}
                    title={reassign ? `Reassign the selected takeoff to ${c.finish_tag} (double-click opens the panel)` : `${c.finish_tag} — press ${idx + 1} or click to activate, double-click to open in the panel, drag onto another chip to reorder`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 5px", border: on ? `2px solid ${c.color}` : (reassign ? "1px dashed var(--cobalt)" : "1px solid var(--ink-faint)"), background: on ? "var(--surface-pop)" : "transparent", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 12.5, lineHeight: 1 }}>
                    {idx < 9 && <span style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: "var(--cobalt)", border: "1px solid var(--cobalt)", borderRadius: 3, padding: "0 3px" }}>{idx + 1}</span>}
                    <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>{c.finish_tag}
                  </button>
                  <button type="button" onClick={() => unpinFromPalette(c.id)} title={`Unpin ${c.finish_tag} from the palette`}
                    style={{ border: "none", background: "none", cursor: "pointer", color: "var(--cobalt)", padding: "0 3px", lineHeight: 0, display: "inline-flex" }}>
                    <Icon name="pin" size={12} />
                  </button>
                </span>
              );
            })}
            {paletteConds.length >= PALETTE_MAX && (
              <span style={{ fontSize: 10.5, color: "var(--ink-muted)", fontStyle: "italic" }}>full ({PALETTE_MAX})</span>
            )}
            {/* add a condition without opening the (now-collapsed) sidebar */}
            <button type="button" onClick={addCondition} title="Add a new condition"
              style={{ padding: "3px 9px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--ink-muted)" }}>+ condition</button>
          </div>
          {/* the active condition's appearance editor, restored to the top bar —
              same component the docked panel row renders (one source of truth) */}
          {aCond && (
            <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--ink-faint)" }}>
              <ConditionAppearanceEditor cond={aCond} onUpdateCond={updateCond} onSetCondParam={setCondParam} onAssignAttr={assignAttr} conditionColumns={conditionColumns} layout="row" />
            </div>
          )}
        </div>
      )}

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
              onOpenChange={onMenuDepth}
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
            // the 1–9 badge follows the same rule as the hotkeys: palette order
            // when curated, condition order (fallback) when nothing is pinned
            const pinnedPal = palette.length > 0;
            const hIdx = pinnedPal ? palette.indexOf(c.id) : i;
            const hot = hIdx >= 0 && hIdx < 9;
            return (
              <button key={c.id} draggable onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copy"; }} onClick={() => activateCondition(c.id)} title={tool === "select" && selectedId ? "Reassign selected shape to this condition" : (hot ? `Press ${hIdx + 1} · drag to the palette to pin` : "Drag to the palette to pin")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 0, border: on ? `2px solid ${c.color}` : (tool === "select" && selectedId ? "1px dashed var(--cobalt)" : "1px solid var(--ink-faint)"), background: on ? "var(--surface-pop)" : "transparent", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 12.5 }}>
                {hot && <span style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: pinnedPal ? "var(--cobalt)" : "var(--ink-muted)", border: `1px solid ${pinnedPal ? "var(--cobalt)" : "var(--ink-faint)"}`, borderRadius: 3, padding: "0 3px" }}>{hIdx + 1}</span>}
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>{c.finish_tag}
              </button>
            );
          })}
          <button onClick={addCondition} style={{ padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
        </div>
      )}

      {/* calibration prompt */}
      {tool === "calibrate" && (
        <div style={{ padding: "8px 14px", background: "var(--paper-bright)", borderBottom: "1px solid var(--hairline-warm)", fontSize: 14 }}>
          {calib.length < 2 ? <span>Custom scale: click two points along a known dimension ({calib.length}/2). Tip: use the longest dimension. (Or just pick a standard scale above.)</span> : (
            <span>Real length:{" "}
              <input name="calibration-length" type="number" value={pendingLen} onChange={(e) => setPendingLen(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCalibration()} placeholder={units === "metric" ? "meters" : "feet"} autoFocus style={{ width: 90, padding: 5, borderRadius: 0, border: "1px solid var(--ink-faint)" }} /> {units === "metric" ? "m" : "ft"}
              <button onClick={applyCalibration} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 0, border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer" }}>Apply</button>
              <button onClick={() => setCalib([])} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button>
            </span>
          )}
        </div>
      )}

      {/* check-a-dimension prompt — read-only twin of calibrate: measure a printed
          dimension at the current scale, compare with what the drawing says */}
      {tool === "check" && (
        <div style={{ padding: "8px 14px", background: "var(--paper-bright)", borderBottom: "1px solid var(--hairline-warm)", fontSize: 14 }}>
          {check.length < 2 ? (
            <span>Check a dimension: click both ends of a printed dimension ({check.length}/2). The measured length shows here — compare it with what the drawing says.</span>
          ) : checkCross ? (
            <span style={{ color: "var(--c-danger)" }}>Check on one sheet — those two clicks landed on different sheets. <button onClick={() => { setCheck([]); setCheckStated(""); }} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button></span>
          ) : !checkUpp ? (
            <span style={{ color: "var(--c-danger)" }}>No scale set for {labelFor(checkPanel)} — pick a standard scale or calibrate first, then check it here.</span>
          ) : checkPx <= 0 ? (
            <span style={{ color: "var(--c-danger)" }}>Those two clicks landed on the same point — click the two <b>ends</b> of a printed dimension.</span>
          ) : (
            <span>
              measures <b style={{ fontFamily: "var(--f-mono)" }}>{fmtCheckLen(checkFeet, units)}</b> at {stdValue || "custom scale"} · drawing says{" "}
              <input name="check-stated-length" value={checkStated} onChange={(e) => setCheckStated(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder={units === "metric" ? "meters" : `feet (12'6, 6" ok)`} autoFocus style={{ width: 100, padding: 5, borderRadius: 0, border: "1px solid var(--ink-faint)" }} /> {units === "metric" ? "m" : "ft"}
              {checkErrPct != null && (() => {
                // checkVerdict grades the ROUNDED value the chip displays (and
                // normalizes -0), so color and number can never contradict —
                // see units.ts for the ≤1/≤5 tie-break rationale
                const v = checkVerdict(checkErrPct);
                const pct = `${v.shown >= 0 ? "+" : ""}${v.shown.toFixed(1)}%`;
                return (
                  <b style={{ marginLeft: 8, color: v.grade === "match" ? "var(--c-positive)" : v.grade === "close" ? "var(--c-warning)" : "var(--c-danger)" }}>
                    {v.grade === "match" ? `matches — scale checks out (${pct})`
                      : v.grade === "close" ? `off by ${pct} — re-check or recalibrate`
                      : `off by ${pct} — wrong scale; recalibrate`}
                  </b>
                );
              })()}
              {checkStatedFeet > 0 && (
                <button onClick={recalibrateFromCheck} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 0, border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer" }}>Recalibrate to this</button>
              )}
              <button onClick={() => { setCheck([]); setCheckStated(""); }} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button>
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
           <div style={{ display: "flex", alignItems: "stretch", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
             {[{ id: "markup", label: "Markups", n: markupCount }, { id: "stamp", label: "Stamps", n: stampLib.stamps.length }, { id: "rfi", label: "RFIs", n: rfis.length }].map((t) => (
               <button key={t.id} onClick={() => setLeftTab(t.id)} title={t.label}
                 style={{ flex: 1, padding: "9px 6px", border: "none", borderBottom: leftTab === t.id ? "2px solid var(--accent-contrast)" : "2px solid transparent", background: leftTab === t.id ? "rgba(255,255,255,.18)" : "transparent", color: "var(--accent-contrast)", cursor: "pointer", fontWeight: leftTab === t.id ? 700 : 500, fontSize: 12 }}>
                 {t.label}{t.n ? ` · ${t.n}` : ""}
               </button>
             ))}
             <button onClick={() => setLeftTab(null)} title="Close panel" style={{ padding: "0 12px", border: "none", background: "transparent", color: "var(--accent-contrast)", fontSize: 16, cursor: "pointer" }}>×</button>
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
                       <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cobalt)", textTransform: "uppercase" }}>{m.type}</span>
                       {/* inline edit — the panel's fallback for the canvas overlay, since a
                           markup here may be off-screen or on another sheet (no click point).
                           Enter/blur commit, Esc cancels; INPUT is guarded from the global keys. */}
                       {panelEditId === m.id ? (
                         <input name="markup-text" autoComplete="off" autoFocus defaultValue={m.text || ""}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); } else if (e.key === "Escape") { e.preventDefault(); e.currentTarget.value = m.text || ""; setPanelEditId(null); } }}
                           onBlur={(e) => { updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); }}
                           style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "1px 4px", border: "1px solid var(--cobalt)", borderRadius: 0, outline: "none" }} />
                       ) : (
                         <span style={{ flex: 1, color: "var(--ink)" }}>{m.type === "svg" ? <em style={{ color: "var(--ink-muted)" }}>(vector symbol)</em> : (m.text || <em style={{ color: "var(--ink-muted)" }}>(no text)</em>)}</span>
                       )}
                       {m.type !== "svg" && <button onClick={() => setPanelEditId((id) => (id === m.id ? null : m.id))} title="Edit text" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)" }}>✎</button>}
                       <button onClick={() => deleteMarkup(m.id)} title="Delete markup" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)" }}>🗑</button>
                     </div>
                     {/* appearance — per-markup color (reuse PALETTE) + line style; both
                         additive: unset color falls back to the cobalt(linked)/amber default,
                         unset style to solid. The RFI ⬢/number badge stays cobalt regardless. */}
                     <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 7, flexWrap: "wrap" }}>
                       <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginRight: 2 }}>Color</span>
                       <button title="Auto (linkage color)" onClick={() => updateMarkup(m.id, { color: "" })} style={{ width: 26, height: 15, borderRadius: 4, background: "var(--paper-bright)", border: !m.color ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 8.5, lineHeight: "11px", color: "var(--ink-muted)" }}>auto</button>
                       {PALETTE.map((c) => <button key={c} title={c} onClick={() => updateMarkup(m.id, { color: c })} style={{ width: 15, height: 15, borderRadius: 4, background: c, border: m.color === c ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
                       <select name="markup-line-style" value={m.line_style || "solid"} onChange={(e) => updateMarkup(m.id, { line_style: e.target.value })} title="Line style" style={{ marginLeft: 4, fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
                         {LINE_STYLE_IDS.map((id) => <option key={id} value={id}>{LINE_STYLES[id].label}</option>)}
                       </select>
                       {/* line weight — a multiplier over the element's base stroke width (default
                           ×1, clamped 0.5–3); additive, absent = ×1 so legacy markups are unchanged */}
                       <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginLeft: 4 }}>Weight</span>
                       <select name="markup-weight" value={String(snapWeight(m.weight))} onChange={(e) => updateMarkup(m.id, { weight: Number(e.target.value) })} title="Line weight (× base)" style={{ fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
                         {WEIGHT_STEPS.map((wv) => <option key={wv} value={wv}>{wv}×</option>)}
                       </select>
                       {/* revision-delta △n — clouds only; blank clears it (no delta drawn) */}
                       {m.type === "cloud" && (
                         <>
                           <span style={{ fontSize: 10.5, color: "var(--ink-muted)", marginLeft: 4 }} title="Revision-delta number (△) drawn at a cloud corner">Rev △</span>
                           <input name="markup-rev" type="number" min="0" step="1" value={Number.isFinite(m.rev) ? m.rev : ""} placeholder="—"
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
                               <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 700, color: "var(--cobalt)" }}>⬢ {String(linked.number ?? "")}</span>
                               <button onClick={() => { setLeftTab("rfi"); }} style={{ ...ctrl, color: "var(--cobalt)" }} title="Open the RFI register">Open</button>
                               <button onClick={() => unlinkRfi(m)} style={{ ...ctrl, color: "var(--ink-muted)" }} title="Unlink this markup from its RFI">Unlink</button>
                             </>
                           ) : (
                             <>
                               <button onClick={() => raiseRfi(m)} style={{ ...ctrl, color: "var(--cobalt)", fontWeight: 600 }} title="Create a new RFI from this markup">Raise RFI</button>
                               {rfis.length > 0 && (
                                 <select name="link-rfi" value="" onChange={(e) => { if (e.target.value) linkRfi(m, e.target.value); }}
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
          onDoubleClick={(e) => { if (tool === "oneclick") { if (proposal?.regions.length) createProposal(); } else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface" || tool === "zone") finishShape(); else if (tool === "select") editMarkupAt(e); }}
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
            <input name="inline-editor" autoComplete="off" ref={editorInputRef} autoFocus defaultValue={editor.value}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finishEditor(true); } else if (e.key === "Escape") { e.preventDefault(); finishEditor(false); } }}
              onBlur={() => finishEditor(true)}
              placeholder="Type, Enter to place · Esc cancels"
              style={{ position: "absolute", left: editor.left, top: editor.top, zIndex: 9, minWidth: 160, padding: "3px 6px", font: "13px var(--f-body, sans-serif)", color: "var(--ink)", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "0 2px 10px rgba(0,0,0,.18)", borderRadius: 0, cursor: "text", outline: "none" }} />
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
                const pShapes = visibleShapes.filter((s) => s.sheet_id === p.key);
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
                      const s = tf.scale;
                      const grip = darkMode ? "#0b0e14" : "#faf6ea";
                      const edges = closed ? qs.length : qs.length - 1;
                      return (
                        <g>
                          {/* edge grips — drag moves the whole line; Shift-click inserts a point */}
                          {Array.from({ length: edges }, (_, i) => {
                            const a = qs[i], b = qs[(i + 1) % qs.length];
                            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                            const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
                            const ew = 14 / s, eh = 6 / s;
                            return <rect key={"m" + i} x={mx - ew / 2} y={my - eh / 2} width={ew} height={eh} rx={eh / 2}
                              transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke="#1f3fc7" strokeWidth={1.6 / s} />;
                          })}
                          {/* corner handles — click selects (Delete removes just that point), drag moves */}
                          {qs.map(([x, y], i) => {
                            const isSel = selVert === i;
                            const sz = (isSel ? 6.5 : 5.5) / s;
                            return <g key={"h" + i}>
                              {isSel && <circle cx={x} cy={y} r={9 / s} fill="none" stroke="#1f3fc7" strokeWidth={1.2 / s} opacity={0.5} />}
                              <path d={`M${x},${y - sz} L${x + sz},${y} L${x},${y + sz} L${x - sz},${y} Z`}
                                fill={isSel ? grip : "#1f3fc7"} stroke={isSel ? "#1f3fc7" : "#fff"} strokeWidth={(isSel ? 2 : 1.4) / s} />
                            </g>;
                          })}
                        </g>
                      );
                    })()}
                    {/* markup layer — highlights / clouds / callouts / text notes on this
                        panel. Highlights draw FIRST (behind) so their translucent fill never
                        dims the linework above. A selected markup wears a CONTRASTING halo
                        (white outer ring + cobalt inner). Per-markup color drives the STROKE/
                        FILL (dark-boosted on the dark canvas); RFI linkage is an unconditional
                        ⬢/number badge, independent of the note text. Layer hides via showMarkups. */}
                    {showMarkups && visibleMarkups.filter((m) => m.sheet_id === p.key)
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
                      if (m.type === "highlight" && Array.isArray(m.pts)) {
                        // freehand highlighter stroke — the ink keeps its OWN hue (a highlight
                        // IS its color; dark legibility comes from the higher opacity, not a
                        // boost). Weight (×) multiplies the stored width like every markup.
                        const ip = m.pts.map(([nx, ny]) => [nx * p.img.w, ny * p.img.h]);
                        if (ip.length < 2) return null;
                        const sw = (m.w || 0.01) * p.img.w * w, o = darkMode ? 0.42 : 0.32;
                        const ink = m.tip === "chisel"
                          ? <path d={"M" + chiselRibbon(ip, sw, 45).map((q) => q.join(",")).join(" L") + " Z"} fill={m.color || "#ffd60a"} fillOpacity={o} />
                          : <path d={strokePathD(ip)} fill="none" stroke={m.color || "#ffd60a"} strokeOpacity={o} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
                        return (
                          <g key={m.id}>
                            {/* selection halo follows the stroke's spine (white outer + cobalt
                                inner, the selected-markup convention adapted to an open path) */}
                            {selM && (
                              <>
                                <path d={strokePathD(ip)} fill="none" stroke="#fff" strokeWidth={sw + 8 / z} strokeLinecap="round" strokeLinejoin="round" />
                                <path d={strokePathD(ip)} fill="none" stroke="#1f3fc7" strokeOpacity={0.55} strokeWidth={sw + 4 / z} strokeLinecap="round" strokeLinejoin="round" />
                              </>
                            )}
                            {ink}
                            {badge(ip[0][0], ip[0][1] - 9 / z)}
                          </g>
                        );
                      }
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
                    {/* zone check — transparent dashed region + a cobalt trace on every counted shape */}
                    {zoneCheck && zoneCheck.key === p.key && (
                      <g style={{ pointerEvents: "none" }}>
                        <polygon points={zoneCheck.pts.map(([nx, ny]) => `${nx * p.img.w},${ny * p.img.h}`).join(" ")}
                          fill="rgba(31,63,199,.06)" stroke="#1f3fc7" strokeWidth={2 / tf.scale}
                          strokeDasharray={`${7 / tf.scale} ${5 / tf.scale}`} />
                        {zoneIds && pShapes.filter((sh) => zoneIds.has(sh.id)).map((sh) => {
                          const vs = sh.verts_norm || [];
                          if (vs.length < 2) {
                            return <circle key={"zc" + sh.id} cx={(vs[0]?.[0] || 0) * p.img.w} cy={(vs[0]?.[1] || 0) * p.img.h}
                              r={7 / tf.scale} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={2.5 / tf.scale} />;
                          }
                          // Closed roles (floor_area/deduct) get a <polygon> like the
                          // main shape renderer — a <polyline> never draws the
                          // closing edge back to the first vertex, so a 4-vertex
                          // room's glow was missing 25% of its outline. linear/
                          // surface_area are genuinely open runs, so they keep
                          // <polyline>, also matching the main renderer.
                          const closed = sh.measure_role !== "linear" && sh.measure_role !== "surface_area";
                          const pts = vs.map(([nx, ny]) => `${nx * p.img.w},${ny * p.img.h}`).join(" ");
                          return closed
                            ? <polygon key={"zc" + sh.id} points={pts} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={3.5 / tf.scale} strokeLinejoin="round" />
                            : <polyline key={"zc" + sh.id} points={pts} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={3.5 / tf.scale} strokeLinejoin="round" />;
                        })}
                      </g>
                    )}
                    {/* One-Click proposal preview — dashed cobalt selection, red dashed carve.
                        Handles (corner diamonds + edge grips) rise on the hovered/selected
                        region: drag a corner, drag an edge to move the whole line, Shift-click
                        an edge to add a point, select a corner + Delete to remove it. */}
                    {proposal && proposal.key === p.key && proposal.regions.map((r, i) => {
                      const col = r.kind === "neg" ? "#b03a26" : "#1f3fc7";
                      const s = tf.scale;
                      const grip = darkMode ? "#0b0e14" : "#faf6ea";
                      const show = i === ocHover || (ocSel && ocSel.ri === i);
                      return (
                      <g key={"oc" + i}>
                        <polygon points={r.poly.map((q) => q.join(",")).join(" ")}
                          fill={r.kind === "neg" ? "rgba(176,58,38,.18)" : "rgba(31,63,199,.10)"}
                          stroke={col} strokeWidth={2.5 / s} strokeDasharray={`${7 / s} ${4 / s}`} />
                        <path d={starPath(r.seed[0], r.seed[1], 5 / s)} fill={col} stroke="#fff" strokeWidth={1 / s} />
                        {show && r.poly.map((a, k) => {
                          const b = r.poly[(k + 1) % r.poly.length];
                          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
                          const w = 14 / s, h = 6 / s;
                          return <rect key={"e" + k} x={mx - w / 2} y={my - h / 2} width={w} height={h} rx={h / 2}
                            transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke={col} strokeWidth={1.6 / s} />;
                        })}
                        {show && r.poly.map(([x, y], k) => {
                          const isSel = ocSel && ocSel.ri === i && ocSel.vi === k;
                          const sz = (isSel ? 6.5 : 5.5) / s;
                          return <g key={"v" + k}>
                            {isSel && <circle cx={x} cy={y} r={9 / s} fill="none" stroke={col} strokeWidth={1.2 / s} opacity={0.5} />}
                            <path d={`M${x},${y - sz} L${x + sz},${y} L${x},${y + sz} L${x - sz},${y} Z`}
                              fill={isSel ? grip : col} stroke={isSel ? col : "#fff"} strokeWidth={(isSel ? 2 : 1.4) / s} />
                          </g>;
                        })}
                      </g>
                      );
                    })}
                    {/* Agent proposals — DASHED pencil pending the accept gate. A
                        finer dash than one-click's selection so the two proposal
                        kinds read apart; the seed star marks the flood seed. The
                        native SVG <title> is the evidence tooltip. Click-to-accept
                        only under the non-drawing tools (select/pan) so a live
                        trace over a proposal is never swallowed; the panel rows
                        and ⏎ accept regardless of tool. */}
                    {agentProposals.filter((ap) => ap.sheet_id === p.key).map((ap) => {
                      const s = tf.scale;
                      const pts = ap.verts_norm.map(([x, y]) => [x * p.img.w, y * p.img.h]);
                      const ded = ap.measure_role === "deduct";
                      const col = ded ? "#b03a26" : "#1f3fc7";
                      const clickable = tool === "select" || tool === "pan";
                      const ev = ap.evidence || {};
                      const evBits = [
                        ev.schedule_row_tag ? `schedule ${ev.schedule_row_tag}` : "",
                        ev.matched_text && ev.matched_text !== ev.schedule_row_tag ? `matched "${ev.matched_text}"` : "",
                        Array.isArray(ev.seed_norm) ? "seeded by one-click" : "",
                      ].filter(Boolean).join(", ");
                      return (
                        <g key={ap.id} style={{ pointerEvents: clickable ? "auto" : "none", cursor: clickable ? "pointer" : undefined }}
                          onPointerDown={(e) => { if (clickable) e.stopPropagation(); }}
                          onClick={(e) => { if (clickable) { e.stopPropagation(); acceptAgentProposal(ap.id); } }}>
                          <title>{`Agent proposal — ${condById[ap.condition_id]?.finish_tag || "?"}${ded ? " (deduct)" : ""}, ${fa(ap.area_sf)}. ${evBits ? `Evidence: ${evBits}. ` : ""}Click to accept (⏎ accepts all visible); reject from the Agent panel.`}</title>
                          <polygon points={pts.map((q) => q.join(",")).join(" ")}
                            fill={ded ? "rgba(176,58,38,.10)" : "rgba(31,63,199,.07)"}
                            stroke={col} strokeOpacity={0.9} strokeWidth={2 / s}
                            strokeDasharray={`${3.5 / s} ${3.5 / s}`} strokeLinejoin="round" />
                          {Array.isArray(ap.seed_norm) && (
                            <path d={starPath(ap.seed_norm[0] * p.img.w, ap.seed_norm[1] * p.img.h, 4.5 / s)}
                              fill={col} fillOpacity={0.85} stroke="#fff" strokeWidth={1 / s} />
                          )}
                        </g>
                      );
                    })}
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
              <path ref={hlPathRef} style={{ display: "none" }} />
              {poly.length >= 2 && (tool === "linear" || tool === "surface"
                ? <polyline points={poly.map((p) => p.join(",")).join(" ")} fill="none" stroke={tool === "surface" ? activeColor : "#1f3fc7"} strokeWidth={(tool === "surface" ? 3.5 : 2.5) / tf.scale} strokeDasharray={tool === "surface" ? `${10 / tf.scale} ${3 / tf.scale} ${2 / tf.scale} ${3 / tf.scale}` : undefined} strokeLinecap="round" strokeLinejoin="round" />
                : <polygon points={poly.map((p) => p.join(",")).join(" ")} fill={poly.length >= 3 ? (tool === "deduct" ? "rgba(176,58,38,.22)" : tool === "zone" ? "rgba(31,63,199,.06)" : shapeFill(aCond)) : "none"} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={2 / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : undefined} />)}
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
              {/* check tool — dashed so it never reads as calibrate's solid line */}
              {tool === "check" && check.length === 2 && !checkCross && (
                <>
                  <line x1={check[0][0]} y1={check[0][1]} x2={check[1][0]} y2={check[1][1]} stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${6 / tf.scale} ${4 / tf.scale}`} />
                  {checkFeet != null && (
                    <text x={(check[0][0] + check[1][0]) / 2} y={(check[0][1] + check[1][1]) / 2 - 8 / tf.scale}
                      fontSize={12.5 / tf.scale} fontWeight={700} fill="#1f3fc7" textAnchor="middle"
                      stroke="#fff" strokeWidth={3 / tf.scale} paintOrder="stroke">{fmtCheckLen(checkFeet, units)}</text>
                  )}
                </>
              )}
              {tool === "check" && check.map((p, i) => <path key={"ck" + i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill="#1f3fc7" />)}
              {/* scale-acceptance guide — an ephemeral calibrated ruler so a 2×-off
                  scale is visually obvious against known elements (a door is ~3′) */}
              {scaleGuide && panelKeySet.has(scaleGuide.key) && (() => {
                const [gx, gy] = scaleGuide.at;
                const z = tf.scale;
                const unitPx = scaleGuide.px / (units === "metric" ? scaleGuide.feet * M_PER_FT : scaleGuide.feet); // one ft (or 1 m) in px
                const step = unitPx * z >= 6 ? 1 : unitPx * z * 5 >= 6 ? 5 : 0;
                const nUnits = units === "metric" ? Math.round(scaleGuide.feet * M_PER_FT) : scaleGuide.feet;
                const ticks = step ? Array.from({ length: Math.floor(nUnits / step) + 1 }, (_, i) => i * step) : [0, nUnits];
                // "at 1/8″ = 1′-0″" reads right for a scale string; a source word ("calibrated", "custom") reads better parenthesized
                const scaleTxt = /[=:]/.test(scaleGuide.label) ? `at ${scaleGuide.label}` : `(${scaleGuide.label})`;
                const lbl = units === "metric" ? `${nUnits} m ${scaleTxt}` : `${scaleGuide.feet}′ ${scaleTxt}`;
                const cap = units === "metric" ? "a door is about 0.9 m — if this bar looks wildly off, the scale is wrong" : "a door opening is about 3′ — if this bar looks wildly off, the scale is wrong";
                return (
                  <g style={{ pointerEvents: "none" }}>
                    <line x1={gx} y1={gy} x2={gx + scaleGuide.px} y2={gy} stroke="#fff" strokeWidth={7 / z} strokeLinecap="round" />
                    <line x1={gx} y1={gy} x2={gx + scaleGuide.px} y2={gy} stroke="#1f3fc7" strokeWidth={3 / z} />
                    {ticks.map((u) => (
                      <line key={u} x1={gx + u * unitPx} y1={gy - (u % 5 === 0 ? 8 : 5) / z} x2={gx + u * unitPx} y2={gy}
                        stroke="#1f3fc7" strokeWidth={(u % 5 === 0 ? 2 : 1.2) / z} />
                    ))}
                    <text x={gx + scaleGuide.px / 2} y={gy - 14 / z} fontSize={13 / z} fontWeight={700} fill="#1f3fc7"
                      textAnchor="middle" stroke="#fff" strokeWidth={3.5 / z} paintOrder="stroke">{lbl}</text>
                    <text x={gx + scaleGuide.px / 2} y={gy + 16 / z} fontSize={10.5 / z} fill="#5b544a"
                      textAnchor="middle" stroke="#fff" strokeWidth={3 / z} paintOrder="stroke">{cap}</text>
                  </g>
                );
              })()}
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
              {status === "error" && <span style={{ color: "var(--c-danger)" }}>Error: {err}</span>}
            </div>
          )}

          {/* zoom buttons — stop left presses here: the container's onPointerDown
              setPointerCapture()s every left press, which retargets the pointerup
              and the composed click never reaches these buttons. Right/middle/
              Space presses still bubble so a pan can start on top of the stack,
              and dblclick is stopped so rapid zoom clicks can't finishShape() */}
          <div onPointerDown={(e) => { if (e.button === 0 && !spaceRef.current) e.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}
            style={{ position: "absolute", left: 14, bottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {[["+", 1.25], ["−", 0.8]].map(([lbl, f]) => (
              <button key={lbl} onClick={() => { const r = containerRef.current.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, f); }}
                style={{ width: 34, height: 34, borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>{lbl}</button>
            ))}
            <button onClick={() => stage.w && fitToView(stage.w, stage.h)} title="Fit" style={{ width: 34, height: 34, borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>fit</button>
            <button onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Sheet back to positive print" : "Invert sheet — negative print (affects marked-set export)"}
              style={{ width: 34, height: 34, borderRadius: 0, border: `1px solid ${darkMode ? "var(--cobalt)" : "var(--ink-faint)"}`, background: darkMode ? "var(--cobalt)" : "var(--paper-bright)", color: darkMode ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontSize: 13 }}>
              {darkMode ? "☀" : "☾"}</button>
          </div>
        </div>

        {/* status line — the transient message bar (was the right end of the old
            conditions bar): floats bottom-center over the canvas, never blocks input */}
        {commitMsg && (
          <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", maxWidth: "70%", zIndex: 6, pointerEvents: "none", padding: "6px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-1)", fontSize: 12, color: isDangerMsg(commitMsg) ? "var(--c-danger)" : "var(--c-positive)" }}>
            {commitMsg}
          </div>
        )}

        {/* live readout — top-right. Height is capped short of the panel rail's centered
            band (same right:14 column) so populated totals never cover the rail buttons. */}
        <div style={{ position: "absolute", right: 14, top: 14, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, padding: "12px 16px", minWidth: 200, maxWidth: 260, maxHeight: "calc(50% - 110px)", overflowY: "auto", boxShadow: "0 4px 18px rgba(0,0,0,.12)", fontVariantNumeric: "tabular-nums", zIndex: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool === "zone" ? "Zone check" : (aCond?.finish_tag || "No condition")}</div>
          {tool === "oneclick" && proposal?.regions.length ? (() => {
            const pos = proposal.regions.filter((r) => r.kind === "pos");
            const neg = proposal.regions.filter((r) => r.kind === "neg");
            const sf = pos.reduce((n, r) => n + r.area_sf, 0) - neg.reduce((n, r) => n + r.area_sf, 0);
            return (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cobalt)" }}>{num(areaVal(sf, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} selected</span></div>
                <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{pos.length} space{pos.length === 1 ? "" : "s"}{neg.length ? ` − ${neg.length} cutout${neg.length === 1 ? "" : "s"}` : ""}{units === "metric" ? "" : ` · ${num(sf / 9)} SY`}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>{ocSel ? "drag to move · Delete drops this point · Esc deselects" : "hover a fill to edit: drag a corner or edge · shift-click an edge adds a point"}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>click adds a space · ⌥-click carves a cutout · ⏎ Create · ⌫ undo · Esc cancel</div>
                {proposal.regions.some((r) => r.rt) && (
                  <div style={{ fontSize: 11.5, color: "var(--c-warning)", marginTop: 4 }}>Traced from scan pixels — verify edges before Create.</div>
                )}
              </>
            );
          })() : tool === "surface" && poly.length >= 2 && liveUpp ? (
            (() => {
              const liveLF = openLen(poly) * liveUpp;
              return condH > 0 ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>{num(areaVal(liveLF * condH, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} wall</span></div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{fl(liveLF)} × {num(condH, 2)} ft</div>
                </>
              ) : <div style={{ fontSize: 12.5, color: "var(--c-danger)" }}>Set a height for {aCond?.finish_tag || "this condition"} — H in the condition editor</div>;
            })()
          ) : tool === "zone" && poly.length >= 1 ? (
            zoneTraceCross ? (
              <span style={{ color: "var(--c-danger)", fontSize: 12.5 }}>Zone on one sheet — that point landed on a different sheet. Finish is disabled; Esc or Undo last point to fix it.</span>
            ) : (
              <>
                {liveArea != null && poly.length >= 3 && <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cobalt)" }}>{num(areaVal(liveArea, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} in zone</span></div>}
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>⏎, double-click, or the Finish button closes the zone and lists everything inside · Esc cancels</div>
              </>
            )
          ) : liveArea != null && poly.length >= 3 ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, color: tool === "deduct" ? "var(--c-danger)" : "var(--ink)" }}>{tool === "deduct" ? "−" : ""}{num(areaVal(liveArea, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)}</span></div>
              <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{units === "metric" ? `${fl(livePerim)} perim` : `${num(liveArea / 9)} SY  ·  ${num(livePerim)} LF perim`}</div>
              {condH > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>@H {num(condH, 2)}′: {fa(livePerim * condH)} vert{units === "metric" ? "" : ` · ${num((liveArea * condH) / 27)} CY`}</div>}
            </>
          ) : (
            <div style={{ fontSize: 12.5, opacity: 0.6 }}>{!unitsPerPx ? "Set scale first" : tool === "zone" ? "Trace a region (an apartment, a wing) — ⏎ closes it and lists every condition inside" : !activeCond ? "Pick a condition" : tool === "oneclick" ? "Click inside a room — it selects itself" : tool === "surface" ? "Trace the wall run" : "Click to trace an area"}</div>
          )}
          {selShape?.measure_role === "surface_area" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }} title="Height for THIS wall only — full-height tile here, 4-ft wainscot there, same condition. ↺ returns to the condition height.">
              <Icon name="height" size={12} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>this wall</span>
              <input name="shape-height-ft" type="number" min="0" step="0.25" value={selShape.height_ft ?? ""}
                onChange={(e) => setShapeHeight(e.target.value)}
                style={{ width: 56, padding: "2px 5px", border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>ft → {fa(selShape.computed?.area_sf || 0)}</span>
              {condH > 0 && Number(selShape.height_ft) !== condH && (
                <button onClick={clearShapeHeight} title="Set this wall to the condition height" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0 }}>↺</button>
              )}
            </div>
          )}
          <div style={{ height: 1, background: "var(--divider-soft)", margin: "8px 0" }} />
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.5 }}>{aCond?.finish_tag || "—"} total ({condRow?.shape_count || 0}{condMult > 1 ? ` ×${condMult}` : ""})</div>
          {condTotal !== 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(areaVal(condTotal, units))} <span style={{ fontSize: 12, fontWeight: 600 }}>{areaUnit(units)}</span> {units === "imperial" && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-secondary)" }}>· {num(condTotal / 9)} SY</span>}</div>}
          {wallTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(areaVal(wallTotal, units))} <span style={{ fontSize: 12, fontWeight: 600 }}>{areaUnit(units)} wall</span></div>}
          {borderTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(areaVal(borderTotal, units))} <span style={{ fontSize: 12, fontWeight: 600 }}>{areaUnit(units)} border</span></div>}
          {lfTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(lenVal(lfTotal, units))} <span style={{ fontSize: 12, fontWeight: 600 }}>{lenUnit(units)}</span></div>}
          {countTotal > 0 && <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{num(countTotal, 0)} <span style={{ fontSize: 12, fontWeight: 600 }}>EA</span></div>}
          {vertTotal > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }} title="Display only — floor-area perimeters × this condition's height (not committed)">{fa(vertTotal)} vert (perim × H)</div>}
          {condTotal === 0 && lfTotal === 0 && countTotal === 0 && wallTotal === 0 && borderTotal === 0 && <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 2 }}>—</div>}
          <div style={{ fontSize: 10.5, opacity: 0.45, marginTop: 6 }}>{visibleShapes.length} shapes on {groupKeys.length > 1 ? `${groupKeys.length} sheets` : "sheet"} · zoom {(tf.scale * 100).toFixed(0)}%</div>
        </div>

        {/* zone check results — ephemeral, clears with the tool/outline. Docked at
            right:56 so it never covers the panel rail (right:14, 34px wide), and
            anchored to the BOTTOM (not top:14 like the original) so it stacks
            vertically with the live readout instead of sitting on top of it —
            the live readout (right:14, top:14, zIndex 6) shows the SAME zone's
            live "SF in zone" figure for the NEXT trace while this panel is open,
            and a top:14 placement here covered all but a ~42px sliver of it. */}
        {zoneRows && (
          <div style={{ position: "absolute", right: 56, bottom: 14, width: 300, maxHeight: "calc(100% - 28px)", overflowY: "auto", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)", zIndex: 7, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
              <b style={{ fontSize: 12.5 }}>Zone check</b>
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--ink-muted)" }}>nothing saved</span>
              <button onClick={resetZone} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", fontSize: 15, lineHeight: 1, color: "var(--ink)" }}>×</button>
            </div>
            {zoneRows.length === 0 && (
              <div style={{ padding: "10px 12px", color: "var(--ink-muted)", fontSize: 11.5 }}>No takeoffs inside this zone on this sheet.</div>
            )}
            {zoneRows.map((zr) => {
              const parts = [];
              if (zr.floor_sf) parts.push(fa(zr.floor_sf));
              if (zr.wall_sf) parts.push(`${fa(zr.wall_sf)} wall`);
              if (zr.border_sf) parts.push(`${fa(zr.border_sf)} border`);
              if (zr.lf) parts.push(fl(zr.lf));
              if (zr.ea) parts.push(`${num(zr.ea, 0)} EA`);
              const open = zoneExpand === zr.id;
              return (
                <div key={zr.id} style={{ padding: "8px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={zr.hatch || "solid"} line={zr.color} fill={zr.fill} /></span>
                    <b style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{zr.finish_tag || "—"}</b>
                    {zr.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{zr.multiplier}</span>}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)" }}>{parts.join(" · ") || "—"}</span>
                  </div>
                  {zr.materials.length > 0 && (
                    <button onClick={() => setZoneExpand(open ? null : zr.id)}
                      style={{ marginTop: 4, padding: 0, border: "none", background: "none", cursor: "pointer", fontSize: 10.5, color: "var(--ink-muted)" }}>
                      {open ? "▾" : "▸"} materials · {zr.materials.length}
                    </button>
                  )}
                  {open && zr.materials.map((m, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginTop: 3, marginLeft: 12, fontSize: 11, color: "var(--ink-secondary)" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                      <span style={{ fontFamily: "var(--f-mono)" }}>{num(m.qty)} {m.unit}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            <div style={{ padding: "7px 12px", fontSize: 10, color: "var(--ink-muted)" }}>
              Shapes counted by their center point · same sheet only · counted shapes glow cobalt.
              {zoneRows.some((r) => (r.multiplier || 1) > 1) && <> Rows marked ×N already have the condition's multiplier applied — the same convention as the Report's Groups section, not its base-quantity by-sheet rows.</>}
              {/* A deduct classifies by its OWN center, independent of its positive
                  area's center (same rule the Report's by-sheet "negative slices"
                  note already documents for a cross-sheet split) — a zone edge
                  can split a deduct from the shape it cuts, producing a negative
                  row here. Flag it rather than guess a pairing: the deduct/positive
                  link is never stored, only inferred by overlap, and geometric
                  containment pairing would guess wrong for nested/overlapping
                  positives. */}
              {zoneRows.some((r) => r.total_sf < 0 || r.floor_sf < 0) && <> A negative row means a deduct here counted but its positive area's center fell outside the zone (or vice-versa) — the zone edge split a deduct from its shape.</>}
            </div>
          </div>
        )}

        {/* panel rail — markup/takeoffs toggles on the right edge (zoom-cluster
            style). Moved out of the toolbar so it never wraps a third row. The
            takeoffs toggle mirrors the DOCKED panel's collapsed pref — the rail
            rides the canvas edge, so it stays visible either way. */}
        <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 6, zIndex: 8 }}>
          {panelBtn(() => setLeftTab((t) => (t === "markup" ? null : "markup")), "markup", "Markups on these sheets (clouds, callouts, notes)", leftTab === "markup", markupCount)}
          {panelBtn(() => setLeftTab((t) => (t === "stamp" ? null : "stamp")), "stamp", "Stamps — reusable annotations dropped click-to-place", leftTab === "stamp", stampLib.stamps.length)}
          {panelBtn(() => setLeftTab((t) => (t === "rfi" ? null : "rfi")), "rfi", "RFI register — raise, track, and export Requests For Information", leftTab === "rfi", rfis.length)}
          {panelBtn(toggleTakeoffs, "takeoffs", "Takeoffs — conditions + running totals", takeoffsOpen, visibleShapes.length)}
          {panelBtn(() => setAgentOpen((o) => !o), "target", "Agent — describe a takeoff; it stages dashed proposals you accept or reject (bring your own AI key)", agentOpen, agentProposals.length)}
          {panelBtn(() => setShowRevisions(true), "revisions", "Revisions — save the takeoff at each bid revision, compare what moved", showRevisions)}
        </div>

       </div>

        {/* Agent panel — DOCKED right-rail sibling (reflows the canvas like the
            Takeoffs panel). Honest empty state until the BYO-AI seam is
            configured; otherwise the goal box, the streaming run log, and the
            per-proposal accept/reject desk. */}
        {agentOpen && (
          <AgentPanel
            configured={isAiConfigured()}
            running={agentRunning}
            log={agentLog}
            proposals={agentProposals}
            condById={condById}
            sheetLabel={(k) => tabLabel(k)}
            units={units}
            fmtArea={(sf) => fa(sf)}
            onRun={runAgent}
            onStop={stopAgent}
            onAccept={acceptAgentProposal}
            onReject={rejectAgentProposal}
            onAcceptAll={acceptAllVisibleAgentProposals}
            onRejectAll={rejectAllAgentProposals}
            onOpenSettings={() => setShowAiSettings(true)}
            onClose={() => setAgentOpen(false)}
          />
        )}

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
          units={units}
          conditions={conditions}
          activeCond={activeCond}
          visRowById={visRowById}
          conditionColumns={conditionColumns}
          shapeLabels={shapeLabels}
          templates={templates}
          palette={palette}
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

      {/* Unified plan navigator — one surface for the plan-set gallery AND the
          Drive folder browser. Presents as a modal over the dimmed canvas when a
          sheet is open behind it, or full-screen (onboarding) when nothing is. */}
      {(view === "gallery" || view === "picker") && (
        <PlanNavigator
          canClose={openTabs.length > 0}
          onExit={() => setView("canvas")}
          initialMode={view === "picker" ? "browse" : "plan"}
          cloudMode={cloudMode}
          sheets={sheets} getDoc={docFor} scales={scales} detectedScales={detectedScales}
          shapes={shapes} labels={galleryLabels}
          onLabel={(k, lbl) => setGalleryLabels((m) => (m[k] === lbl ? m : { ...m, [k]: lbl }))}
          onDetect={(k, det) => setDetectedScales((d) => (d[k]?.label === det.label ? d : { ...d, [k]: det }))}
          thumbCacheRef={thumbCacheRef} busyRef={statusRef}
          openTabs={openTabs} onOpen={openSheets}
          onAddFiles={handleFiles}
          levels={sheetLevels}
          onAssignLevel={(keys, label) => setSheetLevels((m) => {
            const next = { ...m };
            for (const k of keys) { if (label) next[k] = label; else delete next[k]; }
            return next;
          })}
          onClosePdf={closePdf}
          onRemoveFromProject={cloudMode ? removeFromProject : undefined}
          onCloseProject={cloudMode ? closeProject : undefined}
          onBrowseProjects={cloudMode ? browseProjects : undefined}
          listFolder={cloudMode ? pickerListFolder : undefined}
          addSheets={pickerAddSheets}
          onAdded={async () => { await refreshSheets(); setStatus("ready"); }}
        />
      )}

      {importRows && (
        <ImportSchedulePanel
          rows={importRows}
          existing={new Set(conditions.map((c) => normalizeTag(c.finish_tag)))}
          palette={PALETTE} startIndex={conditions.length}
          onCreate={createFromSchedule}
          onClose={() => setImportRows(null)}
        />
      )}

      {loadError && (
        <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "flex", alignItems: "center", gap: 12, maxWidth: 640, padding: "10px 14px", background: "var(--paper-bright)", border: "1px solid var(--c-danger)", boxShadow: "var(--shadow-2)", fontSize: 12.5, color: "var(--ink)" }}>
          <span>
            <strong style={{ color: "var(--c-danger)" }}>Couldn't load this project's saved takeoff</strong> ({loadError}).
            Autosave is paused so nothing overwrites your saved work — reload the tab to retry.
          </span>
          <button onClick={() => window.location.reload()} style={{ whiteSpace: "nowrap", padding: "6px 12px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>Reload</button>
        </div>
      )}

      {showReport && (
        <ReportPanel
          projectName={projectName} onProjectName={setProjectName}
          clientInfo={clientInfo} onClientInfo={setClientInfo} units={units}
          conditions={conditions} shapes={shapes} markups={markups} rfis={rfis}
          conditionColumns={conditionColumns} shapeLabels={shapeLabels}
          scaleInfo={Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, scale_source: scaleSources[sheet_id] || "unknown" }))}
          provenanceCounters={provCounters}
          sheetLabel={(k) => tabLabel(k)}
          onMarkedSet={exportMarkedSet} markedSetDark={darkMode}
          onClose={() => setShowReport(false)}
        />
      )}

      {showRevisions && (
        <RevisionsPanel
          current={buildPayload()}
          units={units}
          onRestore={restoreSavedPayload}
          onClose={() => setShowRevisions(false)}
        />
      )}

      {/* BYO-key AI settings — the single config surface for the ai.js seam
          (the Agent panel links here; closing re-renders, so `configured`
          re-reads immediately). */}
      {showAiSettings && <AiSettings onClose={() => setShowAiSettings(false)} />}
    </div>
  );
}
