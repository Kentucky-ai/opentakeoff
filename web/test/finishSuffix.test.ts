import { test } from "node:test";
import assert from "node:assert/strict";
import { finishCodeOk, finishKeyText, legacyFinishTag, normalizeFinishTag } from "../src/lib/finishCode.ts";
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import { buildSheetGraph, readFinishTable, resolveTag, rowKeyAnswersFor } from "../src/lib/sheetgraph.ts";
import { repairKey } from "../src/lib/ocr/wordClean.ts";
import { evaluateTags, isCreatable, newScheduleRows, setPicked } from "../src/lib/scheduleEdit.ts";
import { build, M, MMC } from "./fixtures/reader483Fixtures.ts";

const table = (keys: string[]) => build({
  cols: MMC, colX: { MATERIAL: 420, MANUFACTURER: 750, COLOR: 1000 },
  items: keys.map((key) => M(key, "CERAMIC TILE", "VENDOR-A", "GREY")),
});

test("finish suffix: compact and spaced parentheses survive native and OCR schedule reads", () => {
  const spans = table(["G-01(C)", "FT-02 (E)", "G-01 ( W )", "G-01C", "G-02"]);
  for (const ocr of [false, true]) {
    const got = readScheduleSpans(spans, { ocr });
    assert.deepEqual(got.rows.map((r) => r.finish_tag), ["G-01(C)", "FT-02(E)", "G-01(W)", "G-01C", "G-02"]);
    assert.ok(got.rows.every((r) => !r.read_as), "preserving printed punctuation isn't an OCR repair");
  }
  assert.deepEqual(readFinishTable({ key: "schedule.pdf", spans })?.table.rows.map((r) => r.key), ["G-01(C)", "FT-02(E)", "G-01(W)", "G-01C", "G-02"]);
});

test("suffix stays in the key; an actual qualifier stays in the description", () => {
  const got = readScheduleSpans(table(["G-01 (C) NOT USED", "G-02(W)", "FTB-01 CUT (C)", "FT-02(E) SAT", "G-03"]));
  const rows = new Map(got.rows.map((r) => [r.finish_tag, r]));
  assert.equal(rows.get("G-01(C)")?.unticked_reason, "not-used");
  assert.match(rows.get("FTB-01")?.description ?? "", /^CUT \(C\)/);
  assert.match(rows.get("FT-02(E)")?.description ?? "", /^SAT/);
});

test("compound keys retain suffixes and answer only for the printed variants", () => {
  const got = readScheduleSpans(table(["G-01(C) / G-01(W)", "FT-02(E)", "G-03"]));
  assert.equal(got.rows[0].finish_tag, "G-01(C)/G-01(W)");
  assert.ok(rowKeyAnswersFor(got.rows[0].finish_tag, "G-01 (C)"));
  assert.ok(!rowKeyAnswersFor(got.rows[0].finish_tag, "G-01C"));
  assert.ok(!rowKeyAnswersFor(got.rows[0].finish_tag, "G-01(E)"));
});

test("a malformed suffix is flagged, never silently flattened into a different code", () => {
  for (const key of ["G-01(C", "G-01C)", "G-01()", "G-01((C))", "G-01(C)(W)", "TILE(C)"]) assert.ok(!finishCodeOk(key), key);
  for (const key of ["G-01(C)", "G-01C", "FT-02(E)", "CPT-1(A1)"]) assert.ok(finishCodeOk(key), key);
  // A historical OCR result lacked its closing parenthesis. The row keeps
  // its own place (it used to vanish and its words joined G-01(C)'s) under
  // the code without the parenthesis, flagged with what was read so the
  // flat code is checked, not trusted (#510 review).
  for (const ocr of [false, true]) {
    const malformed = readScheduleSpans(table(["G-01(C)", "FT-OB(C", "G-02"]), { ocr });
    assert.deepEqual(malformed.rows.map((r) => r.finish_tag), ["G-01(C)", "FT-OBC", "G-02"], `ocr=${ocr}`);
    assert.equal(malformed.rows[1].read_as, "FT-OB(C");
    assert.equal(malformed.rows[0].read_as, undefined);
    assert.equal(malformed.rows[0].description, "CERAMIC TILE");
  }
});

test("a parenthesized word of three or more letters is a qualifier, not a suffix (#510 review)", () => {
  for (const key of ["CPT-1(TYP)", "PT-1(CUT)", "G-01(ALT)"]) assert.ok(!finishCodeOk(key), key);
  for (const key of ["G-01(C)", "FT-02(E)", "ACT-1(2X2)", "G-01(AB)"]) assert.ok(finishCodeOk(key), key);
  const got = readScheduleSpans(table(["CPT-1 (TYP)", "ACT-1 (2X2)", "G-01(C)"]));
  assert.deepEqual(got.rows.map((r) => r.finish_tag), ["CPT-1", "ACT-1(2X2)", "G-01(C)"]);
  assert.match(got.rows[0].description, /^\(TYP\) — /);
  assert.equal(finishKeyText("PT-1 (CUT)"), "PT-1 CUT");
  assert.equal(finishKeyText("G-01(C)/FT-0B(C"), "G-01(C)/FT-0BC");
});

test("an abbreviated qualifier and unpaired parentheses are judged over the whole cell (#516 review)", () => {
  for (const ocr of [false, true]) {
    const got = readScheduleSpans(table(["CPT-1 (TYP.)", "G-01(C )", "G-01 (W", "G-02"]), { ocr });
    assert.deepEqual(got.rows.map((r) => [r.finish_tag, r.read_as ?? ""]), [["CPT-1", ""], ["G-01(C)", ""], ["G-01W", "G-01 (W"], ["G-02", ""]], `ocr=${ocr}`);
    assert.match(got.rows[0].description, /^\(TYP\.\) — /);
  }
  assert.equal(finishKeyText("CPT-1 (TYP.)"), "CPT-1 TYP");
});

