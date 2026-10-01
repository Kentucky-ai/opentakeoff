// Copy text (#471) — the pure half of the canvas tool: a box (or the
// whole page) → the readers → reading-order lines → the clipboard → the
// receipt. A pdf.js-shaped viewport (y flipped, scale 2), as in
// regionText.test.ts, so the text layer is read through the real
// extractRegionText and assembleLines.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT_LAYER, textLayerReader, readCopyText, boxOnPanel, pageIsScanLike, outcomeMessage,
  deliverCopy, retryCopy, receiptKeyDown, makeReceipt, receiptExpires, previewOf, receiptPlacement, receiptAfterEsc, createReadGate,
  PREVIEW_CHARS, type CopyReader, type CopyOutcome, type TextOutcome,
  OCR_LABEL, ocrWordsInRect, ocrCopyReaders, copyOcrRoute, copyReaderChain, copyUnavailable, copyIsScanLike, copyStartMiss, type BoxRead,
} from "../src/lib/copyText";
import { RAIL_CLEAR, CANVAS_EDGE, ZONE_PANEL_W, FLOAT_GAP, SWEEP_PANEL_W } from "../src/lib/canvasConstants.js";
import { RASTER_MIN_IMG_FRAC } from "../src/lib/rastermask";
import type { OcrWord } from "../src/lib/ocr/types";

const H = 1000;   // page height in points; image y = 2·(H − y)
const VP = { width: 1200, height: H * 2, transform: [2, 0, 0, -2, 0, H * 2] };
const flat = (str: string, x: number, y: number, width = 40) =>
  ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });
const vert = (str: string, x: number, y: number) =>
  ({ str, transform: [0, 10, -10, 0, x, y], width: 40, height: 10 });

// image px x 200..600, y 200..400 ⇔ points x 100..300, y 800..900
const BOX = { x0: 200, y0: 200, x1: 600, y1: 400 };
const NOTE = [flat("GENERAL", 110, 880), flat("NOTES", 160, 880), flat("SEE", 110, 860), flat("A-101", 140, 860)];
const tcOf = (...items: ReturnType<typeof flat>[]) => ({ items });
// nine runs, none of them punctuation, on the page and clear of BOX: the
// fewest a page can have and not be a scan (planIndex SCAN_MAX_TEXT_LINES)
// (each on its own line: the rule counts lines)
const NINE = Array.from({ length: 9 }, (_, i) => flat(`RUN${i}`, 320, 700 - i * 30));
const EIGHT = NINE.slice(0, 8);

const asOutcome = (o: CopyOutcome | Promise<CopyOutcome>): CopyOutcome => {
  assert.ok(!(o instanceof Promise), "a text-layer read must settle synchronously");
  return o as CopyOutcome;
};

// ── rect → text result ───────────────────────────────────────────────────────

test("a box of text: lines in reading order, the joined string, the reader label", () => {
  const o = asOutcome(readCopyText([textLayerReader(tcOf(...NOTE), VP)], BOX));
  assert.equal(o.kind, "text");
  if (o.kind !== "text") return;
  assert.equal(o.text, "GENERAL NOTES\nSEE A-101");
  assert.equal(o.lineCount, 2);
  assert.deepEqual(o.lines.map((l) => l.text), ["GENERAL NOTES", "SEE A-101"]);
  assert.equal(o.reader, "Text layer");
  assert.equal(TEXT_LAYER, "Text layer");
  assert.equal(o.skipped, 0);
});

test("rotated runs in the box are left out and counted", () => {
  const o = asOutcome(readCopyText([textLayerReader(tcOf(...NOTE, vert("12'-0\"", 250, 820), vert("9'-6\"", 270, 820)), VP)], BOX));
  assert.equal(o.kind, "text");
  if (o.kind !== "text") return;
  assert.equal(o.text, "GENERAL NOTES\nSEE A-101");
  assert.equal(o.skipped, 2);
});

test("text outside the box is not copied; a run the box only clips is", () => {
  // "CLIPPED" starts left of the box (x 190 px) but its glyphs run into it
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("OUTSIDE", 400, 500), flat("CLIPPED", 95, 850)), VP)], BOX));
  assert.equal(o.kind, "text");
  if (o.kind === "text") assert.equal(o.text, "CLIPPED");
});

test("a null rect reads the whole page", () => {
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("TOP", 50, 990), flat("BOTTOM", 50, 10)), VP)], null));
  assert.equal(o.kind, "text");
  if (o.kind === "text") assert.equal(o.text, "TOP\nBOTTOM");
});

// ── empty regions ────────────────────────────────────────────────────────────

test("an empty box is 'empty', not a zero-line copy", () => {
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("ELSEWHERE", 500, 100)), VP)], BOX));
  assert.deepEqual(o, { kind: "empty", tried: ["Text layer"] });
});

test("a box of only rotated text stops at the text layer: zero lines, the skipped count", () => {
  let asked = false;
  const next: CopyReader = { label: "OCR", read: () => { asked = true; return [{ str: "X", x: 0, y: 0, h: 1 }]; } };
  const o = asOutcome(readCopyText([textLayerReader(tcOf(vert("12'-0\"", 250, 820)), VP), next], BOX));
  assert.deepEqual(o, { kind: "rotated-only", reader: "Text layer", skipped: 1 });
  assert.equal(asked, false, "the next reader is for boxes with no text-layer text at all");
});

