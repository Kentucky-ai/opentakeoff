// Replays two captured on-device reads of the demo material schedule (#470)
// through the reader the canvas runs on them, scored against the vector read
// of the same box — the answer key is computed here, from the demo PDF, by
// the canvas's own vector path (TakeoffCanvas importScheduleFromRect:
// pageSpans → spansInRect → graphSpans → readScheduleSpans).
//
// The fixtures (test/fixtures/schedule-ocr/, each file's `about` says how
// they were captured and redacted) are the OCR engine's words for Import
// from schedule's box on raster copies of page 2 at 200 and 100 DPI. The
// box is rendered at ocrRenderFactor's zoom; a fixture captured at another
// zoom no longer says what the canvas would read, so it fails as stale.
//
// Scores, both copies: no tag the vector read lacks; at least 28 of its
// tags; the row's printed section equal to the vector read's for at least 12
// rows at 200 DPI (the engine never returned the FLOORING, BASE or WALLS
// headings there) and 28 at 100 DPI, and its dialog group (category) for at
// least 14 and 28 (at 200 DPI two BASE rows still land in Base by their
// words); no printed section that differs from the vector read's (a missing
// one is No section); and the blank-band section reset ({ ocr: true }) no
// worse than the read without it on any of these. Then the 100 DPI copy with
// section headings taken out pins the reset itself: a row never carries the
// heading of the code group above it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pageSpans, spansInRect, graphSpans } from "../src/lib/pageSpans.ts";
import { readScheduleSpans, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import { ocrRenderFactor } from "../src/lib/ocr/rasterize.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

type Rect = { x0: number; y0: number; x1: number; y1: number };
interface Fixture {
  source: { page: number; pageSize: { w: number; h: number; rotate: number } };
  rs: number; rect: Rect; zoom: number;
  words: Array<{ str: string; x: number; y: number; w: number; h: number }>;
}
const fixture = (dpi: number): Fixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/schedule-ocr/demo-material-${dpi}dpi.json`, import.meta.url)), "utf8"));

const req = createRequire(import.meta.url);
const DEMO = fileURLToPath(new URL("../public/demo/sample-finish-plan.pdf", import.meta.url));
/** The vector read of `rect` on the demo PDF, as the canvas reads a box. */
async function vectorKey(fx: Fixture): Promise<ScheduleRow[]> {
  const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(DEMO)), useSystemFonts: true }).promise;
  try {
    const page = await doc.getPage(fx.source.page);
    const vp1 = page.getViewport({ scale: 1 });
    assert.deepEqual([vp1.width, vp1.height, page.rotate], [fx.source.pageSize.w, fx.source.pageSize.h, fx.source.pageSize.rotate], "the demo page the fixture was captured on");
    assert.deepEqual([vp1.width, vp1.height, page.rotate], [3024, 2160, 0]);
    const vp = page.getViewport({ scale: fx.rs });
    const tc = await page.getTextContent();
    const r = readScheduleSpans(graphSpans(spansInRect(pageSpans(tc.items, vp.transform, fx.rs), fx.rect)));
    assert.ok(!("refused" in r), "the vector read of the box reads the table");
    return r.rows;
  } finally {
    await doc.destroy();
  }
}

interface Score { wrong: string[]; exact: number; section: number; group: number; wrongSection: string[] }
function score(read: ScheduleRead, key: ScheduleRow[]): Score {
  assert.ok(!("refused" in read), `the OCR read reads the table (${"refused" in read ? read.refused : ""})`);
  const byTag = new Map(key.map((r) => [r.finish_tag, r]));
  const tags = new Set(read.rows.map((r) => r.finish_tag));
  const known = read.rows.filter((r) => byTag.has(r.finish_tag));
  return {
    wrong: [...tags].filter((t) => !byTag.has(t)),
    exact: [...tags].filter((t) => byTag.has(t)).length,
    section: known.filter((r) => byTag.get(r.finish_tag)!.section === r.section).length,
    group: known.filter((r) => byTag.get(r.finish_tag)!.category === r.category).length,
    wrongSection: known.filter((r) => r.section && r.section !== byTag.get(r.finish_tag)!.section).map((r) => `${r.finish_tag}: ${r.section}`),
  };
}

for (const [dpi, sectionFloor, groupFloor] of [[200, 12, 14], [100, 28, 28]] as const) {
  test(`the ${dpi} DPI on-device read of the demo material schedule scores against the vector read`, async () => {
    const fx = fixture(dpi);
    assert.equal(fx.zoom, ocrRenderFactor(fx.rs, fx.rect.x1 - fx.rect.x0, fx.rect.y1 - fx.rect.y0), "stale fixture — capture again");
    const key = await vectorKey(fx);
    assert.equal(key.length, 28);
    const spans = wordsToSpans(fx.words as OcrWord[]);
    const on = score(readScheduleSpans(spans, { ocr: true }), key);
    const off = score(readScheduleSpans(spans), key);
    assert.deepEqual(on.wrong, [], "no tag the vector read lacks");
    assert.ok(on.exact >= 28, `tags: ${on.exact}/28`);
    assert.ok(on.section >= sectionFloor, `section agrees: ${on.section}/28, floor ${sectionFloor}`);
    assert.ok(on.group >= groupFloor, `dialog group agrees: ${on.group}/28, floor ${groupFloor}`);
    assert.deepEqual(on.wrongSection, [], "no printed section other than the vector read's");
    // the reset is never worse than the read without it
    assert.ok(on.wrong.length <= off.wrong.length, "wrong tags");
    assert.ok(on.exact >= off.exact, "exact tags");
    assert.ok(on.section >= off.section, "section agreement");
    assert.ok(on.group >= off.group, "group agreement");
    assert.ok(on.wrongSection.length <= off.wrongSection.length, "wrong sections");
  });
}

// The 200 DPI copy lost its FLOORING, BASE and WALLS headings, all of them,
// so it never shows a row carried into the next code group. Take headings out
// of the 100 DPI copy, one group at a time, and the plain read carries the
// heading above into the group below (measured: BASE+WALLS 10 rows wrong,
// BASE 3, WALLS 7, MILLWORK 4); the blank-band reset leaves those rows with
// no section instead. The heading words are removed by their exact text, each
// printed once in the fixture.
for (const drop of [["BASE", "WALLS"], ["BASE"], ["WALLS"], ["MILLWORK"]]) {
  test(`with the ${drop.join(" and ")} heading${drop.length > 1 ? "s" : ""} missing, the blank-band reset leaves no row under the heading above`, async () => {
    const fx = fixture(100);
    const key = await vectorKey(fx);
    for (const h of drop) assert.equal(fx.words.filter((w) => w.str === h).length, 1, `the fixture prints ${h} once`);
    const words = fx.words.filter((w) => !drop.includes(w.str));
    const spans = wordsToSpans(words as OcrWord[]);
    const off = score(readScheduleSpans(spans), key);
    const on = score(readScheduleSpans(spans, { ocr: true }), key);
    assert.ok(off.wrongSection.length > 0, "without the reset, some row carries the heading above");
    assert.deepEqual(on.wrongSection, [], `with the reset, no printed section other than the vector read's (without it: ${off.wrongSection.join(", ")})`);
    assert.deepEqual(on.wrong, [], "no tag the vector read lacks");
    assert.ok(on.exact >= 28, `tags: ${on.exact}/28`);
    assert.ok(on.section >= off.section && on.group >= off.group, "the reset is no worse on section or group agreement");
  });
}
