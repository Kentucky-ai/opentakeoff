// Generates the symbol_sweep fixtures. The bundled demo plans repeat their
// fixtures loosely (text labels, varied blocks); the sweep's contract needs
// EXACT, pinnable counts, so the fixtures ship deterministic geometry.
// Deterministic byte output; re-run only to change a fixture:
//   node scripts/make-symbol-fixture.mjs
//
// 1. test/fixtures/symbol-plan.pdf — the phase-1 single-sheet fixture
//    (612×612 pt, no text layer — symbol_sweep needs no scale):
//    a 532×532 border rect, plus EIGHT placements of a drain-style symbol
//    (20×20 square + ONE diagonal + a 14 pt stub — deliberately asymmetric
//    under every rotation and mirror; the score weights are load-bearing, see
//    web/test/symbolsweep.test.ts):
//      (100,100)  the SEED instance
//      (200,100)  identical            → match, rotation 0
//      (300,100)  identical            → match, rotation 0
//      (150,220)  identical            → match, rotation 0
//      (400,220)  rotated 90°          → match only with rotations on
//      (100,320)  mirrored             → match only with mirror on
//      (300,320)  diagonal perturbed 6 pt → score ≈ 0.77: WITHHELD, never a match
//      (450,450)  square only (decoy)  → score ≈ 0.65: ignored entirely
//
// 2. test/fixtures/symbol-set.pdf — the phase-2 multi-sheet fixture: four
//    612×612 pt pages WITH a text layer, so the sheet graph can classify
//    roles and read schedule rows. Pins set-wide plan-only counting, detail
//    seeding, schedule-row seeding, and the refusal cases:
//      page 1 "FLOOR PLAN"  (plan)     — 4 drain instances (3 plain + 1
//        rotated); 3 tag markers labeled T1; 1 marker labeled T2 (excluded
//        by tag); 1 unlabeled marker (withheld as a question); 1 bare "T1"
//        text with no marker (text-only disclosure)
//      page 2 "FINISH PLAN" (plan)     — 2 drains (1 plain + 1 mirrored);
//        2 T1 markers
//      page 3 "DETAILS"     (detail)   — 1 drain (the detail-seed source) and
//        1 T1 marker: NEITHER may ever be counted (not a plan sheet)
//      page 4 "FINISH SCHEDULE" (schedule) — the table (CODE / MATERIAL /
//        DESCRIPTION; rows T1, T2, T9) plus 1 reference drain: never counted.
//        T9 exists as a row but is drawn on no plan sheet — the
//        cannot-anchor refusal.
//
// 3. test/fixtures/symbol-lum.pdf — the #260 stroke-luminance fixture
//    (612×612 pt, no text layer): the SAME drain symbol drawn SEVEN times,
//    geometrically identical everywhere — four in black (the devices; one of
//    them the seed) and three in grey RGB(219,219,219) (the background twins).
//    Nothing in the geometry separates them; the stroke color does. Pins the
//    end-to-end path: pdf.js stroke-color ops → extractVectorGeometry's lum
//    channel → symbol_sweep's stated luminance_tolerance gate.
//      black: (100,100) seed · (200,100) · (300,100) · (400,220) rotated 90°
//      grey:  (100,400) · (250,400) · (400,400)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const OUT = join(FIXTURES, "symbol-plan.pdf");
const OUT_SET = join(FIXTURES, "symbol-set.pdf");
const OUT_LUM = join(FIXTURES, "symbol-lum.pdf");

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

// ── symbol-set.pdf — the multi-sheet phase-2 fixture ─────────────────────────

/** A tag marker: a 24-pt diamond (the drawn bubble) around centered text.
 * The diamond is the GEOMETRY the sweep fingerprints; the text is the tag
 * the schedule-row mode corroborates against. One shape shared by every tag
 * — exactly the drafting convention that makes text corroboration necessary. */
