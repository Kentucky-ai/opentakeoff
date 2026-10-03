import truth from "../../test/fixtures/ocr-codes/truth.json";
import { getOcrClient } from "../../src/lib/ocr/client";
import { OCR_ENGINE_OPTIONS } from "../../src/lib/ocr/engineOptions";
import { scoreRows, summarize } from "./score";

const images = import.meta.glob("../../test/fixtures/ocr-codes/*.png", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const output = document.querySelector<HTMLPreElement>("#output")!;
let evidence = "";
save.onclick = () => {
  const url = URL.createObjectURL(new Blob([evidence], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "ocr-code-worker.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
run.onclick = async () => {
  run.disabled = true; save.disabled = true;
  try {
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
      const words = await client.recognize({ rgba: ctx.getImageData(0, 0, width, height).data, width, height, geometry: { rect: { x0: 0, y0: 0, x1: width, y1: height }, zoom: 1 } });
      const reads = words.map((w) => ({ text: w.str, confidence: w.confidence, rect: { x0: w.x, y0: w.y - w.h, x1: w.x + w.w, y1: w.y } }));
      const rows = scoreRows(fixture.rows, reads);
      results.push({ id: fixture.id, sha256: fixture.sha256, control: fixture.control, summary: summarize(rows), rows });
    }
    evidence = JSON.stringify({ backend: "production OCR worker / onnxruntime-web WASM", userAgent: navigator.userAgent, ppu: "6.6.0", modelRev: manifest.rev, engineOptions: OCR_ENGINE_OPTIONS, provenance: truth.provenance, summary: summarize(results.flatMap((r) => r.rows)), results }, null, 2);
    output.textContent = evidence; output.dataset.done = "true"; save.disabled = false;
  } catch (error) { output.textContent = String(error); output.dataset.error = "true"; }
  finally { run.disabled = false; }
};
