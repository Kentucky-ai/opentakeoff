// Generates test/fixtures/multibuilding-set.pdf — the sheet-graph phase-2
// fixture (#87). The bundled demo set is a single-building set with flat
// headers; the phase-2 contract needs the three cases it cannot show, pinned:
//   page 1  BUILDING A - FIRST FLOOR FINISH PLAN   rooms 134 (OFFICE), 135 (LAB)
//   page 2  BUILDING B - FIRST FLOOR FINISH PLAN   rooms 134 (STORAGE), 201 (OFFICE)
//   page 3  ROOM FINISH SCHEDULE - BUILDING A      column headers ROTATED 90°
//           + MATERIAL SCHEDULE (flat headers)     CPT-1 / LVT-1 / RB-1 defs
//   page 4  ROOM FINISH SCHEDULE - BUILDING B      flat headers, row 134 only
//   page 5  ROOM FINISH SCHEDULE - BUILDING B - CONT'D   header repeated, row 201
// So: room 134 exists in BOTH buildings (unqualified resolve must refuse and
// list candidates), building A's table is only readable through the rotated
// header band, and building B's table spans a continuation sheet (201 resolves
// off page 5, cited there). Deterministic byte output; re-run only to change
// the fixture:
//   node scripts/make-sheetgraph-fixture.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "multibuilding-set.pdf");

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
/** Horizontal text at (x, y) pt (PDF y-up), font size s. */
const T = (x, y, s, str) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
/** Text rotated 90° CCW (reading bottom-to-top), baseline starting at (x, y). */
const R = (x, y, s, str) => `BT /F1 ${s} Tf 0 1 -1 0 ${x} ${y} Tm (${esc(str)}) Tj ET`;
const BORDER = "1 w 40 40 532 532 re S";

// room-finish columns (pt): NO, NAME, FLOOR, BASE, WALL
const COLS = [100, 160, 300, 400, 500];
const rfHeader = (y, rotated) =>
  ["NO", "NAME", "FLOOR", "BASE", "WALL"].map((h, i) => (rotated ? R(COLS[i], y, 10, h) : T(COLS[i], y, 10, h)));
const rfRow = (y, cells) => cells.map((c, i) => T(COLS[i], y, 10, c));

const pages = [
  // page 1 — Building A plan
  [
    BORDER,
    T(120, 570, 12, "BUILDING A - FIRST FLOOR FINISH PLAN"),
    T(100, 400, 10, "OFFICE"), T(102, 388, 10, "134"),
    T(300, 400, 10, "LAB"), T(302, 388, 10, "135"),
  ],
  // page 2 — Building B plan
  [
    BORDER,
    T(120, 570, 12, "BUILDING B - FIRST FLOOR FINISH PLAN"),
    T(100, 400, 10, "STORAGE"), T(102, 388, 10, "134"),
    T(300, 400, 10, "OFFICE"), T(302, 388, 10, "201"),
  ],
  // page 3 — Building A room-finish schedule (ROTATED headers) + material schedule
  [
    BORDER,
    T(100, 580, 12, "ROOM FINISH SCHEDULE - BUILDING A"),
    ...rfHeader(520, true),
    ...rfRow(490, ["134", "OFFICE", "CPT-1", "RB-1", "P-1"]),
    ...rfRow(470, ["135", "LAB", "LVT-1", "RB-1", "P-1"]),
    T(100, 380, 12, "MATERIAL SCHEDULE"),
    T(100, 350, 10, "CODE"), T(200, 350, 10, "MATERIAL"), T(380, 350, 10, "MANUFACTURER"),
    T(100, 330, 10, "CPT-1"), T(200, 330, 10, "CARPET TILE"), T(380, 330, 10, "EXAMPLECO"),
    T(100, 310, 10, "LVT-1"), T(200, 310, 10, "LUXURY VINYL TILE"), T(380, 310, 10, "EXAMPLECO"),
    T(100, 290, 10, "RB-1"), T(200, 290, 10, "RESILIENT BASE"), T(380, 290, 10, "EXAMPLECO"),
  ],
  // page 4 — Building B room-finish schedule, base fragment. Row 134 carries a
  // revision marker in the margin (phase 3): ASCII "REV 2" — the Δ glyph is
  // not in WinAnsi, and the REV form exercises the same attachment path. Kept
  // a real margin's distance from the key column: closer and pdf.js glues the
  // marker and the key into one span ("REV 2134").
  [
    BORDER,
    T(100, 580, 12, "ROOM FINISH SCHEDULE - BUILDING B"),
    ...rfHeader(550, false),
    T(50, 530, 10, "REV 2"),
    ...rfRow(530, ["134", "STORAGE", "VCT-2", "RB-2", "P-2"]),
  ],
  // page 5 — the continuation: header repeated, the rest of the rows
  [
    BORDER,
    T(100, 580, 12, "ROOM FINISH SCHEDULE - BUILDING B - CONT'D"),
    ...rfHeader(550, false),
    ...rfRow(530, ["201", "OFFICE", "CPT-2", "RB-2", "P-2"]),
  ],
];

const N_PAGES = pages.length;
// object layout: 1 catalog, 2 pages, 3..2+N page objs, 3+N..2+2N contents, 3+2N font
const pageObj = (i) => 3 + i;
const contObj = (i) => 3 + N_PAGES + i;
const FONT = 3 + 2 * N_PAGES;

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${N_PAGES} >>`,
  ...pages.map((_, i) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents ${contObj(i)} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`),
  ...pages.map((ops) => {
    const content = ops.join("\n");
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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
