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
import { buildSheetGraph, resolveTag, classifySheetRole, rowKeyAnswersFor, type SheetGraph, type SheetSpans, type Bbox } from "../../web/src/lib/sheetgraph.ts";
import { UserError, round1, round2 } from "./format.ts";
// Condition twins — the inheritance rule, shared with the canvas so a headless session and
// the app can never disagree about what a twin holds (web/test/variants.test.ts).
import { mintTwin, splitFromFamily, variantTag, propagateRowAdd, propagateRowPatch, propagateRowRemove,
         markRowLocal, dropRowLocal, type VariantCond, type VariantRow } from "../../web/src/lib/variants.ts";
import { STANDARD_SCALES, RENDER_SCALE, detectScale, extractSheetNumber, type DetectedScale } from "../../web/src/lib/sheets.ts";
import { buildSheetDxf, type DxfBuild } from "../../web/src/lib/dxf.ts";
import {
  extractVectorGeometry, buildMask, traceRegion, snapVertices, ringArea,
  hatchFamilies, MASK_MAX_DIM, SENS_BALANCED, type FloodResult, type MaskObj, type VectorGeometry, type Point, type HatchFamily,
} from "../../web/src/lib/oneclick.ts";
// The trace-confidence module (RFC #60 item D) — the engine's own account of a
// flood scored 0–1 with named factors. floodSignals is THE adapter from a
// FloodResult (audit A2: hand-listing the signal fields at call sites is how a
// signal the engine emits goes silently inert), and every flood this server
// commits or reports goes through it exactly once, in commit()'s central stamp.
import { traceConfidence, floodSignals, type ConfidenceInput } from "../../web/src/lib/confidence.ts";
// The canvas's raster-mask engine (#154), imported as-is — the scanned-sheet
// fallback is the SAME Bradley-threshold module the canvas floods with, so an
// agent's raster trace and a click's raster trace can never binarize differently.
import { buildRasterMask, RASTER_MIN_IMG_FRAC, RASTER_MIN_SEGS, RASTER_RDP_EPS } from "../../web/src/lib/rastermask.ts";
// floodAtSeed is the ONE flood entry point every non-canvas surface measures
// through (RFC #60 / PR #179, audit A6): floodRegionSealed with the sheet's own
// scale-derived arguments — seal radii up to a door width, door-swing wedge
// inclusion, the feet-true minimum-passage rule — exactly what the canvas
// passes at a One-Click. This server used to call the raw floodRegion on
// scale-unpinned masks here, so an MCP trace and a canvas click at the same
// seed measured DIFFERENT square footage under the same origin.method.
import { sweepCommitRefusal } from "./sweepGuard.ts";
import { ROOM_LABEL_RE, seedLadderPx, isLabelBubblePx, floodSurroundsLabelPx, floodAtSeed, type LabelBBox } from "../../web/src/lib/detectRooms.ts";
import { fingerprintSymbol, matchSymbol, buildNegative, SWEEP_TOL_PX, type SweepOptions, type SymbolFingerprint, type SymbolMatchResult, type SweepMatch, type SweepWithheld, type SweepRejected, type SymbolNegative } from "../../web/src/lib/symbolsweep.ts";
import { labelPlacements, type PlacementLabel } from "../../web/src/lib/symbollabels.ts";
import { buildSnapGrid, nearestSnap, closedMetrics, openLen } from "../../web/src/lib/geometry.js";
import { deriveTransitionRuns, type SheetFrame, type TransitionSourceShape } from "../../web/src/lib/transitions.ts";
// Real polygon boolean subtraction (#137/#206) — the canvas's own module, so a
// headless cut and the app's Eraser can never disagree about what a hole holds.
import { subtractCutout, recomposeCutouts, ringFullyInside, cutRun } from "../../web/src/lib/cutout.js";
// Correction rules (#88 / #207) — the canvas's own pure module, imported as-is
// (the approvals/totals precedent): apply_rules re-runs an imported rule with
// the exact predicate engine the canvas's Preview→Apply runs, so a headless
// session and the app can never disagree about what a rule matches.
import { applyRuleToProject, type Rule, type RuleShape, type SheetRuleData } from "../../web/src/lib/rules.ts";
// The approvals family (#176) — the canvas's own pure module, imported as-is
// (the markedset.js/importTakeoff.js precedent), so a verdict this server
// mints and a seal the canvas mints share ONE implementation of minting,
// load-gating, and exact-restore inverses.
import { sanitizeApprovals as sanitizeApprovalsJs, applyApprovalCommand as applyApprovalCommandJs } from "../../web/src/lib/approvals.js";
// the RFI register's pure half (web/src/lib/rfi.js): the panel's numbering and
// its tombstone rule, one implementation for both surfaces
import { nextRfiNumber, liveRfis } from "../../web/src/lib/rfi.js";
import { conditionTotals, grandTotals, sheetTotals, reportJson } from "../../web/src/lib/totals.js";
import { hasRollSetup, mintRollSetup, computeRollTakeoff, rollReportRows, seamLfByShape } from "../../web/src/lib/rollTakeoff.js";
import { gridPxPerFoot, drawGrid, drawShapes, drawMarks, type Ctx2D, type ToCanvas, type ViewMarks } from "./view.ts";

// Copied from the canvas (web/src/pages/TakeoffCanvas.jsx) so conditions and
// snap behavior minted here are identical to the browser's. PALETTE/HATCH_IDS
// are user data — never re-theme them.
const SNAP_CELL = 24; // snap-grid bucket, raster px
const SNAP_TOL = 7;   // one-click vertex-snap tolerance, image px
const PALETTE = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2"];
// (2026-07: dropped a drifted "fleur" entry that never existed in this app's
// HATCHES, restoring "dots", and appended the signal-set ids.)
const HATCH_IDS = ["solid", "diag", "diag2", "cross", "diagdense", "horiz", "vert", "grid", "brick", "plank", "herring", "basket", "checker", "wave", "dots", "speckle", "iso", "honeycomb", "scan", "plus", "circuit", "topo", "woodgrain", "chevron", "pinwheel", "harlequin", "hexagon", "penny", "octagondot", "fleur", "concrete"];
// uid mirrors web/src/lib/provenance.js mintUuid: crypto.randomUUID is a
// global in Node 20+, with the same non-secure-context fallback the browser
// build carries so the two sides mint identically-shaped ids.
const mintUuid = (): string =>
  (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const uid = (p: string): string => `${p}-${mintUuid()}`;
// mirrors web/src/lib/provenance.js nowIso — a twin is born now, not when its parent was
const nowIso = (): string => new Date().toISOString();

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
  /** Which of the condition's totals this row divides. "seam_lf" is the
   * FIGURED roll-layout seam length (weld rod, seam tape — where two cuts meet
   * on the floor), not a share of the perimeter: it reads 0 until the
   * condition carries a roll_setup and has committed floor shapes to lay out,
   * which is the honest answer rather than a guess. */
  basis: "area" | "linear" | "count" | "seam_lf";
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
  method: "manual" | "one_click_v1" | "agent_v1" | "symbol_sweep" | "rule_v1" | "cutout_v1";
  /** Omitted = human. "agent" = the shape was produced by MCP/automation.
   * "rule" = minted by a correction rule's deterministic re-run (#88/#207) —
   * the canvas's own third actor, kept distinct so capture and the marked-set
   * split can tell a taught rule from a fresh agent guess. */
  actor?: "agent" | "rule";
  /** A human affirmed this shape at an explicit review gate. */
  reviewed?: boolean;
  /** one_click: the flood-fill seed, normalized to sheet dims. */
  seed_norm?: [number, number];
  hatch_filtered?: true;
  /** one_click: the seal ladder bridged a drafting pinhole this many px wide
   * to close the region (engine `gapBridged` — canvas parity: the rescue rides
   * provenance rather than passing itself off as a clean fill). */
  gap_bridged_px?: number;
  /** one_click (RFC #60 item D): the trace scored 0–1 from the engine's own
   * signals — sealed openings, door wedges, the minimum-passage rule, hatch
   * escalation tier, raster boundary, mask coarseness, implausible size. A
   * review PRIORITIZER, never a verification: 1.0 means every signal came
   * back clean, not that the trace is right. Stamped centrally in commit()
   * from the flood evidence, so no flood commit path can ship unscored. */
  confidence?: number;
  /** The named factors behind a sub-1.0 confidence (confidence.ts vocabulary,
   * e.g. "sealed-opening(10% synthetic boundary)") — absent when none fired. */
  confidence_factors?: string[];
  /** one_click (RFC #60): the seal ladder closed a genuine OPENING this many
   * mask px wide (a doorway-scale gap, distinct from gap_bridged_px's
   * pinhole rescue) — the synthetic boundary share deducts confidence. */
  gap_sealed_px?: number;
  /** one_click (RFC #60): the feet-true minimum-passage rule ran at this
   * dilation radius AND changed the answer — present only with
   * min_pass_delta, the fraction of the verbatim flood it removed. */
  min_pass_px?: number;
  min_pass_delta?: number;
  /** one_click (RFC #60): arc-cluster wedges annexed into the region under
   * grow-but-verify — the count of doorways whose swing was included. */
  door_wedges?: number;
  /** one_click (RFC #60 / audit F7g): of those wedges, how many were a CLOSED
   * ring's interior (round column, callout bubble) rather than a door swing —
   * annexed floor the operator may want as a deduct instead. */
  ring_interiors?: number;
  /** one_click (#85): the flood ran against a mask whose boundary was STATED
   * by the sheet's PDF layers (visible boundary/structure roles present) —
   * categorically stronger evidence than a pitch-heuristic boundary. */
  layer_bounded?: true;
  raster_traced?: true;
  fill_sensitivity?: number;
  /** A linear shape derived from committed floor shapes rather than traced.
   *
   * derive_base (#148): from ONE room's perimeter — the source, the gross
   * figure, and the openings the agent STATED (its claim to make; the tool
   * never guesses doors).
   *
   * derive_transitions (#202): from where TWO rooms meet — both parents, the
   * two finish tags, and the measured gap. `case` is always "butt" on a
   * committed shape: a wall-separated run is a question, and questions do not
   * become shapes. */
  derived?:
    | { from_shape_id: string; gross_lf: number; openings_lf: number }
    | { between_shape_ids: string[]; between: string[]; case: "butt"; gap_in: number };
  /** rule_v1 (#88/#207): the correction rule that minted this deduct, the
   * estimator's seed correction it re-ran, and the room it landed in — the
   * same three-way citation the canvas's Apply stamps. */
  rule_id?: string;
  seed_shape_id?: string;
  container_shape_id?: string;
  /** cutout_v1 (#137/#206): the parent this deduct cut, and the parent's
   * frozen pre-cut snapshot — the same durable pair the canvas stamps
   * (resolveCutout), so delete can revert the cut after the journal is gone. */
  cuts_shape_id?: string;
  parent_prev?: CutoutParentPrev;
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
   * symmetry-group element it matched under). Phase 2 adds `seed`, WHERE the
   * fingerprint came from: "instance" = an example marqueed on a plan sheet
   * (phase 1's contract); "detail_sheet" = marqueed on a non-plan reference
   * sheet (its role recorded — that sheet defines the symbol and is excluded
   * from counting); "schedule_row" = anchored from a schedule row's drawn tag,
   * with the row citation riding along. */
  symbol?: {
    score: number;
    rotation: number;
    mirrored: boolean;
    seed?: {
      source: "instance" | "detail_sheet" | "schedule_row";
      sheet: string;
      role?: string;
      row?: { sheet: string; key: string; table: string };
    };
  };
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
  /** The room (or phase, or area) this shape belongs to — the canvas's
   * per-shape label (#112, web/src/lib/shapeLabels.js), which is what the
   * Report groups by and what the workbook's floor × room tab reads. Optional
   * because a shape without one is legitimate ("unlabeled" is a real bucket);
   * absent, never "". detect_rooms stamps the room number it traced from, so a
   * batch detection arrives already sliced by room instead of as one
   * undifferentiated pile of square feet. */
  label?: string;
  /** cut_out (#137/#206): a floor_area parent's reconciled hole rings — the
   * REAL geometry the boolean subtract produced, netted into `computed` at
   * cut time. Same field the canvas stores (shapeCommands' cutout). */
  verts_norm_holes?: [number, number][][];
  /** cut_out (#137/#206): set on a deduct that was reconciled INTO a parent
   * as a real hole — totals.js skips it (the parent's computed already nets
   * the hole), and delete restores the parent it cut. */
  cuts_shape_id?: string;
  origin?: ShapeOrigin;
}

/** The frozen pre-cut snapshot of a cutout parent (canvas resolveCutout's
 * parent_prev) — durable on the deduct's origin, read back by delete. */
