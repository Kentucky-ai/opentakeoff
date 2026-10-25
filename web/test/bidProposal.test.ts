import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { conditionTotals } from "../src/lib/totals.js";
import { priceEstimate } from "../src/lib/estimate.js";
import { buildBidProposal, sanitizeBidProposal, bidProposalFromDefaults, allocate, textLines, scopeDescription, bidProposalFileName } from "../src/lib/bidProposal.js";
import { buildBidProposalPdf, wrapText } from "../src/lib/bidProposalPdf.js";
import { buildMarkedSetPdf } from "../src/lib/markedset.js";
import { OT_NAME, OT_WATERMARK } from "../src/lib/branding.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();
async function pageTexts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page: any) => {
    let s = "";
    for (const ref of page.node.Contents().asArray()) {
      const stream: any = doc.context.lookup(ref), filter = stream.dict.lookup(PDFName.of("Filter"));
      s += Buffer.from(String(filter) === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents).toString("latin1");
    }
    return s;
  });
}
const conds = [
  { id: "a", finish_tag: "CPT-1", spec: { description: "Broadloom carpet, direct glue" }, pricing: { unit: "SY", material: 20, labor: 5 } },
  { id: "b", finish_tag: "LVT-1", spec: { manufacturer: "Maker", style: "Plank", color: "Oak" }, pricing: { material: 3, labor: 2 } },
];
const shapes = [area("a", 900), area("b", 400)];
const est = priceEstimate({ rows: conditionTotals(conds, shapes), conditions: conds, settings: { overhead_pct: 10, profit_pct: 15, tax_pct: 6 } });
const today = new Date(2026, 9, 24);

test("allocate: cents, proportional, remainder on the largest line, always sums to the total", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [33.34, 33.33, 33.33]);
  const parts = allocate(1367.52, [600, 400, 7]);
  assert.equal(Math.round(parts.reduce((n: number, p: number) => n + p, 0) * 100), 136752);
  assert.deepEqual(allocate(50, [0, 0]), [50, 0]);
  assert.deepEqual(allocate(50, []), []);
});

test("model: itemized sell prices add up to the base bid; dates and validity", () => {
  const m = buildBidProposal({ est, conditions: conds, company: { name: "Sample Co" }, clientInfo: { client_name: "GC" }, projectName: "Clinic", proposal: { itemized: true, valid_days: 45 }, today });
  assert.equal(m.base_bid, est.total);
  assert.equal(Math.round(m.scope.reduce((n: number, s: any) => n + s.price, 0) * 100), Math.round(est.total * 100));
  assert.equal(m.date, "October 24, 2026");
  assert.equal(m.valid_until, "December 8, 2026");
  assert.deepEqual(m.scope.map((s: any) => [s.tag, s.unit, s.qty]), [["CPT-1", "SY", 100], ["LVT-1", "SF", 400]]);
  assert.equal(m.scope[0].description, "Broadloom carpet, direct glue");
  assert.equal(m.scope[1].description, "Maker · Plank · Oak");
});

test("text helpers: one item per line, bullets stripped; spec description fallbacks", () => {
  assert.deepEqual(textLines("- Material\n\n• Labor \n* Freight"), ["Material", "Labor", "Freight"]);
  assert.equal(scopeDescription({}), "");
  assert.equal(scopeDescription({ spec: { description: "  " , color: "Gray" } }), "Gray");
});

test("project record: sanitized, copied from Company setup defaults", () => {
  assert.deepEqual(sanitizeBidProposal({ itemized: "yes", valid_days: 0, terms: 5, junk: 1 }), { itemized: false, scope_note: "", valid_days: 30, inclusions: "", exclusions: "", terms: "" });
  const p = bidProposalFromDefaults({ inclusions: "Labor", exclusions: "Prep", terms: "Net 30", valid_days: 60, overhead_pct: 10 });
  assert.deepEqual(p, { itemized: false, scope_note: "", valid_days: 60, inclusions: "Labor", exclusions: "Prep", terms: "Net 30" });
  assert.equal(bidProposalFileName("Clinic: A"), "Clinic A - proposal.pdf");
  assert.equal(bidProposalFileName(""), "proposal.pdf");
});

