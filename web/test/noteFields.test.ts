// noteFields — {{qty}} in a note resolves to its linked condition's measured
// quantity (#474). Rows are built through conditionTotals so a totals schema
// change can't leave these tests passing against hand-rolled numbers.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasFields, qtyLabels, resolveNote, resolveMarkup } from "../src/lib/noteFields.ts";
import { conditionTotals, reportJson } from "../src/lib/totals.js";

const conds = [
  { id: "em", finish_tag: "EM-1", multiplier: 1, waste_pct: 10 },
  { id: "ct", finish_tag: "CT-1", multiplier: 2, waste_pct: 8 },
  { id: "none", finish_tag: "P-1", multiplier: 1 },
];
const shapes = [
  ...[1, 2, 3, 4, 5].map((i) => ({ id: `e${i}`, sheet_id: "p#1", condition_id: "em", measure_role: "count", computed: { count: 1 } })),
  { id: "f", sheet_id: "p#1", condition_id: "ct", measure_role: "floor_area", computed: { area_sf: 600 } },
  { id: "b", sheet_id: "p#1", condition_id: "ct", measure_role: "linear", computed: { perimeter_lf: 42.125 } },
];
const labels = qtyLabels(conditionTotals(conds, shapes));

test("{{qty}} is the linked condition's measured count", () => {
  assert.deepEqual(resolveNote("Provide and install x{{qty}} emergency lights", "em", labels),
    { text: "Provide and install x5 EA emergency lights", unresolved: [] });
});

test("measured, not ordered: multiplier applies, waste does not; every unit listed SF → LF", () => {
  // 600 SF × 2 units, 42.125 LF × 2 — the 8% waste never reaches the note
  assert.equal(resolveNote("{{qty}}", "ct", labels).text, "1,200 SF · 84.25 LF");
});

test("the number moves with the takeoff", () => {
  const more = [...shapes, { id: "e6", sheet_id: "p#1", condition_id: "em", measure_role: "count", computed: { count: 1 } }];
  assert.equal(resolveNote("x{{qty}}", "em", qtyLabels(conditionTotals(conds, more))).text, "x6 EA");
});

test("case and inner whitespace don't matter", () => {
  assert.equal(resolveNote("{{ QTY }}", "em", labels).text, "5 EA");
});

test("unresolvable fields stay literal and are reported — never blank, never 0", () => {
  assert.deepEqual(resolveNote("x{{qty}} lights", "", labels), { text: "x{{qty}} lights", unresolved: ["{{qty}}"] });
  assert.deepEqual(resolveNote("x{{qty}}", "none", labels), { text: "x{{qty}}", unresolved: ["{{qty}}"] });   // nothing measured yet
  assert.deepEqual(resolveNote("x{{qty}}", "gone", labels), { text: "x{{qty}}", unresolved: ["{{qty}}"] });   // deleted condition
  assert.deepEqual(resolveNote("{{qty}} of {{Emergency light}}", "em", labels),
    { text: "5 EA of {{Emergency light}}", unresolved: ["{{Emergency light}}"] });
});

test("text without fields passes through untouched", () => {
  assert.equal(hasFields("plain note"), false);
  assert.equal(hasFields("a { b } c"), false);
  assert.equal(hasFields("{{}}"), true);
  assert.deepEqual(resolveNote("plain note", "em", labels), { text: "plain note", unresolved: [] });
  assert.deepEqual(resolveNote(undefined, "em", labels), { text: "", unresolved: [] });
});

test("metric display converts area and length, not counts", () => {
  const m = qtyLabels(conditionTotals(conds, shapes), "metric");
  assert.equal(m.get("ct"), "111.48 m² · 25.68 m");
  assert.equal(m.get("em"), "5 EA");
});

test("resolveMarkup returns the same object when there's nothing to resolve", () => {
  const plain = { id: "a", text: "no fields", condition_id: "em" };
  assert.equal(resolveMarkup(plain, labels).m, plain);
  const live = { id: "b", text: "x{{qty}}", condition_id: "em" };
  const r = resolveMarkup(live, labels);
  assert.equal(r.m.text, "x5 EA");
  assert.equal(live.text, "x{{qty}}");   // the stored template is never rewritten
  assert.equal((r.m as any).field_warn, undefined);
  const broken = resolveMarkup({ id: "c", text: "x{{qty}}", condition_id: "" }, labels);
  assert.equal((broken.m as any).field_warn, true);
});

test("report JSON: text keeps the template, text_resolved appears only on a note that carries a field", () => {
  const rows = conditionTotals(conds, shapes).filter((r: any) => r.shape_count > 0);
  const j: any = reportJson({ rows, markups: [
    { id: "m1", type: "text", sheet_id: "p#1", text: "x{{qty}} lights", condition_id: "em" },
    { id: "m2", type: "text", sheet_id: "p#1", text: "plain", condition_id: "em" },
  ] });
  assert.equal(j.markups[0].text, "x{{qty}} lights");
  assert.equal(j.markups[0].text_resolved, "x5 EA lights");
  assert.equal("text_resolved" in j.markups[1], false);
});
