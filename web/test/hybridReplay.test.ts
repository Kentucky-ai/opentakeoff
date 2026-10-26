// The hybrid sheet's read, replayed through search (#489). The text entry is
// measured from the real synthetic hybrid (test/fixtures/hybridPlan.ts) at
// RENDER_SCALE, as the canvas and the walk index it; the OCR entry is what the
// on-device reader returned for its picture (fixtures/hybrid/hybrid-read.json,
// captured in the browser). The two land in every order the app puts them in,
// and search must then find the picture's codes as OCR, the text layer's own
// codes as text, and a text-layer-only word still at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { measurePage, type MeasurablePage } from "../src/lib/pictures.ts";
import type { OpList } from "../src/lib/oneclick.ts";
import type { SheetIndex } from "../src/lib/planIndex.ts";
import { galleryReadView, needsRead, needsTextPass, ocrSheetIndex, putSheetIndex, runPlanSearch, seedFromThumb, thumbIndexStep } from "../src/lib/planSearch.ts";
import { pageTextIndex } from "../src/lib/pageTextIndex.ts";
import { RENDER_SCALE } from "../src/lib/takeoffConstants.ts";
import { buildHybridPlan, PICTURE } from "./fixtures/hybridPlan.ts";

const OPS = pdfjs.OPS as unknown as Record<string, number>;
const READ = JSON.parse(readFileSync(new URL("./fixtures/hybrid/hybrid-read.json", import.meta.url), "utf8"));
const KEY = "hybrid.pdf";

/** The picture's codes: on page 2's schedule, nowhere on page 1's text layer. */
const PICTURE_ONLY = ["VCT-1", "CPT-2", "RB-1", "CBT-1", "BROADLOOM", "MODULAR"];

let built: Promise<{ bytes: Uint8Array; text: SheetIndex; label: SheetIndex }> | null = null;
/** The hybrid's text entry as measured (the walk, the thumbnails) and as the
 *  canvas's label loop gives it (no pictures). */
function hybrid() {
  built ??= (async () => {
    const bytes = await buildHybridPlan("callouts");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: RENDER_SCALE });
    const p: MeasurablePage = { getTextContent: () => page.getTextContent() as never, getOperatorList: () => page.getOperatorList() as unknown as Promise<OpList> };
    const { index } = await measurePage(KEY, p, vp, OPS);
    const label = pageTextIndex(KEY, (await page.getTextContent()) as never, vp);
    return { bytes, text: index, label };
  })();
  return built;
}

const ocr = () => ocrSheetIndex(KEY, READ.lines);

function assertFound(map: Map<string, SheetIndex>, how: string) {
  for (const q of PICTURE_ONLY) {
    const r = runPlanSearch(q, map, [KEY]);
    assert.deepEqual(r.hits.map((h) => [h.key, h.source]), [[KEY, "ocr"]], `${q} (${how})`);
    assert.ok(r.ocrKeys.has(KEY), `${q} badged OCR (${how})`);
  }
  for (const q of ["CPT-1", "STAIRWELL"]) {
    const r = runPlanSearch(q, map, [KEY]);
    assert.deepEqual(r.hits.map((h) => [h.key, h.source]), [[KEY, "text"]], `${q} (${how})`);
    assert.equal(r.ocrKeys.has(KEY), false, `${q} badged text (${how})`);
  }
  assert.equal(runPlanSearch("x", map, [KEY]).unreadCount, 0, `read (${how})`);
}

test("replay: the fixture is the read of this sheet's picture, at the page read's scale", async () => {
  const { bytes, text } = await hybrid();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), READ.pdfSha256);
  assert.equal(READ.rs, RENDER_SCALE);
  assert.deepEqual(READ.rect, { x0: PICTURE.x0 * READ.rs, y0: PICTURE.y0 * READ.rs, x1: PICTURE.x1 * READ.rs, y1: PICTURE.y1 * READ.rs });
  // the search targets: the picture's codes aren't on the text layer; CPT-1
  // and STAIRWELL are, and STAIRWELL isn't in the read
  for (const q of PICTURE_ONLY) assert.equal(runPlanSearch(q, new Map([[KEY, text]]), [KEY]).hits.length, 0, q);
  assert.ok(text.terms["CPT-1"] && text.terms.STAIRWELL);
  assert.equal(ocr().terms.STAIRWELL, undefined);
  assert.ok(ocr().terms["CPT-1"], "the read has CPT-1 too (the schedule row)");
});

