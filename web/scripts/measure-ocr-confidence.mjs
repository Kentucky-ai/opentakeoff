// Does the reader's confidence tell a misread finish code from a good one?
// (#482). Draws synthetic bordered finish schedules (30 codes, the key 2 pt
// from the cell's left rule, descriptions with " / "), at 100, 144 and 216
// DPI in three fonts, reads each with the real engine (ppu's Node build,
// OCR_ENGINE_OPTIONS, the staged models, as test/ocrEngineStrategy.test.ts
// does), and counts, for a few cut-offs, how many correct key reads and how
// many misread ones fall below it. It also lists the misreads. A read counts
// as correct when it keys the same as the drawn code once case and the
// characters the reader's key rule drops are set aside (sheetgraph rowKeyOf
// keeps A-Z, 0-9, "/" and "-"): "wC-01" and "G-01 (C)" import as the drawn
// code and count as correct; "PT−01" (a U+2212 minus) imports as "PT01".
//
//   node scripts/stage-ocr-model.mjs           # once
//   node --import tsx scripts/measure-ocr-confidence.mjs [out.json]
//
// Not a test: the numbers depend on the platform's ORT build and on how the
// OS resolves the font names. The browser runs ORT's wasm backend on pdf.js
// tiles, so this is the same engine and options, not the same pipeline. All
// text is made up; no plan data is read.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(web, "package.json"));
const { createCanvas } = require("@napi-rs/canvas");
const { PaddleOcrService } = await import("ppu-paddle-ocr");
const { OCR_ENGINE_OPTIONS } = await import("../src/lib/ocr/engineOptions.ts");

const PUBLIC = join(web, "public");
const manifest = JSON.parse(readFileSync(join(PUBLIC, "models/ocr/manifest.json"), "utf8"));
const modelFile = (name) => new Uint8Array(readFileSync(join(PUBLIC, manifest.files.find((f) => f.name === name).url.replace(/^\//, "")))).buffer;

const CODES = ["PT-01", "PT-02", "G-01(C)", "G-02", "FT-01(E)", "FT-02(E)", "SSM-1", "ST-1", "ST-2", "P-1", "P-2", "BK-1", "B1", "B2", "V2", "P2",
  "CPT-01", "LVT-03", "RB-01", "WD-10", "CT-04", "ACT-01", "SV-01", "TS-01", "Q-0", "EP-01", "RF-11", "GL-01", "WC-01", "CPT-10"];
const DESCS = ["VENDOR / LINE ALPHA / COLOR GREY", "CARPET / BROADLOOM / BLUE 202", "TILE W/ EPOXY GROUT / WHITE", "PAINT / EGGSHELL / TAUPE", "BASE / 4 IN / BLACK"];
const keyed = (s) => s.toUpperCase().replace(/[^A-Z0-9/-]/g, "");
const CUTOFFS = [0.8, 0.85, 0.9, 0.95];

const service = new PaddleOcrService({ model: { detection: modelFile("det"), recognition: modelFile("rec"), charactersDictionary: modelFile("dict") }, ...OCR_ENGINE_OPTIONS });
await service.initialize();

const good = [], bad = [], descs = [];
for (const dpi of [100, 144, 216]) for (const font of ["Arial", "Helvetica", "Courier New"]) {
  const s = dpi / 72, rowH = 0.28 * 72 * s, keyW = 72 * s, descW = 4 * 72 * s, x0 = 20;
  const W = Math.ceil(x0 + keyW + descW + 20), H = Math.ceil(rowH * CODES.length + 40);
  const c = createCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#000"; g.lineWidth = Math.max(1, s * 0.7);
  g.fillStyle = "#000"; g.font = `${Math.round(7 * s)}px "${font}"`; g.textBaseline = "middle";
  CODES.forEach((code, i) => {
    const y = 20 + i * rowH;
    g.strokeRect(x0, y, keyW, rowH); g.strokeRect(x0 + keyW, y, descW, rowH);
    g.fillText(code, x0 + 2 * s, y + rowH / 2);
    g.fillText(DESCS[i % DESCS.length], x0 + keyW + 4 * s, y + rowH / 2);
  });
  const png = c.toBuffer("image/png");
  // noCache, as the worker passes: ppu caches results by image bytes
  const res = await service.recognize(new Uint8Array(png).buffer, { flatten: false, noCache: true });
  for (const cell of (res.lines ?? []).flat()) {
    const str = (cell.text ?? "").trim();
    if (!str || !cell.box) continue;
    const read = { dpi, font, str, confidence: +cell.confidence.toFixed(3) };
    if (cell.box.x <= x0 + keyW) (CODES.some((k) => keyed(k) === keyed(str)) ? good : bad).push(read);
    else descs.push(read);
  }
}
await service.destroy();

console.log(`key reads: ${good.length + bad.length} (${good.length} correct, ${bad.length} misread)`);
for (const t of CUTOFFS) {
  console.log(`  below ${t}: ${good.filter((r) => r.confidence < t).length} correct, ${bad.filter((r) => r.confidence < t).length} of ${bad.length} misread`);
}
const range = (a) => a.length ? `${Math.min(...a.map((r) => r.confidence))}–${Math.max(...a.map((r) => r.confidence))}` : "none";
console.log(`  confidence, correct: ${range(good)}; misread: ${range(bad)}`);
console.log("misreads:", bad.map((r) => `${r.str} ${r.confidence} (${r.dpi} DPI ${r.font})`).join("; "));
const sevens = descs.filter((r) => /(^| )7( |$)/.test(r.str));
console.log(`descriptions with a lone 7: ${sevens.length}`, sevens.map((r) => `${r.str} (${r.dpi} DPI ${r.font})`).join("; "));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ CODES, DESCS, good, bad, descs }, null, 1));
