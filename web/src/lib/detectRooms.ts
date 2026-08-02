// Detect Rooms (vector) — batch room detection from the sheet's own text
// layer. The thinnest end-to-end path: read room-number text labels, seed the
// EXISTING One-Click flood at each, keep only the clean floods, and hand the
// confident regions to the caller to trace/commit — the same shape a single
// One-Click call already produces, just N of them from one pass.
//
// Pure, DOM-free, pdfjs-free units so they run straight under node:
//   roomLabelSeeds  positioned text items → candidate seed points
//   oneClickArgs    mask px per foot → the canvas's scale-derived flood args
//   floodAtSeed     mask + seed → the One-Click engine, canvas-identical
//   detectRegions   seeds + mask → { seed, flood } for each CLEAN (ok) flood,
//                   through the SAME sealed flood the click path uses
//   detectionReport tally of one pass → the honest readout (see the bottom of
//                   this file — the numbers matter less than saying what they
//                   do NOT cover)
//
// A6 (audit): floodAtSeed/oneClickArgs exist because the argument derivation a
// One-Click needs — seal radii, door-wedge cap, minimum-passage radius, all
// functions of the sheet scale — was written out at each call site, and the
// non-canvas ones (this module, mcp/src/session.ts) simply didn't write it:
// they called the raw floodRegion on a scale-less mask. Two surfaces, one
// origin.method ("one_click_v1"), different square footage. Now every non-
// canvas caller goes through floodAtSeed, and web/test/engineParity.test.ts
// pins it against the canvas's own inline call.
//
// The caller owns pdf.js/the DOM (extracting positioned text, building the
// mask via oneclick.ts, tracing/committing results) — this module imports
// nothing from pdfjs and takes text already resolved to seed-space px, so it
// works identically whether the caller is the browser canvas or the MCP
// server's Node-side session (mcp/src/pdf.ts's positionedText already does
// the viewport-transform composition; this module has no need to redo it).

import {
  floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, SENS_BALANCED,
} from "./oneclick.ts";
import type { MaskObj, FloodResult } from "./oneclick.ts";

/** A room-number label pattern: 2–3 digits with an optional trailing letter
 *  (134, 139A, 170) — the same shape estimators read off a finish plan. */
export const ROOM_LABEL_RE = /^\d{2,3}[A-Z]?$/;

/** One positioned text item, already resolved to the caller's seed-space px
 *  (image px for the browser canvas; the same for the MCP server, which
 *  resolves it via pdfjs.Util.transform in positionedText). */
export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  /** Text height in the same px, when the caller can supply it (device-space
   *  glyph height — `hypot(t[2], t[3])` of the viewport-composed text matrix).
   *  Without it the seed stays on the anchor; see `placement` below. */
  h?: number;
}

/** A room-number label found in the text layer, with its seed point. */
export interface RoomLabelSeed {
  str: string;
  seed: [number, number];
}

/** Text that carries a number matching the room pattern but is NOT a room tag.
 *  Measured on a real VA finish plan: of 56 items matching the bare pattern,
 *  16 (29%) were not rooms — the plan's OWN printed areas ("557 SF", whose
 *  numeric token survives tokenization), a dimension string ("58'-5\""), a
 *  drawing number ("08 - 6231"), and title-block text ("RENOVATE BUILDING
 *  28"). The paper-space numerals among them produced the largest "room" on
 *  the sheet, 847 SF of title block (issue #184 round 9). */
