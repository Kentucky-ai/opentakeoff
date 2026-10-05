import { test } from "node:test";
import assert from "node:assert/strict";
import { checkableCode, checkCodes, type CodeRead } from "../src/lib/ocr/codeCheck.ts";
import { wordsToSpans } from "../src/lib/ocr/types.ts";
import { boxWords } from "../src/lib/ocr/boxRead.ts";
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import { rowToSeed } from "../src/lib/scheduleRows.ts";
import { codeCheckShown, evaluateTags, isCreatable, setPicked } from "../src/lib/scheduleEdit.ts";
import { splitRecognizer, type PpuServiceInternals } from "../src/lib/ocr/splitRecognize.ts";
import { build, M, MMC } from "./fixtures/reader483Fixtures.ts";

const box = { x: 10, y: 20, width: 30, height: 12 };
const read = (text: string): CodeRead => ({ text, box, confidence: 0.999 });

test("short code checks include surviving single letters, numeric misreads and suffixes, not prose or huge crops", () => {
  for (const text of ["P", "P1", "SS-2", "P.1", "55.3", "5.1", "G-01 (C)", "VWC"]) assert.ok(checkableCode(read(text)), text);
  for (const text of ["CERAMIC TILE", "FINISH", "", "A".repeat(20)]) assert.ok(!checkableCode(read(text)), text);
  assert.ok(!checkableCode({ ...read("P1"), box: { ...box, width: 1025 } }));
  assert.ok(!checkableCode({ ...read("P1"), box: { ...box, height: 257 } }));
});

test("a .999 primary read is kept verbatim and flagged on disagreement, without choosing the alternate", async () => {
  const original = read("S-2"), snapshot = structuredClone(original);
  const result = await checkCodes([original], "source", (source, b) => { assert.equal(source, "source"); assert.equal(b, box); return "crop"; }, async (crop, b) => {
    assert.equal(crop, "crop"); assert.deepEqual(b, { x: 0, y: 0, width: 60, height: 12 });
    return [{ ...read("SS-2"), confidence: 0.55 }];
  });
  assert.deepEqual(result[0], { ...original, codeAlternate: "SS-2" });
  assert.deepEqual(original, snapshot);
});