test("punctuation-only runs don't count toward a text layer (the planIndex rule), and a box of them falls through", () => {
  assert.equal(pageIsScanLike(tcOf(...EIGHT, flat("-", 110, 880), flat("...", 120, 870)), VP), true);
  assert.equal(pageIsScanLike(tcOf(...EIGHT, flat("-", 110, 880), flat("B2", 120, 870)), VP), false);
  let asked = false;
  const next: CopyReader = { label: "OCR", read: () => { asked = true; return [{ str: "ROOM", x: 0, y: 0, h: 1 }]; } };
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("--", 110, 880)), VP), next], BOX));
  assert.equal(asked, true, "the next reader is asked for a box holding only punctuation");
  assert.equal(o.kind, "text");
});

test("text outside the page's viewport doesn't count toward a text layer: the rule search and the Read control use", () => {
  // pdf.js keeps runs placed off the page (a crop box trimmed them away)
  const off = tcOf(...EIGHT, flat("TRIMMED", 1500, 500), flat("NOTE", 100, -40));
  assert.equal(pageIsScanLike(off, VP), true);
  assert.equal(pageIsScanLike(tcOf(...EIGHT, flat("TRIMMED", 1500, 500), flat("ROOM", 100, 500)), VP), false);
});

test("blank runs are not text", () => {
  assert.equal(pageIsScanLike(tcOf(...EIGHT, flat("  ", 110, 880), flat("", 120, 870)), VP), true);
  assert.equal(pageIsScanLike(tcOf(...EIGHT, flat("A", 110, 880)), VP), false);
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("   ", 110, 880)), VP)], BOX));
  assert.deepEqual(o, { kind: "empty", tried: ["Text layer"] });
});

const EMPTY = { kind: "empty", tried: [TEXT_LAYER] } as const;
test("messages tell an empty box, an empty page, a text-less sheet and rotated-only apart", () => {
  const msgs = new Set([
    outcomeMessage({ ...EMPTY, tried: [TEXT_LAYER] }, "box", false),
    outcomeMessage({ ...EMPTY, tried: [TEXT_LAYER] }, "page", false),
    outcomeMessage({ ...EMPTY, tried: [TEXT_LAYER] }, "box", true),
    outcomeMessage({ kind: "rotated-only", reader: TEXT_LAYER, skipped: 3 }, "box", false),
  ]);
  assert.equal(msgs.size, 4);
  assert.match(outcomeMessage({ ...EMPTY, tried: [TEXT_LAYER] }, "box", true), /no text layer/i);
  assert.match(outcomeMessage({ kind: "rotated-only", reader: TEXT_LAYER, skipped: 3 }, "box", false), /3 rotated/);
});

test("after another reader has also looked, the message names it and doesn't stop at 'no text layer'", () => {
  const m = outcomeMessage({ kind: "empty", tried: [TEXT_LAYER, "OCR"] }, "box", true);
  assert.match(m, /OCR/);
  assert.doesNotMatch(m, /no text to copy/);
  assert.notEqual(m, outcomeMessage({ kind: "empty", tried: [TEXT_LAYER] }, "box", true));
  assert.equal(outcomeMessage({ kind: "aborted" }, "box", false), "", "a cancelled read says nothing");
});

// ── the reader chain (the seam an OCR reader joins) ──────────────────────────

test("an async reader that finds nothing hands over to the next, which answers with its own label", async () => {
  const miss: CopyReader = { label: "Cache", read: async () => [] };
  const skip: CopyReader = { label: "Skipped?", read: () => null };
  const hit: CopyReader = { label: "OCR", read: () => [{ str: "READ", x: 0, y: 10, h: 8 }] };
  const o = await readCopyText([miss, skip, hit], BOX);
  assert.equal(o.kind, "text");
  if (o.kind === "text") assert.equal(o.reader, "OCR");
  // and the one straight after the async miss is asked too (no reader skipped)
  const o2 = await readCopyText([miss, hit], BOX);
  assert.equal(o2.kind === "text" && o2.reader, "OCR");
  assert.deepEqual(await readCopyText([miss], BOX), { kind: "empty", tried: ["Cache"] });
});

test("a reader that returns only blank runs hands over", () => {
  const blank: CopyReader = { label: "Text layer", read: () => [{ str: " ", x: 0, y: 0, h: 8 }] };
  const hit: CopyReader = { label: "OCR", read: () => [{ str: "READ", x: 0, y: 10, h: 8 }] };
  const o = asOutcome(readCopyText([blank, hit], BOX));
  assert.equal(o.kind === "text" && o.reader, "OCR");
});

test("every reader gets the signal; an aborted read asks no reader and reports aborted", async () => {
  const ac = new AbortController();
  const seen: unknown[] = [];
  const spy: CopyReader = { label: "Spy", read: (_r, o) => { seen.push(o.signal); return null; } };
  readCopyText([spy], BOX, { signal: ac.signal });
  assert.deepEqual(seen, [ac.signal]);
  ac.abort();
  assert.deepEqual(asOutcome(readCopyText([spy], BOX, { signal: ac.signal })), { kind: "aborted" });
  assert.equal(seen.length, 1, "no reader is asked once aborted");
});

test("a read aborted while an async reader works reports aborted, not its answer", async () => {
  const ac = new AbortController();
  let release!: () => void;
  const slow: CopyReader = { label: "OCR", read: () => new Promise((res) => { release = () => res([{ str: "LATE", x: 0, y: 10, h: 8 }]); }) };
  const p = readCopyText([slow], BOX, { signal: ac.signal });
  ac.abort(); release();
  assert.deepEqual(await p, { kind: "aborted" });
});

