// Generates test/fixtures/reader483-set.pdf — the Import from schedule
// fixture for #483 (codes with a word after them, NOT USED rows, four- and
// five-letter codes). Fully synthetic: invented codes, vendors VENDOR-A … and
// colours; no real plan enters the repo. Three sheets, each a CODE | MATERIAL
// | MANUFACTURER | COLOR material schedule:
//   page 1  A-601 — FLOORING / BASE / WALLS / MISC. FINISHES groups holding:
//           CPT-2 NOT USED beside ticked floor rows; CPT-3 SAT + CPT-3 EGG
//           (two rows that would share CPT-3, so both keep today's glued
//           codes); a filled EPOX row; a one-cell SEAL line (not read, so
//           reported); FTB-01 CUT (C) and FTB-02 COVE; a lone P-1 SAT (read as
//           P-1); TS-1 NOT USED under MISC. FINISHES (its category comes from
//           its words). RB-1 and TS-1 are the codes the screenshot run seeds
//           as existing conditions.
//   page 2  A-602 — a table whose codes are all four-letter (EPOX, CONC,
//           SEAL): no row is read, all three are reported.
//   page 3  A-603 — the short table CPT-1, RB-1, EPOX, PT-1.
// Layout: 8.5 pt text on a 19 pt row pitch (17 px and 38 px at the MCP's
// render scale, the scale of the web fixtures). The sheet number sits in the
// bottom-right corner, clear of the key column.
// Deterministic byte output; re-run only to change the fixture:
//   node scripts/make-reader483-fixture.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "reader483-set.pdf");
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const T = (x, y, s, str) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
const BORDER = "1 w 30 30 552 732 re S";

const FS = 8.5, PITCH = 19;
const COLS = [50, 160, 330, 460]; // CODE, MATERIAL, MANUFACTURER, COLOR
const TOP = 700;

/** A titled CODE | MATERIAL | MANUFACTURER | COLOR table. Each line is a
 * heading (string) or a row [code, material?, manufacturer?, color?]. */
function table(title, lines) {
  const ops = [T(COLS[0], TOP + 2 * PITCH, 12, title)];
  ["CODE", "MATERIAL", "MANUFACTURER", "COLOR"].forEach((h, i) => ops.push(T(COLS[i], TOP, FS, h)));
  let y = TOP;
  for (const ln of lines) {
    y -= PITCH;
    if (typeof ln === "string") { ops.push(T(COLS[0], y, FS, ln)); continue; }
    ln.forEach((cell, i) => { if (cell) ops.push(T(COLS[i], y, FS, cell)); });
  }
  return ops;
}
const sheetNo = (s) => T(500, 44, 10, s);

const pages = [
  [
    BORDER,
    ...table("MATERIAL SCHEDULE", [
      "FLOORING",
      ["CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"],
      ["CPT-2 NOT USED", "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202"],
      ["CPT-3 SAT", "CARPET TILE", "VENDOR-A", "SAND 303"],
      ["CPT-3 EGG", "CARPET TILE", "VENDOR-A", "SAND 304"],
      ["EPOX", "EPOXY FLOORING", "VENDOR-L", "GREY 901"],
      ["LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "OAK 305"],
      ["SEAL", "CONCRETE SEALER"],
      ["VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "WHITE 404"],
      "BASE",
      ["FTB-01 CUT (C)", "CERAMIC TILE BASE", "VENDOR-F", "WHITE 501"],
      ["FTB-02 COVE", "CERAMIC TILE BASE", "VENDOR-F", "WHITE 502"],
      ["RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"],
      "WALLS",
      ["P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601"],
      ["P-2", "PAINT", "VENDOR-E", "TAUPE 602"],
      "MISC. FINISHES",
      ["TS-1 NOT USED", "METAL TRANSITION STRIP", "VENDOR-G", "SATIN"],
      ["CG-1", "CORNER GUARDS", "VENDOR-H", "CLEAR"],
    ]),
    sheetNo("A-601"),
  ],
  [
    BORDER,
    ...table("MATERIAL SCHEDULE", [
      ["EPOX", "EPOXY FLOORING", "VENDOR-L", "GREY 901"],
      ["CONC", "SEALED CONCRETE", "VENDOR-D", "CLEAR"],
      ["SEAL", "PENETRATING SEALER", "VENDOR-D", "CLEAR"],
    ]),
    sheetNo("A-602"),
  ],
  [
    BORDER,
    ...table("MATERIAL SCHEDULE", [
      ["CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"],
      ["RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"],
      ["EPOX", "EPOXY FLOORING", "VENDOR-L", "GREY 901"],
      ["PT-1", "PAINT", "VENDOR-E", "WHITE 601"],
    ]),
    sheetNo("A-603"),
  ],
];

const N = pages.length;
const pageObj = (i) => 3 + i, contObj = (i) => 3 + N + i, FONT = 3 + 2 * N;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${N} >>`,
  ...pages.map((_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contObj(i)} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`),
  ...pages.map((ops) => { const body = ops.join("\n"); return `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`; }),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(OUT, pdf, "latin1");
console.log(`wrote ${OUT} (${Buffer.byteLength(pdf, "latin1")} bytes, ${N} pages)`);
