// One sheet through the door reader, as its own process (a dense plan's
// operator list is large; one PDF per process keeps memory bounded).
//   node --import tsx bench/doors/page.mts <pdf> <page index, 0-based> [fpp]
// Prints one JSON line: boxes [x0, y0, x1, y1] in unrotated page points (y down), scale used, and seconds by stage.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as pdfjs from "pdfjs-dist";
import { extractDoorVectors } from "../../src/lib/doorVectors.ts";
import { loadDoorReader, readDoorsSync } from "../../src/lib/doorReader.ts";
import type { OpsTable } from "../../src/lib/oneclick.ts";

const [pdfPath, pageArg, fppArg] = process.argv.slice(2);
const req = createRequire(import.meta.url);
const root = path.dirname(req.resolve("pdfjs-dist/package.json"));
await loadDoorReader();
const doc = await pdfjs.getDocument({
  data: new Uint8Array(await readFile(pdfPath)), verbosity: 0, isEvalSupported: false,
  standardFontDataUrl: path.join(root, "standard_fonts") + path.sep, cMapUrl: path.join(root, "cmaps") + path.sep, cMapPacked: true,
}).promise;
const t0 = performance.now();
const page = await doc.getPage(Number(pageArg) + 1);
const ops = await page.getOperatorList();
const t1 = performance.now();
const vp = page.getViewport({ scale: 1, rotation: 0 });
const v = extractDoorVectors(ops as never, vp.transform, pdfjs.OPS as unknown as OpsTable);
const t2 = performance.now();
const got = readDoorsSync(v, fppArg ? Number(fppArg) : null);
const t3 = performance.now();
console.log(JSON.stringify({
  boxes: got.doors.map((d) => d.box.map((x) => Math.round(x * 100) / 100)),
  feats: got.doors.map((d) => ({ conf: d.confidence, doubts: d.doubts, pair: d.pair, stall: d.stall, dashed: d.dashed, leaves: d.leaves.map((l) => ({
    rFt: got.fpp ? Math.round(l.radiusPt * got.fpp * 100) / 100 : null, drawn: l.drawn, sweep: Math.round(l.sweepDeg), misfitR: Math.round((l.misfitPt / l.radiusPt) * 1e4) / 1e4,
    jamb: l.jambFt === null ? null : Math.round(l.jambFt * 100) / 100, strike: l.strike, leaf: l.leaf })) })),
  pairs: got.doors.filter((d) => d.pair).length, stalls: got.doors.filter((d) => d.stall).length,
  fpp: got.fpp, scale: got.scaleSource, arcs: got.arcs, items: v.nItems, paths: v.nPaths,
  s: { parse: (t1 - t0) / 1000, extract: (t2 - t1) / 1000, read: (t3 - t2) / 1000, total: (t3 - t0) / 1000 },
}));
await doc.destroy();
