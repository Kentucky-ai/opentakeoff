// Fixed public images, expected code identities, and cell-anchored scoring.
// See bench/ocr-codes/README.md for native and production-worker reproduction.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { OCR_ENGINE_OPTIONS } from "../src/lib/ocr/engineOptions.ts";
import { cleanOcrText } from "../src/lib/ocr/wordClean.ts";
import { splitRecognizer } from "../src/lib/ocr/splitRecognize.ts";
import { scoreRows, summarize } from "../bench/ocr-codes/score.ts";

const fixtures = new URL("../test/fixtures/ocr-codes/", import.meta.url);
const { provenance, fixtures: truth } = JSON.parse(readFileSync(new URL("truth.json", fixtures), "utf8"));
const assets = new URL("../public/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("models/ocr/manifest.json", assets), "utf8"));
const modelFile = (name) => new Uint8Array(readFileSync(new URL(manifest.files.find((f) => f.name === name).url.replace(/^\//, ""), assets))).buffer;
const service = new PaddleOcrService({ model: { detection: modelFile("det"), recognition: modelFile("rec"), charactersDictionary: modelFile("dict") }, ...OCR_ENGINE_OPTIONS });
const results = [];
const checkCodes = process.argv.includes("--check-codes");
try {
  await service.initialize();
  for (const fixture of truth) {
    const png = readFileSync(new URL(fixture.file, fixtures));
    if (createHash("sha256").update(png).digest("hex") !== fixture.sha256) throw new Error(`Changed fixture: ${fixture.file}`);
    const started = performance.now();
    // Use ppu's own canvas platform. Mixing separate native canvas installs
    // can crash when their C++ objects are passed across the package boundary.
    const result = checkCodes ? await splitRecognizer(service, (source, box) => {
      const crop = service.recognitor.platform.createCanvas(Math.max(1, Math.ceil(box.width * 2)), Math.max(1, Math.ceil(box.height)));
      crop.getContext("2d").drawImage(source, box.x, box.y, box.width, box.height, 0, 0, crop.width, crop.height);
      return crop;
    }).recognize(await service.recognitor.platform.canvas.prepareCanvas(new Uint8Array(png).buffer), { flatten: false, noCache: true, verifyCodes: true })
      : await service.recognize(new Uint8Array(png).buffer, { flatten: false, noCache: true });
    const reads = (result.lines ?? []).flat().filter((c) => c.box).map((c) => ({
      text: cleanOcrText(c.text ?? ""), confidence: c.confidence, ...(c.codeAlternate !== undefined ? { codeAlternate: c.codeAlternate } : {}),
      rect: { x0: c.box.x, y0: c.box.y, x1: c.box.x + c.box.width, y1: c.box.y + c.box.height },
    }));
    const rows = scoreRows(fixture.rows, reads);
    results.push({ id: fixture.id, sha256: fixture.sha256, control: fixture.control, ms: performance.now() - started, summary: summarize(rows), rows });
  }
} finally { await service.destroy(); }
const report = {
  backend: "ppu Node / onnxruntime-node", platform: `${process.platform}-${process.arch}`, node: process.version,
  codeCheck: checkCodes ? "horizontal-2x-disagreement-v1" : null, ppu: "6.6.0", modelRev: manifest.rev, engineOptions: OCR_ENGINE_OPTIONS, provenance,
  summary: summarize(results.flatMap((r) => r.rows)), results,
};
const output = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.summary, null, 2));
for (const r of results) for (const row of r.rows.filter((x) => !x.ok)) console.log(`${r.id}: ${row.expected} -> ${row.actual || "<missing>"} (${row.confidence ?? "multiple/no boxes"})`);
// Opt-in acceptance gate for a future OCR fix. Known failures are evidence,
// never asserted as desirable outputs; an improvement can only help this gate.
if (process.argv.includes("--require-flagged") && (report.summary.unflaggedWrong || report.results.some((r) => r.control && r.summary.flaggedCorrect))) process.exitCode = 1;
if (process.argv.includes("--strict") && report.summary.exact !== report.summary.total) process.exitCode = 1;
