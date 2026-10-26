// Copy text on a hybrid sheet (#489): a vector sheet with an unread picture
// on it. copyPlan says which chain a copy takes; on a box over the picture,
// one combining reader answers with the text layer outside the picture and
// OCR inside it. Same pdf.js-shaped viewport as copyText.test.ts (y flipped,
// scale 2), so the text layer is read through the real extractRegionText;
// the last tests use the real synthetic hybrid and its captured read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  copyPlan, copyPictureInputs, textChainPageLines, ocrCopyReaders, hybridCopyReader, readCopyText, outcomeMessage, makeReceipt, copyReaderChain, textLayerReader,
  TEXT_LAYER, OCR_LABEL, TEXT_LAYER_OCR, PICTURE_UNREAD_NOTE,
  type BoxRead, type CopyOutcome, type ReaderMiss, type ReaderMissStatus, type Rect,
} from "../src/lib/copyText";
import type { OcrWord } from "../src/lib/ocr/types";
import { buildSheetIndex, type SheetIndex } from "../src/lib/planIndex";
import { buildHybridPlan, PICTURE } from "./fixtures/hybridPlan.ts";

const H = 1000;   // page height in points; image y = 2·(H − y)
const RS = 2;
const VP = { width: 1200, height: H * 2, transform: [RS, 0, 0, -RS, 0, H * 2] };
const flat = (str: string, x: number, y: number, width = 40) =>
  ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });
const tcOf = (...items: ReturnType<typeof flat>[]) => ({ items });

// the picture: pt at scale 1 (y down) 100..300 × 100..200 ⇔ rs px 200..600 × 200..400
const PIC = { x0: 100, y0: 100, x1: 300, y1: 200 };
const PIC_PX = { x0: 200, y0: 200, x1: 600, y1: 400 };
// a box over the picture's left part and the paper beside and below it
const BOX = { x0: 100, y0: 150, x1: 500, y1: 450 };
const BOX_ON_PIC = { x0: 200, y0: 200, x1: 500, y1: 400 };

// text-layer runs (rs px after the viewport): OVER over the picture (a
// callout: OCR reads it too), SIDE left of it, BELOW under it, EDGE
// straddling the picture's left edge (x 150..230)
const OVER = flat("OVER", 150, 850);    // x 300..380, y 280..300
const SIDE = flat("SIDE", 55, 850);     // x 110..190
const BELOW = flat("BELOW", 150, 780);  // y 420..440
const EDGE = flat("EDGE", 75, 820);     // x 150..230, y 340..360
const TC = tcOf(OVER, SIDE, BELOW);

// OCR lines in rs px (x left, y bottom): the picture's own text, the callout
// as the read sees it, and a word outside the box
const VCT: OcrWord = { str: "VCT-1", x: 220, y: 240, w: 60, h: 20 };
const OVER_OCR: OcrWord = { str: "OVER", x: 302, y: 300, w: 76, h: 20 };
const FAR: OcrWord = { str: "FAR", x: 560, y: 380, w: 30, h: 15 };
const READ = [VCT, OVER_OCR, FAR];

type Deps = { lines?: OcrWord[] | null; cached?: OcrWord[] | null | Promise<OcrWord[] | null>; box?: (rect: Rect, signal?: AbortSignal) => Promise<BoxRead>; startMiss?: ReaderMiss; tc?: ReturnType<typeof tcOf>; rects?: Rect[] };
function hybrid(d: Deps) {
  const boxCalls: Rect[] = [];
  let lookups = 0;
  const reader = hybridCopyReader({
    tc: d.tc ?? TC, viewport: VP, ocrRects: d.rects ?? [BOX_ON_PIC], startMiss: d.startMiss,
    pageLines: () => d.lines ?? null,
    lookup: () => { lookups++; return d.cached instanceof Promise ? d.cached : Promise.resolve(d.cached ?? null); },
    readBox: (rect, signal) => { boxCalls.push(rect); return d.box ? d.box(rect, signal) : Promise.resolve({ ok: true, lines: [] }); },
  });
  return { reader, boxCalls, lookups: () => lookups };
}
const sync = (o: CopyOutcome | Promise<CopyOutcome>): CopyOutcome => {
  assert.ok(!(o instanceof Promise), "answers synchronously, inside the click");
  return o as CopyOutcome;
};
const textOf = (o: CopyOutcome) => (o.kind === "text" ? o.text : `<${o.kind}>`);