export interface CutoutParentPrev {
  verts_norm: [number, number][];
  verts_norm_holes?: [number, number][][];
  computed?: Shape["computed"];
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

/** An RFI — a Request For Information, the register's record (RfiPanel.jsx /
 *  lib/rfi.js). Field-identical to what the canvas's Raise RFI mints, so an
 *  agent-raised one loads in the app's register unchanged. A markup links to
 *  it via markup.rfi_id === rfi.id (one RFI ↔ many markups) and the linked
 *  set is DERIVED from that, never stored twice.
 *
 *  Two additive fields carry what the panel's own records never need:
 *  `origin` — who asked. Every RFI this server mints is
 *    `{actor: "agent", reviewed: false}`: PENDING until an estimator accepts
 *    it in the panel, the same reviewed flag every agent shape carries. An
 *    RFI goes to the architect, so nothing sends without a human; a record
 *    with no origin is the estimator's own.
 *  `deleted` — the tombstone. delete_rfi never removes the record: its number
 *    stays reserved (the register and the marked set keep the gap) and it
 *    prints nowhere. See liveRfis in lib/rfi.js. */
export interface Rfi {
  id: string;
  /** "RFI-001" — nextRfiNumber over EVERY record, tombstones included. */
  number: string;
  created_at?: string;
  subject: string;
  question: string;
  status: "open" | "answered" | "closed" | "void";
  to: string;
  priority: string;
  cost_impact: boolean;
  schedule_impact: boolean;
  /** YYYY-MM-DD opened. */
  date: string;
  response: string;
  /** YYYY-MM-DD, stamped on the transition into answered (the canvas rule). */
  response_date: string;
  sheet_id: string;
  origin?: { actor: "agent" | "estimator"; reviewed?: boolean };
  /** ISO-8601, resolve_rfi's own stamp beside the canvas's date-only field. */
  resolved_at?: string;
  resolved_by?: "agent";
  deleted?: true;
  deleted_at?: string;
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

/** What a flood commit path hands commit() so the central provenance stamp
 * (floodStamp) can score and record it — scalars only, never the region
 * bitmap (see floodEvidence). */
interface FloodEvidence {
  signals: Omit<ConfidenceInput, "areaSF">;
  raster: boolean;
  gapBridged?: number;
  ringWedges?: number;
}

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
  /** scale gate — agent proposes, human confirms. set_scale is the AGENT
   * surface, so a scale set here is false until a human confirms it in the
   * canvas (the flag rides export/import). undefined = confirmed: a human's
   * own canvas act, or a payload that predates the flag. */
  scaleConfirmed?: boolean;
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

/** get_sheet_vectors paging defaults (#367) — the raw extractor output is the
 * densest payload the server emits (a dense E-size sheet runs to hundreds of
 * thousands of segments), so the page size is declared, the ceiling is hard,
 * and every reply carries offset + returned + dropped === total. */
export const VECTORS_DEFAULT_LIMIT = 20000;
export const VECTORS_LIMIT_CEIL = 100000;

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

/** Per-segment subpath ordinal (#367): the extractor states subpaths as
 * contiguous index RANGES (one entry per figure); a wire reader wants the
 * inverse — which figure each segment belongs to. −1 = outside every range.
 * Built once per geometry and cached by identity, like the sheet's mask. */
const subpathIndexCache = new WeakMap<VectorGeometry, Int32Array>();
function subpathIndex(geo: VectorGeometry): Int32Array {
  let idx = subpathIndexCache.get(geo);
  if (idx) return idx;
  idx = new Int32Array(geo.segs.length >> 2).fill(-1);
  (geo.subpaths || []).forEach((sp, k) => { for (let i = sp.i0; i < sp.i1; i++) idx[i] = k; });
  subpathIndexCache.set(geo, idx);
  return idx;
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
  | { op: "materials"; tool: string; condition_id: string; before: MaterialRow[]; dropped_before?: string[];
      family?: { condition_id: string; before: MaterialRow[]; dropped_before?: string[] }[] }
  | { op: "condition"; tool: string; condition_id: string; before: { waste_pct: number; multiplier: number; height_ft?: number; roll_setup?: Record<string, unknown> } }
  | { op: "duplicate_condition"; tool: string; condition_id: string; parent_id: string; parent_had_family: boolean }
  | { op: "split_condition"; tool: string; condition_id: string; before: { variant_of?: string; materials?: unknown; materials_dropped?: string[] } }
  | { op: "approval"; tool: string; inverse: ApprovalCommand }
  // cut_out (#206): one entry per cut — undo removes the deduct AND restores
  // the parent's pre-cut snapshot together, the canvas's one-gesture rule
  | { op: "cutout"; tool: string; deduct_id: string; parent_id: string; parent_prev: CutoutParentPrev }
  // deleting a reconciled deduct (#206): undo re-seats the deduct at its index
  // and puts the parent's cut state back — the inverse of the revert
  | { op: "cutout_restore"; tool: string; removed: { shape: Shape; index: number }; parent_id: string; parent_after: CutoutParentPrev }
  // cut_out on an open RUN: the run keeps its id and takes what survives; the
  // far side of a middle cut lands as its own shape. Undo puts the run back
  // whole and unmints the far side, one gesture like every cut
  | { op: "runcut"; tool: string; target_id: string; target_prev: CutoutParentPrev; minted_ids: string[] }
  // RFIs (#364): each verb is one entry carrying its exact inverse. A create
  // unmints the record and puts every linked markup's previous rfi_id back; a
  // resolve restores the pre-answer record verbatim; a delete swaps the
  // tombstone back for the record it replaced and re-links its markups.
  // Every op here MUST also appear in outputs.ts undoLastOutput's op enum —
  // the wire validates the reply against it, and a missing member fails the
  // undo call itself (the over-the-wire test is what catches it).
  | { op: "rfi_create"; tool: string; id: string; links: { markup_id: string; prev_rfi_id: string }[] }
  | { op: "rfi_resolve"; tool: string; before: Rfi }
  | { op: "rfi_delete"; tool: string; before: Rfi; unlinked: string[] };

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
  /** The RFI register (#364) — the panel's own records, tombstones included
   * (a withdrawn RFI keeps its number reserved). Read through liveRfis() for
   * anything that prints or exports. */
  rfis: Rfi[] = [];
  /** The last assign-from-schedule run's unresolved rooms (0.9.18) — what the
   * marked-set cover discloses as withheld. Replaced per assign run, cleared
   * with the rest of the session on a non-merge load_plan. Seeds ride
   * normalized so the export-time staleness drop can test them against
   * committed rings in verts_norm space. */
  scheduleWithheld: { sheet_id: string; label: string; reason: string; seed_norm: [number, number] }[] = [];
  /** Correction rules (#207) — imported from a canvas takeoff file, never
   * minted here (a rule IS an estimator's correction by definition; minting
   * stays behind the canvas's human Preview→Apply gate). apply_rules re-runs
   * them; applied_to mirrors the canvas's audit-trail semantics. */
  rules: Rule[] = [];

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
      this.rfis = [];
      this.file = null;
      this.filePath = null;
      this.nextOrd = 1;
      this.scheduleWithheld = [];
      this.rules = [];
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
  async viewSheet(name: string, opts: { region?: { x0: number; y0: number; x1: number; y1: number }; px?: number; overlay?: boolean; grid?: string; marks?: ViewMarks }) {
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
    let marksDrawn = 0;
    const { png, width, height, zoom } = await s.page.renderRegionPng(r, px, (ctx, toCanvas) => {
      if (ppf) drawGrid(ctx as Ctx2D, toCanvas as ToCanvas, r, ppf);
      if (opts.overlay) drawShapes(ctx as Ctx2D, toCanvas as ToCanvas, sheetShapes, s.widthPx, s.heightPx, px);
      // #297 — disclosure marks: what the reply names, the picture shows
      if (opts.marks) marksDrawn = drawMarks(ctx as Ctx2D, toCanvas as ToCanvas, opts.marks, px);
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
        ...(opts.marks ? { marks_drawn: marksDrawn } : {}),
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

  /** get_sheet_vectors (#367): the extractor's own output for a sheet — the
   * array the canvas engine is fed, unclassified and undecimated, so a reader
   * can run its own geometry against exactly what the app sees. Where
   * sheet_context CLASSIFIES (hatch families, longest-first decimation), this
   * verb only PAGES: segments arrive in extraction order, whole, with every
   * per-segment channel the extractor emits (meta byte, luminance, subpath
   * ordinal, layer index). The region test is the same keep test
   * sheet_context uses (a segment intersects the rect, endpoints untouched),
   * so `total` here equals sheet_context's total_in_region for the same rect.
   *
   * Paging is exact by construction: `cursor` is a segment index into the
   * sheet's array, the reply walks forward from it collecting matches until
   * `limit`, and `next_cursor` is the index after the last one kept. The
   * ledger `offset + returned + dropped === total` holds on every page, so a
   * dense sheet never clips silently — a reader either walks the cursor to
   * the end or knows exactly how many segments it never saw. */
  async sheetVectors(name: string, opts: { region?: { x0: number; y0: number; x1: number; y1: number }; limit?: number; cursor?: number }) {
    const s = this.sheet(name);
    const geo = await this.ensureGeometry(s);
    const nSeg = geo.segs.length >> 2;
    if (!nSeg) {
      throw new UserError(`${s.key} has no vector linework — it is a scan (or a flattened raster export), and get_sheet_vectors reads the drawn segments, of which a scan has none. There is nothing to return here: view_sheet renders the region as pixels and is the path on a scan; one_click and detect_rooms still flood it through the raster fallback.`);
    }
    const clampX = (v: number) => Math.max(0, Math.min(v, s.widthPx));
    const clampY = (v: number) => Math.max(0, Math.min(v, s.heightPx));
    const r = opts.region
      ? { x0: clampX(opts.region.x0), y0: clampY(opts.region.y0), x1: clampX(opts.region.x1), y1: clampY(opts.region.y1) }
      : { x0: 0, y0: 0, x1: s.widthPx, y1: s.heightPx };
    if (!(r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1)) {
      throw new UserError(`Empty region — need x1 > x0 and y1 > y0 in image px inside the sheet (${s.widthPx} × ${s.heightPx}).`);
    }
    const limit = opts.limit ?? VECTORS_DEFAULT_LIMIT;
    const cursor = opts.cursor ?? 0;
    if (cursor > nSeg) throw new UserError(`cursor ${cursor} is past the end of ${s.key}'s ${nSeg} segments — cursors come from a previous reply's next_cursor.`);

    // the whole-sheet case needs no test; a region walks every segment once
    const full = !opts.region || (r.x0 === 0 && r.y0 === 0 && r.x1 === s.widthPx && r.y1 === s.heightPx);
    const keep = (i: number): boolean => full || segIntersectsRect(geo.segs[i * 4], geo.segs[i * 4 + 1], geo.segs[i * 4 + 2], geo.segs[i * 4 + 3], r);

    let offset = 0, total = 0;
    const kept: number[] = [];
    let next: number | undefined;
    for (let i = 0; i < nSeg; i++) {
      if (!keep(i)) continue;
      total++;
      if (i < cursor) { offset++; continue; }
      if (kept.length < limit) kept.push(i);
      else if (next === undefined) next = i;
    }

    const subOf = subpathIndex(geo);
    const points: number[] = new Array(kept.length * 4);
    const meta: number[] = new Array(kept.length);
    const lum: number[] = geo.lum ? new Array(kept.length) : [];
    const subpath: number[] = new Array(kept.length);
    const layerOf: number[] = geo.layerOf ? new Array(kept.length) : [];
    kept.forEach((i, k) => {
      points[k * 4] = round2(geo.segs[i * 4]); points[k * 4 + 1] = round2(geo.segs[i * 4 + 1]);
      points[k * 4 + 2] = round2(geo.segs[i * 4 + 2]); points[k * 4 + 3] = round2(geo.segs[i * 4 + 3]);
      meta[k] = geo.meta[i];
      if (geo.lum) lum[k] = geo.lum[i];
      subpath[k] = subOf[i];
      if (geo.layerOf) layerOf[k] = geo.layerOf[i];
    });

    const dropped = total - offset - kept.length;
    const { rasterEligible, vectorViable } = this.rasterPolicy(s, geo);
    return {
      sheet: s.key,
      page: s.pageNum,
      sheet_px: [s.widthPx, s.heightPx],
      region: [round1(r.x0), round1(r.y0), round1(r.x1), round1(r.y1)],
      points, meta, lum, subpath,
      image_area: Math.round(geo.imageArea),
      layer_ids: geo.layerIds || [],
      layer_of: layerOf,
      total, offset, returned: kept.length, dropped,
      limit,
      ...(next !== undefined ? { next_cursor: next } : {}),
      ...(rasterEligible && !vectorViable ? { note: `${s.key} is a scan wrapper: a placed image covers the sheet and these ${nSeg} segments are its frame, not the drawing. The drawing is pixels — view_sheet is the path.` } : {}),
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

  /** The vector mask, built through buildMask's FULL scale-pinned signature
   * (RFC #60 / PR #179 — the canvas's ensureMask, verbatim in intent):
   * `pxPerFt` (the sheet scale as image px per foot) rides INTO the mask, so
   * the hatch pitch cap, the seal radii, door-wedge caps and the minimum-
   * passage rule are all feet-true through `mask.mppf` instead of guessing in
   * raster px; the `page` pin (audit A1/F3) makes the working grid a property
   * of the SHEET in points, never of a render. This server renders at the
   * canvas BASELINE (RENDER_SCALE) always, so renderScale === baseScale and
   * basePxPerFt === pxPerFt — the one degenerate case where the pin and the
   * legacy reconstruction agree bit-for-bit. */
  private buildVectorMask(s: SheetState, geo: VectorGeometry, layersOpt?: { include?: string[]; exclude?: string[] }): MaskObj | null {
    if (!geo.segs.length) return null;
    const pxPerFt = s.upp ? 1 / s.upp : 0;
    return buildMask(geo.segs, s.widthPx, s.heightPx, MASK_MAX_DIM, geo.meta, pxPerFt, pxPerFt,
      { pageW: s.widthPt, pageH: s.heightPt, renderScale: RENDER_SCALE, baseScale: RENDER_SCALE },
      this.rolesFor(s, geo, layersOpt));
  }

  /** v1 masks come from the sheet's vector linework only; a scanned sheet
   * (zero segments) is null here and the measuring tools fall back to
   * ensureRasterMask (#154). Layer roles (#85) ride in as the stated
   * short-circuit; an unlayered sheet builds the identical pre-#85 mask.
   * The cached mask BAKES THE SCALE IN (mppf) — set_scale evicts it. */
  async ensureMask(name: string): Promise<MaskObj | null> {
    const s = this.sheet(name);
    if (s.mask === undefined) {
      const geo = await this.ensureGeometry(s);
      s.mask = this.buildVectorMask(s, geo);
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
    return this.buildVectorMask(s, geo, layersOpt);
  }

  /** The raster-fallback mask (#154): a dedicated render of the sheet at mask
   * scale (the view_sheet machinery — pdf.ts + @napi-rs/canvas), thresholded
   * by the canvas's own rastermask engine into the same MaskObj shape
   * buildMask emits, so the sealed flood (floodAtSeed) and traceRegion run
   * unchanged on scans. It carries NO mppf of its own (pixels cannot know
   * the sheet scale), so flood call sites pass mask px per foot explicitly —
   * ws / upp, the canvas's own raster-path convention — and set_scale evicts
   * this cache alongside the vector mask. Where the optional native canvas
   * never installed, renderRgba throws its plain install-hint Error and the
   * tool reply carries it — a stated inability, never a guessed polygon. */
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
    // Mask-cache eviction on recalibration — canvas parity (rescaleSheet):
    // the vector mask bakes the scale in (its hatch-pitch cap, seal radii,
    // wedge caps and minimum-passage rule are feet-true via mppf), so a mask
    // built against the old calibration is exactly the failure class the
    // scale pinning exists to remove. The raster mask is evicted too, the
    // same call the canvas makes; geometry, snap grid and rendered PNGs are
    // scale-free and stay. Re-picking the identical scale evicts nothing.
    if (s.upp !== upp) {
      s.mask = undefined;
      s.rmask = undefined;
    }
    s.upp = upp;
    // the tool reply keeps this session's source vocabulary; the stored value
    // uses the canvas's report vocabulary so export_report's scale_source
    // reads the same as an app-side report.v1
    s.scaleSource = source === "label" ? "standard" : source === "calibrate" ? "calibrated" : source;
    // Scale gate: this is the agent surface, so the scale lands UNCONFIRMED —
    // quantities still flow (the gate is a flag, never a refusal), but every
    // scaled reply carries the caveat and the canvas asks the estimator to
    // confirm. Only a human act (canvas scale UI) clears it.
    s.scaleConfirmed = false;
    return {
      sheet: s.key, upp, ...(label ? { label } : {}), source, confirmed: false,
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
    // (scale gate: the unconfirmed flag deliberately does NOT ride every
    // measure reply — the agent set the scale itself, so repeating it per
    // quantity is noise. It surfaces where the numbers cross a boundary:
    // set_scale's confirmed:false, takeoff_summary's scale_unconfirmed, the
    // export/report scale_confirmed, and the canvas's confirm affordance.)
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

  /** Slim flood evidence — the engine result's SCALAR signals, harvested the
   * moment the flood returns so a batch sweep never pins N mask-sized region
   * bitmaps just to score confidence at commit time. `signals` goes through
   * floodSignals, THE adapter (audit A2: hand-listed signal fields are how an
   * engine emission goes silently inert); gapBridged/ringWedges ride beside
   * it because they are provenance the adapter does not carry. */
  private static floodEvidence(f: Extract<FloodResult, { status: "ok" }>, raster: boolean, mppf: number): FloodEvidence {
    return {
      signals: floodSignals(f, { raster, mppf }),
      raster,
      ...(f.gapBridged ? { gapBridged: f.gapBridged } : {}),
      ...(f.ringWedges ? { ringWedges: f.ringWedges } : {}),
    };
  }

  /** THE flood → provenance mapping (the canvas Create gate's field set,
   * TakeoffCanvas commitOneClickRegions). One function, spread into the
   * committed origin by commit() and into the tool reply by the flood call
   * sites, so the two surfaces cannot drift and no site hand-lists fields. */
  private static floodStamp(ev: FloodEvidence, areaSF?: number): Partial<ShapeOrigin> {
    const conf = traceConfidence({ ...ev.signals, areaSF });
    const sig = ev.signals;
    return {
      confidence: conf.score,
      ...(conf.factors.length ? { confidence_factors: conf.factors } : {}),
      ...(sig.hatchFiltered ? { hatch_filtered: true as const } : {}),
      ...(sig.sealedPx ? { gap_sealed_px: sig.sealedPx } : {}),
      ...(ev.gapBridged ? { gap_bridged_px: ev.gapBridged } : {}),
      // min-pass fields ride only when the rule CHANGED the answer — the
      // canvas convention (minPassDelta gates minPassPx)
      ...(sig.minPassDelta ? { min_pass_px: sig.minPassPx || 0, min_pass_delta: sig.minPassDelta } : {}),
      ...(sig.wedges ? { door_wedges: sig.wedges } : {}),
      ...(ev.ringWedges ? { ring_interiors: ev.ringWedges } : {}),
      ...(ev.raster ? { raster_traced: true as const } : {}),
    };
  }

  private commit(s: SheetState, tag: string, role: MeasureRole, vertsPx: Point[], computed: Shape["computed"], origin?: Shape["origin"], flood?: FloodEvidence): Shape {
    // Flood provenance + confidence (RFC #60) stamp HERE, exactly where the
    // assignment provenance already stamps: a commit path that hands over its
    // flood evidence gets the full engine account — confidence, sealed
    // openings, door wedges, min-passage — minted onto origin centrally, so
    // no flood commit path can ship an unscored shape.
    if (origin && flood) origin = { ...origin, ...Session.floodStamp(flood, computed.area_sf) };
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
        // the sealed engine with the sheet's own feet-true arguments — the
        // mask carries mppf (buildVectorMask baked the scale in), so
        // floodAtSeed derives the same seal radii / wedge cap / min-passage
        // radius the canvas computes at a click; scale unset degrades to the
        // documented scale-blind fallbacks (a weaker measurement, and the
        // px-only preview reply already says so)
        const r = floodAtSeed(mask, x, y, opts.sensitivity ?? SENS_BALANCED);
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
      // the flood's hatch escalation — and the sensitivity knob with it — is
      // structurally inert here; the default sensitivity rides along. Gap
      // sealing, door wedges and the min-passage rule still apply — faded
      // scan lines are the raster path's own flavor of open doorway — and
      // because buildRasterMask cannot know the sheet scale, mask px per
      // foot is passed explicitly (ws / upp), exactly as the canvas does.
      this.refuseLayersOnRaster(opts.layers);
      const rmask = await this.ensureRasterMask(s);
      const r = floodAtSeed(rmask, x, y, SENS_BALANCED, s.upp ? rmask.ws / s.upp : 0);
      if (r.status === "leak") throw new UserError("That space isn't enclosed on the scan — the fill escaped through a gap (faded line or open doorway). Seed a more enclosed spot, or trace it with measure_polygon.");
      if (r.status !== "ok") throw new UserError("Landed on dense scan ink (text or hatching). Seed an open spot inside the room.");
      f = r;
      raster = true;
    }
    // scalar evidence for the reply and the commit stamp — mppf explicit for
    // the raster path (its MaskObj carries none; audit A2's silent-miss case)
    const ev = Session.floodEvidence(f, raster, s.upp ? f.ws / s.upp : 0);
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
    if (s.upp == null) {
      // preview only — px quantities, never committed without a scale. The
      // engine account (confidence + factors) still rides: signals are
      // signals, though the size deduction can't fire without real units.
      return {
        status: "ok" as const,
        nverts: ring.length,
        ...Session.floodStamp(ev),
        ...(opts.returnVerts ? { verts: ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
        area_px2: round1(areaPx2),
        perimeter_px: round1(perimPx),
        warning: `No scale set for ${s.key} — quantities unavailable. Call set_scale${s.detected ? ` (detected: ${s.detected.label})` : ""}.`,
      };
    }
    const upp = s.upp;
    const area_sf = round2(areaPx2 * upp * upp);
    const perimeter_lf = round2(perimPx * upp);
    // the reply wears the same stamp commit() mints onto origin — one mapping
    // (floodStamp), two surfaces, no drift. Present = disclosed both ways:
    // raster_traced says pixels bounded this trace, gap_sealed_px says the
    // boundary is partly synthetic, confidence says how clean the signals ran.
    const common = {
      status: "ok" as const,
      nverts: ring.length,
      ...Session.floodStamp(ev, area_sf),
      ...(opts.returnVerts ? { verts: ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
    };
    let shape_id: string | undefined;
    if (opts.condition) {
      // actor + reviewed: false — this is a machine-proposed trace no human
      // has affirmed; only an explicit human review gate may set reviewed.
      // Flood provenance (hatch/seal/wedge/min-pass/raster + confidence)
      // stamps centrally in commit() from `ev` — nothing hand-listed here.
      shape_id = this.commit(s, opts.condition, opts.role, ring, { area_sf, perimeter_lf }, {
        method: "one_click_v1",
        actor: "agent",
        seed_norm: [x / s.widthPx, y / s.heightPx],
        reviewed: false,
        // #85 — a trace bounded by DECLARED boundary layers is categorically
        // stronger evidence than one bounded by a pitch heuristic (vector
        // path only: the raster mask never saw the layer table)
        ...(!raster && (s.layers || []).some((l) => l.visible && (l.role === "boundary" || l.role === "structure")) ? { layer_bounded: true as const } : {}),
        // canvas-parity provenance: a non-default fill sensitivity is part of
        // how the shape was made (ShapeOrigin.fill_sensitivity) — vector path
        // only; the knob is inert on a single-tier raster mask
        ...(!raster && opts.sensitivity !== undefined && opts.sensitivity !== SENS_BALANCED ? { fill_sensitivity: opts.sensitivity } : {}),
      }, ev).id;
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
    const withheld = { degenerate: 0, duplicate: 0, bubble: 0, unowned: 0, implausible: 0, unresolved: 0 };
    const unresolved: { label: string; reason: string; area_sf: number; perimeter_lf: number; seed: [number, number] }[] = [];
    type Cand = { label: string; ring: Point[]; areaPx2: number; perimPx: number; seed: readonly [number, number] | number[]; ev: FloodEvidence; merged: string[] };
    const byRing = new Map<string, Cand>();
    const order: Cand[] = [];
    // one mask, one mppf for the whole sweep — the raster mask carries no
    // scale of its own (buildRasterMask cannot know it), so mask px per foot
    // is passed explicitly there, exactly as oneClick does
    const sweepMppf = raster ? (s.upp ? mask.ws / s.upp : 0) : (mask.mppf || 0);
    for (const lb of labels) {
      let ring: Point[] | null = null, ev: FloodEvidence | null = null, seed: [number, number] | null = null;
      let sawBubble = false, sawDegenerate = false, sawUnowned = false;
      for (const probe of seedLadderPx(lb.bbox)) {
        // the sealed engine at each ladder rung — floodAtSeed, the ONE entry
        // point every non-canvas surface floods through (web detectRooms.ts),
        // so a batch detection and a canvas click at the same seed can never
        // measure different square footage again
        const f = floodAtSeed(mask, probe[0], probe[1], opts.sensitivity ?? SENS_BALANCED, sweepMppf);
        if (f.status !== "ok") continue;
        // raster trace differences mirror oneClick (#154): looser eps, no snap
        const r = raster
          ? traceRegion(f, RASTER_RDP_EPS)
          : snapVertices(traceRegion(f), (px, py, d) => (s.snap ? nearestSnap(s.snap, px, py, d) : null), SNAP_TOL);
        if (r.length < 3) { sawDegenerate = true; continue; }
        if (isLabelBubblePx(r as [number, number][], lb.bbox)) { sawBubble = true; continue; }
        // ownership (#373): a rung that steps past the room's wall floods the
        // NEIGHBOURING space or a door pocket — on Dublin A-601 the below-box
        // rung under restroom 110 flooded a 10 SF swing pocket and it would
        // have committed as "110". The flood must surround the label's box
        // (the canvas's own test, floodSurroundsLabelPx) or it is not this
        // label's room; withheld as unowned, never committed under the tag.
        if (!floodSurroundsLabelPx(f, lb.bbox)) { sawUnowned = true; continue; }
        // harvest the scalar evidence now; the region bitmap goes with `f`
        ring = r; ev = Session.floodEvidence(f, raster, sweepMppf); seed = probe;
        break;
      }
      if (!ring || !ev || !seed) {
        if (sawBubble && !sawUnowned) withheld.bubble++;   // only its own bubble ever flooded clean
        else if (sawUnowned) withheld.unowned++;             // every clean flood was some other space's
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
        seed, ev, merged: [],
      };
      byRing.set(key, cand);
      order.push(cand);
    }

    const upp = s.upp;
    const rooms = order
      .map((c) => {
        if (upp == null) {
          // px-only preview — the engine account still rides (see oneClick)
          return {
            label: c.label,
            nverts: c.ring.length,
            ...(c.merged.length ? { merged_labels: c.merged } : {}),
            ...Session.floodStamp(c.ev),
            ...(opts.returnVerts ? { verts: c.ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
            area_px2: round1(c.areaPx2), perimeter_px: round1(c.perimPx),
          };
        }
        const area_sf = round2(c.areaPx2 * upp * upp);
        if (area_sf < minAreaSf) { withheld.implausible++; return null; }
        const perimeter_lf = round2(c.perimPx * upp);
        // the same stamp commit() mints onto origin (floodStamp — confidence,
        // sealed openings, door wedges, min-passage, raster), per room
        const common = {
          label: c.label,
          nverts: c.ring.length,
          ...(c.merged.length ? { merged_labels: c.merged } : {}),
          ...Session.floodStamp(c.ev, area_sf),
          ...(opts.returnVerts ? { verts: c.ring.map(([vx, vy]) => [round1(vx), round1(vy)]) } : {}),
        };
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
          // flood provenance + confidence stamp centrally in commit() from
          // the harvested evidence — nothing hand-listed here (audit A2)
          const shape = this.commit(s, tag, opts.role, c.ring, { area_sf, perimeter_lf }, {
            method: "one_click_v1",
            actor: "agent",
            seed_norm: [c.seed[0] / s.widthPx, c.seed[1] / s.heightPx],
            reviewed: false,
            ...(assignment ? { assignment } : {}),
          }, c.ev);
          // The room number this ring was traced FROM becomes the shape's
          // label — the same field the canvas's room/phase grouping reads. A
          // sweep that knows it flooded room 134 and then reports 40 anonymous
          // areas has thrown away the one thing that makes the total auditable
          // room by room, and no downstream reader can recover it.
          shape.label = c.label;
          shape_id = shape.id;
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
    const withheldTotal = withheld.degenerate + withheld.duplicate + withheld.bubble + withheld.unowned + withheld.implausible + withheld.unresolved;
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
        ? { note: `${withheldTotal} seed(s) withheld — ${withheld.duplicate} duplicate region(s), ${withheld.bubble} label-bubble(s), ${withheld.unowned} unowned (every clean flood was a neighbouring space or door pocket — one_click inside the room), ${withheld.implausible} under ${minAreaSf} SF, ${withheld.degenerate} untraceable${assign ? `, ${withheld.unresolved} unresolved against the schedule (see unresolved[])` : ""}.` }
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

  /** apply_rules (#207): re-run the correction rules an estimator taught the
   * canvas (#88). Rules arrive with import_takeoff — they are never minted
   * here, because a rule IS an estimator's correction by definition and the
   * v1 predicate's known label-box false-positive stays safe behind the
   * canvas's human Preview→Apply gate. Evaluation is the same pure rules.ts
   * engine the canvas Preview runs; the commit is the one batch the canvas's
   * Apply makes (ONE journal entry, undo_last takes it all back). Everything
   * lands reviewed: false — this server has no review gate — and the reply's
   * per-rule disclosure IS the preview an agent gets. Idempotent by
   * construction: the engine drops any candidate an existing deduct already
   * covers, and rule N's mints are rule N+1's dedup targets, exactly like
   * consecutive Applies on the canvas. */
  async applyRules(opts: { sheet?: string } = {}) {
    if (!this.rules.length) {
      throw new UserError("No rules in this session — rules ride import_takeoff from a canvas file (an estimator's taught corrections, #88). Minting new rules is the canvas's job; this verb only re-runs what a human already taught.");
    }
    const activeCondIds = new Set(this.rules.filter((r) => r.active).map((r) => r.seed_condition_id));
    const sheetKeys = opts.sheet
      ? [this.sheet(opts.sheet).key]
      : [...new Set(this.shapes
          .filter((x) => x.measure_role === "floor_area" && activeCondIds.has(x.condition_id))
          .map((x) => x.sheet_id))];
    const skipped_sheets: { sheet_id: string; reason: "no_scale" | "no_vector_mask" }[] = [];
    const sheetData = new Map<string, SheetRuleData>();
    for (const key of sheetKeys) {
      const s = this.sheet(key);
      if (!(s.upp && s.upp > 0)) { skipped_sheets.push({ sheet_id: key, reason: "no_scale" }); continue; }
      const mask = await this.ensureMask(key);
      if (!mask) { skipped_sheets.push({ sheet_id: key, reason: "no_vector_mask" }); continue; }
      sheetData.set(key, { mask, upp: s.upp, imgW: s.widthPx, imgH: s.heightPx });
    }
    const rulesOut: { rule_id: string; label: string; condition: string; produced: number; shape_ids: string[]; deduct_sf: number }[] = [];
    const skipped_rules: { rule_id: string; label: string; reason: "inactive" | "condition_not_in_session" }[] = [];
    for (const rule of this.rules) {
      if (!rule.active) { skipped_rules.push({ rule_id: rule.id, label: rule.label, reason: "inactive" }); continue; }
      const cond = this.conditions.find((c) => c.id === rule.seed_condition_id);
      if (!cond) { skipped_rules.push({ rule_id: rule.id, label: rule.label, reason: "condition_not_in_session" }); continue; }
      const candidates = applyRuleToProject(rule, this.shapes as RuleShape[], sheetData);
      const ids: string[] = [];
      let sf = 0;
      for (const cand of candidates) {
        const d = sheetData.get(cand.sheet_id)!;
        const vertsPx: Point[] = cand.verts_norm.map(([nx, ny]) => [nx * d.imgW, ny * d.imgH]);
        const shape = this.commit(this.sheet(cand.sheet_id), cond.finish_tag, "deduct", vertsPx,
          { area_sf: cand.area_sf, perimeter_lf: round2(closedMetrics(vertsPx).perim * d.upp) }, {
            method: "rule_v1",
            actor: "rule",
            reviewed: false,
            rule_id: rule.id,
            seed_shape_id: rule.seed_shape_id,
            container_shape_id: cand.container_shape_id,
          });
        ids.push(shape.id);
        sf += cand.area_sf;
      }
      // canvas semantics (applyStagedRule): the audit trail is the LAST run's
      // mints — a re-run that produced nothing leaves the prior trail standing
      if (ids.length) rule.applied_to = ids;
      rulesOut.push({ rule_id: rule.id, label: rule.label, condition: cond.finish_tag, produced: ids.length, shape_ids: ids, deduct_sf: round2(sf) });
    }
    this.flushCommits("apply_rules");
    const committed = rulesOut.reduce((n, r) => n + r.produced, 0);
    return {
      rules: rulesOut,
      committed,
      total_deduct_sf: round2(rulesOut.reduce((n, r) => n + r.deduct_sf, 0)),
      skipped_rules,
      skipped_sheets,
      note: committed
        ? "One batch, one undo step, everything reviewed: false — this disclosure is your preview; verify with view_sheet overlay:true. Re-running is idempotent: anything a deduct already covers is dropped by the engine."
        : "No new candidates — every match is already covered by an existing deduct (re-running is idempotent by construction), or the rules' rooms are not on the evaluated sheets.",
    };
  }

  /** cut_out (#206): a REAL hole, reconciled the way the canvas cuts one
   * (#137) — the same lib/cutout.js boolean subtract, so a headless session
   * and the app can never disagree about what a hole holds. The parent's
   * outer ring + existing holes minus the new ring lands back on the parent
   * (verts_norm_holes + netted computed); the deduct commits carrying
   * cuts_shape_id, so totals.js skips it (set subtraction — N cuts compose,
   * overlap never double-deducts). One journal entry: undo_last restores
   * parent and hole together. Refusal over guessing: a cut not FULLY inside
   * the parent refuses (the canvas's edge-clip is a canvas affordance), and
   * a subtract that erases or splits the parent refuses whole. */
  cutOut(opts: { parent_shape_id: string; verts: Point[] }) {
    const parent = this.shapes.find((x) => x.id === opts.parent_shape_id);
    if (!parent) throw new UserError(`No shape with id ${JSON.stringify(opts.parent_shape_id)} — list_shapes for real ids.`);
    if (parent.measure_role === "surface_area" || parent.measure_role === "linear") return this.cutRunOut(parent, opts.verts);
    if (parent.measure_role !== "floor_area") {
      throw new UserError(`cut_out subtracts from an area or clips a run — ${parent.id} is ${parent.measure_role}. A count marker has nothing to cut: delete_shape it.`);
    }
    if (parent.origin?.reviewed === true) {
      throw new UserError(`Shape ${parent.id} was affirmed by a human — reviewed work is ink, and cutting a hole in it would mutate what the estimator signed. Commit an independent deduct with measure_polygon instead.`);
    }
    const s = this.sheet(parent.sheet_id);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    if (opts.verts.length < 3) throw new UserError(`A cut needs at least 3 vertices — got ${opts.verts.length}.`);
    const upp = s.upp;
    const toPx = (ring: [number, number][]): Point[] => ring.map(([nx, ny]) => [nx * s.widthPx, ny * s.heightPx]);
    const toNorm = (ring: number[][]): [number, number][] => ring.map(([x, y]) => [x / s.widthPx, y / s.heightPx]);
    const outerPx = toPx(parent.verts_norm);
    if (!ringFullyInside(outerPx, opts.verts)) {
      throw new UserError("The cut is not fully inside the parent's outer ring. The canvas resolves an edge-crossing cut as a boundary clip; over the wire the rule is refusal-over-guessing — reshape the parent with edit_shape, or commit an independent deduct with measure_polygon.");
    }
    const holesPx = (parent.verts_norm_holes ?? []).map(toPx);
    const r = subtractCutout(outerPx, holesPx, opts.verts);
    if (!r) {
      throw new UserError("The subtract degenerates — this cut would erase the parent or split it into disjoint pieces. That is a re-trace decision, not a hole: measure_polygon the pieces as their own rooms.");
    }
    const parentPrev: CutoutParentPrev = {
      verts_norm: parent.verts_norm.map((v) => [...v] as [number, number]),
      ...(parent.verts_norm_holes ? { verts_norm_holes: parent.verts_norm_holes.map((h) => h.map((v) => [...v] as [number, number])) } : {}),
      ...(parent.computed ? { computed: { ...parent.computed } } : {}),
    };
    const met = closedMetrics(opts.verts);
    const deduct: Shape = {
      id: uid("shp"),
      sheet_id: s.key,
      condition_id: parent.condition_id,
      measure_role: "deduct",
      verts_norm: opts.verts.map(([x, y]) => [x / s.widthPx, y / s.heightPx] as [number, number]),
      // face value for the hover label — totals skip it, the parent nets it
      computed: { area_sf: round2(met.area * upp * upp), perimeter_lf: round2(met.perim * upp) },
      cuts_shape_id: parent.id,
      origin: { method: "cutout_v1", actor: "agent", reviewed: false, cuts_shape_id: parent.id, parent_prev: parentPrev },
    };
    const prevNet = parentPrev.computed?.area_sf ?? 0;
    parent.verts_norm = toNorm(r.outer);
    parent.verts_norm_holes = r.holes.map(toNorm);
    parent.computed = { area_sf: round2(r.area * upp * upp), perimeter_lf: round2(r.perim * upp) };
    this.shapes.push(deduct);
    this.record({ op: "cutout", tool: "cut_out", deduct_id: deduct.id, parent_id: parent.id, parent_prev: parentPrev });
    return {
      deduct_shape_id: deduct.id,
      parent_shape_id: parent.id,
      hole_sf: round2(Math.max(0, prevNet - (parent.computed.area_sf ?? 0))),
      parent_net: { area_sf: parent.computed.area_sf ?? 0, perimeter_lf: parent.computed.perimeter_lf ?? 0 },
      holes: parent.verts_norm_holes.length,
      note: "The parent's computed nets the hole for real (boolean subtract, not arithmetic) — overlap with an earlier cut never double-deducts. One undo step restores parent and hole together; deleting the deduct later reverts the cut too.",
    };
  }

  /** cut_out on an OPEN RUN — wall tile (surface_area) and base/transitions
   * (linear) are polylines traced in plan, not polygons, so the ring CLIPS
   * them instead of subtracting: what falls outside the ring survives, and a
   * cut through the middle leaves the far side as its own shape. Quantities
   * ride the surviving length, which is exact for both roles — wall SF is
   * LF × height, a border's SF is LF × thickness. No deduct receipt is minted:
   * there is no area for one to sit on, and totals would count it against the
   * FLOOR, which is the bug that made this necessary. Refusal over guessing
   * stays: a ring that misses, that swallows the run whole, or that lands on a
   * curved run (whose verts are control points, not the line) refuses and says
   * what to do instead. */
  private cutRunOut(parent: Shape, verts: Point[]) {
    if (parent.origin?.reviewed === true) {
      throw new UserError(`Shape ${parent.id} was affirmed by a human — reviewed work is ink, and clipping it would mutate what the estimator signed.`);
    }
    if ((parent as { curved?: boolean }).curved) {
      throw new UserError(`Shape ${parent.id} is a curved run — its vertices are control points, not the line itself, so clipping them would move the curve. Reshape it with edit_shape.`);
    }
    const s = this.sheet(parent.sheet_id);
    if (s.upp == null) throw new UserError(this.scaleGate(s));
    if (verts.length < 3) throw new UserError(`A cut needs at least 3 vertices — got ${verts.length}.`);
    const upp = s.upp;
    const runPx: Point[] = parent.verts_norm.map(([nx, ny]) => [nx * s.widthPx, ny * s.heightPx]);
    const r = cutRun(runPx, verts);
    if (!r) {
      throw new UserError(`The cut does not cross ${parent.id} — nothing came off it. view_sheet the run's coordinates and place the ring over the stretch you mean to remove.`);
    }
    if (r.kind === "erased") {
      throw new UserError(`That ring covers the whole of ${parent.id}. Removing a run outright is delete_shape, not a cut.`);
    }
    const target_prev: CutoutParentPrev = {
      verts_norm: parent.verts_norm.map((v) => [...v] as [number, number]),
      ...(parent.computed ? { computed: { ...parent.computed } } : {}),
    };
    const wasLf = parent.computed?.perimeter_lf ?? 0;
    const wasSf = parent.computed?.area_sf ?? 0;
    const qty = (lenPx: number) => {
      const lf = round2(lenPx * upp);
      const k = wasLf > 0 ? lf / wasLf : 0;
      return { area_sf: round2(wasSf * k), perimeter_lf: lf };
    };
    const toNorm = (run: number[][]): [number, number][] => run.map(([x, y]) => [x / s.widthPx, y / s.heightPx]);
    const survivors = r.runs ?? [];
    const [head, ...rest] = survivors;
    if (!head) throw new UserError(`That ring covers the whole of ${parent.id}. Removing a run outright is delete_shape, not a cut.`);
    parent.verts_norm = toNorm(head);
    parent.computed = qty(openLen(head));
    const minted: Shape[] = rest.map((piece) => ({
      ...structuredClone(parent),
      id: uid("shp"),
      verts_norm: toNorm(piece),
      computed: qty(openLen(piece)),
    }));
    this.shapes.push(...minted);
    this.record({ op: "runcut", tool: "cut_out", target_id: parent.id, target_prev, minted_ids: minted.map((m) => m.id) });
    const pieces = [parent, ...minted].map((x) => ({ shape_id: x.id, lf: x.computed.perimeter_lf ?? 0, sf: x.computed.area_sf ?? 0 }));
    return {
      shape_id: parent.id,
      measure_role: parent.measure_role,
      pieces,
      removed_lf: round2(Math.max(0, wasLf - pieces.reduce((n, p) => n + p.lf, 0))),
      removed_sf: round2(Math.max(0, wasSf - pieces.reduce((n, p) => n + p.sf, 0))),
      note: minted.length
        ? `The cut fell inside the run, so it comes back in ${pieces.length} pieces — same condition, same height, each measured on its own. One undo_last puts the run back whole.`
        : "The run keeps its id and its condition; only its length (and the SF that rides on it) changed. One undo_last puts it back whole.",
    };
  }

  /** The canvas's cutoutParentPrevSans, ported verbatim in spirit (#206 —
   * "the canvas's answer is the spec"): rebuilding a multi-cut parent after
   * ONE cut is deleted starts from the chain's EARLIEST pristine snapshot and
   * re-subtracts every survivor in commit order. Null when the rebuild can't
   * be trusted — the caller falls back to a plain delete that leaves the cut
   * baked in, never reverts over survivors. */
  private cutoutParentPrevSans(doomed: Shape): CutoutParentPrev | null {
    const chain = this.shapes.filter((x) => x.cuts_shape_id === doomed.cuts_shape_id && x.origin?.parent_prev);
    const rest = chain.filter((x) => x.id !== doomed.id);
    if (!rest.length) return doomed.origin!.parent_prev!;
    const parent = this.shapes.find((x) => x.id === doomed.cuts_shape_id)!;
    const s = this.sheet(parent.sheet_id);
    if (s.upp == null) return null;
    const upp = s.upp;
    const px = (ring: [number, number][]): Point[] => ring.map(([nx, ny]) => [nx * s.widthPx, ny * s.heightPx]);
    const base = chain[0].origin!.parent_prev!;
    const r = recomposeCutouts(px(base.verts_norm), (base.verts_norm_holes ?? []).map(px), rest.map((x) => px(x.verts_norm)));
    if (!r) return null;
    const norm = (ring: number[][]): [number, number][] => ring.map(([x, y]) => [x / s.widthPx, y / s.heightPx]);
    return {
      verts_norm: norm(r.outer),
      ...(r.holes.length ? { verts_norm_holes: r.holes.map(norm) } : {}),
      computed: { area_sf: round2(r.area * upp * upp), perimeter_lf: round2(r.perim * upp) },
    };
  }

  /** Write a cutout snapshot back onto a parent — the one place the restore
   * shape is defined, used by undo and by delete's revert. */
  private static restoreCutoutSnapshot(p: Shape, snap: CutoutParentPrev): void {
    p.verts_norm = snap.verts_norm.map((v) => [...v] as [number, number]);
    if (snap.verts_norm_holes) p.verts_norm_holes = snap.verts_norm_holes.map((h) => h.map((v) => [...v] as [number, number]));
    else delete p.verts_norm_holes;
    if (snap.computed) p.computed = { ...snap.computed };
  }

  /** Mint the transition where two finishes meet (#202) — the derivation that
   * follows derive_base, and the one an estimator draws by hand on every job.
   *
   * The geometry lives in web/src/lib/transitions.ts, and its headline is that
   * flood-traced rooms DO NOT SHARE EDGES: a partition puts four to eight
   * inches between two rings, so what is actually there is proximity, in two
   * flavours that mean different things. A BUTT JOINT (the rings run together
   * inside one open space) is the transition, and commits. A WALL-SEPARATED run
   * means the rooms are adjacent across a partition — the transition there is a
   * threshold in the DOORWAY, and nothing in the trace record says where the
   * doorway is: the flood engine seals openings and reports only how much
   * boundary it synthesised, never where. Committing thirty-four feet of
   * threshold because two rooms share thirty-four feet of wall would be a wrong
   * bid with a machine's confidence behind it, so those come back in
   * `withheld` — length, gap, and a point to look at — as questions.
   *
   * All-or-nothing like derive_base: unknown tags, a transition landing on
   * either source tag, or an unscaled sheet refuses the whole call before
   * anything commits. The sweep is ONE journal gesture. */
  deriveTransitions(opts: { condition_a: string; condition_b: string; condition: string; max_gap_in?: number; min_run_in?: number }) {
    const findCond = (tag: string) => {
      const c = this.conditions.find((x) => x.finish_tag === tag);
      if (!c) throw new UserError(`No condition ${JSON.stringify(tag)} — tags: ${this.conditions.map((x) => x.finish_tag).join(", ") || "(none)"}.`);
      return c;
    };
    const a = findCond(opts.condition_a), b = findCond(opts.condition_b);
    if (a.id === b.id) throw new UserError("condition_a and condition_b must be different finishes — a tag does not transition to itself.");
    if (opts.condition === a.finish_tag || opts.condition === b.finish_tag) {
      throw new UserError(`The transition must land on its OWN tag (e.g. 'T-1') — committing onto ${opts.condition} would add its LF to one of the finishes it separates.`);
    }
    const maxGapIn = opts.max_gap_in ?? 12;
    const minRunIn = opts.min_run_in ?? 12;
    if (!(maxGapIn > 0)) throw new UserError("max_gap_in must be > 0.");
    if (!(minRunIn > 0)) throw new UserError("min_run_in must be > 0.");

    const floors = (c: typeof a) => this.shapes.filter((x) => x.condition_id === c.id && x.measure_role === "floor_area");
    const fa = floors(a), fb = floors(b);
    for (const [tag, list] of [[a.finish_tag, fa], [b.finish_tag, fb]] as const) {
      if (!list.length) throw new UserError(`${tag} has no floor_area shapes to derive from — commit rooms first (one_click / detect_rooms).`);
    }
    // a run is only measurable in FEET, so every sheet in play needs its scale
    // before anything is compared — the derive_base refusal, one step earlier
    const sheetsInPlay = [...new Set([...fa, ...fb].map((s) => s.sheet_id))];
    for (const key of sheetsInPlay) {
      const s = this.sheet(key);
      if (s.upp == null) throw new UserError(`${key} has no scale — a transition is a real length, so set_scale first (${this.scaleGate(s)})`);
    }

    // the sheet/pair sweep, the sampling opts and the butt-vs-wall decision are
    // deriveTransitionRuns' — one orchestration, driven by the canvas and this
    // verb alike (the #208 fold). This side keeps the store: refusals above,
    // the journal commit below, and the wire rows the schema promises.
    const frames = new Map<string, SheetFrame>();
    for (const key of sheetsInPlay) {
      const s = this.sheet(key);
      frames.set(key, { widthPx: s.widthPx, heightPx: s.heightPx, upp: s.upp! });
    }
    const src = (sh: typeof fa[number]): TransitionSourceShape => ({ id: sh.id, sheet_id: sh.sheet_id, verts_norm: sh.verts_norm });
    const derived = deriveTransitionRuns(
      { tag: a.finish_tag, shapes: fa.map(src) },
      { tag: b.finish_tag, shapes: fb.map(src) },
      frames,
      { max_gap_in: maxGapIn, min_run_in: minRunIn },
    );

    const committed: any[] = [], withheld: any[] = [];
    for (const w of derived.withheld) {
      withheld.push({
        sheet: w.sheet_id, between_shape_ids: w.between_shape_ids, length_lf: w.length_lf, gap_in: w.gap_in, at: w.at,
        reason: "wall_separated",
        detail: `${a.finish_tag} and ${b.finish_tag} run ${w.length_lf} LF apart across ${w.gap_in}" of wall — adjacent rooms, not a butt joint. If a door opens here the transition is a threshold at the door, which this cannot see.`,
      });
    }
    for (const r of derived.runs) {
      const s = this.sheet(r.sheet_id);
      const pathPx = r.verts_norm.map(([x, y]) => [x * s.widthPx, y * s.heightPx] as Point);
      const shape = this.commit(s, opts.condition, "linear", pathPx, { area_sf: 0, perimeter_lf: r.length_lf }, {
        method: "agent_v1",
        actor: "agent",
        reviewed: false,
        derived: { between_shape_ids: r.between_shape_ids, between: [a.finish_tag, b.finish_tag], case: "butt", gap_in: r.gap_in },
      });
      committed.push({ sheet: r.sheet_id, between_shape_ids: r.between_shape_ids, length_lf: r.length_lf, gap_in: r.gap_in, at: r.at, shape_id: shape.id });
    }
    if (committed.length) this.flushCommits("derive_transitions");
    return {
      condition: opts.condition,
      between: [a.finish_tag, b.finish_tag],
      committed: committed.length,
      total_lf: round2(committed.reduce((n, r) => n + r.length_lf, 0)),
      runs: committed,
      withheld,
      withheld_lf: round2(withheld.reduce((n, r) => n + r.length_lf, 0)),
      note: withheld.length
        ? `${withheld.length} run(s) are adjacency ACROSS A WALL, not a butt joint — the transition there is a threshold in the doorway, and the trace record does not say where the doorway is. view_sheet each \`at\` and place them with measure_line / place_count.`
        : "Every run was a butt joint inside one open space. Verify with view_sheet overlay:true before trusting the total.",
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
  /** count_marks — the deterministic census, the whole count takeoff in ONE
   * call: every VALUE-ANNOTATED mark tag on the plan sheets, counted per
   * schedule mark, committed as EA markers, residue disclosed.
   *
   * The identity rule is the annotated-device drafting pattern: a device is
   * drawn with its mark tag and a value under it ("S1" over "200" — CFM, GPM,
   * a fixture count). Tag text WITH a paired value counts; a tag inside a
   * schedule table's own region is a row label and is excluded; everything
   * else is WITHHELD with a reason and coordinates — a tag amid linework but
   * unvalued may be a real device (look), a bare tag is probably a note. A
   * mark drawn ON its marker with no value is sweep_schedule_row's family,
   * not this one. Refusal-honest throughout: scans refuse (no text layer),
   * a set with no mark-shaped schedule rows refuses unless the marks are
   * stated, and non-plan sheets are skipped with the role that excused them. */
  async countMarks(opts: { marks?: string[]; commit?: boolean } = {}) {
    const graph = await this.ensureGraph();
    if (!graph.available) {
      throw new UserError("This set has no text layer (a scan) — the census reads drawn tag text, so it cannot run. Marquee one device with symbol_sweep instead.");
    }
    const canon = (k: string) => (k || "").trim().toUpperCase().replace(/\s+/g, "");
    const MARK_RE = /^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/;

    // mark vocabulary: stated, or read off the schedule tables' row keys —
    // a compound key ("R1 / E1") contributes each of its marks
    type RowCite = { sheet: string; key: string; table: string };
    const rowCite = new Map<string, RowCite>();
    for (const tb of graph.tables) {
      const table = tb.title?.text || `${tb.kind} schedule`;
      for (const row of tb.rows) {
        for (const part of canon(row.key).split("/").filter(Boolean)) {
          if (!rowCite.has(part)) rowCite.set(part, { sheet: tb.sheet, key: row.key, table });
        }
      }
    }
    let marks: string[];
    if (opts.marks?.length) {
      marks = [...new Set(opts.marks.map(canon).filter(Boolean))];
    } else {
      marks = [...rowCite.keys()].filter((k) => MARK_RE.test(k)).sort();
      if (!marks.length) {
        throw new UserError('No mark-shaped schedule row keys in the set to census — state the marks yourself: count_marks { marks: ["S1", "R1"] }.');
      }
    }

    // plan-role sheets only (the sheet graph decides), skips disclosed
    const roleOf = new Map(graph.sheets.map((g) => [g.key, g.role] as const));
    const skipped: { sheet: string; role: string; reason: string }[] = [];
    const planSheets: SheetState[] = [];
    for (const sh of this.sheetList()) {
      const role = roleOf.get(sh.key) ?? "unknown";
      if (role === "plan") planSheets.push(sh);
      else {
        skipped.push({
          sheet: sh.key, role,
          reason: role === "unknown"
            ? "role unknown (no classifiable title text) — tags here are not censused"
            : `a ${role} sheet — tags here are reference text, never installed work`,
        });
      }
    }
    if (!planSheets.length) {
      throw new UserError("No plan-role sheet in the set — the census counts installed work, and every sheet classified as schedule/legend/detail/unknown. sheet_graph shows each sheet's role and evidence.");
    }

    // a tag inside a schedule table's own region is that table's row label
    const tableRegions = new Map<string, Bbox[]>();
    for (const tb of graph.tables) {
      const arr = tableRegions.get(tb.sheet) ?? [];
      arr.push(tb.region);
      tableRegions.set(tb.sheet, arr);
    }

    const VAL_RE = /^[0-9][0-9,]{0,6}$/;
    type Hit = { at: Point; value: string; sheet: string };
    type WithheldOcc = { at: Point; sheet: string; reason: string };
    const perMark = new Map<string, { counted: Hit[]; withheld: WithheldOcc[] }>();
    for (const m of marks) perMark.set(m, { counted: [], withheld: [] });
    let excludedInTables = 0;
    const perSheetRows: { sheet: string; counts: Record<string, number> }[] = [];

    for (const sh of planSheets) {
      if (!sh.spans) sh.spans = textSpans(sh.page);
      const regions = tableRegions.get(sh.key) ?? [];
      const values = sh.spans.filter((sp) => VAL_RE.test(sp.str.trim()));
      const counts: Record<string, number> = {};
      let segs: ArrayLike<number> | null = null; // lazy — only withheld occurrences look at linework
      for (const m of marks) {
        const rec = perMark.get(m)!;
        for (const sp of sh.spans) {
          if (canon(sp.str) !== m) continue;
          const cx = (sp.x0 + sp.x1) / 2, cy = (sp.y0 + sp.y1) / 2;
          const h = Math.max(sp.y1 - sp.y0, 6);
          if (regions.some((r) => cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3])) { excludedInTables++; continue; }
          const paired = values.find((v) =>
            Math.abs((v.x0 + v.x1) / 2 - cx) <= Math.max(sp.x1 - sp.x0, 1.5 * h) &&
            v.y0 >= sp.y1 - 0.4 * h && v.y0 <= sp.y1 + 2.4 * h);
          if (paired) {
            rec.counted.push({ at: [round1(cx), round1(cy)], value: paired.str.trim(), sheet: sh.key });
            counts[m] = (counts[m] || 0) + 1;
          } else {
            if (segs === null) segs = (await this.ensureGeometry(sh)).segs;
            const pad = 2.5 * h;
            const bx0 = sp.x0 - pad, by0 = sp.y0 - pad, bx1 = sp.x1 + pad, by1 = sp.y1 + pad;
            let n = 0;
            for (let i = 0; i + 3 < segs.length && n < 3; i += 4) {
              if (segs[i] >= bx0 && segs[i] <= bx1 && segs[i + 1] >= by0 && segs[i + 1] <= by1 &&
                  segs[i + 2] >= bx0 && segs[i + 2] <= bx1 && segs[i + 3] >= by0 && segs[i + 3] <= by1) n++;
            }
            rec.withheld.push({
              at: [round1(cx), round1(cy)], sheet: sh.key,
              reason: n >= 3
                ? "tag amid linework but no paired value — may be a device labeled without one, or a legend/detail reference; look before counting it"
                : "bare tag text — no paired value, no adjacent linework; likely a note mention, not an instance",
            });
          }
        }
      }
      perSheetRows.push({ sheet: sh.key, counts });
    }

    // commit — every counted occurrence as one EA marker under its mark's own
    // tag, the schedule citation on origin where a row answers for the mark;
    // the WHOLE census is one undo step
    const committedByMark: Record<string, { committed: number; ea_total: number }> = {};
    if (opts.commit) {
      for (const m of marks) {
        const rec = perMark.get(m)!;
        if (!rec.counted.length) continue;
        const cite = rowCite.get(m);
        let n = 0;
        for (const occ of rec.counted) {
          this.commit(this.sheet(occ.sheet), m, "count", [occ.at], { count: 1 }, {
            method: "manual", actor: "agent", reviewed: false,
            ...(cite ? { assignment: { source: "schedule", schedule_sheet: cite.sheet } } : {}),
          });
          n++;
        }
        const c = this.conditions.find((x) => x.finish_tag === m)!;
        const ea_total = this.shapes
          .filter((x) => x.condition_id === c.id && x.measure_role === "count")
          .reduce((t2, x) => t2 + (x.computed.count || 1), 0);
        committedByMark[m] = { committed: n, ea_total };
      }
      if (Object.keys(committedByMark).length) this.flushCommits("count_marks");
    }

    const cap = <T,>(a: T[], n: number): { list: T[]; elided: number } =>
      a.length > n ? { list: a.slice(0, n), elided: a.length - n } : { list: a, elided: 0 };
    return {
      marks: marks.map((m) => {
        const rec = perMark.get(m)!;
        const cite = rowCite.get(m);
        const c = cap(rec.counted, 150);
        const w = cap(rec.withheld, 60);
        return {
          mark: m,
          count: rec.counted.length,
          ...(cite ? { row: cite } : { unscheduled: true }),
          occurrences: c.list,
          ...(c.elided ? { occurrences_elided: c.elided } : {}),
          withheld: w.list,
          ...(w.elided ? { withheld_elided: w.elided } : {}),
          ...(committedByMark[m] ? { committed: committedByMark[m] } : {}),
        };
      }),
      total: [...perMark.values()].reduce((n, r) => n + r.counted.length, 0),
      per_sheet: perSheetRows,
      ...(excludedInTables ? { excluded_in_tables: excludedInTables } : {}),
      skipped,
      complete: true,
    };
  }

  /** #308 — resolve the drawing's own tag for a sweep's placements. Pure
   * resolution lives in web/src/lib/symbollabels.ts (shared with the canvas
   * Symbol tool, #264); this just lines the answers back up with the rows
   * they belong to. */
  private sweepLabels(spans: TextSpan[], geo: { segs: number[]; lum?: Uint8Array }, seedCenter: Point | null, matches: SweepMatch[], withheld: SweepWithheld[]) {
    const centers: Point[] = [...(seedCenter ? [seedCenter as Point] : []), ...matches.map((m) => m.at), ...withheld.map((w) => w.at)];
    const named = labelPlacements(centers, spans, geo.segs, geo.lum);
    const off = seedCenter ? 1 : 0;
    return {
      seed: seedCenter ? named[0] : null,
      matches: named.slice(off, off + matches.length),
      withheld: named.slice(off + matches.length),
    };
  }

  private static labelFields(l: PlacementLabel | null | undefined): { label?: string; label_via?: "adjacent" | "leader" } {
    return l ? { label: l.label, label_via: l.via } : {};
  }

  /** The label findings worth a sentence, in both directions (#308): a match
   * with no label in a labeled family is a shape-only count to look at; a
   * withheld row carrying the seed's own tag is the drawing vouching for it;
   * a withheld row carrying a different tag is a sibling fixture, answered. */
  private static sweepLabelNote(lbl: { seed: PlacementLabel | null; matches: (PlacementLabel | null)[]; withheld: (PlacementLabel | null)[] }): string | null {
    const parts: string[] = [];
    const seedTag = lbl.seed?.label;
    const anyLabeled = !!seedTag || lbl.matches.some(Boolean);
    const unlabeledMatches = lbl.matches.filter((l) => !l).length;
    if (anyLabeled && unlabeledMatches) {
      parts.push(`${unlabeledMatches} committed match(es) carry NO label while this family is labeled${seedTag ? ` (the seed reads "${seedTag}")` : ""} — counted on shape alone; view_sheet them before trusting the total.`);
    }
    if (seedTag) {
      const diffMatches = [...new Set(lbl.matches.filter((l): l is PlacementLabel => !!l && l.label !== seedTag).map((l) => l.label))];
      if (diffMatches.length) parts.push(`Committed match(es) the drawing names differently (${diffMatches.join(", ")}) — the geometry matched but the tag disagrees; check they belong in this count, or exclude one as a counter-example.`);
      const same = lbl.withheld.filter((l) => l && l.label === seedTag).length;
      const others = [...new Set(lbl.withheld.filter((l): l is PlacementLabel => !!l && l.label !== seedTag).map((l) => l.label))];
      if (same) parts.push(`${same} withheld placement(s) carry the seed's own tag "${seedTag}" — the drawing says they are real; look, then place_count.`);
      if (others.length) parts.push(`Withheld placements the drawing names differently (${others.join(", ")}) are sibling fixtures, not missed counts.`);
    }
    return parts.length ? parts.join(" ") : null;
  }

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

  /** The seed→target size ratio for a cross-sheet sweep (#186): seed-sheet
   * image px per target-sheet image px, which is exactly `upp_seed /
   * upp_target` — both sheets' own committed scales, no search and no guess.
   *
   * `known: false` means at least one of the two sheets has no scale set. The
   * sweep can still run at 1.0 (same-size drafting is the norm across the plan
   * sheets of one set) but the caller MUST disclose the assumption, because an
   * unknown ratio and a zero count together are indistinguishable from "the
   * symbol isn't there" — the exact silent wrong answer #186 exists to kill. */
  private sweepRatio(seed: SheetState, target: SheetState): { scale: number; known: boolean } {
    if (seed.key === target.key) return { scale: 1, known: true };
    if (seed.upp && target.upp) return { scale: seed.upp / target.upp, known: true };
    return { scale: 1, known: false };
  }

  /** The refusal that has to fire before a detail-seeded sweep runs blind. A
   * detail, legend, or schedule sheet is drawn at ITS own enlarged scale — a
   * 1-1/2" = 1'-0" detail against a 1/8" plan is 12× — so sweeping it against
   * the plans without the ratio searches for a symbol twelve times too large
   * and reports a confident zero. Plan-to-plan is different and stays
   * permissive: one set's plan sheets are drawn at one scale nearly always,
   * and requiring set_scale there would break sweeps that work today. */
  private requireCrossScale(seed: SheetState, seedRole: string, targets: SheetState[]): void {
    if (seedRole === "plan") return;
    const seen = new Set<string>();
    const missing = [seed, ...targets].filter((sh) => !sh.upp && !seen.has(sh.key) && (seen.add(sh.key), true));
    if (!missing.length) return;
    const names = missing.map((sh) => sh.key);
    throw new UserError(
      `The seed sits on a ${seedRole} sheet (${seed.key}), which is drawn at its own enlarged scale — matching it against the plans needs BOTH scales stated, and ${names.length === 1 ? `${names[0]} has none` : `these have none: ${names.join(", ")}`}. ` +
      `Sweeping without the ratio would search the plans for a symbol several times too large and report a confident zero, so it refuses instead. ` +
      `Run set_scale on ${names.join(", ")} first${missing.some((sh) => sh.detected) ? ` (detected: ${missing.filter((sh) => sh.detected).map((sh) => `${sh.key} → ${sh.detected!.label}`).join(", ")})` : ""}, or marquee an instance drawn on a plan sheet itself and sweep with scope 'sheet'.`,
    );
  }

  /** symbol_sweep — every placement of ONE example symbol, from the linework.
   * The engine is pure (web/src/lib/symbolsweep.ts): fingerprint the seed
   * rect's segments, propose placements by constellation anchoring under the
   * square symmetry group, score each as the length-weighted fraction of seed
   * segments reproduced within tolerance. This method is the plumbing plus
   * the wire shapes: rect clamping, the scan refusal, and the commit path —
   * match centers through the placeCount path (ONE undo step, EA scale-free),
   * origins telling the truth (`method: "symbol_sweep"`, per-match
   * score/transform), withheld placements NEVER committed.
   *
   * scope "set" (phase 2) sweeps the whole working set, restricted to
   * PLAN-role sheets by the sheet graph: a symbol instance drawn in a detail,
   * legend, or schedule is a reference drawing, not installed work, and must
   * never count itself. The seed rect may sit on ANY sheet — marqueeing the
   * assembly on a detail sheet is the estimator's own gesture — and a
   * non-plan seed sheet serves as the fingerprint SOURCE while staying
   * excluded from counting. Every excluded sheet is disclosed in `skipped`
   * with its role and reason; per-sheet results carry their own match /
   * withheld / cap accounting plus wall-clock elapsed_ms. The whole set-wide
   * commit is ONE undo step: the gesture the agent made was "sweep the set",
   * and taking it back should not require one undo per sheet. */
  async symbolSweep(name: string, opts: {
    seedRect: [Point, Point];
    condition?: string;
    commit?: boolean;
    scope?: "sheet" | "set";
    rotations?: boolean;
    mirror?: boolean;
    tolerancePx?: number;
    variantGuard?: boolean;
    exclude?: [Point, Point][];
    luminanceTolerance?: number;
    commitSeed?: boolean;
  }) {
    const s = this.sheet(name);
    const scope = opts.scope ?? "sheet";
    if (opts.commit && !opts.condition) {
      throw new UserError("commit: true needs a condition — the finish tag the match markers count under (e.g. 'FD-1').");
    }
    // #296 — the seed is installed work in sheet scope, and the count that
    // quietly excluded it read as a miss on a visual audit (four × on a plan
    // with five drains). commit_seed opts it into the same batch; anywhere
    // else it is a mistake worth naming.
    if (opts.commitSeed && !opts.commit) {
      throw new UserError("commit_seed: true needs commit: true — the seed joins the same one-undo-step batch as the matches.");
    }
    if (opts.commitSeed && scope === "set") {
      throw new UserError("commit_seed applies to sheet scope only — in a set-wide sweep the seed may sit on a detail or legend sheet, where it is a reference drawing. If the seed instance is installed work, place_count it on its sheet explicitly.");
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
      // whole-symbol mode: richer-variant placements demote to withheld;
      // stands down inside the engine when negatives are in play. NOT wired
      // for sweep_schedule_row — tag-text corroboration already discriminates
      // variants there, and its matches still carry the `extra` disclosure.
      ...(opts.variantGuard ? { variantGuard: true } : {}),
      // #260 — the stated stroke-luminance gate. The tolerance travels in the
      // shared opts; the CHANNEL is per target sheet, passed at each match.
      ...(typeof opts.luminanceTolerance === "number" ? { lumTol: opts.luminanceTolerance } : {}),
    };
    let fp: SymbolFingerprint;
    try {
      fp = fingerprintSymbol(geo.segs, rect, geo.lum);
    } catch (e) {
      // the engine's refusals (empty marquee, region-sized marquee) are
      // user-facing instructions, not crashes
      throw new UserError(e instanceof Error ? e.message : String(e));
    }
    // #259 — counter-examples, read ONCE on the seed sheet. They travel with
    // the fingerprint the same way it does: the engine resizes them by the
    // same stated ratio on a cross-scale sheet, so "not this one" means the
    // same thing on every sheet swept.
    const negatives: SymbolNegative[] = [];
    for (let i = 0; i < (opts.exclude ?? []).length; i++) {
      const er = opts.exclude![i];
      const nr: [Point, Point] = [
        [clampX(er[0][0]), clampY(er[0][1])],
        [clampX(er[1][0]), clampY(er[1][1])],
      ];
      const neg = buildNegative(fp, geo.segs, nr, sweepOpts);
      if (!neg) {
        // A negative that reads as nothing is worse than no negative: the
        // estimator believes they excluded something. Refuse with the two
        // reasons it can happen, in the marquee's own terms.
        throw new UserError(`Counter-example ${i + 1} holds nothing that separates it from the seed. Either the seed symbol is not drawn inside that rect — a negative must be an instance of what you seeded PLUS whatever makes it not the one you mean — or the rect holds the very same symbol with nothing extra, which would reject every real match. Marquee the lookalike itself (the flush variant with its box, the keynote with its letter), or the empty position whose background line a real instance would break.`);
      }
      negatives.push(neg);
    }

    const seedOut = {
      sheet: s.key,
      segments: fp.segments,
      center: [round1(fp.center[0]), round1(fp.center[1])] as [number, number],
      rect: [round1(rect[0][0]), round1(rect[0][1]), round1(rect[1][0]), round1(rect[1][1])],
      length_px: round1(fp.totalLen),
    };

    if (scope === "sheet") {
      const res = matchSymbol(fp, geo.segs, { ...sweepOpts, lum: geo.lum, excludeCenter: fp.center, ...(negatives.length ? { negatives } : {}) });
      // #308 — the drawing's own names. For a labeled family the sheet says
      // what each placement IS (a tag written beside it, or connected by a
      // leader); resolved as disclosure on every row, never a recount.
      if (!s.spans) s.spans = textSpans(s.page);
      const lbl = this.sweepLabels(s.spans, geo, fp.center, res.matches, res.withheld);
      let committed: { committed: number; shape_ids: string[]; condition: string; ea_total: number } | undefined;
      // #376 — a small seed that clears a crowd of placements does not commit
      // on shape alone; the placements are still returned, the refusal says why.
      const refusal = opts.commit ? sweepCommitRefusal({ seedSegments: fp.segments, found: res.matches.length, variantGuard: !!opts.variantGuard, negatives: negatives.length }) : null;
      if (opts.commit && !refusal && (res.matches.length || opts.commitSeed)) {
        // #296 — commit_seed puts the seed instance first in the SAME batch:
        // one undo step covers the whole gesture, seed included.
        const points = [...(opts.commitSeed ? [fp.center] : []), ...res.matches.map((m) => m.at)];
        const seedOrigin = {
          method: "symbol_sweep" as const,
          actor: "agent" as const,
          reviewed: false,
          symbol: { score: 1, rotation: 0, mirrored: false, seed: { source: "instance" as const, sheet: s.key } },
        };
        committed = this.placeCount(name, points, {
          condition: opts.condition!,
          tool: "symbol_sweep",
          origins: [...(opts.commitSeed ? [seedOrigin] : []), ...res.matches.map((m) => ({
            method: "symbol_sweep" as const,
            actor: "agent" as const,
            reviewed: false,
            symbol: { score: m.score, rotation: m.rotation, mirrored: m.mirrored, seed: { source: "instance" as const, sheet: s.key } },
          }))],
        });
      }
      const labelNote = Session.sweepLabelNote(lbl);
      return {
        scope,
        found: res.matches.length,
        matches: res.matches.map((m, i) => ({ at: [round1(m.at[0]), round1(m.at[1])], score: m.score, rotation: m.rotation, mirrored: m.mirrored, ...(m.extra !== undefined ? { extra: m.extra } : {}), ...Session.labelFields(lbl.matches[i]) })),
        withheld: res.withheld.map((w, i) => ({ at: [round1(w.at[0]), round1(w.at[1])], score: w.score, rotation: w.rotation, mirrored: w.mirrored, ...(w.extra !== undefined ? { extra: w.extra } : {}), ...Session.labelFields(lbl.withheld[i]), reason: w.reason })),
        seed: { ...seedOut, ...Session.labelFields(lbl.seed) },
        ...(res.rejected.length ? { rejected: res.rejected.map((r) => ({ at: [round1(r.at[0]), round1(r.at[1])], score: r.score, rotation: r.rotation, mirrored: r.mirrored, by: r.by + 1, mode: r.mode, evidence: r.evidence, reason: r.reason })) } : {}),
        ...(res.negatives ? { negatives: res.negatives.filter((n) => !!n).map((n) => ({ mode: n!.mode, segments: n!.segments, center: [round1(n!.center[0]), round1(n!.center[1])] as [number, number] })) } : {}),
        ...(res.lum_gate ? { lum_gate: res.lum_gate } : {}),
        candidates: res.candidates,
        complete: res.complete,
        ...(committed ? {
          committed: committed.committed,
          shape_ids: committed.shape_ids,
          condition: committed.condition,
          ea_total: committed.ea_total,
          ...(opts.commitSeed ? { seed_committed: true } : {}),
        } : {}),
        ...(refusal ? { committed: 0, commit_refused: refusal } : {}),
        ...((): { note?: string } => {
          const parts: string[] = [];
          if (opts.commit && !refusal && !res.matches.length && !opts.commitSeed) parts.push("commit requested but nothing cleared the bar — no shapes were committed.");
          // #296 — a count that excludes something the estimator can see must
          // say so: the seed is almost always installed work in sheet scope.
          if (committed && !opts.commitSeed) parts.push(`The seed instance at (${round1(fp.center[0])}, ${round1(fp.center[1])}) is NOT in this count — if it is installed work, re-run with commit_seed: true or place_count it.`);
          if (labelNote) parts.push(labelNote);
          return parts.length ? { note: parts.join(" ") } : {};
        })(),
        ...(res.candidates.dropped > 0 ? { warning: `Work ceiling: ${res.candidates.dropped} candidate placement(s) were never scored — this count is a FLOOR, not a total. The seed's linework is too common on this sheet for an exhaustive sweep; tighten the seed rect around more distinctive geometry, or sweep a region at a time and reconcile the counts.` } : {}),
      };
    }

    // ── scope "set" ────────────────────────────────────────────────────────
    const graph = await this.ensureGraph();
    if (!graph.available) {
      throw new UserError("This set has no text layer, so sheet ROLES are unknown — a set-wide sweep counts PLAN sheets only, and it will not guess which sheets those are. Sweep each sheet explicitly with scope 'sheet'.");
    }
    const roleOf = new Map(graph.sheets.map((g) => [g.key, g.role] as const));
    const seedRole = roleOf.get(s.key) ?? "unknown";
    const seedSource: "instance" | "detail_sheet" = seedRole === "plan" ? "instance" : "detail_sheet";

    // #186: the scale gate fires BEFORE any sweeping, over the plan sheets the
    // sweep is actually going to touch — a refusal after ten sheets of blind
    // matching would be a slow way to say the same thing.
    this.requireCrossScale(s, seedRole, this.sheetList().filter((sh) => (roleOf.get(sh.key) ?? "unknown") === "plan"));

    const perSheet: { state: SheetState; matches: SweepMatch[]; withheld: SweepWithheld[]; rejected: SweepRejected[]; candidates: { considered: number; dropped: number }; complete: boolean; elapsed_ms: number; scale: { scale: number; known: boolean }; scaled?: NonNullable<SymbolMatchResult["scaled"]>; lum_gate?: NonNullable<SymbolMatchResult["lum_gate"]>; labels: { seed: PlacementLabel | null; matches: (PlacementLabel | null)[]; withheld: (PlacementLabel | null)[] } }[] = [];
    const skipped: { sheet: string; role: string; reason: string }[] = [];
    for (const sh of this.sheetList()) {
      const role = roleOf.get(sh.key) ?? "unknown";
      if (role !== "plan") {
        skipped.push({
          sheet: sh.key,
          role,
          reason: sh.key === s.key
            ? `the seed source — a symbol drawn on a ${role} sheet defines the fingerprint but is a reference drawing, never installed work`
            : role === "unknown"
              ? "role unknown (no classifiable title text) — sweep it explicitly with scope 'sheet' if it is a plan"
              : `a ${role} sheet — symbol instances here are reference drawings, not installed work`,
        });
        continue;
      }
      const g2 = await this.ensureGeometry(sh);
      if (!g2.segs.length) {
        skipped.push({ sheet: sh.key, role, reason: "no vector linework (likely a scan) — symbol matching reads the drawn segments" });
        continue;
      }
      const ratio = this.sweepRatio(s, sh);
      const t0 = process.hrtime.bigint();
      let res: SymbolMatchResult;
      try {
        res = matchSymbol(fp, g2.segs, {
          ...sweepOpts,
          lum: g2.lum,
          ...(ratio.scale === 1 ? {} : { scale: ratio.scale }),
          ...(sh.key === s.key ? { excludeCenter: fp.center } : {}),
          ...(negatives.length ? { negatives } : {}),
        });
      } catch (e) {
        // the engine's scale refusals (symbol shrinks inside tolerance, ratio
        // out of band) are instructions about THIS sheet, not a dead sweep —
        // disclose and keep going, so one impossible pairing doesn't cost the
        // estimator the sheets that were fine
        skipped.push({ sheet: sh.key, role, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const elapsed_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
      // #308 — each target sheet's own text names its own placements
      if (!sh.spans) sh.spans = textSpans(sh.page);
      const labels = this.sweepLabels(sh.spans, g2, null, res.matches, res.withheld);
      perSheet.push({ state: sh, ...res, elapsed_ms, scale: ratio, labels });
    }

    const found = perSheet.reduce((n, p) => n + p.matches.length, 0);
    let committed: { committed: number; shape_ids: string[]; condition: string; ea_total: number } | undefined;
    const refusal = opts.commit ? sweepCommitRefusal({ seedSegments: fp.segments, found, variantGuard: !!opts.variantGuard, negatives: negatives.length }) : null;   // #376
    if (opts.commit && !refusal && found) {
      const ids: string[] = [];
      for (const ps of perSheet) {
        for (const m of ps.matches) {
          ids.push(this.commit(ps.state, opts.condition!, "count", [m.at], { count: 1 }, {
            method: "symbol_sweep",
            actor: "agent",
            reviewed: false,
            symbol: { score: m.score, rotation: m.rotation, mirrored: m.mirrored, seed: { source: seedSource, sheet: s.key, role: seedRole } },
          }).id);
        }
      }
      this.flushCommits("symbol_sweep");
      const c = this.conditions.find((x) => x.finish_tag === opts.condition)!;
      const ea_total = this.shapes
        .filter((x) => x.condition_id === c.id && x.measure_role === "count")
        .reduce((n, x) => n + (x.computed.count || 1), 0);
      committed = { committed: ids.length, shape_ids: ids, condition: c.finish_tag, ea_total };
    }

    const capped = perSheet.filter((p) => p.candidates.dropped > 0);
    const notes: string[] = [];
    if (!perSheet.length) notes.push("No plan-role sheet in the set was sweepable — nothing was counted; skipped[] says why, sheet by sheet.");
    if (opts.commit && !refusal && !found) notes.push("commit requested but nothing cleared the bar on any plan sheet — no shapes were committed.");
    // #186 disclosure. A ratio that was APPLIED is reported because the count
    // depends on it; a ratio that was ASSUMED is reported harder when the
    // sweep came back empty, because that pairing — unknown scale, zero found
    // — is precisely the confident-zero this issue was filed about.
    const rescaled = perSheet.filter((p) => p.scaled);
    const assumed = perSheet.filter((p) => !p.scale.known);
    if (rescaled.length) {
      notes.push(`Size ratio applied from the sheets' own scales: ${rescaled.map((p) => `${p.state.key} ×${p.scaled!.ratio}`).join(", ")} — the seed was resized to each target sheet before matching, never scale-searched.`);
      const thinned = rescaled.filter((p) => p.scaled!.sub_pixel_dropped > 0);
      if (thinned.length) {
        notes.push(`Scaling down cost detail: ${thinned.map((p) => `${p.state.key} dropped ${p.scaled!.sub_pixel_dropped} sub-pixel segment(s)`).join(", ")} — scores there are a fraction of the linework that survived the trip, not of the whole seed.`);
      }
    }
    if (assumed.length) {
      const empty = assumed.filter((p) => !p.matches.length).map((p) => p.state.key);
      notes.push(
        `Swept at 1:1 on ${assumed.map((p) => p.state.key).join(", ")} — no scale is set on the seed sheet or on those, so the true size ratio is unknown and same-size drafting was assumed.` +
        (empty.length ? ` ${empty.join(", ")} found nothing, and an unstated ratio is a live explanation for that: if any of those sheets is drawn at a different scale than ${s.key}, the search was for a wrong-sized symbol. set_scale on both ends turns this from an assumption into arithmetic.` : ""),
      );
    }
    const rejectedTotal = perSheet.reduce((n, p) => n + p.rejected.length, 0);
    if (rejectedTotal) {
      notes.push(`${rejectedTotal} placement(s) the geometry accepted were rejected by your counter-example(s) and are NOT in found — each is named per sheet in rejected[] with what it saw. Look before accepting the exclusion: place_count reinstates one by hand.`);
    }
    const lumRejectedTotal = perSheet.reduce((n, p) => n + (p.lum_gate?.rejected ?? 0), 0);
    if (lumRejectedTotal) {
      notes.push(`${lumRejectedTotal} placement(s) the geometry would have committed were pulled under the bar by your stated luminance tolerance — each is named per sheet in lum_gate.at. Look before trusting the gate: a symbol somebody redrew in a different pen fails it honestly.`);
    }
    // #308 — the seed's tag from its own sheet, and one aggregate label note
    if (!s.spans) s.spans = textSpans(s.page);
    const seedLbl = this.sweepLabels(s.spans, geo, fp.center, [], []).seed;
    const labelNote = Session.sweepLabelNote({
      seed: seedLbl,
      matches: perSheet.flatMap((p) => p.labels.matches),
      withheld: perSheet.flatMap((p) => p.labels.withheld),
    });
    if (labelNote) notes.push(labelNote);
    return {
      scope,
      found,
      seed: { ...seedOut, role: seedRole, ...Session.labelFields(seedLbl) },
      ...(rejectedTotal ? { rejected_total: rejectedTotal } : {}),
      ...(negatives.length ? { negatives: negatives.map((n) => ({ mode: n.mode, segments: n.rel.length, center: [round1(n.center[0]), round1(n.center[1])] as [number, number] })) } : {}),
      sheets: perSheet.map((p) => ({
        sheet: p.state.key,
        found: p.matches.length,
        matches: p.matches.map((m, i) => ({ at: [round1(m.at[0]), round1(m.at[1])], score: m.score, rotation: m.rotation, mirrored: m.mirrored, ...(m.extra !== undefined ? { extra: m.extra } : {}), ...Session.labelFields(p.labels.matches[i]) })),
        withheld: p.withheld.map((w, i) => ({ at: [round1(w.at[0]), round1(w.at[1])], score: w.score, rotation: w.rotation, mirrored: w.mirrored, ...(w.extra !== undefined ? { extra: w.extra } : {}), ...Session.labelFields(p.labels.withheld[i]), reason: w.reason })),
        ...(p.rejected.length ? { rejected: p.rejected.map((r) => ({ at: [round1(r.at[0]), round1(r.at[1])], score: r.score, rotation: r.rotation, mirrored: r.mirrored, by: r.by + 1, mode: r.mode, evidence: r.evidence, reason: r.reason })) } : {}),
        ...(p.lum_gate ? { lum_gate: p.lum_gate } : {}),
        candidates: p.candidates,
        complete: p.complete,
        elapsed_ms: p.elapsed_ms,
        ...(p.scaled ? { scaled: p.scaled } : {}),
        ...(p.scale.known ? {} : { scale_assumed: "no scale set on the seed sheet or this one — swept at 1:1" }),
      })),
      complete: perSheet.every((p) => p.complete),
      skipped,
      ...(committed ?? {}),
      ...(refusal ? { committed: 0, commit_refused: refusal } : {}),
      ...(notes.length ? { note: notes.join(" ") } : {}),
      ...(capped.length ? { warning: `Work ceiling: candidate placements were dropped un-scored on ${capped.map((p) => p.state.key).join(", ")} — counts there are FLOORS, not totals. The seed's linework is too common there for an exhaustive sweep; tighten the seed rect around more distinctive geometry, or sweep those sheets singly and reconcile the counts.` } : {}),
    };
  }

  /** sweep_schedule_row (phase 2) — the estimator's story, honored: a
   * transition type sometimes exists only as a schedule row plus tag markers
   * scattered across the plan sheets. Given the ROW's key, this mints the
   * condition FROM the row (the assign-from-schedule vocabulary: the tag is
   * the schedule's claim, `origin.assignment {source: "schedule"}` with the
   * citation) and sweeps every plan sheet for the marker the tag is drawn as.
   *
   * THE CONTRACT, stated precisely — refusal-honest, never text-to-geometry
   * guessing:
   *   1. The row must exist in a schedule table the sheet graph extracted
   *      (one row — a key defined twice across tables is ambiguous, refused).
   *   2. The tag must be DRAWN on at least one plan-role sheet. A row whose
   *      tag appears nowhere on the plans cannot be geometrically anchored,
   *      and a fingerprint is NEVER guessed from text alone — refused, with
   *      the fix (marquee an instance with symbol_sweep).
   *   3. The fingerprint is the linework around the tag's own drawn
   *      occurrence (a deterministic pad ladder around the text bbox), and
   *      where the tag occurs more than once it must CORROBORATE — recur at
   *      a second occurrence — before it is trusted. No repeatable marker
   *      geometry → refused.
   *   4. A geometric match COUNTS only when the row's own tag text sits
   *      within the marker's footprint — drafting reuses one bubble shape
   *      across many tags, so geometry alone is not identity. A match
   *      carrying a SIBLING row's tag is excluded (disclosed with the tag it
   *      carries); a match carrying no tag is withheld as a question; a tag
   *      occurrence with no matching geometry is disclosed as text_only.
   * Commit is ONE undo step for the whole set-wide sweep. */
  async sweepScheduleRow(tag: string, opts: {
    commit?: boolean;
    rotations?: boolean;
    mirror?: boolean;
    tolerancePx?: number;
  } = {}) {
    const t = (tag || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!t) throw new UserError('Pass a schedule-row tag as drawn, e.g. sweep_schedule_row { tag: "T1" }.');
    const graph = await this.ensureGraph();
    if (!graph.available) throw new UserError("This set has no text layer (a scan) — the sheet graph is unavailable, so schedule rows cannot be read.");

    // 1. the row — the same tables resolve_tag / find_schedule read. A
    // schedule often keys one row for several marks ("R1 / E1" — same device,
    // return vs exhaust service): that row ANSWERS for each mark, and the
    // sweep runs on the mark as drawn on the plans, not the compound key.
    const canonKey = (k: string) => (k || "").trim().toUpperCase().replace(/\s+/g, "");
    const rowHits = graph.tables.flatMap((tb) => tb.rows.filter((r) => rowKeyAnswersFor(r.key, t)).map((r) => ({ tb, r })));
    if (!rowHits.length) {
      const found = graph.tables.map((x) => {
        const keys = x.rows.map((row) => row.key).slice(0, 12).join(", ");
        return `${x.kind} on ${x.sheet} (${x.rows.length} rows: ${keys}${x.rows.length > 12 ? ", …" : ""})`;
      }).join(" | ");
      throw new UserError(`No schedule row "${t}" in the set — tables found: ${found || "none"}. Check the tag as drawn (find_schedule shows each table's region), or merge the schedule sheet in with load_plan.`);
    }
    if (rowHits.length > 1) {
      throw new UserError(`Ambiguous: ${rowHits.length} schedule rows carry the key "${t}" — the same mark defined twice cannot seed one sweep. Marquee the marker yourself with symbol_sweep.`);
    }
    const { tb, r } = rowHits[0];
    // sibling keys span EVERY table in the set, not just the row's own: a
    // marker labeled with any other schedule key is that mark's instance, and
    // disclosing it as "excluded, labeled 135" beats calling it unlabeled
    const siblings = [...new Set(graph.tables.flatMap((x) => x.rows.flatMap((row) => canonKey(row.key).split("/").filter(Boolean))))].filter((k) => k !== t).sort();
    const table = tb.title?.text || `${tb.kind} schedule`;

    // 2. plan-role sheets, and every drawn occurrence of the tag on them
    const roleOf = new Map(graph.sheets.map((g) => [g.key, g.role] as const));
    const skipped: { sheet: string; role: string; reason: string }[] = [];
    const planSheets: SheetState[] = [];
    for (const sh of this.sheetList()) {
      const role = roleOf.get(sh.key) ?? "unknown";
      if (role === "plan") planSheets.push(sh);
      else {
        skipped.push({
          sheet: sh.key,
          role,
          reason: role === "unknown"
            ? "role unknown (no classifiable title text) — instances here are not counted"
            : `a ${role} sheet — the tag's instances here are reference drawings, never installed work`,
        });
      }
    }
    type Occ = { cx: number; cy: number; h: number; bbox: [number, number, number, number] };
    const occOf = (sh: SheetState, key: string): Occ[] => {
      if (!sh.spans) sh.spans = textSpans(sh.page);
      return sh.spans
        .filter((sp) => sp.str.trim().toUpperCase() === key)
        .map((sp) => ({ cx: (sp.x0 + sp.x1) / 2, cy: (sp.y0 + sp.y1) / 2, h: Math.max(sp.y1 - sp.y0, 6), bbox: [sp.x0, sp.y0, sp.x1, sp.y1] as [number, number, number, number] }))
        .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    };
    const occBySheet = planSheets.map((sh) => ({ sh, occ: occOf(sh, t) }));
    const totalOcc = occBySheet.reduce((n, e) => n + e.occ.length, 0);
    if (!totalOcc) {
      throw new UserError(`Schedule row "${t}" (${table} on ${tb.sheet}) cannot be geometrically anchored — its tag is not drawn on any plan sheet, and a fingerprint is never guessed from text alone. If the marker is drawn untagged, marquee one instance with symbol_sweep {scope: "set"}.`);
    }

    // 3. anchor + pad ladder + corroboration. Anchor sheet = the plan sheet
    // with the MOST occurrences (ord breaks ties) so corroboration can run on
    // the anchor's own sheet whenever the set allows it; anchor occurrence =
    // first in reading order. Deterministic throughout.
    const withOcc = occBySheet.filter((e) => e.occ.length > 0)
      .sort((a, b) => b.occ.length - a.occ.length || a.sh.ord - b.sh.ord);
    const anchorSheet = withOcc[0].sh;
    const anchor = withOcc[0].occ[0];
    const anchorGeo = await this.ensureGeometry(anchorSheet);
    if (!anchorGeo.segs.length) {
      throw new UserError(`${anchorSheet.key} carries the tag "${t}" but no vector linework — the marker cannot be fingerprinted on a scan.`);
    }
    const sweepOpts: SweepOptions = {
      rotations: opts.rotations ?? true,
      mirror: opts.mirror ?? true,
      tolPx: opts.tolerancePx ?? SWEEP_TOL_PX,
    };
    // corroborators: the tag's OTHER occurrences — same sheet when it has
    // them, else the next sheet that does; a tag drawn exactly once has none
    // the corroborator may live on ANOTHER sheet, so it carries that sheet:
    // the probe has to cross the same size ratio the real sweep will (#186),
    // or a fingerprint gets rejected as "doesn't recur" for the sole reason
    // that the two plan sheets are drawn at different scales
    let corro: { sh: SheetState; segs: number[]; occ: Occ[] } | null = null;
    if (withOcc[0].occ.length > 1) corro = { sh: anchorSheet, segs: anchorGeo.segs, occ: withOcc[0].occ.slice(1) };
    else if (withOcc.length > 1) corro = { sh: withOcc[1].sh, segs: (await this.ensureGeometry(withOcc[1].sh)).segs, occ: withOcc[1].occ };

    const cX = (v: number) => Math.max(0, Math.min(v, anchorSheet.widthPx));
    const cY = (v: number) => Math.max(0, Math.min(v, anchorSheet.heightPx));
    let fp: SymbolFingerprint | null = null;
    let anchorRect: [Point, Point] | null = null;
    let corroborated = false;
    for (const padK of [1, 2, 3]) {
      const pad = padK * anchor.h;
      const rect: [Point, Point] = [
        [cX(anchor.bbox[0] - pad), cY(anchor.bbox[1] - pad)],
        [cX(anchor.bbox[2] + pad), cY(anchor.bbox[3] + pad)],
      ];
      let cand: SymbolFingerprint;
      try {
        cand = fingerprintSymbol(anchorGeo.segs, rect);
      } catch (e) {
        // nothing fully inside yet → widen; a region-sized grab → bigger pads only get worse
        if (e instanceof Error && /region, not one symbol/.test(e.message)) break;
        continue;
      }
      // a degenerate grab is not a marker: one or two short strokes at the tag
      // are its own underline/leader, which recur at EVERY tagged mark and
      // "corroborate" trivially — matching on them counts tags' furniture, not
      // devices. Widen instead; if no pad ever captures real marker geometry,
      // the refusal below states it.
      if (cand.segments < 3) continue;
      if (!corro) { fp = cand; anchorRect = rect; break; }
      const cr = this.sweepRatio(anchorSheet, corro.sh);
      let probe: SymbolMatchResult;
      try {
        probe = matchSymbol(cand, corro.segs, { ...sweepOpts, ...(cr.scale === 1 ? {} : { scale: cr.scale }) });
      } catch {
        // this pad's fingerprint can't survive the trip to the corroborator
        // (too small once scaled) — a wider pad may; never a hard stop
        continue;
      }
      const pr = (probe.scaled ? probe.scaled.footprint_px : cand.footprint) / 2 + anchor.h;
      if (corro.occ.some((o) => probe.matches.some((m) => Math.hypot(m.at[0] - o.cx, m.at[1] - o.cy) <= pr))) {
        fp = cand; anchorRect = rect; corroborated = true;
        break;
      }
    }
    if (!fp || !anchorRect) {
      throw new UserError(corro
        ? `Schedule row "${t}" cannot be anchored: the linework around its drawn tag on ${anchorSheet.key} does not recur at the tag's other occurrences — no repeatable marker geometry to fingerprint. Marquee one instance with symbol_sweep instead.`
        : `Schedule row "${t}" cannot be anchored: no fingerprintable marker linework sits around its drawn tag on ${anchorSheet.key}. Marquee one instance with symbol_sweep instead.`);
    }

    // 4. the full plan-only sweep + tag corroboration per match.
    // The tag-proximity radius is the marker's footprint AS DRAWN ON THE SHEET
    // being read, so it rides the size ratio with the fingerprint (#186): a
    // marker resized to a 12×-smaller plan has a 12×-smaller footprint, and a
    // radius left at the seed's size would sweep up whatever tag happened to
    // be nearby. Unscaled sheets take the identical radius they always did.
    const radiusFor = (sc?: { footprint_px: number }): number => (sc ? sc.footprint_px : fp!.footprint) / 2 + anchor.h;
    const byPos = <T extends { at: Point }>(a: T, b: T): number => a.at[1] - b.at[1] || a.at[0] - b.at[0];
    type CountedMatch = SweepMatch & { tag_at: [number, number, number, number] };
    const perSheet: {
      state: SheetState;
      matches: CountedMatch[];
      withheld: SweepWithheld[];
      excluded: { at: Point; tag: string }[];
      text_only: { at: Point }[];
      candidates: { considered: number; dropped: number };
      complete: boolean;
      elapsed_ms: number;
      scale: { scale: number; known: boolean };
      scaled?: NonNullable<SymbolMatchResult["scaled"]>;
    }[] = [];
    for (const { sh, occ } of occBySheet) {
      const g2 = await this.ensureGeometry(sh);
      if (!g2.segs.length) {
        skipped.push({ sheet: sh.key, role: "plan", reason: "no vector linework (likely a scan) — symbol matching reads the drawn segments" });
        continue;
      }
      const ratio = this.sweepRatio(anchorSheet, sh);
      const t0 = process.hrtime.bigint();
      let res: SymbolMatchResult;
      try {
        res = matchSymbol(fp, g2.segs, { ...sweepOpts, ...(ratio.scale === 1 ? {} : { scale: ratio.scale }) });
      } catch (e) {
        skipped.push({ sheet: sh.key, role: "plan", reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const R = radiusFor(res.scaled);
      const elapsed_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
      const sibSpans: { key: string; cx: number; cy: number }[] = [];
      for (const k of siblings) for (const o of occOf(sh, k)) sibSpans.push({ key: k, cx: o.cx, cy: o.cy });
      const matches: CountedMatch[] = [];
      const excluded: { at: Point; tag: string }[] = [];
      const withheld: SweepWithheld[] = [];
      const matchedOcc = new Set<number>();
      for (const m of res.matches) {
        let oi = -1;
        for (let k = 0; k < occ.length; k++) {
          if (Math.hypot(m.at[0] - occ[k].cx, m.at[1] - occ[k].cy) <= R) { oi = k; break; }
        }
        if (oi >= 0) { matchedOcc.add(oi); matches.push({ ...m, tag_at: occ[oi].bbox }); continue; }
        const sib = sibSpans.find((sp) => Math.hypot(m.at[0] - sp.cx, m.at[1] - sp.cy) <= R);
        if (sib) { excluded.push({ at: m.at, tag: sib.key }); continue; }
        withheld.push({ ...m, reason: `the marker geometry matches but carries no "${t}" tag within its footprint — an unlabeled instance or a shared marker shape; look before counting it` });
      }
      for (const w of res.withheld) {
        const near = occ.some((o) => Math.hypot(w.at[0] - o.cx, w.at[1] - o.cy) <= R);
        withheld.push(near ? { ...w, reason: `${w.reason} — and the "${t}" tag is drawn beside it` } : w);
      }
      matches.sort(byPos); excluded.sort(byPos); withheld.sort(byPos);
      const text_only = occ
        .filter((o, k) => !matchedOcc.has(k) && !res.withheld.some((w) => Math.hypot(w.at[0] - o.cx, w.at[1] - o.cy) <= R))
        .map((o) => ({ at: [round1(o.cx), round1(o.cy)] as Point }));
      perSheet.push({ state: sh, matches, withheld, excluded, text_only, candidates: res.candidates, complete: res.complete, elapsed_ms, scale: ratio, ...(res.scaled ? { scaled: res.scaled } : {}) });
    }

    // 5. commit — condition minted FROM the row (its key IS the tag), the
    // schedule verdict and the seed citation on every marker, one undo step
    const found = perSheet.reduce((n, p) => n + p.matches.length, 0);
    let committed: { committed: number; shape_ids: string[]; condition: string; ea_total: number } | undefined;
    if (opts.commit && found) {
      const ids: string[] = [];
      for (const ps of perSheet) {
        for (const m of ps.matches) {
          ids.push(this.commit(ps.state, t, "count", [m.at], { count: 1 }, {
            method: "symbol_sweep",
            actor: "agent",
            reviewed: false,
            assignment: { source: "schedule", schedule_sheet: tb.sheet },
            symbol: {
              score: m.score, rotation: m.rotation, mirrored: m.mirrored,
              seed: { source: "schedule_row", sheet: anchorSheet.key, row: { sheet: tb.sheet, key: t, table } },
            },
          }).id);
        }
      }
      this.flushCommits("sweep_schedule_row");
      const c = this.conditions.find((x) => x.finish_tag === t)!;
      const ea_total = this.shapes
        .filter((x) => x.condition_id === c.id && x.measure_role === "count")
        .reduce((n, x) => n + (x.computed.count || 1), 0);
      committed = { committed: ids.length, shape_ids: ids, condition: c.finish_tag, ea_total };
    }

    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.cells)) cells[k] = v.text;
    const firstCell = r.cells[Object.keys(r.cells)[0]];
    const capped = perSheet.filter((p) => p.candidates.dropped > 0);
    const notes: string[] = [];
    if (!corroborated) notes.push(`The tag "${t}" is drawn ${totalOcc === 1 ? "exactly once" : "too sparsely to cross-check"} — the fingerprint could not corroborate at a second occurrence; audit the matches with view_sheet before trusting the count.`);
    if (opts.commit && !found) notes.push("commit requested but nothing cleared the bar — no shapes were committed.");
    // #186, same disclosure discipline as symbol_sweep: a ratio the count
    // depends on is stated, and an assumed ratio over an empty sheet is named
    // as the live explanation rather than left to read as absence.
    const rowRescaled = perSheet.filter((p) => p.scaled);
    if (rowRescaled.length) {
      notes.push(`Size ratio applied from the sheets' own scales: ${rowRescaled.map((p) => `${p.state.key} ×${p.scaled!.ratio}`).join(", ")} — the marker was resized from ${anchorSheet.key} before matching.`);
    }
    const rowAssumed = perSheet.filter((p) => !p.scale.known && !p.matches.length);
    if (rowAssumed.length) {
      notes.push(`${rowAssumed.map((p) => p.state.key).join(", ")} found nothing and were swept at 1:1 — no scale is set on ${anchorSheet.key} or on them, so a different drawn scale there is a live explanation for the zero. set_scale on both ends to rule it out.`);
    }
    return {
      tag: t,
      row: {
        sheet: tb.sheet,
        table,
        key: t,
        cells,
        citation: { sheet: tb.sheet, text: `${table} row ${t}`, bbox: Session.wireBox(firstCell?.bbox || tb.region) },
      },
      anchor: {
        sheet: anchorSheet.key,
        at: [round1(anchor.cx), round1(anchor.cy)],
        rect: [round1(anchorRect[0][0]), round1(anchorRect[0][1]), round1(anchorRect[1][0]), round1(anchorRect[1][1])],
        segments: fp.segments,
        length_px: round1(fp.totalLen),
        corroborated,
        occurrences: totalOcc,
      },
      found,
      sheets: perSheet.map((p) => ({
        sheet: p.state.key,
        found: p.matches.length,
        matches: p.matches.map((m) => ({ at: [round1(m.at[0]), round1(m.at[1])], score: m.score, rotation: m.rotation, mirrored: m.mirrored, tag_at: Session.wireBox(m.tag_at) })),
        withheld: p.withheld.map((w) => ({ at: [round1(w.at[0]), round1(w.at[1])], score: w.score, rotation: w.rotation, mirrored: w.mirrored, reason: w.reason })),
        excluded: p.excluded.map((e) => ({ at: [round1(e.at[0]), round1(e.at[1])], tag: e.tag })),
        text_only: p.text_only,
        candidates: p.candidates,
        complete: p.complete,
        elapsed_ms: p.elapsed_ms,
        ...(p.scaled ? { scaled: p.scaled } : {}),
        ...(p.scale.known ? {} : { scale_assumed: `no scale set on ${anchorSheet.key} or this sheet — swept at 1:1` }),
      })),
      complete: perSheet.every((p) => p.complete),
      skipped,
      ...(committed ?? {}),
      ...(notes.length ? { note: notes.join(" ") } : {}),
      ...(capped.length ? { warning: `Work cap: candidate placements were dropped un-scored on ${capped.map((p) => p.state.key).join(", ")} — sweep those sheets singly with symbol_sweep and reconcile the counts.` } : {}),
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
        ...(x.label ? { label: x.label } : {}),
        nverts: x.verts_norm.length,
        reviewed: x.origin?.reviewed === true,
        ...(x.origin?.assignment ? { assignment: x.origin.assignment.source } : {}),
        ...(x.origin?.agent_edits ? { agent_edits: x.origin.agent_edits } : {}),
      })),
      count: rows.length,
    };
  }

  summary() {
    const rows = conditionTotals(this.conditions, this.shapes, this.seamCtx()) as Record<string, unknown>[];
    // strip presentation fields for a compact agent-facing reply
    const lean = rows.map(({ color, fill, hatch, materials, ...rest }) => rest);
    // Scale gate: name every sheet whose scale is agent-set and unconfirmed —
    // a totals reply must say what its numbers stand on
    const unconfirmed = [...this.sheets.values()].filter((s) => s.upp != null && s.scaleConfirmed === false).map((s) => s.key);
    return { conditions: lean, totals: grandTotals(rows), ...(unconfirmed.length ? { scale_unconfirmed: unconfirmed } : {}) };
  }

  deleteShape(id: string) {
    const i = this.shapes.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError(`No shape with id ${JSON.stringify(id)}.`);
    const shape = this.shapes[i];
    // #206 — the canvas's answer is the spec (deleteSelected): deleting a
    // reconciled deduct reverts its cut out of the parent too. The sole cut
    // restores the frozen parent_prev; one of SEVERAL rebuilds from the
    // chain's earliest snapshot minus the survivors. A rebuild that can't be
    // trusted falls through to the plain delete — the shape goes, its cut
    // stays baked in, and the reply says so instead of staying silent.
    if (shape.cuts_shape_id && shape.origin?.parent_prev) {
      const parent = this.shapes.find((x) => x.id === shape.cuts_shape_id);
      if (parent) {
        const parentPrev = this.cutoutParentPrevSans(shape);
        if (parentPrev) {
          const parentAfter: CutoutParentPrev = {
            verts_norm: parent.verts_norm.map((v) => [...v] as [number, number]),
            ...(parent.verts_norm_holes ? { verts_norm_holes: parent.verts_norm_holes.map((h) => h.map((v) => [...v] as [number, number])) } : {}),
            computed: { ...parent.computed },
          };
          this.shapes.splice(i, 1);
          Session.restoreCutoutSnapshot(parent, parentPrev);
          this.record({ op: "cutout_restore", tool: "delete_shape", removed: { shape, index: i }, parent_id: parent.id, parent_after: parentAfter });
          return {
            deleted: id, shape_count: this.shapes.length,
            note: `Reconciled cutout: the cut was reverted out of parent ${parent.id} too (its net is back to ${parent.computed.area_sf} SF).`,
          };
        }
        this.shapes.splice(i, 1);
        this.record({ op: "delete", tool: "delete_shape", removed: [{ shape, index: i }] });
        return {
          deleted: id, shape_count: this.shapes.length,
          note: `The cut could not be rebuilt out of parent ${parent.id} (a re-subtract degenerates) — the deduct is gone but its hole stays baked into the parent's geometry, the canvas's own fallback.`,
        };
      }
    }
    this.shapes.splice(i, 1);
    this.record({ op: "delete", tool: "delete_shape", removed: [{ shape, index: i }] });
    // deleting a PARENT with reconciled cuts: the canvas has no cascade — the
    // deduct children stay, orphaned (skipped by totals, dangling on the
    // sheet). Same behavior here, disclosed rather than silent.
    const orphans = this.shapes.filter((x) => x.cuts_shape_id === id).length;
    return {
      deleted: id, shape_count: this.shapes.length,
      ...(orphans ? { note: `${orphans} reconciled deduct(s) pointed at this shape and are now orphaned (their holes died with the parent; totals ignore them) — the canvas behaves the same. delete_shape them too, or undo_last.` } : {}),
    };
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
   * `label` is the room (or phase, or area) the shape belongs to — the same
   * per-shape field the canvas groups the Report by. A visible string sets it,
   * "" clears it, and the whole shape is snapshotted before the write, so undo
   * restores a cleared label as exactly as it restores geometry.
   *
   * Provenance: agent self-revision bumps origin.agent_edits and touches
   * NOTHING in the human-correction vocabulary (edited / edits /
   * proposed_verts_norm — see web/src/lib/provenance.js). Those fields grade a
   * human's correction of a machine proposal; an agent fixing its own work is
   * not that, and conflating the two would poison the exact signal the capture
   * layer exists to collect. Freezing proposed_verts_norm stays correct on the
   * human's first edit, because the geometry a reviewer saw IS the agent's
   * final revision, not its first draft. */
  editShape(id: string, patch: { verts?: Point[]; condition?: string; role?: MeasureRole; label?: string }) {
    const i = this.shapes.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError(`No shape with id ${JSON.stringify(id)}.`);
    const cur = this.shapes[i];
    if (cur.origin?.reviewed === true) {
      throw new UserError(`Shape ${JSON.stringify(id)} was affirmed by a human — reviewed work is ink, not pencil, and cannot be edited by an agent.`);
    }
    if (patch.verts === undefined && patch.condition === undefined && patch.role === undefined && patch.label === undefined) {
      throw new UserError("Nothing to change — pass at least one of verts, condition, role, label.");
    }
    // #206 — a reconciled cutout pair is one geometry, not two shapes to edit
    // independently. Moving/re-roling the deduct would desync the hole it cut
    // (the parent's computed would keep netting the OLD ring); moving a holed
    // parent's outer ring would strand its holes at their frozen coordinates
    // (the canvas has the same limitation — its hole rings don't track a
    // reshape either, #137 follow-up). Label edits stay fine on both.
    if (cur.cuts_shape_id && (patch.verts !== undefined || patch.role !== undefined || patch.condition !== undefined)) {
      throw new UserError(`Shape ${JSON.stringify(id)} is a reconciled cutout — its ring IS the hole in ${cur.cuts_shape_id}. delete_shape it (the parent's geometry is restored) and cut_out again where you mean it.`);
    }
    if (cur.verts_norm_holes?.length && (patch.verts !== undefined || patch.role !== undefined)) {
      throw new UserError(`Shape ${JSON.stringify(id)} carries ${cur.verts_norm_holes.length} reconciled hole(s) — reshaping its outer ring would strand them. delete_shape the cutout deduct(s) first (each restores the parent), reshape, then cut_out again.`);
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
    // label: a visible string sets it, "" (or whitespace) CLEARS it — the
    // canvas's own rule (web/src/lib/shapeLabels.js), where unassigned is the
    // key being absent rather than an empty string sitting in the payload.
    const nextLabel = patch.label !== undefined ? patch.label.trim() : (cur.label ?? "");
    this.shapes[i] = {
      ...cur,
      condition_id,
      measure_role: role,
      verts_norm: vertsPx.map(([x, y]) => [x / s.widthPx, y / s.heightPx]),
      computed,
      ...(nextLabel ? { label: nextLabel } : {}),
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
    // the spread above carried the old label through — clearing means the key
    // GOES, so an export never ships label: "" for "no room"
    if (!nextLabel) delete this.shapes[i].label;
    this.record({ op: "edit", tool: "edit_shape", before });

    const changed = [
      ...(patch.verts !== undefined ? ["verts"] : []),
      ...(patch.condition !== undefined ? ["condition"] : []),
      ...(patch.role !== undefined ? ["role"] : []),
      ...(patch.label !== undefined ? ["label"] : []),
    ];
    return {
      shape_id: id,
      changed,
      measure_role: role,
      nverts: vertsPx.length,
      ...computed,
      ...(nextLabel ? { label: nextLabel } : {}),
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
    // Snapshot BEFORE anything is written — the target AND its descendants.
    // Materials edits propagate (variants.ts, the same propagate-on-write the
    // canvas runs per row gesture), so undo has to restore every condition the
    // write could reach, tombstones included: a remove on a twin writes
    // materials_dropped, and undo must take that back too.
    const cid = c.id;
    const snap = [cid, ...this.descendantConditionIds(cid)].map((id) => {
      const x = this.conditions.find((q) => q.id === id)! as unknown as VariantCond;
      return { condition_id: id, before: structuredClone(x.materials) as unknown as MaterialRow[],
               ...(x.materials_dropped ? { dropped_before: [...x.materials_dropped] } : {}) };
    });

    // The family rules are the canvas's, verb for verb (TakeoffCanvas.jsx):
    // add on a parent reaches every twin still listening; remove on a twin
    // tombstones a following row (so a later family edit cannot bring it
    // back); a patch on a twin's own row takes THAT row local. The functions
    // are pure and return fresh objects, so this section works functionally
    // over `conds` and writes the array back once at the end.
    let conds = this.conditions as unknown as VariantCond[];
    const isParent = () => conds.some((x) => x.variant_of === cid);
    const target = () => conds.find((x) => x.id === cid)!;
    const mint = (p: string) => uid(p);

    const added: string[] = [];
    for (const a of add) {
      const row: MaterialRow = {
        id: uid("mat"), name: a.name.trim(), per: Math.max(0, a.per ?? 0),
        basis: a.basis ?? "area", unit: a.unit ?? "", round: a.round ?? true,
        ...(a.note ? { note: a.note } : {}),
      };
      conds = conds.map((x) => (x.id !== cid ? x : { ...x, materials: [...(x.materials || []), row as unknown as VariantRow] }));
      added.push(row.id);
      if (isParent()) conds = propagateRowAdd(conds, cid, row as unknown as VariantRow, mint);
    }
    const removed = new Set(remove);
    for (const id of remove) {
      if (target().variant_of) {
        conds = conds.map((x) => (x.id !== cid ? x : dropRowLocal(x, id)));
      } else {
        conds = conds.map((x) => (x.id !== cid ? x : { ...x, materials: (x.materials || []).filter((r) => r.id !== id) }));
        conds = propagateRowRemove(conds, cid, id);
      }
    }
    const patched: string[] = [];
    for (const p of patch) {
      conds = conds.map((x) => (x.id !== cid ? x : {
        ...x,
        materials: (x.materials || []).map((r) => {
          if (r.id !== p.id) return r;
          // fields is an open record at the schema — the row's link fields
          // (id/origin_id/inherited) are pinned back so a patch cannot forge
          // or shed a family link
          const merged = { ...r, ...p.fields, id: r.id } as VariantRow;
          if (r.origin_id === undefined) delete merged.origin_id; else merged.origin_id = r.origin_id;
          if (r.inherited === undefined) delete merged.inherited; else merged.inherited = r.inherited;
          return merged;
        }),
      }));
      patched.push(p.id);
      const cur = target();
      if (cur.variant_of) {
        conds = conds.map((x) => (x.id !== cid ? x : markRowLocal(x, p.id)));
      } else if (isParent()) {
        const row = (cur.materials || []).find((r) => r.id === p.id);
        if (row) conds = propagateRowPatch(conds, cid, p.id, row as unknown as Record<string, unknown>);
      }
    }
    this.conditions = conds as unknown as Condition[];

    const [primary, ...familySnap] = snap;
    this.record({ op: "materials", tool: "edit_materials", condition_id: cid,
                  before: primary.before,
                  ...(primary.dropped_before ? { dropped_before: primary.dropped_before } : {}),
                  ...(familySnap.length ? { family: familySnap } : {}) });

    return {
      condition: tag, condition_id: cid,
      changed: { added, removed: [...removed], patched },
      materials: target().materials as unknown as MaterialRow[],
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

  /** The figured seam length per SHAPE, as conditionTotals wants it — the
   * basis a materials row with basis "seam_lf" (weld rod, seam tape) divides
   * against. computeRollTakeoff returns immediately when no condition carries
   * a roll setup, so this costs nothing on a job that has none, and every
   * seam_lf row on such a job reads 0 rather than guessing. */
  private seamCtx() {
    const { dimsFor, uppFor } = this.rollInputs();
    const { byCond } = computeRollTakeoff(this.conditions, this.shapes, dimsFor, uppFor) as { byCond: Map<string, unknown> };
    return { seamByShape: seamLfByShape(byCond) as Map<string, number> };
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

  /**
   * Twin a condition — the same finish measured somewhere else, with its own materials.
   *
   * The same sheet goods over a slab and over a raised deck take the same field material and
   * different preparation underneath. The twin carries the original's whole materials list and
   * keeps FOLLOWING it: change a coverage rate on the original and every twin that hasn't
   * touched that row gets it; edit a row on the twin and only that row goes local. The rule
   * lives in web/src/lib/variants.ts — one copy, shared with the canvas, so a headless session
   * and the app can never disagree about what a twin holds.
   *
   * A twin needs its OWN tag, and that is not cosmetic here: every tool in this server resolves
   * a condition by finish tag and takes the FIRST match, so two conditions sharing one would
   * make the second permanently unreachable — and a takeoff re-import collapses them last-wins.
   * So the label is required and a collision is refused rather than de-collided.
   */
  /** Every condition below `rootId` in the family tree, children first. The
   * propagate functions walk this same tree; undo snapshots ride it so a
   * family edit's inverse restores exactly the set the write could touch.
   * The `seen` guard mirrors variants.ts — a hand-edited payload with a
   * cycle must not hang the session. */
  private descendantConditionIds(rootId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([rootId]);
    const walk = (pid: string) => {
      for (const child of this.conditions as unknown as VariantCond[]) {
        if (child.variant_of === pid && !seen.has(child.id)) {
          seen.add(child.id);
          out.push(child.id);
          walk(child.id);
        }
      }
    };
    walk(rootId);
    return out;
  }

  duplicateCondition(tag: string, label: string) {
    const src = this.conditions.find((x) => x.finish_tag === tag);
    if (!src) {
      const known = this.conditions.map((x) => x.finish_tag);
      throw new UserError(`No condition ${JSON.stringify(tag)} to duplicate.${known.length ? ` Known tags: ${known.join(", ")}.` : ""}`);
    }
    const lab = String(label || "").trim();
    if (!lab) throw new UserError("label is required — it is what gives the twin its own finish tag, and a tag is how every tool here resolves a condition.");
    const newTag = variantTag(src.finish_tag, lab);
    if (this.conditions.some((x) => x.finish_tag.trim().toUpperCase() === newTag.trim().toUpperCase())) {
      throw new UserError(`A condition is already called ${JSON.stringify(newTag)} — pick a different label. Two conditions sharing a tag would make one of them unreachable to every tool.`);
    }
    const { twin, parentPatch } = mintTwin(src as unknown as VariantCond, {
      label: lab, tag: newTag, mintId: (p: string) => uid(p), nowIso,
      nextHatch: HATCH_IDS[1 + ((this.conditions.length + 1) % (HATCH_IDS.length - 1))],
    });
    if (parentPatch) Object.assign(src, parentPatch);
    this.conditions.push(twin as unknown as Condition);
    this.record({ op: "duplicate_condition", tool: "duplicate_condition", condition_id: twin.id, parent_id: src.id,
                  parent_had_family: !parentPatch });
    return {
      condition: newTag, condition_id: twin.id, variant_of: src.id, variant_label: lab,
      family_id: twin.family_id as string,
      inherited_rows: (twin.materials || []).length,
      note: `Materials follow ${src.finish_tag} until you edit them on this condition. No takeoffs came along — measure into ${newTag}.`,
    };
  }

  /** Cut a twin loose: every following row freezes where it stands. It KEEPS its family_id, so
   * it still groups with its siblings — only the inheritance ends. */
  splitCondition(tag: string) {
    const c = this.conditions.find((x) => x.finish_tag === tag);
    if (!c) {
      const known = this.conditions.map((x) => x.finish_tag);
      throw new UserError(`No condition ${JSON.stringify(tag)}.${known.length ? ` Known tags: ${known.join(", ")}.` : ""}`);
    }
    const cond = c as unknown as VariantCond;
    if (!cond.variant_of) {
      return { condition: tag, condition_id: c.id, split: false, frozen_rows: 0,
               note: "Already owns its materials — nothing was following." };
    }
    const frozen = (cond.materials || []).filter((r) => r.inherited).length;
    const before = structuredClone({ variant_of: cond.variant_of, materials: cond.materials,
                                     materials_dropped: cond.materials_dropped });
    const [next] = splitFromFamily([cond], cond.id);
    Object.assign(c, next);
    // splitFromFamily cuts variant_of and the tombstones BY OMISSION —
    // Object.assign cannot delete, so take them off the live object
    // explicitly or the "split" twin would still carry its link in every
    // export and read as a follower to the canvas.
    delete (c as unknown as VariantCond).variant_of;
    delete (c as unknown as VariantCond).materials_dropped;
    this.record({ op: "split_condition", tool: "split_condition", condition_id: c.id, before });
    return { condition: tag, condition_id: c.id, split: true, frozen_rows: frozen,
             family_id: cond.family_id as string | undefined,
             note: "Frozen at its current values; edits to the original no longer reach it. It still groups with its family." };
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
        // the write may have PROPAGATED (variants.ts — the same
        // propagate-on-write the canvas runs), so the entry carries snapshots
        // for every condition it could reach: the target plus its
        // descendants, tombstones included. Each goes back verbatim.
        const put = (condition_id: string, before: MaterialRow[], dropped?: string[]) => {
          const cc = this.conditions.find((x) => x.id === condition_id) as unknown as VariantCond | undefined;
          if (!cc) return;
          cc.materials = before as unknown as VariantRow[];
          if (dropped === undefined) delete cc.materials_dropped;
          else cc.materials_dropped = dropped;
        };
        put(e.condition_id, e.before, e.dropped_before);
        for (const f of e.family ?? []) put(f.condition_id, f.before, f.dropped_before);
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
      } else if (e.op === "duplicate_condition") {
        // a twin is removed whole — and the family_id the mint may have stamped on the PARENT
        // comes off too when the parent had no family before, so undo leaves no orphan grouping
        const at = this.conditions.findIndex((x) => x.id === e.condition_id);
        if (at >= 0) this.conditions.splice(at, 1);
        if (!e.parent_had_family) {
          const parent = this.conditions.find((x) => x.id === e.parent_id) as unknown as VariantCond | undefined;
          if (parent) delete parent.family_id;
        }
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "split_condition") {
        // the link and every row's inherited/origin_id flag go back verbatim — a split is
        // reversible, so an agent that cut a twin loose by mistake is not stuck with it
        const c = this.conditions.find((x) => x.id === e.condition_id) as unknown as VariantCond | undefined;
        if (c) {
          if (e.before.variant_of === undefined) delete c.variant_of;
          else c.variant_of = e.before.variant_of;
          c.materials = structuredClone(e.before.materials) as VariantCond["materials"];
          if (e.before.materials_dropped === undefined) delete c.materials_dropped;
          else c.materials_dropped = structuredClone(e.before.materials_dropped);
        }
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "cutout") {
        // parent and hole go back TOGETHER — the deduct vanishes and the
        // parent re-takes its frozen pre-cut snapshot, one gesture (#206)
        this.shapes = this.shapes.filter((x) => x.id !== e.deduct_id);
        const p = this.shapes.find((x) => x.id === e.parent_id);
        if (p) Session.restoreCutoutSnapshot(p, e.parent_prev);
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 1 });
      } else if (e.op === "runcut") {
        // the far-side pieces vanish and the run re-takes its pre-cut geometry
        const dead = new Set(e.minted_ids);
        this.shapes = this.shapes.filter((x) => !dead.has(x.id));
        const t = this.shapes.find((x) => x.id === e.target_id);
        if (t) Session.restoreCutoutSnapshot(t, e.target_prev);
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 1 + e.minted_ids.length });
      } else if (e.op === "cutout_restore") {
        // inverse of deleting a reconciled deduct: the deduct returns at its
        // index and the parent re-takes the cut state it held before
        this.shapes.splice(Math.min(e.removed.index, this.shapes.length), 0, e.removed.shape);
        const p = this.shapes.find((x) => x.id === e.parent_id);
        if (p) Session.restoreCutoutSnapshot(p, e.parent_after);
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 1 });
      } else if (e.op === "rfi_create") {
        // unmint the record and hand every linked markup its previous link back
        this.rfis = this.rfis.filter((r) => r.id !== e.id);
        for (const l of e.links) {
          const m = this.markups.find((x) => x.id === l.markup_id);
          if (m) m.rfi_id = l.prev_rfi_id;
        }
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "rfi_resolve") {
        // the pre-answer record goes back verbatim: status, response, dates
        const i = this.rfis.findIndex((r) => r.id === e.before.id);
        if (i >= 0) this.rfis[i] = structuredClone(e.before);
        undone.push({ seq: e.seq, op: e.op, tool: e.tool, shapes: 0 });
      } else if (e.op === "rfi_delete") {
        // the tombstone yields to the record it replaced, in place, and the
        // markups the delete unlinked point at it again
        const i = this.rfis.findIndex((r) => r.id === e.before.id);
        if (i >= 0) this.rfis[i] = structuredClone(e.before);
        else this.rfis.push(structuredClone(e.before));
        for (const id of e.unlinked) {
          const m = this.markups.find((x) => x.id === id);
          if (m) m.rfi_id = e.before.id;
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

  // ── RFIs (#364) — raise, list, answer, withdraw a question on the sheet ───
  // The register is the canvas's (RfiPanel.jsx): same record, same numbering
  // (nextRfiNumber), same link rule (markup.rfi_id). What differs is who
  // asked: everything minted here is origin {actor: "agent", reviewed: false}
  // — pending until an estimator accepts it in the panel, because an RFI
  // goes to the architect and nothing sends without a human.

  /** The register without its tombstones — what lists, prints, and exports. */
  liveRfis(): Rfi[] {
    return liveRfis(this.rfis) as Rfi[];
  }

  private rfiById(id: string): Rfi {
    const r = this.rfis.find((x) => x.id === id);
    if (!r || r.deleted === true) throw new UserError(`No RFI ${JSON.stringify(id)}${r ? ` — ${r.number} was withdrawn (its number stays reserved)` : ""} — list_rfis has the real ids.`);
    return r;
  }

  private rfiRow(r: Rfi): Record<string, unknown> {
    const tagById = new Map(this.conditions.map((c) => [c.id, c.finish_tag]));
    const linked = this.markups.filter((m) => m.rfi_id === r.id);
    return {
      id: r.id,
      number: r.number,
      subject: r.subject,
      question: r.question,
      status: r.status,
      sheet: r.sheet_id,
      actor: r.origin?.actor ?? "estimator",
      pending: r.origin?.actor === "agent" && r.origin.reviewed !== true,
      date: r.date,
      response: r.response,
      response_date: r.response_date,
      linked_markups: linked.map((m) => m.id),
      // the scopes the question touches, through its markups' condition links
      conditions: [...new Set(linked.map((m) => tagById.get(m.condition_id) ?? "").filter(Boolean))],
    };
  }

  /** Raise an RFI. Next number in the panel's own sequence (gaps and
   * tombstones included, so a number is never reissued), status open, dated
   * today, sheet resolved like every other tool. markup_ids link existing
   * annotations the way the panel's Link control does — a markup already on
   * another RFI moves (the panel's own overwrite), and the previous link is
   * journaled so undo puts it back. Every id must exist: a question pinned
   * to a markup that isn't there is a question about nothing. */
  createRfi(a: { title: string; question: string; sheet: string; markup_ids?: string[] }): Record<string, unknown> {
    const s = this.sheet(a.sheet);
    const title = (a.title ?? "").trim();
    const question = (a.question ?? "").trim();
    if (!title) throw new UserError("An RFI needs a title — the one line the register and the schedule print for it.");
    if (!question) throw new UserError("An RFI needs a question — what you are asking the architect to answer.");
    const ids = [...new Set(a.markup_ids ?? [])];
    const marks = ids.map((id) => {
      const m = this.markups.find((x) => x.id === id);
      if (!m) throw new UserError(`No annotation ${JSON.stringify(id)} — list_annotations has the real ids; annotate first to give the question something to point at.`);
      return m;
    });
    const now = new Date();
    const r: Rfi = {
      id: uid("rfi"),
      number: nextRfiNumber(this.rfis),
      created_at: now.toISOString(),
      subject: title,
      question,
      status: "open",
      to: "",
      priority: "normal",
      cost_impact: false,
      schedule_impact: false,
      date: now.toISOString().slice(0, 10),
      response: "",
      response_date: "",
      sheet_id: s.key,
      // actor is the literal on the one line that writes it — no input reaches
      // it, so no MCP path mints an estimator's own question
      origin: { actor: "agent", reviewed: false },
    };
    const links = marks.map((m) => ({ markup_id: m.id, prev_rfi_id: m.rfi_id }));
    for (const m of marks) m.rfi_id = r.id;
    this.rfis.push(r);
    this.record({ op: "rfi_create", tool: "create_rfi", id: r.id, links });
    return {
      ...this.rfiRow(r),
      note: `Raised ${r.number} as the agent — PENDING in the estimator's register until accepted there (origin.reviewed false). It prints in the marked set's RFI schedule like any other RFI${marks.length ? `; ${marks.length} linked markup${marks.length === 1 ? "" : "s"} carry its number on the sheet` : "; link a cloud or callout (annotate, then markup_ids) so it points at something on the sheet"}.`,
    };
  }

  /** Every live RFI with its links resolved: linked markup ids and the finish
   * tags those markups are attached to. Withdrawn numbers are listed so the
   * gap in the sequence is explained, never silent. */
  listRfis(): Record<string, unknown> {
    const live = this.liveRfis();
    return {
      rfis: live.map((r) => this.rfiRow(r)),
      count: live.length,
      open: live.filter((r) => r.status === "open").length,
      pending: live.filter((r) => r.origin?.actor === "agent" && r.origin.reviewed !== true).length,
      withdrawn: this.rfis.filter((r) => r.deleted === true).map((r) => r.number),
    };
  }

  /** Answer an OPEN RFI: the answer lands as the response, status becomes
   * answered (the panel's own state for "response in" — its lifecycle is
   * open → answered → closed, with void for withdrawn), and the response
   * date stamps exactly as the panel's status→date auto-stamp does, plus an
   * ISO timestamp of the resolve. Anything not open is refused: an answered
   * or closed question is not re-answered here, and a voided one is not
   * quietly revived. */
  resolveRfi(id: string, answer: string): Record<string, unknown> {
    const r = this.rfiById(id);
    const text = (answer ?? "").trim();
    if (!text) throw new UserError(`${r.number} needs an answer — resolve_rfi records the response; to withdraw the question use delete_rfi.`);
    if (r.status !== "open") {
      throw new UserError(`${r.number} is ${r.status}, not open — resolve_rfi answers an OPEN question only. list_rfis shows each status; a resolved RFI stays resolved (undo_last reverses your own resolve).`);
    }
    const before = structuredClone(r);
    const now = new Date();
    r.status = "answered";
    r.response = text;
    if (!r.response_date) r.response_date = now.toISOString().slice(0, 10);
    r.resolved_at = now.toISOString();
    r.resolved_by = "agent";
    this.record({ op: "rfi_resolve", tool: "resolve_rfi", before });
    return {
      ...this.rfiRow(r),
      resolved_at: r.resolved_at,
      note: `${r.number} answered — status answered, response recorded${r.origin?.actor === "agent" && r.origin.reviewed !== true ? "; it is still pending the estimator's acceptance in the register" : ""}.`,
    };
  }

  /** Withdraw an RFI: a TOMBSTONE, never a removal. The record stays with
   * deleted: true so its number is never reissued — the register and the
   * marked set keep printing a gap where it was — and every linked markup
   * loses its link (the canvas's own delete rule: clear the pointer, keep
   * the note). Undo swaps the record back and re-links. */
  deleteRfi(id: string): Record<string, unknown> {
    const r = this.rfiById(id);
    const before = structuredClone(r);
    const unlinked = this.markups.filter((m) => m.rfi_id === r.id).map((m) => m.id);
    for (const m of this.markups) if (m.rfi_id === r.id) m.rfi_id = "";
    const i = this.rfis.indexOf(r);
    this.rfis[i] = { ...before, status: "void", deleted: true, deleted_at: new Date().toISOString() };
    this.record({ op: "rfi_delete", tool: "delete_rfi", before, unlinked });
    return {
      deleted: r.id,
      number: r.number,
      unlinked_markups: unlinked.length,
      rfis_remaining: this.liveRfis().length,
      note: `${r.number} withdrawn — a tombstone, not a renumber: the register and the marked set keep the gap, and the next RFI takes ${nextRfiNumber(this.rfis)}. ${unlinked.length ? `${unlinked.length} markup${unlinked.length === 1 ? "" : "s"} kept their note and lost the link.` : "No markups were linked."} undo_last puts it back.`,
    };
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
  /** The takeoff on ONE sheet as a DXF drawing (R2000, LWPOLYLINE per shape,
   * OT-<TAG> layer per finish, feet by default) — the CAD-native handoff.
   * `sheet` omitted resolves only when exactly one calibrated sheet carries
   * shapes; otherwise the refusal names the candidates, because two floors in
   * one model space at the same origin would be a lie. A sheet without a
   * scale refuses too (a CAD file in pixels is worse than none). */
  exportDxf(sheetName?: string, units: "ft" | "m" = "ft"): { sheet: SheetState; build: DxfBuild } {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    let s: SheetState;
    if (sheetName != null && sheetName !== "") {
      s = this.sheet(sheetName);
    } else {
      const withShapes = new Set(this.shapes.map((x) => x.sheet_id));
      const cands = [...this.sheets.values()].filter((x) => withShapes.has(x.key));
      if (cands.length === 0) throw new UserError("No sheet carries committed shapes yet — measure something before exporting to CAD.");
      if (cands.length > 1) {
        throw new UserError(`Several sheets carry shapes — pass sheet to pick one drawing (a DXF is one sheet, like a DWG is): ${cands.map((x) => `"${x.key}"${x.sheetNumber ? ` (${x.sheetNumber})` : ""}`).join(", ")}.`);
      }
      s = cands[0];
    }
    if (s.upp == null) throw new UserError(`Sheet "${s.key}" has no scale — call set_scale first; a CAD file in pixels is worse than none.`);
    const build = buildSheetDxf({
      sheet_id: s.key,
      label: s.sheetNumber || s.key,
      dims: { w: s.widthPx, h: s.heightPx },
      upp: s.upp,
      shapes: this.shapes,
      conditions: this.conditions,
    }, { units });
    return { sheet: s, build };
  }

  exportPayload() {
    if (!this.docs.size) throw new UserError("No plan loaded — call load_plan first.");
    return {
      schema: ANN_SCHEMA,
      project_name: "",
      units: "imperial",
      sheets: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({
        sheet_id: s.key, units_per_px: s.upp,
        // provenance rides the payload (it used to be dropped here): the canvas
        // hydrates scale_source for its report and scale_confirmed for the
        // scale gate's confirm affordance — absent = confirmed (pre-flag docs)
        ...(s.scaleSource ? { scale_source: s.scaleSource } : {}),
        ...(s.scaleConfirmed === false ? { scale_confirmed: false } : {}),
      })),
      conditions: this.conditions,
      shapes: this.shapes,
      markups: this.markups,
      // approvals ride the payload additively (#176) — present only when any
      // exist, exactly the canvas buildPayload's convention, so a verdict-free
      // export stays byte-identical to a pre-#176 one
      ...(this.approvals.length ? { approvals: this.approvals } : {}),
      // RFIs (#364): the panel's own records, tombstones stripped — the app
      // has no tombstone notion (its delete is a removal), and a withdrawn
      // question must not resurface there as a stray Void row. Same
      // present-only-when-any convention as approvals.
      ...(this.liveRfis().length ? { rfis: this.liveRfis() } : {}),
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
    // roll goods (#147): the same pure seam the canvas report uses — figured
    // here so the report.v1 block fills the moment a condition carries a setup.
    // It runs BEFORE the rows because a materials row with basis "seam_lf"
    // divides against the layout's figured seams, not against an area.
    const { dimsFor, uppFor } = this.rollInputs();
    const { byCond } = computeRollTakeoff(this.conditions, this.shapes, dimsFor, uppFor) as { byCond: Map<string, unknown> };
    const rows = (conditionTotals(this.conditions, this.shapes, { seamByShape: seamLfByShape(byCond) }) as Record<string, unknown>[]).filter((r) => (r.shape_count as number) > 0);
    return reportJson({
      projectName,
      rows,
      bySheet: sheetTotals(this.conditions, this.shapes),
      scaleInfo: [...this.sheets.values()].filter((s) => s.upp != null).map((s) => ({ sheet_id: s.key, scale_source: s.scaleSource ?? "unknown", scale_confirmed: s.scaleConfirmed !== false })),
      markups: this.markups,
      rfis: this.liveRfis(),
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
      // The drawn delta-triangle hunt needs linework — but the hunt is a BONUS
      // lane and must never take the graph down. On a monster set (a 287-sheet
      // combined pricing set is real), extracting-and-retaining every sheet's
      // vectors OOMs the process, so: only plan/schedule-shaped sheets that
      // carry a bare 1–2 digit span are hunted, extraction is THROWAWAY (the
      // cached s.geo is reused when a tool already paid for it, otherwise the
      // op list is dropped and the page cleaned), and a global vector budget
      // bounds the whole pass. Sheets past the budget are NAMED in notes —
      // text markers are still read everywhere.
      let vecBudget = 30_000_000; // segments across the whole hunt
      let skippedHeavy = 0;
      for (const s of this.sheets.values()) {
        if (!s.spans) s.spans = textSpans(s.page);
        const spans = s.spans.map((t) => ({ str: t.str, x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, ...(t.rot ? { rot: t.rot } : {}) }));
        let segs: number[] | undefined;
        if (spans.some((t) => /^\d{1,2}$/.test(t.str.trim()))) {
          const role = classifySheetRole({ key: s.key, sheet_number: s.sheetNumber, spans }).role;
          if (role === "plan" || role === "schedule" || role === "demolition" || role === "unknown") {
            if (vecBudget <= 0) skippedHeavy++;
            else if (s.geo) { segs = s.geo.segs; vecBudget -= segs.length / 4; }
            else {
              const opList = await s.page.operatorList();
              segs = extractVectorGeometry(opList, s.page.viewport.transform, OPS).segs;
              vecBudget -= segs.length / 4;
              s.page.cleanup();
            }
          }
        }
        inputs.push({ key: s.key, sheet_number: s.sheetNumber, spans, ...(segs?.length ? { segs } : {}) });
      }
      this.graph = buildSheetGraph(inputs);
      if (skippedHeavy) this.graph.notes.push(`drawn-delta hunt skipped on ${skippedHeavy} sheet(s) — the set's linework exceeded the vector budget; text revision markers (Δ2 / REV 2) were still read everywhere`);
    }
    return this.graph;
  }

  private static wireBox(b: [number, number, number, number]) {
    return { x0: round1(b[0]), y0: round1(b[1]), x1: round1(b[2]), y1: round1(b[3]) };
  }
  private static wireEvidence(e: { sheet: string; text: string; bbox: [number, number, number, number] }) {
    return { sheet: e.sheet, text: e.text, bbox: Session.wireBox(e.bbox) };
  }
  private static wireRoom(r: SheetGraph["rooms"][number]) {
    return {
      tag: r.tag, name: r.name, sheet: r.sheet, bbox: Session.wireBox(r.bbox),
      ...(r.building ? { building: r.building } : {}),
      ...(r.corroboration ? { corroboration: r.corroboration } : {}),
      ...(r.revision ? { revision: { rev: r.revision.rev, source: Session.wireEvidence(r.revision.source), ...(r.revision.drawn ? { drawn: true } : {}) } } : {}),
    };
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
      rooms: g.rooms.map(Session.wireRoom),
      ...(g.unmatched_tags.length ? {
        unmatched_tags: g.unmatched_tags.map((u) => ({
          tag: u.tag, sheet: u.sheet, bbox: Session.wireBox(u.bbox),
          ...(u.building ? { building: u.building } : {}),
          ...(u.name ? { name: u.name } : {}),
          reason: u.reason,
        })),
      } : {}),
      callouts: g.callouts.map((c) => ({ detail: c.detail, target_sheet: c.target_sheet, sheet: c.sheet, bbox: Session.wireBox(c.bbox) })),
      ...(g.buildings.length ? { buildings: g.buildings } : {}),
      ...(g.revisions.length ? { revisions: g.revisions.map((r) => ({ rev: r.rev, sheet: r.sheet, bbox: Session.wireBox(r.bbox), ...(r.drawn ? { drawn: true } : {}) })) } : {}),
      ...(g.notes.length ? { notes: g.notes } : {}),
      counts: { rooms: g.rooms.length, unmatched_tags: g.unmatched_tags.length, schedules: g.tables.length, callouts: g.callouts.length },
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
    // the column is "FLOOR" on a one-tier schedule and "FLOOR FINISH" under a
    // two-tier header (the sub-header takes its parent's name, #374); either
    // way the surface's first word is the surface
    const floor = res.finishes.find((f) => f.surface === "FLOOR" || f.surface.startsWith("FLOOR "));
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
    const room = res.room ? Session.wireRoom(res.room) : null;
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
      ...(res.revisions?.length ? { revisions: res.revisions.map((v) => ({ rev: v.rev, source: Session.wireEvidence(v.source), ...(v.drawn ? { drawn: true } : {}) })) } : {}),
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
        ...(t.rows.some((r) => r.revision) ? { revised_rows: t.rows.filter((r) => r.revision).length } : {}),
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
