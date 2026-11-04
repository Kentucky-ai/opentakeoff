// The estimate and the proposal are ALWAYS watermarked: every Excel tab (its
// last row and its printed page footer) and every proposal PDF page carry the
// OpenTakeoff line, in every branding mode, and no argument turns it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import { conditionTotals } from "../src/lib/totals.js";
import { priceEstimate } from "../src/lib/estimate.js";
import { estimateWorkbook, stampWorkbook } from "../src/lib/estimateExport.js";
import { buildXlsx, sheetXml, escXml } from "../src/lib/xlsx.js";
import { buildBidProposal } from "../src/lib/bidProposal.js";
import { buildBidProposalPdf } from "../src/lib/bidProposalPdf.js";
import { OT_NAME, OT_WATERMARK, resolveBranding } from "../src/lib/branding.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const lin = (id: string, lf: number) => ({ condition_id: id, measure_role: "linear", computed: { perimeter_lf: lf } });
const conds = [{ id: "a", finish_tag: "CPT-1", pricing: { unit: "SY", material: 20 }, materials: [{ id: "m", name: "Adhesive", per: 250, basis: "area", unit: "gal" }] }];
const est = priceEstimate({ rows: conditionTotals(conds, [area("a", 900), lin("a", 40)]), conditions: conds, settings: null });
const priced = priceEstimate({ rows: conditionTotals([{ id: "b", finish_tag: "LVT-1", pricing: { material: 1, labor: 1 } }], [area("b", 10)]), conditions: [{ id: "b", finish_tag: "LVT-1", pricing: { material: 1, labor: 1 } }], settings: null });
const FOOTER = `<oddFooter>${escXml(`&C${OT_WATERMARK}`)}</oddFooter>`;

const BRANDINGS = [
  resolveBranding({ mode: "default" }),
  resolveBranding({ mode: "clearlabel", profileId: "p1", profiles: [{ id: "p1", name: "Sample Flooring Co", address: "100 Example Ave" }] }),
];

test("every Excel tab ends with the watermark and prints it as the page footer, in every branding mode", () => {
  assert.equal(BRANDINGS[1].clear, true);
  for (const e of [est, priced]) {
    for (const b of BRANDINGS) {
      // stray "turn it off" arguments are not part of the signature and change nothing
      const sheets = estimateWorkbook(<any>{ est: e, projectName: "Clinic", companyName: b.brandName, watermark: false, branding: b, clear: true });
      assert.ok(sheets.length >= 2);
      for (const s of sheets) {
        assert.deepEqual(s.rows[s.rows.length - 1], [OT_WATERMARK], `${s.name} last row`);
        assert.equal(s.footer, OT_WATERMARK, `${s.name} footer`);
      }
    }
  }
  assert.deepEqual(estimateWorkbook({ est }).map((s) => s.name), ["Estimate", "Materials", "Unpriced"]);
});

test("stampWorkbook adds the line where it is missing and never doubles it", () => {
  const once = stampWorkbook([{ name: "X", rows: [["a"]] }, { name: "Y", rows: [["b"], [], [OT_WATERMARK]] }]);
  assert.deepEqual(once.map((s) => s.rows), [[["a"], [], [OT_WATERMARK]], [["b"], [], [OT_WATERMARK]]]);
  assert.deepEqual(stampWorkbook(once), once);
});

test("the .xlsx file itself: every worksheet carries the watermark cell and the print footer", async () => {
  const bytes = await buildXlsx(estimateWorkbook({ est, companyName: "Sample Flooring Co" }));
  const files = unzipSync(bytes);
  const sheets = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  assert.equal(sheets.length, 3);
  for (const k of sheets) {
    const xml = strFromU8(files[k]);
    assert.ok(xml.includes(`<t>${escXml(OT_WATERMARK)}</t>`), `${k} cell`);
    assert.ok(xml.includes(FOOTER), `${k} footer`);
    assert.ok(xml.indexOf("</sheetData>") < xml.indexOf("<headerFooter>"), `${k} element order`);
  }
  // a sheet built without a footer (the takeoff report workbook) is unchanged
  assert.equal(sheetXml([["a"]]).includes("headerFooter"), false);
  assert.ok(sheetXml([["a"]], { footer: "A & B" }).includes(escXml("&CA && B")));
});

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

test("every proposal PDF page carries the diagonal and the footer line, in every branding mode, whatever the model says", async () => {
  for (const b of BRANDINGS) {
    const model = buildBidProposal({ est, conditions: conds, company: b.company || {}, projectName: "Clinic", proposal: { itemized: true, terms: "Net 30. ".repeat(400) }, today: new Date(2026, 10, 3) });
    // a model edited to ask for no watermark still gets one
    const { bytes, pages } = await buildBidProposalPdf(<any>{ ...model, watermark: false, branding: b, clear: b.clear });
    assert.ok(pages >= 2, `pages ${pages}`);
    const texts = await pageTexts(bytes);
    texts.forEach((t, i) => {
      assert.ok(t.includes(hex(OT_WATERMARK)), `${b.clear ? "clear-label" : "default"} page ${i + 1} footer`);
      assert.ok(t.includes(hex(OT_NAME)), `${b.clear ? "clear-label" : "default"} page ${i + 1} diagonal`);
    });
    if (b.clear) assert.ok(texts[0].includes(hex("Sample Flooring Co")), "clear-label names the firm and keeps the watermark");
  }
});
