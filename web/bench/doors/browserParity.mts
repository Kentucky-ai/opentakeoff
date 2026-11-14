// A browser run of "Find more doors" against the Python runner on the same sheet.
//   node --import tsx bench/doors/browserParity.mts <found.json> <sheet>.fx.json <sheet>.ref.json
// found.json: JSON.stringify(window.__otDoorFound) from a dev build after the pass (one sheet, or pick with --key).
// The fx / ref pair comes from the lab-side Python reference run (see detectParity.mts); fx.det are the boxes the
// published runner logic gives on a MuPDF render, ref.final the prototype's openings.
// The two renders differ (pdf.js here, MuPDF there), so boxes and scores are close, not identical: this prints how close.
import { readFileSync } from "node:fs";
const [foundPath, fxPath, refPath] = process.argv.slice(2);
const key = process.argv.includes("--key") ? process.argv[process.argv.indexOf("--key") + 1] : null;
const all = JSON.parse(readFileSync(foundPath, "utf8"));
const v = (key ? all[key] : Object.values(all)[0]) as { ppf: number; det: number[][]; preds: Array<{ p1: number[]; p2: number[]; src: string }>; tiles: number; seconds: Record<string, number> };
const fx = JSON.parse(readFileSync(fxPath, "utf8")), ref = JSON.parse(readFileSync(refPath, "utf8"));
const iou = (a: number[], b: number[]) => { const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i); };
console.log(`scale: browser ${v.ppf.toFixed(3)} pt/ft, Python ${fx.ppf}; tiles ${v.tiles}; seconds ${JSON.stringify(v.seconds)}`);
for (const thr of [0.2, 0.45, 0.7]) {
  const A = v.det.filter((b) => b[4] >= thr), B = (fx.det as number[][]).filter((b) => b[4] >= thr), used = new Set<number>();
  let ok = 0, gap = 0;
  for (const a of A) { const j = B.findIndex((b, k) => !used.has(k) && b[5] === a[5] && iou(a, b) >= 0.5); if (j >= 0) { used.add(j); ok++; gap = Math.max(gap, Math.abs(a[4] - B[j][4])); } }
  console.log(`detector boxes at score >= ${thr}: browser ${A.length}, Python ${B.length}, same box and class ${ok}, largest score gap ${gap.toFixed(3)}`);
}
const tol = 1.5, used = new Set<number>();
let ok = 0;
for (const p of v.preds) {
  const j = (ref.final as typeof v.preds).findIndex((q, k) => !used.has(k) && q.src === p.src && [0, 1].every((i) => Math.abs(p.p1[i] - q.p1[i]) <= tol && Math.abs(p.p2[i] - q.p2[i]) <= tol));
  if (j >= 0) { used.add(j); ok++; }
}
console.log(`openings: browser ${v.preds.length}, Python ${ref.final.length}, same line within ${tol} pt ${ok}`);
