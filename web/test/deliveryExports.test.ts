import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildMarkedSetPdf } from "../src/lib/markedset.js";
import { buildBidProposal } from "../src/lib/bidProposal.js";
import { buildBidProposalPdf } from "../src/lib/bidProposalPdf.js";
import { estimateWorkbook } from "../src/lib/estimateExport.js";
import { setLanguage, localizeText } from "../src/lib/i18n/core.js";

const fonts = {
  fontBytes: readFileSync(new URL("../public/fonts/NotoSans-Regular.ttf", import.meta.url)),
  boldBytes: readFileSync(new URL("../public/fonts/NotoSans-Bold.ttf", import.meta.url)),
};
async function texts(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      pages.push(tc.items.flatMap(item => "str" in item ? [item.str] : []).join(" "));
    }
    return pages;
  } finally { await doc.destroy(); }
}

for (const rotation of [0, 90]) test(`Russian marked PDF preserves Cyrillic data and notes at ${rotation} degrees`, async () => {
  const source = await PDFDocument.create();
  source.addPage([300, 200]).setRotation(degrees(rotation));
  const sourceBytes = await source.save();
  const { bytes, filename } = await buildMarkedSetPdf({
    ...fonts, language: "ru", units: "metric", projectName: "Ремонт школы", dark: false,
    sheets: [{ key: "plan", file: "plan", page: 1, label: "План этажа" }],
    shapes: [{ id: "s", sheet_id: "plan", condition_id: "c", measure_role: "floor_area", verts_norm: [[.1,.1],[.4,.1],[.4,.4]], computed: { area_sf: 100, perimeter_lf: 40 } }],
    conditions: [{ id: "c", finish_tag: "Пол-1", color: "#2563eb", waste_pct: 5 }],
    markups: [{ id: "note", sheet_id: "plan", type: "text", at: [.1,.5], text: "Проверить отметку пола" }],
    company: { name: "Solid", address: "Москва" }, clientInfo: { client_name: "Work" },
    rfis: [{id:"rfi",number:"RFI-001",status:"open",subject:"Отметка пола",question:"Уточнить высоту",response:"Проверить по разрезу",to:"Проектировщик"}] as any,
    loadPdfData: async () => sourceBytes,
    getPage: async () => ({ rotate: rotation, getViewport: ({ scale }: {scale: number}) => rotation === 90
      ? { width: 200*scale, height: 300*scale, transform: [0,scale,scale,0,0,0] }
      : { width: 300*scale, height: 200*scale, transform: [scale,0,0,-scale,0,200*scale] } }),
  });
  const pages = await texts(bytes);
  assert.equal(pages.length, 3);
  for (const expected of ["Ремонт школы", "ВИДЫ РАБОТ", "ПО ЛИСТАМ", "Пол-1", "м²", "Solid", "Work"]) assert.ok(pages[0].includes(expected), expected);
  for (const expected of ["ЖУРНАЛ ЗАПРОСОВ", "Отметка пола", "Открыт", "Вопрос:", "Ответ:", "Проектировщик"]) assert.ok(pages[1].includes(expected), expected);
  assert.ok(pages[2].includes("Проверить отметку пола"), pages[2]);
  assert.ok(pages[2].includes("План этажа"));
  assert.ok(filename.includes("чертежи с измерениями"));
  assert.ok(!pages.join(" ").includes("????"));
});

test("Russian estimate keeps customer project/company/client values even when they match UI labels", () => {
  const est = { lines: [], settings: { tax_pct:0, overhead_pct:0, profit_pct:0, profit_mode:"markup" }, material:0, labor:0, tax:0, cost:0, overhead:0, profit:0, total:0, complete:true, warnings:[] } as any;
  const sheets = estimateWorkbook({ est, projectName:"Report", companyName:"Solid", clientName:"Work", date:"2026-11-03", localize: value => localizeText(value, "ru"), language:"ru" });
  assert.equal(sheets[0].name, "Смета");
  assert.deepEqual(sheets[0].rows.slice(0,4).map(row=>row[1]), ["Report", "Solid", "Work", "2026-11-03"]);
});

test("marked PDF paginates a large legend instead of silently dropping the last conditions", async () => {
  const source = await PDFDocument.create(); source.addPage([300,200]);
  const sourceBytes = await source.save();
  const conditions = Array.from({length:70}, (_,i)=>({id:`c${i}`,finish_tag:`FIN-${String(i).padStart(3,"0")}`,color:"#2563eb"}));
  const shapes = conditions.map(c=>({id:c.id,sheet_id:"plan",condition_id:c.id,measure_role:"count",verts_norm:[[.2,.2]],computed:{count:1}}));
  const {bytes} = await buildMarkedSetPdf({
    language:"en",projectName:"Large legend",dark:false,conditions,shapes,markups:[],
    coverTitle:"A long custom cover title ".repeat(6),company:{name:"Solid"},clientInfo:null,
    sheets:[{key:"plan",file:"plan",page:1,label:"A101"}],loadPdfData:async()=>sourceBytes,
    getPage:async()=>({rotate:0,getViewport:({scale}:{scale:number})=>({width:300*scale,height:200*scale,transform:[scale,0,0,-scale,0,200*scale]})}),
  });
  const pages = await texts(bytes);
  assert.ok(pages.length>2);
  const legend = pages.slice(0,-1).join(" ");
  for (const c of conditions) assert.ok(legend.split(c.finish_tag).length>=3, `${c.finish_tag}: both totals and by-sheet rows must be present`);
  assert.ok(legend.includes("Solid"));
});

test("Russian proposal translates labels, preserves customer text and numbers pages in Russian", async () => {
  setLanguage("ru");
  try {
    const est = { lines:[{id:"c",finish_tag:"CPT-1",labor_qty:100,unit:"SF",total:500}],total:500,complete:true,unpriced:[] };
    const model = buildBidProposal({ est, company:{name:"Solid",address:"Materials"}, clientInfo:{client_name:"Work"}, projectName:"Report", conditions:[], locale:"ru-RU",
      proposal:{itemized:true,valid_days:30,scope_note:"Solid",terms:"Work",inclusions:Array(65).fill("Report").join("\n")} });
    const {bytes,pages} = await buildBidProposalPdf(model,fonts);
    assert.ok(pages>1);
    const content = await texts(bytes);
    assert.ok(content[0].includes("Коммерческое предложение"));
    for (const text of ["Solid","Materials","Work","Report"]) assert.ok(content.join(" ").includes(text),text);
    content.forEach((text,i)=>assert.ok(text.includes(`Страница ${i+1} из ${pages}`)));
    assert.ok(!content.join(" ").includes("Page "));
  } finally { setLanguage("en"); }
});