const UNIT_OR_DIM_RE = /\d\s*(?:SF|S\.F\.|SQ\.?\s*FT|GSF|NSF|["'′″]|-\s*\d+["'])/i;
/** A second numeric token that is NOT a room number means this is a code or a
 *  measurement, not "OFFICE 101" — "08 - 6231", "1 OF 12", "A-101 3". */
const OTHER_NUMBER_RE = /^\d+(?:\.\d+)?$/;
/** Title-block / sheet vocabulary. A room tag never sits in a sentence. */
const NON_ROOM_WORDS = new Set([
  "BUILDING", "BLDG", "SHEET", "DRAWING", "DWG", "PROJECT", "NO", "NUMBER",
  "SCALE", "DATE", "REV", "REVISION", "PHASE", "CONTRACT", "OF", "DETAIL",
  "SECTION", "PLAN", "NORTH", "KEY", "NOTE", "NOTES", "TOTAL", "AREA",
]);

export interface RoomLabelOptions {
  /** Drawing extent in seed-space px. Text outside it — title block, sheet
   *  margin, revision cloud legend — is not a room tag. Supply the sheet
   *  dimensions and an inset, or omit to skip the spatial gate entirely. */
  bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** Where the seed goes relative to the label.
   *
   *  "anchor" is the text baseline origin — the original behavior, and what a
   *  caller with no glyph metrics gets. It fails on a very common drafting
   *  convention: a rectangle drawn AROUND the room tag. The seed then floods
   *  the inside of that box, ~3.5 SF, not the room. On the VA finish plan that
   *  was 37 of 41 proposals (issue #184 round 9).
   *
   *  "below-box" (the default when the item carries `h`) drops the seed clear
   *  of the tag. Below, not beside: the box hugs the text horizontally — it is
   *  ~2.6x the width of the run, so a width-based offset stays inside it — but
   *  extends only a few px under the baseline. Measured against the same 41
   *  seeds: median proposal 3 SF → 52 SF, sub-4-SF 37 → 11, and the rooms the
   *  sheet's tags can reach go from 0 of 2 to 2 of 2. */
  placement?: "anchor" | "below-box";
  /** Multiples of the text height to drop by, for "below-box". */
  gap?: number;
}

/** Default drop for "below-box", in multiples of the label's text height.
 *  Enough to clear the tag box's bottom edge, short enough to stay inside a
 *  small room: at a 1/8" sheet a room-tag run is ~0.6 ft tall, so this is
 *  ~0.9 ft below the baseline. */
export const LABEL_GAP = 1.5;

/** Scan positioned text items for room-number labels, returning each as a
 *  seed point. An item's string may be JUST the number ("134") or a
 *  name+number ("OFFICE 101", "CORRIDOR 104") — a single text run often
 *  carries both on a finish plan — so this tokenizes on whitespace and keeps
 *  the item if ANY token matches the room-number pattern. The seed is the
 *  item's own anchor point (its text-matrix origin, already resolved by the
 *  caller) — for a left-aligned room label that sits inside the room's
 *  floodable area; the flood's own few-px nudge absorbs landing near a wall.
 *
 *  Matching the number is not enough: a plan is full of two- and three-digit
 *  numerals that are not rooms. The rejections above are all textual and cheap;
 *  the spatial one (`opts.bounds`) is opt-in because only the caller knows
 *  where the drawing ends and the paper begins. */
export function roomLabelSeeds(items: PositionedTextItem[], opts: RoomLabelOptions = {}): RoomLabelSeed[] {
  const out: RoomLabelSeed[] = [];
  const b = opts.bounds;
  for (const it of items) {
    const raw = (it.str || "").trim();
    if (!raw) continue;
    const toks = raw.split(/\s+/);
    const num = toks.find((tok) => ROOM_LABEL_RE.test(tok));
    if (!num) continue;
    if (UNIT_OR_DIM_RE.test(raw)) continue;                       // "557 SF", "58'-5\""
    if (toks.some((t) => t !== num && OTHER_NUMBER_RE.test(t))) continue;   // "08 - 6231"
    if (toks.some((t) => NON_ROOM_WORDS.has(t.replace(/[^A-Z]/gi, "").toUpperCase()))) continue;
    if (b && (it.x < b.x0 || it.x > b.x1 || it.y < b.y0 || it.y > b.y1)) continue;
    // y grows downward in seed space (image px, origin top-left)
    const place = opts.placement ?? (it.h && it.h > 0 ? "below-box" : "anchor");
    const dy = place === "below-box" && it.h && it.h > 0 ? (opts.gap ?? LABEL_GAP) * it.h : 0;
    out.push({ str: num, seed: [it.x, it.y + dy] });
  }
  return out;
}

/** The scale-derived flood arguments a One-Click uses, for a sheet where one
 *  foot spans `maskPxPerFt` mask px. Byte-for-byte what TakeoffCanvas.jsx
 *  computes at a click:
 *      const mppf = mo.ws / upp;
 *      floodRegionSealed(mo, x, y, fillSens, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf))
 *
 *  At maskPxPerFt ≤ 0 (no scale on the sheet) each helper returns its own
 *  documented scale-blind fallback — the hairline SEAL_RADII floor, no door
 *  wedge retry, minimum-passage rule off. That is a WEAKER measurement, not an
 *  equivalent one, so `scaleBlind` is returned alongside for callers to surface
 *  rather than guess a scale nobody supplied. */
export function oneClickArgs(maskPxPerFt: number): {
  mppf: number; scaleBlind: boolean; radii: number[]; wedgeCapPx: number; minPassPx: number;
} {
  const mppf = Number.isFinite(maskPxPerFt) && maskPxPerFt > 0 ? maskPxPerFt : 0;
  return {
    mppf,
    scaleBlind: mppf <= 0,
    radii: sealRadiiFor(mppf),
    wedgeCapPx: doorWedgeCapPx(mppf),
    minPassPx: minPassRadiusFor(mppf),
  };
}

/** The One-Click engine at one seed — the single entry point every non-canvas
 *  surface (batch detection, the MCP server) measures through, so none of them
 *  can drift from the canvas again. `maskPxPerFt` defaults to the mask's own
 *  `mppf`, which buildMask derives from the sheet scale and which is exactly
 *  the canvas's `mo.ws / upp`; raster masks carry none (buildRasterMask doesn't
 *  set it) and pass it explicitly, as the canvas does. */
export function floodAtSeed(
  maskObj: MaskObj,
  ix: number,
  iy: number,
  sensitivity: number = SENS_BALANCED,
  maskPxPerFt: number = maskObj.mppf || 0,
): FloodResult {
  const a = oneClickArgs(maskPxPerFt);
  return floodRegionSealed(maskObj, ix, iy, sensitivity, a.radii, a.wedgeCapPx, a.minPassPx);
}

/** The conventional drawing extent: the sheet inset by `frac` on every side.
 *  Crude but honest — the title block, border numerals and sheet index all
 *  live in that band, and a room tag essentially never does. */
export function sheetBounds(widthPx: number, heightPx: number, frac = 0.06): NonNullable<RoomLabelOptions["bounds"]> {
  return { x0: widthPx * frac, y0: heightPx * frac, x1: widthPx * (1 - frac), y1: heightPx * (1 - frac) };
}

/** A detected region: the label seed and the CLEAN flood it produced. The
 *  flood is always status "ok" (the gate below withholds everything else),
 *  so `hatchFiltered` is meaningful and traceRegion can consume it directly. */
export interface DetectedRegion {
  str: string;
  seed: [number, number];
  flood: Extract<FloodResult, { status: "ok" }>;
}

// ── the bubble problem (found live on a real plan, 2026-07-24) ───────────────
// Plans draw room numbers inside a small box or ellipse — the label BUBBLE.
// A seed at (or near) the label lands INSIDE that bubble, the flood is
// legitimately enclosed by it, and the trace comes back clean at label size:
// on the discovering sheet, 25 of 26 "rooms" were bubbles. Clean is not the
// same as right. Two pure guards, both scale-free (they compare the ring to
// the label's own box, so they work before any scale is set — exactly where
// the SF plausibility floor cannot):
//
//   seedLadderPx    probe seeds in order — the label's own anchor first
//                   (bubble-less plans stay one-flood fast), then below /
//                   above / farther below at label-height offsets. Bubble
//                   diameters track text size; room sizes don't.
//   isLabelBubblePx a traced ring whose bbox barely exceeds the label's own
//                   bbox IS the label.

/** Ring bbox ≤ this × label bbox (both axes) ⇒ the label's own bubble. */
export const BUBBLE_RATIO = 2.5;

export interface LabelBBox { x0: number; y0: number; x1: number; y1: number }

/** Probe seeds for one label, best-first, in the caller's px space.
 *
 *  `first` picks which rung leads:
 *
 *  "anchor" (the default, unchanged) starts at the label's own center —
 *  bubble-less plans stay one-flood fast, and the bubble guard is what
 *  rejects the tag-box flood when there IS a box.
 *
 *  "below-box" starts at the below-the-box rung (center + 2h — the same drop
 *  as roomLabelSeeds' below-box placement, y1 + LABEL_GAP·h) and demotes the
 *  center to a fallback. This is the fork's issue #184 item F measurement
 *  carried into the ladder: on the very common "rectangle drawn around the
 *  room tag" convention the center rung floods the box interior (37 of 41
 *  tags on the VA finish plan), and when that box is LARGE relative to the
 *  text — a name+number tag — its ring can clear the bubble ratio and be
 *  accepted as a tiny "room". Leading with the below-box rung reaches the
 *  room first, so the guard never has to adjudicate the box at all. */
export function seedLadderPx(b: LabelBBox, first: "anchor" | "below-box" = "anchor"): [number, number][] {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const h = Math.max(b.y1 - b.y0, 1);
  const center: [number, number] = [cx, cy], below: [number, number] = [cx, cy + 2 * h];
  const rest: [number, number][] = [[cx, cy - 2 * h], [cx, cy + 3.5 * h]];
  return first === "below-box" ? [below, center, ...rest] : [center, below, ...rest];
}

// ── flood ownership (the tag-box carve-out, measured 2026-07-30) ────────────
// A clean, non-bubble flood at some rung is not automatically THIS label's
// room: a rung can step across a shared wall and flood the NEIGHBORING space,
// and committing that under this label silently unmeasures a real room. The
// obvious ownership test — point-in-polygon of the label center against the
// traced ring — is WRONG on the very sheets the below-box ladder exists for:
// when the drawn tag box is connected to a wall by its leader line, the flood
// cannot cross box or leader, so the traced OUTER ring notches inward around
// the box and the label center falls outside the polygon even though the
// flood IS the label's room. Measured on the VA finish plan: 7 real rooms
// (125, 133, 136, 145A, 147A, 151A, 157 — 80/47/90/39/46/35/172 SF) fail the
// point-in-polygon test that way, while every reachable room whose tag box
// floats free of the walls passes it.
//
// The robust question is asked of the flood's own REGION BITMAP instead: does
// the flooded area SURROUND the label's box? Probe just outside each side of
// the box (clearing the drawn tag box, which overhangs the text ~1×h
// horizontally and ~0.2×h vertically — hence the offsets below) and count
// sides that land in flooded cells:
//   · the label's own room wraps its tag box — 3 or 4 sides hit (4 usually;
//     3 when the box abuts a wall or its leader blocks one side: 133, 136,
//     145A measured exactly 3);
//   · a neighboring space reached by an over-stepped rung touches the box
//     from ONE side only — every wrong-space flood measured on the sheet
//     (neighbor rooms, corridor slivers, below-tag pockets: 142's 155 SF
//     open area, 134A's 86 SF office-136 flood, 170/150/154/159's pockets,
//     138A's 31 SF fragment, 167's 6 SF fragment) scored 0–2 sides.
// Three sample distances per side and three positions along each side keep a
// single wall stroke, hatch line, or plumbing fixture from eating the probe.

/** Sides of the label box (of 4) that must land in flooded cells for the
 *  flood to own the label. Measured gap on the VA plan: real rooms score 3-4,
 *  wrong-space floods 0-2 (see the block comment above). */
export const SURROUND_MIN_SIDES = 3;

/** Does this flood's region surround the label's bbox? `f` is the "ok" flood
 *  (region bitmap in mask cells; image px = cell / ws). Pure and scale-free —
 *  all offsets are multiples of the label's own text height. */
export function floodSurroundsLabelPx(
  f: { region: Uint8Array; mw: number; mh: number; ws: number },
  b: LabelBBox,
): boolean {
  const inRegion = (x: number, y: number): boolean => {
    const mx = Math.round(x * f.ws), my = Math.round(y * f.ws);
    return mx >= 0 && my >= 0 && mx < f.mw && my < f.mh && !!f.region[my * f.mw + mx];
  };
  const h = Math.max(b.y1 - b.y0, 1);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, w = b.x1 - b.x0;
  const alongX = [cx - 0.35 * w, cx, cx + 0.35 * w];
  const alongY = [cy - 0.3 * h, cy, cy + 0.3 * h];
  const vd = [0.6, 1.1, 1.6].map((k) => k * h);   // past the box's ~0.2h vertical overhang
  const hd = [1.3, 1.8, 2.3].map((k) => k * h);   // past the box's ~1.0h horizontal overhang
  let sides = 0;
  if (alongX.some((x) => vd.some((d) => inRegion(x, b.y0 - d)))) sides++;   // above
  if (alongX.some((x) => vd.some((d) => inRegion(x, b.y1 + d)))) sides++;   // below
  if (alongY.some((y) => hd.some((d) => inRegion(b.x0 - d, y)))) sides++;   // left
  if (alongY.some((y) => hd.some((d) => inRegion(b.x1 + d, y)))) sides++;   // right
  return sides >= SURROUND_MIN_SIDES;
}

/** Is this traced ring just the label's own bubble? Same px space as the ring. */
export function isLabelBubblePx(ring: [number, number][], b: LabelBBox): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const lw = Math.max(b.x1 - b.x0, 1e-6), lh = Math.max(b.y1 - b.y0, 1e-6);
  return (x1 - x0) <= BUBBLE_RATIO * lw && (y1 - y0) <= BUBBLE_RATIO * lh;
}

/** Seed the SAME flood the click path uses at each label and apply the
 *  high-precision status gate: keep a region ONLY if the flood returns status
 *  "ok". leak / tiny / boundary are silently dropped — a batch detector must
 *  never propose a bad trace just because a label happened to be there.
 *
 *  The gate keys off flood STATUS, not `hatchFiltered`. A grow-but-verify
 *  hatch escalation still returns status "ok" with hatchFiltered: true — that
 *  is a real room (most rooms on a finish plan are hatched), so it's kept.
 *  hatchFiltered rides through as provenance, never a rejection reason.
 *
 *  A6 (audit) / PARITY: the flood is `floodAtSeed` — floodRegionSealed with the
 *  SAME scale-derived arguments the canvas passes at a One-Click (gap sealing,
 *  door-swing inclusion, the feet-true minimum-passage rule). It used to be the
 *  raw `floodRegion`, so a batch detection and a canvas click on the same seed
 *  measured DIFFERENT square footage while both stamped origin.method
 *  "one_click_v1"; provenance could not tell them apart. Measured on the VA
 *  finish plan, that gap was mean IoU 0.817 vs 0.999 against the pinned
 *  goldens, and 16.6% of the sheet's proposed floor double-counted (two labels
 *  flooding one conjoined space through an unsealed doorway) vs 0.0% (issue
 *  #184 round 9). Swapping the engine changed which flood runs and nothing
 *  else — the gate above is untouched; when the sheet scale is unknown
 *  (`mppf` absent) each helper degrades to its documented scale-blind
 *  fallback, and `oneClickArgs` surfaces that as `scaleBlind`. */
export function detectRegions(
  maskObj: MaskObj,
  seeds: RoomLabelSeed[],
  sensitivity: number = SENS_BALANCED,
  maskPxPerFt: number = maskObj.mppf || 0,
): DetectedRegion[] {
  const out: DetectedRegion[] = [];
  for (const s of seeds) {
    const f = floodAtSeed(maskObj, s.seed[0], s.seed[1], sensitivity, maskPxPerFt);
    if (f.status !== "ok") continue;
    out.push({ str: s.str, seed: s.seed, flood: f });
  }
  return out;
}

// ── what one detection pass actually did ───────────────────────────────────
// A batch detector that reports only its successes lies by omission: the
// estimator sees N outlined rooms and reads the sheet as measured. It is not.
// Tag seeding has a hard ceiling — on the VA finish plan only 2 of the 8 known
// rooms carry a room-number tag AT ALL (corridors, the elevator and the
// vestibule carry none, and no seeding change reaches them), and roughly a
// quarter of the proposals that do come back are small artifacts. So the
// report below is built from what the pass SAW, not from what it produced,
// and every path through it — including the perfect one — carries the ceiling.

/** Counts collected while running a pass, in pipeline order. */
export interface DetectionTally {
  /** positioned text items scanned on the sheet */
  textItems: number;
  /** items carrying a numeral matching the room-number pattern (pre-filter) */
  patternHits: number;
  /** seeds surviving the text filters and the drawing-extent gate */
  seeds: number;
  /** seeds actually FLOODED. Equal to `seeds` on a completed pass; smaller on
   *  a cancelled one. Optional so an older caller still reports coherently —
   *  it then reads as "everything was tried", which is what a caller with no
   *  cancellation has done. */
  tried?: number;
  /** seeds whose flood came back clean (status "ok") */
  regions: number;
  /** regions that traced to a usable ring — the proposals actually offered */
  proposals: number;
  /** proposals under the caller's fixture-sized threshold */
  tiny: number;
  /** the human stopped the pass before it reached the last seed */
  cancelled?: boolean;
}

export interface DetectionReport {
  /** one sentence: what came back, ALWAYS against what was tried */
  headline: string;
  /** everything the headline does not cover — never empty */
  limits: string[];
  /** headline + limits, for a single-line message channel */
  message: string;
  /** nothing to review (no proposal was produced) */
  empty: boolean;
}

/** The limitation that holds on every sheet whatever the counts say. This is
 *  unconditional on purpose: it is exactly when the pass looks perfect (every
 *  tag produced a room) that the readout is most likely to be misread as
 *  "sheet complete". */
export const NO_TAG_CAVEAT =
  "Only rooms carrying a room-number tag are found — corridors, elevators and vestibules usually carry none and are NOT detected. One-Click those.";

const plural = (n: number) => (n === 1 ? "" : "s");

/** Turn a pass's tally into the readout. Pure — the canvas renders it, the
 *  tests pin it, and nothing here knows what a DOM is. */
export function detectionReport(t: DetectionTally, tinySf = 4): DetectionReport {
  const n = t.proposals;
  // Seeds actually FLOODED. On a completed pass this is every seed; on a
  // cancelled one it is fewer, and the difference must not be laundered into
  // "the fill failed" — a tag nobody tried and a tag that leaked are different
  // facts, and the second is the one that makes an estimator distrust a room
  // (Copilot review, PR #190).
  const tried = t.tried ?? t.seeds;
  const headline =
    t.seeds === 0
      ? t.patternHits === 0
        ? "No room-number tags on this sheet — detection has nothing to seed from."
        : `No room-number tags on this sheet — all ${t.patternHits} matching numeral${plural(t.patternHits)} were rejected as something else.`
      : n === 0
        ? `No rooms detected: ${t.seeds} room tag${plural(t.seeds)} found, ${tried === 0 ? "none was tried" : "none produced a usable region"}.`
        : `${n} of ${tried} room tag${plural(tried)} produced a room${t.cancelled ? ` (${t.seeds} on the sheet)` : ""}.`;
  const limits: string[] = [];
  if (t.cancelled) {
    const untried = Math.max(0, t.seeds - tried);
    limits.push(untried > 0
      ? `Stopped early — ${untried} room tag${plural(untried)} ${untried === 1 ? "was" : "were"} never tried.`
      : "Stopped early.");
  }
  if (t.seeds > 0 && t.patternHits > t.seeds) {
    const k = t.patternHits - t.seeds;
    limits.push(`${k} other numeral${plural(k)} rejected as not a room tag (printed areas, dimensions, drawing numbers, title-block text).`);
  }
  if (tried > n) {
    const k = tried - n;
    limits.push(`${k} tag${plural(k)} produced nothing — the fill leaked past the room, or landed in dense linework.`);
  }
  if (t.tiny > 0) {
    limits.push(`${t.tiny} proposal${plural(t.tiny)} under ${tinySf} SF — usually the box drawn around a room tag, not a room. Reject ${t.tiny === 1 ? "it" : "them"}.`);
  }
  limits.push(NO_TAG_CAVEAT);
  return { headline, limits, message: [headline, ...limits].join(" "), empty: n === 0 };
}
