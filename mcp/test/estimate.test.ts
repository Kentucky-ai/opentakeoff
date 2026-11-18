// The estimate verbs (set_pricing, set_estimate_settings, estimate_summary,
// export_estimate, export_proposal) over a real session on the demo plan. The
// math is web/src/lib/estimate.js (tested there); these pin the session's
// half: what is written, what undo restores, what rides export/import, and
// what the files carry. Prices are placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import { Session } from "../src/session.ts";
import { importTakeoff } from "../src/importing.ts";
import { exportEstimateFile, exportProposalFile } from "../src/estimateFiles.ts";
import { OT_NAME, OT_WATERMARK } from "../../web/src/lib/branding.js";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const SQ = (x: number, y: number, w = 100): [number, number][] => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

// upp 1/10: a 100 px square is 10 ft × 10 ft = 100 SF
async function measured() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 10 });
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  s.editCondition("CPT-1", { waste_pct: 10 });
  s.editMaterials("CPT-1", { add: [{ name: "Adhesive", per: 50, basis: "area", unit: "pail" }] });
  s.measureLine(KEY, [[0, 300], [500, 300]], { condition: "RB-1" });
  return s;
}

test("set_pricing: material on the order quantity, labor on the measured one; supply rows by name", async () => {
  const s = await measured();
  const r = s.setPricing("CPT-1", { unit: "SF", material: 2, labor: 1, materials: [{ name: "adhesive", price: 30 }] });
  assert.deepEqual(r.pricing, { unit: "SF", material: 2, labor: 1 });
  assert.deepEqual(r.material_prices, [{ name: "Adhesive", unit: "pail", price: 30 }]);
  const l = r.line!;
  assert.equal(l.material_qty, 110);
  assert.equal(l.labor_qty, 100);
  assert.equal(l.material_cost, 220);
  assert.equal(l.labor_cost, 100);
  assert.equal(l.materials[0].qty, 2);      // supplies divide the MEASURED basis: ceil(100 / 50) whole pails
  assert.equal(l.materials_cost, 60);
  assert.equal(l.total, 380);
  assert.equal(l.status, "priced");
});

test("estimate_summary names every unentered price and never counts it as entered", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { material: 2 });
  const sum = s.estimateSummary();
  assert.equal(sum.complete, false);
  assert.equal(sum.settings_source.startsWith("unset"), true);
  const by = Object.fromEntries(sum.unpriced.map((u: any) => [u.finish_tag, u.missing]));
  assert.deepEqual(by["CPT-1"], ["labor", "material row: Adhesive"]);
  assert.deepEqual(by["RB-1"], ["material", "labor"]);
  assert.match(sum.note, /never fill one in yourself/);
});

test("set_pricing refuses an unknown row or condition and an empty call; null clears to not-entered", async () => {
  const s = await measured();
  assert.throws(() => s.setPricing("CPT-1", { materials: [{ name: "Grout", price: 1 }] }), /no material row "Grout".*Adhesive/);
  assert.throws(() => s.setPricing("NOPE-1", { material: 1 }), /No condition "NOPE-1"/);
  assert.throws(() => s.setPricing("CPT-1", {}), /Nothing to change/);
  s.setPricing("CPT-1", { material: 2, labor: 1 });
  const r = s.setPricing("CPT-1", { labor: null });
  assert.deepEqual(r.pricing, { material: 2 });
  assert.equal(r.line!.status, "partial");
});

