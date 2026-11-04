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
test("human CSV headings localize without altering numeric values or quoted user data", () => {
  const csv = 'Finish,Floor m²\r\nCPT-1,12.345\r\n"My floor, section 2",4.5\r\n';
  try {
    setLanguage("en");
    assert.equal(localizeCsv(csv), csv);
    setLanguage("ru");
    const output = localizeCsv(csv);
    assert.ok(output.startsWith('\uFEFFВид работ;Пол, м²'));
    assert.ok(output.includes('Ковровое покрытие 1 (CPT-1);12,345'));
    assert.ok(output.includes('My floor, section 2;4,5'));
  } finally { setLanguage("en"); }
});
test("runtime catalog is identical to the editable JSON and keeps interpolation placeholders", () => {
  const json = JSON.parse(readFileSync(new URL("../src/lib/i18n/ru.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog, json);
  for (const [key, text] of Object.entries(catalog)) {
    const en = [...key.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    const ru = [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    assert.deepEqual(ru, en, key);
  }
});
