// Generates test/fixtures/mep-set.pdf — the equipment-schedule fixture.
// Fully synthetic (no real plan enters the repo). Two sheets:
//   page 1  M-101 FIRST FLOOR MECHANICAL PLAN — three baseboard heaters drawn
//           to their own LENGTH (the equipment convention: the symbol's size
//           is the unit's size, so no two are the same geometry), each tagged
//           by a leader; one exhaust fan drawn as a small square with its tag;
//           one BARE mention of a mark inside a general note (no linework
//           near it — a mention, never an instance); one air register drawn
//           as a tag OVER a CFM value (the tag-over-value convention).
//   page 2  M-601 MECHANICAL SCHEDULES — ELECTRIC BASEBOARD HEATER SCHEDULE
//           (ID-keyed, WATTS/VOLTS/LENGTH columns), FAN SCHEDULE (MARK-keyed,
//           CFM/ESP/HP), a DIFFUSER, GRILLE, REGISTER SCHEDULE (NECK/THROW/
//           MOUNTING — no powered column), and a MATERIAL SCHEDULE that says
//           MARK and MANUFACTURER but no powered column (must stay a finish
//           table, never equipment).
// Deterministic byte output; re-run only to change the fixture:
//   node scripts/make-mep-fixture.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "mep-set.pdf");
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const T = (x, y, s, str) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
const seg = (x0, y0, x1, y1) => `${x0} ${y0} m ${x1} ${y1} l S`;
/** A double-outlined bar (outer + inner rectangle as 8 segments), the heater symbol. */
const bar = (x, y, w, h) => [
  seg(x, y, x + w, y), seg(x + w, y, x + w, y + h), seg(x + w, y + h, x, y + h), seg(x, y + h, x, y),
  seg(x + 2, y + 2, x + w - 2, y + 2), seg(x + w - 2, y + 2, x + w - 2, y + h - 2), seg(x + w - 2, y + h - 2, x + 2, y + h - 2), seg(x + 2, y + h - 2, x + 2, y + 2),
];
/** A leader from the tag text to the symbol. */
const leader = (x0, y0, x1, y1) => seg(x0, y0, x1, y1);
const BORDER = "1 w 30 30 552 732 re S";

