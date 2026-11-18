import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLanguage, getLanguage, localizeText, localizeCsv, finishLabel, scaleGroups, scaleRatioLabel, measurementCount } from "../src/lib/i18n/core.js";
import catalog from "../src/lib/i18n/ru.js";
import { areaVal, lenVal, heightInputToFeet } from "../src/lib/units.ts";

test("Russian presentation: material descriptions preserve source codes and unknown custom tags", () => {
  assert.equal(finishLabel("CPT-2", "ru"), "Ковровое покрытие 2 (CPT-2)");
  assert.equal(finishLabel("RB-1", "ru"), "Эластичный плинтус 1 (RB-1)");
  assert.equal(finishLabel("CPT-1", "en"), "CPT-1");
  assert.equal(finishLabel("Мой ламинат — участок 2", "ru"), "Мой ламинат — участок 2");
  assert.equal(measurementCount(1, "ru"), "1 измерение");
  assert.equal(measurementCount(2, "ru"), "2 измерения");
  assert.equal(measurementCount(11, "ru"), "11 измерений");
  assert.equal(measurementCount(21, "ru"), "21 измерение");
});
test("metric scales lead in Russian; English order and calibration values stay intact", () => {
  const feet = { label: '1/8" = 1\'-0"', upp: 0.01 };
  const ratio = { label: "1:100", upp: 0.02 };
  const input = [feet, ratio];
  const ru = scaleGroups(input, "ru");
  assert.equal(ru[0].scales[0], ratio);
  assert.equal(ru[1].scales[0], feet);
  assert.equal(scaleGroups(input, "en")[0].scales, input);
  assert.deepEqual(input, [feet, ratio]);
});
test("architectural scale can be shown as a true ratio without changing the scale", () => {
  assert.equal(scaleRatioLabel('1/8" = 1\'-0"', "ru"), "1:96");
  assert.equal(scaleRatioLabel('1-1/2" = 1\'-0"', "ru"), "1:8");
  assert.equal(scaleRatioLabel('1" = 20\'', "ru"), "1:240");
  assert.equal(scaleRatioLabel("1:100", "ru"), "1:100");
  assert.equal(scaleRatioLabel('1/8" = 1\'-0"', "en"), '1/8" = 1\'-0"');
});
test("language changes update menus and formatted strings, preserving project values", () => {
  try {
    setLanguage("ru");
    assert.equal(getLanguage(), "ru");
    assert.equal(localizeText("Set scale…"), "Задать масштаб");
    assert.equal(localizeText("Takeoff report"), "Ведомость объёмов работ");
    assert.equal(localizeText("Floor m²"), "Пол, м²");
    assert.equal(localizeText("Match 7: CUSTOM-42"), "Совпадение 7: CUSTOM-42");
    assert.equal(localizeText("Мой пол — 2026"), "Мой пол — 2026");
    assert.equal(localizeText(123.45), 123.45);
    const node = { type: "span", props: { children: "Note" } };
    assert.equal(localizeText(node), node);
    setLanguage("en");
    assert.equal(localizeText("Takeoff report"), "Takeoff report");
    assert.equal(localizeText("CPT-1"), "CPT-1");
  } finally { setLanguage("en"); }
});
test("locale does not redefine measurement conversions or an entered wall height", () => {
  setLanguage("ru");
  assert.equal(lenVal(10, "metric"), 3.048);
  assert.equal(areaVal(100, "metric"), 9.290304);
  assert.ok(Math.abs(heightInputToFeet(3, "metric") * 0.3048 - 3) < 1e-10);
  setLanguage("en");
  assert.equal(lenVal(10, "imperial"), 10);
});
test("legacy serialized CSV localizes headings but preserves body data without guessing types", () => {
  const csv = 'Finish,Floor m²\r\nCPT-1,12.345\r\n"My floor, section 2",4.5\r\n';
  try {
    setLanguage("en");
    assert.equal(localizeCsv(csv), csv);
    setLanguage("ru");
    const output = localizeCsv(csv);
    assert.ok(output.startsWith('\uFEFFВид работ;Пол, м²'));
    assert.ok(output.includes('CPT-1;12.345'));
    assert.ok(output.includes('My floor, section 2;4.5'));
  } finally { setLanguage("en"); }
});
test("runtime catalog matches JSON and preserves every content placeholder", () => {
  const json = JSON.parse(readFileSync(new URL("../src/lib/i18n/ru.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog, json);
  const handoff = JSON.parse(readFileSync(new URL("../../docs/i18n/ru-sentences-598.json", import.meta.url), "utf8"));
  const grammar = new Map(handoff.catalog_grammar_slots.map((entry: { key: string; omitted: Record<string, string> }) => [entry.key, entry.omitted]));
  for (const [key, text] of Object.entries(catalog)) {
    const omitted = grammar.get(key) as Record<string, string> | undefined;
    const en = [...key.matchAll(/\{(\d+)\}/g)].filter((m) => !omitted || !Object.prototype.hasOwnProperty.call(omitted, m[1])).map((m) => m[0]).sort();
    const ru = [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    assert.deepEqual(ru, en, key);
  }
  for (const [key, omitted] of grammar) {
    assert.ok(Object.prototype.hasOwnProperty.call(catalog, key as string));
    for (const [id, expression] of Object.entries(omitted as Record<string, string>)) {
      assert.ok((key as string).includes(`{${id}}`));
      // An omitted slot must be evidenced as an English grammar-only ternary.
      const choices = /\?\s*(["'])([^"']*)\1\s*:\s*(["'])([^"']*)\3$/.exec(expression);
      assert.ok(choices, expression);
      assert.ok([choices[2], choices[4]].every((s) => ["", "s", "es", "its", "their"].includes(s)), expression);
    }
  }
});

test("Russian count messages omit English endings while keeping counts and proposal labels", () => {
  try {
    setLanguage("ru");
    for (const count of [1, 2, 5, 21]) {
      const suffix = count === 1 ? "" : "s";
      assert.equal(localizeText(`Imported ${count} stamp${suffix}.`), `Импортировано штампов: ${count}`);
      assert.equal(localizeText(`Highlighted ${count} PDF text run${suffix}.`), `Выделено фрагментов текста PDF: ${count}`);
      assert.equal(localizeText(`Accepted “Batch A” — ${count} shape${suffix} — pencil is now ink (⌘Z undoes).`), `Приняты фигуры: “Batch A” — ${count}. Контуры сохранены (⌘Z — отменить).`);
    }
    assert.equal(localizeText("Price = cost ÷ (1 − 100%) — a margin must be under 100%."), "Цена = себестоимость ÷ (1 − 100%) — маржа должна быть меньше 100%.");
    assert.equal(localizeText("Sheet point approved — seal placed (⌘Z undoes)."), "Точка на листе утверждена — отметка поставлена (⌘Z — отменить).");
  } finally { setLanguage("en"); }
});

test("all 84 handoff locations have separate message roles, source bindings and rendered examples", () => {
  const handoff = JSON.parse(readFileSync(new URL("../../docs/i18n/ru-sentences-598.json", import.meta.url), "utf8"));
  assert.equal(handoff.sentences.length, 84);
  assert.equal(new Set(handoff.sentences.map((s: { id: number }) => s.id)).size, 84);
  const slots = (s: string) => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]))].sort();
  for (const site of handoff.sentences) {
    // Source excerpts identify the reviewed head, not a frozen implementation.
    assert.ok(site.source_excerpt.length > 0, `${site.file}:${site.line}`);
    for (const message of site.messages) {
      assert.deepEqual(slots(message.en), slots(message.ru), `${site.id}: ${message.en}`);
      assert.deepEqual(Object.keys(message.bindings).sort(), slots(message.ru));
      assert.equal(message.example_ru, message.ru.replace(/\{(\d+)\}/g, (_: string, id: string) => message.bindings[id].example));
      assert.ok(!/\{\d+\}/.test(message.example_ru));
    }
  }
  const refArea = handoff.sentences.find((s: { id: number }) => s.id === 4);
  assert.ok(refArea.messages.some((m: { ru: string }) => m.ru.includes("периметр контура пола × высота")));
  const geometry = handoff.sentences.find((s: { id: number }) => s.id === 72);
  assert.equal(geometry.messages[0].example_ru, "Измерений по фильтру: 75 из 100");
});
