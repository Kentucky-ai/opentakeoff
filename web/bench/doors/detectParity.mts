// Parity of the TypeScript door-detector pipeline (src/lib/doorDetect) with
// the Python prototype its cutoffs were chosen with, on identical inputs.
//   node --import tsx bench/doors/detectParity.mts <fixture dir> [--tol 0.05] [--verbose] [--shipped]
// A fixture is a pair of files written by the lab-side Python reference run:
//   <sheet>.fx.json   the inputs: reader doors, detector boxes, the page's ink
//                     masks (bit-packed), swing-box clips, text lines, linework
//   <sheet>.ref.json  the Python stage outputs: fused, swing, stage4, final
// For every sheet it prints, per stage, how many predictions match in order
// and position (both ends within tol page points), and the first mismatches.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runDoorPipeline, DOOR_DETECT_SETTINGS, type DetectPage } from "../../src/lib/doorDetect/pipeline.ts";
import { fitSwing } from "../../src/lib/doorDetect/swingfit.ts";
import type { DetBox, Mask, Pred, Pt } from "../../src/lib/doorDetect/geom.ts";
import type { FuseDoor } from "../../src/lib/doorDetect/fuse.ts";

const args = process.argv.slice(2);
const dir = args[0];
const tol = Number(args.includes("--tol") ? args[args.indexOf("--tol") + 1] : 0.05);
const verbose = args.includes("--verbose");
// the prototype has no repeat-number rule for lone tags: parity is checked with it off unless --shipped is given
const SETTINGS = args.includes("--shipped") ? DOOR_DETECT_SETTINGS : { ...DOOR_DETECT_SETTINGS, tags: { ...DOOR_DETECT_SETTINGS.tags, orphan_skip_repeats: false } };

interface Packed { h: number; w: number; bits: string; z: number; ox?: number; oy?: number }
function unpack(p: Packed): Mask {
  const raw = Buffer.from(p.bits, "base64"), data = new Uint8Array(p.w * p.h);
  for (let i = 0; i < data.length; i++) data[i] = (raw[i >> 3] >> (7 - (i & 7))) & 1;
  return { w: p.w, h: p.h, z: p.z, data };
}
type RefPred = { p1: Pt; p2: Pt; src: string; how?: string; cls?: number };
const same = (a: { p1: Pt; p2: Pt; src: string }, b: RefPred) =>
  a.src === b.src && Math.abs(a.p1[0] - b.p1[0]) <= tol && Math.abs(a.p1[1] - b.p1[1]) <= tol && Math.abs(a.p2[0] - b.p2[0]) <= tol && Math.abs(a.p2[1] - b.p2[1]) <= tol;

function compare(name: string, got: Pred[], want: RefPred[]): { ok: number; n: number; extra: number; missing: number } {
  // order-free match, then report order agreement separately
  const used = new Set<number>();
  let ok = 0, inOrder = 0;
  got.forEach((g, i) => {
    const j = want.findIndex((w, k) => !used.has(k) && same(g, w));
    if (j >= 0) { used.add(j); ok++; if (j === i) inOrder++; }
    else if (verbose) console.log(`    ${name}: only in TypeScript`, JSON.stringify({ p1: g.p1.map((v) => +v.toFixed(2)), p2: g.p2.map((v) => +v.toFixed(2)), src: g.src, how: g.how, cls: g.cls }));
  });
  if (verbose) want.forEach((w, k) => { if (!used.has(k)) console.log(`    ${name}: only in Python`, JSON.stringify({ p1: w.p1.map((v) => +v.toFixed(2)), p2: w.p2.map((v) => +v.toFixed(2)), src: w.src, how: w.how, cls: w.cls })); });
  console.log(`  ${name.padEnd(7)} TypeScript ${String(got.length).padStart(4)}  Python ${String(want.length).padStart(4)}  same ${String(ok).padStart(4)}  same place in list ${inOrder}`);
  return { ok, n: want.length, extra: got.length - ok, missing: want.length - ok };
}