test("a new box read cancels the one in flight: two quick boxes can't both post", async () => {
  const gate = createReadGate();
  const releases: (() => void)[] = [];
  const slow = (s: string): CopyReader => ({ label: "OCR", read: () => new Promise((res) => { releases.push(() => res([{ str: s, x: 0, y: 10, h: 8 }])); }) });
  const first = readCopyText([slow("FIRST")], BOX, { signal: gate.begin() });
  const second = readCopyText([slow("SECOND")], BOX, { signal: gate.begin() });
  releases[1](); releases[0]();
  assert.deepEqual(await first, { kind: "aborted" });
  const o = await second;
  assert.equal(o.kind === "text" && o.text, "SECOND");
});

test("the chain falls through only on no tokens, and the reader supplies the label", async () => {
  const none: CopyReader = { label: "Text layer", read: () => [] };
  const nul: CopyReader = { label: "Cache", read: () => null };
  const later: CopyReader = { label: "OCR", read: async () => [{ str: "SCANNED", x: 10, y: 20, h: 8 }] };
  const out = readCopyText([none, nul, later], BOX);
  assert.ok(out instanceof Promise, "an async reader makes the result async");
  const o = await out;
  assert.equal(o.kind, "text");
  if (o.kind === "text") { assert.equal(o.reader, "OCR"); assert.equal(o.text, "SCANNED"); }
});

test("the first reader with tokens wins; later readers aren't asked", () => {
  let asked = false;
  const first: CopyReader = { label: "Text layer", read: () => [{ str: "HIT", x: 0, y: 10, h: 8 }] };
  const second: CopyReader = { label: "OCR", read: () => { asked = true; return null; } };
  const o = asOutcome(readCopyText([first, second], BOX));
  assert.equal(o.kind === "text" && o.reader, "Text layer");
  assert.equal(asked, false);
});

test("the rect handed to each reader is the one asked for", () => {
  const seen: unknown[] = [];
  const spy: CopyReader = { label: "Spy", read: (r) => { seen.push(r); return null; } };
  readCopyText([spy], BOX); readCopyText([spy], null);
  assert.deepEqual(seen, [BOX, null]);
});

// ── the box ──────────────────────────────────────────────────────────────────

const P1 = { key: "a.pdf", xOffset: 0, img: { w: 1000, h: 800 } };
const P2 = { key: "b.pdf", xOffset: 1024, img: { w: 1000, h: 800 } };

test("the box is in panel px, corners in any order, clamped to the sheet", () => {
  assert.deepEqual(boxOnPanel([1100, 900], [1300, 300], P2, P2), { rect: { x0: 76, y0: 300, x1: 276, y1: 800 } });
  assert.deepEqual(boxOnPanel([-50, -20], [100, 60], P1, P1), { rect: { x0: 0, y0: 0, x1: 100, y1: 60 } });
});

test("a box across two sheets, or smaller than 4 px, is refused with a reason", () => {
  assert.deepEqual(boxOnPanel([900, 100], [1100, 200], P1, P2), { error: "cross" });
  assert.deepEqual(boxOnPanel([100, 100], [103, 300], P1, P1), { error: "small" });
  assert.deepEqual(boxOnPanel([100, 100], [300, 102], P1, P1), { error: "small" });
});

test("exactly 4 px a side is a box", () => {
  assert.deepEqual(boxOnPanel([100, 100], [104, 104], P1, P1), { rect: { x0: 100, y0: 100, x1: 104, y1: 104 } });
});

// ── the clipboard and its fallback ───────────────────────────────────────────

test("deliverCopy calls writeText before its first await (inside the click's activation)", async () => {
  const calls: string[] = [];
  const clip = { writeText: (t: string) => { calls.push(t); return Promise.resolve(); } };
  const p = deliverCopy("NOTE", clip);
  assert.deepEqual(calls, ["NOTE"], "writeText must be called synchronously");
  assert.equal(await p, true);
});

test("a refused, missing or throwing clipboard means the write failed", async () => {
  assert.equal(await deliverCopy("x", { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) }), false);
  assert.equal(await deliverCopy("x", undefined), false);
  assert.equal(await deliverCopy("x", {} as never), false);
  assert.equal(await deliverCopy("x", { writeText: () => { throw new TypeError("boom"); } }), false);
});

const TEXT_OUT: TextOutcome = { kind: "text", reader: TEXT_LAYER, lines: [], text: "GENERAL NOTES\nSEE A-101", lineCount: 2, skipped: 1 };

test("the receipt carries the text, line count, reader, skipped count and whether the write failed", () => {
  const r = makeReceipt(TEXT_OUT, { failed: false, scope: "box", key: "a.pdf" });
  assert.deepEqual(r, { text: "GENERAL NOTES\nSEE A-101", lineCount: 2, preview: "GENERAL NOTES\nSEE A-101", reader: "Text layer", skipped: 1, failed: false, scope: "box", key: "a.pdf" });
  assert.equal(makeReceipt(TEXT_OUT, { failed: true, scope: "page", key: "a.pdf" }).failed, true);
});

test("a refused write keeps the receipt up; a written one expires", () => {
  assert.equal(receiptExpires(makeReceipt(TEXT_OUT, { failed: false, scope: "box", key: "k" })), true);
  assert.equal(receiptExpires(makeReceipt(TEXT_OUT, { failed: true, scope: "box", key: "k" })), false);
});