test("resolve_tag chains a parenthesized room-finish cell to its definition (#510 review)", () => {
  const sp = (str: string, x: number, y: number) => ({ str, x, y, w: str.length * 7, h: 10 });
  const rooms = { key: "s#1", sheet_number: "A-601", spans: [
    sp("ROOM FINISH SCHEDULE", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("101", 100, 80), sp("LOBBY", 160, 80), sp("G-01(C)", 300, 80), sp("RB-1", 400, 80), sp("PT-1", 500, 80),
    sp("102", 100, 100), sp("OFFICE", 160, 100), sp("G-01 ( W )", 300, 100), sp("RB-1", 400, 100), sp("PT-1", 500, 100),
  ] };
  const fin = { key: "s#2", sheet_number: "A-602", spans: [
    sp("MATERIAL SCHEDULE", 100, 300), sp("CODE", 100, 320), sp("MATERIAL", 220, 320), sp("MANUFACTURER", 380, 320),
    ...[["G-01(C)", "VENDOR-A"], ["G-01(W)", "VENDOR-B"], ["RB-1", "VENDOR-C"], ["PT-1", "VENDOR-D"]].flatMap(([c, v], i) =>
      [sp(c, 100, 340 + i * 20), sp("TILE", 220, 340 + i * 20), sp(v, 380, 340 + i * 20)]),
  ] };
  const g = buildSheetGraph([rooms, fin]);
  for (const [tag, want] of [["101", "VENDOR-A"], ["102", "VENDOR-B"]]) {
    const res = resolveTag(g, tag);
    assert.equal(res.status, "resolved", tag);
    if (res.status !== "resolved") continue;
    assert.equal(res.finishes.find((f) => f.surface === "FLOOR")?.definition?.cells.MANUFACTURER, want, tag);
  }
});

test("OCR digit repairs leave suffix characters and their punctuation intact", () => {
  assert.deepEqual(repairKey("G-O1(C)", "G-O1(C)"), { key: "G-01(C)", readAs: "G-O1(C)" });
  assert.deepEqual(repairKey("FT-O2(O)", "FT-O2(O)"), { key: "FT-02(O)", readAs: "FT-O2(O)" });
  assert.deepEqual(repairKey("$SM-O1(C)", "SM-O1(C)"), { key: "SSM-01(C)", readAs: "$SM-O1(C)" });
  assert.deepEqual(repairKey("G-O1 ( C )", "G-O1(C)"), { key: "G-01(C)", readAs: "G-O1(C)" });
});

test("tag normalization keeps printed identities distinct and custom names intact", () => {
  assert.equal(normalizeFinishTag(" g-01 ( c ) "), "G-01(C)");
  assert.equal(normalizeFinishTag("g-01c"), "G-01C");
  assert.equal(normalizeFinishTag("res   w"), "RES W");
  assert.equal(normalizeFinishTag("LOBBY ( EAST )"), "LOBBY ( EAST )");
});

test("re-import holds only a possible old flattened spelling, without mutating or aliasing it", () => {
  const existing = new Set([" g-01c ", "FT-02 (E)"]);
  const before = [...existing];
  const rows = [{ key: "c", tag: "G-01 (C)" }, { key: "w", tag: "G-01(W)" }, { key: "e", tag: "FT-02(E)" }];
  const states = evaluateTags(rows, existing);
  assert.deepEqual(states.get("c"), { key: "c", tag: "G-01(C)", status: "legacy", legacyTag: "G-01C" });
  assert.equal(states.get("w")?.status, "ok");
  assert.equal(states.get("e")?.status, "in-use");
  assert.deepEqual([...setPicked(new Set(), rows.map((r) => r.key), (key) => isCreatable(states.get(key)), true)], ["w"]);
  assert.deepEqual([...existing], before);
  assert.equal(legacyFinishTag("G-01(C)", ["G-01C"]), "G-01C");
  assert.equal(legacyFinishTag("G-01(C)", ["G-01W", "G-01(C)"]), undefined);
  // New imports with both printed identities stay separate. No historical
  // flattened condition exists here, so there is no migration to infer.
  assert.ok([...evaluateTags([{ key: "a", tag: "G-01C" }, { key: "b", tag: "G-01(C)" }]).values()].every(isCreatable));
  const selected = [{ finish_tag: "G-01C" }, { finish_tag: "G-01 (C)" }, { finish_tag: "G-01(C)" }, { finish_tag: "G-01(W)" }];
  assert.deepEqual(newScheduleRows(selected, new Set()).map((r) => r.finish_tag), ["G-01C", "G-01(C)", "G-01(W)"]);
  assert.deepEqual(newScheduleRows(selected, new Set(["G-01C"])).map((r) => r.finish_tag), ["G-01(W)"]);
});

test("suffix whitespace dedups exact re-imports; a reviewed condition rename resolves the legacy warning", () => {
  const rows = [{ key: "a", tag: "G-01(C)" }, { key: "b", tag: "g-01 ( c )" }];
  assert.deepEqual([...evaluateTags(rows).values()].map((s) => s.status), ["ok", "duplicate"]);
  assert.deepEqual([...evaluateTags(rows, new Set(["G-01 (C)"])).values()].map((s) => s.status), ["in-use", "in-use"]);
});
