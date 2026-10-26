// #519 measure-first: score a blind second read of the rows the on-device
// code check flags, before any provider read is built (bench/ocr-codes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreRows, summarize, scoreSecondRead, formatSecondReadTable } from "../bench/ocr-codes/score.ts";
import { blindReadPrompt, parseBlindReply, providerSecondReader } from "../bench/ocr-codes/secondRead.ts";

const rect = (i: number) => ({ x0: 0, y0: i * 20, x1: 50, y1: i * 20 + 20 });
// One cell per row; `alt` undefined means the code check agreed (no flag).
const rows = (cases: Array<[expected: string, primary: string, alt?: string]>) => scoreRows(
  cases.map(([expected], i) => ({ expected, rect: rect(i) })),
  cases.map(([, text, alt], i) => ({ text, rect: rect(i), confidence: 0.99, ...(alt !== undefined ? { codeAlternate: alt } : {}) })),
);

test("summary splits an empty second read from a real alternate", () => {
  const s = summarize(rows([
    ["SS-2", "SS-2", ""],     // right, empty alternate
    ["P-1", "P.1", ""],       // wrong, empty alternate
    ["S-1", "5.1", "S-1"],    // wrong, alternate is the truth
    ["VWC", "WWC", "WC"],     // wrong, alternate is wrong too
    ["ST-1", "ST-1", "S-1"],  // right, alternate wrong
    ["P2", "P2"],             // not flagged
  ]));
  assert.deepEqual(s.flaggedEmpty, { correct: 1, wrong: 1 });
  assert.deepEqual(s.flaggedAlternate, { correct: 1, wrong: 2, alternateIsTruth: 1 });
  // the existing fields keep their meaning
  assert.equal(s.flaggedCorrect, 2);
  assert.equal(s.unflaggedWrong, 0);
});

test("blind rule clears a flag only on agreement with the primary read", () => {
  const scored = rows([
    ["SS-2", "SS-2", ""],    // second = primary, primary right  → cleared correctly
    ["P-1", "P.1", "P-1"],   // second = primary, primary wrong  → cleared WRONGLY
    ["S-1", "5.1", "S-1"],   // second = alternate               → two reads vs one, shown
    ["VWC", "WWC", "WC"],    // a third string                   → stays on Check code
    ["BK-1", "BK.1", "BK-1"],// nothing usable                   → stays on Check code
    ["P2", "P2"],            // not flagged: never read, never counted
  ]);
  const r = scoreSecondRead(scored, ["ss-2 ", "P.1", "S-1", "VWC", "", "XX"], "crop");
  assert.equal(r.unit, "crop");
  assert.equal(r.all.flagged, 5);
  assert.deepEqual(r.all.read, { correct: 3, wrong: 1, nothing: 1 });
  assert.deepEqual(r.all.blind, { clearedCorrect: 1, clearedWrong: 1, twoVsOne: 1, twoVsOneAlternateRight: 1, keptThird: 1, keptNothing: 1 });
  // The naive rule (take the second read as the code) settles four rows,
  // one of them wrong, and that wrong one was the agreeing P.1.
  assert.deepEqual(r.all.naive, { settledCorrect: 3, settledWrong: 1, brokeCorrect: 0, kept: 1 });
  assert.equal(r.empty.flagged, 1);
  assert.equal(r.alternate.flagged, 4);
});

test("naive rule counts a correct primary turned wrong; the blind rule never does", () => {
  const scored = rows([["ST-1", "ST-1", "S-1"]]);
  const r = scoreSecondRead(scored, ["S-1"], "row");
  assert.deepEqual(r.all.naive, { settledCorrect: 0, settledWrong: 1, brokeCorrect: 1, kept: 0 });
  // blind: equals the alternate, so both readings stay in front of the person
  assert.equal(r.all.blind.twoVsOne, 1);
  assert.equal(r.all.blind.clearedWrong, 0);
});

test("second reads compare through codeCheck's comparable(), punctuation kept", () => {
  const scored = rows([["P-1", "P-1", ""], ["G-01(C)", "G-01(C)", "G-01C"]]);
  const r = scoreSecondRead(scored, ["  p-1 ", "G-01C"], "crop");
  assert.equal(r.all.blind.clearedCorrect, 1);   // "  p-1 " is P-1
  assert.equal(r.all.blind.twoVsOne, 1);         // G-01C is not G-01(C)
  assert.equal(r.all.read.wrong, 1);
});