test("the preview is cut at a length, the text never is", () => {
  const long = "A".repeat(500);
  const r = makeReceipt({ ...TEXT_OUT, text: long }, { failed: false, scope: "box", key: "k" });
  assert.equal(r.text, long);
  assert.equal(r.preview, `${"A".repeat(220)}…`);
  assert.equal(previewOf("short"), "short");
  assert.equal(PREVIEW_CHARS, 220);
  assert.equal(previewOf("B".repeat(220)), "B".repeat(220), "exactly the limit is not cut");
  assert.equal(previewOf("B".repeat(221)), `${"B".repeat(220)}…`);
});

test("retry: selects the text and copies the selection first, then tries the clipboard", async () => {
  const steps: string[] = [];
  const env = (clipOk: boolean, execOk: boolean | "throw") => ({
    clipboard: { writeText: () => { steps.push("write"); return clipOk ? Promise.resolve() : Promise.reject(new Error("no")); } },
    select: () => { steps.push("select"); },
    execCopy: () => { steps.push("exec"); if (execOk === "throw") throw new Error("x"); return execOk; },
  });
  assert.equal(await retryCopy("t", env(false, true)), true);
  assert.deepEqual(steps.splice(0), ["select", "exec"], "a selection copy that takes needs no clipboard call");
  assert.equal(await retryCopy("t", env(true, false)), true);
  assert.deepEqual(steps.splice(0), ["select", "exec", "write"]);
  assert.equal(await retryCopy("t", env(true, "throw")), true);
  assert.equal(await retryCopy("t", env(false, false)), false);
  assert.equal(await retryCopy("t", env(false, "throw")), false);
  assert.equal(await retryCopy("t", { clipboard: undefined, select() {}, execCopy: () => false }), false);
});

test("retry: the selection copy runs inside the button's click, before any await", () => {
  const steps: string[] = [];
  void retryCopy("t", { clipboard: { writeText: () => { steps.push("write"); return Promise.resolve(); } }, select: () => { steps.push("select"); }, execCopy: () => { steps.push("exec"); return false; } });
  // Firefox and Safari allow execCommand("copy") only during the click's own dispatch
  assert.deepEqual(steps, ["select", "exec", "write"]);
});

test("Esc on the canvas clears a written receipt but keeps a refused one (its textarea holds the only copy)", () => {
  assert.equal(receiptAfterEsc(makeReceipt(TEXT_OUT, { failed: false, scope: "box", key: "k" })), null);
  const failed = makeReceipt(TEXT_OUT, { failed: true, scope: "box", key: "k" });
  assert.equal(receiptAfterEsc(failed), failed);
  assert.equal(receiptAfterEsc(null), null);
});

test("Esc in the receipt closes it; other keys pass", () => {
  let closed = 0, stopped = 0;
  const ev = (key: string) => ({ key, preventDefault() {}, stopPropagation() { stopped++; } });
  receiptKeyDown(ev("a"), () => { closed++; });
  assert.equal(closed, 0);
  receiptKeyDown(ev("Escape"), () => { closed++; });
  assert.equal(closed, 1);
  assert.equal(stopped, 1, "the canvas's own Esc chain doesn't also act on it");
});

// ── placement ────────────────────────────────────────────────────────────────

test("the receipt sits in the canvas, bottom-right below the live readout, clear of the panel rail", () => {
  const p = receiptPlacement({ sweepOpen: false, zoneOpen: false, narrow: false });
  assert.deepEqual(p, { position: "absolute", right: RAIL_CLEAR, bottom: CANVAS_EDGE });
  assert.equal(RAIL_CLEAR, 56, "the readout's and zone panel's clearance of the panel rail");
});

test("while a sweep is live the receipt moves left of the Sweep panel", () => {
  const p = receiptPlacement({ sweepOpen: true, zoneOpen: false, narrow: false });
  // the Sweep panel spans FLOAT_GAP … FLOAT_GAP + SWEEP_PANEL_W from the window's right edge;
  // the canvas's right edge is at or left of the window's, so this clears it
  assert.ok((p.right ?? 0) >= FLOAT_GAP + SWEEP_PANEL_W + FLOAT_GAP, `receipt at right ${p.right} overlaps the Sweep panel`);
  assert.equal(p.bottom, CANVAS_EDGE);
});

test("on a phone the readout is a bottom strip, so the receipt goes to the top", () => {
  const p = receiptPlacement({ sweepOpen: false, zoneOpen: false, narrow: true });
  assert.equal(p.bottom, undefined);
  assert.equal(p.top, CANVAS_EDGE);
});

test("while the Zone check panel is up (same corner) the receipt moves clear of it", () => {
  // the zone panel sits at right RAIL_CLEAR, bottom CANVAS_EDGE, ZONE_PANEL_W wide, of any height
  const zoneLeft = RAIL_CLEAR + ZONE_PANEL_W;
  const p = receiptPlacement({ sweepOpen: false, zoneOpen: true, narrow: false });
  assert.ok((p.right ?? 0) > zoneLeft, `receipt at right ${p.right} overlaps the zone panel (to ${zoneLeft})`);
  const both = receiptPlacement({ sweepOpen: true, zoneOpen: true, narrow: false });
  assert.ok((both.right ?? 0) > zoneLeft && (both.right ?? 0) >= FLOAT_GAP + SWEEP_PANEL_W + FLOAT_GAP, "clear of both");
  assert.equal(ZONE_PANEL_W, 300);
});

