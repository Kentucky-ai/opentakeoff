import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scoreRows, summarize } from "../bench/ocr-codes/score.ts";

const root = new URL("./fixtures/ocr-codes/", import.meta.url);
const truth = JSON.parse(readFileSync(new URL("truth.json", root), "utf8"));

test("public OCR fixture bytes, dimensions and per-cell truth stay paired", () => {
  assert.equal(truth.fixtures.length, 4);
  assert.equal(truth.fixtures.filter((f: { control: boolean }) => f.control).length, 1);
  for (const fixture of truth.fixtures) {
    const png = readFileSync(new URL(fixture.file, root));
    assert.equal(createHash("sha256").update(png).digest("hex"), fixture.sha256);
    assert.equal(png.readUInt32BE(16), fixture.width);
    assert.equal(png.readUInt32BE(20), fixture.height);
    assert.deepEqual(fixture.rows.map((r: { expected: string }) => r.expected), ["P1", "P2", "SS-2", "SS-3", "VWC", "WVC", "ST-1", "S-1", "P-1", "BK-1", "G-01(C)", "FT-02(E)"]);
    for (const row of fixture.rows) {
      assert.ok(row.rect.x0 >= 0 && row.rect.x1 <= fixture.width);
      assert.ok(row.rect.y0 >= 0 && row.rect.y1 <= fixture.height);
    }
  }
});

test("another row's valid code and dropped punctuation are still wrong", () => {
  const rect = { x0: 0, y0: 0, x1: 50, y1: 20 };
  const next = { ...rect, y0: 20, y1: 40 };
  const scored = scoreRows([{ expected: "P-1", rect }, { expected: "P1", rect: next }], [{ text: "P1", rect, confidence: 0.99 }]);
  assert.deepEqual(scored.map((r) => [r.actual, r.ok]), [["P1", false], ["", false]]);
  assert.equal(summarize(scored).missing, 1);
  assert.equal(summarize(scored).thresholds[3].wrongAtOrAbove, 1);
  for (const [expected, actual] of [["P-1", "P.1"], ["G-01(C)", "G-01C"], ["SS-2", "S-2"]]) {
    assert.equal(scoreRows([{ expected, rect }], [{ text: actual, rect }])[0].ok, false);
  }
});

test("scoring ignores descriptions, counts missing reads, and never averages split-box confidence", () => {
  const rect = { x0: 0, y0: 0, x1: 50, y1: 20 };
  const good = scoreRows([{ expected: "P1", rect }], [
    { text: "p1", rect, confidence: 0.98 },
    { text: "MATERIAL", rect: { ...rect, x0: 50, x1: 100 }, confidence: 0.99 },
  ]);
  assert.equal(good[0].ok, true);
  assert.equal(summarize(good).thresholds[2].correctAtOrAbove, 1);
  const split = scoreRows([{ expected: "P1", rect }], [
    { text: "1", rect: { ...rect, x0: 15, x1: 25 }, confidence: 0.99 },
    { text: "P", rect: { ...rect, x0: 0, x1: 10 }, confidence: 0.99 },
  ]);
  assert.equal(split[0].actual, "P 1");
  assert.equal(split[0].confidence, undefined);
  assert.equal(summarize(split).thresholds[3].wrongAtOrAbove, 0);
});