// ── copyPlan ─────────────────────────────────────────────────────────────────

const plan = (over: Partial<Parameters<typeof copyPlan>[0]>) =>
  copyPlan({ scope: "box", rect: BOX, scan: false, hybridPictures: [PIC], pictureState: "measured", rs: RS, pageRead: false, ...over });

test("copyPictureInputs: copyPlan's picture inputs from the sheet's index entry", () => {
  const vec = (extra: Partial<SheetIndex>): SheetIndex => ({ ...buildSheetIndex("v.pdf", Array.from({ length: 20 }, (_, i) => ({ str: `ROOM ${100 + i}` }))), textLayer: true, ...extra });
  assert.deepEqual(copyPictureInputs(undefined), { hybridPictures: [], pictureState: "unknown" }, "not indexed");
  assert.deepEqual(copyPictureInputs(vec({})), { hybridPictures: [], pictureState: "unknown" }, "indexed, not measured");
  assert.deepEqual(copyPictureInputs(vec({ pictures: [] })), { hybridPictures: [], pictureState: "measured" });
  assert.deepEqual(copyPictureInputs(vec({ pictures: "failed" })), { hybridPictures: [], pictureState: "measured" }, "an unreadable op list: none");
  assert.deepEqual(copyPictureInputs(vec({ pictures: [PIC] })), { hybridPictures: [PIC], pictureState: "measured" });
  // a scan's pictures are never a hybrid's (its read is the whole page)
  assert.deepEqual(copyPictureInputs({ ...buildSheetIndex("s.pdf", []), textLayer: false, pictures: [PIC] }), { hybridPictures: [], pictureState: "measured" });
  // a hybrid's read carries its pictures
  assert.deepEqual(copyPictureInputs({ ...buildSheetIndex("h.pdf", [{ str: "VCT-1" }], "ocr"), textLayer: true, pictures: [PIC] }), { hybridPictures: [PIC], pictureState: "measured" });
});

test("copyPlan: pictures not measured yet is today's behavior — the scan chain on a scan, else the text chain, whatever pictures are passed", () => {
  assert.deepEqual(plan({ pictureState: "unknown" }), { kind: "text" });
  assert.deepEqual(plan({ pictureState: "unknown", scan: true }), { kind: "scan" });
  assert.deepEqual(plan({ pictureState: "unknown", scope: "page", rect: null, pageRead: true }), { kind: "text" });
});

test("copyPlan: a scan is the scan chain, pictures or not", () => {
  assert.deepEqual(plan({ scan: true }), { kind: "scan" });
  assert.deepEqual(plan({ scan: true, hybridPictures: [] }), { kind: "scan" });
});

test("copyPlan: a box over the picture is a hybrid copy, its OCR rect the box ∩ the picture in rs px", () => {
  assert.deepEqual(plan({}), { kind: "hybrid", ocrRects: [BOX_ON_PIC] });
  // corners in any order
  assert.deepEqual(plan({ rect: { x0: BOX.x1, y0: BOX.y1, x1: BOX.x0, y1: BOX.y0 } }), { kind: "hybrid", ocrRects: [BOX_ON_PIC] });
  // a box inside the picture is its own OCR rect
  const inner = { x0: 250, y0: 250, x1: 350, y1: 350 };
  assert.deepEqual(plan({ rect: inner }), { kind: "hybrid", ocrRects: [inner] });
  // rs 1: the same picture is 100..300 px
  assert.deepEqual(plan({ rs: 1, rect: { x0: 0, y0: 0, x1: 150, y1: 150 } }), { kind: "hybrid", ocrRects: [{ x0: 100, y0: 100, x1: 150, y1: 150 }] });
});

test("copyPlan: a box crossing two pictures gets one OCR rect per picture", () => {
  const other = { x0: 400, y0: 100, x1: 500, y1: 200 };   // px 800..1000
  const wide = { x0: 300, y0: 250, x1: 900, y1: 350 };
  assert.deepEqual(plan({ rect: wide, hybridPictures: [PIC, other] }), {
    kind: "hybrid", ocrRects: [{ x0: 300, y0: 250, x1: 600, y1: 350 }, { x0: 800, y0: 250, x1: 900, y1: 350 }],
  });
});