// ── the OCR readers: the page's read, then a read of the box ─────────────────

// OCR lines in rs px: x left, y bottom, w, h — a text-less page, so the text
// layer finds nothing and the chain reaches these
const OCR_LINES: OcrWord[] = [
  { str: "GENERAL NOTES", x: 210, y: 240, w: 180, h: 20, confidence: 0.9 },
  { str: "SEE A-101", x: 210, y: 280, w: 120, h: 20 },
  { str: "OUTSIDE", x: 700, y: 900, w: 100, h: 20 },
  // starts left of the box, its box runs into it: copied (the text layer's rule)
  { str: "STRADDLES", x: 120, y: 330, w: 150, h: 20 },
];
const noText = textLayerReader(tcOf(), VP);
type Fakes = { lines?: OcrWord[] | null | Promise<OcrWord[] | null>; box?: (rect: unknown, signal?: AbortSignal) => Promise<BoxRead> };
function ocr(f: Fakes) {
  const boxCalls: { rect: unknown; signal?: AbortSignal }[] = [];
  let pageAsks = 0;
  const readers = ocrCopyReaders({
    pageLines: () => { pageAsks++; return f.lines ?? null; },
    readBox: (rect, signal) => { boxCalls.push({ rect, signal }); return f.box ? f.box(rect, signal) : Promise.resolve({ ok: true, lines: [] }); },
  });
  return { readers, boxCalls, pageAsks: () => pageAsks };
}

test("ocrWordsInRect: an OCR line whose box meets the rect, the text layer's containment rule", () => {
  assert.deepEqual(ocrWordsInRect(OCR_LINES, BOX).map((w) => w.str), ["GENERAL NOTES", "SEE A-101", "STRADDLES"]);
  // a line just below the box: its top (y − h) is past y1
  assert.deepEqual(ocrWordsInRect([{ str: "BELOW", x: 300, y: 425, w: 50, h: 20 }], BOX), []);
  // its top edge touches y1: in
  assert.deepEqual(ocrWordsInRect([{ str: "EDGE", x: 300, y: 420, w: 50, h: 20 }], BOX).map((w) => w.str), ["EDGE"]);
  assert.equal(ocrWordsInRect(OCR_LINES, null).length, OCR_LINES.length, "null = the whole page");
});

test("a page with a read: its lines in the box copy synchronously, labelled OCR, no box read", () => {
  const f = ocr({ lines: OCR_LINES });
  const o = asOutcome(readCopyText([noText, ...f.readers], BOX));
  assert.equal(o.kind, "text");
  if (o.kind !== "text") return;
  assert.equal(o.reader, "OCR");
  assert.equal(OCR_LABEL, "OCR");
  assert.equal(o.text, "GENERAL NOTES\nSEE A-101\nSTRADDLES");
  assert.equal(f.boxCalls.length, 0);
});

test("OCR lines reach textlines with their width: a wide gap between two lines in a row is a TAB", () => {
  const cols: OcrWord[] = [{ str: "CPT-1", x: 210, y: 240, w: 60, h: 20 }, { str: "CARPET", x: 480, y: 240, w: 90, h: 20 }];
  const o = asOutcome(readCopyText([noText, ...ocr({ lines: cols }).readers], BOX));
  assert.equal(o.kind === "text" && o.text, "CPT-1\tCARPET");
});

test("a page with a read but nothing of it in the box never starts a box read", () => {
  const f = ocr({ lines: [OCR_LINES[2]] });
  const o = asOutcome(readCopyText([noText, ...f.readers], BOX));
  assert.deepEqual(o, { kind: "empty", tried: [TEXT_LAYER, "OCR", "OCR"] });
  assert.equal(f.boxCalls.length, 0);
});

test("a page read still being looked up: the chain waits for it, then uses it", async () => {
  const f = ocr({ lines: Promise.resolve(OCR_LINES) });
  const o = await readCopyText([noText, ...f.readers], BOX);
  assert.equal(o.kind === "text" && o.reader, "OCR");
  assert.equal(f.boxCalls.length, 0);
});

test("no page read: the box is read on-device with the copy's signal, labelled OCR", async () => {
  const ac = new AbortController();
  const f = ocr({ lines: null, box: async () => ({ ok: true, lines: [OCR_LINES[0]] }) });
  const o = await readCopyText([noText, ...f.readers], BOX, { signal: ac.signal });
  assert.equal(o.kind === "text" && o.reader, "OCR");
  assert.equal(o.kind === "text" && o.text, "GENERAL NOTES");
  assert.deepEqual(f.boxCalls, [{ rect: BOX, signal: ac.signal }]);
});

test("the text layer answering stops the chain: no page lookup, no box read", () => {
  const f = ocr({ lines: null });
  const o = asOutcome(readCopyText([textLayerReader(tcOf(...NOTE), VP), ...f.readers], BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
  assert.equal(f.pageAsks(), 0);
  assert.equal(f.boxCalls.length, 0);
});

test("a box read that finds nothing: empty, and the message says OCR read none (once)", async () => {
  const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: true, lines: [] }) }).readers], BOX);
  assert.deepEqual(o, { kind: "empty", tried: [TEXT_LAYER, "OCR", "OCR"] });
  const m = outcomeMessage(o, "box", true);
  assert.match(m, /OCR read none/);
  assert.doesNotMatch(m, /OCR, OCR/);
  assert.match(outcomeMessage(o, "box", false), /OCR/, "on a sheet with a text layer too");
});

