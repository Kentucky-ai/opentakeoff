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