test("same spelling after border cleanup is agreement; missing/multiple second reads are not", async () => {
  const input = read("P-1");
  assert.equal((await checkCodes([input], {}, () => ({}), async () => [read("[p-1]")]))[0], input);
  for (const second of [[], [read("P"), read("1")]]) {
    assert.equal((await checkCodes([input], {}, () => ({}), async () => second))[0].codeAlternate, "");
  }
  await assert.rejects(checkCodes([input], {}, () => ({}), async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("prose is returned without extra allocations or recognition", async () => {
  const input = read("MATERIAL / SERIES ALPHA / GREY");
  const fail = () => { throw new Error("must not reread prose"); };
  assert.equal((await checkCodes([input], {}, fail, fail))[0], input);
});

test("split recognizer checks only when requested, retaining original grouped geometry", async () => {
  const calls: unknown[][] = [];
  const svc: PpuServiceInternals = {
    detector: { run: async () => [box] }, options: { recognition: { strategy: "per-box" } }, destroy: async () => {},
    recognitor: { run: async (...args) => { calls.push(args); return [read(args[0] === "crop" ? "SS-2" : "S-2")]; } },
  };
  const wrapper = splitRecognizer(svc, () => "crop");
  await wrapper.recognize("source", { flatten: false, noCache: true });
  assert.equal(calls.length, 1);
  const result = await wrapper.recognize("source", { flatten: false, noCache: true, verifyCodes: true }) as { lines: CodeRead[][] };
  assert.equal(calls.length, 3);
  assert.deepEqual(result.lines[0][0], { ...read("S-2"), codeAlternate: "SS-2" });
  assert.equal((calls[2][4] as Record<string, unknown>).verifyCodes, undefined, "private option never reaches ppu");
  await assert.rejects(splitRecognizer(svc).recognize("source", { flatten: false, noCache: true, verifyCodes: true }), /cropper unavailable/);
});

test("warnings survive box words and spans, flag only the code cell, and never enter a condition seed", () => {
  const spans = build({ cols: MMC, items: [M("S-2", "CERAMIC TILE", "VENDOR-A", "GREY"), M("PT-1", "PAINT", "VENDOR-B", "WHITE")] });
  const words = spans.map((s) => ({ str: s.str, x: s.x, y: s.y + s.h, w: s.w, h: s.h,
    ...(s.str === "S-2" ? { codeAlternate: "SS-2" } : s.str === "PAINT" ? { codeAlternate: "POINT" } : {}) }));
  const converted = wordsToSpans(boxWords(words));
  const result = readScheduleSpans(converted, { ocr: true });
  const flagged = result.rows.find((r) => r.finish_tag === "S-2")!;
  assert.deepEqual(flagged.code_checks, [{ first: "S-2", second: "SS-2" }]);
  assert.equal(flagged.suggested, false);
  assert.equal(result.rows.find((r) => r.finish_tag === "PT-1")?.code_checks, undefined);
  assert.ok(!("code_checks" in rowToSeed(flagged, 0)));
  assert.ok(readScheduleSpans(converted).rows.every((r) => !r.code_checks), "native reads do not gain OCR warnings");
});

test("bulk selection skips disputed tags; individual selection survives; editing the code clears its warning", () => {
  const rows = [{ finish_tag: "S-2", code_checks: [{ first: "S-2", second: "SS-2" }] }, { finish_tag: "PT-1" }];
  const states = evaluateTags(rows.map((r) => ({ key: r.finish_tag, tag: r.finish_tag })));
  const canBulkPick = (key: string) => isCreatable(states.get(key)) && !codeCheckShown(rows.find((r) => r.finish_tag === key)!, states.get(key)!.tag);
  assert.deepEqual([...setPicked(new Set(), ["S-2", "PT-1"], canBulkPick, true)], ["PT-1"]);
  assert.deepEqual([...setPicked(new Set(["S-2"]), ["S-2", "PT-1"], canBulkPick, true)], ["S-2", "PT-1"]);
  assert.equal(codeCheckShown(rows[0], "s-2"), true);
  assert.equal(codeCheckShown(rows[0], "SS-2"), false);
});

test("removing a repeated clipped fragment keeps its unresolved warning on the surviving code", () => {
  const words = boxWords([
    { str: "S-2", x: 10, y: 20, w: 30, h: 10, clipped: true, codeAlternate: "SS-2" },
    { str: "S-2", x: 8, y: 20, w: 34, h: 10, clipped: true },
  ]);
  assert.deepEqual(words, [{ str: "S-2", x: 8, y: 20, w: 34, h: 10, codeAlternate: "" }]);
});

test("stable wrong reads still require individual review, irrespective of confidence", async () => {
  const [same] = await checkCodes([read("P-110")], {}, () => ({}), async () => [read("P-110")]);
  assert.equal(same.codeAlternate, undefined);
  const spans = build({ cols: MMC, items: [M(same.text, "CERAMIC TILE", "VENDOR-A", "GREY"), M("PT-1", "PAINT", "VENDOR-B", "WHITE")] });
  const rows = readScheduleSpans(spans, { ocr: true }).rows;
  assert.ok(rows.every(r => r.ocr_code && codeCheckShown(r, r.finish_tag)));
  assert.deepEqual([...setPicked(new Set(), rows.map(r => r.finish_tag), k => !codeCheckShown(rows.find(r => r.finish_tag === k)!, k), true)], []);
  assert.ok(rows.every(r => !('ocr_code' in rowToSeed(r, 0))));
  assert.ok(readScheduleSpans(spans).rows.every(r => !r.ocr_code && !codeCheckShown(r, r.finish_tag)));
});

test("numeric misread inside a finish key column becomes an unnamed review row, never the alternate identity", () => {
  const spans = build({ cols: MMC, items: [M("PT-1", "PAINT", "VENDOR-A", "WHITE"), M("88-2", "SOLID SURFACE", "VENDOR-B", "GREY"), M("CT-1", "CERAMIC TILE", "VENDOR-C", "BEIGE")] });
  const numeric = spans.find(s => s.str === '88-2')!; numeric.codeAlternate = 'SS-2';
  const before = structuredClone(spans);
  const rows = readScheduleSpans(spans, { ocr: true }).rows;
  assert.deepEqual(rows.map(r => r.finish_tag), ['PT-1', '', 'CT-1']);
  assert.equal(rows[1].description, 'SOLID SURFACE');
  assert.equal(rows[1].manufacturer, 'VENDOR-B');
  assert.deepEqual(rows[1].code_checks, [{ first: '88-2', second: 'SS-2' }]);
  assert.equal(rows[1].suggested, false);
  assert.equal(evaluateTags([{ key: 'r', tag: rows[1].finish_tag }]).get('r')?.status, 'empty');
  assert.deepEqual(spans, before);
  assert.deepEqual(readScheduleSpans(spans).rows.map(r => r.finish_tag), ['PT-1', 'CT-1']);
});

test("a numeric misread on the table's last row is recovered like a middle row (#511 review)", () => {
  const spans = build({ cols: MMC, items: [M("PT-1", "PAINT", "VENDOR-A", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-C", "BEIGE"), M("88-2", "SOLID SURFACE", "VENDOR-B", "GREY")] });
  spans.find(s => s.str === '88-2')!.codeAlternate = 'SS-2';
  const rows = readScheduleSpans(spans, { ocr: true }).rows;
  assert.deepEqual(rows.map(r => r.finish_tag), ['PT-1', 'CT-1', '']);
  assert.equal(rows[2].description, 'SOLID SURFACE');
  assert.deepEqual(rows[2].code_checks, [{ first: '88-2', second: 'SS-2' }]);
  assert.equal(rows[1].description, 'CERAMIC TILE', "the last row's words don't stay in the row above");
  // a numeric text far below the table is not a row of it
  const far = build({ cols: MMC, items: [M("PT-1", "PAINT", "VENDOR-A", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-C", "BEIGE")] });
  const ct = far.find(s => s.str === 'CT-1')!;
  far.push({ ...ct, str: '88-2', y: ct.y + 20 * ct.h, codeAlternate: 'SS-2' });
  assert.deepEqual(readScheduleSpans(far, { ocr: true }).rows.map(r => r.finish_tag), ['PT-1', 'CT-1']);
});

test("two numeric misreads in a row at the end of a table both recover (#517 review)", () => {
  const spans = build({ cols: MMC, items: [M("PT-1", "PAINT", "VENDOR-A", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-C", "BEIGE"), M("88-2", "SOLID SURFACE", "VENDOR-B", "GREY"), M("55-3", "SOLID SURFACE", "VENDOR-D", "TAN")] });
  spans.find(s => s.str === '88-2')!.codeAlternate = 'SS-2';
  spans.find(s => s.str === '55-3')!.codeAlternate = 'SS-3';
  const rows = readScheduleSpans(spans, { ocr: true }).rows;
  assert.deepEqual(rows.map(r => r.finish_tag), ['PT-1', 'CT-1', '', '']);
  assert.deepEqual(rows.map(r => r.manufacturer), ['VENDOR-A', 'VENDOR-C', 'VENDOR-B', 'VENDOR-D']);
  assert.deepEqual(rows[3].code_checks, [{ first: '55-3', second: 'SS-3' }]);
});

test("numeric values in non-key cells and foreign schedules cannot create recovery rows", () => {
  const spans = build({ cols: MMC, items: [M("PT-1", "PAINT", "88-2", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-C", "BEIGE")] });
  spans.find(s => s.str === '88-2')!.codeAlternate = 'SS-2';
  assert.deepEqual(readScheduleSpans(spans, { ocr: true }).rows.map(r => r.finish_tag), ['PT-1', 'CT-1']);
  const foreign = [{ str: 'DOOR SCHEDULE', x: 100, y: -40, w: 180, h: 15 }, ...spans];
  assert.equal(readScheduleSpans(foreign, { ocr: true }).rows.length, 0);
});