test("declined: the chain ends empty with the reason, and the message says nothing was downloaded", async () => {
  const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: false, status: "declined" }) }).readers], BOX);
  assert.deepEqual(o, { kind: "empty", tried: [TEXT_LAYER, "OCR", "OCR"], miss: { status: "declined" } });
  assert.match(outcomeMessage(o, "box", true), /wasn't downloaded/);
});

test("disabled or not installed: the sheet has no text layer and OCR isn't available", async () => {
  for (const status of ["disabled", "uninstalled"] as const) {
    const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: false, status }) }).readers], BOX);
    assert.equal(o.kind === "empty" && o.miss?.status, status);
    assert.match(outcomeMessage(o, "box", true), /no text layer.*isn't available/);
    assert.equal(outcomeMessage(o, "box", false), "No text in that box.", "a vector sheet's empty box says only that");
  }
});

test("a box or page too large to read says so", async () => {
  const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: false, status: "too-large", message: "x" }) }).readers], BOX);
  assert.equal(outcomeMessage(o, "box", true), "That box is too large for the on-device text reader (OCR).");
  assert.equal(outcomeMessage(o, "page", true), "This sheet is too large for the on-device text reader (OCR).");
});

test("a failed box read says what went wrong", async () => {
  const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: false, status: "failed", message: "worker died" }) }).readers], BOX);
  assert.match(outcomeMessage(o, "box", true), /Couldn't read that box.*worker died/);
});

test("aborted while the box is read: the copy reports aborted, not the late answer", async () => {
  const ac = new AbortController();
  let release!: (r: BoxRead) => void;
  const f = ocr({ lines: null, box: () => new Promise((res) => { release = res; }) });
  const p = readCopyText([noText, ...f.readers], BOX, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0));
  ac.abort();
  release({ ok: true, lines: [OCR_LINES[0]] });
  assert.deepEqual(await p, { kind: "aborted" });
});

test("a box read stopped from elsewhere (not this copy) says so", async () => {
  const o = await readCopyText([noText, ...ocr({ lines: null, box: async () => ({ ok: false, status: "aborted" }) }).readers], BOX);
  assert.match(outcomeMessage(o, "box", true), /stopped/);
});

test("lines no raster held whole are counted on the outcome and the receipt", () => {
  const cut = [{ ...OCR_LINES[0], clipped: true as const }, OCR_LINES[1]];
  const o = asOutcome(readCopyText([noText, ...ocr({ lines: cut }).readers], BOX));
  assert.equal(o.kind === "text" && o.clipped, 1);
  if (o.kind === "text") assert.equal(makeReceipt(o, { failed: true, scope: "box", key: "k" }).clipped, 1);
  const whole = asOutcome(readCopyText([noText, ...ocr({ lines: [OCR_LINES[1]] }).readers], BOX));
  assert.equal(whole.kind === "text" && "clipped" in whole, false, "no count when nothing was cut");
});

// ── which OCR a copy may use (review) ────────────────────────────────────────

test("copyOcrRoute: a sheet with no placed image at all and a text layer never goes to OCR (blank space, symbols)", () => {
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: 0 }), "none");
  assert.equal(copyOcrRoute({ scope: "page", scanLike: false, imageFrac: 0 }), "none");
});

test("copyOcrRoute: any placed image allows a box read, however small (a pasted scanned schedule at 5%)", () => {
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: 0.05 }), "box");
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: RASTER_MIN_IMG_FRAC / 2 }), "box", "not the raster-fallback threshold");
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: 0.9 }), "box");
  // stats not in yet: allowed
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: undefined }), "box");
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: null }), "box");
});

test("copyOcrRoute: Copy page text on a sheet with no text layer is the page read (kept, indexed), whatever its images", () => {
  for (const imageFrac of [1, 0.05, 0, undefined]) {
    assert.equal(copyOcrRoute({ scope: "page", scanLike: true, imageFrac }), "page");
  }
  assert.equal(copyOcrRoute({ scope: "box", scanLike: true, imageFrac: 1 }), "box");
  assert.equal(copyOcrRoute({ scope: "box", scanLike: true, imageFrac: 0 }), "box", "text drawn as paths: the box may be read");
});

test("copyOcrRoute: punctuation-only text is no text layer (the rule the Read control uses), so Copy page text takes the same page read", () => {
  const tc = tcOf(flat("--", 110, 880), flat("...", 300, 500));
  assert.equal(pageIsScanLike(tc, VP), true);
  assert.equal(copyOcrRoute({ scope: "page", scanLike: pageIsScanLike(tc, VP), imageFrac: 0 }), "page");
});

test("copyOcrRoute 'none' in ocrCopyReaders' place: the chain stops at the text layer", () => {
  const o = asOutcome(readCopyText([textLayerReader(tcOf(flat("--", 110, 880)), VP)], BOX));
  assert.deepEqual(o, { kind: "empty", tried: [TEXT_LAYER] });
  assert.equal(outcomeMessage(o, "box", false), "No text in that box.");
});

test("a synchronous reader's miss reaches the outcome", () => {
  const off: CopyReader = { label: "OCR", read: () => ({ miss: { status: "disabled" } }) };
  assert.deepEqual(asOutcome(readCopyText([off], BOX)), { kind: "empty", tried: ["OCR"], miss: { status: "disabled" } });
});

// ── a scan with a few stray text runs: OCR first (#471) ──────────────────────