test("table prints one column per crop unit, side by side", () => {
  const scored = rows([["S-1", "5.1", "S-1"], ["P-1", "P.1", "P-1"]]);
  const table = formatSecondReadTable([
    scoreSecondRead(scored, ["S-1", "P.1"], "crop"),
    scoreSecondRead(scored, ["S-1", "P-1"], "row"),
  ]);
  const lines = table.split("\n");
  assert.match(lines[0], /\| crop \| row \|$/);
  assert.ok(lines.some((l) => /flags cleared wrongly \| 1 \| 0 \|/.test(l)), table);
});

test("the blind prompt never carries a candidate reading", () => {
  for (const unit of ["crop", "row"] as const) {
    const p = blindReadPrompt(unit, { leftPct: 7 });
    assert.doesNotMatch(p, /\b(?:or|either)\b.*\?/i);
    assert.match(p, /UNREADABLE/);
  }
  assert.match(blindReadPrompt("row", { leftPct: 7 }), /7%/);
});

test("replies normalise to one code or nothing", () => {
  assert.equal(parseBlindReply("P-1"), "P-1");
  assert.equal(parseBlindReply("`SS-2`\n"), "SS-2");
  assert.equal(parseBlindReply("\"ST.1\""), "ST.1");
  assert.equal(parseBlindReply("UNREADABLE"), null);
  assert.equal(parseBlindReply(""), null);
  assert.equal(parseBlindReply(null), null);
  assert.equal(parseBlindReply("The code is P-1 or maybe P1, hard to say."), null);
});

test("provider reader sends the crop and the blind prompt only, through ai.js plumbing", async () => {
  const sent: Array<{ url: string; body: string }> = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "S-1" } }] }) };
  };
  const read = providerSecondReader({ endpoint: "http://localhost:9", model: "m", provider: "openai", apiKey: "" }, fetchFn);
  const png = new Uint8Array([137, 80, 78, 71]);
  assert.equal(await read(png, "crop", { leftPct: 0 }), "S-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://localhost:9/v1/chat/completions");
  const body = JSON.parse(sent[0].body);
  const text = body.messages[0].content.find((p: { type: string }) => p.type === "text").text;
  assert.equal(text, blindReadPrompt("crop", { leftPct: 0 }));
  assert.match(body.messages[0].content.find((p: { type: string }) => p.type === "image_url").image_url.url, /^data:image\/png;base64,iVBORw==$/);
  const failing = providerSecondReader({ endpoint: "http://localhost:9", model: "m", provider: "openai", apiKey: "" },
    async () => ({ ok: false, status: 500, json: async () => ({}) }));
  // A transport failure is not "nothing usable": it stops the measurement.
  await assert.rejects(failing(png, "crop", { leftPct: 0 }), /HTTP 500/);
});

test("recorded checked runs: the split of the public set", () => {
  const recorded = JSON.parse(readFileSync(new URL("../bench/ocr-codes/checked-native.json", import.meta.url), "utf8"));
  const s = summarize(recorded.results.flatMap((r: { rows: unknown[] }) => r.rows));
  assert.deepEqual(s.flaggedEmpty, { correct: 1, wrong: 0 });
  assert.deepEqual(s.flaggedAlternate, { correct: 1, wrong: 10, alternateIsTruth: 9 });
});

test("recorded second-read runs re-score to their committed tables", () => {
  for (const name of ["native", "browser"]) {
    const run = JSON.parse(readFileSync(new URL(`../bench/ocr-codes/second-read-${name}.json`, import.meta.url), "utf8"));
    const checked = JSON.parse(readFileSync(new URL(`../bench/ocr-codes/checked-${name}.json`, import.meta.url), "utf8"));
    const scored = checked.results.flatMap((r: { rows: unknown[] }) => r.rows);
    for (const result of run.results) {
      const reads = run.rows.map((r: { flagged: boolean; second: Record<string, string | null> }) => (r.flagged ? r.second[result.unit] : undefined));
      assert.deepEqual(scoreSecondRead(scored, reads, result.unit), result, `${name} ${result.unit}`);
    }
  }
});