test("copyPlan: a box off the picture, or no picture on the sheet, is the text chain", () => {
  assert.deepEqual(plan({ rect: { x0: 700, y0: 700, x1: 900, y1: 900 } }), { kind: "text" });
  assert.deepEqual(plan({ hybridPictures: [] }), { kind: "text" }, "measured, none (or the op list was unreadable)");
});

test("copyPlan: a sliver of the picture (a side under 11 pt × rs) is the text chain; exactly 11 pt is kept", () => {
  const side = 11 * RS;
  assert.deepEqual(plan({ rect: { x0: 100, y0: 250, x1: PIC_PX.x0 + side - 0.01, y1: 350 } }), { kind: "text" }, "too narrow");
  assert.deepEqual(plan({ rect: { x0: 300, y0: 100, x1: 400, y1: PIC_PX.y0 + side - 0.01 } }), { kind: "text" }, "too short");
  assert.deepEqual(plan({ rect: { x0: 100, y0: 250, x1: PIC_PX.x0 + side, y1: 350 } }), { kind: "hybrid", ocrRects: [{ x0: 200, y0: 250, x1: 200 + side, y1: 350 }] });
  // one picture a sliver, the other kept: only the kept one is read
  const other = { x0: 400, y0: 100, x1: 500, y1: 200 };
  assert.deepEqual(plan({ rect: { x0: 590, y0: 250, x1: 900, y1: 350 }, hybridPictures: [PIC, other] }), { kind: "hybrid", ocrRects: [{ x0: 800, y0: 250, x1: 900, y1: 350 }] });
});

test("copyPlan: Copy page text on a hybrid combines over the whole page only with a read in memory; without one, the text chain", () => {
  assert.deepEqual(plan({ scope: "page", rect: null, pageRead: true }), { kind: "hybrid", ocrRects: [PIC_PX] });
  assert.deepEqual(plan({ scope: "page", rect: null, pageRead: false }), { kind: "text" });
});

// ── the combining reader ─────────────────────────────────────────────────────

