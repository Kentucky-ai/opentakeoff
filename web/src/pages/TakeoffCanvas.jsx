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
import { keyText } from "../lib/keys.ts";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { store, isStaleTabError, STALE_TAB_MESSAGE, friendlyStoreError, projectIdFromUrl, ANN_SCHEMA, emptyAnnotations, metaGet, metaPut } from "../lib/store.js";
import { forgetThumbs, releaseThumbs } from "../lib/thumbs.js";
import { Z } from "../lib/ui.js";
import { getFocusMode, toggleFocusMode, onFocusModeChange } from "../lib/focusMode.js";
import { seedStampLibrary, instantiateStamp, markupToStampElement } from "../lib/stamps.js";
import { extractSvgPrimitives, svgToStamp } from "../lib/svgImport.js";
import { transformPath, svgPlacedBox } from "../lib/svgpath.js";
import { imagePlacedBox, captureRectToImageGeom, resizeImageFromCorner, aspectFromDims, pickEmbedFormat } from "../lib/markupImage";
import { ingestFiles } from "../lib/ingest.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../lib/importTakeoff.js";
import { buildProjectArchive, parseProjectArchive, isProjectArchive, downloadArchive } from "../lib/projectArchive.js";
import { buildProfile, parseProfile, applyProfile, resetProfileDefaults, isProfileFile } from "../lib/profile.js";
import ToolMenu from "../components/ToolMenu.jsx";
import PlanNavigator from "../components/PlanNavigator.jsx";
import ReportPanel from "../components/ReportPanel.jsx";
import RevisionsPanel from "../components/RevisionsPanel.jsx";
import UserGuide from "../components/UserGuide.jsx";
import TakeoffsPanel, { clampPanelW, CONDITION_DND_MIME, ConditionAppearanceEditor } from "../components/TakeoffsPanel.jsx";
import { HATCHES, PALETTE, NO_FILL, HatchPattern, HatchSwatch } from "../components/hatches.jsx";
import { Icon } from "../brand/icons.jsx";
import { RENDER_SCALE, MAX_GROUP, STANDARD_SCALES, parseSheetKey, compareSheetKeys, extractSheetNumber, detectScale, extractRegionText, extractTextMarks, extractDimTexts } from "../lib/sheets";
import { normalizeLoadedGroups } from "../lib/sheetGroups";
import { isStitchKey, mintStitchId, sanitizeStitches, autoButt, stitchExtent, alignMembers, seamClips, mergePoints, mergeSegs, stitchAlive, stitchLayoutSig } from "../lib/stitches";
import { isCanvasBusy } from "../lib/canvasBusy";
import { parseSchedule, rowToSeed } from "../lib/scheduleParse";
import { normalizeScanRows, postScanWithRetry, SCAN_ENDPOINT, scanRasterScale } from "../lib/scheduleScan";
import { normalizeTag } from "../lib/scheduleEdit";
// Condition twins — the whole inheritance rule is in lib/variants.ts (test/variants.test.ts);
// this file only calls it from the material write paths and the condition deletes.
import { mintTwin, variantTag,
  propagateRowPatch, propagateRowAdd, propagateRowRemove,
  markRowLocal, dropRowLocal, followFamily, splitFromFamily, promoteOnDelete } from "../lib/variants.ts";
import { isGoogleConfigured, isSignedIn, isAllowedDomain, getAccessToken, orgDomainHint } from "../lib/google/auth.js";
import { extractVectorGeometry, buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, oneClickRing, ringArea, MASK_MAX_DIM, MIN_PASS_FT, SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE } from "../lib/oneclick";
import { tidyRing, axisLockPoint } from "../lib/ringTidy";
// The Symbol tool (#264) — the canvas face for the sweep engine. The engine,
// counter-examples, the luminance channel, and label corroboration all live
// as pure web libs already; this file adds only the gesture and the review.
import { sweepSymbols } from "../lib/symbolsweep";
import { labelPlacements } from "../lib/symbollabels";
import { traceConfidence, floodSignals } from "../lib/confidence";
// The scale-acceptance ruler (a calibrated bar drawn on the sheet after a scale
// is set) — the owner's call, 2026-08-24: it serves no purpose on the sheet.
const SHOW_SCALE_GUIDE = false;
// net engine runs in a worker: a dense sheet's build is 30-90 s of pure
// geometry and must never block the page (measured: "Page Unresponsive"
// on Comfort Inn when it ran on the main thread)
const netWorker = typeof Worker !== "undefined" ? new Worker(new URL("../lib/netroom.worker.js", import.meta.url), { type: "module" }) : null;
const netPending = new Map();   // req → {resolve}
let netReq = 0;
if (netWorker) netWorker.onmessage = (ev) => { const m = ev.data; const p = netPending.get(m.req); if (p) { netPending.delete(m.req); p.resolve(m); } };
function netCall(msg) { return new Promise((resolve) => { const req = ++netReq; netPending.set(req, { resolve }); netWorker.postMessage({ ...msg, req }); }); }
import { buildRasterMask, RASTER_MIN_IMG_FRAC, RASTER_MIN_SEGS, RASTER_RDP_EPS } from "../lib/rastermask";
// PDF layer roles (#85): the pure name→role classifier and the override
// plumbing shared with the MCP session — the canvas consumes buildMask's
// opts.roles seam exactly the way the server does, one engine, one meaning.
import { buildLayerInfos, effectiveLayerRoles, layerRoleCodes, segRoles, sanitizeLayerOverrides } from "../lib/layers";
import { detectCandidateRule, buildRuleFromSeed, applyRuleToProject } from "../lib/rules";
import { deriveTransitionRuns, transitionRefusal } from "../lib/transitions";
import { conditionTotals, verticalWallSf, downloadText } from "../lib/totals.js";
import { measurementBreakdown } from "../lib/measurementBreakdown.js";
import { shapesInZone } from "../lib/zone.js";
import { sanitizeSheetLevels } from "../lib/sheetLevels.js";
import { sanitizeConditionColumns, sanitizeConditionAttrs, renameColumnValue, columnLabel } from "../lib/conditionColumns.js";
import { sanitizeShapeLabels, sanitizeShapeLabelsOnShapes, renameShapeLabel, shapeLabelValue } from "../lib/shapeLabels.js";
import { buildMarkedSetPdf, downloadBytes } from "../lib/markedset.js";
import { loadProfiles } from "../lib/identity.js";
import { resolveBranding, loadBrandingSelection } from "../lib/branding.js";
import { starPath, cloudPath, thinStroke, strokePathD, chiselRibbon, buildSnapGrid, nearestSnap, ANGLE_TOL, angleSnap, closedMetrics, openLen, pointInPoly, hitShape, arrowheadPath, distToSeg, reflectVertsNorm, ringSelfIntersects } from "../lib/geometry.js";
// Drawing style (draft chrome look) — one resolved token object (DS in JSX,
// dsRef.current in the imperative movers) replaces the hardcoded cobalt/star
// literals across the in-progress trace, cursor, and selection chrome.
import { DRAW_STYLES, DRAW_STYLE_IDS, resolveDrawStyle, markerPath, drawDashFor, rgbaFromHex, getDrawStyle, setDrawStyle, onDrawStyleChange } from "../lib/drawStyles.js";
import { getDraftOutline, setDraftOutline, onDraftOutlineChange } from "../lib/draftOutline.js";
import { flattenCurve } from "../lib/curve.js";
import { flattenArcRing, arcPathD, arcLength } from "../lib/arc.js";
import { dashArrayFor, boostForDark, clampWeight, snapWeight, LINE_STYLES, LINE_STYLE_IDS, WEIGHT_STEPS } from "../lib/lineStyles.js";
import { nextRfiNumber } from "../lib/rfi.js";
import { libFields, matFieldOverridden, libPushPatch, libRevertPatch, libEntryPatch, matEditPatch } from "../lib/materials.js";
import RfiPanel from "../components/RfiPanel.jsx";
import StampPanel from "../components/StampPanel.jsx";
import ImportSchedulePanel from "../components/ImportSchedulePanel.jsx";
// Roll goods (#136): lib/rollgoods.js is the pure packing engine (untouched
// here), lib/rollTakeoff.js the pure shapes→engine bridge; RollPanel is the
// docked diagram/reorder desk. Cut edits commit through the rollcut command.
import RollPanel from "../components/RollPanel.jsx";
// Layers (#85 phase 2): the docked layer-table desk — stated roles + the
// per-layer Auto/Wall/Off overrides that feed the mask's role short-circuit.
import LayerPanel from "../components/LayerPanel.jsx";
import { rollColorForType } from "../lib/rollgoods.js";
import { computeRollTakeoff, seamLfByShape } from "../lib/rollTakeoff.js";
// In-canvas takeoff agent — BYO-key tool-use loop (lib/agentLoop) aiming the
// registry of deterministic tools (lib/agentTools); this file provides the
// CAPABILITIES those tools close over and the review gate their proposals
// pass through. AiSettings is the config surface for the ai.js seam.
import AgentPanel from "../components/AgentPanel.jsx";
import AiSettings from "../components/AiSettings.jsx";
import { AGENT_TOOL_DEFS, executeAgentTool, agentScaleGate } from "../lib/agentTools.js";
import { runAgentLoop } from "../lib/agentLoop.js";
import { runVoiceCommand, isAgentHandoffTrigger, shouldOfferAgentHandoff } from "../lib/voiceActions";
import { createVoiceRecognizerClient } from "../lib/voiceRecognizerClient";
import { startCapture, captureSupported } from "../lib/voiceCapture";
import { aiConfig, isAiConfigured } from "../lib/ai.js";
import AccountChip from "../components/AccountChip.jsx";
import PresenceChip from "../components/PresenceChip.jsx";
import DrawStylePicker from "../components/DrawStylePicker.jsx";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { getTheme, toggleTheme, onThemeChange } from "../lib/theme.js";
// Pure data constants (render/zoom budgets, snap tuning, tool descriptors,
// flooring starter conditions) live in lib/canvasConstants.js; the pure
// module-scope helpers (uid, clamp, isDangerMsg, instantiateTemplate,
// seedConditions) in lib/canvasUtil.js. autoRenderScale/invertCanvasPixels
// retired from this file's imports — #86 moved painting into the tile
// worker pool (lib/tileCompositor.ts); both still exist as pure exports
// (renderBudget.test.ts covers autoRenderScale) pending a follow-up cleanup
// pass once the tile path has proven itself in production.
import {
  PANEL_GAP, DETAIL_ENGAGE, DETAIL_MARGIN, MAX_CANVAS_DIM, MAX_CANVAS_AREA, SYNC_MS, GESTURE_MS, SNAP_CELL,
  MEASURE_TOOLS, CUT_TOOLS, MARKUP_TOOLS, MARKUP_IDS, HL_INKS, HL_SIZES,
  MARKUP_IMG_MAX, MAX_IMAGE_MARKUP_BYTES, MARKUP_UPLOAD_MAX_BYTES, MARKUP_DECODE_MAX_AREA,
} from "../lib/canvasConstants.js";
import { uid, clamp, isDangerMsg, instantiateTemplate, seedConditions } from "../lib/canvasUtil.js";
// Tile-pyramid rendering (#86) — pure math in lib/tiles.ts (tested), worker
// pool in lib/tilePool.ts, DOM/Worker orchestration glue here via one
// long-lived compositor instance. Replaces the old single-raster base +
// threshold-gated detail-overlay effects below.
import { createTileCompositor } from "../lib/tileCompositor";
import { requiredDensity as tileRequiredDensity } from "../lib/tiles";
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
import { nowIso, mintUuid, setAuthorName, authorName } from "../lib/provenance.js";
import { applyShapeCommand, geomSnapshot, vertsEqual, recordCommand } from "../lib/shapeCommands.js";
import { applyApprovalCommand, sanitizeApprovals, approvalInk, APPROVAL_R } from "../lib/approvals.js";
import { findCutoutParent, subtractCutout, recomposeCutouts, cutRunsAcross } from "../lib/cutout.js";
import { computeShapeMetrics, needsMetrics } from "../lib/shapeMetrics.js";
import { fmtCheckLen, parseLenInput, checkVerdict, M_PER_FT, areaVal, areaUnit, lenVal, lenUnit, calInputToFeet, heightVal, heightUnit, heightInputToFeet, heightStep, dimInputStr, dimLabel } from "../lib/units";
import * as panelGeom from "../lib/panelGeometry.js";

// Carpet roll width — a run reaching this needs a seam. The live cursor readout
// turns amber at/past it so the estimator sees where seams fall while tracing.
const CARPET_ROLL_FT = 12;

// Paint/pick tiers (#116): a filled Area passes hitShape anywhere inside its
// fill, so in raw creation order an Area drawn over a Counter, Line, or Surface
// both paints above it and eats every pick inside it — the covered element
// becomes unselectable. Tiers put fills at the bottom, deducts just above their
// parent fills, runs above that, count pins on top. The renderer paints the
// stack ascending and both pickers scan the SAME stack descending, so what
// reads as on-top is always what a click lands on. Creation order still breaks
// ties within a tier (stable sort), so overlapping Areas keep newest-wins.
const ROLE_TIER = { floor_area: 0, deduct: 1, linear: 2, surface_area: 2, count: 3 };
const tierOf = (s) => ROLE_TIER[s.measure_role] ?? 0;

// The tools whose boundary can bend mid-measure (#284): the same click, the
// same commit, the curve is just a property of the points you placed. Zone is
// a query region, not a quantity, and One-Click traces its own ring.
const CURVABLE = new Set(["area", "deduct", "linear", "surface"]);
// Click-select against a curved line's DRAWN path: flatten the control points and
// hand hitShape a stand-in shape (lib/geometry.js stays byte-identical with Spline's).
function hitShapeC(s, x, y, w, h, thr) {
  if (!s.curved) return hitShape(s, x, y, w, h, thr);
  const flat = flattenCurve((s.verts_norm || []).map(([nx, ny]) => [nx * w, ny * h]));
  return hitShape({ ...s, verts_norm: flat.map(([px, py]) => [px / w, py / h]) }, x, y, w, h, thr);
}

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

// Narrow-viewport switch (phones). Everything it gates is layout-only — the
// Takeoffs panel presents as an overlay instead of docking (a 240px+ dock
// covers a phone screen), and the live readout drops to a bottom strip.
// ≥701px is byte-for-byte the existing desktop layout.
const NARROW_MQ = "(max-width: 700px)";
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
// Top-bar quick-access condition palette: a curated handful (≤9) of pinned
// conditions for one-click activation without leaving the canvas. Palette holds
// condition ids (workspace-scoped), so it persists with the annotation payload,
// not the per-user panel prefs. Capped at 9 so it maps 1:1 onto the 1–9 hotkeys.
const PALETTE_MAX = 9;

// status-bar verb column — the armed tool spoken as its MCP verb, so agent and
// human activity read in the same instrument language.
const TOOL_VERB = {
  select: "select", area: "measure_polygon", rect: "measure_polygon",
  deduct: "cut_out", "deduct-rect": "cut_out",
  linear: "measure_line", surface: "measure_surface",
  count: "place_count", oneclick: "one_click", calibrate: "set_scale",
  symbol: "symbol_sweep",
  check: "check_dimension", zone: "zone_check", "stitch-align": "stitch_align",
  schedule: "find_schedule", highlighter: "annotate", cloud: "annotate",
  callout: "annotate", text: "annotate", highlight: "annotate",
  arrow: "annotate", dimension: "annotate", stamp: "annotate", bubble: "annotate",
};

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
  // Sheet-tab strip: past MANY_TABS the row stops wrapping and becomes a
  // horizontal strip with ◀ ▶ arrows (every open sheet stays a visible,
  // clickable tab — no dropdown to hunt through). The active tab is kept in
  // view whenever the sheet changes.
  const MANY_TABS = 8;
  const tabStripRef = useRef(null);
  // Instant, not smooth: smooth scrollBy/scroll-behavior on this strip is cancelled
  // every frame (the canvas render loop keeps the layout hot), so the arrows
  // silently did nothing on prod. A direct scrollLeft write always lands.
  const scrollTabStrip = (dir) => { const el = tabStripRef.current; if (el) el.scrollLeft = Math.max(0, el.scrollLeft + dir * Math.max(160, el.clientWidth * 0.6)); };
  const [galleryLabels, setGalleryLabels] = useState({}); // sheetKey → title-block number, all files
  const [pageLabels, setPageLabels] = useState({}); // { pageNum: "A003" } from the title block
  const [sheetGroup, setSheetGroup] = useState([]);   // sheetKeys shown side-by-side; [] = single-sheet mode
  const [sheetLevels, setSheetLevels] = useState({}); // sheetKey → level label ("L1") — persisted (additive `sheet_levels` key); groups the gallery for multi-floor sets
  const [lastGroup, setLastGroup] = useState([]);     // most recent side-by-side composition — "Regroup" restores it
  const [focusKey, setFocusKey] = useState("");         // panel of the last click — scale/calibrate target in group mode
  // Stitches (#161): persisted match-line composites (lib/stitches.ts) — a
  // stitch opens as ONE panel; its members are a render-time concern only.
  const [stitches, setStitches] = useState([]);
  const [alignPt, setAlignPt] = useState(null);       // stitch-align first click (stage px) — ephemeral, never persisted
  const [zoneCheck, setZoneCheck] = useState(null);   // ephemeral zone-check region {key, pts (norm)} — never persisted (buildPayload doesn't read it)
  const [zoneExpand, setZoneExpand] = useState(null); // zone panel: condition id with materials expanded
  // Shared reset for the two zone transients — every site that discards
  // OTHER in-flight measurement state (sheet change, snapshot load, hydrate)
  // must discard this too, or the results panel and glow can outlive the
  // region/shapes they described. See the tool-change effect below for the
  // matching `poly` (pending zone trace) reset, which has its own rule.
  const resetZone = () => { setZoneCheck(null); setZoneExpand(null); };
  const [markups, setMarkups] = useState([]);                // cloud/callout/text annotations (separate from measurement shapes)
  const [approvals, setApprovals] = useState([]);            // approval seals — estimator APPROVED ink + agent AGENT marks (lib/approvals.js; its own family, not markups)
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

  const [tool, setTool] = useState("select");
  const [panelImgs, setPanelImgs] = useState({}); // { sheetKey: {w,h} } rendered bitmap dims per panel
  const [tf, setTf] = useState({ x: 0, y: 0, scale: 1 }); // render mirror of tfRef

  const [scales, setScales] = useState({});
  const [scaleSources, setScaleSources] = useState({}); // scale provenance for the report — typically "calibrated" | "standard" | "detected", but any string a newer build wrote is kept verbatim; sheets that predate the flag export "unknown"
  // Scale gate — agent proposes, human confirms. A key mapped to false means an
  // AGENT set this sheet's scale (MCP set_scale, arriving by import) and no
  // human has confirmed it; absent = confirmed. Any human scale act
  // (rescaleSheet) clears the flag — the act is the confirmation.
  const [scaleUnconfirmed, setScaleUnconfirmed] = useState({});
  const confirmScale = (key) => setScaleUnconfirmed((m) => { if (!(key in m)) return m; const n = { ...m }; delete n[key]; return n; });
  const [detectedScales, setDetectedScales] = useState({}); // { sheetKey: {upp,label,multi} } read off the plan text
  const isNarrow = useIsNarrow();
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem("opentakeoff_dark") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("opentakeoff_dark", darkMode ? "1" : "0"); } catch { /* private mode */ } }, [darkMode]);
  // App chrome theme (light/dark tokens) — independent of the canvas ☾ invert
  // above. lib/theme.js owns the DOM; this state just keeps the glyph current.
  const [theme, setTheme] = useState(getTheme);
  useEffect(() => onThemeChange(setTheme), []);
  // Drawing style (draft chrome look) — same 3-line subscription pattern as the
  // app theme above (picker / other tabs round-trip through the module event).
  // resolveDrawStyle is memoized: the component re-renders ~11 Hz during
  // gestures via the tf mirror, so no fresh deep-merge per render. dsRef is the
  // imperative movers' handle, assigned in the RENDER BODY (never an effect — a
  // pointermove can arrive before effects flush). Canvas ☾ (darkMode) picks the
  // theme's dark deltas, mirroring the invert everything else on the sheet honors.
  const [drawStyleId, setDrawStyleId] = useState(getDrawStyle);
  useEffect(() => onDrawStyleChange(setDrawStyleId), []);
  const [draftOutline, setDraftOutlineState] = useState(getDraftOutline);
  useEffect(() => onDraftOutlineChange(setDraftOutlineState), []);
  const DS = useMemo(() => resolveDrawStyle(drawStyleId, darkMode), [drawStyleId, darkMode]);
  const dsRef = useRef(DS);
  dsRef.current = DS;
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
  // #284 — which of the in-progress trace's points are arc BOW points. Parallel
  // to poly and written ONLY through the three helpers below, so it can never
  // drift out of step with the points it describes.
  const [polyCurve, setPolyCurve] = useState([]);
  // Sticky curve mode — the STACK-style straight/curve switch you flip mid
  // measurement rather than a modifier you hold. In Curve the clicks ALTERNATE:
  // one lands on the bow, the next on the far end, and the circular arc through
  // the vertex you were already on, the bow and the end is unique — so it sits
  // ON a radius wall instead of near it. ⌥ still works, and it INVERTS whatever
  // the mode is. The mode is trace-local; it clears with the trace.
  const [curveMode, setCurveMode] = useState(false);
  const clearPoly = () => { setPoly([]); setPolyCurve([]); setCurveMode(false); };
  const dropLastPoint = () => { setPoly((q) => q.slice(0, -1)); setPolyCurve((q) => q.slice(0, -1)); };
  const addPoint = (pt, curved) => { setPoly((q) => [...q, pt]); setPolyCurve((q) => [...q, !!curved]); };
  // the drawn boundary of the in-progress trace: straight where it was clicked
  // straight, splined through every run of curve points
  const curveIdx = useMemo(() => polyCurve.reduce((a, c, i) => (c ? (a.push(i), a) : a), []), [polyCurve]);
  // Mid-gesture: the last click was a bow point, so the NEXT click closes that
  // arc rather than opening another. The live preview reads the same flag.
  const bowOpen = polyCurve.length > 0 && polyCurve[polyCurve.length - 1] && poly.length >= 2;
  // Ring-tool draft invalidity (drawing styles): a self-crossing area/deduct/
  // zone draft recolors on a theme that sets invalidColor. `!!DS.invalidColor`
  // is the FIRST guard, so drafting (invalidColor null) short-circuits before
  // any geometry runs — parity is structural, not incidental. Computed on
  // PLACED vertices only (per-point via the memo, never per mousemove); ring
  // tools only — an open polyline has no closing edge and must never flip.
  const isRingTool = tool === "area" || tool === "deduct" || tool === "zone";
  const draftInvalid = useMemo(
    () => !!DS.invalidColor && isRingTool && poly.length >= 4 && ringSelfIntersects(poly),
    [DS.invalidColor, isRingTool, poly]
  );
  // ONE restore expression for the draft/rubber/trace stroke, shared by the JSX
  // and the movers so React and imperative writes can never disagree: deduct
  // red (a safety signal in every theme) → invalid flip → theme accent.
  const draftStroke = (t, invalid, ds) => (t === "deduct" ? "#b03a26" : invalid && ds.invalidColor ? ds.invalidColor : ds.accent);
  // Draft totals for the panel chip chromes (Contemporary panelDark / Precision
  // panelCream): placed-edge length sum + partial shoelace cross-sum, assigned
  // IN THE RENDER BODY (the dsRef pattern — a useEffect([poly]) recompute has a
  // stale window: React does not guarantee passive-effect flush before
  // continuous pointer events, so a pointermove could read old sums against a
  // new poly). moveCrosshair adds only the cursor terms — O(1) per move. Gated
  // on the panel chromes so Drafting Table (paper) does literally zero extra work.
  const draftStatsRef = useRef({ len: 0, cross: 0 });
  if (DS.chip.chrome === "panelDark" || DS.chip.chrome === "panelCream") {
    let dLen = 0, dCross = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      dLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
      dCross += a[0] * b[1] - b[0] * a[1];
    }
    draftStatsRef.current.len = dLen;
    draftStatsRef.current.cross = dCross;
  }
  const [guideOpen, setGuideOpen] = useState(false);   // the in-app manual overlay (? / the toolbar button)
  const [proposal, setProposal] = useState(null);  // One-Click selection under review: { key, regions: [{kind:'pos'|'neg', seed, poly, area_sf, perim_lf}] } — panel-LOCAL px
  // ── in-canvas takeoff agent state ──────────────────────────────────────────
  // agentProposals are NOT shapes: committed truth stays committed. Each entry
  // {id, sheet_id, condition_id, measure_role, verts_norm, evidence, seed_norm?,
  //  proposed_ts, area_sf, perim_lf} renders as a DASHED pencil outline until
  // the human accepts (→ dispatchShape add with agent_v1 origin) or rejects
  // (→ dropped LOCALLY — dismissed geometry never rides the contribution wire).
  // Ephemeral by design: never persisted (buildPayload doesn't read them).
  const [agentProposals, setAgentProposals] = useState([]);
  // ── correction rules (#88) — one correction, fifty rooms ────────────────────
  // rules PERSIST (project file, buildPayload/hydrate) — they're the captured
  // corrections. ruleOffer/ruleStage are ephemeral review state like
  // agentProposals: the offer banner after a qualifying Cut Out, and the staged
  // batch awaiting the explicit Apply. Staged candidates are NOT shapes —
  // nothing commits until Apply dispatches ONE `ruleApply` command.
  const [rules, setRules] = useState([]);
  const [ruleOffer, setRuleOffer] = useState(null);   // { deduct, seed, tag }
  const [ruleStage, setRuleStage] = useState(null);   // { rule, candidates, proposed_ts }
  const [agentOpen, setAgentOpen] = useState(false);      // docked right-rail Agent panel
  // ── roll goods (#136) — view state; the figured layouts are a memo below ──
  const [rollShow, setRollShow] = useState(true);         // draw the figured cuts over the plan (on: opting a condition in shows its cuts immediately)
  const [rollEdit, setRollEdit] = useState(false);        // cut-edit mode — cuts take pointer events (slide / resize / double-click reset)
  const [rollPanelOpen, setRollPanelOpen] = useState(false); // docked Roll panel (diagram + reorder)
  const rollDragRef = useRef(null);                       // live cut-drag gesture; commit is ONE rollcut command on release
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
  // raw text of the per-wall height field while it is being edited; null =
  // mirror the stored value. Same reason as DimParamInput's draft: the field
  // round-trips through a rounded unit conversion, so without this a metric
  // typist watching "2.4" become "2.438" mid-word cannot finish the number.
  const [shapeHDraft, setShapeHDraft] = useState(null);
  useEffect(() => { setShapeHDraft(null); }, [selectedId]);   // a draft belongs to ONE wall
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
    // approval entries share the ONE gesture history (family tag, recorded by
    // dispatchApproval below) — same stacks, different pure apply + array.
    if (entry.family === "approval") {
      const res = applyApprovalCommand(approvals, entry.inverse);
      setApprovals(res.approvals);
      redoStackRef.current = [...redoStackRef.current, { family: "approval", cmd: res.inverse, inverse: entry.inverse }];
      return;
    }
    const res = applyShapeCommand(shapes, entry.inverse);
    setShapes(res.shapes);
    redoStackRef.current = [...redoStackRef.current, { cmd: res.inverse, inverse: entry.inverse }];
    setSelVert(null);   // vertex counts may have changed — a stale index must not aim the next ⌫
  }
  function redoShapeCommand() {
    const entry = redoStackRef.current[redoStackRef.current.length - 1];
    if (!entry) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    if (entry.family === "approval") {
      const res = applyApprovalCommand(approvals, entry.cmd);
      setApprovals(res.approvals);
      undoStackRef.current = [...undoStackRef.current, { family: "approval", cmd: entry.cmd, inverse: res.inverse }];
      return;
    }
    const res = applyShapeCommand(shapes, entry.cmd);
    setShapes(res.shapes);
    undoStackRef.current = [...undoStackRef.current, { cmd: entry.cmd, inverse: res.inverse }];
    setSelVert(null);   // same stale-index guard as undo
  }
  // ── the approval-command wrapper ──────────────────────────────────────────
  // dispatchShape one size smaller: pure apply (lib/approvals.js) +
  // setApprovals + the SHARED undo/redo stacks, entries tagged family:
  // "approval" so ⌘Z pops seals and shapes in one gesture history. No
  // counters and no reset path — hydrate sets the array directly, and the
  // shape replace-reset clears the shared stacks (approval entries included).
  function dispatchApproval(cmd, { record = true } = {}) {
    const res = applyApprovalCommand(approvals, cmd);
    setApprovals(res.approvals);
    if (record && res.inverse) {
      const st = recordCommand(undoStackRef.current, { family: "approval", cmd, inverse: res.inverse });
      undoStackRef.current = st.undo;
      redoStackRef.current = st.redo;   // a new command discards the redone future
    }
    return res;
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
  // scan-path flood sensitivity — fixed; the knob is gone with the fill UI
  const fillSens = SENS_BALANCED;
  // NET ENGINE (test drive, 2026-08-24): route One-Click through the wall-
  // network room detector (lib/netroom) instead of the raster flood. Off by
  // default; persisted so a test session survives a reload. The net for a
  // sheet is built once per (sheet, scale) and cached — seconds on a dense
  // sheet, instant after.
  // The net engine IS One-Click on vector sheets (owner's call, 2026-08-25:
  // the flood has no purpose there). The flood survives only as the SCAN
  // path — a scan has no linework to network — and is never user-visible on
  // a vector sheet.
  const netEngine = true;
  const netCacheRef = useRef(new Map());   // `${sheetKey}:${upp}` → built net
  const netTickRef = useRef(null);          // ticking "reading the walls… N s" timer
  // No mode dial (his call, 2026-08-24: "too technical for users"). A click
  // is a room (walls + doors + drawn finish transitions); ⇧-click is the
  // finish FIELD — grow across the same tile/plank pattern, stop where it
  // stops (teller lines, lobbies, open plans). Same gesture STACK uses.
  const [saveState, setSaveState] = useState("idle");
  const [focusMode, setFocusModeState] = useState(getFocusMode);   // chrome-collapse (F) — lib/focusMode.js is the store+broadcast
  useEffect(() => onFocusModeChange(setFocusModeState), []);
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
  // ── the Symbol tool (#264) — same two-click marquee idiom as schedule ─────
  const [symbolAnchor, setSymbolAnchor] = useState(null);     // first marquee corner, isolated like scheduleAnchor
  const [imageAnchor, setImageAnchor] = useState(null);       // first marquee corner for the "image" screenshot tool, isolated like scheduleAnchor/symbolAnchor
  const [placingImageId, setPlacingImageId] = useState(null); // an image markup being (re)placed: it follows the cursor until the next click drops it (re-enterable from the panel, not just at capture)
  const placeGrabRef = useRef(null);                          // {key, dx, dy}: cursor→image-centre offset captured on the pointer's FIRST canvas contact during a place, so the image is grabbed where it sits (no teleport) and moves relative after
  const [imgThumbs, setImgThumbs] = useState({});             // markupId → tiny JPEG dataURL for the panel row — memory-only, built once per image, NEVER persisted (a 40px <img> of a full 1600px src would decode the whole bitmap and eat the byte budget)
  const thumbBuildingRef = useRef(new Set());                 // ids with a thumb build in flight (dedupe the async decode)
  const [sweep, setSweep] = useState(null);                   // the live review: matches / questions / seed, one sheet, dies on commit or discard
  const sweepRef = useRef(null);
  useEffect(() => { sweepRef.current = sweep; }, [sweep]);
  const [projectName, setProjectName] = useState("");   // optional label for the report header
  const [clientInfo, setClientInfo] = useState({});      // per-project client/job fields for branded output; additive payload field
  const fileInputRef = useRef(null);                    // hidden <input type=file> for "Open PDF"
  const importInputRef = useRef(null);                  // hidden <input type=file> for "Import takeoff…" (the agent-JSON handoff)
  const profileInputRef = useRef(null);                 // hidden <input type=file> for "Import profile…" (#299)
  const imageInputRef = useRef(null);                   // hidden <input type=file> for the Markups-dock "Upload image…" button

  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const panelCanvasRefs = useRef(new Map()); // sheetKey → <canvas> (base layer — small backing store, coarse pyramid placeholder)
  const pageObjsRef = useRef(new Map());     // sheetKey → pdf.js page object (getOperatorList/getTextContent only — painting moved to the tile worker pool)
  const dimTextsRef = useRef(new Map());     // sheetKey → positioned dim-pattern texts (#320) — RENDER_SCALE px, rescaled at buildMask time
  const renderScalesRef = useRef(new Map()); // sheetKey → RENDER_SCALE, always (see factorFor comment above) — kept so the ~20 factorFor/uppFor call sites are untouched
  // Tile-pyramid compositor (#86) — one instance owning the worker pool +
  // tile LRU cache (see lib/tileCompositor.ts). Lazily created on first
  // real use (getCompositor(), mirroring voiceRecognizerClient.ts's "nothing
  // loads until first use" worker pattern), NOT eagerly in a mount effect —
  // an eager create+dispose pair fought React 18 StrictMode's dev-mode
  // double-invoke in a way pure effect-ordering couldn't reliably fix (this
  // component observably mounts more than the textbook once-cleanup-once
  // cycle on first load — confirmed live via instrumented logging). Nulling
  // the ref on dispose (below) is what makes this resilient to ANY number of
  // create/dispose cycles, not just exactly one: the next real use just
  // recreates it.
  const compositorRef = useRef(null);
  const getCompositor = () => (compositorRef.current ??= createTileCompositor());
  const detailCanvasRefs = useRef(new Map()); // sheetKey → <canvas> (one detail/viewport layer PER PANEL now, not one shared global — every group-mode panel gets independent sharpness)
  const detailKeysRef = useRef(new Map());    // sheetKey → last requested crop key (per-panel render-key dedup, generalizing the old single detailKeyRef)
  const detailCancelsRef = useRef(new Map()); // sheetKey → disposer for the in-flight paintDetail call
  const renderTasksRef = useRef(new Map());  // sheetKey → pdf.js RenderTask
  const pdfDocsRef = useRef(new Map());      // file name → pdf.js loading task (doc cache)
  const renderSeqRef = useRef(0);            // monotonic token — stale render chains bail out
  const scanBusyRef = useRef(false);         // a paid schedule OCR read is in flight — blocks re-fire from a rapid re-draw
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const crossVRef = useRef(null);
  const crossHRef = useRef(null);
  const rubberRef = useRef(null);
  const arcRef = useRef(null);      // live 3-point arc preview (bow placed → cursor); the rubber band becomes its chord
  const rectRef = useRef(null);
  const cloudRef = useRef(null);       // live cloud preview (first corner → cursor)
  const highlightRef = useRef(null);   // live highlight-box preview (first corner → cursor; own translucent fill, NOT rectRef's condition fill)
  const dimRef = useRef(null);         // live dimension-line preview (first end → cursor; own ref — rubberRef belongs to the measure trace)
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
  // sheetKey → drawn-figure ranges (SubPath[]): the ink-classification input.
  // Single-panel sheets only — a STITCHED composite merges several sheets'
  // segment arrays, and a subpath's meaning is a contiguous range into ONE of
  // them, so a composite simply carries none and classification degrades to
  // exactly today's behaviour (the optional-field contract).
  const subpathsRef = useRef(new Map());
  const textMarksRef = useRef(new Map());  // sheetKey → positioned text (label-box classification)
  const segLumRef = useRef(new Map());     // sheetKey → per-segment stroke luminance (#260) — the Symbol tool's label leader-chase pen separator
  const textSpansRef = useRef(new Map());  // sheetKey → label text spans (built lazily on first sweep)
  const textTfRef = useRef(new Map());     // sheetKey → viewport transform, for positioning text spans in image px
  // PDF layers (#85): the op walk's per-segment OCG attribution + the sheet's
  // classified layer table. Engine reads go through REFS (rolesForSheet runs
  // inside click paths — a just-resolved table must be visible before React
  // commits); sheetLayers STATE mirrors layerInfosRef for the panel render.
  const layerGeoRef = useRef(new Map());   // sheetKey → { layerIds, layerOf }
  const layerInfosRef = useRef(new Map()); // sheetKey → LayerInfo[] ([] = unlayered)
  const layerOverridesRef = useRef({});    // mirror of layerOverrides — see above
  const [sheetLayers, setSheetLayers] = useState({});        // sheetKey → LayerInfo[] (panel view)
  const [layersOpen, setLayersOpen] = useState(false);       // docked Layers panel
  const [layerOverrides, setLayerOverrides] = useState({});  // sheetKey → { ocgId: "include"|"exclude" } — persisted (additive `layer_overrides`)
  const maskCacheRef = useRef(new Map());  // sheetKey → built boundary mask (lazy, dropped on re-render)
  const sheetStatsRef = useRef(new Map()); // sheetKey → {segCount, imageFrac} — raster-fallback trigger signals
  const panelSourceDimsRef = useRef(new Map()); // stitchKey → { memberKey: {w,h} } — member dims resolved by the render effect (#161)
  const rasterMaskCacheRef = useRef(new Map()); // sheetKey → Promise<MaskObj|null> — scan-pixel mask (lazy, shared across clicks)
  const snapMarkRef = useRef(null);    // SVG snap indicator
  const angleRef = useRef(null);       // current angle-locked image point (or null) — the click commits it
  const aimMarkRef = useRef(null);     // four floating liquid-glass pickets thickening the crosshair crossing
  const aimChipRef = useRef(null);     // readout chip by the cursor (locked angle · live segment length)
  const rubberCasingRef = useRef(null); // casing under-stroke twin of the rubber band (mounted only when DS.casing — Site Glass)
  const closeRef = useRef(null);       // ring tools' close-preview ghost edge (mounted only when DS.closePreview — Contemporary)
  const dragRef = useRef(null);        // {kind:'move'|'vertex'|'edge'|'markupMove', shapeId?/markupId?, vIndex?, start:[x,y], orig:verts_norm/markup coords, moved?, prev: grab-time geomSnapshot (shape drags), shape: grab-time shape, lastVerts/lastComputed: latest preview frame — the release commit's geom command payload}
  const ocDragRef = useRef(null);      // One-Click proposal edit drag: {kind:'oc-vertex'|'oc-edge', ri, vi?/i?/j?, oa?, ob?, sx?, sy?} — poly is panel-LOCAL px
  const ocHoverRef = useRef(-1);       // mirror of ocHover (region index under cursor) — compared per-move to avoid stale-closure churn
  const editingRef = useRef(false);    // true while the inline text editor is open — read in moveCrosshair/onPointerDown/wheel (a REF, never per-mousemove state) to suppress the crosshair and freeze pan/zoom
  const editorRef = useRef(null);      // mirror of the open editor object, so finishEditor can commit without a stale-closure race
  const editorInputRef = useRef(null); // the live <input> element (uncontrolled — value read on commit)
  const lastPtrRef = useRef(null);     // last pointer CLIENT coords — paste targets the sheet under the cursor; ALSO the voice-deixis aim (getAimSeed) — the one pointer tracker
  const aimSeqRef = useRef(0);         // bumps with every lastPtrRef write — the deixis freshness clock (no second tracker, just a tick on the existing one)
  const voiceAimMarkRef = useRef(0);   // aim is LIVE for deixis only while aimSeq > this; re-marked at utterance begin (Command box focus / every run) and on canvas-leave + tab-hide, so a parked-off-canvas or refocus ghost seed can never place a trace
  const pendingClickRef = useRef(null); // deferred draw click {p,cx,cy} — drag >5px converts to a pan
  const hoverRef = useRef(null);        // hover tooltip div (DOM-direct like the crosshair)
  const insGhostRef = useRef(null);     // edge-insert ghost "+" badge (DOM-direct like the hover readout)
  const hoverIdRef = useRef("");        // shape id currently described by the tooltip
  const lastMeasureRef = useRef("area"); // last armed measure tool — shown on the Measure menu face
  const prevToolRef = useRef("select");   // previous armed tool — detects a LEAVE-zone transition so the shared `poly` array only clears when zone itself was left, not on every tool change
  const statusCoordRef = useRef(null);   // status-bar coords span — direct DOM writes from onPointerMove, never React state per mousemove
  const markTileTopRef = useRef(0);      // MARK tile's viewport top — anchors the fixed highlighter popover beside the rail
  const menuDepthRef = useRef(0);      // >0 while a toolbar menu is open (letter shortcuts pause)
  // ONE stable open/close listener for every toolbar menu — ToolMenu re-fires
  // its onOpenChange effect when the callback identity changes, so an inline
  // arrow here would re-count an open menu on every canvas render
  const onMenuDepth = useCallback((o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }, []);
  const thumbCacheRef = useRef(new Map()); // sheetKey → thumbnail blob URL (lib/thumbs.js) — survives gallery close; persisted twin lives in the meta store
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
  // Slice 5b defer-gate scratch: `busyStateRef` mirrors the state half of the busy
  // predicate every render so computeBusy can read it via a ref (always fresh, stable
  // to capture); `remotePendingRender` marks a reconcile whose RENDER we deferred
  // because the canvas went busy after the store adopted (Case 2), drained on idle.
  const busyStateRef = useRef({});
  const remotePendingRender = useRef(false);
  // Bumped whenever a busy INTERACTION ref clears (drag/editor/scan end) — those don't
  // trigger a render, so the idle-drain (below) can't observe the busy→idle edge from
  // its state deps alone. idleTick is a drain dep so a ref-only idle transition still
  // drains a deferred render (and un-blocks autosave, which stays suppressed while a
  // render is deferred). Without it, suppression could wedge saves indefinitely.
  const [idleTick, setIdleTick] = useState(0);
  // Only meaningful on the opted-in path (the idle-drain no-ops without a bridge), so
  // gate on syncBridge — this keeps the flag-off / anonymous path free of the extra
  // interaction-end re-renders, preserving byte-for-byte legacy behavior (invariant #4).
  const bumpIdle = () => { if (store.syncBridge) setIdleTick((t) => t + 1); };
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
    let k = (focusKey && sheetGroup.includes(focusKey)) ? focusKey : (sheetGroup[0] || sheetKey);
    // ungrouping a stitch lands on its first member — the stitch id itself is
    // not a pageable single sheet (active/page never carry stitch keys)
    if (isStitchKey(k)) k = stitchById[k]?.members[0]?.key || sheets[0]?.name || k;
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
    if (isStitchKey(key)) { openStitch(key); return; }   // a stitch opens as a group of one (#161)
    const t = parseSheetKey(key);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
    setSheetGroup([]);
  }
  // ── stitches (#161): open / create / delete ────────────────────────────────
  function openStitch(id) {
    if (!stitchById[id]) return;
    setOpenTabs((t) => (t.includes(id) ? t : [...t, id]));
    setSheetGroup([id]);
    setFocusKey(id);
    setView("canvas");
  }
  // Mint a stitch from 2..MAX_GROUP sheet keys: members butt flush left-to-
  // right (match-line alignment is the Align gesture's job), the stitch opens
  // immediately, and it inherits the members' scale when they all agree.
  async function createStitch(keys) {
    const ks = [...new Set(keys)].slice(0, MAX_GROUP);
    if (ks.length < 2 || ks.some((k) => isStitchKey(k))) return;
    const dims = {};
    try {
      for (const k of ks) {
        const t = parseSheetKey(k);
        const pdf = await docFor(t.file);
        const pg = await pdf.getPage(Math.min(Math.max(1, t.page), pdf.numPages || 1));
        const vp = pg.getViewport({ scale: RENDER_SCALE });
        // EXACT dims — a butt layout at ceil'd widths would open a hairline gap
        // and drift the composite extent (see resolveSource's wf/hf note)
        dims[k] = { w: vp.width, h: vp.height };
      }
    } catch (e) { setCommitMsg(`Couldn't read those sheets to stitch them: ${e.message || e}`); return; }
    const st = { id: mintStitchId(), name: ks.map((k) => tabLabel(k)).join(" + "), members: autoButt(ks, dims), created_at: nowIso() };
    setStitches((s) => [...s, st]);
    const upps = ks.map((k) => scales[k]);
    if (upps.every((u) => u != null && Math.abs(u - upps[0]) < 1e-12)) setScales((s) => ({ ...s, [st.id]: upps[0] }));
    setOpenTabs((t) => (t.includes(st.id) ? t : [...t, st.id]));
    setSheetGroup([st.id]);
    setFocusKey(st.id);
    setView("canvas");
    setCommitMsg("Stitched — drag to pan, then Align (toolbar) joins the match line: click the same point on both sheets.");
  }
  // Deleting a stitch is refused while takeoffs live on it — quantities are
  // never silently orphaned (the close-PDF confirm precedent, but stricter:
  // a stitch has no file to re-add, so there is no restore path).
  function deleteStitch(id) {
    const n = shapes.filter((s) => s.sheet_id === id).length + markups.filter((m) => m.sheet_id === id).length;
    if (n) { setCommitMsg(`This stitch carries ${n} takeoff${n === 1 ? "" : "s"}/markup${n === 1 ? "" : "s"} — delete or move them first.`); return; }
    setStitches((s) => s.filter((st) => st.id !== id));
    setOpenTabs((t) => t.filter((k) => k !== id));
    if (sheetGroup.includes(id)) { const f = sheetGroup.filter((k) => k !== id); setSheetGroup(f.length >= 2 || (f.length === 1 && isStitchKey(f[0])) ? f : []); }
    setLastGroup((g) => (g.includes(id) ? [] : g));
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
    if (sheetGroup.includes(key)) { const f = sheetGroup.filter((k) => k !== key); setSheetGroup(f.length >= 2 || (f.length === 1 && isStitchKey(f[0])) ? f : []); }
    if (!next.length) { setView("gallery"); return; }
    if (!sheetGroup.length && key === sheetKey) { const nb = next[Math.min(Math.max(i, 0), next.length - 1)]; if (nb) goToSheet(nb); }
  }
  const tabLabel = (k) => {
    if (isStitchKey(k)) return stitchById[k]?.name || "Stitched sheets";
    const lvl = sheetLevels[k] ? `${sheetLevels[k]} · ` : "";   // assigned floor/level rides every tab label
    if (galleryLabels[k]) return lvl + galleryLabels[k];
    const t = parseSheetKey(k);
    if (t.file === active && pageLabels[t.page]) return lvl + pageLabels[t.page];
    const base = t.file.replace(/\.pdf$/i, "");
    return lvl + (t.page > 1 ? `${base} · ${t.page}` : base);
  };
  // A sheet's bare identifier for auto-naming an image markup (e.g. "AF101") —
  // tabLabel WITHOUT the mutable "Level 1 · " prefix and with a hyphen so a page-2
  // sheet reads "PLAN-2", not the compound "Level 1 · PLAN · 2" that would nest
  // badly inside an image name like "…-01".
  const sheetBaseLabel = (k) => {
    if (isStitchKey(k)) return stitchById[k]?.name || "Stitched";
    if (galleryLabels[k]) return galleryLabels[k];
    const t = parseSheetKey(k);
    if (t.file === active && pageLabels[t.page]) return pageLabels[t.page];
    const base = t.file.replace(/\.pdf$/i, "");
    return t.page > 1 ? `${base}-${t.page}` : base;
  };

  // ── panels: the ONE rendering model — single-sheet mode is a group of one ──
  // Every coordinate on screen lives in "stage space": panel i's image px plus
  // its xOffset. With one panel xOffset is 0, so stage space IS image space and
  // all the original single-sheet math is unchanged.
  const groupKeys = sheetGroup.length ? sheetGroup : [sheetKey];
  const stitchById = useMemo(() => Object.fromEntries(stitches.map((s) => [s.id, s])), [stitches]);
  // docEpoch re-keys groupSig when a re-dropped file's BYTES changed under the
  // same name (store.addPdf → revised): the render effect keyed on groupSig is
  // the one path that resets every cache (compositor, pageObjs, snap grids) and
  // reloads docs, so bumping it is how new revision bytes reach the screen
  // without a reload. Same-name-same-bytes drops don't bump — no wasted repaint.
  // The stitch-layout signature joins it (#161): re-aligning a stitch moves its
  // members under the SAME keys, and this effect is the one path that rebuilds
  // the merged snap/mask geometry and member placement.
  const [docEpoch, setDocEpoch] = useState(0);
  const groupSig = JSON.stringify(groupKeys) + "@" + docEpoch + "|" + stitchLayoutSig(groupKeys, stitches);
  let _px = 0;
  const panels = groupKeys.map((key) => {
    const dims = panelImgs[key] || { w: 0, h: 0 };
    const p = { key, ...parseSheetKey(key), img: dims, xOffset: _px };
    if (dims.w) _px += dims.w + PANEL_GAP;
    return p;
  });
  // Draw-time expansion (#161): a stitch panel paints as its MEMBER canvases
  // (each positioned at its stitch offset, seam-clipped); a plain panel paints
  // as itself with drawKey === key, so the non-stitch DOM is byte-identical.
  // Input math (panelAt/stage space) reads `panels` only and never sees this.
  const drawPanels = panels.flatMap((p) => {
    const st = stitchById[p.key];
    if (!st) return [{ drawKey: p.key, compKey: p.key, x: p.xOffset, y: 0, w: p.img.w, h: p.img.h, clip: null }];
    const dims = panelSourceDimsRef.current.get(p.key);
    if (!dims) return [];   // members not resolved yet — the render effect paints nothing until phase A lands
    const clips = seamClips(st.members, dims);
    return st.members.map((m, i) => ({
      drawKey: `${p.key}::${m.key}`, compKey: `${p.key}::${m.key}`,
      x: p.xOffset + m.dx, y: m.dy,
      // ceil to match the base canvas's integer backing store (dims are exact)
      w: Math.ceil(dims[m.key]?.w || 0), h: Math.ceil(dims[m.key]?.h || 0),
      // clip is the member's VISIBLE box in stage space (wrapper div bounds)
      clip: { x: p.xOffset + clips[i].x0, y: clips[i].y0, w: clips[i].x1 - clips[i].x0, h: clips[i].y1 - clips[i].y0 },
    }));
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
  // bottom-to-top paint order (see ROLE_TIER) — the renderer maps this
  // ascending; the click and hover pickers scan it reversed.
  const stackedShapes = useMemo(() => [...visibleShapes].sort((a, b) => tierOf(a) - tierOf(b)), [visibleShapes]);
  const visibleMarkups = useMemo(() => {
    const keys = new Set(sheetGroup.length ? sheetGroup : [sheetKey]);
    return markups.filter((m) => keys.has(m.sheet_id));
  }, [markups, sheetGroup, sheetKey]);
  // scale is PER PAGE (plan sets are never one uniform scale) — set it once per
  // sheet and it's remembered. In group mode the scale dropdown and hints target
  // the FOCUSED panel (the one last clicked); single mode focuses the lone panel.
  const focusPanel = (focusKey && groupKeys.includes(focusKey) && panelByKey(focusKey)) || panels[0];
  const unitsPerPx = scales[focusPanel.key] ?? null;
  const labelFor = (p) => stitchById[p.key]?.name || (p.file === active && pageLabels[p.page]) || (p.page > 1 ? `Sheet ${p.page}` : p.file);
  // Scale semantics (why geometry divides by factorFor and calibration
  // multiplies back to baseline) are documented on the pure functions in
  // lib/panelGeometry.js; these wrappers bind the live scales/renderScalesRef.
  // factorFor is now a constant 1 (renderScalesRef is always pinned to
  // RENDER_SCALE — see the tile-pyramid render effect below): the logical
  // img space no longer varies with what's actually rastered, since nothing
  // is rastered at panel scope anymore, only bounded tiles. Signatures are
  // unchanged so none of factorFor/uppFor's ~20 call sites needed to move.
  const factorFor = (key) => panelGeom.factorFor(renderScalesRef.current, key);
  const uppFor = (key) => panelGeom.uppFor(scales, renderScalesRef.current, key);
  // keep the agent's capability closures reading LIVE state across their awaits
  useEffect(() => {
    agentStateRef.current = { panels, scales, scaleSources, detectedScales, conditions, status };
  });

  // ── roll goods (#136): the figured layouts, one pure pass over the takeoff ──
  // Rendered sheets only — a ring needs bitmap dims (panelImgs) plus a scale to
  // speak feet. Memoized off geometry/config, never the transform: pan/zoom
  // must not re-figure a roll. uppFor reads `scales` (a dep) plus a ref pinned
  // to RENDER_SCALE, so the dep list is honest.
  const rollTakeoff = useMemo(
    () => computeRollTakeoff(conditions, shapes, (k) => panelImgs[k] || null, (k) => uppFor(k)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- uppFor reads scales (listed) + renderScalesRef pinned to RENDER_SCALE; listing it would re-figure rolls on every render
    [conditions, shapes, panelImgs, scales]   // uppFor: scales + a pinned ref
  );
  const rollByCond = rollTakeoff.byCond;
  const rollCutsByPanel = rollTakeoff.cutsBySheet;
  // Figured seam LF per shape — the basis a "seam_lf" materials row (weld rod,
  // seam tape) divides against. Handed to every conditionTotals scope below so
  // the HUD, the project roll-up, and a zone check agree with the Report on
  // what the layout welds.
  const seamCtx = useMemo(() => ({ seamByShape: seamLfByShape(rollByCond) }), [rollByCond]);

  // Cut drag (#136) — the self-contained element-drag pattern (the panel-resize
  // handle's): the cut's own <g> opts into pointer events in edit mode, captures
  // the pointer, live-PREVIEWS by writing shape.roll_layout through raw
  // setShapes (the sanctioned preview path — see the dispatchShape header), and
  // commits ONE undoable `rollcut` command on release whose inverse is the
  // grab-time row. kind: "body" slides the cut along its lane; "start"/"end"
  // pull the run ends (the installer's call the math can't make — carry into a
  // closet, stop short of a transition). A cut can never get shorter than 3″.
  const beginRollCut = (e, ct, kind) => {
    if (!rollEdit) return;
    e.stopPropagation(); e.preventDefault();
    const shape = shapes.find((s) => s.id === ct.srcId);
    if (!shape) return;
    rollDragRef.current = {
      srcId: ct.srcId, laneIndex: ct.laneIndex, laneCount: ct.laneCount, kind,
      runY: ct.laneAxis === "x", upp: ct.upp, sx: e.clientX, sy: e.clientY,
      base: { runMin: ct.runMin, runMax: ct.runMax },
      prevRow: { id: ct.srcId, ...("roll_layout" in shape ? { roll_layout: shape.roll_layout } : {}) },
      moved: false, lastLayout: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveRollCut = (e) => {
    const d = rollDragRef.current; if (!d) return;
    const dFt = ((d.runY ? e.clientY - d.sy : e.clientX - d.sx) / tfRef.current.scale) * d.upp;
    let { runMin, runMax } = d.base;
    if (d.kind === "body") { runMin += dFt; runMax += dFt; }
    else if (d.kind === "start") runMin = Math.min(d.base.runMax - 0.25, d.base.runMin + dFt);
    else runMax = Math.max(d.base.runMin + 0.25, d.base.runMax + dFt);
    d.moved = d.moved || Math.abs(dFt) > 1e-4;
    // Build the target layout SYNCHRONOUSLY, from the grab-time row — never
    // inside the setShapes updater: a fast flick's pointerup can land before
    // React flushes the last move, and a commit that reads updater-written
    // state would silently skip (the house drag pattern: gesture state lives
    // in the ref, the updater only mirrors it). A stored layout from a
    // DIFFERENT lane count is stale (reshaped room) — start fresh rather than
    // resurrect overrides aimed at lanes that moved.
    const prevRl = d.prevRow.roll_layout;
    const prior = prevRl && typeof prevRl === "object" && prevRl.lanes && prevRl.laneCount === d.laneCount ? prevRl.lanes : {};
    d.lastLayout = { laneCount: d.laneCount, lanes: { ...prior, [d.laneIndex]: { ...(prior[d.laneIndex] || {}), runMin, runMax } } };
    setShapes((ss) => ss.map((s) => (s.id === d.srcId ? { ...s, roll_layout: d.lastLayout } : s)));
  };
  const endRollCut = () => {
    const d = rollDragRef.current; if (!d) return;
    rollDragRef.current = null;
    if (!d.moved || !d.lastLayout) return;   // zero-motion = not an edit — no command, no undo entry
    dispatchShape({ type: "rollcut", rows: [{ id: d.srcId, roll_layout: d.lastLayout }], prev: [d.prevRow] });
  };
  // double-click: hand THIS cut back to the figured layout (drop its lane
  // override; the key clears entirely when no other lane holds an edit)
  const resetRollCut = (ct) => {
    const shape = shapes.find((s) => s.id === ct.srcId);
    const rl = shape?.roll_layout;
    if (!rl || !rl.lanes || !(ct.laneIndex in rl.lanes)) return;
    const lanes = { ...rl.lanes };
    delete lanes[ct.laneIndex];
    const row = Object.keys(lanes).length ? { id: ct.srcId, roll_layout: { laneCount: rl.laneCount, lanes } } : { id: ct.srcId };
    dispatchShape({ type: "rollcut", rows: [row] });
  };
  // RollPanel reorder: the dragged order becomes seq overrides (manual cuts
  // pack FIRST, in that order — the engine's skyline re-packs, so a manual
  // order can never overlap) — ONE rollcut command, one undo entry.
  const onReorderRollCuts = (condId, orderedIds) => {
    const ri = rollByCond.get(condId); if (!ri) return;
    const laneCountBySrc = new Map(ri.strips.map((s) => [s.srcId, s.laneCount]));
    const bySrc = new Map();
    orderedIds.forEach((sid, idx) => {
      const i = sid.lastIndexOf(":");
      const srcId = sid.slice(0, i), lane = sid.slice(i + 1);
      if (!bySrc.has(srcId)) bySrc.set(srcId, {});
      bySrc.get(srcId)[lane] = idx;
    });
    const rows = [];
    for (const [srcId, seqByLane] of bySrc) {
      const shape = shapes.find((s) => s.id === srcId); if (!shape) continue;
      const lc = laneCountBySrc.get(srcId);
      const prior = shape.roll_layout?.laneCount === lc && shape.roll_layout.lanes ? shape.roll_layout.lanes : {};
      const lanes = { ...prior };
      for (const [lane, seq] of Object.entries(seqByLane)) lanes[lane] = { ...(lanes[lane] || {}), seq };
      rows.push({ id: srcId, roll_layout: { laneCount: lc, lanes } });
    }
    if (rows.length) dispatchShape({ type: "rollcut", rows });
  };
  // strip only the seq keys — a floor-position edit (runMin/runMax) survives a
  // cutting-order reset; that's a different decision than double-click reset
  const onResetRollOrder = (condId) => {
    const ri = rollByCond.get(condId); if (!ri) return;
    const srcIds = new Set(ri.strips.map((s) => s.srcId));
    const rows = [];
    for (const s of shapes) {
      if (!srcIds.has(s.id) || !s.roll_layout?.lanes) continue;
      let changed = false;
      const lanes = {};
      for (const [k, o] of Object.entries(s.roll_layout.lanes)) {
        if (o && typeof o === "object" && "seq" in o) {
          const { seq: _seq, ...rest } = o;
          changed = true;
          if (Object.keys(rest).length) lanes[k] = rest;
        } else lanes[k] = o;
      }
      if (!changed) continue;
      rows.push(Object.keys(lanes).length ? { id: s.id, roll_layout: { laneCount: s.roll_layout.laneCount, lanes } } : { id: s.id });
    }
    if (rows.length) dispatchShape({ type: "rollcut", rows });
  };

  // ── transform: tfRef is source of truth; write straight to the DOM ─────────
  const applyTf = useCallback(() => {
    const { x, y, scale } = tfRef.current;
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);
  // Compositor-promote the stage layer for the DURATION OF A GESTURE only.
  // A permanently-promoted layer (will-change: transform in the JSX) freezes
  // its raster scale at promotion time — Chromium deliberately never re-rasters
  // such a layer when only its transform scale changes — so after a zoom-in the
  // SVG overlay (committed boundaries, the in-progress polygon, vertex handles)
  // stays a GPU-magnified bitmap: pixelated, blurry edges while drawing. The
  // detail canvases never showed it because they repaint their own pixels at
  // settle. So promote when a pan/zoom gesture opens (per-frame moves stay
  // compositor-only and cheap) and demote when it settles (in syncTilePanels,
  // keyed off the same gestureUntilRef wheel-quiet signal the detail repaint
  // uses) — a demoted stage transforms at paint time, re-rastering the overlay
  // crisp at whatever zoom the user landed on.
  const promoteStage = useCallback(() => {
    const el = stageRef.current;
    if (el && el.style.willChange !== "transform") el.style.willChange = "transform";
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
      // Tile repositioning (#86) is UNCONDITIONAL — it doesn't wait on the tf
      // state mirror below, or a pure low-zoom pan would never resync its
      // crop (see syncTilePanelsRef's comment for why this had to split out).
      syncTilePanelsRef.current();
      // Nothing in the render tree reads tf.x/tf.y — position lives entirely in
      // the CSS transform above. A pure pan (scale unchanged) below this
      // density threshold doesn't need the React mirror at all: skipping the
      // state write avoids re-rendering the whole shape/markup overlay
      // (thousands of SVG els at overview zoom) on every ~90ms pan tick — that
      // wasted reconciliation was the zoomed-out pan flicker + toolbar lag.
      // (DETAIL_ENGAGE is reused here only as a convenient density threshold —
      // this gate is about SVG reconciliation cost, unrelated to raster tiles.)
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
  // ── page-count cache (#302) ────────────────────────────────────────────────
  // The gallery used to learn every file's page count by loading its FULL bytes
  // into a pdf.js doc the moment it opened — the one eager read left in an
  // otherwise lazy pipeline (thumbnails render on scroll, the canvas rasters
  // only open tabs). On a large plan set that read IS the sluggishness, so
  // counts persist in the meta store once discovered and the gallery opens a
  // known set without touching a byte of it. Keyed per project scope; entries
  // drop on the only two paths that can change a file's pages — a revision
  // (addPdf revised) and a removal — so the cache can't go stale.
  const pageCacheKey = "sheet_pages:" + (projectIdFromUrl() || "local");
  const [knownPages, setKnownPages] = useState({});
  const knownPagesRef = useRef(knownPages);
  useEffect(() => {
    let off = false;
    metaGet(pageCacheKey).then((m) => {
      if (off || !m || typeof m !== "object") return;
      knownPagesRef.current = m;
      setKnownPages(m);
    }).catch(() => {});
    return () => { off = true; };
  }, [pageCacheKey]);
  const rememberPages = useCallback((name, count) => {
    if (!Number.isFinite(count) || count < 1 || knownPagesRef.current[name] === count) return;
    const next = { ...knownPagesRef.current, [name]: count };
    knownPagesRef.current = next;
    setKnownPages(next);
    metaPut(pageCacheKey, next).catch(() => { /* cache only — rediscovered next open */ });
  }, [pageCacheKey]);
  const forgetPages = useCallback((names) => {
    // a file whose bytes are leaving (or changing) takes its thumbnails with it
    forgetThumbs(names, thumbCacheRef.current);
    const next = { ...knownPagesRef.current };
    let hit = false;
    for (const n of names) if (n in next) { delete next[n]; hit = true; }
    if (!hit) return;
    knownPagesRef.current = next;
    setKnownPages(next);
    metaPut(pageCacheKey, next).catch(() => {});
  }, [pageCacheKey]);
  // Free a departing file's pdf.js worker doc — the doc cache is deliberately
  // long-lived (thumbnails + reopen speed), but a file that LEFT the working
  // set would otherwise hold worker memory for the rest of the session (#302).
  const evictDoc = useCallback((name) => {
    const t = pdfDocsRef.current.get(name);
    if (t) { t.then((task) => { try { task.destroy(); } catch { /* already gone */ } }).catch(() => {}); pdfDocsRef.current.delete(name); }
  }, []);
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
    evictDoc(name);
    forgetPages([name]);
    reconcileAfterRemoval(name, await refreshSheets());
  }, [refreshSheets, reconcileAfterRemoval, evictDoc, forgetPages]);
  // Bulk close (#301): one pass over the manage-mode selection, ONE refresh and
  // reconcile at the end. Per-file semantics are exactly closePdf's — shapes
  // persist in annotations and restore if the same file is re-added.
  const closePdfs = useCallback(async (names) => {
    if (!names.length) return;
    for (const n of names) { await store.removePdf(n); evictDoc(n); }
    forgetPages(names);
    const list = await refreshSheets();
    reconcileAfterRemoval(names.includes(active) ? active : "", list);
    setCommitMsg(`Removed ${names.length} PDF${names.length === 1 ? "" : "s"} from the plan set — takeoffs on them stay in the project and restore on re-add.`);
  }, [refreshSheets, reconcileAfterRemoval, evictDoc, forgetPages, active]);
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
    // a dropped .otk is a PROJECT, not a plan — it replaces the workspace
    // (snapshot first) instead of joining the plan set (#300)
    const otk = incoming.find((f) => isProjectArchive(f.name));
    if (otk) {
      await importProjectArchive(otk);
      if (incoming.length > 1) setCommitMsg((m) => `${m} Other dropped files were ignored — open plans separately from a project archive.`);
      return;
    }
    // a dropped .otprofile is the working ENVIRONMENT (#299) — apply it, never
    // ingest it as a plan
    const prof = incoming.find((f) => isProfileFile(f.name));
    if (prof) { await importProfileFile(prof); return; }
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
    const results = [];
    for (const f of pdfs) { try { results.push(await store.addPdf(f)); } catch (e) { setCommitMsg(`Couldn't open ${f.name}: ${e.message || e}`); } }
    await refreshSheets();
    // CO-1: a re-drop whose bytes CHANGED is a plan revision, not a re-open.
    // The store archived the old bytes; here the stale pdf.js docs must go
    // (docFor caches by name for the life of the view) and the render effect
    // must re-key so the new revision actually reaches the screen.
    const revised = results.filter((r) => r?.revised);
    if (revised.length) {
      for (const r of revised) evictDoc(r.name);
      // a revision can change the page count — drop the cached counts so the
      // gallery re-learns them from the new bytes (#302)
      forgetPages(revised.map((r) => r.name));
      setDocEpoch((e) => e + 1);
    }
    const names = pdfs.map((f) => f.name);
    const tail = skipped.length ? ` · ${skipped.length} skipped` : "";
    if (names.length === 1) {
      setOpenTabs((t) => (t.includes(names[0]) ? t : [...t, names[0]]));
      goToSheet(names[0]);
      setView("canvas");
    } else {
      setView("gallery");   // a plan set → land in the gallery to pick sheets
    }
    if (revised.length) {
      // "changed under your markups" only when ink actually rides that file —
      // any page of it (sheet_id is `name` for page 1, `name#page` beyond)
      const inked = (n) => shapes.some((s) => s.sheet_id === n || s.sheet_id.startsWith(n + "#"))
        || markups.some((m) => m.sheet_id === n || m.sheet_id.startsWith(n + "#"));
      const hot = revised.filter((r) => inked(r.name));
      const label = (r) => `${r.name} → rev ${r.rev}`;
      setCommitMsg(hot.length
        ? `Sheet changed under your markups: ${hot.map(label).join(", ")} — earlier revision kept; re-check the affected takeoff.`
        : `Sheet updated: ${revised.map(label).join(", ")} — earlier revision kept.`);
    } else {
      setCommitMsg(`Opened ${names.length} sheet${names.length === 1 ? "" : "s"}${tail}.`);
    }
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
    // same rule for the correction-rule review state (#88): an offer/staged
    // batch aimed at pre-load shapes must not survive the load. The RULES
    // themselves are project data and hydrate below.
    setRuleOffer(null); setRuleStage(null);
    setRules(Array.isArray(a.rules) ? a.rules : []);   // additive — old saves without rules load as []
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
    setMarkups(Array.isArray(a.markups) ? a.markups.map((m) => ({ ...m, id: m.id || uid("mk"), rfi_id: m.rfi_id || "", condition_id: m.condition_id || "" })) : []);
    setApprovals(sanitizeApprovals(a.approvals));   // additive — old saves load as []; load-gated so one corrupt seal can't wedge the render loop
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
    // additive `layer_overrides` (#85 — per-sheet PDF-layer Wall/Off overrides
    // for the One-Click mask): same else-clear + shape gate as sheet_levels.
    // Masks are a lazy per-sheet cache — drop them so a loaded snapshot's
    // overrides govern the next flood, not the replaced project's.
    const lov = sanitizeLayerOverrides(a.layer_overrides);
    layerOverridesRef.current = lov;
    setLayerOverrides(lov);
    maskCacheRef.current.clear();
    // additive `stitches` (#161) — sanitize-gated like approvals; else-clear so a
    // snapshot load can't inherit the replaced project's composites. Sanitized
    // BEFORE group normalization: a solo stitch key in sheet_group is only a
    // legitimate group of one while its stitch actually exists.
    const loadedStitches = sanitizeStitches(a.stitches, MAX_GROUP);
    setStitches(loadedStitches);
    setAlignPt(null);
    // else-clear matters at runtime (snapshot load): a payload without groups/
    // tabs must not inherit the pre-load ones — autosave would persist a hybrid.
    // In group mode sheetGroup + lastGroup share ONE instance so the lastGroup-sync
    // effect below is a reference-equal no-op — otherwise its follow-up commit would
    // escape the one-shot save suppression and spuriously re-save (see normalizeLoadedGroups).
    const { sheetGroup: grp, lastGroup: lgFinal } = normalizeLoadedGroups(a, MAX_GROUP,
      (k) => loadedStitches.some((s) => s.id === k));
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
    const unconf = {};
    for (const s of a.sheets || []) if (s.sheet_id && s.units_per_px) {
      sc[s.sheet_id] = s.units_per_px;
      // provenance is additive — old projects lack it (report shows "unknown").
      // Any non-empty string passes through, not just today's known values: a
      // whitelist would silently strip a future value on load and the next
      // autosave would persist the loss. Display already falls back safely.
      if (typeof s.scale_source === "string" && s.scale_source) src[s.sheet_id] = s.scale_source;
      if (s.scale_confirmed === false) unconf[s.sheet_id] = false;   // scale gate: agent-set, awaiting a human
    }
    setScales(sc);
    setScaleSources(src);
    setScaleUnconfirmed(unconf);
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
  useEffect(() => { if (tool !== "image") setImageAnchor(null); }, [tool]);   // leaving the image marquee drops a half-set anchor (mirrors scheduleAnchor/symbolAnchor reset)
  // A One-Click proposal is only actionable while One-Click is armed (Enter
  // already requires it) — discard it on tool switch, like the stamp above.
  // Also keeps Create out of the ACTION slot while Finish occupies it, so the
  // slot's reserved width always fits its content (issue #61).
  useEffect(() => { if (tool !== "oneclick") setProposal(null); }, [tool]);
  useEffect(() => { if (tool !== "stitch-align") setAlignPt(null); }, [tool]);   // leaving the align gesture drops its half-set match point
  // Proposal gone (created, discarded, sheet changed) ⇒ drop any handle selection/hover.
  useEffect(() => { if (!proposal) { setOcSel(null); ocHoverRef.current = -1; setOcHover(-1); } }, [proposal]);
  // selection/tool changed under a parked cursor ⇒ the edge-insert ghost's
  // promise is stale — hide it until the next pointer move re-earns it.
  useEffect(() => { if (insGhostRef.current) insGhostRef.current.style.display = "none"; }, [selectedId, tool]);
  // Switching to a different shape (or clearing the selection) drops the vertex pick.
  useEffect(() => { setSelVert(null); }, [selectedId]);

  // remember every live composition so Regroup works after ANY exit from group
  // mode (Ungroup button, tab click, gallery View) — not just the last Ungroup
  useEffect(() => { if (sheetGroup.length >= 2) setLastGroup(sheetGroup); }, [sheetGroup]);

  // a persisted group may reference a since-deleted file — drop those keys; a
  // group of one collapses back to single-sheet mode. A stitch key is live
  // while its stitch exists and every member's file survives (#161), and a
  // solo stitch is a legitimate group of one.
  useEffect(() => {
    if (!sheets.length) return;
    const names = new Set(sheets.map((s) => s.name));
    const keyLive = (k) => (isStitchKey(k)
      ? !!stitchById[k] && stitchAlive(stitchById[k], names)
      : names.has(parseSheetKey(k).file));
    const liveKeys = (g) => {
      const f = g.filter(keyLive);
      return f.length === g.length ? g : (f.length >= 2 || (f.length === 1 && isStitchKey(f[0])) ? f : []);
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
    setOpenTabs((t) => { const f = t.filter(keyLive); return f.length === t.length ? t : f; });
    // stitchById joins the deps: a stitch created/deleted this session must
    // re-run the same liveness pass its members' files do.
  }, [sheets, stitchById]);

  // land on the first restored tab (the sheet-list effect defaults to sheets[0])
  useEffect(() => {
    if (tabInitRef.current || !openTabs.length || !sheets.length || sheetGroup.length) return;
    tabInitRef.current = true;
    goToSheet(openTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs, sheets]);
  // keep the active tab visible in the scrolling strip (no-op while the row wraps)
  useEffect(() => {
    const strip = tabStripRef.current; if (!strip || openTabs.length <= MANY_TABS) return;
    const el = strip.querySelector('[data-sheet-tab="active"]');
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sheetKey, sheetGroup, openTabs.length]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { proposalRef.current = proposal; }, [proposal]);
  // Tab hidden ⇒ the voice-deixis aim dies: on return the tracked position
  // predates the refocus (rAF suspended, the pointer may be anywhere), so
  // "this room" must wait for a fresh move — the stale-aim bar (RFC #59).
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") voiceAimMarkRef.current = aimSeqRef.current; };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // one pdf.js document per file, cached for the life of the project view —
  // the canvas render AND the gallery thumbnails share this cache
  // Bytes come from the local store (IndexedDB); pdf.js needs them up front, so
  // the cache holds a PROMISE of the loading task (not the task itself).
  const docFor = useCallback((file) => {
    let t = pdfDocsRef.current.get(file);
    if (!t) {
      t = store.loadPdfData(file).then((data) => pdfjsLib.getDocument({ data }));
      // never cache a FAILED load: a file removed and re-added under the same
      // name (Manage → remove, then re-open) would otherwise pin the removal-
      // race rejection for the life of the view and refuse to ever render
      t.catch(() => { if (pdfDocsRef.current.get(file) === t) pdfDocsRef.current.delete(file); });
      pdfDocsRef.current.set(file, t);
    }
    return t.then((task) => task.promise);
  }, []);

  // dark toggle: repaint the base layer of every already-loaded panel at the
  // new mode (the detail effect below also depends on darkMode, so it
  // repaints too). Tiles are cached PER MODE (tileCompositor.ts), so a
  // toggle-back is instant once both variants have been seen once.
  useEffect(() => {
    darkModeRef.current = darkMode;
    if (status !== "ready") return;
    for (const d of drawPanels) {
      const cv = panelCanvasRefs.current.get(d.drawKey);
      if (cv && d.w) getCompositor().paintBase(cv, d.drawKey, d.w, d.h, darkMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode]);

  // ── render the sheet group (a single sheet is a group of one) ──────────────
  // Two phases: (A) resolve every panel's LOGICAL dimensions — page-points ×
  // RENDER_SCALE, fixed forever, never rastered directly (see tiles.ts's
  // header comment on why this makes factorFor collapse to a constant) — so
  // the row layout is final before any pixel paints, then (B) hand each sheet
  // to the tile compositor, which paints a small bounded coarse placeholder
  // (the base layer) and opens the sheet in the worker pool for on-demand
  // tile rendering. A monotonic token is checked after EVERY await so a stale
  // chain can never paint, resize, or cancel a newer chain's work.
  useEffect(() => {
    if (!active) return;
    const seq = ++renderSeqRef.current;
    const stale = () => seq !== renderSeqRef.current;
    setStatus("rendering"); setErr(""); clearPoly(); setCalib([]); setPendingLen(""); setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null); selectShape(null); setProposal(null); setAlignPt(null); resetZone();
    for (const [, rt] of renderTasksRef.current) { try { rt.cancel(); } catch { /* done */ } }
    renderTasksRef.current.clear();
    snapGridsRef.current.clear();
    vectorSegsRef.current.clear();
    segMetaRef.current.clear();
    subpathsRef.current.clear();
    textMarksRef.current.clear();
    layerGeoRef.current.clear();
    layerInfosRef.current.clear();
    setSheetLayers({});
    maskCacheRef.current.clear();
    sheetStatsRef.current.clear();
    rasterMaskCacheRef.current.clear();
    canvasInvertedRef.current.clear();
    pageObjsRef.current.clear();
    renderScalesRef.current.clear();
    getCompositor().resetAll();
    for (const [, c] of detailCancelsRef.current) { try { c.cancel(); } catch { /* done */ } }
    detailCancelsRef.current.clear();
    detailKeysRef.current.clear();
    for (const [, cv] of detailCanvasRefs.current) cv.style.display = "none";
    (async () => {
      // resolve one drawable source: doc → page → viewport at the FIXED logical scale
      const resolveSource = async (memberKey) => {
        const { file, page: pn } = parseSheetKey(memberKey);
        const pdf = await docFor(file); if (stale()) return null;
        if (file === active) setPageCount(pdf.numPages || 1);
        const pageNum = Math.min(Math.max(1, pn), pdf.numPages || 1);
        const pageObj = await pdf.getPage(pageNum); if (stale()) return null;
        const viewport = pageObj.getViewport({ scale: RENDER_SCALE });
        // wf/hf: the EXACT logical dims — stitch extents must accumulate these,
        // not the ceil'd canvas dims, or a composite of N members drifts up to
        // N px wide. That drift is not cosmetic: the one-click mask downscale
        // (MASK_MAX_DIM/width) is resolution-sensitive, and a 6049px stitch of
        // a 6048px drawing measurably breaks flood fills the 6048px original
        // sustains (reproduced on the split-sheet fixture; same failure occurs
        // feeding 6049 to the ORIGINAL sheet's mask — the drift was the bug,
        // not the merge).
        return { key: memberKey, file, pageNum, pageObj, viewport, w: Math.ceil(viewport.width), h: Math.ceil(viewport.height), wf: viewport.width, hf: viewport.height };
      };
      // phase A — logical dimensions for every panel. A stitch panel (#161)
      // resolves each MEMBER and takes the composite extent; its members'
      // pageObjs register under their own keys (one-off render paths address
      // sheets, not composites), while the merged snap/mask geometry below
      // registers under the STITCH key — the only key the input model sees.
      const metas = [];
      for (const key of groupKeys) {
        const st = stitchById[key];
        if (st) {
          const sources = [];
          const dims = {};   // EXACT member dims — extent, seams and align math all read these
          for (const mem of st.members) {
            const s = await resolveSource(mem.key); if (stale()) return; if (!s) return;
            pageObjsRef.current.set(mem.key, s.pageObj);
            renderScalesRef.current.set(mem.key, RENDER_SCALE);
            dims[mem.key] = { w: s.wf, h: s.hf };
            sources.push({ ...s, drawKey: `${key}::${mem.key}`, dx: mem.dx, dy: mem.dy });
          }
          panelSourceDimsRef.current.set(key, dims);
          renderScalesRef.current.set(key, RENDER_SCALE);
          const ext = stitchExtent(st.members, dims);
          metas.push({ key, file: key, stitch: st, dims, sources, w: ext.w, h: ext.h });
        } else {
          const s = await resolveSource(key); if (stale()) return; if (!s) return;
          pageObjsRef.current.set(key, s.pageObj);     // kept for getOperatorList/getTextContent and the independent one-off render paths (raster-mask, agent vision, schedule marquee) — unrelated to painting, still main-thread
          renderScalesRef.current.set(key, RENDER_SCALE);
          metas.push({ ...s, sources: [{ ...s, drawKey: key, dx: 0, dy: 0 }] });
        }
      }
      setPanelImgs(Object.fromEntries(metas.map((m) => [m.key, { w: m.w, h: m.h }])));
      let rw = 0, rh = 0;
      for (const m of metas) { rw += (rw ? PANEL_GAP : 0) + m.w; rh = Math.max(rh, m.h); }
      fitToView(rw, rh);
      // phase B — open each source sheet in the worker pool + paint its coarse
      // base layer (a stitch contributes one canvas per member, positioned by
      // the drawPanels expansion). Sheets are independent pdf.js docs in the
      // pool now (not one shared canvas context), so there's no reason to
      // serialize them the way the old left-to-right raster loop had to.
      await Promise.all(metas.flatMap((m) => m.sources.map(async (s) => {
        getCompositor().openSheet(s.drawKey, s.pageNum, store.loadPdfData(s.file), s.w, s.h);
        let canvas = panelCanvasRefs.current.get(s.drawKey);
        for (let t = 0; !canvas && t < 10; t++) {
          await new Promise((r) => requestAnimationFrame(r)); if (stale()) return;
          canvas = panelCanvasRefs.current.get(s.drawKey);
        }
        if (!canvas || stale()) return;
        await getCompositor().paintBase(canvas, s.drawKey, s.w, s.h, darkModeRef.current);
      })));
      if (stale()) return;
      // vector geometry per PANEL (best-effort; snap is off until enabled).
      // Plain panels keep the old per-sheet path byte-for-byte; a stitch merges
      // its members' geometry into stitch space, seam-clipped so hidden ink
      // near the match line neither offers snap targets nor walls off the
      // one-click mask (lib/stitches.ts mergePoints/mergeSegs).
      for (const m of metas) {
        if (m.stitch) {
          const clips = seamClips(m.stitch.members, m.dims);
          Promise.all(m.sources.map((s) => s.pageObj.getOperatorList().then((ol) => ({ s, g: extractVectorGeometry(ol, s.viewport.transform, pdfjsLib.OPS) })))).then((parts) => {
            if (stale()) return;
            const byIdx = parts.map(({ s, g }, i) => ({
              points: g.points, segs: g.segs, meta: g.meta, imageArea: g.imageArea,
              dx: s.dx, dy: s.dy,
              clip: { x0: clips[i].x0, y0: clips[i].y0, x1: clips[i].x1, y1: clips[i].y1 },
            }));
            const pts = mergePoints(byIdx);
            const merged = mergeSegs(byIdx);
            snapGridsRef.current.set(m.key, buildSnapGrid(pts, SNAP_CELL));
            vectorSegsRef.current.set(m.key, merged.segs);
            segMetaRef.current.set(m.key, merged.meta);
            sheetStatsRef.current.set(m.key, { segCount: merged.segs.length >> 2, imageFrac: Math.min(1, merged.imageArea / (m.w * m.h)) });
            // verbose stitch tracing, gated like __OT_DETAIL_DEBUG
            if (window.__OT_STITCH_DEBUG) window.__stitchGeom = { key: m.key, clips, members: m.stitch.members, dims: m.dims, w: m.w, h: m.h, segs: merged.segs.length >> 2, perMember: byIdx.map((b) => ({ dx: b.dx, dy: b.dy, clip: b.clip, n: b.segs.length >> 2 })) };
          }).catch(() => {
            if (stale()) return;
            sheetStatsRef.current.set(m.key, { segCount: 0, imageFrac: 1 });
          });
          // scale note: the first member speaks for the composite (members
          // plot at one scale by construction — see createStitch's seeding)
          m.sources[0].pageObj.getTextContent().then((tc) => {
            if (stale()) return;
            const det = detectScale(tc, m.sources[0].viewport);
            if (det) setDetectedScales((d) => (d[m.key]?.label === det.label ? d : { ...d, [m.key]: det }));
          }).catch(() => {});
          continue;
        }
        // snap-to-vector index per panel (best-effort; off until the user enables it)
        m.pageObj.getOperatorList().then(async (ol) => {
          if (stale()) return;
          const { points, segs, meta, imageArea, lum, layerOf, layerIds, subpaths } = extractVectorGeometry(ol, m.viewport.transform, pdfjsLib.OPS);
          snapGridsRef.current.set(m.key, buildSnapGrid(points, SNAP_CELL));
          vectorSegsRef.current.set(m.key, segs);
          segMetaRef.current.set(m.key, meta);
          if (subpaths) subpathsRef.current.set(m.key, subpaths);
          if (lum) segLumRef.current.set(m.key, lum);
          textTfRef.current.set(m.key, m.viewport.transform);
          // raster-fallback trigger signals: how much of the sheet is placed
          // image, and whether the vector linework is dense enough to bound rooms
          sheetStatsRef.current.set(m.key, { segCount: segs.length >> 2, imageFrac: Math.min(1, imageArea / (m.w * m.h)) });
          // classify the sheet's PDF layer table (#85): the walk attributed
          // segments to OCG ids; the DOCUMENT declares id → (name, default
          // visibility). buildLayerInfos is the same pure derivation the MCP
          // session runs, so panel and sheet_info can never disagree. An empty
          // table is the (common) unlayered case — the Layers control stays
          // invisible and the mask path is byte-identical to pre-#85. Own
          // try/catch: a failed config read degrades to unlayered, and must
          // never trip the outer catch into the corrupt-op-list stats sentinel.
          let infos = [];
          if (layerIds.length) {
            try {
              const cfg = await (await docFor(m.file)).getOptionalContentConfig();
              const groups = cfg ? cfg.getGroups() : null;
              infos = buildLayerInfos(layerIds, layerOf, new Map(Object.entries(groups || {})));
            } catch { /* no resolvable declarations — nothing is stated */ }
          }
          if (stale()) return;
          layerGeoRef.current.set(m.key, { layerIds, layerOf });
          layerInfosRef.current.set(m.key, infos);
          maskCacheRef.current.delete(m.key);   // a mask built before the table resolved was roleless
          setSheetLayers((prev) => ({ ...prev, [m.key]: infos }));
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
        // read the drawn scale note off this panel's page text (best-effort),
        // and the positioned dimension-pattern texts the dim-string classifier
        // anchors on (#320) — a mask built before they resolved was textless
        m.pageObj.getTextContent().then((tc) => {
          if (stale()) return;
          const det = detectScale(tc, m.viewport);
          if (det) setDetectedScales((d) => (d[m.key]?.label === det.label ? d : { ...d, [m.key]: det }));
          // positioned text for ink classification — a mask built before this
          // resolved simply had no text evidence (the layer-table precedent)
          const marks = extractTextMarks(tc, m.viewport);
          if (marks.length) { textMarksRef.current.set(m.key, marks); maskCacheRef.current.delete(m.key); }
          const dts = extractDimTexts(tc, m.viewport);
          if (dts.length) { dimTextsRef.current.set(m.key, dts); maskCacheRef.current.delete(m.key); }
        }).catch(() => {});
      }
      if (stale()) return;
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
  }, [groupSig]);

  // ── detail view: composite the visible region + margin from cached tiles ──
  // Generalizes the old single-detail-canvas effect to EVERY panel (group
  // mode previously only ever sharpened the last-focused one — see the #86
  // research note) and drops the DETAIL_ENGAGE threshold entirely: tiles are
  // the only raster path now, active at every zoom level, not a sharpening
  // overlay on top of an already-acceptable base. Pixels only — markup is an
  // SVG sibling ABOVE these canvases, and quantities never touch render
  // pixels: both untouched.
  //
  // This is a REF-CALLED FUNCTION, not a plain tf-keyed effect: scheduleSync
  // (below) intentionally skips mirroring tfRef into the `tf` REACT STATE for
  // a pure pan below the old DETAIL_ENGAGE threshold (avoids a full SVG-
  // overlay reconciliation storm on a zoomed-out pan — see its comment). That
  // optimization predates tiles being always-active; if this logic only ran
  // off `tf` state, a low-zoom pan would never reposition the visible-region
  // crop. So scheduleSync calls syncTilePanelsRef.current() on EVERY tick,
  // state-mirror-skip or not, and this effect is just the "also run it after
  // a structural render" path (load, dark toggle, group change, panel resize).
  const syncTilePanelsRef = useRef(() => {});
  useEffect(() => {
    syncTilePanelsRef.current = () => {
      const cont = containerRef.current;
      if (!cont || status !== "ready") return;
      const t = tfRef.current;
      // Mid-gesture bail: resizing a detail canvas mid-pinch would flash the
      // region blank and storm the worker pool with cancelled renders. The
      // previous crop stays correctly anchored in stage space (it rides the
      // same CSS transform everything else does), so leaving it painted is
      // free; self-poll so the settle repaint is guaranteed even if no further
      // input event arrives before the gesture window expires.
      if (panRef.current || performance.now() < gestureUntilRef.current) { scheduleSync(); return; }
      // Gesture settled: demote the stage layer (see promoteStage) so the SVG
      // overlay re-rasters at the zoom the user landed on — this is what
      // un-pixelates a drafted boundary after a scroll-zoom.
      if (stageRef.current && stageRef.current.style.willChange !== "auto") stageRef.current.style.willChange = "auto";
      const r = cont.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const density = tileRequiredDensity(t.scale, dpr);
      // draw-time entries, not input panels: a stitch (#161) sharpens one crop
      // per MEMBER, each clipped to its seam box (the wrapper div does the
      // clipping; the canvas positions relative to it via the x/y bases).
      for (const d of drawPanels) {
        const cv = detailCanvasRefs.current.get(d.drawKey);
        if (!cv || !d.w) continue;
        const hide = () => { cv.style.display = "none"; detailKeysRef.current.delete(d.drawKey); };
        // visible region of THIS source, in ITS image px (stage space minus its
        // stage origin), intersected with the seam-visible box when clipped
        const vx0 = d.clip ? Math.max(d.x, d.clip.x) : d.x;
        const vy0 = d.clip ? Math.max(d.y, d.clip.y) : d.y;
        const vx1 = d.clip ? Math.min(d.x + d.w, d.clip.x + d.clip.w) : d.x + d.w;
        const vy1 = d.clip ? Math.min(d.y + d.h, d.clip.y + d.clip.h) : d.y + d.h;
        let x0 = Math.max((-t.x) / t.scale, vx0) - d.x;
        let y0 = Math.max((-t.y) / t.scale, vy0) - d.y;
        let x1 = Math.min((r.width - t.x) / t.scale, vx1) - d.x;
        let y1 = Math.min((r.height - t.y) / t.scale, vy1) - d.y;
        if (x1 <= x0 || y1 <= y0) { hide(); continue; }         // source off-screen
        const mw = (x1 - x0) * DETAIL_MARGIN, mh = (y1 - y0) * DETAIL_MARGIN;
        x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh);
        x1 = Math.min(d.w, x1 + mw); y1 = Math.min(d.h, y1 + mh);
        // one composite per distinct crop — the sync loop re-fires this several
        // times around a settle with identical inputs
        const renderKey = `${d.drawKey}|${x0.toFixed(1)},${y0.toFixed(1)}|${x1.toFixed(1)},${y1.toFixed(1)}|${density.toFixed(2)}|${darkModeRef.current ? 1 : 0}`;
        if (renderKey === detailKeysRef.current.get(d.drawKey)) continue;
        detailKeysRef.current.set(d.drawKey, renderKey);
        try { detailCancelsRef.current.get(d.drawKey)?.cancel(); } catch { /* done */ }
        // paintDetail owns position/size/pixels together now and applies all
        // three atomically on reveal — setting them here first would show a
        // correctly-positioned canvas with the OLD crop's (wrongly scaled)
        // pixels for a frame, which is its own flavor of flicker.
        // Position bases are relative to the canvas's offset parent: the stage
        // for a plain panel, the clipping wrapper for a stitch member.
        const xBase = d.clip ? d.x - d.clip.x : d.x;
        const yBase = d.clip ? d.y - d.clip.y : d.y;
        const cancel = getCompositor().paintDetail(cv, d.drawKey, xBase, x0, y0, x1, y1, density, darkModeRef.current, () => {}, yBase);
        detailCancelsRef.current.set(d.drawKey, cancel);
      }
    };
  });
  const [repaintTick, setRepaintTick] = useState(0);
  // panelW/takeoffsOpen: docking or resizing the Takeoffs panel changes the
  // container rect without a transform change. repaintTick: bumped by the
  // visibilitychange recovery below.
  useEffect(() => { syncTilePanelsRef.current(); }, [tf, groupSig, status, panelW, takeoffsOpen, darkMode, repaintTick]);

  // Primary recovery for a stalled tile fetch: a hidden tab can suspend
  // in-flight work indefinitely with no error (Chrome throttles rAF-gated
  // work in hidden tabs) — clear every panel's render key and retry on return.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      detailKeysRef.current.clear();
      setRepaintTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // the doc cache holds whole PDFs in the worker — tear it down when the
  // project view unmounts or the project changes. The tile compositor (its
  // worker pool + up to BYTE_BUDGET of ImageBitmaps) goes down with it:
  // dispose-and-NULL pairs with getCompositor's lazy ??= creation, which is
  // what makes this safe under StrictMode's extra mount/unmount cycles — a
  // post-dispose render just mints a fresh compositor instead of hitting a
  // permanently-dead pool (the failure mode an eager create/dispose effect
  // pair was observed to cause; see getCompositor's comment).
  useEffect(() => () => {
    for (const [, t] of pdfDocsRef.current) { t.then((task) => { try { task.destroy(); } catch { /* already gone */ } }).catch(() => {}); }
    pdfDocsRef.current.clear();
    try { compositorRef.current?.dispose(); } catch { /* half-built pool */ }
    compositorRef.current = null;
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
    return { project_name: projectName, ...(units === "metric" ? { units } : {}), ...(Object.values(clientInfo).some((v) => v && String(v).trim()) ? { client_info: clientInfo } : {}), sheets: Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, ...(scaleSources[sheet_id] ? { scale_source: scaleSources[sheet_id] } : {}), ...(scaleUnconfirmed[sheet_id] === false ? { scale_confirmed: false } : {}) })), conditions, ...(conditionColumns.length ? { condition_columns: conditionColumns } : {}), ...(shapeLabels.length ? { shape_labels: shapeLabels } : {}), ...(pinned.length ? { palette: pinned } : {}), shapes, markups, rfis, ...(approvals.length ? { approvals } : {}), ...(rules.length ? { rules } : {}), sheet_group: sheetGroup, last_group: lastGroup, sheet_tabs: openTabs, ...(stitches.length ? { stitches } : {}), ...(Object.keys(sheetLevels).length ? { sheet_levels: sheetLevels } : {}), ...(Object.keys(layerOverrides).length ? { layer_overrides: layerOverrides } : {}), ...(Object.keys(provCounters.shapes_deleted).length ? { provenance_counters: provCounters } : {}) };
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
    clearPoly(); setCalib([]); setPendingLen(""); selectShape(null); setProposal(null);
    setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null);
    resetZone();
    hydrate(payload || {});
  };

  // "Import takeoff…" (Sheet menu) — the file half of the agent handoff: an
  // MCP session's export_takeoff JSON (the app's own autosave schema) lands
  // here. The merge rules are pure and tested (lib/importTakeoff.js): operator
  // state wins, re-import is idempotent. Landed machine shapes keep
  // origin.reviewed:false, so the committed-but-unreviewed path renders them
  // dashed in their condition colors until the Accept banner inks them; the
  // runtime-load path above resets in-flight work, and mid-session savesArmed
  // is already true, so the merged payload autosaves like any other edit.
  const importTakeoffFile = async (file) => {
    if (!file) return;
    try {
      const imported = parseTakeoffImport(await file.text());
      const { payload, note } = mergeTakeoffImport(buildPayload(), imported, sheets.map((s) => s.name));
      restoreSavedPayload(payload);
      const parts = [`Imported ${note.shapes_added} shape${note.shapes_added === 1 ? "" : "s"}`];
      if (note.shapes_pending) parts.push(`${note.shapes_pending} dashed pending your review — Accept turns pencil to ink`);
      if (note.conditions_added) parts.push(`${note.conditions_added} new condition${note.conditions_added === 1 ? "" : "s"}`);
      if (note.conditions_merged) parts.push(`${note.conditions_merged} matched your finish tags`);
      if (note.unknown_files.length) parts.push(`some shapes reference ${note.unknown_files.join(", ")} — open that file to see them`);
      setCommitMsg(parts.join(" · ") + ".");
    } catch (e) {
      // module copy already speaks "Couldn't…" (the sticky danger convention);
      // anything unexpected gets wrapped into it rather than aging out unread
      setCommitMsg(String(e?.message || "").startsWith("Couldn't") ? e.message : `Couldn't import takeoff: ${e?.message || e}`);
    }
  };

  // "Export takeoff…" (Sheet menu) — the other half of the file pair (#285).
  // The app has always READ takeoff_canvas.v1 and never written one to disk,
  // so the only copy of a finished takeoff lived in this browser profile's
  // IndexedDB: a cleared profile, a new machine, or a second estimator and
  // the work was unreachable. This writes the EXACT document autosave writes
  // — no export-only shape, no report flattening — so Import takeoff reads it
  // back into an editable takeoff, and a diff between two exports is a diff
  // between two saves.
  //
  // The plan PDF is deliberately NOT in it: this is the annotation record, the
  // same one the MCP export_takeoff emits, and it names its sheets by file.
  // Restoring means opening the same PDF first — the message says so, since a
  // backup that silently restores to nothing is worse than no backup.
  const exportTakeoffFile = () => {
    const payload = { schema: ANN_SCHEMA, ...buildPayload() };
    const base = (projectName || "takeoff").trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "takeoff";
    downloadText(`${base}.takeoff.json`, JSON.stringify(payload, null, 2), "application/json");
    const n = shapes.length;
    setCommitMsg(`Exported ${base}.takeoff.json — ${n} takeoff${n === 1 ? "" : "s"}, ${conditions.length} condition${conditions.length === 1 ? "" : "s"}. The plan PDF isn't in it: to restore, open the same PDF, then Import takeoff.`);
  };

  // "Clear workspace" (#301) — the deliberate start-fresh: every stored PDF
  // goes and the takeoff resets to empty, without touching browser storage by
  // hand. Local mode only (a cloud project's canon lives in Drive — Close
  // project is that mode's exit). Commit before risk: a non-empty takeoff is
  // snapshotted first, so the work is one Revisions-panel restore away — the
  // PDFs themselves are gone either way (local plans aren't stored elsewhere);
  // restored shapes re-attach by sheet name when the same files are re-opened.
  const clearWorkspace = async () => {
    const names = sheets.map((s) => s.name);
    let saved = false;
    if (shapes.length || conditions.length || markups.length) {
      try { await store.saveSnapshot(`Before Clear workspace — ${new Date().toLocaleString()}`, buildPayload()); saved = true; }
      catch { /* best-effort (quota) — clearing continues; message says what happened */ }
    }
    for (const n of names) { try { await store.removePdf(n); } catch { /* already gone */ } evictDoc(n); }
    forgetPages(names);
    releaseThumbs(thumbCacheRef.current);
    setGalleryLabels({});
    setDetectedScales({});
    reconcileAfterRemoval("", await refreshSheets());
    restoreSavedPayload(emptyAnnotations());
    setCommitMsg(saved
      ? `Workspace cleared — ${names.length} PDF${names.length === 1 ? "" : "s"} removed. The takeoff was snapshotted first: Revisions → restore brings it back (re-open the same PDFs to see its shapes).`
      : `Workspace cleared — ${names.length} PDF${names.length === 1 ? "" : "s"} removed.`);
  };

  // "Export project archive…" (#300) — the whole job as ONE portable .otk:
  // every stored plan's bytes plus the exact autosave payload. The other half
  // of the #285 pair: Export takeoff is the annotation record alone (open the
  // same PDF to restore); this is the archive that carries its own paper.
  const exportProjectArchive = async () => {
    if (!sheets.length) { setCommitMsg("Couldn't export project: no plans are open."); return; }
    const base = (projectName || "project").trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "project";
    try {
      const data = await buildProjectArchive({
        takeoff: { schema: ANN_SCHEMA, ...buildPayload() },
        sheets,
        loadPdfData: (n) => store.loadPdfData(n),
        projectName,
        onProgress: setCommitMsg,
      });
      downloadArchive(`${base}.otk`, data);
      setCommitMsg(`Exported ${base}.otk — ${sheets.length} PDF${sheets.length === 1 ? "" : "s"} + the full takeoff (${shapes.length} shape${shapes.length === 1 ? "" : "s"}). Self-contained: open it on any machine, or hand it to another estimator.`);
    } catch (e) {
      setCommitMsg(`Couldn't export project: ${e?.message || e}`);
    }
  };

  // Open a .otk (drop or file picker): REPLACE the workspace with the archived
  // project. Commit before risk — the current takeoff, if non-empty, is
  // snapshotted first so opening an archive is never a silent overwrite.
  const importProjectArchive = async (file) => {
    try {
      setCommitMsg(`Opening ${file.name}…`);
      const { takeoff, pdfs } = await parseProjectArchive(new Uint8Array(await file.arrayBuffer()));
      if (shapes.length || conditions.length || markups.length) {
        try { await store.saveSnapshot(`Before opening ${file.name} — ${new Date().toLocaleString()}`, buildPayload()); }
        catch { /* best-effort — the open continues; archives are additive to PDFs */ }
      }
      for (const f of pdfs) {
        setCommitMsg(`Restoring ${f.name}…`);
        await store.addPdf(f);        // same-name different-bytes archives a revision (CO-1), never a silent overwrite
        evictDoc(f.name);             // stale docs must re-read the restored bytes
      }
      forgetPages(pdfs.map((f) => f.name));
      setDocEpoch((e) => e + 1);
      await refreshSheets();
      restoreSavedPayload(takeoff);
      const n = Array.isArray(takeoff.shapes) ? takeoff.shapes.length : 0;
      setCommitMsg(`Opened ${file.name} — ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"}, ${n} takeoff${n === 1 ? "" : "s"}.${shapes.length || conditions.length ? " Your previous takeoff was snapshotted — Revisions restores it." : ""}`);
    } catch (e) {
      setCommitMsg(String(e?.message || "").startsWith("Couldn't") ? e.message : `Couldn't open project: ${e?.message || e}`);
    }
  };

  // ── estimator profile (#299) — export / import / reset the working
  // environment (condition templates, materials, stamps, report setup),
  // never project data. Import and reset both DOWNLOAD the current profile
  // first: the receipt is the rollback (Import profile restores it), so
  // neither needs a second confirmation step.
  const refreshLibraries = async () => {
    const tpl = await store.loadTemplates().catch(() => []);
    templatesRef.current = tpl; setTemplates(tpl);
    setMatLib(await store.loadMaterialLibrary().catch(() => []));
    const lib = await store.loadStampLibrary().catch(() => ({ stamps: [], sets: [] }));
    stampLibRef.current = lib; setStampLib(lib);
  };
  const profileSummary = (p) =>
    `${(p.condition_templates || []).length} condition template${(p.condition_templates || []).length === 1 ? "" : "s"}, ${(p.material_library || []).length} material${(p.material_library || []).length === 1 ? "" : "s"}, ${(p.stamp_library?.stamps || []).length} stamp${(p.stamp_library?.stamps || []).length === 1 ? "" : "s"}, ${(p.report_templates || []).length} report template${(p.report_templates || []).length === 1 ? "" : "s"}`;
  const exportProfileFile = async () => {
    try {
      const p = await buildProfile();
      downloadText("opentakeoff-profile.otprofile", JSON.stringify(p, null, 2), "application/json");
      setCommitMsg(`Exported opentakeoff-profile.otprofile — ${profileSummary(p)}. Import it on another machine to carry your setup over.`);
    } catch (e) { setCommitMsg(`Couldn't export profile: ${e?.message || e}`); }
  };
  const backupProfileFile = async () => {
    const backup = await buildProfile();
    downloadText("opentakeoff-profile-backup.otprofile", JSON.stringify(backup, null, 2), "application/json");
  };
  const importProfileFile = async (file) => {
    if (!file) return;
    try {
      const p = parseProfile(await file.text());
      await backupProfileFile();
      const n = await applyProfile(p);
      await refreshLibraries();
      setCommitMsg(`Applied profile${p.name ? ` "${p.name}"` : ""} — ${n.templates} condition template${n.templates === 1 ? "" : "s"}, ${n.materials} material${n.materials === 1 ? "" : "s"}, ${n.stamps} stamp${n.stamps === 1 ? "" : "s"}, ${n.reportTemplates} report template${n.reportTemplates === 1 ? "" : "s"}. Your previous setup downloaded as opentakeoff-profile-backup.otprofile.`);
    } catch (e) {
      setCommitMsg(String(e?.message || "").startsWith("Couldn't") ? e.message : `Couldn't apply profile: ${e?.message || e}`);
    }
  };
  const resetProfile = async () => {
    try {
      await backupProfileFile();
      await resetProfileDefaults();
      await refreshLibraries();
      setCommitMsg("Profile reset to OpenTakeoff defaults — your previous setup downloaded as opentakeoff-profile-backup.otprofile (Import profile restores it). Project takeoffs are untouched.");
    } catch (e) { setCommitMsg(`Couldn't reset profile: ${e?.message || e}`); }
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
    // A reconcile adopted a remote winner into local (synced_rev is already advanced)
    // but the canvas is still showing the SUPERSEDED pre-adopt content because we
    // deferred the render while busy (Slice 5b Case 2). Persisting/pushing now would
    // send stale content at the winner's rev and silently clobber it. Skip entirely
    // until the idle-drain re-hydrates the winner; any edits made on this superseded
    // canvas are dropped by that re-hydrate (visible supersession, not silent loss —
    // the co-editing casualty the rollout forbids). The drain clears the flag.
    if (remotePendingRender.current) return;
    const payload = buildPayload();
    saveDataRef.current = payload;          // keep the freshest payload for an unmount flush
    setSaveState("saving");
    const t = setTimeout(() => {
      // A render was deferred AFTER this save was scheduled (its closure captured the
      // pre-adopt payload) → don't push stale over the winner; go idle so the canvas
      // can drain and re-hydrate. Closes the last pre-scheduled-save loss window.
      if (remotePendingRender.current) { setSaveState("idle"); return; }
      store.saveAnnotations(payload).then(() => setSaveState("saved")).catch((e) => {
        // surface the failure rather than dropping to a silent "idle" — with inline
        // image markups a QuotaExceededError is a realistic failure mode, and a
        // silent one loses the WHOLE payload (shapes, quantities, everything) with
        // no signal. Stale-tab keeps its sticky lockout copy; anything else (quota,
        // disk) shows the actionable friendlyStoreError text.
        setCommitMsg(isStaleTabError(e) ? STALE_TAB_MESSAGE : friendlyStoreError(e));
        setSaveState("idle");
      });
    }, 700);
    return () => clearTimeout(t);
    // buildPayload is intentionally omitted: this dep list IS the exact set of
    // state it serializes, so listing buildPayload (a new identity each render)
    // would fire a save on every render instead of only on a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, conditions, conditionColumns, shapeLabels, palette, scales, scaleSources, markups, approvals, rfis, rules, provCounters, sheetGroup, sheetLevels, layerOverrides, lastGroup, openTabs, stitches, projectName, clientInfo, units]);
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

  // ── Local-first sync bridge (Slices 5a + 5b) ───────────────────────────────
  // On the opted-in path the active store carries a non-enumerable `syncBridge`
  // (main.jsx); on the legacy cloud path (and anonymous local) there is none, so
  // every handler below is a no-op and flag-off behavior is byte-identical.

  // The defer-gate predicate. computeBusy reads ONLY refs (busyStateRef, mirrored
  // from state every render, plus the interaction refs), so it is always fresh yet
  // stable to capture once — no re-registration null window. isCanvasBusy is the
  // pure, unit-tested core (lib/canvasBusy.js); it must report EVERY interaction mode
  // a mid-session re-hydrate would clobber (trace/calibrate/check, One-Click review,
  // a scheduled save, an active drag, the open text editor, an in-flight OCR scan,
  // an agent run and its staged proposals — hydrate() wipes agentProposals and the
  // conditions a mid-run agent minted, so both defer exactly like One-Click review).
  busyStateRef.current = { poly, calib, check, proposal, scaleGuide, prevScale, agentRunning, agentProposals };
  const computeBusy = () => isCanvasBusy({
    ...busyStateRef.current,
    saveState: saveStateRef.current,
    dragging: !!dragRef.current || !!ocDragRef.current,
    editing: editingRef.current,
    scanning: scanBusyRef.current,
  });

  // Register both reconcile handlers ONCE. onRemoteUpdate handles CASE 2: the store
  // adopted remote→local, then the canvas went busy in maybeFlush's ~2-IDB-write gap
  // before this fires. Re-check busy at APPLY time — if busy, DEFER the render (local
  // already equals remote on Drive; the idle-drain below re-hydrates) rather than
  // clobber the in-flight work; else suppress the echo and hydrate. EITHER branch
  // nulls saveDataRef so the unmount flush can't push a pre-adopt payload at a fresh
  // rev over the remote winner. (It does NOT stop an already-scheduled debounced save
  // firing stale — that is the documented residual, active-co-editing-only.)
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge) return;
    bridge.isBusy = computeBusy;
    bridge.onRemoteUpdate = (data) => {
      saveDataRef.current = null;
      if (computeBusy()) { remotePendingRender.current = true; return; }
      remotePendingRender.current = false; // this hydrate satisfies any earlier deferred render
      suppressNextSave.current = true;
      hydrate(data || {});
    };
    return () => { bridge.isBusy = null; bridge.onRemoteUpdate = null; };
    // computeBusy + hydrate are stable for a given mount (they read only refs / call
    // setters), so capture once; listing them would re-register every render, opening
    // a null window where an arriving reconcile is dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Presence (#317): tell the heartbeat which sheet is open. Ref-mirrored so
  // the getter registers once (same discipline as the handlers above) yet
  // always reads the current sheet.
  const presenceSheetRef = useRef("");
  presenceSheetRef.current = sheetKey || "";
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge) return;
    bridge.getSheet = () => presenceSheetRef.current || null;
    return () => { bridge.getSheet = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle-drain. When the canvas goes idle, drain BOTH defer paths:
  //   CASE 1 — the store deferred at its own gate (isBusy true → never adopted,
  //     pendingRemote held, local untouched): flushPending() adopts now and fires
  //     onRemoteUpdate → hydrate.
  //   CASE 2 — we deferred the render above: re-read LOCAL (freshest — the adopt, or a
  //     local edit the user saved during the busy window; stashing the remote data
  //     would silently clobber that saved edit) and hydrate.
  // `saveState` is in the deps because the last thing to clear on going idle is usually
  // the debounced save (saving→saved) — and it must gate re-hydrate anyway so a
  // committed trace's pending save lands before we re-read (CRITICAL-b).
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge || computeBusy()) return;
    let alive = true;
    (async () => {
      // Serialize: drain Case 1 FIRST so a store-deferred adopt lands (and its
      // onRemoteUpdate hydrates + clears remotePendingRender) before the Case 2
      // re-read — otherwise the re-read could race the adopt's IDB writes and read
      // stale local.
      await bridge.flushPending?.();
      // Re-check after the awaits: unmounted, or the user went busy again → bail and
      // leave remotePendingRender set so the NEXT idle retries (never a dropped render).
      if (!alive || !remotePendingRender.current || computeBusy()) return;
      try {
        const a = await store.loadAnnotations(); // freshest local: the adopt, or an interim saved edit
        // A concurrent store-side onRemoteUpdate may have hydrated + cleared the flag
        // during the await — don't double-hydrate (Finding 4).
        if (!alive || computeBusy() || !remotePendingRender.current) return;
        remotePendingRender.current = false;      // clear ONLY after a successful read
        suppressNextSave.current = true;
        hydrate(a || {});
      } catch { /* keep remotePendingRender → retry on the next idle, never drop it */ }
    })();
    return () => { alive = false; };
    // computeBusy/hydrate are stable (refs/setters); the deps below ARE the idle-
    // transition triggers. saveState catches the debounced-save clearing; idleTick
    // catches an interaction ref (drag/editor/scan) clearing with no state change.
    // agentRunning/agentProposals: the run finishing or the last proposal being
    // accepted/rejected is a busy→idle edge that must drain a held remote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poly, calib, check, proposal, scaleGuide, prevScale, saveState, idleTick, agentRunning, agentProposals]);

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
      promoteStage();                   // gesture opening: composite the stage for cheap per-frame moves
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
  }, [applyTf, scheduleSync, zoomAround, promoteStage]);

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
      // "?" opens the manual. Here rather than in its own listener so it
      // inherits this effect's guards — a "?" typed into a condition tag or
      // with a toolbar menu open must not pop a dialog over the work.
      if (e.key === "?") { e.preventDefault(); setGuideOpen(true); return; }
      if (e.key === "Enter") {
        // router offer confirm takes the key FIRST (RFC #59 slice 5): the
        // offer is the most recent thing the user was told ⏎ does, and it
        // auto-expires — so it can never contest ⏎ for long, and a pending
        // agent-proposal accept resumes the key the moment the offer clears
        if (agentOfferFnsRef.current?.pending()) { e.preventDefault(); agentOfferFnsRef.current.confirm(); return; }
        if (tool === "oneclick" && proposal?.regions.length) { e.preventDefault(); createProposal(); return; }
        const ok = !bowOpen && (((tool === "area" || tool === "deduct") && poly.length >= 3) || (tool === "zone" && poly.length >= 3 && !zoneTraceCross) || ((tool === "linear" || tool === "surface") && poly.length >= 2));
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
      if (lower === "f") { toggleFocusMode(); return; }
      if (e.key === "D" && e.shiftKey) { setTool("deduct-rect"); return; }
      // no `p` binding: pan is not a tool — drag open canvas, or Space/middle/right-drag
      // Q with a bendable trace in flight flips the straight/curve switch
      // instead of jumping to the Curve Line tool — switching tools mid-trace
      // would abandon the points already placed, so this binding can only be
      // an improvement on the one it shadows.
      if (lower === "q" && CURVABLE.has(tool) && poly.length) { setCurveMode((c) => !c); return; }
      // Symbol review (#264): while a sweep is under review the keyboard walks
      // the questions — one keystroke per answer, taking priority over tool
      // bindings (stopImmediatePropagation keeps the proposal-Enter handler,
      // registered after this one, from double-acting).
      if (sweepRef.current) {
        const sw = sweepRef.current;
        const hasOpen = sw.questions.some((q) => q.state === "open");
        if ((e.key === "Enter" || lower === "x") && hasOpen) {
          e.preventDefault(); e.stopImmediatePropagation();
          const verdict = e.key === "Enter" ? "accepted" : "dismissed";
          setSweep((s) => {
            const qs = s.questions.map((q, i) => (i === s.qIndex && q.state === "open" ? { ...q, state: verdict } : q));
            let j = s.qIndex;
            for (let i = 1; i <= qs.length; i++) { const k = (s.qIndex + i) % qs.length; if (qs[k].state === "open") { j = k; break; } }
            return { ...s, questions: qs, qIndex: j };
          });
          return;
        }
        if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && hasOpen) {
          e.preventDefault(); e.stopImmediatePropagation();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          setSweep((s) => {
            let j = s.qIndex;
            for (let i = 1; i <= s.questions.length; i++) { const k = (s.qIndex + dir * i + s.questions.length * i) % s.questions.length; if (s.questions[k].state === "open") { j = k; break; } }
            return { ...s, qIndex: j };
          });
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setSweep(null); return; }
      }
      const map = { v: "select", a: "area", r: "rect", l: "linear", s: "surface", c: "count", d: "deduct", o: "oneclick", k: "check", h: "highlighter", n: "dimension", y: "symbol" };
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
        if (poly.length) { dropLastPoint(); }
        else if (ocSel && proposal) { deleteSelectedOcVertex(); }
        else if (proposal?.regions.length) { setProposal((pr) => { const rg = pr.regions.slice(0, -1); return rg.length ? { ...pr, regions: rg } : null; }); }
        else if (selVert != null && selectedId) { deleteSelectedShapeVertex(); }
        // route through deleteSelected — a reconciled Cut Out (#137) must
        // revert its hole out of the parent, keyboard and menu alike
        else if (selectedId) { deleteSelected(); }
        else if (selectedMarkupId && showMarkups) { deleteMarkup(selectedMarkupId); setSelectedMarkupId(null); }
        // pop ONLY the armed tool's pending points — calibrate and check both
        // keep two-click state (calib points even render while another tool is
        // armed), and an unguarded pop used to silently cross-slice the other
        // tool's points, on-screen or hidden
        else if (tool === "calibrate") { setCalib((c) => c.slice(0, -1)); }
        else if (tool === "check") { setCheck((c) => c.slice(0, -1)); }
      } else if (e.key === "Escape") { if (agentOfferFnsRef.current?.pending()) { agentOfferFnsRef.current.dismiss(); } else if (ocSel) { setOcSel(null); } else if (selVert != null) { setSelVert(null); } else { clearPoly(); setCalib([]); setCheck([]); setCheckStated(""); setScaleGuide(null); selectShape(null); setMarkupDraft(null); setProposal(null); setArmedStamp(null); setScheduleAnchor(null); setSymbolAnchor(null); setImageAnchor(null); setPlacingImageId(null); placeGrabRef.current = null; setAlignPt(null); resetZone(); hlRef.current = null; if (hlPathRef.current) hlPathRef.current.style.display = "none"; } }
      // ⌘Z: the drawing context wins — mid-trace it still pops the last placed
      // point (with or without ⇧, matching the old behavior byte-for-byte);
      // only with no trace in progress does the command stack engage
      // (⌘Z = undo, ⇧⌘Z = redo).
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (poly.length) dropLastPoint();
        else if (e.shiftKey) redoShapeCommand();
        else undoShapeCommand();
      }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { if (selectedId) { e.preventDefault(); copySelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { if (clipRef.current.length) { e.preventDefault(); pasteClipboard(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { if (selectedId) { e.preventDefault(); duplicateSelected(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // approvals is a real dep: ⌘Z's undoShapeCommand closes over it (the
    // family branch), and a stale capture would undo against a pre-seal array.
  }, [tool, selectedId, selVert, selectedMarkupId, showMarkups, poly, proposal, ocSel, shapes, approvals, sheetKey, groupSig, scales, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (prevToolRef.current === "zone" && tool !== "zone") clearPoly();
    prevToolRef.current = tool;
  }, [tool]);

  // ── pointer ────────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (status !== "ready") return;
    // inline editor open: the blur that follows this click commits it; swallow the
    // canvas interaction so pan/zoom stays frozen and no stray point is placed
    if (editingRef.current) return;
    // Pan WITHOUT leaving the draw tool: middle-drag, right-drag, or Space-drag.
    // (There is no Pan tool — Select's open-canvas drag and the deferred-click
    // hold-drag below cover the rest of the modeless-pan doctrine.)
    if (e.button === 1 || e.button === 2 || spaceRef.current) {
      promoteStage();
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: tfRef.current.x, oy: tfRef.current.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;   // only left-click places points
    // an image (re)placement is armed → this left-click drops it where it now sits
    // (onPointerMove has been centre-following the cursor). One click ends the mode.
    if (placingImageId) {
      const id = placingImageId;
      setPlacingImageId(null);
      placeGrabRef.current = null;
      selectMarkup(id);
      setCommitMsg("Image placed.");
      return;
    }
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
    else if (tool === "oneclick") oneClickAt(p, !!(ev && ev.altKey), undefined, !!(ev && ev.shiftKey));
    // ⌥-click on an area/deduct trace drops a CURVE point (#284): the boundary
    // bends through it instead of turning a corner at it. Every other
    // point-placing tool takes the click as it always has.
    else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface" || tool === "zone") {
      // Curve alternates bow → end → bow → end. A bow needs a vertex behind it
      // to arc away from, so the first point of a trace is always a corner.
      const wantCurve = CURVABLE.has(tool) && (curveMode !== !!(ev && ev.altKey));
      addPoint(p, wantCurve && poly.length > 0 && !bowOpen);
    }
    else if (tool === "count") commitCount(p);
    else if (tool === "rect" || tool === "deduct-rect") {
      if (poly.length === 0) addPoint(p, false);
      else { const a = poly[0]; commitPoly([[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], tool === "deduct-rect"); clearPoly(); }
    }
    else if (tool === "schedule") {
      // two-click marquee, isolated state: first click drops the anchor, second reads the box
      if (!scheduleAnchor) setScheduleAnchor(p);
      else { importScheduleFromRect(scheduleAnchor, p); setScheduleAnchor(null); setTool("select"); }
    }
    else if (tool === "symbol") {
      // the Symbol tool's marquee (#264): tight box around ONE instance
      if (!symbolAnchor) setSymbolAnchor(p);
      else { runSymbolSweep(symbolAnchor, p); setSymbolAnchor(null); }
    }
    else if (tool === "image") {
      // two-click marquee, isolated state like schedule/symbol — routes ONLY here,
      // never through placeMarkup (which has no image case and would no-op)
      if (!imageAnchor) setImageAnchor(p);
      else { captureRegionMarkup(imageAnchor, p); setImageAnchor(null); setTool("select"); }
    }
    else if (tool === "cloud" || tool === "callout" || tool === "text" || tool === "highlight" || tool === "dimension") placeMarkup(p);
    else if (tool === "stamp") placeStamp(p);
    else if (tool === "approve") placeApproval(p);
    else if (tool === "stitch-align") stitchAlignAt(p);
  }
  // ── stitch align (#161) — the Calibrate idiom on the composite: click a
  // point near the match line, then the SAME point where the other sheet
  // draws it; the second sheet translates so the two coincide. Guarded while
  // takeoffs live on the stitch (verts_norm are extent-relative — moving
  // members under committed shapes would silently shift their quantities' ink).
  function stitchAlignAt(p) {
    const st = stitchById[groupKeys[0]];
    if (!st || panels.length !== 1) { setTool("select"); return; }
    const n = shapes.filter((s) => s.sheet_id === st.id).length;
    if (n) { setCommitMsg(`Align before tracing — ${n} takeoff${n === 1 ? "" : "s"} already live on this stitch. Delete them (or a fresh stitch) to re-align.`); setTool("select"); return; }
    if (!alignPt) {
      setAlignPt(p);
      setCommitMsg("Match point set — now click the SAME point where the other sheet draws it.");
      return;
    }
    const dims = panelSourceDimsRef.current.get(st.id) || {};
    const res = alignMembers(st.members, dims, [alignPt[0], alignPt[1]], [p[0], p[1]]);
    setAlignPt(null);
    if (res.error) { setCommitMsg(res.error); return; }
    setStitches((list) => list.map((s) => (s.id === st.id ? { ...s, members: res.members } : s)));
    setTool("select");
    setCommitMsg("Match line joined — the sheets now read as one surface. Trace straight across it.");
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
    if ((m.type === "arrow" || m.type === "dimension") && m.from && m.to) {
      // a leader / dimension line — hit its shaft (endpoint tolerance folds into the band)
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
    if (m.type === "image" && Array.isArray(m.at) && Number(m.w) > 0 && pickEmbedFormat(m.src)) {
      // a raster image — hit its placed box (width-anchored, same box the renderer
      // draws). Gate on a PNG/JPEG DATA url (pickEmbedFormat) so an imported record
      // with a non-data src (e.g. http(s)://) is neither rendered nor selectable.
      const { bw, bh } = imagePlacedBox(m.w, m.aspect, W);
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
    //    line (both endpoints), Shift-click an edge to insert a new anchor point —
    //    or just press anywhere else along the edge (where the hover ghost shows
    //    a "+") to insert an anchor at that exact spot, no modifier needed.
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
      // anywhere else ALONG an edge (the hover ghost's promise): drop a new
      // anchor at the point projected onto the edge and drag it out in the
      // same gesture — no modifier needed. Same LIVE-insert semantics as the
      // ⇧-midpoint path above (a zero-motion click leaves a collinear,
      // unstamped anchor; any drag commits ONE geom command on release).
      const insHit = edgeInsertHitAt(p);
      if (insHit) {
        const va = sel.verts_norm[insHit.i], vb = sel.verts_norm[insHit.j];
        const nv = [va[0] + (vb[0] - va[0]) * insHit.t, va[1] + (vb[1] - va[1]) * insHit.t];
        const vnIns = [...sel.verts_norm.slice(0, insHit.i + 1), nv, ...sel.verts_norm.slice(insHit.i + 1)];
        const inserted = { ...sel, verts_norm: vnIns, computed: recomputeShape({ ...sel, verts_norm: vnIns }) };
        setShapes((ss) => ss.map((s) => (s.id === sel.id ? inserted : s)));
        setSelVert(insHit.i + 1);
        dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: insHit.i + 1, prev: geomSnapshot(inserted), shape: inserted, gx: e.clientX, gy: e.clientY };
        if (insGhostRef.current) insGhostRef.current.style.display = "none";
        e.currentTarget.setPointerCapture(e.pointerId); return;
      }
    }
    // 1b. a selected image's bottom-right RESIZE handle wins next (screen-constant,
    //     /z). Gated on the resolved markup being type "image" so this never fires
    //     on another selected markup. Fixed top-left; onPointerMove drives the live
    //     resize via resizeImageFromCorner.
    if (showMarkups && selectedMarkupId) {
      const selMk = markups.find((mm) => mm.id === selectedMarkupId);
      // require the image to be on a VISIBLE panel — panelByKey falls back to
      // panels[0] for an off-group sheet, which would arm the resize against the
      // wrong panel's dims and corrupt an off-view image's w/at.
      if (selMk && selMk.type === "image" && selMk.at && panelKeySet.has(selMk.sheet_id)) {
        const sp = panelByKey(selMk.sheet_id);
        if (sp && sp.img.w) {
          const { bw, bh } = imagePlacedBox(selMk.w, selMk.aspect, sp.img.w);
          const brx = selMk.at[0] * sp.img.w + sp.xOffset + bw / 2, bry = selMk.at[1] * sp.img.h + bh / 2;
          if (Math.hypot(p[0] - brx, p[1] - bry) < thr * 1.5) {
            const tlx = selMk.at[0] * sp.img.w - bw / 2, tly = selMk.at[1] * sp.img.h - bh / 2;
            dragRef.current = { kind: "markupResize", markupId: selMk.id, tl: { x: tlx, y: tly }, aspect: selMk.aspect, ox: sp.xOffset, imgW: sp.img.w, imgH: sp.img.h };
            e.currentTarget.setPointerCapture(e.pointerId); return;
          }
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
      // three tiers: plain markups first, then highlight, then image LAST — so a
      // large image never shadows another markup from selection (an image shields
      // shapes beneath it like a highlight box does; move it to reach what's under).
      const mHit = rev.find((m) => m.type !== "highlight" && m.type !== "image" && hitMarkup(m, p, thr))
                || rev.find((m) => m.type === "highlight" && hitMarkup(m, p, thr))
                || rev.find((m) => m.type === "image" && hitMarkup(m, p, thr));
      if (mHit) {
        selectMarkup(mHit.id);
        // arm a move drag — snapshot the markup's current normalized coords (all four
        // shapes: cloud/highlight rect, callout at+target, text at). The move stays a
        // no-op until it passes the threshold in onPointerMove, so a pure click (or the
        // first click of a double-click re-edit) never nudges the markup.
        const orig = (mHit.type === "highlight" && Array.isArray(mHit.pts)) ? { pts: mHit.pts.map((v) => [...v]) }
          : (mHit.type === "cloud" || mHit.type === "highlight") ? { rect: mHit.rect }
          : mHit.type === "callout" ? { at: mHit.at, target: mHit.target }
            : (mHit.type === "arrow" || mHit.type === "dimension") ? { from: mHit.from, to: mHit.to }
              : { at: mHit.at };   // text + bubble
        // raw start (markups don't snap/angle-lock; matches the raw tracking point in
        // onPointerMove so the delta can't be contaminated by a stale snap/angle ref)
        dragRef.current = { kind: "markupMove", markupId: mHit.id, sheetId: mHit.sheet_id, start: toImage(e.clientX, e.clientY), orig, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    // 3. move the selected shape if its body (not a handle) was hit
    if (sel && selSp && hitShapeC(sel, p[0] - selSp.xOffset, p[1], selSp.img.w, selSp.img.h, thr)) {
      dragRef.current = { kind: "move", shapeId: selectedId, start: p, orig: sel.verts_norm, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId); return;
    }
    // 4. otherwise pick a shape (or clear the selection)
    const hit = [...stackedShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShapeC(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
    });
    selectShape(hit ? hit.id : null);
    if (hit) { dragRef.current = { kind: "move", shapeId: hit.id, start: p, orig: hit.verts_norm, prev: geomSnapshot(hit), shape: hit, gx: e.clientX, gy: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); return; }
    // 5. open canvas — drag the paper to PAN (the instinct everyone brings from
    // desktop takeoff tools; no need to reach for the Pan tool). The plain
    // click (no drag) already cleared the selection above, so a stationary
    // press costs nothing.
    promoteStage();
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
  // Canvas-side wrapper over the ONE quantity computer (lib/shapeMetrics.js):
  // panel dims + scale + condition lookup here, the role-aware math there —
  // shared with the load-time heal, which prices shapes on CLOSED sheets too.
  // Hole-aware since #137: a parent carrying verts_norm_holes prices the
  // clipped geometry, not the outer ring.
  function recomputeShape(s, uppOverride) {
    return computeShapeMetrics(s, panelByKey(s.sheet_id).img, uppOverride ?? (uppFor(s.sheet_id) || 0), condById[s.condition_id]);
  }
  // The panel chip chromes' children — built imperatively by moveCrosshair on a
  // __mode change (the chip element stays CHILDLESS in JSX for every chrome;
  // React never renders content into it). textContent-only writes throughout:
  // condition names are user data, so no innerHTML anywhere on this path.
  function buildChipPanel(chip, chrome) {
    chip.textContent = "";
    const vals = {};
    const row = (label, key, unit) => {
      const r = document.createElement("div");
      r.style.display = "flex"; r.style.justifyContent = "space-between"; r.style.gap = "12px";
      const l = document.createElement("span");
      l.textContent = label;
      l.style.opacity = "0.62"; l.style.fontWeight = "500";
      const v = document.createElement("span");
      v.style.fontWeight = "700";
      const val = document.createElement("span");
      v.appendChild(val);
      if (unit) {
        // muted-gray unit span — reads as annotation beside the value, not value
        const u = document.createElement("span");
        u.textContent = " " + unit;
        u.style.color = "#8a8577"; u.style.fontWeight = "500";
        v.appendChild(u);
      }
      r.appendChild(l); r.appendChild(v);
      chip.appendChild(r);
      vals[key] = val;
    };
    if (chrome === "panelDark") {
      row("This segment", "seg");
      row("Total linear", "lin");
      row("Total area", "area");
    } else {
      const head = document.createElement("div");
      head.style.fontWeight = "700"; head.style.marginBottom = "1px";
      chip.appendChild(head);
      vals.head = head;
      const sub = document.createElement("div");
      sub.textContent = "This section only:";
      sub.style.opacity = "0.62"; sub.style.fontSize = "9.5px"; sub.style.marginBottom = "1px";
      chip.appendChild(sub);
      row("Area", "area", areaUnit(units));
      row("Linear", "lin", lenUnit(units));
      row("Segments", "segs");
      row("Points", "pts");
    }
    chip.__vals = vals;
  }
  function moveCrosshair(e) {
    if (editingRef.current) return;   // inline editor open — no aim crosshair (ref check, never per-mousemove state)
    if (tool === "select" || status !== "ready" || !containerRef.current) return;
    const ds = dsRef.current;   // resolved drawing style — refs only in this hot path (render-body assigned, never stale)
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
    if (angleOn && anchor && !bowOpen && !snapRef.current && !panRef.current) {
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
        el.style.background = lock ? ds._hairlineLock.background : ds._hairline;
        el.style.boxShadow = lock ? ds._hairlineLock.boxShadow : ds._hairlineLock.boxShadowBase;
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
          star.style.filter = lock ? `drop-shadow(0 0 5px ${ds._aimGlow}) drop-shadow(0 1px 2px rgba(14,26,46,.3))` : "drop-shadow(0 1px 2px rgba(14,26,46,.3))";
        }
      }
      el.style.display = "block";
    }
    if (aimChipRef.current) {
      const chip = aimChipRef.current;
      const chipT = ds.chip;
      // panel chromes (panelDark/panelCream) replace the single-row live-segment
      // text with a small multi-row readout — ONLY during a poly draft with ≥1
      // placed point on a scaled sheet; every other text (check length, rect
      // W×H, bare angle, "snap") degrades to a single row in the same palette.
      const panelChrome = chipT.chrome === "panelDark" || chipT.chrome === "panelCream";
      const panelActive = panelChrome && drawing && anchor && liveUpp;
      let txt = "", over = false;
      if (tool === "check" && check.length === 1) {
        // live length to the cursor while picking the second end of the dimension.
        // No CARPET_ROLL_FT amber here — a dimension string is not a seam plan.
        const u = uppFor(panelAt(check[0][0]).key);
        if (u) txt = fmtCheckLen(Math.hypot(cur[0] - check[0][0], cur[1] - check[0][1]) * u, units) + (lock ? ` · ${lock.deg}°` : "");
      } else if (tool === "dimension" && markupDraft) {
        // live length while picking the dimension's second end — same readout
        // as check, and like check no roll-width amber: a dimension string is
        // a label, not a seam plan
        const u = uppFor(panelAt(markupDraft[0]).key);
        if (u) txt = fmtCheckLen(Math.hypot(cur[0] - markupDraft[0], cur[1] - markupDraft[1]) * u, units);
      } else if ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 && liveUpp) {
        // rectangle: live W × H + area (SF and SY imperial — carpet is bought in SY)
        const a = poly[0];
        const w = Math.abs(cur[0] - a[0]) * liveUpp, h = Math.abs(cur[1] - a[1]) * liveUpp;
        const sf = w * h;
        txt = `${fmtCheckLen(w, units)} × ${fmtCheckLen(h, units)} · ${num(areaVal(sf, units))} ${areaUnit(units)}${units === "metric" ? "" : ` · ${num(sf / 9)} SY`}`;
        over = w >= CARPET_ROLL_FT - 0.02 || h >= CARPET_ROLL_FT - 0.02;
      } else if (drawing && anchor && liveUpp && !panelActive) {
        // line/polyline: live segment length, ALWAYS (not just under the 45° lock).
        // With a bow open the segment IS the arc, so measure along it — reading
        // the chord here would price a curved wall short the whole time you aim.
        const len = bowOpen
          ? arcLength(poly[poly.length - 2], anchor, cur) * liveUpp
          : Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) * liveUpp;
        txt = lock ? `${lock.deg}° · ${fmtCheckLen(len, units)}` : fmtCheckLen(len, units);
        over = len >= CARPET_ROLL_FT - 0.02;
      } else if (!panelActive && lock) {
        txt = `${lock.deg}°`;
      } else if (!panelActive && snapRef.current) txt = "snap";
      if (panelActive) {
        // The rebuild dirty-mark encodes MODE, not just chrome: the same chrome
        // alternates panel (mid-draft) and single-row (check length, rect W×H,
        // bare angle, "snap"), and a chrome-only key would leave the mover
        // updating value nodes a textContent write already wiped, or chip.__t
        // skipping a rewrite over stale panel children. (units joins the key so
        // a ft/m flip rebuilds the panel's baked unit spans.)
        const mode = chipT.chrome + ":panel:" + units;
        if (chip.__mode !== mode) {
          chip.__mode = mode;
          delete chip.__t;   // every panel build clears __t — the next row-mode write must never skip
          buildChipPanel(chip, chipT.chrome);
        }
        // totals = render-body placed sums (draftStatsRef) + O(1) cursor terms.
        // With a bow open the live leg is the arc, so measure segLen along it.
        const st = draftStatsRef.current;
        const segPx = Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]);
        const segLen = (bowOpen ? arcLength(poly[poly.length - 2], anchor, cur) : segPx) * liveUpp;
        const totLen = (st.len + segPx) * liveUpp;
        const p0 = poly[0], pn = poly[poly.length - 1];
        const crossSum = st.cross + (pn[0] * cur[1] - cur[0] * pn[1]) + (cur[0] * p0[1] - p0[0] * cur[1]);
        const areaSf = (Math.abs(crossSum) / 2) * liveUpp * liveUpp;
        const v = chip.__vals;
        // a shoelace area is meaningless for an OPEN run — the panel shows it
        // only on ring tools (linear/surface drafts read "—" there)
        const ringDraft = tool === "area" || tool === "deduct" || tool === "zone";
        if (chipT.chrome === "panelDark") {
          v.seg.textContent = lock ? `${lock.deg}° · ${fmtCheckLen(segLen, units)}` : fmtCheckLen(segLen, units);
          v.lin.textContent = fmtCheckLen(totLen, units);
          v.area.textContent = ringDraft ? `${num(areaVal(areaSf, units))} ${areaUnit(units)}` : "—";
        } else {
          v.head.textContent = aCond?.finish_tag || "No condition";
          v.area.textContent = ringDraft ? num(areaVal(areaSf, units)) : "—";
          v.lin.textContent = num(lenVal(totLen, units));
          // chain counts INCLUDING the live leg: placed edges + the rubber =
          // poly.length segments, placed vertices + the cursor = poly.length+1
          v.segs.textContent = String(poly.length);
          v.pts.textContent = String(poly.length + 1);
        }
        over = segLen >= CARPET_ROLL_FT - 0.02;
      } else if (txt) {
        const mode = chipT.chrome + ":row";
        // a row-mode write goes through textContent, which wipes any panel
        // children left by the previous mode
        if (chip.__mode !== mode) { chip.__mode = mode; delete chip.__t; chip.__vals = null; }
        if (chip.__t !== txt) { chip.textContent = txt; chip.__t = txt; }
      }
      if (panelActive || txt) {
        // 12 ft roll-width cue — the chip goes amber when a run reaches roll width
        // (a seam falls here); the restore re-applies the ds-resolved base strings
        // (for Drafting Table those are today's exact var(--…) strings)
        const os = over ? "1" : "";
        if (chip.__over !== os) {
          chip.__over = os;
          chip.style.background = over ? chipT.warnBg : chipT.bg;
          chip.style.color = over ? chipT.warnFg : chipT.fg;
          chip.style.borderColor = over ? chipT.warnBorder : chipT.border;
        }
        // anchor "lastVertex" pins the chip to the last placed vertex during a
        // poly draft (Site Glass); every other text and chrome rides the cursor
        const anchorLast = chipT.anchor === "lastVertex" && drawing && poly.length > 0;
        const ax = anchorLast ? poly[poly.length - 1][0] * t.scale + t.x : ex;
        const ay = anchorLast ? poly[poly.length - 1][1] * t.scale + t.y : ey;
        chip.style.transform = `translate3d(${ax + 14}px, ${ay + 18}px, 0)`;
        chip.style.display = "block";
      } else chip.style.display = "none";
    }
    if (rubberRef.current) {
      const cas = rubberCasingRef.current;
      if (!panRef.current && drawing && poly.length > 0) {
        // With a bow open the band runs from the arc's START and goes dashed —
        // it is the chord under the bow, a reference line, not the boundary.
        const last = poly[bowOpen ? poly.length - 2 : poly.length - 1];
        rubberRef.current.setAttribute("x1", last[0]); rubberRef.current.setAttribute("y1", last[1]);
        rubberRef.current.setAttribute("x2", cur[0]); rubberRef.current.setAttribute("y2", cur[1]);
        // screen-constant width, like the JSX default and the dash below (÷ scale):
        // the raw stage-px value this used to write drew a fat, smeared band at
        // deep zoom. The lock reads thicker within the band (or, where a theme
        // sets rubber.lockColor, recolored instead of thickened).
        rubberRef.current.setAttribute("stroke-width", (lock ? ds.rubber.lockWidth : ds.rubber.width) / tfRef.current.scale);
        if (ds.rubber.lockColor) {
          // recolor on lock-CHANGE only (__lockColor dirty mark); the restore is
          // the SAME deduct→invalid→accent expression the JSX declares.
          if (rubberRef.current.__lockColor !== lockState) {
            rubberRef.current.__lockColor = lockState;
            rubberRef.current.setAttribute("stroke", lock ? ds.rubber.lockColor : draftStroke(tool, draftInvalid, ds));
          }
        }
        // With a bow open the band is the dashed chord under the arc; otherwise
        // the theme's own rubber dash (solid for drafting → "").
        const dash = bowOpen ? `${5 / tfRef.current.scale} ${4 / tfRef.current.scale}` : (drawDashFor(ds.rubber.dash, tfRef.current.scale) || "");
        if (rubberRef.current.__dash !== dash) { rubberRef.current.setAttribute("stroke-dasharray", dash); rubberRef.current.__dash = dash; }
        rubberRef.current.style.display = "block";
        // casing under-stroke mirrors the STRAIGHT rubber band (Site Glass) — its
        // JSX twin heals wheel-zoom with a stationary pointer, this mover write
        // heals move cadence. Skipped while a bow is open: the band is then a
        // dashed reference chord, and a white casing under it reads wrong.
        if (cas && ds.casing && !bowOpen) {
          cas.setAttribute("x1", last[0]); cas.setAttribute("y1", last[1]);
          cas.setAttribute("x2", cur[0]); cas.setAttribute("y2", cur[1]);
          cas.setAttribute("stroke-width", ds.casing.width / tfRef.current.scale);
          cas.style.display = "block";
        } else if (cas) cas.style.display = "none";
      } else {
        rubberRef.current.style.display = "none";
        if (cas) cas.style.display = "none";   // the hide branch mirrors the casing too
      }
    }
    // close preview — the ring tools' ghost cursor→first edge (theme-gated; the
    // element only mounts when DS.closePreview is set). Width AND dash are
    // dual-owned exactly like the rubber core: the JSX twin declares both from
    // the ~11 Hz tf mirror, this mover re-writes both from tfRef per move — so
    // width and dash always come from the SAME scale read, in both cadences.
    if (closeRef.current) {
      if (!panRef.current && ds.closePreview && (tool === "area" || tool === "deduct" || tool === "zone") && poly.length >= 2) {
        const csc = tfRef.current.scale;
        closeRef.current.setAttribute("x1", cur[0]); closeRef.current.setAttribute("y1", cur[1]);
        closeRef.current.setAttribute("x2", poly[0][0]); closeRef.current.setAttribute("y2", poly[0][1]);
        closeRef.current.setAttribute("stroke-width", ds.closePreview.width / csc);
        const cd = drawDashFor(ds.closePreview.dash, csc);
        if (cd) closeRef.current.setAttribute("stroke-dasharray", cd);
        else closeRef.current.removeAttribute("stroke-dasharray");
        closeRef.current.style.display = "block";
      } else closeRef.current.style.display = "none";
    }
    // The arc itself — a real SVG conic through (start, bow, cursor), so what
    // you aim with is what commits rather than a preview that flattens later.
    if (arcRef.current) {
      if (!panRef.current && drawing && bowOpen) {
        arcRef.current.setAttribute("d", arcPathD(poly[poly.length - 2], poly[poly.length - 1], cur));
        arcRef.current.setAttribute("stroke-width", ds.draft.lineWidth / tfRef.current.scale);
        arcRef.current.style.display = "block";
      } else arcRef.current.style.display = "none";
    }
    if (rectRef.current) {
      const schedDraw = tool === "schedule" && scheduleAnchor;
      const symDraw = tool === "symbol" && symbolAnchor;
      const imgDraw = tool === "image" && imageAnchor;
      if (!panRef.current && ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 || schedDraw || symDraw || imgDraw)) {
        const a = imgDraw ? imageAnchor : symDraw ? symbolAnchor : schedDraw ? scheduleAnchor : poly[0];
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
    // live dimension-line preview: first end (markupDraft) → cursor
    if (dimRef.current) {
      if (!panRef.current && tool === "dimension" && markupDraft) {
        dimRef.current.setAttribute("x1", markupDraft[0]); dimRef.current.setAttribute("y1", markupDraft[1]);
        dimRef.current.setAttribute("x2", cur[0]); dimRef.current.setAttribute("y2", cur[1]);
        dimRef.current.style.display = "block";
      } else dimRef.current.style.display = "none";
    }
  }
  function hideCrosshair() {
    for (const ref of [crossVRef, crossHRef, rubberRef, rubberCasingRef, closeRef, arcRef, rectRef, cloudRef, highlightRef, dimRef, snapMarkRef, aimMarkRef, aimChipRef]) if (ref.current) ref.current.style.display = "none";
    if (hlRef.current == null && hlPathRef.current) hlPathRef.current.style.display = "none";
    if (hoverRef.current) hoverRef.current.style.display = "none";
    hoverIdRef.current = "";
    angleRef.current = null;
  }
  // Pointer left the canvas: hide the aim chrome AND kill the voice-deixis aim —
  // a pointer parked off-canvas must not leave a ghost seed for "this room".
  // (Other hideCrosshair callers — e.g. the inline editor — keep the aim: the
  // pointer is still parked on the sheet there.)
  function leaveCanvas() {
    hideCrosshair();
    voiceAimMarkRef.current = aimSeqRef.current;
  }
  function describeShape(s) {
    const tag = condById[s.condition_id]?.finish_tag || "?";
    const a = s.computed?.area_sf || 0, lf = s.computed?.perimeter_lf || 0;
    if (s.measure_role === "count") return `${tag} · ${num(s.computed?.count || 1, 0)} EA`;
    // closed shapes carry their ring length too (#283) — a footprint's LF is
    // as much a takeoff number as its SF, and it's already computed
    if (s.measure_role === "deduct") return `${tag} · −${fa(a)} deduct${lf > 0 ? ` · ${fl(lf)} perim` : ""}`;
    if (s.measure_role === "surface_area") {
      // same height semantics as recomputeShape: an override wins outright (even 0).
      // Heights stay feet in both systems — they're ENTERED in feet everywhere.
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      return `${tag} · ${fa(a)} wall (${fl(lf)} × ${num(h, 2)}′)`;
    }
    if (s.measure_role === "linear") return `${tag} · ${fl(lf)}${a > 0 ? ` · ${fa(a)} border` : ""}`;
    return `${tag} · ${faSY(a)}${lf > 0 ? ` · ${fl(lf)} perim` : ""}`;
  }
  // Edge-insert affordance: the nearest point ON an edge of the selected shape,
  // away from its corner diamonds and midpoint grip (those gestures keep
  // priority). A press there drops a new anchor at the projected point and
  // drags it out in the same gesture; the hover ghost telegraphs it first.
  function edgeInsertHitAt(p) {
    if (!selectedId) return null;
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel || sel.measure_role === "count" || !panelKeySet.has(sel.sheet_id)) return null;
    const sp = panelByKey(sel.sheet_id);
    const thr = 8 / tfRef.current.scale;
    const pts = sel.verts_norm.map(([nx, ny]) => [nx * sp.img.w + sp.xOffset, ny * sp.img.h]);
    const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
    const edges = closed ? pts.length : pts.length - 1;
    let best = null;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % pts.length;
      const a = pts[i], b = pts[j];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
      const qx = a[0] + t * dx, qy = a[1] + t * dy;
      const d = Math.hypot(qx - p[0], qy - p[1]);
      if (d >= thr || (best && d >= best.d)) continue;
      // clear of the corner diamonds (thr*1.6 hit radius) and the edge grip
      // (thr*1.4) with a little margin, so the ghost never shadows a grip
      if (Math.hypot(qx - a[0], qy - a[1]) < thr * 1.8 || Math.hypot(qx - b[0], qy - b[1]) < thr * 1.8) continue;
      if (Math.hypot((a[0] + b[0]) / 2 - qx, (a[1] + b[1]) / 2 - qy) < thr * 1.6) continue;
      best = { i, j, t, d, qx, qy };
    }
    return best;
  }
  function updateInsGhost(e) {
    const el = insGhostRef.current;
    if (!el) return;
    const off = () => { el.style.display = "none"; };
    if (tool !== "select" || panRef.current || dragRef.current || pendingClickRef.current || status !== "ready") return off();
    const hit = edgeInsertHitAt(toImage(e.clientX, e.clientY));
    if (!hit) return off();
    const t = tfRef.current;
    el.style.left = `${hit.qx * t.scale + t.x - 8}px`;
    el.style.top = `${hit.qy * t.scale + t.y - 8}px`;
    el.style.display = "flex";
  }
  // STACK-style hover readout: small, follows the cursor, gone on hover-off
  function updateHover(e) {
    const el = hoverRef.current;
    if (!el) return;
    if (panRef.current || dragRef.current || pendingClickRef.current || status !== "ready") { el.style.display = "none"; hoverIdRef.current = ""; return; }
    const pt = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    const hit = [...stackedShapes].reverse().find((s) => {
      const sp = panelByKey(s.sheet_id);
      return hitShapeC(s, pt[0] - sp.xOffset, pt[1], sp.img.w, sp.img.h, thr);
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
    aimSeqRef.current++;                           // deixis freshness tick — see getAimSeed
    // (re)placing an image markup: it rides the cursor until the next click drops
    // it. On the pointer's FIRST canvas contact (or when it crosses to a new sheet)
    // we grab the image WHERE IT SITS — recording the cursor→centre offset so it
    // doesn't teleport under the cursor — then move it by the cursor delta after.
    // Live setMarkups mirrors the move-drag; committed on pointerdown below.
    if (placingImageId) {
      const q = toImage(e.clientX, e.clientY);
      const tp = panelAt(q[0]);
      if (tp?.img?.w) {
        const cx = (q[0] - tp.xOffset) / tp.img.w, cy = q[1] / tp.img.h;
        if (!placeGrabRef.current || placeGrabRef.current.key !== tp.key) {
          const m0 = markups.find((m) => m.id === placingImageId);
          const ax = m0 && Array.isArray(m0.at) ? m0.at[0] : cx, ay = m0 && Array.isArray(m0.at) ? m0.at[1] : cy;
          placeGrabRef.current = { key: tp.key, dx: ax - cx, dy: ay - cy };
        }
        const g = placeGrabRef.current;
        setMarkups((ms) => ms.map((m) => (m.id === placingImageId ? { ...m, at: [cx + g.dx, cy + g.dy], sheet_id: tp.key } : m)));
      }
      return;
    }
    // status-bar coords — direct DOM (instrument readout; no React render per move).
    // Sheet feet when the hovered panel has a scale, raw image px otherwise.
    if (statusCoordRef.current) {
      const q = toImage(e.clientX, e.clientY);
      const sp = panelAt(q[0]);
      const u = scales[sp.key];
      statusCoordRef.current.textContent = u
        ? `x ${fmtCheckLen((q[0] - sp.xOffset) * u, units)} · y ${fmtCheckLen(q[1] * u, units)}`
        : `x ${Math.round(q[0] - sp.xOffset)} · y ${Math.round(q[1])} px`;
    }
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
        promoteStage();
        panRef.current = { sx: pc.cx, sy: pc.cy, ox: tfRef.current.x, oy: tfRef.current.y };
        pendingClickRef.current = null;
        if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      }
    }
    updateHover(e);
    if (tool === "select") updateInsGhost(e);
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
          let [slx, sly] = ocSnap(sp.key, p[0] - sp.xOffset, p[1], !!d.shape.origin?.raster_traced);   // snap the corner to true endpoints (never on a raster-traced shape — see ocSnap)
          // auto-straighten (45° toggle): when no endpoint claimed the point,
          // the dragged vertex locks onto its neighbors' axes — an edited wall
          // stays straight instead of drifting a pixel off square. Osnap wins;
          // toggle 45° off to place genuinely angled vertices freely.
          if (angleOn && slx === p[0] - sp.xOffset && sly === p[1]) {
            const base = d.prev.verts_norm, n0 = base.length;
            const closed = d.shape.measure_role !== "linear" && d.shape.measure_role !== "surface_area";
            const pick = (i) => {
              let k = i;
              if (closed) k = ((i % n0) + n0) % n0; else if (k < 0 || k >= n0) return null;
              const v = base[k];
              return v ? [v[0] * sp.img.w, v[1] * sp.img.h] : null;
            };
            const lock = axisLockPoint([slx, sly], pick(d.vIndex - 1), pick(d.vIndex + 1), 8 / tfRef.current.scale);
            if (lock.locked) [slx, sly] = lock.pt;
          }
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
      } else if (d.kind === "markupResize") {
        // drag the BR corner while the top-left stays fixed — resizeImageFromCorner
        // clamps width first, then derives the new center so the top-left is
        // invariant even at the clamp rails. Live setMarkups (not commit-on-release);
        // onPointerUp sees a non-shape kind and just releases capture.
        const mp = toImage(e.clientX, e.clientY);
        const pointerLocalX = mp[0] - d.ox;
        const { w, at } = resizeImageFromCorner({ x: d.tl.x, y: d.tl.y }, { x: pointerLocalX, y: mp[1] }, d.aspect, d.imgW, d.imgH);
        setMarkups((ms) => ms.map((m) => (m.id === d.markupId ? { ...m, w, at } : m)));
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
    if (ocDragRef.current) { ocDragRef.current = null; bumpIdle(); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ } return; }
    if (dragRef.current) {
      const d = dragRef.current;
      dragRef.current = null;
      bumpIdle();
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
    confirmScale(key);   // scale gate: a human scale act IS the confirmation
    // The vector mask bakes the scale in (its hatch-pitch cap and seal radii
    // are feet-true via mppf), so a recalibrated sheet must rebuild its masks
    // on next use — a mask built against the old calibration is exactly the
    // failure class the scale pinning exists to remove.
    maskCacheRef.current.delete(key);
    rasterMaskCacheRef.current.delete(key);
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
  // #137 — try to resolve a freshly-drawn deduct into a REAL hole in a parent
  // floor_area shape (turf boolean subtract, lib/cutout.js) instead of it
  // landing as a second independent overlay. Returns null (caller keeps the
  // legacy path) whenever the resolution is anything but unambiguous:
  //   - zero or 2+ floor_area shapes on this sheet touch the deduct's ring
  //     (ambiguous parent, or it spans more than one condition's shape);
  //   - the boolean op itself degenerates (deduct erases the parent, or
  //     splits it into disjoint pieces — subtractCutout refuses both).
  // A parent that already carries reconciled cutout(s) is a normal target:
  // the new ring subtracts against (outer + existing holes), so N deducts
  // compose into N holes and overlap between cuts never double-deducts.
  function resolveCutout(tp, deductPointsPx, deductShape) {
    // deductPointsPx is ABSOLUTE stage space (commitPoly's `points`, xOffset
    // baked in — same convention as verts_norm's own encode below); candidate
    // rings must land in that SAME frame or containment/overlap comes out
    // wrong the moment more than one sheet is open side by side (group view).
    const candidates = shapes
      .filter((s) => s.sheet_id === tp.key && s.measure_role === "floor_area")
      .map((s) => ({ id: s.id, ringPx: s.verts_norm.map(([x, y]) => [x * tp.img.w + tp.xOffset, y * tp.img.h]) }));
    if (!candidates.length) return null;
    const parentId = findCutoutParent(candidates, deductPointsPx);
    if (!parentId) return null;
    const parent = shapes.find((s) => s.id === parentId);
    const parentRingPx = candidates.find((c) => c.id === parentId).ringPx;
    const parentHolesPx = (parent.verts_norm_holes || []).map((ring) => ring.map(([nx, ny]) => [nx * tp.img.w + tp.xOffset, ny * tp.img.h]));
    const result = subtractCutout(parentRingPx, parentHolesPx, deductPointsPx);
    if (!result) return null;
    const norm = (ring) => ring.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]);
    const upp = uppFor(tp.key);
    const parentNext = {
      verts_norm: norm(result.outer),
      verts_norm_holes: result.holes.map(norm),
      computed: { area_sf: +(result.area * upp * upp).toFixed(2), perimeter_lf: +(result.perim * upp).toFixed(2) },
    };
    // Frozen pre-cut snapshot of the PARENT, durable on the deduct's own
    // origin (not just the ephemeral undo stack) — deleteSelected reads this
    // to revert the parent's geometry when this specific cutout is deleted
    // later, possibly in a different session after the undo stack is long gone.
    const parentPrev = {
      verts_norm: parent.verts_norm.map((v) => [...v]),
      ...("verts_norm_holes" in parent ? { verts_norm_holes: parent.verts_norm_holes.map((r) => r.map((v) => [...v])) } : {}),
      ...("computed" in parent ? { computed: parent.computed } : {}),
    };
    return {
      parentId,
      parentNext,
      deductShape: {
        ...deductShape,
        cuts_shape_id: parentId,
        origin: { method: "cutout_v1", cuts_shape_id: parentId, parent_prev: parentPrev },
      },
    };
  }
  // WALL TILE IS NOT A POLYGON. A Surface Area takeoff is an OPEN run traced
  // in plan × the condition's height, and base/transitions are the same run
  // without one — but every path the Cut Out tool could take resolved against
  // `floor_area` shapes only. Drawing one over a wall run therefore did the
  // worst available thing quietly: it landed an independent deduct overlay
  // whose area came off the condition's FLOOR total, a bucket a wall run
  // never fills (lib/totals accumulateRole), so the wall SF never moved and
  // the floor went negative instead. There was no other way to take a stretch
  // of wall tile back out.
  //
  // Runs now cut: the ring CLIPS the polyline (lib/cutout.cutRunsAcross),
  // quantities scale with the surviving length — exactly right for both
  // roles, since wall SF is LF × height and a border's SF is LF × thickness —
  // and a cut through the middle leaves the far side as its own shape. Every
  // run the ring touches is cut, not one unambiguous parent: a ring dropped
  // on a corner where two runs meet cuts both, which is what was drawn. A
  // CURVED run is left alone — its verts are control points, not the line
  // itself, so clipping them would move the curve it re-smooths through.
  // Returns null when the ring crosses no run at all.
  const RUN_ROLES = new Set(["surface_area", "linear"]);
  function resolveRunCuts(tp, ringPx) {
    const upp = uppFor(tp.key);
    if (!upp) return null;
    const candidates = shapes
      .filter((s) => s.sheet_id === tp.key && RUN_ROLES.has(s.measure_role) && !s.curved && (s.verts_norm || []).length >= 2)
      .map((s) => ({ id: s.id, runPx: s.verts_norm.map(([x, y]) => [x * tp.img.w + tp.xOffset, y * tp.img.h]) }));
    if (!candidates.length) return null;
    const hits = cutRunsAcross(candidates, ringPx);
    if (!hits.length) return null;
    const norm = (run) => run.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]);
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const targets = [], mint = [], deleteIds = [];
    for (const h of hits) {
      if (h.kind === "erased") { deleteIds.push(h.id); continue; }
      const src = byId.get(h.id);
      // quantities ride the length: SF/LF scale by (survived / original), so a
      // per-shape height or a condition thickness stays honoured without this
      // reaching back into the condition at all
      const was = src?.computed?.perimeter_lf || 0;
      const qty = (lenPx) => {
        const lf = +(lenPx * upp).toFixed(2);
        const k = was > 0 ? lf / was : 0;
        return { perimeter_lf: lf, area_sf: +((src?.computed?.area_sf || 0) * k).toFixed(2) };
      };
      const [head, ...rest] = h.runs;
      targets.push({ id: h.id, next: { verts_norm: norm(head), computed: qty(openLen(head)) } });
      for (const piece of rest) {
        const { id: _id, created_at: _ct, ...carry } = src;
        mint.push({ ...carry, verts_norm: norm(piece), computed: qty(openLen(piece)) });
      }
    }
    return { targets, mint, deleteIds };
  }
  const runCutMsg = (runs) => {
    const bits = [];
    if (runs.targets.length) bits.push(`cut ${runs.targets.length} run${runs.targets.length === 1 ? "" : "s"}`);
    if (runs.mint.length) bits.push(`${runs.mint.length} left on the far side of the cut`);
    if (runs.deleteIds.length) bits.push(`removed ${runs.deleteIds.length} outright`);
    return `Cut Out: ${bits.join(" \u00b7 ")}.`;
  };
  // A trace whose points span two side-by-side panels has no coherent
  // quantity — the inter-panel gap would be measured as real feet, and the
  // shape would bind to one sheet with vertices hanging off its edge. Refuse
  // at commit (the calibrate cross-panel precedent) and point at the fix:
  // stitching joins the sheets into ONE panel, where a spanning trace is
  // exactly right (#161).
  function spansPanels(points) {
    if (panels.length < 2) return false;
    const first = panelAt(points[0][0]);
    return points.some((q) => panelAt(q[0]) !== first);
  }
  const SPAN_MSG = "That trace crosses onto another sheet — the gap between sheets isn't real distance. To work a floor split at a match line as one surface, stitch the sheets (Sheets → gallery → select both → Stitch).";
  function commitPoly(points, asDeduct, opts = {}) {
    if (points.length < 3) return;
    if (spansPanels(points)) { setCommitMsg(SPAN_MSG); return; }
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const met = closedMetrics(points);
    // id + created_at are minted by the add command — the ONE creation gate
    const shape = {
      sheet_id: tp.key, condition_id: activeCond,
      measure_role: asDeduct ? "deduct" : "floor_area",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual", ...(opts.curved ? { curved: true } : {}) },
    };
    // #137 — a deduct tries the real-hole path first; anything ambiguous
    // (see resolveCutout) falls straight back to the independent-overlay
    // commit below, unchanged.
    if (asDeduct) {
      // the run half of the ring rides inside the SAME command, so one drawn
      // ring stays one ⌘Z whether it crossed an area, some runs, or both
      const runs = resolveRunCuts(tp, points);
      const cut = resolveCutout(tp, points, shape);
      if (cut) {
        const res = dispatchShape({ type: "cutout", shape: cut.deductShape, parentId: cut.parentId, parentNext: cut.parentNext, ...(runs ? { runs } : {}) });
        if (runs) setCommitMsg(runCutMsg(runs));
        // the deduct is pushed first, any far-side run pieces after it
        maybeOfferRule(res.shapes[res.shapes.length - 1 - (runs ? runs.mint.length : 0)], res.shapes);
        return;
      }
      if (runs) {
        // nothing but runs under the ring — there is no area for a deduct
        // receipt to sit on, so none is minted
        dispatchShape({ type: "cutout", runs });
        setCommitMsg(runCutMsg(runs));
        return;
      }
    }
    const res = dispatchShape({ type: "add", shapes: [shape] });
    // A Cut Out fully inside a same-condition room reads as a correction —
    // offer to make it a rule (#88). Detection only; nothing applies here.
    if (asDeduct) maybeOfferRule(res.shapes[res.shapes.length - 1], res.shapes);
  }
  function commitLinear(points, curved = false, baked = false) {
    if (points.length < 2) return;
    if (spansPanels(points)) { setCommitMsg(SPAN_MSG); return; }
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    // curved: verts stay the clicked CONTROL points (drag one → re-smooths);
    // length always comes from the flattened spline
    const LF = openLen(curved ? flattenCurve(points) : points) * upp;
    const tIn = Number(aCond?.thickness_in) || 0; // borders/feature strips: SF = LF × T/12
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "linear",
      ...(curved ? { curved: true } : {}),
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual", ...(baked ? { curved: true } : {}) },
    }] });
  }
  // Surface Area — trace the wall run in plan; SF = traced LF × the condition's
  // height. The wall-tile "stack" workflow: set tile height once, trace walls.
  function commitSurface(points, baked = false) {
    if (points.length < 2) return;
    if (spansPanels(points)) { setCommitMsg(SPAN_MSG); return; }
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
      origin: { method: "manual", ...(baked ? { curved: true } : {}) },
    }] });
  }
  // ── the Symbol tool (#264): marquee one instance → the engine finds every
  // placement; matches light up, near-misses ask, and nothing commits until
  // the estimator says so. Engine + labels are the same pure libs the MCP
  // ships (sweepSymbols / labelPlacements) — canvas and agent cannot disagree.
  async function ensureTextSpans(key) {
    if (textSpansRef.current.has(key)) return textSpansRef.current.get(key);
    const spans = [];
    try {
      const pg = pageObjsRef.current.get(key);
      const vt = textTfRef.current.get(key);
      if (pg && vt) {
        const tc = await pg.getTextContent();
        for (const it of tc.items || []) {
          const str = (it.str || "");
          if (!str.trim()) continue;
          const t = pdfjsLib.Util.transform(vt, it.transform);
          // it.width/height are USER-SPACE units (font size already in them) —
          // scale by the VIEWPORT alone, never the composed norm (which folds
          // the font size in a second time and inflates every box ~10×; found
          // live when a 12 px tag grew a 440 px adjacency and labeled the
          // wrong diamond). Same math as the MCP's textSpans, deliberately.
          const vs = Math.hypot(vt[0], vt[1]) || 2;
          const w = (it.width || 0) * vs;
          const h = (it.height || 0) * vs || Math.hypot(t[2], t[3]);
          spans.push({ str, x0: t[4], y0: t[5] - h, x1: t[4] + w, y1: t[5] });
        }
      }
    } catch { /* no text layer — labels simply stay absent */ }
    textSpansRef.current.set(key, spans);
    return spans;
  }
  async function runSymbolSweep(a, b) {
    const tp = panelAt(a[0]);
    const key = tp.key;
    const rect = [[a[0] - tp.xOffset, a[1]], [b[0] - tp.xOffset, b[1]]];
    const segs = vectorSegsRef.current.get(key);
    if (!segs || !segs.length) { setCommitMsg("This sheet has no vector linework (likely a scan) — the Symbol tool reads drawn segments."); return; }
    const lum = segLumRef.current.get(key);
    let res;
    try {
      res = sweepSymbols(segs, rect, lum ? { lum } : {});
    } catch (e) {
      // the engine's refusals (empty marquee, region-sized marquee) are
      // instructions, exactly as the MCP surfaces them
      setCommitMsg(String((e && e.message) || e));
      return;
    }
    let labels = [];
    try {
      const spans = await ensureTextSpans(key);
      labels = labelPlacements(
        [res.seed.center, ...res.matches.map((m) => m.at), ...res.withheld.map((w) => w.at)],
        spans, segs, lum,
      );
    } catch { labels = []; }
    const L = (i) => labels[i] || null;
    const nM = res.matches.length;
    // One physical spot, ONE question. The engine discloses every rotational
    // reading of a near-miss (an instrument's honesty); the review lane must
    // not draw them as stacked rings — and must never let two readings of the
    // same symbol both be accepted into the count. Cluster at a quarter of
    // the marquee diagonal: readings of one instance sit a few px apart,
    // while genuinely adjacent instances (abutting tiles) stay separate.
    const clusterR = Math.max(6, Math.hypot(rect[1][0] - rect[0][0], rect[1][1] - rect[0][1]) / 4);
    const rawQ = res.withheld.map((w, i) => ({ ...w, label: L(1 + nM + i) }));
    const questions = [];
    for (const q of rawQ.sort((a, b) => b.score - a.score)) {
      const twin = questions.find((k) => Math.hypot(k.at[0] - q.at[0], k.at[1] - q.at[1]) <= clusterR);
      if (twin) { twin.readings += 1; continue; }
      questions.push({ ...q, readings: 1, state: "open" });
    }
    setSweep({
      key, img: tp.img,
      seed: { center: res.seed.center, rect: res.seed.rect, segments: res.seed.segments, label: L(0) },
      matches: res.matches.map((m, i) => ({ ...m, label: L(1 + i) })),
      questions,
      complete: res.complete, dropped: res.candidates.dropped,
      includeSeed: true, qIndex: 0, excludedTags: [],
    });
    setTool("select");
  }
  /** The label story in one line: "drawing says P-7 on all 4", or the mix. */
  function sweepLabelLine(rows, seedTag) {
    const tags = rows.map((r) => r.label?.label || null);
    const named = tags.filter(Boolean);
    if (!named.length) return null;
    if (seedTag && named.length === rows.length && named.every((t) => t === seedTag)) return `drawing says ${seedTag} on all ${rows.length}`;
    const byTag = {};
    for (const t of tags) byTag[t || "no label"] = (byTag[t || "no label"] || 0) + 1;
    return Object.entries(byTag).map(([t, n]) => `${t} ×${n}`).join(" · ");
  }
  function commitSweep() {
    const sw = sweep;
    if (!sw) return;
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const rows = [];
    const off = new Set(sw.excludedTags);
    const tagKey = (m) => (m.label && m.label.label) || "\u2205";
    if (sw.includeSeed) rows.push({ at: sw.seed.center, score: 1, rotation: 0, mirrored: false, seedRow: true });
    for (const m of sw.matches) if (!off.has(tagKey(m))) rows.push(m);
    for (const q of sw.questions) if (q.state === "accepted") rows.push(q);
    if (!rows.length) { setCommitMsg("Nothing to commit — no matches and no accepted questions."); return; }
    // ONE dispatch = one undo step, the whole gesture — same batch discipline
    // as the MCP's set-wide commit
    dispatchShape({ type: "add", shapes: rows.map((m) => ({
      sheet_id: sw.key, condition_id: activeCond, measure_role: "count",
      verts_norm: [[m.at[0] / sw.img.w, m.at[1] / sw.img.h]], computed: { count: 1 },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "symbol_sweep", symbol: { score: m.score, rotation: m.rotation, mirrored: m.mirrored, seed: { source: "instance", sheet: sw.key, ...(m.seedRow ? { seed_instance: true } : {}) } } },
    })) });
    const skippedN = sw.matches.length - sw.matches.filter((m) => !off.has(tagKey(m))).length;
    setCommitMsg(`Committed ${rows.length} EA under ${condById[activeCond]?.finish_tag || "condition"}${sw.includeSeed ? " — seed included" : ""}${skippedN ? ` · ${skippedN} excluded by label` : ""} · one undo step (${keyText("⌘Z")}).`);
    setSweep(null);
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
  // The sheet's stated layer roles as buildMask's per-segment codes (#85),
  // with the estimator's Layers-panel overrides applied — include forces hard
  // boundary, exclude drops the ink, the same semantics the MCP layers
  // filters carry. Refs, not state: this runs inside click paths and must see
  // a just-resolved table. null on unlayered sheets (or nothing classified) —
  // buildMask then takes the byte-identical pre-#85 path.
  function rolesForSheet(key) {
    const geo = layerGeoRef.current.get(key);
    const infos = layerInfosRef.current.get(key);
    if (!geo || !infos || !infos.length) return null;
    return segRoles(geo.layerOf, layerRoleCodes(geo.layerIds, effectiveLayerRoles(infos, layerOverridesRef.current[key])));
  }
  function ensureMask(key) {
    let mo = maskCacheRef.current.get(key);
    if (!mo) {
      const segs = vectorSegsRef.current.get(key);
      const dims = panelImgs[key];
      if (!segs || !segs.length || !dims?.w) return null;
      // sheet scale (image px per foot) rides into the mask so the hatch pitch
      // cap and the flood's size guards are feet-true — resolution-independent.
      // rescaleSheet evicts this cache entry when the calibration changes.
      const upp = uppFor(key);
      // A1: pass the BASELINE px/ft too, so the working raster is pinned to the
      // sheet rather than to whatever scale this sheet happens to be rendered at.
      const rsNow = renderScalesRef.current.get(key) || RENDER_SCALE;
      const pxPerFt = upp ? 1 / upp : 0;
      // …and A1/F3: the baseline the raster is pinned to comes from the page in
      // POINTS. `dims` is a ceil() of the render, so deriving the baseline from
      // it leaves the pin render-dependent (see buildMask's F3 note). This is
      // also the only branch that works before a calibration: k comes from the
      // render scales, not from px/ft, so an uncalibrated Hi-Res sheet is pinned
      // too. The mask is cached, so the extra getViewport is once per sheet per
      // calibration.
      const pgVp = pageObjsRef.current.get(key)?.getViewport({ scale: 1 });
      // dim texts were positioned at RENDER_SCALE; segs live at this render —
      // rescale so text and ink share a frame whatever the Hi-Res toggle says
      const dtk = rsNow === RENDER_SCALE ? dimTextsRef.current.get(key) : (dimTextsRef.current.get(key) || []).map((t) => ({ ...t, x: t.x * rsNow / RENDER_SCALE, y: t.y * rsNow / RENDER_SCALE, wPx: t.wPx * rsNow / RENDER_SCALE }));
      mo = buildMask(segs, dims.w, dims.h, MASK_MAX_DIM, segMetaRef.current.get(key), pxPerFt,
                     pxPerFt ? pxPerFt * RENDER_SCALE / rsNow : 0,
                     pgVp ? { pageW: pgVp.width, pageH: pgVp.height, renderScale: rsNow, baseScale: RENDER_SCALE } : null,
                     rolesForSheet(key),
                     { subpaths: subpathsRef.current.get(key) || null, texts: textMarksRef.current.get(key) || null, dimTexts: dtk && dtk.length ? dtk : null });
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
  // Build one one-click region from a flood result — the trace/snap/metrics
  // core shared VERBATIM by the stage path (proposeRegion) and the voice-deixis
  // direct-commit path (settleRegion), so an aimed utterance and an aimed click
  // can never trace differently. Raster differences: a looser RDP eps (scan
  // contours wobble) and NO vertex snapping — there are no true endpoints on a
  // scan, and pulling room corners onto the title-block's vector corners would
  // corrupt the ring. null = no scale, or the ring collapsed (too tiny/thin).
  function buildOneClickRegion(f, tp, local, negative, raster) {
    const upp = uppFor(tp.key);
    if (!upp) return null;
    // THE shared ring — trace-then-snap for vector, looser-eps unsnapped for
    // raster — through oneClickRing so this site cannot drift from the bench's
    // scoring of the production ring.
    const grid = snapGridsRef.current.get(tp.key);
    const ring = raster
      ? oneClickRing(f, { raster: true, rasterEps: RASTER_RDP_EPS })
      : oneClickRing(f, { nearest: (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null) });
    if (ring.length < 3) return null;
    const area_sf = +(ringArea(ring) * upp * upp).toFixed(2);
    const perim_lf = +(closedMetrics(ring).perim * upp).toFixed(2);
    // Item D: the engine's own account of the trace — tier, seal, wedges,
    // min-passage — scored to a 0–1 confidence with named factors, minted
    // into provenance at the Create gate below.
    const conf = traceConfidence(floodSignals(f, { raster, mppf: f.ws / upp, areaSF: area_sf }));
    // poly0 freezes the MACHINE trace (post-snap, pre-handle-edit) so a
    // corrected region can still report what the fill proposed; sens rides
    // only when the estimator moved the knob off Balanced (vector path
    // only — the raster mask is single-tier, sensitivity is inert there).
    return {
      kind: negative ? "neg" : "pos",
      seed: local,
      poly: ring,
      poly0: ring.map(([x, y]) => [x, y]),
      ...(!raster && fillSens !== SENS_BALANCED ? { sens: fillSens } : {}),
      area_sf,
      perim_lf,
      hf: !!f.hatchFiltered,
      // Whether SENSITIVITY had anything to act on for THIS fill. The knob
      // only tunes escalation past ink the classifier called hatch, so a fill
      // whose boundary is entirely hard ink returns the same region at every
      // setting — and the estimator, watching it stop short, reasonably reaches
      // for the knob and gets nothing. Sheet-level softCount can't answer this
      // (the VA plan classifies plenty of toilet poché while the rooms that
      // stop short touch none of it); only this region's own softHits can.
      // Raster-traced fills are single-tier, where sensitivity is inert by
      // construction.
      shs: raster ? 0 : (f.softHits || 0),
      sl: f.sealedPx || 0,
      gap: f.gapBridged || 0,
      mp: f.minPassDelta ? (f.minPassPx || 0) : 0, mpd: f.minPassDelta || 0,
      wg: f.wedges || 0,
      rw: f.ringWedges || 0,
      rt: !!raster,
      cf: conf.score,
      cff: conf.factors,
    };
  }
  // The propose tail (physical clicks): stage the region for the Create (⏎)
  // gate. Duplicate/carve checks run inside a FUNCTIONAL setProposal so a
  // click racing the first raster render can't clobber state.
  function proposeRegion(f, tp, local, negative, raster, prebuilt) {
    const region = prebuilt || buildOneClickRegion(f, tp, local, negative, raster);
    if (!region) {
      if (uppFor(tp.key)) setCommitMsg("Couldn't trace that space — trace it with Area (A).");
      return;
    }
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
        if (rs.some((r) => r.kind === region.kind && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "dup";
          return prev;
        }
        if (negative && !rs.some((r) => r.kind === "pos" && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "needsPos";
          return prev;
        }
        outcome = "added";
        return { key: tp.key, regions: [...rs, region] };
      });
    });
    if (outcome === "dup") setCommitMsg(negative ? "That cutout is already carved." : keyText("Already selected — ⌥-click carves an enclosed cutout; ⏎ creates."));
    else if (outcome === "needsPos") setCommitMsg(keyText("⌥-click carves an enclosed area INSIDE the selection (a column or shaft) — click its room first."));
    // The measurement-policy receipts: when the engine sealed, wedged, or
    // ruled a passage out, the estimator hears it at stage time — the trace is
    // reviewable while the edge in question is still under the cursor.
    else if (!f) { /* net-engine region: the caller already set the message; there is no flood receipt to narrate */ }
    else if (f.wedges && f.ringWedges >= f.wedges) setCommitMsg(`Measured to include the floor inside ${f.ringWedges === 1 ? "a closed ring" : `${f.ringWedges} closed rings`} drawn on the plan (a round column or a callout bubble) — no door swing was involved. If that is a column you deduct rather than floor you cover, ${keyText("⌥-click carves it out. ⏎ creates.")}`);
    else if (f.wedges && f.ringWedges) setCommitMsg(`Measured through the drawn door to the wall opening — the swing area is included. It also includes the floor inside ${f.ringWedges === 1 ? "a closed ring" : `${f.ringWedges} closed rings`} (a round column or callout bubble), which is not a door swing; ${keyText("⌥-click carves one out if it should be deducted. ⏎ creates.")}`);
    else if (f.wedges) setCommitMsg("Measured through the drawn door to the wall opening — the swing area is included. ⏎ creates.");
    else if (f.sealedPx) setCommitMsg(f.minPassPx
      ? `That space isn't closed on the drawing — the gap is under ${MIN_PASS_FT} ft, so the minimum-passage rule bridged it rather than measuring through it. That call is at the limit of what this sheet's resolution can decide; review the edge, then ⏎ creates.`
      : "That space wasn't fully enclosed — a small opening (a doorway or line gap) was sealed to bound it. Review the edge, then ⏎ creates.");
    else if (f.minPassDelta) setCommitMsg(`A passage under ${MIN_PASS_FT} ft wide was treated as not connecting — measuring through it would have added ${Math.round(f.minPassDelta * 100)}% more area. Review that edge, then ⏎ creates.`);
    else setCommitMsg("");
  }
  // `direct` (voice deixis, RFC #59): { conditionId, label } — the human aimed
  // the crosshair, so the flood COMMITS in one step through settleRegion →
  // commitOneClickRegions (the same gate ⏎ drives) instead of staging a
  // proposal, and every exit returns { ok, message } so the voice outcome can
  // speak it — a deixis trace never no-ops silently. The condition rides BY
  // VALUE because the utterance armed it in this same handler (the activeCond
  // closure is a render behind). Click callers ignore the return value; their
  // message surface stays setCommitMsg, unchanged.
  async function oneClickAt(p, negative, direct, fieldClick) {
    const say = (message) => { setCommitMsg(message); return { ok: false, message }; };
    const tp = panelAt(p[0]);
    const upp = uppFor(tp.key);
    if (!upp) return say(`Set the scale for ${labelFor(tp)} first.`);
    if (!(direct ? direct.conditionId : activeCond)) return say("Pick or add a condition first.");
    // a click may EXTEND a same-sheet proposal; voice deixis commits whole and
    // must never swallow a selection the human is still reviewing — ANY pending
    // proposal rejects the utterance
    if (proposal && (direct || proposal.key !== tp.key)) {
      return say(direct
        ? "Finish the pending one-click selection first — ⏎ creates it, Esc discards."
        : `Finish the selection on ${labelFor(panelByKey(proposal.key))} first — ⏎ creates it, Esc discards.`);
    }
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
    // NET ENGINE branch — vector sheets only; a scan has no linework to network.
    if (netEngine && !direct && vectorViable) {
      const segs = vectorSegsRef.current.get(tp.key);
      const meta = segMetaRef.current.get(tp.key);
      if (!segs || !meta) return say("Still reading this sheet's linework — One-Click arms as soon as that finishes (a dense sheet can take a few seconds). Try again in a moment.");
      if (!netWorker) return say("One-Click needs Web Workers in this browser — trace it with Area (A).");
      // FRAMES: the vector segments live at the BASELINE render scale; a hi-res
      // sheet's click and its upp are in the hi-res frame (uppFor divides by
      // factorFor). Convert into the segments' frame for the engine and back
      // out for the ring — at 207% zoom every foot-based threshold was off
      // by the zoom factor (the "regressions" that appeared only zoomed in).
      const kF = RENDER_SCALE / (renderScalesRef.current.get(tp.key) || RENDER_SCALE);   // hi-res px → baseline px
      const ftPx = kF / upp;                     // baseline px per foot
      const buildOpts = {};
      const ck = `${tp.key}:${ftPx.toFixed(4)}`;
      let built = netCacheRef.current.get(ck);
      if (!built) {
        // one build per (sheet, scale); concurrent clicks share the promise
        // LOUD, TICKING status: a dense sheet reads for tens of seconds and a
        // silent wait reads as failure (his call, Liminal 2026-08-24)
        const t0 = Date.now();
        setCommitMsg("Reading the walls on this sheet… 0 s — the first click on a sheet builds its wall network; the page stays live.");
        const tick = setInterval(() => setCommitMsg(`Reading the walls on this sheet… ${Math.round((Date.now() - t0) / 1000)} s — the first click on a sheet builds its wall network; the page stays live.`), 1000);
        netTickRef.current = tick;
        const subpathsIn = subpathsRef.current.get(tp.key) || null, textsIn = textMarksRef.current.get(tp.key) || [];
        // diagnostic record of EXACTLY what the engine was handed (read from devtools as window.__netLast)
        try { window.__netLast = { key: ck, sheet: tp.key, nSegs: segs.length >> 2, nMeta: meta.length, nSubpaths: subpathsIn ? subpathsIn.length : 0, nTexts: textsIn.length, ftPx, upp, kF, img: tp.img && { w: tp.img.w, h: tp.img.h }, metaHead: Array.from(meta.slice(0, 12)), segsHead: Array.from(segs.slice(0, 8)).map((v) => +v.toFixed(1)), textHead: textsIn.slice(0, 2) }; } catch { /* diagnostics only */ }
        built = netCall({ type: "build", key: ck, segs, meta, subpaths: subpathsIn, ftPx, texts: textsIn, opts: buildOpts })
          .then((m) => { if (m.error) { netCacheRef.current.delete(ck); throw new Error(m.error); } try { Object.assign(window.__netLast, { faces: m.faces, starved: m.starved, ms: m.ms }); } catch { /* diagnostics only */ } return m; });
        netCacheRef.current.set(ck, built);
      }
      let info;
      try { info = await built; }
      catch (err) { console.error("net engine build failed", err); return say("One-Click couldn't read this sheet's linework — trace it with Area (A)."); }
      finally { if (netTickRef.current) { clearInterval(netTickRef.current); netTickRef.current = null; } }
      if (toolRef.current !== "oneclick" || (proposalRef.current && proposalRef.current.key !== tp.key)) { setCommitMsg(""); return { ok: false, message: "" }; }
      const field = !!fieldClick;
      const rm = await netCall({ type: "room", key: ck, x: local[0] * kF, y: local[1] * kF, ftPx, mode: field ? "field" : "room" });
      const r = rm.room;
      if (!r) return say(field
        ? "No finish pattern under that ⇧-click — ⇧-click inside the tile or plank pattern to select the whole field."
        : "That click isn't inside an enclosed space — click an open spot, ⇧-click an open finish field, or trace it with Area (A).");
      const ring = r.ring.map(([x, y]) => [x / kF, y / kF]);      // back to the panel's frame
      try { Object.assign(window.__netLast, { lastClick: [local[0], local[1]], lastRing: ring.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]), lastFaces: r.faces }); } catch { /* diagnostics only */ }
      const area_sf = +(r.areaPx / (ftPx * ftPx)).toFixed(2);
      const perim_lf = +(closedMetrics(ring).perim * upp).toFixed(2);
      const region = {
        kind: negative ? "neg" : "pos", seed: local, poly: ring, poly0: ring.map(([x, y]) => [x, y]),
        area_sf, perim_lf, hf: false, shs: 0, sl: 0, gap: 0, mp: 0, mpd: 0, wg: 0, rw: 0, rt: false,
        cf: 1, cff: [], net: true, netFaces: r.faces, netStarved: !!r.starved, netMode: field ? "field" : "room",
      };
      setCommitMsg(`${field ? "Finish field" : "Room"}: ${area_sf.toFixed(0)} SF from ${r.faces} face${r.faces === 1 ? "" : "s"}${r.holes.length ? ` (${r.holes.length} interior void${r.holes.length === 1 ? "" : "s"} not subtracted from the outline)` : ""}${info && info.ms ? ` · net built in ${(info.ms / 1000).toFixed(1)} s` : ""} — ⏎ creates, Esc discards.`);
      proposeRegion(null, tp, local, negative, false, region);
      return { ok: true, message: "" };
    }
    if (!rasterEligible || vectorViable) {
      const mo = ensureMask(tp.key);
      if (!mo && !rasterEligible) return say("Still reading this sheet's linework — try again in a second.");
      if (mo) {
        // seal radii + wedge cap scale with the sheet: bridge up to a door-width
        // opening (mask px per foot = mask-per-image-px / units-per-image-px)
        const mppf = mo.ws / upp;
        const f = floodRegionSealed(mo, local[0], local[1], fillSens, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
        if (f.status === "ok") return settleRegion(f, tp, local, negative, false, direct);
        if (!rasterEligible) {
          return say(f.status === "leak"
            ? "That space isn't enclosed on the plan linework — the fill spilled. Click a more enclosed spot, or trace it with Area (A)."
            : "Landed in dense linework (hatching/text). Zoom in and click an open spot, or trace it with Area (A).");
        }
      }
    }
    setCommitMsg("Reading the scan…");
    const seq = renderSeqRef.current;
    const rmo = await ensureRasterMask(tp.key);
    if (seq !== renderSeqRef.current) {   // sheet group changed mid-render — the new sheet must not be left showing a stale "Reading the scan…" ("…" messages never auto-expire, see commitMsg's 6s-timer effect
      setCommitMsg("");
      return direct
        ? say("Couldn't place that — the sheet changed while reading the scan. Say it again.")
        : { ok: false, message: "" };
    }
    // The raster render can take real time on a large scan; the user may have
    // switched tools or started a DIFFERENT panel's proposal while it was in
    // flight. renderSeq alone only catches a sheet-GROUP change — re-validate
    // against the LIVE tool/proposal (refs, not the closed-over `tool`/
    // `proposal` — this is an async continuation resuming after other renders)
    // so a late raster result can never silently replace another panel's
    // in-progress proposal or paint a ghost selection in the wrong tool.
    // Voice (direct) is modeless — no tool check — but a proposal appearing
    // mid-await means the human started clicking; the utterance yields loudly
    // rather than race the hand.
    if (direct ? proposalRef.current : (toolRef.current !== "oneclick" || (proposalRef.current && proposalRef.current.key !== tp.key))) {
      setCommitMsg("");
      return direct
        ? say("Couldn't place that — a one-click selection started while reading the scan. Finish it (⏎/Esc), then say it again.")
        : { ok: false, message: "" };
    }
    if (!rmo) return say("Couldn't read this scan — trace it with Area (A).");
    // The raster mask is single-tier (softCount 0), so the flood's hatch
    // escalation — and with it the Fill sensitivity knob — is structurally
    // inert on scans; the default sensitivity rides along. Gap sealing still
    // applies — faded scan lines are the raster path's own flavor of open doorway.
    const f = floodRegionSealed(rmo, local[0], local[1], undefined, sealRadiiFor(rmo.ws / upp), doorWedgeCapPx(rmo.ws / upp), minPassRadiusFor(rmo.ws / upp));
    if (f.status !== "ok") {
      return say(f.status === "leak"
        ? "That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Click a more enclosed spot, or trace it with Area (A)."
        : "Landed on dense scan ink (text or hatching). Zoom in and click an open spot, or trace it with Area (A).");
    }
    return settleRegion(f, tp, local, negative, true, direct);
  }
  // After a successful flood: a physical click STAGES the region for the
  // ⏎/dblclick Create gate; a voice-deixis trace (direct) COMMITS it now —
  // same builder, same commit gate, no preview-then-Enter. The spoken
  // imperative IS the confirmation (RFC #59 who-aimed-it rule).
  function settleRegion(f, tp, local, negative, raster, direct) {
    if (!direct) { proposeRegion(f, tp, local, negative, raster); return { ok: true, message: "" }; }
    const region = buildOneClickRegion(f, tp, local, negative, raster);
    if (!region) return { ok: false, message: "Couldn't trace that space — trace it with Area (A)." };
    return commitOneClickRegions({ key: tp.key, regions: [region] }, direct);
  }
  // The ONE commit gate for one-click regions — the ⏎/dblclick Create AND a
  // voice-deixis trace both land here, so human-aimed work gets exactly one
  // origin shape (one_click_v1, reviewed) and one undo path. `direct` (voice)
  // pins { conditionId, label } from the utterance BY VALUE — the arming
  // setState hasn't rendered, so the activeCond/activeLabel closures are one
  // render behind (the updateCondition-by-id precedent in voiceActions).
  function commitOneClickRegions(prop, direct) {
    const tp = panelByKey(prop.key);
    const condId = direct ? direct.conditionId : activeCond;
    const label = direct && direct.label !== undefined ? direct.label : (activeLabel || undefined);
    const made = prop.regions.map((r) => ({
      sheet_id: tp.key, condition_id: condId,
      measure_role: r.kind === "neg" ? "deduct" : "floor_area",
      verts_norm: r.poly.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
      computed: { area_sf: r.area_sf, perimeter_lf: r.perim_lf },
      ...(label ? { label } : {}),
      // the provenance receipt: machine-proposed, human-reviewed at the Create
      // gate (voice deixis: the spoken imperative is the review). A handle-
      // corrected region (touched) records the machine's frozen trace (poly0)
      // as proposed_verts_norm — the one-click correction pair; an untouched
      // region's verts ARE the proposal, so nothing extra rides. Post-Create
      // edits are stamped by stampEdit, which freezes the same field from the
      // pre-edit ring only when Create didn't already.
      origin: { method: r.net ? "net_v1" : "one_click_v1", ...(r.net ? { net_faces: r.netFaces, net_starved: r.netStarved, net_mode: r.netMode } : {}), seed_norm: [r.seed[0] / tp.img.w, r.seed[1] / tp.img.h], reviewed: true, confidence: r.cf ?? 1, ...(r.cff?.length ? { confidence_factors: r.cff } : {}), ...(r.hf ? { hatch_filtered: true } : {}), ...(r.sl ? { gap_sealed_px: r.sl } : {}), ...(r.gap ? { gap_bridged_px: r.gap } : {}), ...(r.mp ? { min_pass_px: r.mp, min_pass_delta: r.mpd } : {}), ...(r.wg ? { door_wedges: r.wg } : {}), ...(r.rw ? { ring_interiors: r.rw } : {}), ...(r.rt ? { raster_traced: true } : {}), ...(r.sens != null ? { fill_sensitivity: r.sens } : {}), ...(r.touched ? { edited_before_create: true, proposed_verts_norm: r.poly0.map(([x, y]) => [x / tp.img.w, y / tp.img.h]) } : {}) },
    }));
    const res = dispatchShape({ type: "add", shapes: made });   // the creation gate — id/created_at minted by the command
    // ...and the new takeoff is SELECTED. Without this, Create left nothing
    // selected, so the ⌫ that had been deleting the proposal a moment earlier
    // suddenly did nothing and the only way to undo a bad fill was the Edit
    // menu — the one moment in the flow where the keyboard stopped working.
    // Same idiom as pasteClipboard: a plain add appends, so the minted shapes
    // are the array's last N. Deliberately WITHOUT pasteClipboard's
    // setTool("select") — the status message says "Click the next room" and
    // it has to stay true. Selecting while One-Click is armed is safe: a
    // shape's own handles only grab under tool === "select", and the
    // proposal branch sits ahead of `selectedId` in the ⌫ chain, so the next
    // fill's ⌫ still discards that proposal first.
    if (res?.shapes?.length) selectShape(res.shapes[res.shapes.length - 1].id);
    const sf = prop.regions.reduce((n, r) => n + (r.kind === "neg" ? -r.area_sf : r.area_sf), 0);
    // condById is a render closure — a condition minted THIS utterance is only
    // in the live mirror, so fall through to it for the tag
    const tag = (condById[condId] || agentStateRef.current.conditions.find((c) => c.id === condId))?.finish_tag || "";
    const message = `Created ${made.length} takeoff${made.length === 1 ? "" : "s"} — ${fa(sf)} ${tag}. Click the next room.`;
    setCommitMsg(message);
    return { ok: true, message };
  }
  function createProposal() {
    if (!proposal || !proposal.regions.length) return;
    commitOneClickRegions(proposal);
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
    if (!proposal || !tp || !tp.img.w) { ocDragRef.current = null; bumpIdle(); return; }
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
  // ── Tidy — one geometry pass on the selected takeoff (ringTidy) ────────────
  // A mask-derived ring (One-Click, detect_rooms, a raster trace) carries
  // dozens–hundreds of staircase vertices no hand can drag straight. One pass:
  // collinear/micro-segment chains collapse, vertices on CAD corners hold
  // (drifted ones pull home), near-square walls square up between anchors;
  // genuinely angled walls survive. Closed rings only — a linear run's
  // vertices are its measurement. The lib refuses any result that moves area
  // >3%; worst case the shape comes back untouched. One command = one ⌘Z.
  function tidySelected() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel) return;
    if (sel.measure_role === "count" || sel.measure_role === "linear" || sel.measure_role === "surface_area") {
      setCommitMsg("Tidy works on area takeoffs — a linear run's vertices are its measurement."); return;
    }
    const sp = panelByKey(sel.sheet_id);
    if (!sp || !sp.img.w || (sel.verts_norm || []).length < 3) return;
    const grid = snapGridsRef.current.get(sel.sheet_id);
    const rt = !!sel.origin?.raster_traced;   // no true endpoints on a scan — pure simplify+square
    const ringPx = sel.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
    const r = tidyRing(ringPx, { nearest: (x, y, dd) => (!rt && grid ? nearestSnap(grid, x, y, dd) : null) });
    if (!r.changed) { setCommitMsg("Nothing to tidy — this takeoff is already clean."); return; }
    const vn = r.ring.map(([x, y]) => [x / sp.img.w, y / sp.img.h]);
    dispatchShape({
      type: "geom", id: sel.id, editKind: "tidy",
      verts_norm: vn, computed: recomputeShape({ ...sel, verts_norm: vn }), prev: geomSnapshot(sel),
    });
    setCommitMsg(`Tidied — ${ringPx.length} → ${r.ring.length} vertices; corners held to plan lines, near-square walls squared. ⌘Z undoes.`);
  }
  // ── markup (cloud / callout / text) — annotations, not measurements ─────────
  // markupDraft holds STAGE px (so the live preview spans panels); a markup
  // belongs to the panel of its FIRST click and normalizes against that panel.
  function addMarkup(m, key) {
    // created_at rides the defaults so every markup path (hand-drawn, cloud's
    // pre-minted id, stamp instances) is stamped at this single creation gate.
    // condition_id defaults to the ACTIVE condition: an annotation drawn while
    // a condition is selected is almost always about that condition, and a
    // wrong-but-editable link beats an unlinked note nobody ever goes back to
    // attach. Explicit `...m` still wins, so a caller that means "unattached"
    // can pass condition_id: "".
    setMarkups((ms) => [...ms, { id: uid("mk"), created_at: nowIso(), sheet_id: key, rfi_id: "", condition_id: activeCond || "", ...m }]);
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
      // approval seals are ink, not markups — the include-markups checkbox
      // never drops them, and a sheet carrying only a seal still exports
      const allKeys = [...new Set([...shapes.map((s) => s.sheet_id), ...exportMarkups.map((m) => m.sheet_id), ...approvals.map((a) => a.sheet_id)])];
      const plainMeta = allKeys.filter((k) => !isStitchKey(k)).map((key) => {
        const { file, page } = parseSheetKey(key);
        return { key, file, page, label: tabLabel(key) };
      }).sort((a, b) => compareSheetKeys(a.key, b.key));   // canonical sheet order — shared comparator
      // Stitched surfaces (#161 → #200) burn in as composite pages, after the
      // source sheets: each member placed at its stitch offset, seam-clipped,
      // shapes drawn once in the frame they were measured in. A stitch whose
      // record is gone (member file dropped from the set) has nowhere to draw
      // and is skipped — its shapes still ride the Report, as before.
      const stitchMeta = allKeys.filter(isStitchKey).map((key) => {
        const st = stitchById[key];
        if (!st) return null;
        return {
          key, label: st.name || "Stitched sheets",
          stitch: { members: st.members.map((m) => ({ key: m.key, ...parseSheetKey(m.key), label: tabLabel(m.key), dx: m.dx, dy: m.dy })) },
        };
      }).filter(Boolean);
      const sheetMeta = [...plainMeta, ...stitchMeta];
      // branding mode decides the cover identity + wordmark + parent credit;
      // resolved per-project (folderId "" ⇒ the single browser-only setting)
      const brand = resolveBranding({ ...(await loadBrandingSelection(projectIdFromUrl())), profiles: loadProfiles().profiles });
      const { bytes, filename } = await buildMarkedSetPdf({
        projectName, clientInfo, company: brand.company, credit: brand.credit, coverTitle: brand.coverTitle,
        dark: darkMode, units, sheets: sheetMeta, shapes, markups: exportMarkups, approvals, rfis, conditions,
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
    else if ((m.type === "arrow" || m.type === "dimension") && m.from && m.to) { nx = (m.from[0] + m.to[0]) / 2; ny = (m.from[1] + m.to[1]) / 2; }
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
  useEffect(() => { if (!editor) { editingRef.current = false; bumpIdle(); } }, [editor]);
  // double-click a markup (Select tool) to edit its text in place — find the target
  // via toImage + hitMarkup (non-highlight beats highlight, mirroring selectAt) and
  // open the overlay at its anchor.
  function editMarkupAt(e) {
    if (!showMarkups) return;
    const p = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    const rev = [...visibleMarkups].reverse();
    const m = rev.find((mm) => mm.type !== "highlight" && mm.type !== "image" && hitMarkup(mm, p, thr))
      || rev.find((mm) => mm.type === "highlight" && hitMarkup(mm, p, thr))
      || rev.find((mm) => mm.type === "image" && hitMarkup(mm, p, thr));
    if (!m) return;
    // an svg symbol carries no text — select it, but don't open a dead-end editor;
    // a highlighter stroke is pure ink (no text either), same rule
    if (m.type === "svg" || m.type === "image" || (m.type === "highlight" && Array.isArray(m.pts))) { selectMarkup(m.id); return; }
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
    } else if (tool === "dimension") {
      // a dimension LABELS a real length, so it is the one markup the scale
      // gate applies to — same refusal the measure tools give (mirrors the
      // MCP annotate verb's doctrine). Gate on the FIRST click so the user
      // isn't refused after carefully picking both ends.
      if (!markupDraft) {
        if (!uppFor(tp.key)) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
        setMarkupDraft(p);
      } else {
        if (spansPanels([markupDraft, p])) { setCommitMsg(SPAN_MSG); return; }
        const dp = panelAt(markupDraft[0]);
        const upp = uppFor(dp.key);
        const lenFt = Math.hypot(p[0] - markupDraft[0], p[1] - markupDraft[1]) * (upp || 0);
        if (!(lenFt > 0)) return;   // a zero-length click-in-place is a misfire, not a dimension
        addMarkup({ type: "dimension", from: norm(markupDraft, dp), to: norm(p, dp), len_ft: +lenFt.toFixed(2), text: "" }, dp.key);
        setMarkupDraft(null);
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
  // ── approval seal (ink, human-only) — the estimator's stamp. One click: on
  // a committed shape → seal that shape (records its id); on empty plan →
  // seal the sheet at that point. A click on an existing seal LIFTS it, so the
  // tool is its own eraser. Both directions are real undo steps — family-
  // tagged entries on the shared ⌘Z stack (dispatchApproval above).
  // Deliberately NOT exposed through MCP or the in-canvas agent: machine
  // verdicts arrive as actor "agent" records through data paths, never here.
  function placeApproval(p) {
    const tp = panelAt(p[0]);
    if (!tp?.img?.w) return;
    const nx = (p[0] - tp.xOffset) / tp.img.w, ny = p[1] / tp.img.h;
    // lift first — distance in width-normalized units (the seal radius is
    // normalized to sheet WIDTH, the bubble convention), topmost wins
    const seal = [...approvals].reverse().find((a) => a.sheet_id === tp.key
      && Math.hypot(nx - a.at[0], (ny - a.at[1]) * (tp.img.h / tp.img.w)) <= APPROVAL_R);
    if (seal) { dispatchApproval({ type: "delete", ids: [seal.id] }); setCommitMsg("Approval seal lifted (⌘Z restores it)."); return; }
    // topmost committed shape under the click — the selectAt scan, this panel only
    const thr = 8 / tfRef.current.scale;
    const shape = [...stackedShapes].reverse().find((s) => s.sheet_id === tp.key
      && hitShapeC(s, p[0] - tp.xOffset, p[1], tp.img.w, tp.img.h, thr));
    dispatchApproval({ type: "add", approvals: [{ actor: "estimator", sheet_id: tp.key, at: [nx, ny], ...(shape ? { shape_id: shape.id } : {}) }] });
    setCommitMsg(shape
      ? `Approved — seal on ${condById[shape.condition_id]?.finish_tag || "shape"} (⌘Z undoes).`
      : "Sheet point approved — seal placed (⌘Z undoes).");
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
  // ── markup ↔ condition. Same shape as the RFI link and deliberately so: one
  // condition ↔ many markups, the link lives on the MARKUP, and membership is
  // derived rather than stored on the condition. Without this an annotation is
  // a floating note — it can't take the condition's colour, can't travel with
  // it into an export, and can't answer "what did we say about this scope".
  const linkCondition = (markup, condId) => { if (markup && condId) updateMarkup(markup.id, { condition_id: condId }); };
  const unlinkCondition = (markup) => { if (markup) updateMarkup(markup.id, { condition_id: "" }); };
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
    else if ((m.type === "arrow" || m.type === "dimension") && m.from && m.to) anchor = [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2];
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
      clearPoly();
      return;
    }
    // A curved area commits as ONE closed polygon (#284) — the spline is
    // flattened here, at the boundary, so nothing downstream (area, perimeter,
    // Cut Out, hit-testing, the marked PDF, every export) has to learn a second
    // kind of geometry. flattenArcRing is the identity on an all-straight trace.
    const drawn = curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly;
    if (tool === "surface") commitSurface(drawn, curveIdx.length > 0);
    else if (tool === "linear") commitLinear(drawn, false, curveIdx.length > 0);
    else commitPoly(curveIdx.length ? flattenArcRing(poly, curveIdx, true) : poly, tool === "deduct", { curved: curveIdx.length > 0 });
    clearPoly();
  }
  // #137 — the parent state deleting a reconciled deduct should restore. The
  // deduct's own frozen origin.parent_prev is only correct when it is the
  // parent's SOLE cut: with several reconciled cutouts on one parent, that
  // snapshot predates the OTHER cuts, so restoring it would wipe their holes
  // while their deduct shapes live on. Instead: take the chain's EARLIEST
  // snapshot (the most pristine geometry on record) and re-subtract every
  // surviving deduct's ring in commit order (lib/cutout.recomposeCutouts).
  // Null when the rebuild can't be trusted (panel not mounted, scale unset,
  // or a re-subtract degenerates) — the caller then falls back to a plain
  // delete that leaves the cut baked in, never reverts over survivors.
  function cutoutParentPrevSans(doomed) {
    const chain = shapes.filter((s) => s.cuts_shape_id === doomed.cuts_shape_id && s.origin?.parent_prev);
    const rest = chain.filter((s) => s.id !== doomed.id);
    if (!rest.length) return doomed.origin.parent_prev;
    const parent = shapes.find((s) => s.id === doomed.cuts_shape_id);
    const tp = panelByKey(parent.sheet_id);
    const upp = uppFor(parent.sheet_id);
    if (!tp?.img?.w || !upp) return null;
    const px = (ring) => ring.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    const base = chain[0].origin.parent_prev;
    const r = recomposeCutouts(px(base.verts_norm), (base.verts_norm_holes || []).map(px), rest.map((s) => px(s.verts_norm)));
    if (!r) return null;
    const norm = (ring) => ring.map(([x, y]) => [x / tp.img.w, y / tp.img.h]);
    return {
      verts_norm: norm(r.outer),
      ...(r.holes.length ? { verts_norm_holes: r.holes.map(norm) } : {}),
      computed: { area_sf: +(r.area * upp * upp).toFixed(2), perimeter_lf: +(r.perim * upp).toFixed(2) },
    };
  }
  // #137 — deleting a reconciled deduct reverts its cut out of the parent
  // too: the sole cut restores the frozen origin.parent_prev snapshot
  // (durable — works after a reload, not just within the same undo stack);
  // one of SEVERAL cuts rebuilds the parent from the chain's earliest
  // snapshot minus the survivors (cutoutParentPrevSans). A rebuild that
  // degenerates falls through to the plain delete — the shape goes, its cut
  // stays baked in.
  function deleteSelected() {
    if (!selectedId) return;
    const only = shapes.find((s) => s.id === selectedId);
    if (only?.cuts_shape_id && only.origin?.parent_prev && shapes.some((s) => s.id === only.cuts_shape_id)) {
      const parentPrev = cutoutParentPrevSans(only);
      if (parentPrev) {
        dispatchShape({ type: "cutout", restore: true, deductId: only.id, parentId: only.cuts_shape_id, parentPrev });
        setSelectedId(null);
        return;
      }
    }
    dispatchShape({ type: "delete", ids: [selectedId] }); setSelectedId(null);
  }
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

  // A withheld transition is a QUESTION, and the answer is at a PLACE on the
  // sheet — so its row in the panel jumps there rather than printing raw image
  // pixels at someone. Centers the point at a working zoom; the estimator looks
  // for the door and measures the threshold.
  function locateSheetPoint(sheetId, at) {
    const el = containerRef.current;
    const sp = panelByKey(sheetId);
    if (!el || !sp?.img?.w || !Array.isArray(at)) return;
    const r = el.getBoundingClientRect();
    const scale = clamp(1.2);
    setTfNow({ x: r.width / 2 - (at[0] + sp.xOffset) * scale, y: r.height / 2 - at[1] * scale, scale });
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
    const vectorViable = !!stats && stats.segCount >= RASTER_MIN_SEGS;
    let f = null, raster = false;
    // Vector sheet: the SAME net engine a human click runs — an agent and an
    // estimator must never trace differently (the who-aimed-it rule).
    if (vectorViable) {
      const segs = vectorSegsRef.current.get(key);
      const meta = segMetaRef.current.get(key);
      if (!segs || !meta) return { error: "Still reading this sheet's linework — try again in a moment." };
      if (!netWorker) return { error: "One-Click needs Web Workers in this browser." };
      const kF = RENDER_SCALE / (renderScalesRef.current.get(key) || RENDER_SCALE);
      const ftPx = kF / upp;
      const ck = `${key}:${ftPx.toFixed(4)}`;
      let built = netCacheRef.current.get(ck);
      if (!built) {
        built = netCall({ type: "build", key: ck, segs, meta, subpaths: subpathsRef.current.get(key) || null, ftPx, texts: textMarksRef.current.get(key) || [], opts: {} })
          .then((m) => { if (m.error) { netCacheRef.current.delete(ck); throw new Error(m.error); } return m; });
        netCacheRef.current.set(ck, built);
      }
      try { await built; } catch { return { error: "One-Click couldn't read this sheet's linework — the estimator will have to trace it." }; }
      const rm = await netCall({ type: "room", key: ck, x: local[0] * kF, y: local[1] * kF, ftPx, mode: "room" });
      const r = rm.room;
      if (!r) return { error: "That seed isn't inside an enclosed space on the plan linework. Seed an open spot inside the room." };
      const ring = r.ring.map(([x, y]) => [x / kF, y / kF]);
      if (ring.length < 3) return { error: "Couldn't trace that space into a polygon." };
      const area_sf = +(r.areaPx / (ftPx * ftPx)).toFixed(2);
      return {
        verts_norm: ring.map(([x, y]) => [+(x / p.img.w).toFixed(5), +(y / p.img.h).toFixed(5)]),
        area_sf,
        perimeter_lf: +(closedMetrics(ring).perim * upp).toFixed(2),
        seed_norm: [+xn.toFixed(5), +yn.toFixed(5)],
        confidence: 1,
        net_faces: r.faces,
      };
    }
    if (!f) {
      const rmo = await ensureRasterMask(key);
      if (!rmo) return { error: "Couldn't read this scan — the estimator will have to trace it by hand." };
      const r = floodRegionSealed(rmo, local[0], local[1], undefined, sealRadiiFor(rmo.ws / upp), doorWedgeCapPx(rmo.ws / upp), minPassRadiusFor(rmo.ws / upp));
      if (r.status !== "ok") {
        return { error: r.status === "leak"
          ? "That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Seed a more enclosed spot."
          : "Landed on dense scan ink (text or hatching). Seed an open spot inside the room." };
      }
      f = r; raster = true;
    }
    const grid = snapGridsRef.current.get(key);
    const ring = raster
      ? oneClickRing(f, { raster: true, rasterEps: RASTER_RDP_EPS })
      : oneClickRing(f, { nearest: (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null) });
    if (ring.length < 3) return { error: "Couldn't trace that space into a polygon." };
    const area_sf = +(ringArea(ring) * upp * upp).toFixed(2);
    const conf = traceConfidence(floodSignals(f, { raster, mppf: f.ws / upp, areaSF: area_sf }));
    return {
      verts_norm: ring.map(([x, y]) => [+(x / p.img.w).toFixed(5), +(y / p.img.h).toFixed(5)]),
      area_sf,
      perimeter_lf: +(closedMetrics(ring).perim * upp).toFixed(2),
      seed_norm: [+xn.toFixed(5), +yn.toFixed(5)],
      confidence: conf.score,
      ...(conf.factors.length ? { confidence_factors: conf.factors } : {}),
      ...(f.hatchFiltered ? { hatch_filtered: true } : {}),
      ...(f.sealedPx ? { gap_sealed_px: f.sealedPx } : {}),
      ...(f.minPassDelta ? { min_pass_px: f.minPassPx || 0, min_pass_delta: f.minPassDelta } : {}),
      ...(f.wedges ? { door_wedges: f.wedges } : {}),
      ...(f.ringWedges ? { ring_interiors: f.ringWedges } : {}),
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

  // Voice deixis (RFC #59 deixis slice): "carpet one, this room" — the
  // utterance carries WHAT, the crosshair carries WHERE. getAimSeed resolves
  // the existing pointer tracker (lastPtrRef — the same positions the
  // moveCrosshair aim renders from; no second tracker) into a sheet-local
  // seed. null = the aim isn't LIVE: nothing tracked since the utterance
  // began — Command box focus / the previous run — or since the pointer left
  // the canvas or the tab hid (voiceAimMarkRef). sheetId "" = live aim that
  // isn't over a sheet. Both become loud rejects in the dispatcher, checked
  // before any state moves. The seed is the RAW cursor, not the snap/angle-
  // adjusted point: a flood seed targets a room's interior, where snap pull
  // toward a wall endpoint could only hurt — and matches a mid-room click,
  // which never snaps either.
  function getAimSeed() {
    if (status !== "ready" || !lastPtrRef.current) return null;
    if (aimSeqRef.current <= voiceAimMarkRef.current) return null;   // stale — no pointer update since the utterance began / last invalidation
    const p = toImage(lastPtrRef.current[0], lastPtrRef.current[1]);
    const tp = panelAt(p[0]);
    const x = p[0] - tp.xOffset, y = p[1];
    if (!tp.img.w || x < 0 || y < 0 || x >= tp.img.w || y >= tp.img.h) return { x, y, sheetId: "" };
    return { x, y, sheetId: tp.key };
  }
  // The who-aimed-it rule: the human put the crosshair there, so the trace
  // runs the SAME oneClickAt flood a physical click runs and commits DIRECT
  // as human work (one_click_v1 origin, same undo) — one utterance, no
  // preview-then-⏎, and NEVER an agentProposals row (that gate is for agent-
  // INFERRED placement; the line is aim). conditionId/label ride explicitly:
  // the utterance armed them in this same handler, so the render closures are
  // stale. Failures wrap into the commitMsg bar's "Couldn't" convention.
  async function voiceTraceAt(seed, conditionId, label) {
    const tp = panelByKey(seed.sheetId);
    if (!tp || tp.key !== seed.sheetId || !tp.img.w) return { ok: false, message: "Couldn't place that — aim at a sheet." };
    const out = await oneClickAt([seed.x + tp.xOffset, seed.y], false, { conditionId, label });
    if (out.ok) return out;
    const m = out.message || "Couldn't place that — the view changed mid-trace. Say it again.";
    return { ok: false, message: /^couldn'?t/i.test(m) ? m : `Couldn't place that — ${m.charAt(0).toLowerCase()}${m.slice(1)}` };
  }
  // Voice-command capabilities (RFC #59 slice 2) — every entry binds an action
  // the UI already exposes; the dispatcher (voiceActions.ts) never touches
  // state directly. getConditions reads the live mirror (mintCondition updates
  // it mid-handler); the rest are safe render closures because the voice path
  // is synchronous up to traceAt, whose async continuation carries its state
  // by value/ref instead. Programmatic activation passes {reassign:false} —
  // same policy as hotkeys and Library Apply.
  function buildVoiceCtx() {
    return {
      getConditions: () => agentStateRef.current.conditions.map((c) => ({ id: c.id, finish_tag: c.finish_tag })),
      getShapeLabels: () => shapeLabels,
      getActiveConditionId: () => activeCond || "",
      activateCondition: (id) => activateCondition(id, { reassign: false }),
      createCondition: (tag) => mintCondition(tag),
      updateCondition: updateCondById,
      addLabel,
      activateLabel,
      // top-center of the focused sheet: text markups render centered on `at`,
      // and addMarkup auto-opens the Markups dock, so the note is immediately
      // visible and draggable — the anchor is a starting point, not a commitment
      addNote: (text) => addMarkup({ type: "text", at: [0.5, 0.06], text }, focusPanel.key),
      // author declaration (#314) — provenance's one localStorage key; new
      // commits pick it up at mint, nothing re-stamps retroactively
      setAuthor: (v) => setAuthorName(v),
      getAimSeed,
      traceAt: (seed, conditionId, label) => voiceTraceAt(seed, conditionId, label),
    };
  }
  const onVoiceCommand = (text) => {
    const out = runVoiceCommand(buildVoiceCtx(), text);
    // every run consumes the aim (the seed was already read synchronously):
    // repeating "this room" without a fresh pointer move is a stale-aim
    // reject, never a silent double-commit of the same room
    voiceAimMarkRef.current = aimSeqRef.current;
    const finish = (o) => {
      setCommitMsg(o.message);
      // two-tier router (RFC #59 slice 5): a FULLY-unrecognized transcript,
      // with the agent configured, earns an OFFER — never an auto-run. Any
      // other outcome (success, near-miss reject, dispatcher refusal) clears
      // a stale offer so ⏎ can never become a surprise agent run.
      if (shouldOfferAgentHandoff(o, isAiConfigured())) offerAgentHandoff(text);
      else clearAgentOffer();
      return o.ok;
    };
    // deixis traces can resolve async (raster flood awaits a render) — the
    // outcome message lands when it lands; everything else stays synchronous
    return typeof out?.then === "function" ? out.then(finish) : finish(out);
  };

  // ── push-to-talk (RFC #59 recognizer slice) ────────────────────────────────
  // Hold M to dictate; release runs the transcript through the SAME
  // onVoiceCommand the Command box uses; Esc mid-hold discards. Everything is
  // lazy: the worker + model load on the first hold (ingest.js precedent), and
  // decode happens OFF the main thread (stt.worker.ts) so pan/zoom stays
  // smooth. Deliberately NOT re-marking the deixis aim at keydown: for typed
  // commands focus starts the utterance and the pointer moves after; for a
  // hold, the hand is ALREADY resting the pointer on the room — demanding a
  // pointer tick mid-hold would stale-reject every still-handed "this room".
  // The standing invalidations (canvas-leave, tab-hide, previous run) still
  // guard every ghost-seed path the #83 design named.
  const [voiceChip, setVoiceChip] = useState(null); // { text, tone: "live"|"busy"|"info"|"offer" } | null
  const voiceClientRef = useRef(null);
  const voiceCaptureRef = useRef(null);              // live CaptureSession during a hold
  const voiceModelRef = useRef({ phase: "unprobed" });
  const voiceHoldRef = useRef(false);                // physical key/button state
  const voiceFlashRef = useRef(0);                   // transcript-flash timer
  // ── two-tier router offer (RFC #59 slice 5) ───────────────────────────────
  // A thin consent-gated bridge into the EXISTING agent loop: confirm hands
  // the refused transcript to runAgent() — same cfg, tools, Accept gate as the
  // panel; no new tools, no second interpretation. The offer expires (consent
  // hygiene), and the spoken confirm is a fixed literal, never grammar.
  const AGENT_OFFER_TTL_MS = 20000;
  const pendingAgentOfferRef = useRef(null);         // { transcript } | null — the chip is the render, the ref is the logic
  const agentOfferTimerRef = useRef(0);
  function offerAgentHandoff(transcript) {
    clearTimeout(agentOfferTimerRef.current);
    pendingAgentOfferRef.current = { transcript };
    setVoiceChip({ text: 'not a command — ⏎ or say "ask the agent" to run it on YOUR agent (your endpoint, your key) · proposals land for review · Esc dismisses', tone: "offer" });
    agentOfferTimerRef.current = setTimeout(() => clearAgentOffer(), AGENT_OFFER_TTL_MS);
  }
  function clearAgentOffer() {
    if (!pendingAgentOfferRef.current) return;
    clearTimeout(agentOfferTimerRef.current);
    pendingAgentOfferRef.current = null;
    setVoiceChip((c) => (c && c.tone === "offer" ? null : c));
  }
  function confirmAgentHandoff() {
    const t = pendingAgentOfferRef.current?.transcript;
    clearAgentOffer();
    if (!t) return;
    // runAgent self-guards (agentRunning, isAiConfigured, sheet ready); the
    // panel opens so the run — and its Accept gate — happen in plain sight
    setAgentOpen(true);
    void runAgent(t);
  }
  const agentOfferFnsRef = useRef(null);
  agentOfferFnsRef.current = { confirm: confirmAgentHandoff, dismiss: clearAgentOffer, pending: () => !!pendingAgentOfferRef.current };
  function ensureVoiceClient() {
    if (!voiceClientRef.current) {
      voiceClientRef.current = createVoiceRecognizerClient((s) => {
        voiceModelRef.current = s;
        if (s.phase === "loading") setVoiceChip({ text: `voice model loading… ${s.pct}%`, tone: "busy" });
        else if (s.phase === "ready") setVoiceChip((c) => (c && c.tone === "busy" ? null : c));
        else if (s.phase === "uninstalled") { setVoiceChip(null); setCommitMsg("Voice isn't installed on this deployment — see docs/VOICE.md to stage the model."); }
        else if (s.phase === "error") { setVoiceChip(null); setCommitMsg(`Couldn't load the voice model — ${s.message} Hold M to retry.`); }
      });
    }
    return voiceClientRef.current;
  }
  async function voiceHoldStart() {
    if (voiceCaptureRef.current) return;
    const client = ensureVoiceClient();
    if (voiceModelRef.current.phase !== "ready") {
      // never a silent drop: pressing PTT before the model is ready SAYS so
      // (and kicks off/retries the load, so the affordance is also the fix)
      void client.ensureReady();
      if (voiceModelRef.current.phase === "loading")
        setVoiceChip({ text: `voice model loading… ${voiceModelRef.current.pct ?? 0}% — try again shortly`, tone: "busy" });
      return;
    }
    try {
      const session = await startCapture();
      if (!voiceHoldRef.current) { session.cancel(); return; }  // released during the permission prompt
      session.onEnded(() => {
        session.cancel();
        voiceCaptureRef.current = null;
        setVoiceChip(null);
        setCommitMsg("Couldn't finish dictation — the microphone was revoked.");
      });
      voiceCaptureRef.current = session;
      setVoiceChip({ text: "listening… release M to run · Esc to discard", tone: "live" });
    } catch (err) {
      setCommitMsg(
        err?.reason === "mic_denied" ? "Couldn't start dictation — microphone permission denied. Allow the mic and try again."
        : err?.reason === "no_mic_device" ? "Couldn't start dictation — no microphone found."
        : "Couldn't start dictation — microphone unavailable.",
      );
    }
  }
  function voiceHoldEnd(commit) {
    const session = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (!session) return;
    if (!commit) { session.cancel(); setVoiceChip(null); return; }
    const pcm = session.stop();
    if (pcm.length < 1600) { setVoiceChip(null); return; }   // <0.1 s — a key tap, not an utterance
    setVoiceChip({ text: "decoding…", tone: "busy" });
    voiceClientRef.current.transcribe(pcm).then((text) => {
      const t = text.trim();
      // the spoken router confirm is a FIXED LITERAL (never grammar): said
      // alone with an offer pending it confirms; without one it says so —
      // and the trigger itself never becomes an offer
      if (isAgentHandoffTrigger(t)) {
        if (pendingAgentOfferRef.current) { setVoiceChip(null); agentOfferFnsRef.current.confirm(); return true; }
        setVoiceChip({ text: "nothing to hand off — say the command first", tone: "info" });
        clearTimeout(voiceFlashRef.current);
        voiceFlashRef.current = setTimeout(() => setVoiceChip((c) => (c && c.tone === "info" ? null : c)), 2400);
        return false;
      }
      // flash what was heard — the transcript is the receipt — then the
      // outcome lands in the commitMsg bar like every other command
      setVoiceChip(t ? { text: `“${t}”`, tone: "info" } : null);
      clearTimeout(voiceFlashRef.current);
      voiceFlashRef.current = setTimeout(() => setVoiceChip((c) => (c && c.tone === "info" ? null : c)), 2400);
      return Promise.resolve(onVoiceCommandRef.current(t));
    }).catch(() => { setVoiceChip(null); setCommitMsg("Couldn't decode that — try again."); });
  }
  // live refs — the mount-once keyboard effect must never see stale closures
  const onVoiceCommandRef = useRef(null);
  onVoiceCommandRef.current = onVoiceCommand;
  const voiceFnsRef = useRef(null);
  voiceFnsRef.current = { start: voiceHoldStart, end: voiceHoldEnd };
  useEffect(() => {
    const down = (e) => {
      if (e.key === "Escape" && voiceCaptureRef.current) { voiceFnsRef.current.end(false); return; }
      const tg = e.target.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      if (menuDepthRef.current > 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ((e.key || "").toLowerCase() !== "m") return;
      voiceHoldRef.current = true;
      voiceFnsRef.current.start();
    };
    const up = (e) => {
      if ((e.key || "").toLowerCase() !== "m") return;
      if (!voiceHoldRef.current) return;
      voiceHoldRef.current = false;
      voiceFnsRef.current.end(true);
    };
    // tab backgrounded mid-dictation: discard, say so (testing-bar lifecycle)
    const onVis = () => {
      if (document.visibilityState === "hidden" && voiceCaptureRef.current) {
        voiceHoldRef.current = false;
        voiceFnsRef.current.end(false);
        setCommitMsg("Dictation discarded — the tab went to the background.");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("visibilitychange", onVis);
      // unmount cleanup — no orphaned audio contexts, workers, or offer timers
      voiceCaptureRef.current?.cancel();
      voiceCaptureRef.current = null;
      voiceClientRef.current?.dispose();
      voiceClientRef.current = null;
      clearTimeout(agentOfferTimerRef.current);
      pendingAgentOfferRef.current = null;
    };
  }, []);

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

  // ── correction rules (#88) — detect → offer → preview → Apply ──────────────
  // The correction carried information: a deduct hand-drawn fully inside a
  // same-condition room is "this enclosed thing is not finish area on this
  // project". detectCandidateRule (lib/rules.ts, pure + tested) decides; the
  // banner offers; Preview stages candidates as dashed pencil; Apply commits
  // ONE ruleApply command. Never silent, never model-in-the-loop.
  function maybeOfferRule(deductShape, allShapes) {
    const seed = detectCandidateRule(allShapes, deductShape);
    if (!seed) return;
    setRuleStage(null);
    setRuleOffer({ deduct: deductShape, seed, tag: condById[deductShape.condition_id]?.finish_tag || "this condition" });
  }
  function previewRule() {
    if (!ruleOffer) return;
    const rule = buildRuleFromSeed(ruleOffer.deduct, ruleOffer.seed, ruleOffer.tag, { id: `rule-${mintUuid()}`, now: nowIso() });
    // sheet data for every OPEN panel with linework + a scale — the rule scans
    // what the estimator can see and review, nothing off-screen.
    const sheetData = new Map();
    for (const p of panels) {
      if (!p.img?.w) continue;
      const mo = ensureMask(p.key);
      const upp = uppFor(p.key);
      if (!mo || !upp) continue;
      sheetData.set(p.key, { mask: mo, upp, imgW: p.img.w, imgH: p.img.h });
    }
    const candidates = applyRuleToProject(rule, shapes, sheetData);
    setRuleOffer(null);
    if (!candidates.length) { setCommitMsg("No other enclosed regions match this rule on the open sheets."); return; }
    setRuleStage({ rule, candidates, proposed_ts: nowIso() });
  }
  function applyStagedRule() {
    if (!ruleStage) return;
    const { rule, candidates, proposed_ts } = ruleStage;
    const ts = nowIso();
    const made = [];
    for (const c of candidates) {
      const tp = panels.find((x) => x.key === c.sheet_id && x.img.w);
      const upp = uppFor(c.sheet_id);
      if (!tp || !upp) continue;
      const ringPx = c.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
      made.push({
        sheet_id: c.sheet_id, condition_id: rule.seed_condition_id, measure_role: "deduct",
        verts_norm: c.verts_norm.map((v) => [...v]),
        computed: { area_sf: +(ringArea(ringPx) * upp * upp).toFixed(2), perimeter_lf: +(closedMetrics(ringPx).perim * upp).toFixed(2) },
        // rule_v1 origin — every propagated shape traces back to the rule and
        // the seed correction (the RFC's provenance requirement, verbatim).
        origin: {
          method: "rule_v1", actor: "rule", reviewed: true,
          rule_id: rule.id, seed_shape_id: rule.seed_shape_id,
          container_shape_id: c.container_shape_id,
          proposed_ts, accepted_ts: ts,
          proposed_verts_norm: c.verts_norm.map((v) => [...v]),
        },
      });
    }
    setRuleStage(null);
    if (!made.length) return;
    const res = dispatchShape({ type: "ruleApply", shapes: made });   // ONE command — one undo entry for the whole batch
    const ids = res.shapes.slice(-made.length).map((s) => s.id);
    // the rule persists WITH its audit trail — inspectable in the project file
    setRules((rs) => [...rs.filter((r) => r.id !== rule.id), { ...rule, applied_to: ids }]);
    setCommitMsg(`Rule applied — ${made.length} deduct${made.length === 1 ? "" : "s"} added (⌘Z undoes all). ${rule.label}.`);
  }

  // ── ⟂ Transitions (#202, canvas side) ──────────────────────────────────────
  // Where two finishes meet is the most mechanical line left on a Division 9
  // takeoff, and an estimator draws it by hand on every job. derive_transitions
  // handed that to the agent; this hands the same thing — and the same refusal —
  // to the person at the canvas.
  //
  // A BUTT JOINT (the two rooms running together inside one open space) commits
  // as dashed pencil on the ACTIVE condition, so the Accept pill already on
  // screen is the gate and ⌘Z undoes the sweep in one step. A WALL-SEPARATED
  // pair never commits: the transition across a partition is a threshold in a
  // doorway, and nothing in a flood trace says where the doorway is. Those come
  // back as a report — length, gap, and a point to look at — for the estimator
  // to place with the drawing in front of them.
  //
  // Sources are scoped to the OPEN sheets (the rule preview's rule): the
  // derivation only proposes what you can see and review.
  const transitionSources = useMemo(() => {
    const rooms = new Map();
    for (const s of visibleShapes) {
      if (s.measure_role !== "floor_area") continue;
      rooms.set(s.condition_id, (rooms.get(s.condition_id) || 0) + 1);
    }
    return conditions.filter((c) => rooms.has(c.id)).map((c) => ({ id: c.id, finish_tag: c.finish_tag, rooms: rooms.get(c.id) }));
  }, [conditions, visibleShapes]);

  function deriveTransitionsOnto(idA, idB) {
    const target = condById[activeCond];
    if (!target) return { error: "Pick the condition the transitions land on first." };
    const ca = condById[idA], cb = condById[idB];
    if (!ca || !cb) return { error: "Pick the two finishes that meet." };
    const roomsOf = (id) => visibleShapes
      .filter((s) => s.condition_id === id && s.measure_role === "floor_area" && (s.verts_norm || []).length >= 3)
      .map((s) => ({ id: s.id, sheet_id: s.sheet_id, verts_norm: s.verts_norm }));
    const a = { tag: ca.finish_tag, shapes: roomsOf(idA) };
    const b = { tag: cb.finish_tag, shapes: roomsOf(idB) };
    // frames for the open panels those rooms actually sit on; an unscaled one
    // refuses the WHOLE call rather than deriving a partial answer — a
    // transition is a real length, and half a sweep reads like a whole one.
    const frames = new Map(), unscaled = [];
    const inPlay = new Set([...a.shapes, ...b.shapes].map((s) => s.sheet_id));
    for (const p of panels) {
      if (!p.img?.w || !inPlay.has(p.key)) continue;
      const upp = uppFor(p.key);
      if (!upp) { unscaled.push(labelFor(p)); continue; }
      frames.set(p.key, { widthPx: p.img.w, heightPx: p.img.h, upp });
    }
    const refusal = transitionRefusal({ activeTag: target.finish_tag, a, b, sheets: frames, unscaled });
    if (refusal) return { error: refusal };
    const { runs, withheld } = deriveTransitionRuns(a, b, frames);
    const tIn = Number(target.thickness_in) || 0;   // a transition strip with a width prices border SF, exactly like a drawn line
    const made = runs.map((r) => ({
      sheet_id: r.sheet_id, condition_id: target.id, measure_role: "linear",
      verts_norm: r.verts_norm.map((v) => [...v]),
      computed: { perimeter_lf: r.length_lf, area_sf: tIn > 0 ? +((r.length_lf * tIn) / 12).toFixed(2) : 0 },
      // the MCP verb's provenance vocabulary, verbatim: both parents, both
      // tags, the measured gap, and `case` always "butt" — a wall-separated run
      // is a question, and questions do not become shapes.
      origin: {
        method: "derived", actor: "canvas", reviewed: false, proposed_ts: nowIso(),
        derived: { between_shape_ids: r.between_shape_ids, between: r.between, case: "butt", gap_in: r.gap_in },
      },
    }));
    if (made.length) dispatchShape({ type: "add", shapes: made });   // ONE command — one undo entry for the whole sweep
    const total_lf = +made.reduce((n, s) => n + s.computed.perimeter_lf, 0).toFixed(2);
    if (made.length) {
      setCommitMsg(`${made.length} transition${made.length === 1 ? "" : "s"} derived between ${a.tag} and ${b.tag} — ${total_lf} LF onto ${target.finish_tag}, dashed until you Accept (⌘Z undoes the sweep).`);
    } else if (withheld.length) {
      setCommitMsg(`Nothing to commit — every ${a.tag}/${b.tag} run is across a wall. See the Transitions panel.`);
    } else {
      setCommitMsg(`${a.tag} and ${b.tag} never meet on the open sheets.`);
    }
    return { committed: made.length, total_lf, withheld, between: [a.tag, b.tag], onto: target.finish_tag };
  }

  // ── the accept gate, for shapes already IN the data ─────────────────────────
  // An imported MCP takeoff arrives committed but unreviewed (origin.reviewed
  // === false) — those render dashed pencil and gate the Accept pill. Accept
  // routes through the `review` command (ONE undo entry), which flips reviewed
  // + stamps accepted_ts and nothing else: affirmation, not an edit. Rejecting
  // one is just deleting it — select and Delete, like any shape.
  const pendingCommitted = useMemo(() => visibleShapes.filter((s) => s.origin?.reviewed === false), [visibleShapes]);
  function acceptPendingShapes() {
    if (!pendingCommitted.length) return;
    dispatchShape({ type: "review", ids: pendingCommitted.map((s) => s.id) });
    setCommitMsg(`Accepted ${pendingCommitted.length} proposed shape${pendingCommitted.length === 1 ? "" : "s"} — pencil is now ink.`);
  }
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
      bumpIdle();   // scan done → let the idle-drain observe the busy→idle edge (Slice 5b)
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

  // ── image markup (#…) — two entry points, one record type ────────────────
  // Marquee screenshot: a,b are the two marquee corners in stage px. Render the
  // boxed region of the plan offscreen (the rasterizeRegion idiom, but with its
  // OWN 1600px downscale factor — NOT scanRasterScale's 4096 cap) and store it as
  // a floating `image` markup anchored at the box center. Guards mirror
  // importScheduleFromRect: sheet ready, both corners in one panel, a real source
  // page (refuse a stitched composite), a non-degenerate box.
  async function captureRegionMarkup(a, b) {
    if (status !== "ready") { setCommitMsg("Sheet still loading — try again in a moment."); return; }
    const panel = panelAt(a[0]);
    if (panelAt(b[0]).key !== panel.key) { setCommitMsg("Draw the box within a single sheet."); return; }
    const pageObj = pageObjsRef.current.get(panel.key);
    if (!pageObj) { setCommitMsg("Capture a region on a single sheet (not a stitched view)."); return; }
    const rs = renderScalesRef.current.get(panel.key) || RENDER_SCALE;
    // rect in image (rs-viewport) px, clamped to the panel bounds so an over-drag
    // past the sheet edge never parks the geometry off-sheet
    const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const x0 = cl(Math.min(a[0], b[0]) - panel.xOffset, 0, panel.img.w);
    const x1 = cl(Math.max(a[0], b[0]) - panel.xOffset, 0, panel.img.w);
    const y0 = cl(Math.min(a[1], b[1]), 0, panel.img.h);
    const y1 = cl(Math.max(a[1], b[1]), 0, panel.img.h);
    const regW = x1 - x0, regH = y1 - y0;
    if (!(regW >= 4 && regH >= 4)) { setCommitMsg("Drag a larger box to capture."); return; }
    // own downscale factor: 1600px longest side (never scanRasterScale's 4096)
    const factor = Math.min(1, MARKUP_IMG_MAX / regW, MARKUP_IMG_MAX / regH);
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));
    let src;
    try {
      const vp = pageObj.getViewport({ scale: rs * factor });
      const canvas = document.createElement("canvas");
      canvas.width = bw; canvas.height = bh;
      await pageObj.render({
        canvasContext: canvas.getContext("2d"),
        viewport: vp,
        transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor],
      }).promise;
      src = canvas.toDataURL("image/png");
    } catch { setCommitMsg("Couldn't capture that region."); return; }
    const { at, w, aspect } = captureRectToImageGeom({ x0, y0, x1, y1 }, panel.img.w, panel.img.h);
    if (!(w > 0)) return;
    addImageMarkup({ at, w, aspect, src, source: "capture" }, panel.key);
  }

  // The aggregate-budget gate shared by both entry points: refuse a new image when
  // the project's total image-markup bytes would exceed the cap (N capped images
  // otherwise defeat the per-image cap and push the annotations blob past quota).
  // This is a SOFT guard read from the render-closure `markups`; two back-to-back
  // async adds could momentarily race it, but the per-image 1600px cap already
  // bounds each one, so the worst case is a single image slipping just over the
  // budget — not a correctness or safety issue, and the quota surfacing in the
  // autosave catch is the real backstop.
  function addImageMarkup(m, key) {
    const used = markups.reduce((n, x) => n + (x.type === "image" && typeof x.src === "string" ? x.src.length : 0), 0);
    if (used + m.src.length > MAX_IMAGE_MARKUP_BYTES) { setCommitMsg("Too many/large images on this project — delete some before adding more."); return; }
    // Auto-name (stored in `text`, which the panel renders and the ✎ edits): the
    // sheet base + a per-sheet sequence ("AF101-01"). Uploads carry the file name.
    // Collisions after a delete are tolerated (a simple count, not a high-water
    // counter). Stamp the declared author (git-style; absent ⇒ omitted).
    const { name: given, ...rest } = m;
    const seq = markups.filter((x) => x.type === "image" && x.sheet_id === key).length + 1;
    const text = (typeof given === "string" && given.trim()) || `${sheetBaseLabel(key)}-${String(seq).padStart(2, "0")}`;
    const by = authorName();
    addMarkup({ type: "image", ...rest, text, ...(by ? { author: by } : {}) }, key);
    setCommitMsg("Image placed.");
  }

  // Lazy, memory-only panel thumbnail: decode the src ONCE, downscale to a ~48px
  // JPEG, cache by markup id. Returns null while building (the row shows a
  // placeholder) or on a bad src; the build's setImgThumbs re-renders the row.
  function ensureThumb(m) {
    if (imgThumbs[m.id]) return imgThumbs[m.id];
    if (!thumbBuildingRef.current.has(m.id) && m.src && pickEmbedFormat(m.src)) {
      thumbBuildingRef.current.add(m.id);
      const img = new Image();
      img.onload = () => {
        const s = 48 / Math.max(img.width, img.height, 1);
        const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        setImgThumbs((t) => ({ ...t, [m.id]: c.toDataURL("image/jpeg", 0.7) }));
      };
      img.onerror = () => { thumbBuildingRef.current.delete(m.id); };
      img.src = m.src;
    }
    return null;
  }
  // Provenance one-liner for the panel row's title tooltip (Kevin: not shown
  // prominently). Degrades: drops the author when none is declared.
  function imageProvenance(m) {
    const verb = m.source === "upload" ? "Uploaded" : "Captured from";
    const where = m.source === "upload" ? "" : ` ${sheetBaseLabel(m.sheet_id)}`;
    const when = m.created_at ? ` · ${String(m.created_at).slice(0, 10)}` : "";
    const who = m.author ? ` · ${m.author}` : "";
    return `${verb}${where}${when}${who}`;
  }

  // Upload: decode a raster file (EXIF-oriented), downscale to 1600px longest side,
  // ALWAYS re-encode through a canvas (pixels only — SSRF/script-safe; guarantees a
  // PNG/JPEG data URL), and drop it centered in the current view of the focus sheet.
  async function addImageFromFile(file) {
    // don't trust accept="image/*": accept ONLY PNG/JPEG — matching the UI copy,
    // the docs, and pickEmbedFormat (the marked-set gate), and keeping the decode
    // surface small. By MIME OR by extension, because some platforms/drag-drop hand
    // over an empty file.type for a good PNG/JPEG (the StampPanel import checks the
    // extension for the same reason). Everything else — webp/gif/bmp, and SVG — is
    // refused here (uploads are still re-encoded to PNG/JPEG regardless).
    const name = file?.name || "";
    const isPngJpeg = !!file && (/^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(name));
    if (!isPngJpeg) {
      setCommitMsg("Pick a PNG or JPEG image."); return;
    }
    // cheap pre-decode gate: bail on a huge FILE before createImageBitmap allocates
    // anything (a small-file / huge-dims pixel bomb is caught by the area guard below).
    if (file.size > MARKUP_UPLOAD_MAX_BYTES) { setCommitMsg(`That image file is too large (max ${Math.round(MARKUP_UPLOAD_MAX_BYTES / (1024 * 1024))} MB).`); return; }
    try {
      // sniff intrinsic dimensions via an <img> FIRST — reading naturalWidth/Height
      // only needs the header, so a pixel bomb (small file, enormous declared dims)
      // is refused BEFORE createImageBitmap forces a full-size RGBA decode that could
      // OOM the tab. createImageBitmap then only runs on an already-bounded image.
      const url = URL.createObjectURL(file);
      try {
        const dims = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => rej(new Error("decode"));
          im.src = url;
        });
        if (dims.w * dims.h > MARKUP_DECODE_MAX_AREA) { setCommitMsg("That image is too large (too many pixels)."); return; }
      } finally { URL.revokeObjectURL(url); }
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      // defense-in-depth: the oriented bitmap's own area, in case the sniff and the
      // decoder disagree (a markup-appropriate cap, NOT the 241M render-canvas cap).
      if (bmp.width * bmp.height > MARKUP_DECODE_MAX_AREA) { bmp.close?.(); setCommitMsg("That image is too large (too many pixels)."); return; }
      const f = Math.min(1, MARKUP_IMG_MAX / Math.max(bmp.width, bmp.height));
      const bw = Math.max(1, Math.round(bmp.width * f)), bh = Math.max(1, Math.round(bmp.height * f));
      const canvas = document.createElement("canvas");
      canvas.width = bw; canvas.height = bh;
      canvas.getContext("2d").drawImage(bmp, 0, 0, bw, bh);
      bmp.close?.();
      const isJpeg = file.type === "image/jpeg";
      const src = canvas.toDataURL(isJpeg ? "image/jpeg" : "image/png", isJpeg ? 0.85 : undefined);
      const aspect = aspectFromDims(bw, bh);
      // center of the current view, normalized to the focus panel (falls back to
      // the panel center if the view geometry isn't available)
      const cl01 = (v) => Math.min(1, Math.max(0, v));
      let at = [0.5, 0.5];
      const r = containerRef.current?.getBoundingClientRect();
      if (r) {
        const c = toImage(r.left + r.width / 2, r.top + r.height / 2);
        at = [cl01((c[0] - focusPanel.xOffset) / focusPanel.img.w), cl01(c[1] / focusPanel.img.h)];
      }
      addImageMarkup({ at, w: 0.2, aspect, src, source: "upload", name: (file?.name || "").replace(/\.[^.]+$/, "") }, focusPanel.key);
    } catch { setCommitMsg("Couldn't read that image."); }
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
  // By-id core + active-based convenience: one save chokepoint. Voice combo
  // intents ("cpt one waste seven") patch a condition activated in the SAME
  // handler, before re-render — the active-based form would hit the old active.
  const updateCondById = (id, patch) => setConditions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch, updated_at: nowIso() } : c)));
  const updateCond = (patch) => updateCondById(activeCond, patch);

  // delete a condition entirely (and its takeoffs); pick a new active one
  function deleteCondition(id) {
    const c = condById[id];
    if (!c) return;
    const owned = shapes.filter((s) => s.condition_id === id);
    if (owned.length && !window.confirm(`Delete ${c.finish_tag} and its ${owned.length} takeoff${owned.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    // Lineage first, removal second: deleting a family parent must not orphan its twins. The
    // eldest survivor is promoted to root (its rows are already materialized — propagate-on-write
    // guarantees that) and the rest re-point at it, origin_ids remapped.
    const next = promoteOnDelete(conditions, new Set([id])).filter((x) => x.id !== id);
    // cascade delete of the condition's OWNED shapes — counted centrally by the
    // command, but record:false keeps it off the undo stack: the confirm just
    // said "can't be undone", and ⌘Z restoring shapes without their condition
    // would resurrect orphans
    if (owned.length) dispatchShape({ type: "delete", ids: owned.map((s) => s.id), reason: "condition-delete" }, { record: false });
    setConditions(next);
    // Annotations are NOT owned by the condition the way shapes are — a cloud
    // saying "verify substrate here" outlives the takeoff line it was drawn
    // against. Clear the dangling pointer and keep the markup, same rule
    // deleteRfi follows: leave no orphan link, but never delete someone's note
    // as a side effect of deleting a quantity.
    setMarkups((ms) => ms.map((m) => (m.condition_id === id ? { ...m, condition_id: "" } : m)));
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

  // ── the family seam (lib/variants.ts) ─────────────────────────────────────
  // Every material write on a condition that belongs to a family goes through one of these, so
  // inheritance can never be half-applied. Two directions, and they are opposites:
  //   editing a FAMILY PARENT's row → the same patch lands on every twin still following it
  //   editing a TWIN's row          → that row goes local and stops following, for good
  const isFamilyParent = (cs, id) => cs.some((c) => c.variant_of === id);
  // supporting-materials editing (operates on the active condition)
  const addMaterial = () => setConditions((cs) => {
    const row = { id: uid("mat"), name: "", per: 0, basis: "area", unit: "", round: true };
    const next = cs.map((c) => (c.id === activeCond
      ? { ...c, materials: [...(c.materials || []), row], updated_at: nowIso() } : c));
    // a row added to the family reaches every area; a row added ON a twin is that twin's own
    // (minted with no origin_id, so nothing upstream ever touches it)
    return isFamilyParent(cs, activeCond) ? propagateRowAdd(next, activeCond, row, uid) : next;
  });
  const updateMaterial = (mid, patch) => setConditions((cs) => {
    const cur = cs.find((c) => c.id === activeCond);
    // NAME edits re-classify a geometry-less line's kind
    const next = cs.map((c) => (c.id === activeCond ? {
      ...c, updated_at: nowIso(),
      materials: (c.materials || []).map((m) => (m.id === mid ? matEditPatch(m, patch) : m)),
    } : c));
    if (cur?.variant_of) return next.map((c) => (c.id === activeCond ? markRowLocal(c, mid) : c));
    if (!isFamilyParent(cs, activeCond)) return next;
    const row = (next.find((c) => c.id === activeCond)?.materials || []).find((m) => m.id === mid);
    return row ? propagateRowPatch(next, activeCond, mid, row) : next;
  });
  // Removing a row: on a twin it leaves a tombstone (so the panel can show it, and so a later
  // family edit can't bring it back); on a parent it clears the twins' following copies but
  // never a row a twin has taken over.
  const removeMaterial = (mid) => setConditions((cs) => {
    const cur = cs.find((c) => c.id === activeCond);
    if (cur?.variant_of) return cs.map((c) => (c.id === activeCond ? { ...dropRowLocal(c, mid), updated_at: nowIso() } : c));
    const next = cs.map((c) => (c.id === activeCond
      ? { ...c, materials: (c.materials || []).filter((m) => m.id !== mid), updated_at: nowIso() } : c));
    return isFamilyParent(cs, activeCond) ? propagateRowRemove(next, activeCond, mid) : next;
  });
  // The per-row undo of an override: this row follows the family again.
  const followFamilyRow = (mid) => setConditions((cs) => {
    const row = (cs.find((c) => c.id === activeCond)?.materials || []).find((m) => m.id === mid);
    return row?.origin_id ? followFamily(cs, activeCond, row.origin_id, uid) : cs;
  });
  // A tombstoned row has no row left to carry the id, so the panel restores it by origin.
  const restoreDroppedRow = (originId) => setConditions((cs) => followFamily(cs, activeCond, originId, uid));
  // Twin the active condition: same finish somewhere else, its own materials, still following
  // this one. The label is REQUIRED and becomes the tag suffix — every export and every MCP tool
  // resolves a condition by tag, so two conditions sharing one make the second unreachable and
  // collapse on a takeoff re-import.
  const duplicateCondition = (id, label) => {
    const src = conditions.find((c) => c.id === id);
    const lab = String(label || "").trim();
    if (!src || !lab) return null;
    const tag = variantTag(src.finish_tag, lab);
    if (conditions.some((c) => normalizeTag(c.finish_tag) === normalizeTag(tag))) {
      setCommitMsg(`A condition is already called ${tag} — pick another label.`);
      return null;
    }
    const { twin, parentPatch } = mintTwin(src, {
      label: lab, tag, mintId: uid, nowIso,
      // keep the family's colour, advance only the hatch: variants of one finish should read as
      // related on the sheet, not as unrelated scopes
      nextHatch: HATCHES[1 + ((conditions.length + 1) % (HATCHES.length - 1))].id,
    });
    agentStateRef.current = { ...agentStateRef.current, conditions: [...agentStateRef.current.conditions, twin] };
    setConditions((cs) => [...cs.map((c) => (c.id === src.id && parentPatch ? { ...c, ...parentPatch } : c)), twin]);
    activateCondition(twin.id, { reassign: false });
    setCommitMsg(`Added ${twin.finish_tag} — its materials follow ${src.finish_tag} until you change them here.`);
    return twin;
  };
  // Cut a twin loose: every following row freezes where it stands. It KEEPS its family_id, so it
  // still groups and subtotals with its siblings — only the inheritance ends.
  const splitCondition = (id) => {
    const c = conditions.find((x) => x.id === id);
    if (!c?.variant_of) return;
    const par = conditions.find((x) => x.id === c.variant_of);
    const n = (c.materials || []).filter((r) => r.inherited).length;
    if (!window.confirm(`Split ${c.finish_tag} out of its family?\n\n${n} row${n === 1 ? "" : "s"} freeze at ${n === 1 ? "its" : "their"} current values, and edits to ${par?.finish_tag || "the original"} stop reaching it.\nIt keeps its name and still subtotals with the family.`)) return;
    setConditions((cs) => splitFromFamily(cs, id));
    setCommitMsg(`${c.finish_tag} no longer follows ${par?.finish_tag || "its family"}.`);
  };
  // Height/Thickness are LIVE parameters: changing them re-flows
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
      const lpts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
      const LF = openLen(s.curved ? flattenCurve(lpts) : lpts) * u;
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
  // The in-progress ring/rect fill, per the theme's draft.fillMode: "condition"
  // wears the active condition's own fill (drafting — today's look), "tint" a
  // wash of the theme accent, "none" a hollow draft. Defined here (not with the
  // early helpers) because it reads shapeFill(aCond) — both defined just above.
  const draftFill = DS.draft.fillMode === "condition" ? shapeFill(aCond)
    : DS.draft.fillMode === "tint" ? rgbaFromHex(DS.accent, DS.draft.tintAlpha ?? 0.08)
    : "none";
  // When the "outline area while drawing" preference is on, the ring tools draw
  // as an OPEN outline (no fill, not auto-closed) while in progress — they still
  // commit CLOSED on Enter/dbl-click (commitPoly is untouched). Off ⇒ today's
  // closed+filled polygon, byte-identical. surface/linear are unaffected — they
  // already render open and are excluded here.
  const ringOutline = draftOutline && (tool === "area" || tool === "deduct" || tool === "zone");
  // the drawn boundary — flattenArcRing is the identity on an all-straight trace
  const mm = closedMetrics(curveIdx.length ? flattenArcRing(poly, curveIdx, !bowOpen) : poly);
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
  const visRows = useMemo(() => conditionTotals(conditions, visibleShapes, seamCtx), [conditions, visibleShapes, seamCtx]);
  const visRowById = useMemo(() => new Map(visRows.map((r) => [r.id, r])), [visRows]);
  // Whole-project per-condition totals — the number the bid is built on. The
  // panel's rows lead with the visible-sheet slice (what you're looking at);
  // this map feeds the dim Σ suffix whenever the project holds MORE than the
  // open sheets show, so a condition whose takeoffs live on closed sheets
  // reads "Σ 412 SF" instead of a dead "—" (the whole-project number used to
  // exist only in the Report/exports). Same conditionTotals rules, no filter.
  const projRows = useMemo(() => conditionTotals(conditions, shapes, seamCtx), [conditions, shapes, seamCtx]);
  const projRowById = useMemo(() => new Map(projRows.map((r) => [r.id, r])), [projRows]);
  // ── load-time quantity heal (#137) ─────────────────────────────────────────
  // A shape can ARRIVE without the numbers its role requires (an import that
  // carried geometry only). Such a shape draws fine but reads as 0 SF in
  // every summer and silently zeroes its condition's totals. Heal once per
  // load: recompute from the SAME deterministic dims the render pipeline uses
  // (pdf.js viewport at RENDER_SCALE — page metadata only, no raster, so
  // shapes on CLOSED sheets heal too), and only where the sheet's scale is
  // known — no scale, no honest number; those stay unpriced rather than
  // guessed. Commits like the rescale repair (replace + reset — not an edit,
  // no undo entry); the next autosave banks it. The seq guard kills an
  // in-flight heal the moment shapes/scales change — the rerun starts over
  // against the fresh state (docFor caches, so the redo is cheap), and once
  // nothing needsMetrics this is a pure no-op.
  const healSeqRef = useRef(0);
  useEffect(() => {
    if (status !== "ready") return;
    const missing = shapes.filter((s) => needsMetrics(s) && uppFor(s.sheet_id));
    if (!missing.length) return;
    const seq = ++healSeqRef.current;
    (async () => {
      const dimsBy = new Map();
      for (const key of new Set(missing.map((s) => s.sheet_id))) {
        try {
          const { file, page: pn } = parseSheetKey(key);
          const pdf = await docFor(file);
          const pageObj = await pdf.getPage(Math.min(Math.max(1, pn), pdf.numPages || 1));
          const vp = pageObj.getViewport({ scale: RENDER_SCALE });
          dimsBy.set(key, { w: Math.ceil(vp.width), h: Math.ceil(vp.height) });
        } catch { /* orphaned sheet (source gone) — its shapes stay unpriced */ }
      }
      if (seq !== healSeqRef.current) return;   // stale — a newer load/edit owns the heal now
      const healed = new Map(missing
        .filter((s) => dimsBy.has(s.sheet_id))
        .map((s) => [s.id, computeShapeMetrics(s, dimsBy.get(s.sheet_id), uppFor(s.sheet_id) || 0, condById[s.condition_id])]));
      if (!healed.size) return;
      dispatchShape({ type: "replace", shapes: shapes.map((s) => (healed.has(s.id) ? { ...s, computed: healed.get(s.id) } : s)) }, { reset: true });
      setCommitMsg(`Repriced ${healed.size} takeoff${healed.size === 1 ? "" : "s"} that loaded without quantities.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reruns on load/shape/scale change; docFor/uppFor/condById read from the same render
  }, [status, shapes, scales, conditions]);
  // Zone check: the SAME conditionTotals rules on the shapes whose center point
  // sits inside the traced zone (lib/zone.js) — third scope of the one role math.
  const zoneShapes = useMemo(() => (zoneCheck ? shapesInZone(shapes, zoneCheck) : null), [shapes, zoneCheck]);
  const zoneRows = useMemo(
    () => (zoneShapes ? conditionTotals(conditions, zoneShapes, seamCtx).filter((r) => r.shape_count > 0) : null),
    [conditions, zoneShapes, seamCtx]
  );
  const zoneIds = useMemo(() => (zoneShapes ? new Set(zoneShapes.map((sh) => sh.id)) : null), [zoneShapes]);
  const condRow = visRowById.get(activeCond);
  const condTotal = condRow?.floor_sf || 0;
  const lfTotal = condRow?.lf || 0;
  const countTotal = condRow?.ea || 0;
  const wallTotal = condRow?.wall_sf || 0;
  const borderTotal = condRow?.border_sf || 0;
  // display-only derived metric: floor-area perimeters × the condition height
  const condH = Number(aCond?.height_ft) || 0; // the live-readout JSX below still reads this
  const vertTotal = verticalWallSf(visibleShapes, activeCond, aCond?.height_ft, condMult);
  // the tally under the total: every linear run and wall of the active
  // condition on the visible sheets, in draw order (lib/measurementBreakdown)
  const tally = useMemo(() => measurementBreakdown(visibleShapes, activeCond, aCond), [visibleShapes, activeCond, aCond]);
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
  // the input types in DISPLAY units (metres in metric); height_ft is stored feet
  const setShapeHeight = (raw) => {
    const v = Math.max(0, heightInputToFeet(parseFloat(raw) || 0, units));
    setShapes((ss) => ss.map((s) => {
      if (s.id !== selectedId) return s;
      const next = { ...s, height_ft: v, height_override: true };
      return { ...next, computed: recomputeShape(next) };
    }));
  };
  const clearShapeHeight = () => {
    setShapeHDraft(null);
    setShapes((ss) => ss.map((s) => {
      if (s.id !== selectedId) return s;
      const next = { ...s, height_ft: Number(condById[s.condition_id]?.height_ft) || 0, height_override: false };
      return { ...next, computed: recomputeShape(next) };
    }));
  };
  const finishOk = !bowOpen && (((tool === "area" || tool === "deduct") && poly.length >= 3) || (tool === "zone" && poly.length >= 3 && !zoneTraceCross) || ((tool === "linear" || tool === "surface") && poly.length >= 2));

  // ── Layers panel (#85 phase 2) wiring ──────────────────────────────────────
  // Open sheets that actually carry a PDF layer table. Empty for the common
  // flattened export — the rail button and the panel then render nothing at
  // all (zero chrome; the fallback is invisible, not a degraded mode).
  const layerEntries = groupKeys
    .map((k) => ({ key: k, label: tabLabel(k), layers: sheetLayers[k] || [], overrides: layerOverrides[k] || {} }))
    .filter((e) => e.layers.length);
  // Override mutations funnel here: the ref is the engine's source of truth
  // (rolesForSheet reads it inside click paths), state mirrors it for render/
  // persistence, and the sheet's lazy mask drops so the NEXT flood rebuilds
  // with the new roles. Existing staged proposals keep their traced rings —
  // they're under review, and re-flooding an estimator's edit would be rude.
  const setLayerOverride = (key, id, state) => {
    const prev = layerOverridesRef.current;
    const cur = { ...(prev[key] || {}) };
    if (state) cur[id] = state; else delete cur[id];
    const next = { ...prev };
    if (Object.keys(cur).length) next[key] = cur; else delete next[key];
    layerOverridesRef.current = next;
    maskCacheRef.current.delete(key);
    setLayerOverrides(next);
  };
  const resetLayerOverrides = (key) => {
    const next = { ...layerOverridesRef.current };
    delete next[key];
    layerOverridesRef.current = next;
    maskCacheRef.current.delete(key);
    setLayerOverrides(next);
  };

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
    setConditions((cs) => promoteOnDelete(cs, ids).filter((c) => !ids.has(c.id)));   // lineage repaired first
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
    ...(c.roll_setup ? { roll_setup: { ...c.roll_setup } } : {}),   // #136 — the roll spec is part of what makes a CPT-1 template CPT-1
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
    onDuplicateCondition: duplicateCondition, onSplitCondition: splitCondition,
    onDeriveTransitions: deriveTransitionsOnto,   // returns its result synchronously — the panel renders the withheld report from it
    onLocateTransition: locateSheetPoint,
    onFollowFamilyRow: followFamilyRow, onRestoreDroppedRow: restoreDroppedRow,
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
  // rail tile — a machined tool face for the left rail: 36px, keycap corner,
  // filled cobalt (+ HUD glow) when armed. Tooltip = label · shortcut.
  const railTile = (id, iconName, label, shortcut, onArm, opts = {}) => {
    const armed = opts.armed ?? (tool === id);
    return (
      <button key={id} type="button" onClick={onArm || (() => setTool(id))}
        title={shortcut ? keyText(`${label} · ${shortcut}`) : label} aria-label={label} aria-pressed={armed}
        style={{ position: "relative", width: "var(--ctl-l)", height: "var(--ctl-l)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid transparent", borderRadius: "var(--r-1)", background: armed ? (opts.tint || "var(--cobalt)") : "transparent", color: armed ? "var(--accent-contrast)" : (opts.tint || "var(--ink)"), boxShadow: armed ? "var(--glow)" : "none", cursor: "pointer", lineHeight: 1 }}>
        <Icon name={iconName} size={17} />
        {shortcut && <span aria-hidden="true" style={{ position: "absolute", bottom: 1, right: 3, fontFamily: "var(--f-mono)", fontSize: 8, color: armed ? "var(--accent-contrast)" : "var(--ink-muted)", opacity: armed ? 0.75 : 1 }}>{keyText(shortcut)}</span>}
      </button>
    );
  };
  const railLabel = (text) => (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: "var(--fs-2xs)", letterSpacing: ".1em", color: "var(--ink-muted)", userSelect: "none", margin: "var(--sp-2) 0 2px" }}>{text}</span>
  );

  // deck-1 sheet-nav chip — ONE home for "which sheet am I on": pages, files,
  // group/ungroup and the gallery all live in its dropdown. Ungroup/Regroup
  // are sheet-set operations, so they move in here instead of appearing
  // mid-row and shifting everything after them.
  // assigned floor/level rides the sheet chip + page entries (sheet key: page 1 is the bare file name)
  const levelOfPage = (n) => sheetLevels[n > 1 ? `${active}#${n}` : active] || "";
  const soloStitch = sheetGroup.length === 1 && isStitchKey(sheetGroup[0]) ? stitchById[sheetGroup[0]] : null;
  const sheetChipLabel = sheetGroup.length
    ? (soloStitch ? `Stitched — ${soloStitch.name}` : `${sheetGroup.length} sheets side-by-side`)
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
  if (sheetGroup.length) sheetMenuItems.push(soloStitch
    ? { id: "ungroup", label: "Leave stitch — back to one sheet", title: "Back to a single sheet (the stitch's first member) — the stitch keeps its takeoffs and reopens from the gallery or its tab", onSelect: ungroup }
    : { id: "ungroup", label: "Ungroup — back to one sheet", title: "Back to one sheet — you land on the sheet you were last working; every sheet keeps its takeoffs and markups", onSelect: ungroup });
  if (!sheetGroup.length && lastGroup.length >= 2) sheetMenuItems.push({ id: "regroup", label: `Regroup (${lastGroup.length})`, title: `Side-by-side again with the same ${lastGroup.length} sheets — each keeps its own scale, takeoffs and markups`, onSelect: regroup });
  if (sheetMenuItems.length) sheetMenuItems.push("divider");
  sheetMenuItems.push({ id: "gallery", icon: "sheets", label: "Open gallery…", shortcut: "G", onSelect: () => setView("gallery") });
  sheetMenuItems.push({
    id: "export-takeoff", icon: "document", label: "Export takeoff…",
    title: "Save this whole takeoff to a JSON file on your computer — every shape, condition, scale, markup and RFI, in the app's own format. Import takeoff reads it back as an editable takeoff (the plan PDF isn't in the file: open it first, then import).",
    onSelect: exportTakeoffFile,
  });
  sheetMenuItems.push({
    id: "import-takeoff", icon: "document", label: "Import takeoff…",
    title: "Load a takeoff JSON — the app's own export or an agent session's export_takeoff. Machine shapes land dashed in their condition colors for your review; on merge, your calibration, conditions, and workspace win.",
    onSelect: () => importInputRef.current?.click(),
  });
  sheetMenuItems.push({
    id: "export-project", icon: "document", label: "Export project archive…",
    title: "Save the WHOLE job as one portable .otk file — every plan PDF plus the full takeoff. Open it on any machine (drop it like a plan, or Add plans), archive it, or hand it to another estimator; unlike Export takeoff, the plans travel inside.",
    onSelect: exportProjectArchive,
  });
  sheetMenuItems.push({ section: "Profile — your templates, stamps & report setup" });
  sheetMenuItems.push({
    id: "export-profile", icon: "document", label: "Export profile…",
    title: "Save your working environment — condition templates, material library, stamps, report templates/theme/columns — as one portable .otprofile. Import it on another machine or hand a company setup to another estimator; project takeoffs are never in it.",
    onSelect: exportProfileFile,
  });
  sheetMenuItems.push({
    id: "import-profile", icon: "document", label: "Import profile…",
    title: "Replace your working environment with a .otprofile (you can also drop the file on the canvas). Your current setup downloads as a backup first — importing that backup restores it. Project takeoffs are untouched.",
    onSelect: () => profileInputRef.current?.click(),
  });
  sheetMenuItems.push({
    id: "reset-profile", icon: "undo", label: "Reset profile to defaults",
    title: "Back to a stock OpenTakeoff setup — empty template/material libraries, the default stamps, no report customization. Your current setup downloads as a backup first; project takeoffs are untouched.",
    onSelect: resetProfile,
  });

  // deck-2 scale chip — the four scale controls collapsed to one status face:
  // red dashed = unset ("you can't trace yet"), green = set, warning = the
  // plan notes a different scale than the one you picked
  const scaleDet = detectedScales[focusPanel.key];
  const scaleMismatch = !!(unitsPerPx && stdValue && scaleDet && Math.abs(scaleDet.upp - unitsPerPx) > 1e-9);
  // scale gate: an agent-set scale no human has confirmed wears the warning
  // face until it's confirmed (menu row below) or replaced by a human act
  const scaleNeedsConfirm = !!unitsPerPx && scaleUnconfirmed[focusPanel.key] === false;
  const scaleFace = !unitsPerPx ? "Set scale…" : scaleNeedsConfirm ? `⚠ ${stdValue || "custom"} — confirm` : `${scaleMismatch ? "≠" : "✓"} ${stdValue || "custom"}`;
  const scaleFaceStyle = !unitsPerPx
    ? { border: "1px dashed var(--c-danger)", color: "var(--c-danger)" }
    : scaleMismatch || scaleNeedsConfirm
      ? { border: "1px solid var(--c-warning)", color: "var(--c-warning)" }
      : { border: "1px solid var(--c-positive)", color: "var(--c-positive)" };
  const scaleTitle = scaleNeedsConfirm
    ? `An agent set this sheet's scale — no person has confirmed it. Check it against a printed dimension (K), then confirm from this menu; quantities stand on this number.`
    : scaleMismatch
      ? `You set ${stdValue}, but the plan notes ${scaleDet.label} on ${labelFor(focusPanel)} — double-check before tracing.`
      : `Set the scale for ${labelFor(focusPanel)} — remembered per sheet${groupKeys.length > 1 ? " (targets the sheet you last clicked)" : ""}`;
  const scaleItems = [];
  if (scaleNeedsConfirm) {
    scaleItems.push({
      id: "confirm-scale", icon: "check", tint: "var(--c-warning)",
      label: "Confirm agent-set scale",
      title: `This scale arrived from an agent takeoff and no person has verified it. Best practice: Check a dimension (K) against a printed dimension string first — a wrong scale poisons every quantity on the sheet.`,
      onSelect: () => confirmScale(focusPanel.key),
    });
    scaleItems.push("divider");
  }
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

  // Drawing-style picker — a select-style dropdown (DrawStylePicker.jsx),
  // grouped in the ⋯ overflow menu with the light/dark chrome toggle. The two
  // appearance preferences (chrome theme, drawing style) live together, out of
  // the per-trace tool row so a set-once preference never crowds the work; a
  // dropdown keeps that block one line tall, matching the toolbar's other
  // selects. setDrawStyle writes the module preference and its CustomEvent
  // (Task 2's onDrawStyleChange) round-trips back into drawStyleId, repainting
  // the canvas live — no other wiring here.
  const drawStyleRow = (
    <DrawStylePicker styles={DRAW_STYLES} ids={DRAW_STYLE_IDS} activeId={drawStyleId} onPick={setDrawStyle} />
  );

  // Outline-while-drawing toggle (⋯ overflow menu). ON ⇒ the Area/Deduct/Zone draft
  // shows as an open outline (no fill, not auto-closed) while tracing; it still
  // commits closed on Enter/dbl-click. A `custom` row never closes the menu, so
  // the toggle can be flipped and watched against the live draft behind it.
  // Home: the ⋯ overflow menu, directly under the drawing-style picker — the two
  // draft-appearance preferences travel together.
  const draftOutlineRow = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px" }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Outline area while drawing</span>
      <button type="button" aria-pressed={draftOutline} onClick={() => setDraftOutline(!draftOutline)}
        title="Draw Area / Deduct / Zone as an open outline (no fill) while tracing — it still commits closed on Enter or double-click."
        style={{ padding: "4px 12px", cursor: "pointer", fontSize: 11.5, fontWeight: 600, border: `1px solid ${draftOutline ? "var(--cobalt)" : "var(--ink-faint)"}`, background: draftOutline ? "var(--cobalt)" : "transparent", color: draftOutline ? "var(--paper-bright)" : "var(--ink)" }}>
        {draftOutline ? "On" : "Off"}
      </button>
    </div>
  );

  // ?hatchqa — density-tuning wall: every pattern at three scales in two palette
  // colors, real components, dark-aware. Unreachable from the UI; kept for retunes.
  // Added 2026-07-07 (d02032a) and lost, not removed, in the fork merge 1317d07
  // (PR #26, 2026-07-13) — FEATURES.md has advertised it the whole time.
  if (new URLSearchParams(window.location.search).has("hatchqa")) {
    const qaColors = [PALETTE[0], PALETTE[2]];
    return (
      <div style={{ padding: 20, background: darkMode ? "#14120e" : "var(--paper-bright)", minHeight: "100vh", overflow: "auto" }}>
        <button onClick={() => setDarkMode((v) => !v)} style={{ marginBottom: 14, padding: "4px 12px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>☾ toggle dark</button>
        {HATCHES.map((h) => (
          <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
            <span style={{ width: 120, fontFamily: "var(--f-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: darkMode ? "#c9c2b2" : "var(--ink-muted)" }}>{h.label}</span>
            {qaColors.map((col) => (
              <svg key={col} width={392} height={64} style={{ border: "1px solid var(--ink-faint)", background: darkMode ? "#1c1914" : "#fff" }}>
                <defs>
                  <HatchPattern id={`qa-${h.id}-${col.slice(1)}`} type={h.id} line={col} fill={col} dark={darkMode} />
                </defs>
                {[[0.5, 0], [1, 132], [3, 264]].map(([sc, x]) => (
                  <g key={sc} transform={`translate(${x},0) scale(${sc})`}>
                    <rect width={128 / sc} height={64 / sc} fill={`url(#qa-${h.id}-${col.slice(1)})`} />
                  </g>
                ))}
              </svg>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    // .app-shell: the print stylesheet collapses this 100vh flex column while the report is open
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files); }}
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* file inputs — always mounted (drag-drop and the ⋯ import path need
          the refs even while focus mode hides the bar) */}
      <input name="sheet-file" ref={fileInputRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed,.otk" multiple style={{ display: "none" }}
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
      <input name="profile-import" ref={profileInputRef} type="file" accept=".otprofile,application/json" style={{ display: "none" }}
        onChange={(e) => { importProfileFile(e.target.files?.[0]); e.target.value = ""; }} />
      <input name="takeoff-import" ref={importInputRef} type="file" accept=".json,application/json" style={{ display: "none" }}
        onChange={(e) => { importTakeoffFile(e.target.files?.[0]); e.target.value = ""; }} />
      {/* THE top bar — one row (the two decks of issue #61 merged once the
          tool rail absorbed the draw menus). Project verbs left, work verbs
          center, Report + the ⋯ overflow (guide, appearance — chrome theme and
          drawing style —, schedule import, cloud moves) right. Cluster captions stay — they're the drafting
          language. The row never wraps; rarely-used controls live in ⋯ so
          nothing shifts position mid-work. Focus mode (F) hides the whole
          bar — the rail and status bar carry the essentials.
          Un-wrapped is not the same as unreachable, though: this row is
          ~1550px of fixed-width controls, so on a 1440-class laptop Report and
          the Action menu render past the right edge. The document can
          technically scroll to them, but the canvas claims wheel and trackpad
          gestures for zoom/pan, so that scroll never arrives and the app reads
          as "Export is unclickable". The row therefore SCROLLS itself; its
          menus open position:fixed off the trigger rect (ToolMenu) so this
          overflow cannot clip them. */}
      {!focusMode && (
      <div style={{ display: "flex", gap: 7, alignItems: "center", padding: "16px 14px 6px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", whiteSpace: "nowrap", overflowX: "auto", overflowY: "visible", scrollbarWidth: "thin", overscrollBehaviorX: "contain" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--ink)", letterSpacing: "-0.02em" }}>open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span></strong>
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
              face={<span style={{ display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sheetChipLabel}</span>}
              faceStyle={{ fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 400, padding: "6px 8px" }}
              menuStyle={{ minWidth: 260, maxHeight: "min(480px, 60vh)", overflowY: "auto" }}
              items={sheetMenuItems}
            />
            <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={!!sheetGroup.length || page >= pageCount} title="Next sheet"
              style={{ padding: "5px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", opacity: (!!sheetGroup.length || page >= pageCount) ? 0.4 : 1 }}><Icon name="chevronRight" size={12} /></button>
          </span>
        )}
        {vRule}
        {cluster("Edit", <>
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
              { id: "tidy", label: "Tidy shape", disabled: !selectedId, onSelect: tidySelected },
              "divider",
              { id: "finish", icon: "check", label: `Finish shape${poly.length ? ` (${poly.length} pts)` : ""}`, shortcut: "↵", disabled: !finishOk, onSelect: finishShape },
              { id: "undopt", icon: "undo", label: "Undo last point", shortcut: "⌘Z", disabled: !poly.length, onSelect: dropLastPoint },
              { id: "undoshape", icon: "undo", label: "Undo last shape", disabled: !visibleShapes.length, onSelect: undoLast },
              { id: "redo", label: "Redo", shortcut: "⇧⌘Z", onSelect: redoShapeCommand },
              "divider",
              { id: "del", icon: "close", label: "Delete selected", shortcut: "⌫", disabled: !selectedId, tint: "var(--c-danger)", onSelect: deleteSelected },
            ]}
          />
        </>)}
        {vRule}
        {cluster("Aids", <>
          {panels.length === 1 && isStitchKey(panels[0].key) && (
            <button onClick={() => setTool((t) => (t === "stitch-align" ? "select" : "stitch-align"))}
              title="Align the match line — click a point near the joint, then the SAME point where the other sheet draws it; that sheet slides so the two coincide. Do this before tracing (a stitch with takeoffs on it won't re-align)."
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: `1px solid ${tool === "stitch-align" ? "var(--cobalt)" : "var(--ink-faint)"}`, background: tool === "stitch-align" ? "var(--cobalt)" : "transparent", color: tool === "stitch-align" ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}>
              <Icon name="calibrate" size={15} />Align
            </button>
          )}
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
        {/* Typed voice command (RFC #59 slice 2): the same grammar push-to-talk
            will feed — a keyboard command line meanwhile, and the accessibility
            path. Focus suppresses canvas shortcuts via the existing INPUT guards.
            Deixis: focus marks the utterance's start — "this room" then needs an
            aim placed AFTER it (park the pointer on the room, type, Enter). */}
        {cluster("Command",
          <input
            type="text"
            placeholder="cpt 1 · waste 7 · this room"
            title={'Command line (RFC #59): a condition tag ("CPT-1", "carpet one", "tile 2 waste 5"), "waste 7", "label Phase 1", "clear label", "author <your name>" (new marks sign it — the report can group by author), or "note …" — Enter runs it through the same actions the buttons use. End with "this room" / "here" while the pointer rests on a room to trace and commit it there ("carpet one, this room"). Push-to-talk dictation will feed this box.'}
            onFocus={() => { voiceAimMarkRef.current = aimSeqRef.current; }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = e.currentTarget.value.trim();
              if (!v) return;
              const el = e.currentTarget;   // capture: currentTarget nulls after dispatch, and deixis outcomes can resolve async (raster)
              // router confirm (RFC #59 slice 5): the rejected text is still in
              // the box (only success clears it) — a second ⏎ on the SAME text
              // confirms the pending offer instead of re-rejecting in a loop
              if (pendingAgentOfferRef.current && v === pendingAgentOfferRef.current.transcript) {
                agentOfferFnsRef.current.confirm();
                el.value = "";
                return;
              }
              Promise.resolve(onVoiceCommand(v)).then((ok) => { if (ok) el.value = ""; });
            }}
            style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", width: 150 }}
          />
        )}
        {/* Push-to-talk (RFC #59 recognizer): hold the button (or M) to dictate
            into the same grammar the Command box runs. Hidden entirely where
            capture is unsupported — graceful feature-absence, never broken. */}
        {captureSupported() && cluster("Voice",
          <button
            title={'Hold to talk (or hold M anywhere on the canvas): speak a command — "carpet one, waste seven", "label phase two", "note …", or end with "this room" to trace at the cursor. Release to run; Esc discards. Audio is processed on-device and never leaves the browser.'}
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); voiceHoldRef.current = true; voiceFnsRef.current.start(); }}
            onPointerUp={() => { if (voiceHoldRef.current) { voiceHoldRef.current = false; voiceFnsRef.current.end(true); } }}
            onPointerCancel={() => { if (voiceHoldRef.current) { voiceHoldRef.current = false; voiceFnsRef.current.end(false); } }}
            style={{ padding: "5px 10px", border: `1px solid ${voiceChip?.tone === "live" ? "var(--cobalt)" : "var(--ink-faint)"}`, background: voiceChip?.tone === "live" ? "var(--cobalt)" : "transparent", color: voiceChip?.tone === "live" ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 700, lineHeight: 1 }}>
            {voiceChip?.tone === "live" ? "● talking" : "talk · M"}
          </button>
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
            {markupDraft && (tool === "cloud" || tool === "callout" || tool === "highlight" || tool === "dimension") && <span style={{ fontSize: 11, color: "var(--cobalt)" }}>click the {tool === "callout" ? "label spot" : tool === "dimension" ? "other end" : "opposite corner"}…</span>}
            {finishOk && (
              <button onClick={finishShape} title="Finish shape (↵ or double-click)" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Finish ({poly.length})</button>
            )}
            {proposal?.regions.length > 0 && (
              <button onClick={createProposal} title="Create the selected takeoff(s) (↵). ⌫ removes the last click; Esc discards the selection." style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "none", background: "var(--c-positive)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, lineHeight: 1 }}><Icon name="check" size={14} />Create ({proposal.regions.length})</button>
            )}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowReport(true)} disabled={!conditions.length} title="Open the takeoff report — per-condition breakdown with waste, plus CSV / JSON export."
          style={{ padding: "8px 14px", border: "none", background: conditions.length ? "var(--ink)" : "var(--text-faint)", color: "var(--paper-bright)", cursor: conditions.length ? "pointer" : "default", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" }}>Report</button>
        {/* ⋯ overflow — rarely-used project controls, so the row never wraps
            and nothing shifts position mid-work (issue #61's contract). */}
        <ToolMenu
          title="More — guide, appearance, schedule import, project moves"
          onOpenChange={onMenuDepth}
          face={<span style={{ fontWeight: 700, letterSpacing: "0.08em" }}>⋯</span>}
          items={[
            { id: "guide", label: "How OpenTakeoff works", shortcut: "?", onSelect: () => setGuideOpen(true) },
            { id: "theme", label: theme === "dark" ? "Light chrome" : "Dark chrome", onSelect: toggleTheme },
            { section: "Drawing style" },
            { id: "drawstyle", custom: drawStyleRow },
            { id: "draftoutline", custom: draftOutlineRow },
            "divider",
            { id: "schedule", icon: "rectTool", label: "Import from schedule", active: tool === "schedule", onSelect: () => { setScheduleAnchor(null); setTool((t) => (t === "schedule" ? "select" : "schedule")); } },
            ...(cloudMode ? [
              "divider",
              { id: "closeproj", label: "Close project", onSelect: closeProject },
              ...(browseProjects ? [{ id: "projects", label: "Team projects", onSelect: browseProjects }] : []),
            ] : []),
            ...(!cloudMode && googleUser && isGoogleConfigured() && projectHomeFolderId() ? [
              "divider",
              { id: "browse", label: "Browse team projects", onSelect: () => navigate("/projects") },
            ] : []),
          ]}
        />
        <PresenceChip bridge={store.syncBridge} />
        <AccountChip note={cloudMode ? "Synced to Google Drive" : "Local workspace"} onOpenChange={onMenuDepth} />
      </div>
      )}

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
      {!focusMode && conditions.length > 0 && (
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
              <ConditionAppearanceEditor cond={aCond} onUpdateCond={updateCond} onSetCondParam={setCondParam} onAssignAttr={assignAttr} conditionColumns={conditionColumns} layout="row" units={units} />
            </div>
          )}
        </div>
      )}

      {/* open-sheet tabs — what you opened from the gallery; click to view,
          ⊞ to side-by-side, ✕ to close; the dropdown lists every open sheet */}
      {!focusMode && openTabs.length > 0 && (
        <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "5px 14px", flexWrap: openTabs.length > MANY_TABS ? "nowrap" : "wrap", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", minWidth: 0 }}>
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--ink-muted)", flexShrink: 0 }}>Sheets</span>
          {openTabs.length > MANY_TABS && (
            <button type="button" onClick={() => scrollTabStrip(-1)} title="Scroll sheets left" aria-label="Scroll sheets left" style={{ flexShrink: 0, padding: "4px 5px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", display: "inline-flex" }}><Icon name="chevronLeft" size={12} /></button>
          )}
          <div ref={tabStripRef} data-sheet-tab-strip style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: openTabs.length > MANY_TABS ? "nowrap" : "wrap", overflowX: openTabs.length > MANY_TABS ? "auto" : "visible", minWidth: 0, flex: openTabs.length > MANY_TABS ? 1 : "0 1 auto", scrollbarWidth: "none", overscrollBehaviorX: "contain" }}>
          {openTabs.map((k) => {
            const inGroup = sheetGroup.includes(k);
            const on = sheetGroup.length ? inGroup : k === sheetKey;
            const lbl = tabLabel(k);
            return (
              <span key={k} data-sheet-tab={on ? "active" : "idle"} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, border: "1px solid var(--ink-faint)", borderBottom: on ? "2px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: on ? "var(--paper-cream)" : "transparent", padding: "3px 6px 2px 9px", maxWidth: 190 }}>
                <button onClick={() => goToSheet(k)} title={k} style={{ border: "none", background: "none", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 11.5, color: "var(--ink)", fontFamily: "var(--f-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140, padding: 0 }}>{lbl}</button>
                <button onClick={() => toggleInGroup(k)} title={inGroup ? "Remove from side-by-side" : "Side-by-side with the current sheet"} style={{ border: "none", background: "none", cursor: "pointer", color: inGroup ? "var(--cobalt)" : "var(--ink-faint)", padding: 0, display: "inline-flex" }}><Icon name="sideBySide" size={11} /></button>
                <button onClick={() => closeTab(k)} title="Close tab" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, display: "inline-flex" }}><Icon name="close" size={10} /></button>
              </span>
            );
          })}
          </div>
          {openTabs.length > MANY_TABS && (
            <button type="button" onClick={() => scrollTabStrip(1)} title="Scroll sheets right" aria-label="Scroll sheets right" style={{ flexShrink: 0, padding: "4px 5px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", display: "inline-flex" }}><Icon name="chevronRight" size={12} /></button>
          )}
          {openTabs.length > 1 && openTabs.length <= MANY_TABS && (
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
      {!focusMode && panelPrefs.strip && (
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
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, position: "relative" /* anchors the narrow-screen panel overlay */ }}>
       {/* tool rail — machined faces grouped by MCP module (the concept shell).
           Individual tiles replace deck 2's Measure/Cut Out menus; Markup keeps
           its variety flyout on one tile (five markup kinds don't earn five
           faces). Lives in the canvas row so docked panels + canvas reflow
           beside it; survives focus mode — it IS the tool access. */}
       {view === "canvas" && (
       <nav role="toolbar" aria-label="Tools" style={{ width: "var(--rail-w)", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--sp-1)", paddingTop: "var(--sp-2)", borderRight: "1px solid var(--ink-faint)", background: "var(--paper-bright)", overflowY: "auto", overflowX: "visible" }}>
         {railLabel("SEL")}
         {railTile("select", "select", "Select — pick a takeoff, drag points; drag open canvas to pan", "V")}
         {railLabel("MEAS")}
         {MEASURE_TOOLS.map((t) => railTile(t.id, t.icon, t.label, t.shortcut))}
         {railLabel("CUT")}
         {CUT_TOOLS.map((t) => railTile(t.id, t.icon, t.label, t.shortcut, null, { tint: "var(--c-danger)" }))}
         {railLabel("MARK")}
         <span ref={(el) => { if (el) markTileTopRef.current = el.getBoundingClientRect().top; }} style={{ position: "relative", display: "inline-flex" }}>
           <ToolMenu
             title="Markup — annotations, not measurements"
             active={MARKUP_IDS.includes(tool)}
             onOpenChange={onMenuDepth}
             flyout="right"
             face={<Icon name="markup" size={17} />}
             items={[
               { section: "Markup — notes on the plan, never measured" },
               ...MARKUP_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, shortcut: t.shortcut, active: tool === t.id, onSelect: () => { setTool(t.id); setMarkupDraft(null); } })),
             ]}
           />
           {/* highlighter style popover — fixed beside the rail while armed
               (fixed, not absolute: the rail's scroll box would clip it) */}
           {tool === "highlighter" && (
             <div style={{ position: "fixed", left: "calc(var(--rail-w) + 8px)", top: markTileTopRef.current || 200, zIndex: Z.popover, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "var(--shadow-pop)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
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
         {/* Approval stamp — ink over pencil. Human-only by design: this tile
             is the ONLY way an estimator seal is minted (no MCP tool, no agent
             path), so the mark means a person looked. */}
         {railTile("approve", "approve", "Approval stamp — the estimator's ink. Click a committed takeoff to approve it, or empty plan to approve the sheet; click a seal to lift it. ⌘Z undoes. Human-only.", null,
           () => setTool((t) => (t === "approve" ? "select" : "approve")), { tint: tool === "approve" ? "var(--c-positive)" : undefined, armed: tool === "approve" })}
         {railLabel("CAL")}
         {railTile("calibrate", "calibrate", "Calibrate — click two points of a known dimension", null)}
       </nav>
       )}
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
                 <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
                   {/* hidden input reused by the Upload button — re-encoded through addImageFromFile */}
                   <input name="markup-image-file" ref={imageInputRef} type="file" accept="image/*" style={{ display: "none" }}
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) addImageFromFile(f); e.target.value = ""; }} />
                   <button
                     onClick={() => imageInputRef.current?.click()}
                     title="Upload a raster image (PNG or JPEG) as a floating annotation on the current sheet"
                     style={{ background: "transparent", border: "1px solid var(--ink-faint)", color: "var(--ink)", fontSize: 11, cursor: "pointer", padding: "2px 7px" }}>
                     Upload image…
                   </button>
                   <button
                     onClick={() => { const nv = !showMarkups; setShowMarkups(nv); if (!nv) setSelectedMarkupId(null); }}
                     title={showMarkups ? "Hide the markup layer on the canvas" : "Show the markup layer on the canvas"}
                     style={{ background: "transparent", border: "1px solid var(--ink-faint)", color: "var(--ink)", fontSize: 11, cursor: "pointer", padding: "2px 7px" }}>
                     {showMarkups ? "Hide layer" : "Show layer"}
                   </button>
                 </div>
                 <div style={{ padding: "8px 10px", color: "var(--ink-muted)" }}>
                   Pick <b>☁ Cloud</b>, <b>▨ Highlight</b>, <b>💬 Callout</b>, <b>T Text</b>, or <b>⟷ Dimension</b> above, then click the plan to annotate it. <b>🖼 Image</b> marquees a region (two clicks) — or use <b>Upload image…</b> above.
                 </div>
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).length === 0 && (
                   <div style={{ padding: "4px 12px 14px", color: "var(--ink-muted)" }}>No markups {groupKeys.length > 1 ? "on these sheets" : "on this sheet"} yet.</div>
                 )}
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).map((m) => (
                   <div key={m.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)", background: selectedMarkupId === m.id ? "var(--surface-pop)" : "transparent" }}>
                     {/* the header line selects + flies to the markup (parity with the RFI
                         register's onFlyTo) — the inner controls stopPropagation so only the
                         label area triggers it, never edit/delete. */}
                     <div onClick={() => flyToMarkup(m)} title={m.type === "image" ? imageProvenance(m) : "Select and center this markup"} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                       {m.type === "image" && (() => {
                         const th = ensureThumb(m);
                         return <span style={{ flex: "0 0 auto", width: 30, height: 30, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                           {th ? <img src={th} alt="" style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }} /> : <span style={{ fontSize: 14 }}>🖼</span>}
                         </span>;
                       })()}
                       <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cobalt)", textTransform: "uppercase" }}>{m.type}</span>
                       {/* inline edit — the panel's fallback for the canvas overlay, since a
                           markup here may be off-screen or on another sheet (no click point).
                           Enter/blur commit, Esc cancels; INPUT is guarded from the global keys. */}
                       {panelEditId === m.id ? (
                         <input name="markup-text" autoComplete="off" autoFocus defaultValue={m.text || ""}
                           onClick={(e) => e.stopPropagation()}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); } else if (e.key === "Escape") { e.preventDefault(); e.currentTarget.value = m.text || ""; setPanelEditId(null); } }}
                           onBlur={(e) => { updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); }}
                           style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "1px 4px", border: "1px solid var(--cobalt)", borderRadius: 0, outline: "none" }} />
                       ) : (
                         <span style={{ flex: 1, color: "var(--ink)" }}>{m.type === "svg" ? <em style={{ color: "var(--ink-muted)" }}>(vector symbol)</em> : ([m.type === "dimension" && Number(m.len_ft) > 0 ? dimLabel(m.len_ft) : "", m.text].filter(Boolean).join(" · ") || <em style={{ color: "var(--ink-muted)" }}>(no text)</em>)}</span>
                       )}
                       {m.type === "image" && <button onClick={(e) => { e.stopPropagation(); placeGrabRef.current = null; flyToMarkup(m); setPlacingImageId(m.id); setCommitMsg("Placing image — the view centered on it; move the pointer and click to drop (Esc cancels)."); }} title="Reposition: centers the view on the image, then it follows the cursor — click the sheet to drop it" style={{ border: "1px solid var(--ink-faint)", background: placingImageId === m.id ? "var(--cobalt)" : "transparent", color: placingImageId === m.id ? "#fff" : "var(--cobalt)", cursor: "pointer", fontSize: 11, padding: "1px 7px" }}>Place</button>}
                       {m.type !== "svg" && <button onClick={(e) => { e.stopPropagation(); setPanelEditId((id) => (id === m.id ? null : m.id)); }} title="Edit text" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)" }}>✎</button>}
                       <button onClick={(e) => { e.stopPropagation(); deleteMarkup(m.id); }} title="Delete markup" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)" }}>🗑</button>
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
                     {/* Condition link — which scope this annotation is ABOUT.
                         Same one-to-many shape as the RFI link below it. */}
                     {(() => {
                       const lc = m.condition_id ? condById[m.condition_id] : null;
                       const ctrl = { padding: "2px 7px", border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 };
                       return (
                         <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                           {lc ? (
                             <>
                               <span title={`Annotation is about ${lc.finish_tag}`}
                                 style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 700 }}>
                                 <span style={{ width: 9, height: 9, background: lc.color, border: "1px solid var(--ink-faint)" }} />
                                 {lc.finish_tag}
                               </span>
                               <button onClick={() => { setActiveCond(lc.id); }} style={{ ...ctrl, color: "var(--cobalt)" }} title="Make this the active condition">Select</button>
                               <button onClick={() => unlinkCondition(m)} style={{ ...ctrl, color: "var(--ink-muted)" }} title="Detach this annotation from its condition">Detach</button>
                             </>
                           ) : conditions.length > 0 && (
                             <select name="link-condition" value="" onChange={(e) => { if (e.target.value) linkCondition(m, e.target.value); }}
                               title="Attach this annotation to a condition" style={{ ...ctrl, background: "var(--paper-bright)", maxWidth: 170 }}>
                               <option value="">Attach to condition…</option>
                               {conditions.map((c) => <option key={c.id} value={c.id}>{c.finish_tag}</option>)}
                             </select>
                           )}
                         </div>
                       );
                     })()}
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
          onPointerCancel={onPointerUp} onPointerLeave={leaveCanvas} onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={(e) => { if (tool === "oneclick") { if (proposal?.regions.length) createProposal(); } else if (tool === "area" || tool === "deduct" || tool === "linear" || tool === "surface" || tool === "zone") finishShape(); else if (tool === "select") editMarkupAt(e); }}
          style={{ position: "absolute", inset: 0, background: darkMode ? "#0b0e14" : "var(--paper-cream)", cursor: tool === "select" ? "default" : "none", touchAction: "none" }}>
          {/* aim crosshair (draw modes): the OS cursor is hidden on the canvas — the
              crosshair IS the cursor. Two crisp full-page hairlines riding the
              EFFECTIVE point (angle-locked / endpoint-snapped), the SPLINE STAR at
              the crossing, and a small readout chip in the house style. The 45°
              lock reads as a quiet state change (hairlines brighten, star swells
              cobalt, rubber band thickens) — no extra chrome on the sheet. All
              positioned imperatively in moveCrosshair. */}
          {DS.crosshair !== "none" && (<>
            <div ref={crossVRef} style={{ position: "absolute", top: 0, bottom: 0, width: 1.5, background: DS._hairline, boxShadow: DS._hairlineLock.boxShadowBase, pointerEvents: "none", display: "none", zIndex: 5 }} />
            <div ref={crossHRef} style={{ position: "absolute", left: 0, right: 0, height: 1.5, background: DS._hairline, boxShadow: DS._hairlineLock.boxShadowBase, pointerEvents: "none", display: "none", zIndex: 5 }} />
          </>)}
          <div ref={aimMarkRef} style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none", display: "none", zIndex: 6, willChange: "transform" }}>
            {/* the aim mark at the crossing — the theme's cursor glyph; it swells
                and glows while the 45° lock holds (drafting: the house star) */}
            <svg width={22} height={22} viewBox="0 0 22 22" style={{ position: "absolute", left: -11, top: -11, transition: "transform 120ms ease, filter 120ms ease", filter: "drop-shadow(0 1px 2px rgba(14,26,46,.3))" }}>
              {DS.aimMark === "ring"
                ? <circle cx={11} cy={11} r={6.5} fill="none" stroke={DS.aimMarkColor} strokeWidth={1.6} />
                : <path d={markerPath(DS.aimMark, 11, 11, DS.aimMark === "star" ? 8.5 : 6)} fill={DS.aimMarkColor} stroke="#fff" strokeWidth={1.4} />}
            </svg>
          </div>
          <div ref={aimChipRef} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", display: "none", zIndex: 6, padding: "2px 8px", background: DS.chip.bg, border: `1px solid ${DS.chip.border}`, boxShadow: "var(--shadow-1)", fontFamily: DS.chip.font === "mono" ? "var(--f-mono)" : "var(--f-body)", fontSize: 10.5, fontWeight: 600, color: DS.chip.fg, whiteSpace: "nowrap", willChange: "transform" }} />
          {/* hover readout — what takeoff is under the cursor (DOM-direct) */}
          <div ref={hoverRef} style={{ position: "absolute", display: "none", pointerEvents: "none", zIndex: 8, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-1)", padding: "4px 8px", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)", whiteSpace: "nowrap" }} />
          {/* edge-insert ghost — the "+" that rides the selected shape's edge under
              the cursor; pressing there inserts a vertex at that exact spot */}
          <div ref={insGhostRef} style={{ position: "absolute", display: "none", pointerEvents: "none", zIndex: 8, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "#1f3fc7", border: "1.5px solid #fff", boxShadow: "var(--shadow-1)", color: "#fff", fontFamily: "var(--f-mono)", fontSize: 12, lineHeight: 1 }}>+</div>
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
          {/* No permanent will-change here: the stage is compositor-promoted only
              for the duration of a gesture (promoteStage / syncTilePanels demote).
              A permanent promotion froze the layer's raster scale and pixelated
              every drawn boundary after a zoom-in. */}
          <div ref={stageRef} style={{ position: "absolute", transformOrigin: "0 0", width: stage.w || undefined, height: stage.h || undefined }}>
            {/* base layer — a small, bounded coarse pyramid placeholder CSS-stretched
                to the panel's full logical footprint (see tileCompositor.ts's
                paintBase); the backing store is NOT sheet-sized, only its CSS box is,
                which is what keeps this a bounded canvas regardless of sheet size */}
            {drawPanels.filter((d) => !d.clip).map((d) => (
              <canvas key={d.drawKey} ref={(el) => { if (el) panelCanvasRefs.current.set(d.drawKey, el); else panelCanvasRefs.current.delete(d.drawKey); }}
                style={{ position: "absolute", left: d.x, top: d.y, width: d.w || undefined, height: d.h || undefined, boxShadow: "0 2px 20px rgba(0,0,0,.18)" }} />
            ))}
            {/* detail layer — one PER SOURCE, a crop of the visible region + margin
                composited from cached tiles at the current zoom (see the detail-view
                effect); group mode no longer shares a single global detail canvas */}
            {drawPanels.filter((d) => !d.clip).map((d) => (
              <canvas key={`detail-${d.drawKey}`} ref={(el) => { if (el) detailCanvasRefs.current.set(d.drawKey, el); else detailCanvasRefs.current.delete(d.drawKey); }}
                style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none" }} />
            ))}
            {/* stitch members (#161): base + detail together inside a seam-clip
                wrapper — the div does ALL clipping (overflow:hidden at the member's
                visible box), so the neighbor's margin/border strip near the match
                line can't overpaint the plan. The shadow rides the wrapper: the
                composite reads as one sheet of paper, not N taped panels. */}
            {drawPanels.filter((d) => d.clip).map((d) => (
              <div key={`wrap-${d.drawKey}`} style={{ position: "absolute", left: d.clip.x, top: d.clip.y, width: d.clip.w, height: d.clip.h, overflow: "hidden", boxShadow: "0 2px 20px rgba(0,0,0,.18)" }}>
                <canvas ref={(el) => { if (el) panelCanvasRefs.current.set(d.drawKey, el); else panelCanvasRefs.current.delete(d.drawKey); }}
                  style={{ position: "absolute", left: d.x - d.clip.x, top: d.y - d.clip.y, width: d.w || undefined, height: d.h || undefined }} />
                <canvas ref={(el) => { if (el) detailCanvasRefs.current.set(d.drawKey, el); else detailCanvasRefs.current.delete(d.drawKey); }}
                  style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none" }} />
              </div>
            ))}
            <svg width={stage.w} height={stage.h} viewBox={`0 0 ${stage.w} ${stage.h}`} style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}>
              <defs>
                {conditions.map((c) => <HatchPattern key={patId(c)} id={patId(c)} type={c.hatch || "solid"} line={c.color} fill={c.fill} dark={darkMode} />)}
              </defs>
              {/* committed shapes + markups, one group per panel in its local frame */}
              {panels.map((p) => {
                const pShapes = stackedShapes.filter((s) => s.sheet_id === p.key);
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
                      const sw = (sel ? DS.selection.width : 2) / z;
                      // Committed-but-unreviewed machine shapes (an imported MCP
                      // takeoff) render dashed pencil — same invariant as the
                      // ephemeral agent proposals, until Accept flips reviewed.
                      const pending = s.origin?.reviewed === false;
                      const pDash = `${4 / z} ${3 / z}`;
                      if (s.measure_role === "count") {
                        const [cx, cy] = pts[0], r = 7 / z;
                        return <rect key={s.id} x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2 / z} fill={col + (pending ? "55" : "cc")} stroke={sel ? DS.selection.color : "#fff"} strokeWidth={(sel ? 3 : 1.5) / z} strokeDasharray={pending ? `${3 / z} ${2.5 / z}` : undefined} />;
                      }
                      if (s.measure_role === "surface_area") {
                        return <polyline key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? DS.selection.color : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={(sel ? 4.5 : 3.5) / z} strokeDasharray={pending ? pDash : `${10 / z} ${3 / z} ${2 / z} ${3 / z}`} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      if (s.measure_role === "linear") {
                        // line_style governs linear outlines (surface_area keeps its dash-dot identity above)
                        const lpts = s.curved ? flattenCurve(pts) : pts;
                        return <polyline key={s.id} points={lpts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? DS.selection.color : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={(sel ? 4 : 3) / z} strokeDasharray={pending ? pDash : dashArrayFor(cond?.line_style || "solid", z)} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      const ded = s.measure_role === "deduct";
                      // #137 — a RECONCILED deduct (cuts_shape_id) renders as a
                      // dashed outline only: its geometry is already excised
                      // from its parent's fill below (fill-rule evenodd), so a
                      // solid overlay here would reintroduce the exact
                      // "decal on top" bug the real subtract fixes.
                      if (ded && s.cuts_shape_id) {
                        return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? DS.selection.color : "#b03a26"} strokeWidth={(sel ? 3 : 1.5) / z} strokeDasharray={`${5 / z} ${3 / z}`} />;
                      }
                      // #137 — a parent carrying real hole ring(s): ONE compound
                      // path, outer ring + every hole ring, fill-rule evenodd so
                      // the hole is an actual excision from the fill rather than
                      // a shape sitting on top of it.
                      if (!ded && s.verts_norm_holes?.length) {
                        const ringD = (ring) => `M${dn(ring).map((q) => q.join(",")).join("L")}Z`;
                        const d = ringD(s.verts_norm) + s.verts_norm_holes.map(ringD).join("");
                        return <path key={s.id} d={d} fillRule="evenodd" fill={pending ? col + "14" : shapeFill(cond)} stroke={sel ? DS.selection.color : col} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw} strokeDasharray={pending ? pDash : dashArrayFor(cond?.line_style || "solid", z)} />;
                      }
                      // deduct keeps its danger-red dashing (a safety signal, wins over line_style); positive floor_area follows the condition's line_style
                      return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")}
                        fill={ded ? (pending ? "rgba(176,58,38,.10)" : "rgba(176,58,38,.28)") : pending ? col + "14" : shapeFill(cond)}
                        stroke={ded ? "#b03a26" : (sel ? DS.selection.color : col)} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw}
                        strokeDasharray={pending ? pDash : ded ? `${6 / z} ${4 / z}` : dashArrayFor(cond?.line_style || "solid", z)} />;
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
                              transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke={DS.selection.color} strokeWidth={1.6 / s} />;
                          })}
                          {/* corner handles — click selects (Delete removes just that point), drag moves.
                              The theme's handle glyph (drafting: paper-filled diamond); a "hollow" theme
                              draws the mark unfilled, the selection color as its outline. */}
                          {qs.map(([x, y], i) => {
                            const isSel = selVert === i;
                            const sz = (isSel ? 6.5 : 5.5) / s;
                            const hollow = DS.selection.handleFill === "hollow";
                            return <g key={"h" + i}>
                              {isSel && <circle cx={x} cy={y} r={9 / s} fill="none" stroke={DS.selection.color} strokeWidth={1.2 / s} opacity={0.5} />}
                              <path d={markerPath(DS.selection.handleShape, x, y, sz)}
                                fill={hollow ? "none" : (isSel ? grip : DS.selection.color)} stroke={hollow ? DS.selection.color : (isSel ? DS.selection.color : "#fff")} strokeWidth={(isSel ? 2 : 1.4) / s} />
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
                      // three draw tiers that MATCH the three hit tiers (selectAt),
                      // so on-screen z-order never contradicts selection priority:
                      // image at the back (0), highlight (1), everything else on top
                      // (2). Painting is document order, so tier 0 draws first/behind
                      // and tier 2 last/on top; hit-test ranks them in reverse, so the
                      // topmost-drawn markup is the one a click selects.
                      .slice().sort((a, b) => (a.type === "image" ? 0 : a.type === "highlight" ? 1 : 2) - (b.type === "image" ? 0 : b.type === "highlight" ? 1 : 2))
                      .map((m) => {
                      const z = tf.scale;
                      // Colour precedence: an explicit per-markup colour always
                      // wins (the user picked it), then the LINKED CONDITION's
                      // colour so an annotation reads as part of that scope at a
                      // glance, then RFI blue, then the unattached default.
                      const mCond = m.condition_id ? condById[m.condition_id] : null;
                      const base = m.color || mCond?.color || (m.rfi_id ? "#1f3fc7" : "#c47a10");
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
                      if (m.type === "dimension" && m.from && m.to) {
                        // a dimension line: perpendicular ticks at both ends and the
                        // measured length (m.len_ft, snapshotted at annotate time from
                        // the sheet scale) centered beside the line — a note ABOUT a
                        // distance, never a takeoff quantity
                        const [fx, fy] = [m.from[0] * p.img.w, m.from[1] * p.img.h];
                        const [tx, ty] = [m.to[0] * p.img.w, m.to[1] * p.img.h];
                        const dl = Math.hypot(tx - fx, ty - fy) || 1;
                        const dnx = -(ty - fy) / dl, dny = (tx - fx) / dl;   // unit normal
                        const tick = 7 / z;
                        const dimText = [Number(m.len_ft) > 0 ? dimLabel(m.len_ft) : "", m.text].filter(Boolean).join(" · ");
                        const hx0 = Math.min(fx, tx), hy0 = Math.min(fy, ty), hx1 = Math.max(fx, tx), hy1 = Math.max(fy, ty);
                        const pad = (6 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
                            <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            <line x1={fx - dnx * tick} y1={fy - dny * tick} x2={fx + dnx * tick} y2={fy + dny * tick} stroke={mk} strokeWidth={(2 * w) / z} />
                            <line x1={tx - dnx * tick} y1={ty - dny * tick} x2={tx + dnx * tick} y2={ty + dny * tick} stroke={mk} strokeWidth={(2 * w) / z} />
                            {dimText && <text x={(fx + tx) / 2 + dnx * (11 / z)} y={(fy + ty) / 2 + dny * (11 / z)} fill={mk} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{dimText}</text>}
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
                      if (m.type === "image") {
                        // a raster image markup (screenshot capture or upload). Width-anchored
                        // like svg but off `m.w` alone (imagePlacedBox), rendered as-is (no
                        // dark-mode invert — a screenshot is captured from the light PDF).
                        // Self-contained: a guard-fail returns null, never falling through to
                        // the text renderer below (which would paint a phantom note box).
                        const { bw, bh } = imagePlacedBox(m.w, m.aspect, p.img.w);
                        // only a PNG/JPEG DATA url renders (matches the marked-set
                        // export invariant) — an imported record with an http(s)://
                        // src must never make <image href> fetch remote content.
                        if (!(m.src && pickEmbedFormat(m.src) && Array.isArray(m.at) && bw > 0 && bh > 0)) return null;
                        const x0 = m.at[0] * p.img.w - bw / 2, y0 = m.at[1] * p.img.h - bh / 2;
                        return (
                          <g key={m.id}>
                            {halo(x0, y0, x0 + bw, y0 + bh)}
                            <image href={m.src} x={x0} y={y0} width={bw} height={bh} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />
                            {/* PERMANENT frame — a placed screenshot overlays its own source and is
                                invisible without it; the halo is selection-only. White + slate double
                                stroke reads on both canvas themes (the image itself is never inverted). */}
                            <rect x={x0} y={y0} width={bw} height={bh} fill="none" stroke="#fff" strokeWidth={2.5 / z} style={{ pointerEvents: "none" }} />
                            <rect x={x0} y={y0} width={bw} height={bh} fill="none" stroke="#2a3550" strokeWidth={1 / z} style={{ pointerEvents: "none" }} />
                            {selM && <rect x={x0 + bw - 4 / z} y={y0 + bh - 4 / z} width={8 / z} height={8 / z} fill="#1f3fc7" stroke="#fff" strokeWidth={1.5 / z} style={{ pointerEvents: "none" }} />}
                            {badge(x0, y0 - 9 / z)}
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
                    {/* approval seals — ink over pencil (lib/approvals.js): the
                        estimator's APPROVED ring, the agent's AGENT diamond. Its
                        own layer above markups and NOT gated on showMarkups — a
                        seal is the record of review, so it never hides with the
                        annotations. Sizes are sheet-normalized (the bubble
                        convention) so seals print proportionally; inks are token
                        literals via approvalInk (SVG attrs don't resolve CSS vars). */}
                    {approvals.filter((a) => a.sheet_id === p.key).map((a) => {
                      const cx = a.at[0] * p.img.w, cy = a.at[1] * p.img.h;
                      const rad = APPROVAL_R * p.img.w;
                      const ink = approvalInk(a.actor, darkMode);
                      const backing = darkMode ? "rgba(12,15,20,.72)" : "rgba(255,255,255,.72)";
                      if (a.actor === "agent") {
                        const dia = (k) => `M${cx},${cy - rad * k} L${cx + rad * k},${cy} L${cx},${cy + rad * k} L${cx - rad * k},${cy} Z`;
                        return (
                          <g key={a.id} style={{ pointerEvents: "none" }}>
                            <path d={dia(1)} fill={backing} stroke={ink} strokeWidth={rad * 0.07} strokeLinejoin="round" />
                            <path d={dia(0.72)} fill="none" stroke={ink} strokeWidth={rad * 0.035} strokeLinejoin="round" />
                            <text x={cx} y={cy} fill={ink} fontSize={rad * 0.3} fontWeight="700" letterSpacing={rad * 0.02} textAnchor="middle" dominantBaseline="central">AGENT</text>
                          </g>
                        );
                      }
                      return (
                        <g key={a.id} style={{ pointerEvents: "none" }}>
                          <circle cx={cx} cy={cy} r={rad} fill={backing} stroke={ink} strokeWidth={rad * 0.07} />
                          <circle cx={cx} cy={cy} r={rad * 0.78} fill="none" stroke={ink} strokeWidth={rad * 0.035} />
                          <text x={cx} y={cy} fill={ink} fontSize={rad * 0.26} fontWeight="700" letterSpacing={rad * 0.03} textAnchor="middle" dominantBaseline="central">APPROVED</text>
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
                      const clickable = tool === "select";
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
                    {/* staged rule-propagation candidates (#88): dashed danger
                        pencil until Apply — the same review-before-ink contract
                        as agent proposals. Non-interactive on the canvas; the
                        banner owns Apply/Cancel (ONE decision for the batch,
                        matching the one-command undo). */}
                    {ruleStage && ruleStage.candidates.filter((c) => c.sheet_id === p.key).map((c, i) => {
                      const s = tf.scale;
                      const pts = c.verts_norm.map(([x, y]) => [x * p.img.w, y * p.img.h]);
                      return (
                        <g key={`rulecand-${i}`} style={{ pointerEvents: "none" }}>
                          <title>{`Rule candidate — −${fa(c.area_sf)} deduct. ${ruleStage.rule.label}.`}</title>
                          <polygon points={pts.map((q) => q.join(",")).join(" ")}
                            fill="rgba(176,58,38,.10)" stroke="#b03a26" strokeOpacity={0.9}
                            strokeWidth={2 / s} strokeDasharray={`${3.5 / s} ${3.5 / s}`} strokeLinejoin="round" />
                        </g>
                      );
                    })}
                    {/* Roll-goods cut overlay (#136) — every figured cut drawn to
                        scale over its room in the MATERIAL-TRUE color (carpet tan,
                        vinyl/rubber grey — the engine's own palette, so cuts never
                        mimic a condition's takeoff look), numbered in cutting
                        order, dashed when the room seams across lanes. Inert
                        drawing until edit mode; then each cut owns its pointer
                        events — body slides along the lane, the two end handles
                        pull the run ends, double-click resets to the figured
                        layout. Adjacent cuts overlapping IS the seam (physical
                        pieces carry the seam allowance). */}
                    {rollShow && (rollCutsByPanel.get(p.key) || []).map((ct) => {
                      const s = tf.scale;
                      const col = rollColorForType(ct.material);
                      const runY = ct.laneAxis === "x";     // strips run along screen y; lanes tile across x
                      const hs = 5 / s;
                      const showNum = ct.w * s > 16 && ct.h * s > 16;
                      const strokeCol = ct.overRoll ? "#b03a26" : col;
                      return (
                        <g key={"roll" + ct.id}
                          style={{ pointerEvents: rollEdit ? "auto" : "none", cursor: rollEdit ? "grab" : undefined }}
                          onPointerDown={(e) => beginRollCut(e, ct, "body")}
                          onPointerMove={moveRollCut} onPointerUp={endRollCut} onPointerCancel={endRollCut}
                          onDoubleClick={() => rollEdit && resetRollCut(ct)}>
                          <title>{`Cut ${ct.num} — ${condById[ct.condId]?.finish_tag || "?"}: ${fmtCheckLen(ct.lenFt, units)} × ${fmtCheckLen(ct.widthFt, units)}${ct.multi ? ` · lane ${ct.laneIndex + 1}/${ct.laneCount}` : ""}${ct.overRoll ? " · LONGER THAN ONE ROLL — needs a cross-seam" : ""}${rollEdit ? " · drag to slide, pull the square handles to resize, double-click to reset" : ""}`}</title>
                          <rect x={ct.x} y={ct.y} width={ct.w} height={ct.h}
                            fill={col + "38"} stroke={strokeCol}
                            strokeWidth={(ct.overRoll ? 2.6 : 1.8) / s}
                            strokeDasharray={ct.multi ? `${6 / s} ${4 / s}` : undefined} />
                          {showNum && (
                            <g style={{ pointerEvents: "none" }}>
                              <circle cx={ct.x + 11 / s} cy={ct.y + 11 / s} r={7.5 / s} fill={strokeCol} stroke="#fff" strokeWidth={1 / s} />
                              <text x={ct.x + 11 / s} y={ct.y + 14.4 / s} fontSize={10 / s} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily="var(--f-mono,monospace)">{ct.num}</text>
                            </g>
                          )}
                          {rollEdit && (
                            <>
                              <rect x={runY ? ct.x + ct.w / 2 - hs : ct.x - hs} y={runY ? ct.y - hs : ct.y + ct.h / 2 - hs}
                                width={hs * 2} height={hs * 2} fill="#fff" stroke={strokeCol} strokeWidth={1.4 / s}
                                style={{ cursor: runY ? "ns-resize" : "ew-resize" }}
                                onPointerDown={(e) => beginRollCut(e, ct, "start")} />
                              <rect x={runY ? ct.x + ct.w / 2 - hs : ct.x + ct.w - hs} y={runY ? ct.y + ct.h - hs : ct.y + ct.h / 2 - hs}
                                width={hs * 2} height={hs * 2} fill="#fff" stroke={strokeCol} strokeWidth={1.4 / s}
                                style={{ cursor: runY ? "ns-resize" : "ew-resize" }}
                                onPointerDown={(e) => beginRollCut(e, ct, "end")} />
                            </>
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
              {DS.casing && <line ref={rubberCasingRef} data-draft="casing" stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeOpacity={DS.rubber.opacity} strokeLinecap="round" style={{ display: "none" }} />}
              <line ref={rubberRef} stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.rubber.width / tf.scale} strokeOpacity={DS.rubber.opacity} strokeDasharray={drawDashFor(DS.rubber.dash, tf.scale)} strokeLinecap="round" style={{ display: "none" }} />
              <path ref={arcRef} fill="none" stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.draft.lineWidth / tf.scale} strokeLinecap="round" style={{ display: "none" }} />
              {/* rect/marquee preview shares one ref across four tools, so its paint
                  is a 3-way branch: deduct-rect (AND ring deduct) = danger red;
                  schedule = a NEUTRAL selection gesture, left cobalt + condition
                  fill; rect & symbol marquees are measure tools, themed via DS. */}
              {(() => {
                const rectDeduct = tool === "deduct" || tool === "deduct-rect";
                const rectNeutral = tool === "schedule";   // selection gesture, not measurement — never themed
                return <rect ref={rectRef}
                  fill={rectDeduct ? "rgba(176,58,38,.22)" : rectNeutral ? shapeFill(aCond) : draftFill}
                  stroke={rectDeduct ? "#b03a26" : rectNeutral ? "#1f3fc7" : DS.accent}
                  strokeWidth={(rectNeutral ? 2 : DS.draft.width) / tf.scale} style={{ display: "none" }} />;
              })()}
              <path ref={cloudRef} fill="rgba(37,99,235,.06)" stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${5 / tf.scale} ${4 / tf.scale}`} style={{ display: "none" }} />
              <rect ref={highlightRef} fill="rgba(196,122,16,.18)" stroke="#c47a10" strokeWidth={2 / tf.scale} style={{ display: "none" }} />
              <line ref={dimRef} stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${5 / tf.scale} ${4 / tf.scale}`} style={{ display: "none" }} />
              <path ref={hlPathRef} style={{ display: "none" }} />
              {/* Symbol sweep review overlay (#264) — the same glyph language the
                  MCP renders ship: seed = violet double ring, question = orange
                  ?-circle, accepted/committed-to-be = the condition color. */}
              {sweep && (() => {
                const pp = panels.find((x) => x.key === sweep.key);
                if (!pp) return null;
                const ox = pp.xOffset;
                const k = 1 / tf.scale;
                // translucent like the highlighter — the estimator's own rule:
                // review glyphs must never obstruct the ink they sit on
                const X = (at, color, w) => (
                  <g stroke={color} strokeWidth={w * k} strokeOpacity={0.6}>
                    <line x1={at[0] + ox - 8 * k} y1={at[1] - 8 * k} x2={at[0] + ox + 8 * k} y2={at[1] + 8 * k} />
                    <line x1={at[0] + ox - 8 * k} y1={at[1] + 8 * k} x2={at[0] + ox + 8 * k} y2={at[1] - 8 * k} />
                  </g>
                );
                return (
                  <g pointerEvents="none">
                    <circle cx={sweep.seed.center[0] + ox} cy={sweep.seed.center[1]} r={15 * k} fill="none" stroke={DS.symbol.seed} strokeWidth={2 * k} strokeOpacity={0.65} />
                    <circle cx={sweep.seed.center[0] + ox} cy={sweep.seed.center[1]} r={9 * k} fill="none" stroke={DS.symbol.seed} strokeWidth={2 * k} strokeOpacity={0.65} />
                    {sweep.matches.map((m, i) => {
                      const offTag = sweep.excludedTags.includes((m.label && m.label.label) || "\u2205");
                      return <g key={`m${i}`} opacity={offTag ? 0.22 : 1}>{X(m.at, activeColor, 2.4)}</g>;
                    })}
                    {sweep.questions.map((q, i) => {
                      if (q.state === "dismissed") return null;
                      if (q.state === "accepted") return <g key={`q${i}`}>{X(q.at, activeColor, 2.4)}</g>;
                      return (
                        <g key={`q${i}`}>
                          <circle cx={q.at[0] + ox} cy={q.at[1]} r={13 * k} fill="none" stroke={DS.symbol.question} strokeWidth={(i === sweep.qIndex ? 3.4 : 2.2) * k} strokeOpacity={i === sweep.qIndex ? 0.85 : 0.6} />
                          <text x={q.at[0] + ox} y={q.at[1] + 5 * k} textAnchor="middle" fill={DS.symbol.question} fillOpacity={0.85} fontSize={14 * k} fontWeight="700" fontFamily="JetBrains Mono, monospace">?</text>
                        </g>
                      );
                    })}
                  </g>
                );
              })()}
              {/* casing under-stroke (Site Glass): a JSX twin BEHIND each draft
                  stroke, tracing the SAME geometry (arc-flattened where a bow is
                  set). Width ownership is DUAL like the rubber core — this twin
                  declares width from the ~11 Hz tf mirror (heals wheel-zoom with a
                  stationary pointer). Surface is un-themed, so no casing there.
                  The polygon's strokeDasharray MUST mirror the accent polygon's
                  four lines below — same expression, same dash, so a dashed
                  zone accent never rides a solid casing ribbon. */}
              {DS.casing && poly.length >= 2 && tool !== "surface" && (tool === "linear"
                ? <polyline data-draft="casing" points={(curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeLinecap="round" strokeLinejoin="round" />
                : ringOutline
                ? <polyline data-draft="casing" points={(curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : drawDashFor(DS.draft.dash, tf.scale)} strokeLinecap="round" strokeLinejoin="round" />
                : <polygon data-draft="casing" points={(curveIdx.length ? flattenArcRing(poly, curveIdx, tool !== "zone" && !bowOpen) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : drawDashFor(DS.draft.dash, tf.scale)} strokeLinejoin="round" />)}
              {poly.length >= 2 && (tool === "linear" || tool === "surface"
                ? <polyline points={(curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={tool === "surface" ? activeColor : DS.accent} strokeWidth={(tool === "surface" ? 3.5 : DS.draft.lineWidth) / tf.scale} strokeDasharray={tool === "surface" ? `${10 / tf.scale} ${3 / tf.scale} ${2 / tf.scale} ${3 / tf.scale}` : drawDashFor(DS.draft.dash, tf.scale)} strokeLinecap="round" strokeLinejoin="round" />
                : ringOutline
                ? <polyline points={(curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.draft.width / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : drawDashFor(DS.draft.dash, tf.scale)} strokeLinecap="round" strokeLinejoin="round" />
                : <polygon points={(curveIdx.length ? flattenArcRing(poly, curveIdx, tool !== "zone" && !bowOpen) : poly).map((p) => p.join(",")).join(" ")} fill={poly.length >= 3 ? (tool === "deduct" ? "rgba(176,58,38,.22)" : tool === "zone" ? rgbaFromHex(DS.accent, 0.06) : draftFill) : "none"} stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.draft.width / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : drawDashFor(DS.draft.dash, tf.scale)} />)}
              {/* outline mode: dotted ghost of the on-commit closing edge (last vertex → first), so the loop is visible without a fill. */}
              {ringOutline && poly.length >= 3 && !bowOpen && (
                <line x1={poly[poly.length - 1][0]} y1={poly[poly.length - 1][1]} x2={poly[0][0]} y2={poly[0][1]}
                  stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.draft.width / tf.scale}
                  strokeLinecap="round" strokeDasharray={`${1 / tf.scale} ${5 / tf.scale}`} />
              )}
              {/* Bold the most recent segment so you see where you just clicked.
                  A closed arc bolds AS the arc — a straight chord drawn across
                  the bow would read as the boundary and it isn't one. Nothing
                  bolds while a bow is still open; the live preview is the
                  segment then. */}
              {poly.length >= 2 && !bowOpen && DS.lastSegWidth != null && (
                polyCurve[poly.length - 2] && poly.length >= 3
                  ? <>
                      {DS.casing && tool !== "surface" && <path data-draft="casing" d={arcPathD(poly[poly.length - 3], poly[poly.length - 2], poly[poly.length - 1])} fill="none"
                        stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeLinecap="round" />}
                      <path d={arcPathD(poly[poly.length - 3], poly[poly.length - 2], poly[poly.length - 1])} fill="none"
                        stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.lastSegWidth / tf.scale} strokeLinecap="round" />
                    </>
                  : <>
                      {DS.casing && tool !== "surface" && <line data-draft="casing" x1={poly[poly.length - 2][0]} y1={poly[poly.length - 2][1]} x2={poly[poly.length - 1][0]} y2={poly[poly.length - 1][1]}
                        stroke={DS.casing.color} strokeWidth={DS.casing.width / tf.scale} strokeLinecap="round" />}
                      <line x1={poly[poly.length - 2][0]} y1={poly[poly.length - 2][1]} x2={poly[poly.length - 1][0]} y2={poly[poly.length - 1][1]}
                        stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.lastSegWidth / tf.scale} strokeLinecap="round" />
                    </>
              )}
              {/* close preview — the ring tools' ghost cursor→first edge (theme-
                  gated; positioned by moveCrosshair). Width AND dash dual-owned with
                  the mover: both declared here from the tf mirror, both re-written
                  there from tfRef — always the same scale read, both cadences. */}
              {DS.closePreview && (tool === "area" || tool === "deduct" || tool === "zone") && poly.length >= 2 && (
                <line ref={closeRef} data-draft="close-preview" stroke={draftStroke(tool, draftInvalid, DS)} strokeWidth={DS.closePreview.width / tf.scale} strokeDasharray={drawDashFor(DS.closePreview.dash, tf.scale)} strokeLinecap="round" style={{ display: "none" }} />
              )}
              {poly.map((p, i) => {
                const isLast = i === poly.length - 1;
                // Preserve the affordance: a CURVE point reads as a round handle,
                // a corner as the theme's vertex glyph (drafting: the house star).
                // Only the CORNER shape is themed — curve points stay circles so
                // the ⌥-curve gesture is always legible, whatever the theme.
                // casing backing (Site Glass): the same glyph fattened in the
                // casing color, so each vertex carries a sheet-contrast halo. When
                // off (every other style), the bare element is returned EXACTLY as
                // before — no wrapper — so Drafting Table is byte-identical.
                const cased = DS.vertex.casing && DS.casing;
                if (polyCurve[i]) {
                  const dot = <circle key={i} cx={p[0]} cy={p[1]} r={(isLast ? 4.5 : 3.4) / tf.scale}
                    fill={isLast ? "#fff" : DS.accent} stroke={DS.accent} strokeWidth={(isLast ? 2 : 1.4) / tf.scale} />;
                  if (!cased) return dot;
                  return (
                    <g key={i}>
                      <circle data-draft="casing" cx={p[0]} cy={p[1]} r={((isLast ? 4.5 : 3.4) + 1.5) / tf.scale} fill={DS.casing.color} stroke={DS.casing.color} strokeWidth={1 / tf.scale} />
                      <circle cx={p[0]} cy={p[1]} r={(isLast ? 4.5 : 3.4) / tf.scale}
                        fill={isLast ? "#fff" : DS.accent} stroke={DS.accent} strokeWidth={(isLast ? 2 : 1.4) / tf.scale} />
                    </g>
                  );
                }
                const d = markerPath(DS.vertex.shape, p[0], p[1], (isLast ? DS.vertex.lastR : DS.vertex.r) / tf.scale);
                if (!d) return null;   // "none" — this theme places no corner marks
                if (!cased) return <path key={i} d={d}
                  fill={isLast ? "#fff" : DS.accent} stroke={DS.accent} strokeWidth={(isLast ? 2 : 1) / tf.scale} />;
                return (
                  <g key={i}>
                    <path data-draft="casing" d={d} fill={DS.casing.color} stroke={DS.casing.color} strokeWidth={3 / tf.scale} />
                    <path d={d} fill={isLast ? "#fff" : DS.accent} stroke={DS.accent} strokeWidth={(isLast ? 2 : 1) / tf.scale} />
                  </g>
                );
              })}
              {/* edge labels (Precision "all" / Site Glass "last2"): placed-edge
                  midpoints priced with the draft's own sheet scale, in the check
                  tool's white-halo idiom. Surface keeps its own readout; a segment
                  touching a curve control is skipped — its chord would float off
                  the flattened arc and misstate the length. */}
              {DS.edgeLabels && tool !== "surface" && poly.length >= 2 && liveUpp ? (() => {
                const z = tf.scale;
                const start = DS.edgeLabels === "last2" ? Math.max(0, poly.length - 3) : 0;
                const kids = [];
                for (let i = start; i < poly.length - 1; i++) {
                  if (polyCurve[i] || polyCurve[i + 1]) continue;   // arc segment — chord label would misstate
                  const a = poly[i], b = poly[i + 1];
                  kids.push(
                    <text key={i} data-draft="edge-label" x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 6 / z} fontSize={10.5 / z} fontWeight={600}
                      fill={DS.accent} textAnchor="middle" stroke="#fff" strokeWidth={3 / z} paintOrder="stroke">
                      {fmtCheckLen(Math.hypot(b[0] - a[0], b[1] - a[1]) * liveUpp, units)}
                    </text>
                  );
                }
                return <g>{kids}</g>;
              })() : null}
              {calib.length === 2 && <line x1={calib[0][0]} y1={calib[0][1]} x2={calib[1][0]} y2={calib[1][1]} stroke={DS.accent} strokeWidth={2 / tf.scale} />}
              {calib.map((p, i) => <path key={i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill={DS.accent} />)}
              {alignPt && <path d={starPath(alignPt[0], alignPt[1], 4.5 / tf.scale)} fill={DS.accent} stroke="#fff" strokeWidth={1 / tf.scale} />}
              {/* check tool — dashed so it never reads as calibrate's solid line */}
              {tool === "check" && check.length === 2 && !checkCross && (
                <>
                  <line x1={check[0][0]} y1={check[0][1]} x2={check[1][0]} y2={check[1][1]} stroke={DS.accent} strokeWidth={2 / tf.scale} strokeDasharray={`${6 / tf.scale} ${4 / tf.scale}`} />
                  {checkFeet != null && (
                    <text x={(check[0][0] + check[1][0]) / 2} y={(check[0][1] + check[1][1]) / 2 - 8 / tf.scale}
                      fontSize={12.5 / tf.scale} fontWeight={700} fill={DS.accent} textAnchor="middle"
                      stroke="#fff" strokeWidth={3 / tf.scale} paintOrder="stroke">{fmtCheckLen(checkFeet, units)}</text>
                  )}
                </>
              )}
              {tool === "check" && check.map((p, i) => <path key={"ck" + i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill={DS.accent} />)}
              {/* scale-acceptance guide — an ephemeral calibrated ruler so a 2×-off
                  scale is visually obvious against known elements (a door is ~3′) */}
              {SHOW_SCALE_GUIDE && scaleGuide && panelKeySet.has(scaleGuide.key) && (() => {
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

          {/* corner cluster — fit + sheet-invert only. Zoom buttons are gone:
              wheel-notch/pinch zoom toward the cursor already owns zooming
              (precision-instrument rule: no control that duplicates a gesture).
              Left presses stop here (the container's onPointerDown
              setPointerCapture()s every left press, which retargets pointerup
              so the composed click never reaches these buttons); right/middle/
              Space presses still bubble so a pan can start on top, and dblclick
              is stopped so rapid clicks can't finishShape() */}
          <div onPointerDown={(e) => { if (e.button === 0 && !spaceRef.current) e.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}
            style={{ position: "absolute", left: 14, bottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            <button onClick={() => stage.w && fitToView(stage.w, stage.h)} title="Fit sheet to view" style={{ width: 34, height: 34, borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>fit</button>
            <button onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Sheet back to positive print" : "Invert sheet — negative print (affects marked-set export)"}
              style={{ width: 34, height: 34, borderRadius: 0, border: `1px solid ${darkMode ? "var(--cobalt)" : "var(--ink-faint)"}`, background: darkMode ? "var(--cobalt)" : "var(--paper-bright)", color: darkMode ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", fontSize: 13 }}>
              {darkMode ? "☀" : "☾"}</button>
            <button onClick={() => toggleFocusMode()} title={focusMode ? "Focus off — show all chrome (F)" : "Focus — trade chrome for canvas height (F)"}
              style={{ width: 34, height: 34, borderRadius: 0, border: `1px solid ${focusMode ? "var(--cobalt)" : "var(--ink-faint)"}`, background: focusMode ? "var(--cobalt)" : "var(--paper-bright)", color: focusMode ? "var(--accent-contrast)" : "var(--ink)", cursor: "pointer", fontSize: 13 }}>⛶</button>
          </div>
        </div>

        {/* correction-rule banner (#88): offer after a qualifying Cut Out, then
            the staged batch's Apply/Cancel. Floats alone bottom-center (the
            transient commitMsg text lives in the status bar now); Dismiss/
            Cancel are always one click — a rule is never applied silently. */}
        {(ruleOffer || ruleStage) && (
        <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", zIndex: Z.canvasUi, display: "flex", flexDirection: "column-reverse", alignItems: "center", gap: 8, maxWidth: "82%", pointerEvents: "none" }}>
        {(ruleOffer || ruleStage) && (
          <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "var(--paper-bright)", border: "1.5px dashed var(--c-danger)", boxShadow: "var(--shadow-1)", fontSize: 12.5, color: "var(--ink)", maxWidth: "100%" }}>
            {ruleOffer ? (<>
              <span>Make this a rule for all <b>{ruleOffer.tag}</b> rooms? Excludes enclosed regions under <b>{ruleOffer.seed.max_area_sf} SF</b>.</span>
              <button onClick={previewRule}
                style={{ padding: "4px 12px", background: "var(--paper-bright)", border: "1.5px solid var(--cobalt)", color: "var(--cobalt)", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                Preview</button>
              <button onClick={() => setRuleOffer(null)}
                style={{ padding: "4px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 12, cursor: "pointer" }}>
                Dismiss</button>
            </>) : (<>
              <span><b>{ruleStage.candidates.length}</b> matching region{ruleStage.candidates.length === 1 ? "" : "s"} staged as dashed deducts — {ruleStage.rule.label}.</span>
              <button onClick={applyStagedRule}
                style={{ padding: "4px 12px", background: "var(--paper-bright)", border: "1.5px solid var(--cobalt)", color: "var(--cobalt)", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                Apply {ruleStage.candidates.length}</button>
              <button onClick={() => setRuleStage(null)}
                style={{ padding: "4px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 12, cursor: "pointer" }}>
                Cancel</button>
            </>)}
          </div>
        )}
        </div>
        )}
        {/* top-center stack: accept pill + dictation chip share one flex column
            so simultaneous voice + pending proposals can never overlap. */}
        {(voiceChip || pendingCommitted.length > 0) && (
        <div style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: Z.canvasUi, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, pointerEvents: "none" }}>
        {/* accept pill — visible while committed-but-unreviewed shapes (an
            imported MCP takeoff) are on the visible sheets; they render dashed
            pencil until accepted. One click, one undo entry. */}
        {pendingCommitted.length > 0 && (
          <button onClick={acceptPendingShapes}
            title={`${pendingCommitted.length} machine-proposed shape${pendingCommitted.length === 1 ? "" : "s"} render${pendingCommitted.length === 1 ? "s" : ""} dashed pending your review. Accept makes them ink (⌘Z undoes); to reject one, select it and press Delete.`}
            style={{ pointerEvents: "auto", padding: "6px 14px", background: "var(--paper-bright)", border: "1.5px dashed var(--cobalt)", boxShadow: "var(--shadow-1)", fontSize: 12.5, fontWeight: 600, color: "var(--cobalt)", cursor: "pointer" }}>
            Accept {pendingCommitted.length} proposed shape{pendingCommitted.length === 1 ? "" : "s"}
          </button>
        )}
        {/* live dictation chip (RFC #59 recognizer): top-center, fixed — NOT
            cursor-following, the cursor is busy aiming for deixis. Shows the
            hold state, decode state, and a brief flash of the heard transcript
            (the receipt); outcomes land in the commitMsg bar like every command. */}
        {voiceChip && (
          <div style={{ padding: "5px 12px", background: "var(--surface-pop)", border: `1px solid ${voiceChip.tone === "live" || voiceChip.tone === "offer" ? "var(--cobalt)" : "var(--ink-faint)"}`, boxShadow: "var(--shadow-1)", fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink)", display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
            {voiceChip.tone === "live" && <span className="pip" />}
            {voiceChip.text}
          </div>
        )}
        </div>
        )}

        {/* live readout — top-right, at right:56 so it clears the panel rail's
            column entirely (right:14, 34px wide — same clearance the zone panel
            uses) instead of the old magic maxHeight tuned to the rail's height. */}
        <div style={{ position: "absolute", ...(isNarrow
          // phones: a bottom strip — the top-right box plus the panel rail was
          // covering the entire screen. bottom:64 clears the bottom-center toast.
          ? { left: 10, right: 10, bottom: 64, maxHeight: "36%", padding: "8px 12px" }
          : { right: 56, top: 14, minWidth: 200, maxWidth: 260, maxHeight: "calc(100% - 28px)", padding: "12px 16px" }),
          background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, overflowY: "auto", boxShadow: "var(--shadow-pop)", fontVariantNumeric: "tabular-nums", zIndex: Z.canvasUi }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool === "zone" ? "Zone check" : (aCond?.finish_tag || "No condition")}</div>
          {/* The straight/curve switch (#284) — a mode you flip mid
              measurement, not a modifier you hold, so an arc is a run of
              ordinary clicks. Lives in the readout because that is where the
              eye already is while tracing; the canvas stays chrome-free. */}
          {CURVABLE.has(tool) && (
            <div style={{ display: "flex", gap: 0, marginBottom: 8, border: "1px solid var(--ink-faint)" }}
              title="Straight places corners. Curve takes two clicks — one anywhere ON the bow, then its far end — and lays the unique circle through those and the vertex you were on, so it sits on a radius wall instead of near it. Switch as often as you like inside one measurement: Q flips it once a trace is going, and ⌥-click always places the OTHER kind for one point.">
              {[["straight", "Straight", "╱"], ["curve", "Curve", "⌒"]].map(([k, label, glyph]) => {
                const on = (k === "curve") === curveMode;
                return (
                  <button key={k} onClick={() => setCurveMode(k === "curve")}
                    style={{ flex: 1, padding: "3px 6px", border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: on ? 700 : 500,
                      background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--accent-contrast)" : "var(--ink-secondary)" }}>
                    <span style={{ fontSize: 13 }}>{glyph}</span> {label}
                  </button>
                );
              })}
            </div>
          )}
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
              const liveLF = openLen(curveIdx.length ? flattenArcRing(poly, curveIdx, false) : poly) * liveUpp;
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
              {condH > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>@H {num(heightVal(condH, units), 2)}{units === "metric" ? " m" : "′"}: {fa(livePerim * condH)} vert{units === "metric" ? "" : ` · ${num((liveArea * condH) / 27)} CY`}</div>}
              {CURVABLE.has(tool) && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>{bowOpen ? "Bow set — click the far END of the arc" : curveMode && poly.length ? "Click a point ON the bow, then its far end" : curveIdx.length ? `${curveIdx.length} arc${curveIdx.length === 1 ? "" : "s"} — each one a true circle through 3 points` : "Q or the switch above draws an arc · ⌥-click flips one point"}</div>}
            </>
          ) : selShape ? (
            // #283 — a FINISHED takeoff reads the same as it did mid-trace.
            // The perimeter is already computed and stored on every closed
            // shape (shapeMetrics); before this it simply had nowhere to be
            // read, so an estimator who wanted the footprint's LF traced the
            // ring a second time with the linear tool.
            (() => {
              const c = selShape.computed || {};
              const a = c.area_sf || 0, lf = c.perimeter_lf || 0;
              const shTag = condById[selShape.condition_id]?.finish_tag || "—";
              const big = (txt, unit, col) => (
                <div style={{ fontSize: 22, fontWeight: 700, color: col || "var(--ink)" }}>{txt} <span style={{ fontSize: 13, fontWeight: 600 }}>{unit}</span></div>
              );
              const sub = (txt) => <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{txt}</div>;
              const foot = <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>{shTag} · selected{selShape.origin === "agent" ? " · agent" : ""}</div>;
              if (selShape.measure_role === "count") return <>{big(num(c.count || 1, 0), "EA")}{foot}</>;
              if (selShape.measure_role === "linear") {
                return <>{big(num(lenVal(lf, units)), lenUnit(units))}{a > 0 ? sub(`${fa(a)} border`) : null}{foot}</>;
              }
              if (selShape.measure_role === "surface_area") {
                const h = selShape.height_override === true
                  ? Number(selShape.height_ft) || 0
                  : Number(selShape.height_ft) || Number(condById[selShape.condition_id]?.height_ft) || 0;
                return <>{big(num(areaVal(a, units)), `${areaUnit(units)} wall`)}{sub(`${fl(lf)} × ${num(heightVal(h, units), 2)}${units === "metric" ? " m" : " ft"}`)}{foot}</>;
              }
              const ded = selShape.measure_role === "deduct";
              return (
                <>
                  {big(`${ded ? "−" : ""}${num(areaVal(a, units))}`, areaUnit(units), ded ? "var(--c-danger)" : undefined)}
                  {sub(units === "metric" ? `${fl(lf)} perim` : `${num(a / 9)} SY  ·  ${num(lf)} LF perim`)}
                  {foot}
                </>
              );
            })()
          ) : (
            <div style={{ fontSize: 12.5, opacity: 0.6 }}>{!unitsPerPx ? "Set scale first" : tool === "zone" ? "Trace a region (an apartment, a wing) — ⏎ closes it and lists every condition inside" : !activeCond ? "Pick a condition" : tool === "oneclick" ? "Click inside a room — it selects itself" : tool === "surface" ? "Trace the wall run" : "Click to trace an area"}</div>
          )}
          {selShape?.measure_role === "surface_area" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }} title="Height for THIS wall only — full-height tile here, 4-ft wainscot there, same condition. ↺ returns to the condition height.">
              <Icon name="height" size={12} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>this wall</span>
              <input name="shape-height-ft" type="number" min="0" step={heightStep(units)} value={shapeHDraft ?? dimInputStr(selShape.height_ft, units, "height")}
                onChange={(e) => { setShapeHDraft(e.target.value); setShapeHeight(e.target.value); }}
                onBlur={() => { if (shapeHDraft != null) setShapeHeight(shapeHDraft); setShapeHDraft(null); }}
                style={{ width: 56, padding: "2px 5px", border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{heightUnit(units)} → {fa(selShape.computed?.area_sf || 0)}</span>
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
          {tally.length > 0 && (
            <>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.5, marginTop: 8 }}>Measurements</div>
              <div style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, lineHeight: 1.5, marginTop: 2 }}>
                {tally.map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 6, whiteSpace: "nowrap" }}>
                    <span style={{ opacity: 0.45 }}>{String(r.n).padStart(2, "0")}</span>
                    <span>
                      {fl(r.lf)}
                      {r.role === "wall"
                        ? <> × {num(heightVal(r.h, units), 2)} {heightUnit(units)} = {fa(r.sf)}</>
                        : <span style={{ color: "var(--ink-muted)" }}> linear</span>}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
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
          {rollByCond.size > 0 && panelBtn(() => setRollPanelOpen((o) => !o), "roll", "Roll goods — the cut diagram, cutting order, and figured order footage", rollPanelOpen, rollByCond.size)}
          {layerEntries.length > 0 && panelBtn(() => setLayersOpen((o) => !o), "layers", "PDF layers — what this drawing's own layer table states each ink is; set what One-Click treats as wall and what it ignores", layersOpen, layerEntries.reduce((n, e) => n + e.layers.length, 0))}
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

        {/* Roll panel (#136) — DOCKED right-rail sibling like the Agent panel:
            per-condition cut diagrams (to scale, numbered), drag-to-reorder with
            the engine re-pack, the overlay/edit toggles, and the figured order
            lines. A pure view — layout state lives on the shapes (rollcut). */}
        {rollPanelOpen && (
          <RollPanel
            layouts={[...rollByCond.entries()].map(([condId, ri]) => {
              const c = condById[condId];
              return { condId, tag: c?.finish_tag || "?", color: c?.color, fill: c?.fill, hatch: c?.hatch, multiplier: c?.multiplier || 1, ri };
            })}
            show={rollShow} onShow={setRollShow}
            edit={rollEdit} onEdit={setRollEdit}
            onReorder={onReorderRollCuts} onResetOrder={onResetRollOrder}
            onClose={() => setRollPanelOpen(false)}
          />
        )}

        {/* Layers panel (#85 phase 2) — DOCKED right-rail sibling like the Roll
            panel: the sheet's PDF layer table (names + stated roles) with the
            per-layer Auto/Wall/Off controls feeding One-Click's role
            short-circuit. Its rail button renders only when an open sheet
            actually carries layers, so a flattened export costs zero chrome. */}
        {layersOpen && layerEntries.length > 0 && (
          <LayerPanel
            entries={layerEntries}
            onOverride={setLayerOverride}
            onReset={resetLayerOverrides}
            onClose={() => setLayersOpen(false)}
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
          overlay={isNarrow}
          multiSheet={groupKeys.length > 1}
          units={units}
          conditions={conditions}
          activeCond={activeCond}
          visRowById={visRowById} projRowById={projRowById}
          conditionColumns={conditionColumns}
          shapeLabels={shapeLabels}
          templates={templates}
          palette={palette}
          rollByCond={rollByCond}
          transitionSources={transitionSources}
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
          sheets={sheets} getDoc={docFor} scales={scales} detectedScales={detectedScales} scaleUnconfirmed={scaleUnconfirmed}
          shapes={shapes} labels={galleryLabels}
          onLabel={(k, lbl) => setGalleryLabels((m) => (m[k] === lbl ? m : { ...m, [k]: lbl }))}
          onDetect={(k, det) => setDetectedScales((d) => (d[k]?.label === det.label ? d : { ...d, [k]: det }))}
          thumbCacheRef={thumbCacheRef} busyRef={statusRef}
          openTabs={openTabs} onOpen={openSheets}
          stitches={stitches} onStitch={createStitch} onOpenStitch={openStitch} onDeleteStitch={deleteStitch}
          onAddFiles={handleFiles}
          levels={sheetLevels}
          onAssignLevel={(keys, label) => setSheetLevels((m) => {
            const next = { ...m };
            for (const k of keys) { if (label) next[k] = label; else delete next[k]; }
            return next;
          })}
          onClosePdf={closePdf}
          onCloseMany={closePdfs}
          onClearWorkspace={cloudMode ? undefined : clearWorkspace}
          knownPages={knownPages} onPages={rememberPages}
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
          scaleInfo={Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, scale_source: scaleSources[sheet_id] || "unknown", scale_confirmed: scaleUnconfirmed[sheet_id] !== false }))}
          rollByCond={rollByCond}
          provenanceCounters={provCounters}
          sheetLabel={(k) => tabLabel(k)}
          sheetDims={(k) => panelByKey(k)?.img}
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

      {/* status bar — the 28px instrument strip, the grid shell's bottom row.
          Mono, tabular, tick-ruled top edge. The verb column keeps tool/agent
          activity legible at all times; the coords span updates via direct DOM
          from onPointerMove (never React state per mousemove); transient
          commitMsg text lives here now (the old floating pill is gone — the
          rule banner still floats, it has buttons). Print: the report-only
          visibility rules already hide this. */}
      {/* ── Symbol sweep review panel (#264) — floats while a sweep is live ── */}
      {sweep && view === "canvas" && (() => {
        const seedTag = sweep.seed.label?.label || null;
        const mLine = sweepLabelLine(sweep.matches, seedTag);
        const openQ = sweep.questions.filter((q) => q.state === "open").length;
        const accQ = sweep.questions.filter((q) => q.state === "accepted").length;
        // per-tag groups (#308 → commit-by-label): the drawing names the
        // matches; a tag the estimator unticks is excluded from the commit —
        // the sibling-fixture answer in one click, sweep_schedule_row's
        // excluded-by-tag discipline brought to the canvas.
        const tagKeyOf = (m) => (m.label && m.label.label) || "\u2205";
        const tagGroups = [];
        for (const m of sweep.matches) {
          const k = tagKeyOf(m);
          const g = tagGroups.find((x) => x.tag === k);
          if (g) g.n += 1; else tagGroups.push({ tag: k, n: 1 });
        }
        tagGroups.sort((a, b) => b.n - a.n);
        const offSet = new Set(sweep.excludedTags);
        const matchN = sweep.matches.filter((m) => !offSet.has(tagKeyOf(m))).length;
        const commitN = (sweep.includeSeed ? 1 : 0) + matchN + accQ;
        const unlabeled = (seedTag || sweep.matches.some((m) => m.label)) ? sweep.matches.filter((m) => !m.label).length : 0;
        return (
          <div style={{ position: "fixed", right: 12, top: "calc(var(--topbar-h) + 12px)", width: 288, zIndex: Z.popover, background: "var(--paper-cream)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-pop)", display: "flex", flexDirection: "column", fontSize: "var(--fs-m)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
              <span className="field-label">SYMBOL SWEEP</span>
              <span style={{ flex: 1 }} />
              {sweep.complete
                ? <span style={{ fontFamily: "var(--f-mono)", fontSize: "var(--fs-2xs)", letterSpacing: ".1em", color: "var(--c-positive)", border: "1px solid var(--c-positive)", padding: "2px 6px" }}>COMPLETE</span>
                : <span style={{ fontFamily: "var(--f-mono)", fontSize: "var(--fs-2xs)", letterSpacing: ".1em", color: "#fff", background: "var(--c-warning)", padding: "3px 6px" }}>FLOOR — NOT A TOTAL</span>}
            </div>
            {sweep.seed.segments <= 3 && (
              <div style={{ padding: "8px 12px", background: "var(--tint-select)", color: "var(--ink)", fontSize: "var(--fs-s)", lineHeight: 1.45 }}>
                The seed is only {sweep.seed.segments} segment(s) — likely a FRAGMENT, and fragments match everywhere (every square corner reads as one). Marquee the whole symbol.
              </div>
            )}
            {!sweep.complete && (
              <div style={{ padding: "8px 12px", background: "var(--c-warning)", color: "#fff", fontSize: "var(--fs-s)", lineHeight: 1.45 }}>
                {sweep.dropped} placement(s) were never scored — tighten the marquee around more distinctive linework before trusting this as a total.
              </div>
            )}
            <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div><b style={{ fontFamily: "var(--f-display)", fontSize: "var(--fs-xl)" }}>{matchN}</b> of {sweep.matches.length} matched will commit{mLine && tagGroups.length <= 1 ? <span style={{ color: "var(--ink-soft)" }}> — {mLine}</span> : null}</div>
              {tagGroups.length > 1 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div className="field-label">BY LABEL — UNTICK A TAG TO EXCLUDE IT</div>
                  {tagGroups.map((g) => {
                    const isSeedTag = seedTag && g.tag === seedTag;
                    const isOff = offSet.has(g.tag);
                    return (
                      <label key={g.tag} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-s)", cursor: "pointer", color: isOff ? "var(--text-faint)" : !isSeedTag && g.tag !== "\u2205" ? "var(--c-warning)" : "var(--ink)" }}>
                        <input type="checkbox" checked={!isOff}
                          onChange={() => setSweep((sw2) => ({ ...sw2, excludedTags: isOff ? sw2.excludedTags.filter((t) => t !== g.tag) : [...sw2.excludedTags, g.tag] }))} />
                        <span style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{g.tag === "\u2205" ? "no label" : g.tag}</span>
                        <span>×{g.n}</span>
                        {isSeedTag && <span style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-muted)" }}>seed's tag</span>}
                        {!isSeedTag && g.tag !== "\u2205" && !isOff && <span style={{ fontSize: "var(--fs-2xs)" }}>different device?</span>}
                      </label>
                    );
                  })}
                </div>
              )}
              {unlabeled > 0 && tagGroups.length <= 1 && <div style={{ fontSize: "var(--fs-s)", color: "var(--c-warning)" }}>{unlabeled} match(es) carry no label while this family is labeled — look at those first.</div>}
              <div><b style={{ fontFamily: "var(--f-display)", fontSize: "var(--fs-xl)", color: openQ ? "var(--c-warning)" : "var(--ink)" }}>{sweep.questions.length}</b> question(s){openQ ? <span style={{ color: "var(--ink-soft)" }}> — ↵ accept · X dismiss · → next</span> : <span style={{ color: "var(--ink-soft)" }}> — all answered</span>}</div>
              {sweep.questions.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                  {sweep.questions.map((q, i) => (
                    <button key={i} type="button" onClick={() => setSweep((s) => ({ ...s, qIndex: i }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontFamily: "var(--f-body)", fontSize: "var(--fs-s)", textAlign: "left", background: i === sweep.qIndex ? "var(--tint-select)" : "transparent", border: `1px solid ${i === sweep.qIndex ? "var(--c-warning)" : "var(--ink-faint)"}`, color: q.state === "dismissed" ? "var(--text-faint)" : "var(--ink)", textDecoration: q.state === "dismissed" ? "line-through" : "none", cursor: "pointer" }}>
                      <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: q.state === "accepted" ? "var(--c-positive)" : q.state === "dismissed" ? "var(--text-faint)" : DS.symbol.question }}>{q.state === "accepted" ? "✓" : q.state === "dismissed" ? "×" : "?"}</span>
                      <span>{Math.round(q.score * 100)}%{q.label ? ` · ${q.label.label}` : ""}{q.readings > 1 ? ` · read ${q.readings} ways` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-s)", cursor: "pointer" }}>
                <input type="checkbox" checked={sweep.includeSeed} onChange={(e) => setSweep((s) => ({ ...s, includeSeed: e.target.checked }))} />
                <span>Count the seed{seedTag ? <span> — drawing says <b style={{ fontFamily: "var(--f-mono)" }}>{seedTag}</b></span> : null}</span>
              </label>
            </div>
            <div style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)", display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" className="btn-primary" onClick={commitSweep} style={{ justifyContent: "center" }}>
                Commit {commitN} as {condById[activeCond]?.finish_tag || "…"}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setSweep(null)} style={{ justifyContent: "center" }}>Discard (Esc)</button>
            </div>
          </div>
        );
      })()}
      <footer className="ink-panel ticks"
        style={{ height: "var(--status-h)", flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, padding: "0 14px", fontFamily: "var(--f-mono)", fontSize: "var(--fs-xs)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", userSelect: "none" }}>
        <span style={{ color: "var(--status-acc)", textShadow: "var(--glow)" }}>{TOOL_VERB[tool] || tool}</span>
        <span style={{ opacity: 0.25 }} aria-hidden="true">|</span>
        <span ref={statusCoordRef} aria-hidden="true" style={{ minWidth: 150 }} />
        <span style={{ opacity: 0.25 }} aria-hidden="true">|</span>
        <span>{scaleFace}</span>
        {commitMsg && (
          <span title={commitMsg} style={{ marginLeft: 8, color: isDangerMsg(commitMsg) ? "var(--c-danger)" : "var(--c-positive)", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {commitMsg}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 12, opacity: 0.75 }} aria-live="polite">
          <span>{shapes.filter((s) => panelKeySet.has(s.sheet_id)).length} shapes</span>
          <span>{cloudMode ? "drive" : "local"}{saveState === "saving" ? " · saving…" : saveState === "saved" ? " · saved" : ""}</span>
        </span>
      </footer>
      {/* BYO-key AI settings — the single config surface for the ai.js seam
          (the Agent panel links here; closing re-renders, so `configured`
          re-reads immediately). */}
      {showAiSettings && <AiSettings onClose={() => setShowAiSettings(false)} />}
      {/* the manual, last in the tree so it sits above every panel and dock */}
      {guideOpen && <UserGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