test("PDF: letterhead, scope, base bid, terms, acceptance, and the watermark on every page", async () => {
  const m = buildBidProposal({
    est, conditions: conds, today, projectName: "Clinic", proposal: { itemized: true, inclusions: "Material and labor", exclusions: "Floor prep", terms: "Net 30" },
    company: { name: "Sample Flooring Co", address: "100 Example Ave\nAnytown, ST", phone: "555-0100", license: "LIC-000" }, clientInfo: { client_name: "Example GC", reference: "B-7" },
  });
  const { bytes, pages } = await buildBidProposalPdf(m);
  assert.equal(pages, 1);
  const [p1] = await pageTexts(bytes);
  for (const s of ["Sample Flooring Co", "PROPOSAL", "Example GC", "Clinic", "CPT-1", "LVT-1", "BASE BID", `$${est.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Floor prep", "Net 30", "License LIC-000", OT_NAME, OT_WATERMARK]) {
    assert.ok(p1.includes(hex(s)), `page 1 shows ${s}`);
  }
  assert.ok(p1.includes(hex("100 Example Ave")) && p1.includes(hex("Anytown, ST")) && !p1.includes(hex("Ave?Anytown")), "address keeps its line break");
});

test("PDF: a long scope flows onto more pages, each watermarked and numbered", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, finish_tag: `F-${i}`, pricing: { material: 1, labor: 1 } }));
  const e = priceEstimate({ rows: conditionTotals(many, many.map((c) => area(c.id, 10))), conditions: many, settings: null });
  const { bytes, pages } = await buildBidProposalPdf(buildBidProposal({ est: e, conditions: many, today, proposal: { terms: "x ".repeat(3000) } }));
  assert.ok(pages >= 3, `pages: ${pages}`);
  const texts = await pageTexts(bytes);
  texts.forEach((t, i) => {
    assert.ok(t.includes(hex(OT_WATERMARK)), `page ${i + 1} footer`);
    assert.ok(t.includes(hex(OT_NAME)), `page ${i + 1} diagonal`);
    assert.ok(t.includes(hex(`Page ${i + 1} of ${pages}`)), `page ${i + 1} number`);
  });
});

test("PDF: a broken logo never blocks the proposal", async () => {
  const m = buildBidProposal({ est, conditions: conds, today, company: { name: "X", logo: "data:image/png;base64,AAAA" } });
  const { pages } = await buildBidProposalPdf(m);
  assert.equal(pages, 1);
});

test("wrapText: wraps at the width and hard-splits an overlong word", async () => {
  const { PDFDocument: D, StandardFonts } = await import("pdf-lib");
  const font = await (await D.create()).embedFont(StandardFonts.Helvetica);
  const lines = wrapText("alpha beta gamma delta " + "x".repeat(200), font, 10, 100);
  assert.ok(lines.length > 3);
  assert.ok(lines.every((l) => font.widthOfTextAtSize(l, 10) <= 100));
  // line breaks survive (sanitizing before splitting used to print them as "?")
  assert.deepEqual(wrapText("100 Example Ave\nAnytown, ST", font, 10, 400), ["100 Example Ave", "Anytown, ST"]);
});

test("marked set: every page carries the watermark, in default and clear-label mode", async () => {
  const source = await PDFDocument.create(); source.addPage([300, 200]);
  const sourceBytes = await source.save();
  const conditions = [{ id: "c", finish_tag: "CPT-1", color: "#2563eb", multiplier: 1 }];
  const sh = [{ id: "s1", sheet_id: "sample.pdf", condition_id: "c", measure_role: "count", computed: { count: 1 }, verts_norm: [[0.3, 0.3]] }];
  for (const company of [null, { name: "Sample Co" }]) {
    const { bytes } = await buildMarkedSetPdf(<any>{
      projectName: "Field test", dark: false, sheets: [{ key: "sample.pdf", file: "sample.pdf", page: 1, label: "A-101" }], shapes: sh, markups: [], conditions,
      company, clientInfo: null, credit: company ? "Measured with OpenTakeoff" : null, coverTitle: company ? "Marked Set" : "OpenTakeoff · Marked Set",
      loadPdfData: async () => sourceBytes, getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 300 * scale, height: 200 * scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] }) }),
    });
    const texts = await pageTexts(bytes);
    assert.ok(texts.length >= 2);
    texts.forEach((t, i) => assert.ok(t.includes(hex(OT_WATERMARK)) && t.includes(hex(OT_NAME)), `${company ? "clear-label" : "default"} page ${i + 1}`));
  }
});
