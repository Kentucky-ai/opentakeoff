// Replays two captured on-device reads of the demo material schedule (#470)
// through the reader the canvas runs on them, scored against the vector read
// of the same box — the answer key is computed here, from the demo PDF, by
// the canvas's own vector path (TakeoffCanvas importScheduleFromRect:
// pageSpans → spansInRect → graphSpans → readScheduleSpans).
//
// The fixtures (test/fixtures/schedule-ocr/, each file's `about` says how
// they were captured and redacted) are the OCR engine's words for Import
// from schedule's box on raster copies of page 2 at 200 and 100 DPI. The
// box is read as planTiles plans it (lib/ocr/boxRead.ts): under the cap, one
// tile at its zoom; a fixture captured at another zoom, or that the plan now
// splits into tiles, no longer says what the canvas would read, so it fails
// as stale. Both were captured under ppu's per-line recognition at batch 6,
// before #484 (each file's `recognition`, checked as provenance only); the
// canvas now reads per box at batch 1 (engineOptions.ts). They replay
// recorded words through the reader, so they pin the reader, not what
// today's engine returns: no check here can notice an engine change.
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
//
// The answer key is computed with the reader under test, so it is pinned
// here too — every tag in print order with its printed section and dialog
// group, the demo's values as mcp/test/scheduleImport.test.ts pins them — and
// a change to the reader that moved the key cannot move the scores with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pageSpans, spansInRect, graphSpans } from "../src/lib/pageSpans.ts";
import { readScheduleSpans, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import { boxWords } from "../src/lib/ocr/boxRead.ts";
import { planTiles } from "../src/lib/ocr/seams.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

type Rect = { x0: number; y0: number; x1: number; y1: number };
interface Fixture {
  source: { page: number; pageSize: { w: number; h: number; rotate: number } };
  rs: number; rect: Rect; zoom: number;
  /** the recognition options the words were read under */
  recognition: { strategy: string; recBatchSize: number };
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
    assert.deepEqual(r.rows.map((x) => [x.finish_tag, x.section, x.category]), KEY, "the answer key is the demo's pinned read");
    return r.rows;
  } finally {
    await doc.destroy();
  }
}

/** The vector read of the demo material schedule: [tag, section, category], in print order. */
const KEY: Array<[string, string, string]> = [
  ["CPT-1", "FLOORING", "floor"], ["CPT-2", "FLOORING", "floor"], ["VCT-1", "FLOORING", "floor"],
  ["PT-1", "FLOORING", "floor"], ["PT-2", "FLOORING", "floor"], ["C", "FLOORING", "floor"],
  ["RB-1", "BASE", "base"], ["CBT-1", "BASE", "base"], ["CT-3", "BASE", "base"],
  ["P-1", "WALLS", "wall"], ["P-2", "WALLS", "wall"], ["P-3", "WALLS", "wall"], ["CT-1", "WALLS", "wall"],
  ["CT-2", "WALLS", "wall"], ["CT-4", "WALLS", "wall"], ["SC-1", "WALLS", "wall"],
  ["PLAM-1", "MILLWORK", "other"], ["PLAM-2", "MILLWORK", "other"], ["S-1", "MILLWORK", "other"], ["S-2", "MILLWORK", "other"],
  ["ACT-1", "CEILINGS", "ceiling"], ["ACT-2", "CEILINGS", "ceiling"],
  ["PR-1", "MISC", "unassigned"], ["TS-1", "MISC", "transition"], ["TS-2", "MISC", "transition"],
  ["HR-1", "MISC", "wall_protection"], ["CR-1", "MISC", "wall_protection"], ["CG-1", "MISC", "wall_protection"],
];

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
    const plan = planTiles(fx.rect, fx.rs);
    assert.deepEqual([plan.tiles.length, plan.zoom], [1, fx.zoom], "stale fixture — capture again");
    // provenance only: the words are a recording, replayed, so this can't
    // notice an engine change; it keeps the file honest about which engine
    // read them
    assert.deepEqual(fx.recognition, { strategy: "per-line", recBatchSize: 6 }, "recorded under the pre-#484 engine (per-line, batch 6); replays words, so it can't detect an engine change");
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

// The canvas's box read hands the reader boxWords' words, which are cleaned
// of the cells' ruling (#482): both copies end codes with a rule read as "_"
// (RB-1_, P-2_, C_ …). Through boxWords they meet the same floors with the
// same rows: the reader already dropped the "_" from a code.
for (const [dpi, sectionFloor, groupFloor] of [[200, 12, 14], [100, 28, 28]] as const) {
  test(`the ${dpi} DPI read through boxWords: the same rows, the same floors`, async () => {
    const fx = fixture(dpi);
    assert.ok(fx.words.some((w) => w.str.endsWith("_")), "the fixture has ruling to clean");
    const key = await vectorKey(fx);
    const raw = readScheduleSpans(wordsToSpans(fx.words as OcrWord[]), { ocr: true });
    const cleaned = readScheduleSpans(wordsToSpans(boxWords(fx.words)), { ocr: true });
    assert.deepEqual(cleaned, raw);
    const on = score(cleaned, key);
    assert.deepEqual(on.wrong, [], "no tag the vector read lacks");
    assert.ok(on.exact >= 28, `tags: ${on.exact}/28`);
    assert.ok(on.section >= sectionFloor, `section agrees: ${on.section}/28, floor ${sectionFloor}`);
    assert.ok(on.group >= groupFloor, `dialog group agrees: ${on.group}/28, floor ${groupFloor}`);
    assert.deepEqual(on.wrongSection, [], "no printed section other than the vector read's");
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