// three stray runs (a scanner label, a stamp), two of them inside BOX: a
// text-layer-first chain would copy these instead of the scan
const STRAY = [flat("SCANNED", 110, 880), flat("RECEIVED", 200, 860), flat("COPY", 400, 300)];
const chainFor = (tc: ReturnType<typeof tcOf>, f: ReturnType<typeof ocr>) =>
  copyReaderChain({ scanLike: copyIsScanLike(tc, VP, 1), textLayer: textLayerReader(tc, VP), ocr: f.readers });

test("pageIsScanLike: a page with a few stray lines is a scan; the boundary sits between 8 and 9 lines", () => {
  assert.equal(pageIsScanLike(tcOf(...STRAY), VP), true, "3 runs");
  assert.equal(pageIsScanLike(tcOf(...EIGHT), VP), true, "8 runs");
  assert.equal(pageIsScanLike(tcOf(...NINE), VP), false, "9 runs");
});

test("a box on a stray-text scan with a read: the read's lines, labelled OCR, synchronously, never the stray runs", () => {
  const tc = tcOf(...STRAY);
  assert.equal(asOutcome(readCopyText([textLayerReader(tc, VP)], BOX)).kind, "text", "the stray runs are in the box");
  const f = ocr({ lines: OCR_LINES });
  const o = asOutcome(readCopyText(chainFor(tc, f), BOX));
  assert.equal(o.kind === "text" && o.reader, OCR_LABEL);
  assert.equal(o.kind === "text" && o.text, "GENERAL NOTES\nSEE A-101\nSTRADDLES");
  assert.equal(f.boxCalls.length, 0);
});

test("a box on a stray-text scan with no read: the box is read on-device, not the stray runs", async () => {
  const f = ocr({ lines: null, box: async () => ({ ok: true, lines: [OCR_LINES[0]] }) });
  const o = await readCopyText(chainFor(tcOf(...STRAY), f), BOX);
  assert.equal(o.kind === "text" && o.reader, OCR_LABEL);
  assert.equal(o.kind === "text" && o.text, "GENERAL NOTES");
  assert.equal(f.boxCalls.length, 1);
});

test("Copy page text on a stray-text scan: the page route, and the read's lines, labelled OCR", () => {
  const tc = tcOf(...STRAY);
  assert.equal(copyOcrRoute({ scope: "page", scanLike: pageIsScanLike(tc, VP), imageFrac: 1 }), "page");
  const o = asOutcome(readCopyText(chainFor(tc, ocr({ lines: OCR_LINES })), null));
  assert.equal(o.kind === "text" && o.reader, OCR_LABEL);
  assert.equal(o.kind === "text" && o.lineCount, OCR_LINES.length);
});

test("a stray-text scan where OCR isn't available here (off, not installed): the stray runs still copy, from the text layer", async () => {
  for (const status of ["disabled", "uninstalled"] as const) {
    const o = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: false, status }) })), BOX);
    assert.equal(o.kind === "text" && o.reader, TEXT_LAYER, status);
    assert.equal(o.kind === "text" && o.text, "SCANNED\nRECEIVED", status);
  }
});

test("a stray-text scan whose image couldn't be read (declined, offline, too large): the stray runs copy, and the receipt says the image wasn't read", async () => {
  for (const status of ["declined", "error", "too-large"] as const) {
    const o = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: false, status, message: "x" }) })), BOX);
    assert.equal(o.kind === "text" && o.reader, TEXT_LAYER, status);
    assert.equal(o.kind === "text" && o.text, "SCANNED\nRECEIVED", status);
    if (o.kind === "text") assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k" }).reader, "Text layer · the scanned image wasn't read", status);
  }
});

test("a text-layer copy on a sheet with a text layer, or after OCR was off or found nothing, carries no such note", async () => {
  const plain = asOutcome(readCopyText([textLayerReader(tcOf(...NOTE), VP)], BOX));
  if (plain.kind === "text") assert.equal(makeReceipt(plain, { failed: false, scope: "box", key: "k" }).reader, TEXT_LAYER);
  for (const status of ["disabled", "uninstalled"] as const) {
    const o = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: false, status }) })), BOX);
    if (o.kind === "text") assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k" }).reader, TEXT_LAYER, status);
    else assert.fail(status);
  }
});

test("a stray-text scan whose read was stopped or failed: nothing copied, the reason said", async () => {
  for (const status of ["aborted", "failed", "page-closed"] as const) {
    const o = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: false, status, message: "x" }) })), BOX);
    assert.equal(o.kind, "empty", status);
    assert.equal(o.kind === "empty" && o.miss?.status, status);
  }
});

test("a sheet with 9 or more lines is unchanged: the text layer first, no page lookup, no box read", () => {
  const tc = tcOf(...NOTE, ...NINE);
  const f = ocr({ lines: OCR_LINES });
  const o = asOutcome(readCopyText(chainFor(tc, f), BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
  assert.equal(o.kind === "text" && o.text, "GENERAL NOTES\nSEE A-101");
  assert.equal(f.pageAsks(), 0);
  assert.equal(f.boxCalls.length, 0);
});

test("a stray-text scan where OCR read the box and found nothing there: the stray runs in the box copy, from the text layer", async () => {
  // a page read with nothing in the box
  const cached = asOutcome(readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: [OCR_LINES[2]] })), BOX));
  assert.equal(cached.kind === "text" && cached.reader, TEXT_LAYER);
  assert.equal(cached.kind === "text" && cached.text, "SCANNED\nRECEIVED");
  // no page read, and a box read that found nothing
  const boxed = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: true, lines: [] }) })), BOX);
  assert.equal(boxed.kind === "text" && boxed.reader, TEXT_LAYER);
});