const pages = [
  // page 1 — the plan
  [
    BORDER,
    T(60, 740, 12, "FIRST FLOOR MECHANICAL PLAN"),
    T(480, 40, 10, "M-101"),
    // room outlines
    "0.6 w", seg(60, 100, 300, 100), seg(300, 100, 300, 400), seg(300, 400, 60, 400), seg(60, 400, 60, 100),
    seg(320, 100, 540, 100), seg(540, 100, 540, 400), seg(540, 400, 320, 400), seg(320, 400, 320, 100),
    "1.4 w",
    // EBB-1: a 60pt bar along the left wall, tagged by a leader
    ...bar(64, 200, 8, 60), T(90, 225, 9, "EBB-1"), leader(88, 228, 72, 230),
    // EBB-2: a 90pt bar (a longer unit — different geometry, same convention)
    ...bar(64, 300, 8, 90), T(90, 340, 9, "EBB-2"), leader(88, 343, 72, 345),
    // EBB-3: a 60pt bar drawn HORIZONTAL along the bottom wall of the second room
    ...bar(380, 104, 60, 8), T(395, 125, 9, "EBB-3"), leader(410, 122, 410, 113),
    // EF-1: exhaust fan, a small square with a diagonal, tagged
    seg(400, 300, 420, 300), seg(420, 300, 420, 320), seg(420, 320, 400, 320), seg(400, 320, 400, 300), seg(400, 300, 420, 320),
    T(426, 306, 9, "EF-1"),
    // SR-1: a supply register drawn as tag OVER value (the air-device convention)
    T(150, 360, 9, "SR-1"), T(152, 349, 9, "150"),
    seg(146, 368, 176, 368), seg(176, 368, 176, 346), seg(176, 346, 146, 346), seg(146, 346, 146, 368),
    // a general note that MENTIONS a mark — no linework near it
    // (three runs, so the mark is its own text span — the way CAD text export
    // splits a note around a tag — with no linework anywhere near it)
    T(60, 60, 8, "GENERAL NOTE: SEE"), T(150, 60, 8, "EBB-1"), T(180, 60, 8, "FOR TYPICAL MOUNTING HEIGHT."),
  ],
  // page 2 — the schedules
  [
    BORDER,
    T(480, 40, 10, "M-601"),
    T(60, 720, 12, "ELECTRIC BASEBOARD HEATER SCHEDULE"),
    T(60, 700, 9, "ID"), T(120, 700, 9, "MANUFACTURER"), T(230, 700, 9, "MODEL"), T(300, 700, 9, "WATTS"), T(360, 700, 9, "VOLTS"), T(420, 700, 9, "LENGTH"), T(480, 700, 9, "REMARKS"),
    T(60, 684, 9, "EBB-1"), T(120, 684, 9, "EXAMPLECO"), T(230, 684, 9, "BB-750"), T(300, 684, 9, "750"), T(360, 684, 9, "120"), T(420, 684, 9, "3'-0\""),
    T(60, 668, 9, "EBB-2"), T(120, 668, 9, "EXAMPLECO"), T(230, 668, 9, "BB-1000"), T(300, 668, 9, "1000"), T(360, 668, 9, "240"), T(420, 668, 9, "4'-0\""),
    T(60, 652, 9, "EBB-3"), T(120, 652, 9, "EXAMPLECO"), T(230, 652, 9, "BB-750"), T(300, 652, 9, "750"), T(360, 652, 9, "120"), T(420, 652, 9, "3'-0\""),
    T(60, 600, 12, "FAN SCHEDULE"),
    T(60, 580, 9, "MARK"), T(120, 580, 9, "DESCRIPTION"), T(260, 580, 9, "CFM"), T(320, 580, 9, "ESP"), T(380, 580, 9, "HP"), T(440, 580, 9, "VOLTS"),
    T(60, 564, 9, "EF-1"), T(120, 564, 9, "BATHROOM EXHAUST FAN"), T(260, 564, 9, "80"), T(320, 564, 9, "0.25"), T(380, 564, 9, "1/20"), T(440, 564, 9, "120"),
    T(60, 510, 12, "DIFFUSER, GRILLE, REGISTER SCHEDULE"),
    T(60, 490, 9, "ID"), T(120, 490, 9, "DESCRIPTION"), T(260, 490, 9, "MANUFACTURER"), T(360, 490, 9, "NECK SIZE"), T(440, 490, 9, "THROW"), T(500, 490, 9, "MOUNTING"),
    T(60, 474, 9, "SR-1"), T(120, 474, 9, "SUPPLY REGISTER"), T(260, 474, 9, "EXAMPLECO"), T(360, 474, 9, "10 x 6"), T(440, 474, 9, "3-WAY"), T(500, 474, 9, "SURFACE"),
    T(60, 420, 12, "MATERIAL SCHEDULE"),
    T(60, 400, 9, "MARK"), T(120, 400, 9, "MATERIAL"), T(260, 400, 9, "MANUFACTURER"), T(400, 400, 9, "DESCRIPTION"),
    T(60, 384, 9, "CPT-1"), T(120, 384, 9, "CARPET TILE"), T(260, 384, 9, "EXAMPLECO"), T(400, 384, 9, "24 x 24 MODULAR"),
    T(60, 368, 9, "RB-1"), T(120, 368, 9, "RESILIENT BASE"), T(260, 368, 9, "EXAMPLECO"), T(400, 368, 9, "4 IN COVE"),
    T(60, 320, 8, "MECHANICAL SCHEDULES"),
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
