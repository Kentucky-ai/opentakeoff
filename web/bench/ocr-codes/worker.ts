import React from "react";
import { createRoot } from "react-dom/client";
import ImportSchedulePanel from "../../src/components/ImportSchedulePanel.jsx";
import { readScheduleSpans } from "../../src/lib/scheduleRead";
import { type OcrWord } from "../../src/lib/ocr/types";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";
import truth from "../../test/fixtures/ocr-codes/truth.json";
import { getOcrClient } from "../../src/lib/ocr/client";
import { OCR_ENGINE_OPTIONS } from "../../src/lib/ocr/engineOptions";
import { scoreRows, summarize } from "./score";

const images = import.meta.glob("../../test/fixtures/ocr-codes/*.png", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const output = document.querySelector<HTMLPreElement>("#output")!;
let evidence = "";
const readsByFixture = new Map<string, OcrWord[]>();
const review = document.querySelector<HTMLButtonElement>("#review")!;
const fixtureSelect = document.querySelector<HTMLSelectElement>("#fixture")!;
const root = createRoot(document.querySelector("#dialog")!);
for (const fixture of truth.fixtures) { const option = document.createElement("option"); option.value = fixture.id; option.textContent = fixture.id; fixtureSelect.append(option); }
review.onclick = () => {
  const id = fixtureSelect.value;
  // The tiny recognition fixtures aren't full parser fixtures. For this
  // separate UI exercise, place their actual OCR codes in an invented table.
  // No expected code is substituted and no confidence/alternate is changed.
  const fixture = truth.fixtures.find((f) => f.id === id)!;
  const words = readsByFixture.get(id) || [];
  const span = (str: string, x: number, y: number) => ({ str, x, y, w: str.length * 8, h: 17 });
  const spans = [span("CODE", 100, 0), span("MATERIAL", 220, 0), span("MANUFACTURER", 520, 0), span("COLOR", 1000, 0)];
  fixture.rows.forEach((row, i) => {
    const y = (i + 1) * 38;
    const r = row.rect;
    let x = 100;
    for (const word of words.filter((w) => w.x + w.w / 2 >= r.x0 && w.x + w.w / 2 < r.x1 && w.y - w.h / 2 >= r.y0 && w.y - w.h / 2 < r.y1)) {
      spans.push({ ...span(word.str, x, y), ...(word.codeAlternate !== undefined ? { codeAlternate: word.codeAlternate } : {}) });
      x += word.str.length * 8 + 4;
    }
    spans.push(span("CERAMIC TILE", 220, y), span("VENDOR-A", 520, y), span("GREY", 1000, y));
  });
  const result = readScheduleSpans(spans, { ocr: true });
  output.dataset.schedule = JSON.stringify(result);
  root.render(React.createElement(ImportSchedulePanel, { key: id + performance.now(), rows: result.rows, existing: new Set<string>(), palette: ["#2563eb", "#2f7d54"], startIndex: 0,
    onClose: () => root.render(null), onCreate: (rows: { finish_tag: string }[]) => { output.dataset.created = JSON.stringify(rows); root.render(null); },
  }));
};
save.onclick = () => {
  const url = URL.createObjectURL(new Blob([evidence], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "ocr-code-worker.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
run.onclick = async () => {
  run.disabled = true; save.disabled = true; review.disabled = true;
  delete output.dataset.done; delete output.dataset.error;
  try {
    const verifyCodes = document.querySelector<HTMLInputElement>("#verify")!.checked;
    const client = getOcrClient();
    const ready = await client.ensureReady({ consent: true });
    if (!ready.ok) throw new Error(JSON.stringify(ready));
    const manifest = await fetch("/models/ocr/manifest.json").then((r) => r.json());
    const results = [];
    for (const fixture of truth.fixtures) {
      output.textContent = `Reading ${fixture.id}…`;
      const bytes = await fetch(images[`../../test/fixtures/ocr-codes/${fixture.file}`]).then((r) => r.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join("");
      if (hash !== fixture.sha256) throw new Error(`Changed fixture: ${fixture.file}`);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const { width, height } = canvas;
      const started = performance.now();
      const words = await client.recognize({ verifyCodes, rgba: ctx.getImageData(0, 0, width, height).data, width, height, geometry: { rect: { x0: 0, y0: 0, x1: width, y1: height }, zoom: 1 } });
      readsByFixture.set(fixture.id, words);
      const reads = words.map((w) => ({ text: w.str, confidence: w.confidence, ...(w.codeAlternate !== undefined ? { codeAlternate: w.codeAlternate } : {}), rect: { x0: w.x, y0: w.y - w.h, x1: w.x + w.w, y1: w.y } }));
      const rows = scoreRows(fixture.rows, reads);
      results.push({ id: fixture.id, sha256: fixture.sha256, control: fixture.control, ms: performance.now() - started, summary: summarize(rows), rows });
    }
    evidence = JSON.stringify({ backend: "production OCR worker / onnxruntime-web WASM", codeCheck: verifyCodes ? "horizontal-2x-disagreement-v1" : null, userAgent: navigator.userAgent, ppu: "6.6.0", modelRev: manifest.rev, engineOptions: OCR_ENGINE_OPTIONS, provenance: truth.provenance, summary: summarize(results.flatMap((r) => r.rows)), results }, null, 2);
    output.textContent = evidence; output.dataset.done = "true"; save.disabled = false; review.disabled = false;
  } catch (error) { output.textContent = String(error); output.dataset.error = "true"; }
  finally { run.disabled = false; }
};