test("undo_last restores pricing and supply prices verbatim; settings undo restores all three records", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { unit: "SY", material: 20, labor: 5, materials: [{ name: "Adhesive", price: 30 }] });
  s.setPricing("CPT-1", { unit: "SF", material: null, materials: [{ name: "Adhesive", price: null }] });
  const undone = s.undoLast(1);
  assert.equal(undone.steps[0].op, "pricing");
  const c = s.conditions.find((x) => x.finish_tag === "CPT-1")!;
  assert.deepEqual(c.pricing, { unit: "SY", material: 20, labor: 5 });
  assert.equal(c.materials[0].price, 30);
  s.setEstimateSettings({ overhead_pct: 10, proposal: { itemized: true, terms: "Net 30" }, client: { name: "Example GC" } });
  s.setEstimateSettings({ overhead_pct: 15, client: { name: "" } });
  s.undoLast(1);
  assert.equal(s.estimateSettings!.overhead_pct, 10);
  assert.equal(s.clientInfo.client_name, "Example GC");
  s.undoLast(1);
  assert.equal(s.estimateSettings, null);
  assert.equal(s.bidProposal, null);
  assert.deepEqual(s.clientInfo, {});
});

test("set_estimate_settings: markups price the summary; margin is ÷ (1 − p); proposal and client are kept", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { material: 0, labor: 10, materials: [{ name: "Adhesive", price: 0 }] });
  s.setPricing("RB-1", { material: 0, labor: 0 });
  const r = s.setEstimateSettings({ profit_pct: 100 / 3, profit_mode: "margin", proposal: { exclusions: "Floor prep", valid_days: 45 }, client: { name: "Example GC", reference: "B-7" } });
  assert.equal(r.estimate_settings!.profit_mode, "margin");
  assert.equal(r.bid_proposal!.exclusions, "Floor prep");
  assert.deepEqual(r.client_info, { client_name: "Example GC", reference: "B-7" });
  const sum = s.estimateSummary();
  assert.equal(sum.complete, true);
  assert.equal(sum.total, 1500);   // 1000 labor ÷ (1 − 1/3)
  assert.throws(() => s.setEstimateSettings({}), /Nothing to change/);
});

test("export_takeoff carries prices and the project records; a fresh session adopts them; a joined unpriced condition takes the file's prices", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { unit: "SY", material: 20, labor: 5, materials: [{ name: "Adhesive", price: 30 }] });
  s.setEstimateSettings({ tax_pct: 6, proposal: { terms: "Net 30" }, client: { name: "Example GC" } });
  const doc = s.exportPayload() as any;
  assert.deepEqual(doc.conditions.find((c: any) => c.finish_tag === "CPT-1").pricing, { unit: "SY", material: 20, labor: 5 });
  assert.equal(doc.estimate_settings.tax_pct, 6);
  assert.equal(doc.bid_proposal.terms, "Net 30");
  assert.equal(doc.client_info.client_name, "Example GC");
  const dir = await mkdtemp(path.join(tmpdir(), "ot-estimate-"));
  const file = path.join(dir, "takeoff.json");
  await writeFile(file, JSON.stringify(doc));

  const fresh = new Session();
  await fresh.loadPlan(PLAN);
  await importTakeoff(fresh, file);
  assert.equal(fresh.estimateSummary().total, s.estimateSummary().total);
  assert.equal(fresh.clientInfo.client_name, "Example GC");

  // a session that measured CPT-1 itself (unpriced) joins the file's CPT-1 and takes its prices
  const own = new Session();
  await own.loadPlan(PLAN);
  own.setScale(KEY, { upp: 1 / 10 });
  own.measurePolygon(KEY, SQ(400, 0), { condition: "CPT-1", role: "floor_area" });
  own.editMaterials("CPT-1", { add: [{ name: "Adhesive", per: 50, basis: "area", unit: "pail" }] });
  await importTakeoff(own, file);
  const joined = own.conditions.find((c) => c.finish_tag === "CPT-1")!;
  assert.deepEqual(joined.pricing, { unit: "SY", material: 20, labor: 5 });
  assert.equal(joined.materials.find((m) => m.name === "Adhesive")!.price, 30);
});

