// Generates test/fixtures/layered-plan.pdf — the OCG fixture for #85 (neither
// bundled demo plan carries Optional Content, so the layered case ships its
// own). Deterministic byte output; re-run only to change the fixture:
//   node scripts/make-layered-fixture.mjs
//
// The sheet (612×612 pt):
//   A-WALL-FULL (on)   a 300×300 pt room, stroked — the boundary
//   A-FLOR-PATT (on)   a 3×3 tile grid inside — only FOUR interior lines,
//                      far below HATCH_MIN_RUN, so the pitch heuristics keep
//                      them HARD and a naive flood traps in one tile cell;
//                      the layer states what they are, which is the point
//   A-ANNO-TEXT (on)   a leader line crossing the room — annotation ink
//   A-WALL-DEMO (OFF)  a wall bisecting the room, hidden in the default
//                      config — excluded unless explicitly included
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "layered-plan.pdf");

const content = [
  "/OC /oc1 BDC",
  "2 w",
  "100 100 300 300 re S",
  "EMC",
  "/OC /oc2 BDC",
  "0.5 w",
  "200 100 m 200 400 l S",
  "300 100 m 300 400 l S",
  "100 200 m 400 200 l S",
  "100 300 m 400 300 l S",
  "EMC",
  "/OC /oc3 BDC",
  "0.5 w",
  "110 110 m 390 390 l S",
  "EMC",
  "/OC /oc4 BDC",
  "2 w",
  "100 250 m 400 250 l S",
  "EMC",
].join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R 7 0 R 8 0 R] /D << /Order [5 0 R 6 0 R 7 0 R 8 0 R] /OFF [8 0 R] >> >> >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents 4 0 R /Resources << /Properties << /oc1 5 0 R /oc2 6 0 R /oc3 7 0 R /oc4 8 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /OCG /Name (A-WALL-FULL) >>",
  "<< /Type /OCG /Name (A-FLOR-PATT) >>",
  "<< /Type /OCG /Name (A-ANNO-TEXT) >>",
  "<< /Type /OCG /Name (A-WALL-DEMO) >>",
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
