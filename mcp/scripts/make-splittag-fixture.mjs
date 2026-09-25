// Generates test/fixtures/split-tags.pdf — finish tags drawn the way CAD
// exports often draw them: the hyphen set in a second font, so pdf.js emits
// "WB" + "-" + "01" as three touching text items instead of one "WB-01".
//   page 1  FLOOR FINISH PLAN      boxed tags: WB-01 ×3 (split), TR-01 ×2 (split),
//                                  C-03 ×1 (one run), WB-01 ×1 vertical (split);
//                                  "FLOOR" "TILE" as two runs one word-space apart
//   page 2  FLOOR FINISH SCHEDULE  MARK / DESCRIPTION / MANUFACTURER rows WB-01 (key split),
//                                  TR-01, C-03, TR-03 (on no plan — a zero)
// F1 and F2 are both Helvetica; the font SWITCH is what splits the item.
// Deterministic byte output; re-run only to change the fixture:
//   node scripts/make-splittag-fixture.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "split-tags.pdf");

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const T = (x, y, s, str) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
const T2 = (x, y, s, str) => `BT /F2 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
/** A tag split at its hyphen: prefix in F1, "-" in F2, suffix in F1, one text object. */
const SPLIT = (x, y, s, tag) => {
  const [a, b] = tag.split("-");
  return `BT /F1 ${s} Tf ${x} ${y} Td (${esc(a)}) Tj /F2 ${s} Tf (-) Tj /F1 ${s} Tf (${esc(b)}) Tj ET`;
};
/** The same, reading bottom-to-top (rotated 90° CCW). */
const SPLIT_R = (x, y, s, tag) => {
  const [a, b] = tag.split("-");
  return `BT /F1 ${s} Tf 0 1 -1 0 ${x} ${y} Tm (${esc(a)}) Tj /F2 ${s} Tf (-) Tj /F1 ${s} Tf (${esc(b)}) Tj ET`;
};
/** A tag box: 38 × 14 pt around a tag whose baseline starts at (x, y). */
const BOX = (x, y) => `0.8 w ${x - 3} ${y - 3} 38 14 re S`;
const BOX_R = (x, y) => `0.8 w ${x - 11} ${y - 3} 14 38 re S`;
const BORDER = "1 w 40 40 532 532 re S";

const plan = [
  BORDER,
  T(120, 570, 12, "FLOOR FINISH PLAN"),
  // rooms (walls are not the point here; the tags are)
  "1 w 60 300 220 220 re S", "1 w 300 300 240 220 re S", "1 w 60 60 480 220 re S",
  T(120, 470, 10, "OFFICE"), T(126, 458, 10, "101"),
  ...[[110, 430], [360, 430], [110, 200]].flatMap(([x, y]) => [BOX(x, y), SPLIT(x, y, 10, "WB-01")]),
  ...[[360, 200], [460, 360]].flatMap(([x, y]) => [BOX(x, y), SPLIT(x, y, 10, "TR-01")]),
  BOX(250, 120), T(250, 120, 10, "C-03"),
  BOX_R(520, 90), SPLIT_R(520, 90, 10, "WB-01"),
  // two words one normal space apart, as two runs: must NOT become "FLOORTILE"
  T(330, 250, 10, "FLOOR"), T2(367.2, 250, 10, "TILE"),
];

const COLS = [100, 180, 380];
const ROW = (y, [k, d, m], split) => [split ? SPLIT(COLS[0], y, 10, k) : T(COLS[0], y, 10, k), T(COLS[1], y, 10, d), T(COLS[2], y, 10, m)];
const sched = [
  BORDER,
  T(100, 570, 12, "FLOOR FINISH SCHEDULE"),
  T(COLS[0], 540, 10, "MARK"), T(COLS[1], 540, 10, "DESCRIPTION"), T(COLS[2], 540, 10, "MANUFACTURER"),
  ...ROW(520, ["WB-01", "RUBBER WALL BASE", "EXAMPLECO"], true),
  ...ROW(500, ["TR-01", "TRANSITION STRIP", "EXAMPLECO"]),
  ...ROW(480, ["C-03", "WALK OFF CARPET", "EXAMPLECO"]),
  ...ROW(460, ["TR-03", "METAL TRANSITION", "EXAMPLECO"]),
];

const pages = [plan, sched];
const N = pages.length;
const pageObj = (i) => 3 + i;
const contObj = (i) => 3 + N + i;
const F1 = 3 + 2 * N, F2 = F1 + 1;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${N} >>`,
  ...pages.map((_, i) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents ${contObj(i)} 0 R /Resources << /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R >> >> >>`),
  ...pages.map((ops) => {
    const content = ops.join("\n");
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>",
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