test("export_estimate writes the workbook beside the plan; our own file may be replaced, a foreign one is refused", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { material: 2 });
  const dir = await mkdtemp(path.join(tmpdir(), "ot-estimate-"));
  const out = path.join(dir, "job - estimate.xlsx");
  const r = await exportEstimateFile(s, { path: out, project_name: "Job" });
  assert.deepEqual(r.tabs, ["Estimate", "Materials", "Unpriced"]);
  assert.equal(r.complete, false);
  const zip = unzipSync(new Uint8Array(await readFile(out)));
  const sheet1 = strFromU8(zip["xl/worksheets/sheet1.xml"]);
  assert.ok(sheet1.includes("Base bid") && sheet1.includes("Prepared with OpenTakeoff"));
  await exportEstimateFile(s, { path: out, project_name: "Job" });   // ours: replaced without overwrite
  const foreign = path.join(dir, "theirs.xlsx");
  await writeFile(foreign, "not ours");
  await assert.rejects(() => exportEstimateFile(s, { path: foreign }), /overwrite/i);
});

test("export_proposal writes the watermarked PDF; it never refuses an incomplete estimate and says so", async () => {
  const s = await measured();
  s.setPricing("CPT-1", { material: 2, labor: 1, materials: [{ name: "Adhesive", price: 30 }] });
  s.setEstimateSettings({ proposal: { itemized: true, exclusions: "Floor prep" }, client: { name: "Example GC" } });
  const dir = await mkdtemp(path.join(tmpdir(), "ot-estimate-"));
  const out = path.join(dir, "proposal.pdf");
  const r = await exportProposalFile(s, { path: out, project_name: "Job", company: { name: "Sample Flooring Co", license: "LIC-000" } });
  assert.equal(r.pages, 1);
  assert.equal(r.itemized, true);
  assert.equal(r.complete, false);   // RB-1 unpriced
  assert.equal(r.unpriced[0].finish_tag, "RB-1");
  const pdf = await PDFDocument.load(await readFile(out), { updateMetadata: false });   // load() rewrites Producer otherwise
  assert.equal(pdf.getProducer(), "OpenTakeoff");
  let text = "";
  for (const ref of (pdf.getPages()[0] as any).node.Contents().asArray()) {
    const st: any = pdf.context.lookup(ref), f = st.dict.lookup(PDFName.of("Filter"));
    text += Buffer.from(String(f) === "/FlateDecode" ? inflateSync(st.contents) : st.contents).toString("latin1");
  }
  for (const t of ["Sample Flooring Co", "Example GC", "Floor prep", OT_NAME, OT_WATERMARK]) assert.ok(text.includes(hex(t)), t);
  const blank = await exportProposalFile(s, { path: path.join(dir, "b.pdf") });
  assert.match(blank.note ?? "", /No company name/);
});

test("export_takeoff's wire schema accepts the estimate records (the reply is validated against it)", async () => {
  const { z } = await import("zod");
  const { exportTakeoffOutput } = await import("../src/outputs.ts");
  const s = await measured();
  s.setPricing("CPT-1", { material: 2 });
  s.setEstimateSettings({ tax_pct: 6, proposal: { terms: "Net 30" }, client: { name: "Example GC" } });
  const parsed = z.object(exportTakeoffOutput).strict().safeParse(s.exportPayload());
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
});

// ── every line is priceable (one line per quantity kind, web/src/lib/estimate.js) ──
// CPT-1: a 100 SF room + a 50 LF plain run + two floor boxes, all under one condition
async function multiKind() {
  const s = await measured();
  s.measureLine(KEY, [[0, 500], [500, 500]], { condition: "CPT-1" });
  s.placeCount(KEY, [[600, 600], [700, 600]], { condition: "CPT-1" });
  return s;
}

