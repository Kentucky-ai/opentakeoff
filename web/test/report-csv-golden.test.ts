// Golden-snapshot test for the report CSV: the full byte-for-byte output of
// totalsToCsv(conditionTotals(...)) against a checked-in fixture. Any change
// to the CSV shape — columns, rounding, escaping, materials section, the
// (unescaped) title line — fails here first, on purpose.
//
// To regenerate after an INTENTIONAL format change: re-run the pipeline below
// against the same fixture and overwrite test/fixtures/report.golden.csv
// (never hand-edit the golden file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// totals.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { conditionTotals, sheetTotals, totalsToCsv } from "../src/lib/totals.js";
import { conditions, shapes, projectName, sheetLabel } from "./fixtures/report.fixture.ts";

test("report CSV matches the golden snapshot byte-for-byte", () => {
  const golden = readFileSync(new URL("./fixtures/report.golden.csv", import.meta.url), "utf8");
  const rows = conditionTotals(conditions, shapes).filter((r: any) => r.shape_count > 0);
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel);
  assert.equal(csv, golden);
});
