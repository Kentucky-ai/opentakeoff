// Detect Rooms (vector) — batch room detection from the sheet's own text
// layer. The thinnest end-to-end path: read room-number text labels, seed the
// EXISTING One-Click flood at each, keep only the clean floods, and hand the
// confident regions to the caller to trace/commit — the same shape a single
// One-Click call already produces, just N of them from one pass.
//
// Both pure, DOM-free, pdfjs-free units so they run straight under node:
//   roomLabelSeeds  positioned text items → candidate seed points
//   detectRegions   seeds + mask → { seed, flood } for each CLEAN (ok) flood
//
// The caller owns pdf.js/the DOM (extracting positioned text, building the
// mask via oneclick.ts, tracing/committing results) — this module imports
// nothing from pdfjs and takes text already resolved to seed-space px, so it
// works identically whether the caller is the browser canvas or the MCP
// server's Node-side session (mcp/src/pdf.ts's positionedText already does
// the viewport-transform composition; this module has no need to redo it).

import { floodRegion, SENS_BALANCED } from "./oneclick.ts";
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
}

/** A room-number label found in the text layer, with its seed point. */
export interface RoomLabelSeed {
  str: string;
  seed: [number, number];
}

/** Scan positioned text items for room-number labels, returning each as a
 *  seed point. An item's string may be JUST the number ("134") or a
 *  name+number ("OFFICE 101", "CORRIDOR 104") — a single text run often
 *  carries both on a finish plan — so this tokenizes on whitespace and keeps
 *  the item if ANY token matches the room-number pattern. The seed is the
 *  item's own anchor point (its text-matrix origin, already resolved by the
 *  caller) — for a left-aligned room label that sits inside the room's
 *  floodable area; the flood's own few-px nudge absorbs landing near a wall. */
export function roomLabelSeeds(items: PositionedTextItem[]): RoomLabelSeed[] {
  const out: RoomLabelSeed[] = [];
  for (const it of items) {
    const num = (it.str || "").trim().split(/\s+/).find((tok) => ROOM_LABEL_RE.test(tok));
    if (!num) continue;
    out.push({ str: num, seed: [it.x, it.y] });
  }
  return out;
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

/** Probe seeds for one label, best-first, in the caller's px space. */
export function seedLadderPx(b: LabelBBox): [number, number][] {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const h = Math.max(b.y1 - b.y0, 1);
  return [[cx, cy], [cx, cy + 2 * h], [cx, cy - 2 * h], [cx, cy + 3.5 * h]];
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

/** Seed the EXISTING flood at each label and apply the high-precision status
 *  gate: keep a region ONLY if floodRegion returns status "ok". leak / tiny /
 *  boundary are silently dropped — a batch detector must never propose a bad
 *  trace just because a label happened to be there.
 *
 *  The gate keys off flood STATUS, not `hatchFiltered`. A grow-but-verify
 *  hatch escalation still returns status "ok" with hatchFiltered: true — that
 *  is a real room (most rooms on a finish plan are hatched), so it's kept.
 *  hatchFiltered rides through as provenance, never a rejection reason. */
export function detectRegions(
  maskObj: MaskObj,
  seeds: RoomLabelSeed[],
  sensitivity: number = SENS_BALANCED,
): DetectedRegion[] {
  const out: DetectedRegion[] = [];
  for (const s of seeds) {
    const f = floodRegion(maskObj, s.seed[0], s.seed[1], sensitivity);
    if (f.status !== "ok") continue;
    out.push({ str: s.str, seed: s.seed, flood: f });
  }
  return out;
}