function diamond([cx, cy]) {
  const r = 12;
  const pts = [[cx - r, cy], [cx, cy + r], [cx + r, cy], [cx, cy - r]];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    out.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`);
  }
  return out;
}
/** Centered tag text (Helvetica 10; "T1" is ~11.7 pt wide, cap ~7 pt tall). */
const tagText = (tag, [cx, cy]) => `BT /F1 10 Tf ${fmt(cx - 5.8)} ${fmt(cy - 3.5)} Td (${tag}) Tj ET`;
const title = (text) => `BT /F1 14 Tf 40 580 Td (${text}) Tj ET`;
const cell = (text, x, y) => `BT /F1 9 Tf ${fmt(x)} ${fmt(y)} Td (${text}) Tj ET`;

const marker = (tag, at) => [...diamond(at), ...(tag ? [tagText(tag, at)] : [])];

const PAGES = [
  // page 1 — FLOOR PLAN (plan role)
  [
    title("FLOOR PLAN"),
    "1 w",
    "30 30 552 552 re S",
    "0.5 w",
    ...place(SYMBOL, [120, 430]),
    ...place(SYMBOL, [260, 430]),
    ...place(SYMBOL, [400, 430]),
    ...place(SYMBOL, [120, 330], { rot90: true }),
    ...marker("T1", [150, 200]),
    ...marker("T1", [300, 200]),
    ...marker("T1", [450, 200]),
    ...marker("T2", [450, 120]),
    ...marker(null, [150, 120]),          // the marker shape with no tag — a question, never a count
    tagText("T1", [300, 90]),             // the tag with no marker — text alone is never a fingerprint
  ],
  // page 2 — FINISH PLAN (plan role)
  [
    title("FINISH PLAN"),
    "1 w",
    "30 30 552 552 re S",
    "0.5 w",
    ...place(SYMBOL, [150, 400]),
    ...place(SYMBOL, [350, 400], { mir: true }),
    ...marker("T1", [150, 250]),
    ...marker("T1", [400, 250]),
  ],
  // page 3 — DETAILS (detail role): the seed source; nothing here counts
  [
    title("DETAILS"),
    "0.5 w",
    ...place(SYMBOL, [300, 300]),
    ...marker("T1", [150, 150]),
  ],
  // page 4 — FINISH SCHEDULE (schedule role): the rows + a reference drawing
  [
    title("FINISH SCHEDULE"),
    cell("CODE", 60, 540), cell("MATERIAL", 200, 540), cell("DESCRIPTION", 400, 540),
    cell("T1", 60, 515), cell("TRANSITION", 200, 515), cell("EDGE STRIP RESILIENT", 400, 515),
    cell("T2", 60, 490), cell("TRANSITION", 200, 490), cell("EDGE STRIP METAL", 400, 490),
    cell("T9", 60, 465), cell("JOINT COVER", 200, 465), cell("NOT DRAWN ON PLANS", 400, 465),
    "0.5 w",
    ...place(SYMBOL, [450, 300]),         // reference drawing in the schedule margin — never counted
  ],
];

// object layout: 1 catalog, 2 pages, 3 font, then per page (page obj, stream obj)
const setObjects = [
  `<< /Type /Catalog /Pages 2 0 R >>`,
  `<< /Type /Pages /Kids [${PAGES.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${PAGES.length} >>`,
  `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
];
for (let i = 0; i < PAGES.length; i++) {
  const stream = PAGES[i].join("\n");
  setObjects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  );
}

let setPdf = "%PDF-1.5\n";
const setOffsets = [];
setObjects.forEach((body, i) => {
  setOffsets.push(setPdf.length);
  setPdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const setXrefAt = setPdf.length;
setPdf += `xref\n0 ${setObjects.length + 1}\n0000000000 65535 f \n`;
for (const off of setOffsets) setPdf += `${String(off).padStart(10, "0")} 00000 n \n`;
setPdf += `trailer\n<< /Size ${setObjects.length + 1} /Root 1 0 R >>\nstartxref\n${setXrefAt}\n%%EOF\n`;

writeFileSync(OUT_SET, setPdf, "latin1");
console.log(`wrote ${OUT_SET} (${setPdf.length} bytes)`);

// ── symbol-lum.pdf — the #260 stroke-luminance fixture ───────────────────────
// The same drain glyph seven times, geometrically identical; only the stroke
// color separates device from background twin. 219/255 = 0.858824 — the grey
// the field report measured on a real ceiling grid.

const lumContent = [
  "0 0 0 RG",
  "1 w",
  "40 40 532 532 re S",                       // border — long segments, never the symbol
  "0.5 w",
  ...place(SYMBOL, [100, 100]),               // seed (black)
  ...place(SYMBOL, [200, 100]),
  ...place(SYMBOL, [300, 100]),
  ...place(SYMBOL, [400, 220], { rot90: true }),
  "0.858824 0.858824 0.858824 RG",            // the grey twins — same ink, different pen
  ...place(SYMBOL, [100, 400]),
  ...place(SYMBOL, [250, 400]),
  ...place(SYMBOL, [400, 400]),
].join("\n");

const lumObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents 4 0 R /Resources << >> >>",
  `<< /Length ${lumContent.length} >>\nstream\n${lumContent}\nendstream`,
];

let lumPdf = "%PDF-1.5\n";
const lumOffsets = [];
lumObjects.forEach((body, i) => {
  lumOffsets.push(lumPdf.length);
  lumPdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const lumXrefAt = lumPdf.length;
lumPdf += `xref\n0 ${lumObjects.length + 1}\n0000000000 65535 f \n`;
for (const off of lumOffsets) lumPdf += `${String(off).padStart(10, "0")} 00000 n \n`;
lumPdf += `trailer\n<< /Size ${lumObjects.length + 1} /Root 1 0 R >>\nstartxref\n${lumXrefAt}\n%%EOF\n`;

writeFileSync(OUT_LUM, lumPdf, "latin1");
console.log(`wrote ${OUT_LUM} (${lumPdf.length} bytes)`);