test("combining: the text layer outside the picture, OCR inside it, synchronously from a read in memory, no box read", () => {
  const h = hybrid({ lines: READ });
  const o = sync(readCopyText([h.reader], BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  assert.equal(TEXT_LAYER_OCR, "Text layer + OCR");
  // OVER once (the text layer's; OCR's read of it overlaps it), FAR not (outside the box)
  assert.equal(textOf(o), "VCT-1\nSIDE\tOVER\nBELOW");
  assert.deepEqual(h.boxCalls, []);
  assert.equal(h.lookups(), 0);
});

test("combining: every text-layer run in the box is kept, over the picture too; OCR words are placed by their centre", () => {
  // EDGE runs 30 px into the picture: the text layer's
  const h = hybrid({ lines: [VCT], tc: tcOf(EDGE) });
  const o = sync(readCopyText([h.reader], BOX));
  assert.equal(textOf(o), "VCT-1\nEDGE");
  // an OCR word whose centre is outside the picture (here, past its right edge) isn't taken, even inside the box
  const out: OcrWord = { str: "PAST", x: 610, y: 300, w: 40, h: 20 };
  const wide = { x0: 100, y0: 150, x1: 700, y1: 450 };
  const h2 = hybrid({ lines: [VCT, out], tc: tcOf(), rects: [{ x0: 200, y0: 200, x1: 600, y1: 400 }] });
  assert.equal(textOf(sync(readCopyText([h2.reader], wide))), "VCT-1");
});

test("combining: a callout wholly inside the picture copies exactly, from the text layer; OCR's garbled read of it is dropped", () => {
  // the read runs the callout into the picture's text under it: one wider, garbled word
  const garbled: OcrWord = { str: "OVFRTILE", x: 290, y: 302, w: 150, h: 22 };
  const h = hybrid({ lines: [VCT, garbled], tc: tcOf(OVER) });
  const o = sync(readCopyText([h.reader], BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  assert.equal(textOf(o), "VCT-1\nOVER");
});

test("combining: an OCR word overlapping a kept text-layer run is dropped (the read of a run's tail)", () => {
  const tail: OcrWord = { str: "GE", x: 202, y: 360, w: 26, h: 20 };   // EDGE's last letters, inside the picture
  const o = sync(readCopyText([hybrid({ lines: [VCT, tail], tc: tcOf(EDGE) }).reader], BOX));
  assert.equal(textOf(o), "VCT-1\nEDGE");
  // touching is not overlapping
  const beside: OcrWord = { str: "TOUCH", x: 230, y: 360, w: 60, h: 20 };
  assert.equal(textOf(sync(readCopyText([hybrid({ lines: [beside], tc: tcOf(EDGE) }).reader], BOX))), "EDGE TOUCH");
});

test("combining: OCR words keep their own fields (clipped is counted)", () => {
  const cut = { ...VCT, clipped: true as const };
  const o = sync(readCopyText([hybrid({ lines: [cut] }).reader], BOX));
  assert.equal(o.kind === "text" && o.clipped, 1);
});

test("combining: only OCR text in the box is labelled OCR; only the text layer, Text layer", () => {
  const ocrOnly = sync(readCopyText([hybrid({ lines: [VCT], tc: tcOf() }).reader], BOX));
  assert.equal(ocrOnly.kind === "text" && ocrOnly.reader, OCR_LABEL);
  // the read found nothing in the picture: every text-layer run in the box, OVER included
  const textOnly = sync(readCopyText([hybrid({ lines: [FAR] }).reader], BOX));
  assert.equal(textOnly.kind === "text" && textOnly.reader, TEXT_LAYER);
  assert.equal(textOf(textOnly), "SIDE\tOVER\nBELOW");
  assert.equal(textOnly.kind === "text" && "imageUnread" in textOnly, false);
});

test("combining: every OCR word dropped as overlap counts as finding nothing — the text layer copies whole", () => {
  const tail: OcrWord = { str: "GE", x: 202, y: 360, w: 26, h: 20 };
  const o = sync(readCopyText([hybrid({ lines: [tail], tc: tcOf(EDGE, OVER) }).reader], BOX));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
  assert.equal(textOf(o), "OVER\nEDGE");
});

test("combining: no read in memory — the cached read, then a read of box ∩ picture only (never the whole box)", async () => {
  const cached = hybrid({ cached: READ });
  const c = await readCopyText([cached.reader], BOX);
  assert.equal(textOf(c), "VCT-1\nSIDE\tOVER\nBELOW");
  assert.equal(cached.lookups(), 1);
  assert.deepEqual(cached.boxCalls, []);

  const ac = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const read = hybrid({ cached: null, box: async (_r, s) => { seen.push(s); return { ok: true, lines: [VCT, OVER_OCR] }; } });
  const o = await readCopyText([read.reader], BOX, { signal: ac.signal });
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  assert.equal(textOf(o), "VCT-1\nSIDE\tOVER\nBELOW");
  assert.deepEqual(read.boxCalls, [BOX_ON_PIC]);
  assert.deepEqual(seen, [ac.signal]);
});

test("combining: a lookup that fails is no cached read", async () => {
  const h = hybrid({ cached: Promise.reject(new Error("idb")), box: async () => ({ ok: true, lines: [VCT, OVER_OCR] }) });
  const o = await readCopyText([h.reader], BOX);
  assert.equal(textOf(o), "VCT-1\nSIDE\tOVER\nBELOW");
  assert.equal(h.boxCalls.length, 1);
});

test("combining: a box over two pictures reads each in turn, and stops when the copy is replaced", async () => {
  const r2 = { x0: 800, y0: 250, x1: 900, y1: 350 };
  const r1 = { x0: 300, y0: 250, x1: 600, y1: 350 };
  const both = hybrid({ rects: [r1, r2], tc: tcOf(), box: async (r) => ({ ok: true, lines: [{ str: r === r1 ? "ONE" : "TWO", x: r.x0 + 5, y: 300, w: 40, h: 20 }] }) });
  const o = await readCopyText([both.reader], { x0: 300, y0: 250, x1: 900, y1: 350 });
  assert.equal(textOf(o), "ONE\tTWO");
  assert.deepEqual(both.boxCalls, [r1, r2]);

  const ac = new AbortController();
  const stop = hybrid({ rects: [r1, r2], tc: tcOf(), box: async () => { ac.abort(); return { ok: true, lines: [] }; } });
  assert.deepEqual(await readCopyText([stop.reader], { x0: 300, y0: 250, x1: 900, y1: 350 }, { signal: ac.signal }), { kind: "aborted" });
  assert.equal(stop.boxCalls.length, 1, "the second picture isn't read");
});

test("combining: a box over two pictures whose second read is declined, offline or too large keeps the first picture's words, and the receipt says a picture wasn't read", async () => {
  const r1 = { x0: 300, y0: 250, x1: 600, y1: 350 };
  const r2 = { x0: 800, y0: 250, x1: 900, y1: 350 };
  const paper = flat("PAPER", 350, 850);   // x 700..780, between the pictures
  const box = { x0: 300, y0: 250, x1: 900, y1: 350 };
  const second = (status: ReaderMissStatus) => hybrid({
    rects: [r1, r2], tc: tcOf(paper), cached: null,
    box: async (r): Promise<BoxRead> => (r === r1 ? { ok: true, lines: [{ str: "ONE", x: 305, y: 300, w: 40, h: 20 }] } : { ok: false, status, message: "x" }),
  });
  for (const status of ["declined", "error", "too-large"] as const) {
    const h = second(status);
    const o = await readCopyText([h.reader], box);
    assert.equal(textOf(o), "ONE\tPAPER", status);
    assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR, status);
    assert.equal(o.kind === "text" && o.imageUnread, true, status);
    if (o.kind === "text") assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k", hybrid: true }).reader, "Text layer + OCR · the picture wasn't read", status);
    assert.deepEqual(h.boxCalls, [r1, r2], status);
  }
  // a second read that was stopped, failed or lost its page still ends the copy
  for (const status of ["failed", "aborted", "page-closed"] as const) {
    const o = await readCopyText([second(status).reader], box);
    assert.equal(o.kind === "empty" && o.miss?.status, status, status);
  }
});

test("combining: a rotated text-layer run (one textlines skips) hides no OCR word under its bounding box but off its glyphs", () => {
  // 45° up-right from px (210, 390) to (380, 220), glyphs 20 px tall on its
  // upper-left side: its axis-aligned box covers VCT-1 (x 220..280, y 220..240),
  // its glyphs don't
  const deg = 45, c = 10 * Math.cos((deg * Math.PI) / 180), s = 10 * Math.sin((deg * Math.PI) / 180);
  const matchLine = { str: "MATCH LINE", transform: [c, s, -s, c, 105, 805], width: 120, height: 10 };
  const o = sync(readCopyText([hybrid({ lines: [VCT], tc: { items: [matchLine] } }).reader], BOX));
  assert.equal(textOf(o), "VCT-1");
  // both readers found text in the box; the text layer's is the skipped run
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  assert.equal(o.kind === "text" && o.skipped, 1, "the rotated run is in the box, skipped as rotated");
});

// ── when OCR doesn't read the picture: the scan chain's rule ────────────────

const missRead = (status: ReaderMissStatus, tc = TC) => hybrid({ tc, cached: null, box: async () => ({ ok: false, status, message: "x" }) });

test("OCR found nothing, off or not installed: every text-layer run in the box, no note", async () => {
  const none = await readCopyText([hybrid({ cached: null }).reader], BOX);
  assert.equal(textOf(none), "SIDE\tOVER\nBELOW");
  assert.equal(none.kind === "text" && none.reader, TEXT_LAYER);
  for (const status of ["disabled", "uninstalled"] as const) {
    const o = await readCopyText([missRead(status).reader], BOX);
    assert.equal(textOf(o), "SIDE\tOVER\nBELOW", status);
    assert.equal(o.kind === "text" && "imageUnread" in o, false, status);
    if (o.kind === "text") assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k", hybrid: true }).reader, TEXT_LAYER, status);
  }
});

test("declined, offline or too large: every text-layer run in the box, and the receipt says the picture wasn't read", async () => {
  assert.equal(PICTURE_UNREAD_NOTE, "the picture wasn't read");
  for (const status of ["declined", "error", "too-large"] as const) {
    const o = await readCopyText([missRead(status).reader], BOX);
    assert.equal(textOf(o), "SIDE\tOVER\nBELOW", status);
    assert.equal(o.kind === "text" && o.reader, TEXT_LAYER, status);
    assert.equal(o.kind === "text" && o.imageUnread, true, status);
    if (o.kind === "text") assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k", hybrid: true }).reader, "Text layer · the picture wasn't read", status);
    // and with nothing on the text layer either: empty, with the reason
    const e = await readCopyText([missRead(status, tcOf()).reader], BOX);
    assert.equal(e.kind === "empty" && e.miss?.status, status, status);
  }
});

test("a read that was stopped, failed or lost its page: nothing copied, the reason said", async () => {
  for (const status of ["failed", "aborted", "page-closed"] as const) {
    const o = await readCopyText([missRead(status).reader], BOX);
    assert.equal(o.kind, "empty", status);
    assert.equal(o.kind === "empty" && o.miss?.status, status, status);
  }
});

test("OCR known off (startMiss): the text layer answers synchronously, no lookup, no box read", () => {
  for (const status of ["disabled", "uninstalled"] as const) {
    const h = hybrid({ startMiss: { status }, cached: READ });
    const o = sync(readCopyText([h.reader], BOX, {}, [], { status }));
    assert.equal(textOf(o), "SIDE\tOVER\nBELOW", status);
    assert.equal(h.lookups(), 0);
    assert.deepEqual(h.boxCalls, []);
    // an empty box keeps the reason, reported by the reader itself
    const e = sync(readCopyText([hybrid({ startMiss: { status }, tc: tcOf() }).reader], BOX));
    assert.equal(e.kind === "empty" && e.miss?.status, status);
  }
});

// ── Copy page text ───────────────────────────────────────────────────────────

test("Copy page text on a hybrid with a read in memory: the same combine over the page, synchronously, no new read", () => {
  const h = hybrid({ lines: READ, rects: [PIC_PX], tc: tcOf(OVER, SIDE, BELOW, flat("TITLE", 500, 100)) });
  const o = sync(readCopyText([h.reader], null));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  assert.equal(textOf(o), "VCT-1\nSIDE\tOVER\nFAR\nBELOW\nTITLE");
  assert.deepEqual(h.boxCalls, []);
  assert.equal(h.lookups(), 0);
});

test("Copy page text through the combining reader without a read in memory: the text layer, synchronously, no lookup", () => {
  const h = hybrid({ cached: READ, rects: [PIC_PX] });
  const o = sync(readCopyText([h.reader], null));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER);
  assert.equal(h.lookups(), 0);
  assert.deepEqual(h.boxCalls, []);
});

// ── messages and the receipt ────────────────────────────────────────────────

const SCAN_WORDS = /little or no text layer|scanned image/;

test("a hybrid's messages never call the sheet a scan, whatever scanLike says", async () => {
  const outs: CopyOutcome[] = [
    await readCopyText([hybrid({ tc: tcOf(), cached: null }).reader], BOX),
    ...await Promise.all((["declined", "too-large", "failed", "aborted", "page-closed", "error", "disabled", "uninstalled"] as const)
      .map((s) => readCopyText([missRead(s, tcOf()).reader], BOX))),
    { kind: "empty", tried: [TEXT_LAYER] },
  ];
  for (const o of outs) {
    for (const scope of ["box", "page"] as const) {
      for (const scanLike of [false, true]) assert.doesNotMatch(outcomeMessage(o, scope, scanLike, true), SCAN_WORDS, JSON.stringify(o));
    }
  }
  // an empty hybrid box the read found nothing in names OCR once, not the combined label
  const m = outcomeMessage(outs[0], "box", false, true);
  assert.equal(m, "No text found in that box: no text-layer text there, and OCR read none.");
});

test("an empty hybrid box with OCR off says the picture can't be read here, and why", () => {
  const off = (status: "disabled" | "uninstalled") => sync(readCopyText([hybrid({ startMiss: { status }, tc: tcOf() }).reader], BOX));
  assert.equal(outcomeMessage(off("disabled"), "box", false, true), "No text layer in that box, and the picture can't be read here: on-device reading is turned off on this site.");
  assert.equal(outcomeMessage(off("uninstalled"), "box", false, true), "No text layer in that box, and the picture can't be read here: this site doesn't have the on-device reader installed.");
  // a scan's and a plain vector sheet's wording is unchanged
  assert.match(outcomeMessage(off("disabled"), "box", true), /little or no text layer/);
  assert.equal(outcomeMessage(off("disabled"), "box", false), "No text in that box.");
});

test("the receipt names a combined copy, and keeps the scan's note off a hybrid", () => {
  const o = sync(readCopyText([hybrid({ lines: READ }).reader], BOX));
  if (o.kind !== "text") return assert.fail(o.kind);
  assert.equal(makeReceipt(o, { failed: false, scope: "box", key: "k", hybrid: true }).reader, "Text layer + OCR");
  const unread = { ...o, reader: TEXT_LAYER, imageUnread: true as const };
  assert.equal(makeReceipt(unread, { failed: false, scope: "box", key: "k", hybrid: true }).reader, "Text layer · the picture wasn't read");
  assert.equal(makeReceipt(unread, { failed: false, scope: "box", key: "k" }).reader, "Text layer · the scanned image wasn't read", "a scan's note unchanged");
});

// ── the real synthetic hybrid and its captured read ─────────────────────────

const REPLAY = JSON.parse(readFileSync(new URL("./fixtures/hybrid/hybrid-read.json", import.meta.url), "utf8"));
let real: Promise<{ tc: { items: unknown[] }; vp: { width: number; height: number; transform: number[] } }> | null = null;
function hybridPage() {
  real ??= (async () => {
    const bytes = await buildHybridPlan("callouts");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    return { tc: (await page.getTextContent()) as never, vp: page.getViewport({ scale: REPLAY.rs }) as never };
  })();
  return real;
}

test("hybrid sheet: a box over the picture clipping FIELD VERIFY copies the picture's rows, the callouts exactly, MATCH EXISTING once", async () => {
  const { tc, vp } = await hybridPage();
  const rs = REPLAY.rs;
  const box = { x0: 1270, y0: 2630, x1: 3320, y1: 3150 };
  const p = copyPlan({ scope: "box", rect: box, scan: false, hybridPictures: [PICTURE], pictureState: "measured", rs, pageRead: true });
  assert.deepEqual(p, { kind: "hybrid", ocrRects: [REPLAY.rect] });
  if (p.kind !== "hybrid") return;
  const boxCalls: Rect[] = [];
  const reader = hybridCopyReader({
    tc: tc as never, viewport: vp as never, ocrRects: p.ocrRects,
    pageLines: () => REPLAY.lines, lookup: async () => null,
    readBox: async (r) => { boxCalls.push(r); return { ok: true, lines: [] }; },
  });
  const o = sync(readCopyText([reader], box));
  assert.equal(o.kind === "text" && o.reader, TEXT_LAYER_OCR);
  const text = textOf(o);
  for (const w of ["CPT-1\tBROADLOOM CARPET", "CPT-2\tMODULAR CARPET TILE", "VCT-1", "RB-1\tRESILIENT BASE", "CBT-1\tCARPET WALL BASE", "FIELD VERIFY", "SEE NOTE 4"]) {
    assert.ok(text.includes(w), `${w} in ${text}`);
  }
  // the read ran SEE NOTE 4 into the cell under it; the text layer's run is exact
  assert.ok(REPLAY.lines.some((l: { str: string }) => /OFEFIQN/.test(l.str)), "the replay holds the garbled overlap");
  assert.doesNotMatch(text, /OFEFIQN/);
  // the trade-off: that garbled word held the row's description too, and it
  // is dropped whole (it overlaps the callout), so the VCT-1 row copies
  // without it, the callout in its place
  const rows = text.split("\n");
  const vct = rows.findIndex((l) => l.startsWith("VCT-1"));
  assert.equal(rows[vct], "VCT-1\tSEE NOTE 4");
  assert.equal(text.split("MATCH EXISTING").length - 1, 1, "MATCH EXISTING once (the text layer's, not also the read's)");
  assert.deepEqual(boxCalls, []);
});

test("hybrid sheet: a box beside the picture (FIELD VERIFY alone) is the text chain, from the text layer", async () => {
  const { tc, vp } = await hybridPage();
  const box = { x0: 3250, y0: 2850, x1: 3500, y1: 2950 };
  assert.deepEqual(copyPlan({ scope: "box", rect: box, scan: false, hybridPictures: [PICTURE], pictureState: "measured", rs: REPLAY.rs, pageRead: true }), { kind: "text" });
  const o = sync(readCopyText(copyReaderChain({ scanLike: false, textLayer: textLayerReader(tc as never, vp as never), ocr: [] }), box));
  assert.equal(o.kind === "text" && o.text, "FIELD VERIFY");
});

// ── the text chain on a hybrid (copyPlan "text") ─────────────────────────────
// A box copyPlan sends to the text chain on a hybrid (off the pictures, or a
// sliver of one) must not take the sheet's pictures read as its page read:
// that read covers only the pictures, so it neither says the box is empty
// nor copies a clipped picture's words as OCR. The box is read on its own.

const HYB_IX: SheetIndex = { ...buildSheetIndex("h.pdf", Array.from({ length: 20 }, (_, i) => ({ str: `ROOM ${100 + i}` }))), textLayer: true, pictures: [PIC] };
// a word of the picture just inside its left edge (centre x 207)
const CLIP: OcrWord = { str: "CLIP", x: 202, y: 300, w: 10, h: 20 };
const PICTURES_READ = [VCT, OVER_OCR, FAR, CLIP];
function textChain(ix: SheetIndex | undefined, rect: Rect, boxLines: OcrWord[]) {
  const boxCalls: (Rect | null)[] = [];
  const p = copyPlan({ scope: "box", rect, scan: false, ...copyPictureInputs(ix), rs: RS, pageRead: true });
  assert.equal(p.kind, "text");
  const ocr = ocrCopyReaders({
    pageLines: textChainPageLines(ix, () => PICTURES_READ),
    readBox: (r) => { boxCalls.push(r); return Promise.resolve({ ok: true, lines: boxLines }); },
  });
  const out = readCopyText(copyReaderChain({ scanLike: false, textLayer: textLayerReader(tcOf() as never, VP as never), ocr }), rect);
  return { out, boxCalls };
}

test("hybrid, box off the picture, empty text layer: the box is read, not called empty by the pictures read", async () => {
  const off = { x0: 700, y0: 200, x1: 900, y1: 400 };
  const NOTE: OcrWord = { str: "NOTE", x: 720, y: 300, w: 60, h: 20 };
  const { out, boxCalls } = textChain(HYB_IX, off, [NOTE]);
  const o = await out;
  assert.deepEqual(boxCalls, [off]);
  assert.equal(textOf(o), "NOTE");
  assert.equal(o.kind === "text" && o.reader, OCR_LABEL);
});

test("hybrid, a sliver of the picture, empty text layer: the box is read; the clipped picture's words never copy from the pictures read", async () => {
  const sliver = { x0: 100, y0: 200, x1: 215, y1: 400 };   // 15 px of PIC_PX, under 11 pt × rs
  const { out, boxCalls } = textChain(HYB_IX, sliver, []);
  const o = await out;
  assert.deepEqual(boxCalls, [sliver]);
  assert.ok(!textOf(o).includes("CLIP"), textOf(o));
  assert.equal(o.kind, "empty");
});

test("textChainPageLines: a sheet that isn't a hybrid keeps its page read for the text chain (a scan's read covers the page)", () => {
  const lines = () => PICTURES_READ;
  assert.equal(textChainPageLines(undefined, lines)(), PICTURES_READ, "no entry: whatever the reader has");
  assert.equal(textChainPageLines({ ...HYB_IX, pictures: [] }, lines)(), PICTURES_READ);
  assert.equal(textChainPageLines({ ...HYB_IX, pictures: undefined }, lines)(), PICTURES_READ, "not measured yet");
  assert.equal(textChainPageLines({ ...buildSheetIndex("s.pdf", []), textLayer: false }, lines)(), PICTURES_READ, "a scan");
  assert.equal(textChainPageLines(HYB_IX, lines)(), null, "a hybrid: no page read for the text chain");
  // a hybrid's own read (OCR entry carrying its pictures) is still a pictures read
  assert.equal(textChainPageLines({ ...buildSheetIndex("h.pdf", [{ str: "VCT-1" }], "ocr"), textLayer: true, pictures: [PIC] }, lines)(), null);
});