test("set_pricing line prices a condition's LF and EA lines; estimate_summary lists every line with its unit, quantities, rates and missing", async () => {
  const s = await multiKind();
  const main = s.setPricing("CPT-1", { material: 2, labor: 1, materials: [{ name: "Adhesive", price: 30 }] });
  assert.equal(main.line!.unit, "SF");
  assert.deepEqual(main.lines.map((l: any) => [l.unit, l.main, l.status]), [["SF", true, "priced"], ["LF", false, "unpriced"], ["EA", false, "unpriced"]]);
  assert.match(main.note ?? "", /LF \(material, labor\); EA \(material, labor\).*line "LF"/);
  const lf = s.setPricing("CPT-1", { line: "LF", material: 1.5, labor: 0.75 });
  assert.deepEqual(lf.pricing, { material: 2, labor: 1, by_unit: { LF: { material: 1.5, labor: 0.75 } } });
  assert.deepEqual([lf.line!.unit, lf.line!.material_qty, lf.line!.labor_qty, lf.line!.material_cost, lf.line!.labor_cost, lf.line!.status], ["LF", 55, 50, 82.5, 37.5, "priced"]);
  s.setPricing("CPT-1", { line: "EA", material: 40 });
  let sum = s.estimateSummary();
  const cpt = sum.lines.filter((l: any) => l.finish_tag === "CPT-1");
  assert.deepEqual(cpt.map((l: any) => [l.unit, l.material_qty, l.labor_qty, l.material_rate, l.labor_rate, l.status, l.missing]), [
    ["SF", 110, 100, 2, 1, "priced", []],
    ["LF", 55, 50, 1.5, 0.75, "priced", []],
    ["EA", 2, 2, 40, null, "partial", ["labor"]],
  ]);
  assert.deepEqual(sum.unpriced.filter((u: any) => u.finish_tag === "CPT-1").map((u: any) => [u.unit, u.missing]), [["EA", ["labor"]]]);
  s.setPricing("CPT-1", { line: "EA", labor: 25 });
  s.setPricing("RB-1", { material: 1, labor: 1 });
  sum = s.estimateSummary();
  assert.equal(sum.complete, true);
  // 110×2 + 100×1 + 2 pails×30 + 82.5 + 37.5 + 2×40 + 2×25 + RB-1 (50 LF, no waste, at $1 + $1)
  assert.equal(sum.total, 220 + 100 + 60 + 82.5 + 37.5 + 80 + 50 + 50 + 50);
  // null clears a by_unit rate back to not entered; undo restores the nested rates verbatim
  s.setPricing("CPT-1", { line: "LF", material: null, labor: null });
  assert.deepEqual(s.conditions.find((c) => c.finish_tag === "CPT-1")!.pricing!.by_unit, { EA: { material: 40, labor: 25 } });
  s.undoLast(1);
  assert.deepEqual(s.conditions.find((c) => c.finish_tag === "CPT-1")!.pricing!.by_unit, { LF: { material: 1.5, labor: 0.75 }, EA: { material: 40, labor: 25 } });
});

test("set_pricing keeps old calls unchanged: unit still picks the main line's unit, line naming the main unit is the main line", async () => {
  const s = await multiKind();
  const r = s.setPricing("CPT-1", { unit: "LF", material: 1 });
  assert.deepEqual(r.pricing, { unit: "LF", material: 1 });
  assert.deepEqual(r.lines.map((l: any) => l.unit), ["LF", "SF", "EA"]);
  assert.equal(r.line!.unit, "LF");
  const same = s.setPricing("CPT-1", { line: "LF", labor: 2 });
  assert.deepEqual(same.pricing, { unit: "LF", material: 1, labor: 2 });   // line = the main unit → the main line, no by_unit
  // the second area line prices in SF
  const sf = s.setPricing("CPT-1", { line: "SF", material: 3 });
  assert.deepEqual(sf.pricing.by_unit, { SF: { material: 3 } });
  assert.throws(() => s.setPricing("CPT-1", { line: "SY", material: 3 }), /second area line prices in SF/);
  s.setPricing("CPT-1", { unit: "SF" });
  assert.throws(() => s.setPricing("CPT-1", { line: "SY", material: 3 }), /area line is its main line, priced in SF/);
  assert.throws(() => s.setPricing("CPT-1", { line: "LF" }), /Nothing to change.*line only says WHICH line/);
  // a kind the condition doesn't carry yet: saved, and the reply says so
  const none = s.setPricing("RB-1", { line: "EA", material: 5 });
  assert.equal(none.line, null);
  assert.match(none.note ?? "", /no count quantity yet/);
});

