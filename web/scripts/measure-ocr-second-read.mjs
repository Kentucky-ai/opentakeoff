// #519 measure-first: give every row the on-device code check flagged a
// blind second read, as a tight crop and as its whole schedule row, and
// score what the decision rule would do (bench/ocr-codes/README.md).
//
// The primary reads come from a recorded checked run (default: the native
// one), so a second reader is compared against pinned flags. The default
// reader is free: the same on-device engine, on a crop scaled 2x in both
// directions (the code check stretches 2x horizontally only). A provider
// reader sends crops to an endpoint you name, and only with --allow-network.
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { OCR_ENGINE_OPTIONS } from "../src/lib/ocr/engineOptions.ts";
import { cleanOcrText } from "../src/lib/ocr/wordClean.ts";
import { scoreSecondRead, formatSecondReadTable } from "../bench/ocr-codes/score.ts";
import { providerSecondReader } from "../bench/ocr-codes/secondRead.ts";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const primaryPath = arg("primary", fileURLToPath(new URL("../bench/ocr-codes/checked-native.json", import.meta.url)));
const readerName = arg("reader", "ondevice");
const units = arg("units", "crop,row").split(",");
const output = process.argv.slice(2).find((a) => !a.startsWith("--"));

const fixtures = new URL("../test/fixtures/ocr-codes/", import.meta.url);
const { fixtures: truth } = JSON.parse(readFileSync(new URL("truth.json", fixtures), "utf8"));
const primary = JSON.parse(readFileSync(primaryPath, "utf8"));
const assets = new URL("../public/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("models/ocr/manifest.json", assets), "utf8"));
const modelFile = (name) => new Uint8Array(readFileSync(new URL(manifest.files.find((f) => f.name === name).url.replace(/^\//, ""), assets))).buffer;
const service = new PaddleOcrService({ model: { detection: modelFile("det"), recognition: modelFile("rec"), charactersDictionary: modelFile("dict") }, ...OCR_ENGINE_OPTIONS });

const flaggedRow = (r) => r.cells.some((c) => c.codeAlternate !== undefined);
const union = (cells) => cells.reduce((u, { rect }) => ({
  x0: Math.min(u.x0, rect.x0), y0: Math.min(u.y0, rect.y0), x1: Math.max(u.x1, rect.x1), y1: Math.max(u.y1, rect.y1),
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

// The free stand-in: the shipped detector and recognizer on a 2x-scaled crop.
// Either unit is detected the same way and the boxes whose centre falls inside
// the flagged cell are read, left to right, so the units differ only in how
// much of the row the engine sees.
function onDeviceReader() {
  const { detector, recognitor, options } = service;
  const dict = options.recognition?.charactersDictionary;
  return async (png, _unit, hint) => {
    const src = await recognitor.platform.canvas.prepareCanvas(new Uint8Array(png).buffer);
    const scaled = recognitor.platform.createCanvas(src.width * 2, src.height * 2);
    scaled.getContext("2d").drawImage(src, 0, 0, scaled.width, scaled.height);
    const lo = scaled.width * hint.leftPct / 100, hi = scaled.width * hint.rightPct / 100;
    const boxes = (await detector.run(scaled)).filter((b) => b.x + b.width / 2 >= lo && b.x + b.width / 2 < hi);
    if (!boxes.length) return null;
    const reads = await recognitor.run(scaled, boxes, dict, "per-box", {});
    const text = reads.filter((r) => r.box).sort((a, b) => a.box.x - b.box.x).map((r) => cleanOcrText(r.text ?? "").trim()).join(" ").trim();
    return text || null;
  };
}

function providerReader() {
  const cfg = {
    endpoint: process.env.OT_SECOND_READ_ENDPOINT ?? "", model: process.env.OT_SECOND_READ_MODEL ?? "",
    provider: process.env.OT_SECOND_READ_PROVIDER || "openai", apiKey: process.env.OT_SECOND_READ_KEY ?? "",
  };
  if (!cfg.endpoint || !cfg.model) throw new Error("set OT_SECOND_READ_ENDPOINT and OT_SECOND_READ_MODEL");
  if (!process.argv.includes("--allow-network")) throw new Error("a provider reader sends crops off this machine: pass --allow-network");
  return { cfg, read: providerSecondReader(cfg, fetch) };
}

const results = [];
const perRow = [];
try {
  await service.initialize();
  let read;
  if (readerName === "provider") {
    const p = providerReader();
    const n = primary.results.reduce((s, r) => s + r.rows.filter(flaggedRow).length, 0);
    console.error(`Sending ${n} crops per unit (${units.join(", ")}) to ${p.cfg.endpoint}, model ${p.cfg.model}.`);
    read = p.read;
  } else if (readerName === "ondevice") read = onDeviceReader();
  else throw new Error(`unknown --reader=${readerName}`);

  const allRows = [];
  const seconds = Object.fromEntries(units.map((u) => [u, []]));
  for (const fixture of truth) {
    const recorded = primary.results.find((r) => r.id === fixture.id);
    if (!recorded || recorded.sha256 !== fixture.sha256) throw new Error(`primary run doesn't match fixture ${fixture.id}`);
    const page = await service.recognitor.platform.canvas.prepareCanvas(new Uint8Array(readFileSync(new URL(fixture.file, fixtures))).buffer);
    for (const [i, row] of recorded.rows.entries()) {
      allRows.push(row);
      const entry = { id: fixture.id, expected: row.expected, primary: row.actual, alternates: row.cells.map((c) => c.codeAlternate ?? null), flagged: flaggedRow(row), second: {} };
      perRow.push(entry);
      for (const unit of units) {
        if (!entry.flagged) { seconds[unit].push(undefined); continue; }
        const cell = union(row.cells), t = fixture.rows[i].rect, pad = 4;
        const r = unit === "row"
          ? { x0: 0, y0: t.y0, x1: fixture.width, y1: t.y1 }
          : { x0: Math.max(0, cell.x0 - pad), y0: Math.max(0, cell.y0 - pad), x1: Math.min(fixture.width, cell.x1 + pad), y1: Math.min(fixture.height, cell.y1 + pad) };
        const crop = service.recognitor.platform.createCanvas(Math.ceil(r.x1 - r.x0), Math.ceil(r.y1 - r.y0));
        crop.getContext("2d").drawImage(page, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0, 0, crop.width, crop.height);
        const hint = { leftPct: (cell.x0 - r.x0) / (r.x1 - r.x0) * 100, rightPct: (cell.x1 - r.x0) / (r.x1 - r.x0) * 100 };
        const text = await read(new Uint8Array(crop.toBuffer("image/png")), unit, hint);
        seconds[unit].push(text);
        entry.second[unit] = text;
      }
    }
  }
  for (const unit of units) results.push(scoreSecondRead(allRows, seconds[unit], unit));
} finally { await service.destroy(); }

const report = {
  issue: "#519 measure-first", reader: readerName === "ondevice" ? "on-device stand-in: shipped detector + recognizer, crop scaled 2x both ways" : `provider: ${process.env.OT_SECOND_READ_MODEL}`,
  primary: `web/${relative(fileURLToPath(new URL("..", import.meta.url)), resolve(primaryPath))}`, modelRev: manifest.rev, platform: `${process.platform}-${process.arch}`, node: process.version,
  results, rows: perRow,
};
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
for (const kind of ["all", "empty", "alternate"]) console.log(formatSecondReadTable(results, kind) + "\n");
for (const r of perRow.filter((x) => x.flagged)) console.log(`${r.id}: ${r.expected} primary ${r.primary} alt ${JSON.stringify(r.alternates)} → ${units.map((u) => `${u} ${JSON.stringify(r.second[u])}`).join(", ")}`);
