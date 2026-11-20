// Compare an actual UI export after review + undo with the starting fixture.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
if (!process.argv[2]) throw new Error("Pass the exported takeoff JSON path.");
const baseline = JSON.parse(await fs.readFile(process.argv[3] || new URL("./sample.takeoff.json", import.meta.url), "utf8"));
const exported = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
assert.deepEqual(exported.shapes, baseline.shapes);
assert.deepEqual(exported.conditions, baseline.conditions);
for (const sheet of baseline.sheets) {
  const saved = exported.sheets.find(s => s.sheet_id === sheet.sheet_id);
  for (const [key, value] of Object.entries(sheet)) assert.deepEqual(saved?.[key], value);
}
assert.equal(Object.keys(exported).some(k => /selection/i.test(k)), false);
console.log("PASS: every measurement and condition equals the baseline; source calibration is preserved; selection is not exported.");
