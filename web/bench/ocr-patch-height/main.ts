// The browser side of #488, part 1: the shipped OCR worker (wasm), a pdf.js
// render through rasterizeRegion, and the same packing and scoring as the
// native sweep. scripts/verify-ocr-patch-height.mjs drives window.measurePack.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { getOcrClient } from "../../src/lib/ocr/client";
import { rasterizeRegion } from "../../src/lib/ocr/rasterize";
import { assignLines, joinPatches, planTiles } from "../../src/lib/ocr/seams";
import type { OcrWord } from "../../src/lib/ocr/types";
import { acrossOf, alongOf, bandRecall, packed, runsOf } from "./pack";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const RS = 2;

interface PackSpec { url: string; pageNo: number; caps: number[]; tileWords?: OcrWord[][] }

async function measurePack({ url, pageNo, caps, tileWords }: PackSpec) {
  const client = getOcrClient();
  const ready = await client.ensureReady({ consent: true });
  if (!ready.ok) throw new Error(`engine not ready: ${JSON.stringify(ready)}`);
  const doc = await pdfjs.getDocument({ url }).promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: RS });
  const plan = planTiles({ x0: 0, y0: 0, x1: vp.width, y1: vp.height }, RS);
  const items = (await page.getTextContent()).items as Parameters<typeof runsOf>[0];
  const runs = runsOf(items, RS, vp.transform, pdfjs.Util.transform as (a: number[], b: number[]) => number[]);
  const read = async (rect: { x0: number; y0: number; x1: number; y1: number }) => {
    const raster = await rasterizeRegion(page as never, RS, rect, { dpi: plan.dpi });
    const t0 = performance.now();
    const words = await client.recognize(raster);
    return { words, ms: performance.now() - t0, width: raster.width, height: raster.height };
  };
  const tiles: OcrWord[][] = [];
  let tileMs = 0;
  if (tileWords) tiles.push(...tileWords);
  else for (const t of plan.tiles) { const r = await read(t.render); tiles.push(r.words); tileMs += r.ms; }
  const a = assignLines(plan, tiles);
  const seen = new Map<string, { words: OcrWord[]; ms: number }>();
  const arms = [];
  for (const cap of [0, ...caps]) {
    const p2 = cap ? packed(a, cap) : a;
    const reads: OcrWord[][] = [];
    let ms = 0;
    for (const p of p2.patches) {
      const k = JSON.stringify(p.render);
      if (!seen.has(k)) seen.set(k, await read(p.render));
      reads.push(seen.get(k)!.words);
      ms += seen.get(k)!.ms;
    }
    const lines = joinPatches(p2, reads);
    const rec = bandRecall(a, lines, runs);
    arms.push({
      cap: cap || "main", patches: p2.patches.length,
      heights: p2.patches.map((p) => { const [c0, c1] = acrossOf(p.axis, p.render); return Math.round((c1 - c0) * plan.zoom); }),
      lengths: p2.patches.map((p) => { const [a0, a1] = alongOf(p.axis, p.render); return Math.round((a1 - a0) * plan.zoom); }),
      lines: lines.length, clipped: lines.filter((l) => l.clipped).length,
      recall: `${rec.read}/${rec.wanted}`, ms: Math.round(ms), missed: rec.missed,
    });
  }
  await doc.destroy();
  return { tiles: plan.tiles.length, tileMs: Math.round(tileMs), arms };
}

(window as unknown as { measurePack: typeof measurePack }).measurePack = measurePack;
document.body.dataset.ready = "1";