// A bordered linear condition, as the canvas writes it (thickness → border SF on
// each run): before multi-line estimates it priced as one SF line.
async function bordered() {
  const s = await measured();
  s.measureLine(KEY, [[0, 700], [1200, 700]], { condition: "BR-1" });   // 120 LF
  const c = s.conditions.find((x) => x.finish_tag === "BR-1")! as any;
  c.thickness_in = 4;
  for (const sh of s.shapes.filter((x: any) => x.condition_id === c.id) as any[]) sh.computed.area_sf = +(sh.computed.perimeter_lf * 4 / 12).toFixed(2);
  return s;
}

test("a bordered linear condition priced on its SF reads fully priced; its derived LF line is optional, not missing", async () => {
  const s = await bordered();
  s.setPricing("CPT-1", { material: 2, labor: 1, materials: [{ name: "Adhesive", price: 30 }] });
  s.setPricing("RB-1", { material: 1, labor: 1 });
  const r = s.setPricing("BR-1", { material: 5, labor: 3 });
  assert.equal(r.note, undefined);   // nothing else on BR-1 needs a price
  const sum = s.estimateSummary();
  const br = sum.lines.filter((l: any) => l.finish_tag === "BR-1");
  assert.deepEqual(br.map((l: any) => [l.unit, l.main, l.optional, l.labor_qty, l.status, l.missing, l.total]), [
    ["SF", true, false, 40, "priced", [], 320],   // 40 SF × $5 + 40 × $3 (no waste on BR-1)
    ["LF", false, true, 120, "optional", [], 0],
  ]);
  assert.equal(sum.complete, true);
  assert.deepEqual(sum.unpriced, []);
  assert.match(sum.note, /Every measured line is priced\. 1 optional line \(BR-1 LF\)/);
  const { z } = await import("zod");
  const { estimateSummaryOutput, setPricingOutput } = await import("../src/outputs.ts");
  assert.equal(z.object(estimateSummaryOutput).safeParse(sum).success, true);
  assert.equal(z.object(setPricingOutput).safeParse(r).success, true);

  // the workbook has no Unpriced tab; the proposal prints the LF row "Included", not $0.00
  const dir = await mkdtemp(path.join(tmpdir(), "ot-estimate-"));
  const x = await exportEstimateFile(s, { path: path.join(dir, "b - estimate.xlsx"), project_name: "B" });
  assert.deepEqual([x.tabs, x.complete], [["Estimate", "Materials"], true]);
  s.setEstimateSettings({ proposal: { itemized: true } });
  const out = path.join(dir, "b.pdf");
  const p = await exportProposalFile(s, { path: out, project_name: "B", company: { name: "Sample Flooring Co" } });
  assert.equal(p.complete, true);
  const pdf = await PDFDocument.load(await readFile(out), { updateMetadata: false });
  let text = "";
  for (const ref of (pdf.getPages()[0] as any).node.Contents().asArray()) {
    const st: any = pdf.context.lookup(ref), f = st.dict.lookup(PDFName.of("Filter"));
    text += Buffer.from(String(f) === "/FlateDecode" ? inflateSync(st.contents) : st.contents).toString("latin1");
  }
  assert.ok(text.includes(hex("Included")));

  // pricing the optional line is still possible, and rides export_takeoff → import_takeoff
  s.setPricing("BR-1", { line: "LF", labor: 0.5 });
  assert.equal(s.estimateSummary().total, sum.total + 60);
  const file = path.join(dir, "takeoff.json");
  await writeFile(file, JSON.stringify(s.exportPayload()));
  const fresh = new Session();
  await fresh.loadPlan(PLAN);
  await importTakeoff(fresh, file);
  assert.deepEqual(fresh.conditions.find((c) => c.finish_tag === "BR-1")!.pricing, { material: 5, labor: 3, by_unit: { LF: { labor: 0.5 } } });
  assert.equal(fresh.estimateSummary().total, s.estimateSummary().total);
});