const tot = { sheets: 0, final: 0, finalOk: 0, extra: 0, missing: 0, fits: 0, fitsOk: 0 };
for (const f of readdirSync(dir).filter((x) => x.endsWith(".fx.json")).sort()) {
  const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const ref = JSON.parse(readFileSync(path.join(dir, f.replace(".fx.json", ".ref.json")), "utf8"));
  const ppf: number = fx.ppf;
  const doors: FuseDoor[] = fx.reader.boxes.map((b: number[], i: number) => {
    const ft = fx.reader.feats[i];
    return { box: b.slice(0, 4), jambLine: ft.jamb_line ?? null, confidence: ft.conf, pair: !!ft.pair, stall: !!ft.stall, leaves: ft.leaves.map((l: { hinge: Pt; tip: Pt; sweep: number; rPt: number }) => ({ hinge: l.hinge, tip: l.tip, sweepDeg: l.sweep, radiusPt: l.rPt })) };
  });
  const det: DetBox[] = fx.det;
  const ink = unpack(fx.mask16), wallInk = unpack(fx.mask24);
  // fixture clips are keyed by the box to 0.1 pt as Python prints it (ties round to even there), so match by value
  const clipKeys = Object.keys(fx.clips).map((k) => [k, k.split(",").map(Number)] as const);
  const key = (b: ArrayLike<number>) => clipKeys.find(([, v]) => v.every((x, i) => Math.abs(x - b[i]) <= 0.051))?.[0] ?? "";
  let fits = 0, fitsOk = 0;
  const page: DetectPage = {
    ppf, ink, inkPxf: ppf * ink.z, wallInk,
    fitSwing: (b) => {
      const c = fx.clips[key(b)];
      if (!c) return null;
      const r = fitSwing(b, unpack(c), [c.ox, c.oy], ppf);
      const want = ref.fits[key(b)];
      fits++;
      const ws = want?.seg as { p1: Pt; p2: Pt } | null;
      const eq = (!r.seg && !ws) || (!!r.seg && !!ws && Math.abs(r.seg.p1[0] - ws.p1[0]) <= tol && Math.abs(r.seg.p1[1] - ws.p1[1]) <= tol && Math.abs(r.seg.p2[0] - ws.p2[0]) <= tol && Math.abs(r.seg.p2[1] - ws.p2[1]) <= tol);
      if (eq) fitsOk++;
      else if (verbose) console.log("    fit differs", key(b), JSON.stringify(r.seg), JSON.stringify(ws), r.deg, want?.info?.deg);
      return r;
    },
    lines: fx.text_lines.map((l: { str: string; box: number[]; c: Pt; size: number }) => ({ str: l.str, box: l.box, c: l.c, size: l.size })),
    rest: fx.rest, labels: fx.labels.map((l: [number, number, string]) => [l[0], l[1]] as Pt),
    segs: { data: Float32Array.from((fx.segs as number[][]).flat()), n: fx.segs.length },
  };
  const t0 = performance.now();
  const r = await runDoorPipeline(doors, det, page, SETTINGS);
  const ms = performance.now() - t0;
  console.log(`${fx.sheet}: reader ${doors.length}, detector boxes ${det.length}, ${ms.toFixed(0)} ms; swing fits ${fitsOk}/${fits} same`);
  compare("fused", r.stages.fused, ref.fused);
  compare("swing", r.stages.swing, ref.swing);
  compare("tags", r.stages.tagged, ref.stage4);
  const c = compare("final", r.preds, ref.final);
  const wantDrop = Object.values(ref.drop as Record<string, string>).sort().join(", "), gotDrop = Object.values(r.stages.drop).sort().join(", ");
  if (wantDrop !== gotDrop) console.log(`  filters differ: TypeScript [${gotDrop}]  Python [${wantDrop}]`);
  tot.sheets++; tot.final += c.n; tot.finalOk += c.ok; tot.extra += c.extra; tot.missing += c.missing; tot.fits += fits; tot.fitsOk += fitsOk;
}
console.log(`\n${tot.sheets} sheets: final openings ${tot.finalOk} of ${tot.final} the same; only in TypeScript ${tot.extra}; only in Python ${tot.missing}; swing fits the same ${tot.fitsOk} of ${tot.fits}`);
process.exit(tot.extra + tot.missing === 0 ? 0 : 1);
