// Generates test/fixtures/symbol-plan.pdf — the symbol_sweep fixture. The
// bundled demo plans repeat their fixtures loosely (text labels, varied
// blocks); the sweep's contract needs EXACT, pinnable counts, so the fixture
// ships deterministic geometry. Deterministic byte output; re-run only to
// change the fixture:
//   node scripts/make-symbol-fixture.mjs
//
// The sheet (612×612 pt, no text layer — symbol_sweep needs no scale):
//   a 532×532 border rect, plus EIGHT placements of a drain-style symbol
//   (20×20 square + ONE diagonal + a 14 pt stub — deliberately asymmetric
//   under every rotation and mirror; the score weights are load-bearing, see
//   web/test/symbolsweep.test.ts):
//     (100,100)  the SEED instance
//     (200,100)  identical            → match, rotation 0
//     (300,100)  identical            → match, rotation 0
//     (150,220)  identical            → match, rotation 0
//     (400,220)  rotated 90°          → match only with rotations on
//     (100,320)  mirrored             → match only with mirror on
//     (300,320)  diagonal perturbed 6 pt → score ≈ 0.77: WITHHELD, never a match
//     (450,450)  square only (decoy)  → score ≈ 0.65: ignored entirely
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "symbol-plan.pdf");

// the symbol, local pt (y up): square + one diagonal + right stub
const SYMBOL = [
  [0, 0, 20, 0], [20, 0, 20, 20], [20, 20, 0, 20], [0, 20, 0, 0],
  [0, 0, 20, 20],
  [20, 10, 34, 10],
];
const SQUARE_ONLY = SYMBOL.slice(0, 4);
const PERTURBED = SYMBOL.map((s, i) => (i === 4 ? [0, 0, 26, 20] : s)); // diagonal endpoint off by 6 pt

const fmt = (v) => (Math.round(v * 100) / 100).toString();
/** Place a segment set: translate, optional 90° CCW rotation about the local
 * (10,10) square center, optional mirror about local x=10. */
function place(segs, [px, py], { rot90 = false, mir = false } = {}) {
  const out = [];
  for (const [ax, ay, bx, by] of segs) {
    const t = (x, y) => {
      let [mx, my] = mir ? [20 - x, y] : [x, y];
      if (rot90) [mx, my] = [20 - my, mx];
      return [mx + px, my + py];
    };
    const a = t(ax, ay), b = t(bx, by);
    out.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`);
  }
  return out;
}

const content = [
  "1 w",
  "40 40 532 532 re S",                       // the border — long segments, never the symbol
  "0.5 w",
  ...place(SYMBOL, [100, 100]),               // seed
  ...place(SYMBOL, [200, 100]),
  ...place(SYMBOL, [300, 100]),
  ...place(SYMBOL, [150, 220]),
  ...place(SYMBOL, [400, 220], { rot90: true }),
  ...place(SYMBOL, [100, 320], { mir: true }),
  ...place(PERTURBED, [300, 320]),
  ...place(SQUARE_ONLY, [450, 450]),
].join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents 4 0 R /Resources << >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];

let pdf = "%PDF-1.5\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, pdf, "latin1");
console.log(`wrote ${OUT} (${pdf.length} bytes)`);