test("copyOcrRoute: OCR off on this build or not installed: none, so a stray-text scan copies its text layer synchronously, inside the click", () => {
  for (const scope of ["box", "page"] as const) {
    assert.equal(copyOcrRoute({ scope, scanLike: true, imageFrac: 1, ocrOff: true }), "none");
    assert.equal(copyOcrRoute({ scope, scanLike: false, imageFrac: 1, ocrOff: true }), "none");
  }
  const tc = tcOf(...STRAY);
  const o = asOutcome(readCopyText(copyReaderChain({ scanLike: pageIsScanLike(tc, VP), textLayer: textLayerReader(tc, VP), ocr: [] }), BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
});

test("copyIsScanLike: a page of a few lines is a scan for Copy text only when it may hold an image (imageFrac not 0)", () => {
  const tc = tcOf(...STRAY);
  assert.equal(copyIsScanLike(tc, VP, 0), false, "a vector cover sheet: no image at all");
  assert.equal(copyIsScanLike(tc, VP, 0.9), true);
  assert.equal(copyIsScanLike(tc, VP, 0.01), true);
  assert.equal(copyIsScanLike(tc, VP, undefined), true, "stats not in yet: possibly raster");
  assert.equal(copyIsScanLike(tc, VP, null), true);
  assert.equal(copyIsScanLike(tcOf(), VP, 0), true, "no text at all: OCR may still read outlined text, as before");
  assert.equal(copyIsScanLike(tcOf(...NINE), VP, 1), false);
});

test("a vector cover sheet (a few title lines, no placed image): a box copies its title from the text layer at once, no OCR", () => {
  const tc = tcOf(...STRAY);
  const scanLike = copyIsScanLike(tc, VP, 0);
  assert.equal(copyOcrRoute({ scope: "box", scanLike, imageFrac: 0 }), "none");
  const f = ocr({ lines: OCR_LINES });
  const o = asOutcome(readCopyText(copyReaderChain({ scanLike, textLayer: textLayerReader(tc, VP), ocr: [] }), BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
  assert.equal(f.pageAsks(), 0);
});

test("copyStartMiss: OCR known off seeds the miss, so an empty copy keeps the reason", () => {
  assert.deepEqual(copyStartMiss({ enabled: false, avail: "available", hasRead: false }), { status: "disabled" });
  assert.deepEqual(copyStartMiss({ enabled: true, avail: "disabled", hasRead: false }), { status: "disabled" });
  assert.deepEqual(copyStartMiss({ enabled: true, avail: "uninstalled", hasRead: false }), { status: "uninstalled" });
  assert.equal(copyStartMiss({ enabled: true, avail: "available", hasRead: false }), undefined);
  assert.equal(copyStartMiss({ enabled: true, avail: null, hasRead: false }), undefined, "not probed yet: OCR may run");
  assert.equal(copyStartMiss({ enabled: true, avail: "error", hasRead: false }), undefined);
  assert.equal(copyStartMiss({ enabled: false, avail: null, hasRead: true }), undefined, "a read in memory still answers");
  const tc = tcOf(...STRAY);
  const empty = { x0: 900, y0: 1500, x1: 1000, y1: 1600 };
  const miss = copyStartMiss({ enabled: false, avail: null, hasRead: false });
  const o = asOutcome(readCopyText(copyReaderChain({ scanLike: true, textLayer: textLayerReader(tc, VP), ocr: [] }), empty, {}, [], miss));
  assert.equal(o.kind === "empty" && o.miss?.status, "disabled");
  assert.match(outcomeMessage(o, "box", true), /isn't available/);
  const hit = asOutcome(readCopyText(copyReaderChain({ scanLike: true, textLayer: textLayerReader(tc, VP), ocr: [] }), BOX, {}, [], miss));
  assert.equal(hit.kind === "text" && hit.reader, TEXT_LAYER, "synchronous, from the text layer");
});

test("copyOcrRoute: a stray-text scan with no placed image (outlined text, a blank scan) may still be read", () => {
  assert.equal(copyOcrRoute({ scope: "box", scanLike: true, imageFrac: 0 }), "box");
  assert.equal(copyOcrRoute({ scope: "box", scanLike: false, imageFrac: 0 }), "none");
});

test("outcomeMessage on a stray-text scan doesn't claim the sheet has no text at all", async () => {
  const o = await readCopyText(chainFor(tcOf(...STRAY), ocr({ lines: null, box: async () => ({ ok: true, lines: [] }) })), { x0: 900, y0: 1500, x1: 1000, y1: 1600 });
  assert.equal(o.kind, "empty");
  assert.match(outcomeMessage(o, "box", true), /little or no text layer/);
});

// ── where Copy text can't read ───────────────────────────────────────────────

test("copyUnavailable: a stitch says to open the sheet on its own; no page says open one; a page is fine", () => {
  assert.equal(copyUnavailable({ stitch: true, hasPage: false }), "Copy text works on single sheets — open the sheet on its own.");
  assert.equal(copyUnavailable({ stitch: false, hasPage: false }), "Open a sheet first.");
  assert.equal(copyUnavailable({ stitch: false, hasPage: true }), null);
});
