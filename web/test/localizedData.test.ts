import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { formatMessage, localizeText, setLanguage } from "../src/lib/i18n/core.js";
import { conditionTotals, sheetTotals, totalsToCsv } from "../src/lib/totals.js";
import { CSV_PROFILE } from "../src/lib/reportColumns.js";
import { reportWorkbook, buildXlsx } from "../src/lib/xlsx.js";
import { estimateWorkbook } from "../src/lib/estimateExport.js";
import { priceEstimate } from "../src/lib/estimate.js";
import { estimateForDisplay } from "../src/lib/estimatePresentation.js";
import { rfisToCsv } from "../src/lib/rfi.js";
import { shapesDetail, shapesToCsv } from "../src/lib/shapesExport.js";

const options = { language: "ru", localize: (value: unknown) => localizeText(value, "ru") };
const columns = CSV_PROFILE.filter(c => c.defaultVisible);
const conditions = ["Report", "Work", "001.20", '=SUM(1,2); "Пол"'].map((tag, i) => ({
  id: `c${i}`, finish_tag: tag, waste_pct: 5,
  pricing: { unit: "SF", material: 2, labor: 3 },
  materials: [{ name: "Work", unit: "bag", per: 100, basis: "area", price: 20, note: "Report\n001.20" }],
}));
const shapes = conditions.map(c => ({
  id: `s${c.id}`, sheet_id: "001.20", condition_id: c.id, measure_role: "floor_area",
  verts_norm: [[.1, .1], [.5, .1], [.5, .5]],
  computed: { area_sf: 100, perimeter_lf: 40 },
}));

test("whole status messages preserve data slots and explicitly translated nested messages", () => {
  const backup = localizeText("Your previous takeoff was snapshotted — Revisions restores it.", "ru");
  for (const count of [0, 1, 2, 5, 21]) {
    assert.equal(formatMessage("Deleted conditions: {0}. Deleted takeoffs: {1}.", [count, count], "ru"),
      `Удалено видов работ: ${count}. Удалено измерений: ${count}.`);
    const opened = formatMessage("Opened {0} — PDFs: {1}, takeoffs: {2}.{3}", ["Report", 2, count, " " + backup], "ru");
    assert.equal(opened, `Открыт Report — PDF: 2, измерений: ${count}. ${backup}`);
    assert.ok(!opened.includes("Your previous"));
  }
  assert.equal(formatMessage("Opened {0} — PDFs: {1}, takeoffs: {2}.{3}", ["Work", 1, 2, ""], "en"),
    "Opened Work — PDFs: 1, takeoffs: 2.");
  const skipped = formatMessage("Skipped proposals: {0}. Open their sheets with scales set to accept them.", [1], "ru");
  assert.equal(formatMessage("Accepted agent proposals: {0}.{1}", [2, " " + skipped], "ru"),
    "Принято предложений агента: 2. Пропущено предложений: 1. Для принятия откройте соответствующие листы и задайте масштаб.");
  assert.equal(formatMessage("{0}: material price, {1}/{2}", ["Report", "₽", "м²"], "ru"), "Report: цена материала, ₽/м²");
  assert.equal(formatMessage("{0}: labor price, {1}/{2}", ["Work", "$", "SF"], "en"), "Work: labor price, $/SF");
  assert.equal(formatMessage("Imported measurements: {0}", [21], "ru"), "Импортировано измерений: 21");
});

test("actual CSV exporters preserve custom names, text codes and notes while formatting numeric cells", () => {
  const rows = conditionTotals(conditions, shapes);
  const bySheet = sheetTotals(conditions, shapes);
  const customColumn = { key: "custom:test", header: "Work", custom: true, get: () => "001.20" };
  const csv = totalsToCsv(rows, "Report", bySheet, () => "Work", [...columns, customColumn], null, null, "OpenTakeoff", "imperial", options);
  assert.ok(csv.startsWith("\uFEFF# Report"));
  assert.ok(csv.split("\r\n")[1].startsWith("Вид работ;"));
  assert.ok(csv.split("\r\n")[1].endsWith(";Work"), "custom column heading remains data");
  assert.ok(csv.includes("\r\nReport;1;1;5;100;"));
  assert.ok(csv.includes("\r\n001.20;1;1;5;100;"));
  assert.ok(csv.includes("Work;001.20;Report;100;"), "sheet title and sheet ID remain data");
  assert.ok(csv.includes('"Report\n001.20"'), "multiline note remains exact");
  assert.ok(csv.includes("Report;Work;1;мешок;"));
  assert.ok(csv.includes("'="), "formula-shaped text stays inert");
  const metric = totalsToCsv(rows, "", null, null, columns, null, null, "OpenTakeoff", "metric", options);
  assert.ok(metric.includes("Report;1;1;5;9,29;"));
  assert.ok(metric.includes("001.20;1;1;5;9,29;"), "text code keeps its dot while a real numeric quantity uses a comma");
  const details = shapesDetail(conditions, shapes, () => "Report");
  const detailCsv = shapesToCsv(details, "Work", "OpenTakeoff", "metric", options);
  assert.ok(detailCsv.includes("sc0;Report;001.20;Report;"));
  assert.ok(detailCsv.includes(";9,29;12,19;"));
  const rfiCsv = rfisToCsv([{ id: "r", number: "001.20", subject: "Report", question: "Work", response: "Solid", status: "open" }], [], "Work", null, "OpenTakeoff", options);
  assert.ok(rfiCsv.includes("001.20;Report;Открыт;"));
  assert.ok(rfiCsv.includes(";Work;Solid;"));
});

test("report and estimate XLSX retain typed data and the same quantities and money after language switches", async () => {
  const before = JSON.stringify({ conditions, shapes });
  const rows = conditionTotals(conditions, shapes);
  const source = priceEstimate({ rows, conditions });
  assert.equal(source.total, 2120); // 4 × (105 SF × 2 + 100 SF × 3 + 1 bag × 20)
  for (const language of ["ru", "en", "ru"]) {
    setLanguage(language);
    const presentation = { language, localize: localizeText };
    const metric = language === "ru";
    const report = reportWorkbook({ rows, bySheet: sheetTotals(conditions, shapes), shapeRows: shapesDetail(conditions, shapes), cols: columns, units: metric ? "metric" : "imperial", presentation });
    const estimate = estimateWorkbook({ est: estimateForDisplay(source, metric, "l"), projectName: "Report", companyName: "Solid", clientName: "Work", ...presentation });
    for (const tag of ["Report", "Work", "001.20"]) {
      assert.ok(report[0].rows.some(r => r[0] === tag));
      assert.ok(estimate[0].rows.some(r => r[0] === tag));
      assert.ok(estimate[1].rows.some(r => r[0] === tag && r[1] === "Work"));
    }
    assert.deepEqual(estimate[0].rows.slice(0, 3).map(r => r[1]), ["Report", "Solid", "Work"]);
    const line = estimate[0].rows.find(r => r[0] === "001.20")!;
    assert.equal(line[line.length - 1], 530);
    assert.equal(line[9], 20);
    const files = unzipSync(await buildXlsx(estimate));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]);
    assert.ok(xml.includes('<t>001.20</t>'));
    assert.ok(xml.includes('<v>530</v>'));
    assert.ok(!xml.includes('<f>'), "customer strings do not become formulas");
    assert.equal(JSON.stringify({ conditions, shapes }), before);
  }
  setLanguage("en");
});