test("replay: text pass first, then the read — codes as OCR, text-layer words as text", async () => {
  const { text } = await hybrid();
  const map = new Map<string, SheetIndex>();
  assert.equal(putSheetIndex(map, KEY, text), true);
  assert.equal(needsRead(map.get(KEY)), true, "a hybrid is offered a read");
  assert.equal(runPlanSearch("x", map, [KEY]).unreadCount, 1);
  assert.equal(putSheetIndex(map, KEY, ocr()), true);
  assertFound(map, "text → read");
});

test("replay: after a reload — the thumbnail's seed, the cached read, then the text pass", async () => {
  const { text, label } = await hybrid();
  for (const [pass, how] of [[text, "measured pass"], [label, "label-loop pass"]] as const) {
    const map = new Map<string, SheetIndex>();
    const seed = seedFromThumb({ textLayer: true, pictures: text.pictures }, KEY, (k) => map.has(k));
    assert.ok(seed, "a hybrid's thumbnail record seeds its entry");
    assert.equal(putSheetIndex(map, KEY, seed), true);
    assert.equal(needsRead(map.get(KEY)), true, "the seed is offered a read");
    assert.equal(putSheetIndex(map, KEY, ocr()), true);
    assert.equal(putSheetIndex(map, KEY, pass), true, how);
    assertFound(map, `seed → read → ${how}`);
  }
});

/** A text pass as the app runs one: only when needsTextPass asks for it. */
function pass(map: Map<string, SheetIndex>, ix: SheetIndex): boolean {
  if (!needsTextPass(map.get(KEY))) return false;
  putSheetIndex(map, KEY, ix);
  return true;
}

function assertMeasured(map: Map<string, SheetIndex>, pictures: unknown, how: string) {
  const ix = map.get(KEY)!;
  assert.deepEqual(ix.pictures, pictures, `pictures (${how})`);
  assert.equal(ix.textLayer, true, `textLayer (${how})`);
  assert.equal(needsTextPass(ix), false, `no pass asked for (${how})`);
  assert.equal(galleryReadView(ix, "available", undefined).what, "picture", `reads the picture (${how})`);
}

test("replay: a read with nothing under it (Copy's lookup), then the label loop's pass, then a measured pass", async () => {
  const { text, label } = await hybrid();
  const map = new Map<string, SheetIndex>();
  assert.equal(putSheetIndex(map, KEY, ocr()), true);
  assert.equal(pass(map, label), true, "the read has had no text pass");
  assert.equal(map.get(KEY)!.pictures, undefined, "the label loop doesn't measure");
  assert.equal(pass(map, text), true, "not measured yet: the walk's (or the thumbnails') pass still runs");
  assertFound(map, "read → label pass → measured pass");
  assertMeasured(map, text.pictures, "read → label pass → measured pass");
});

test("replay: the label loop first, then a kept record's pictures (adopt), before or after the read", async () => {
  const { text, label } = await hybrid();
  const rec = { textLayer: true, pictures: text.pictures };
  const adopt = (map: Map<string, SheetIndex>) => {
    const step = thumbIndexStep(rec, KEY, (k) => map.get(k), () => true);
    assert.equal(step.kind, "adopt");
    const { kind: _k, ...fields } = step as { kind: string };
    assert.equal(putSheetIndex(map, KEY, { ...map.get(KEY)!, ...fields }), true);
  };
  const m1 = new Map<string, SheetIndex>();
  assert.equal(pass(m1, label), true);
  adopt(m1);
  assert.equal(needsRead(m1.get(KEY)), true, "a hybrid now: offered a read");
  assert.equal(pass(m1, text), false, "measured: no pass asked for");
  assert.equal(putSheetIndex(m1, KEY, ocr()), true);
  assertFound(m1, "label pass → adopt → read");
  assertMeasured(m1, text.pictures, "label pass → adopt → read");

  const m2 = new Map<string, SheetIndex>();
  assert.equal(pass(m2, label), true);
  assert.equal(putSheetIndex(m2, KEY, ocr()), true);
  adopt(m2);
  assert.equal(pass(m2, text), false, "measured: no pass asked for");
  assertFound(m2, "label pass → read → adopt");
  assertMeasured(m2, text.pictures, "label pass → read → adopt");
});
