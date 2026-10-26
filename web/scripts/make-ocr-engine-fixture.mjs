// Writes test/fixtures/ocr-engine/twoline.png (#484): a synthetic finish
// schedule, 16 rows, with five DESCRIPTION cells wrapped onto two lines, drawn
// as a 17 × 11 in sheet at 200 DPI like a scan. test/ocrEngineStrategy.test.ts
// reads it with the real engine and asserts every wrapped cell's FIRST line
// reads ("BULLNOSE EDGE AT" and four more): under ppu's per-line strategy at
// batch 6, only 2 of the 5 did.
//
//   node scripts/make-ocr-engine-fixture.mjs
//
// The committed PNG is the reference, not this script's output: the text is
// drawn in "Arial", which each OS resolves to its own font, so a run on
// another machine can give other pixels. The table is the #484 diagnosis
// harness's "twoline" input (the same layout, wrapped cells and RNG order: a
// 60-row and a 10-row table before this one), with every manufacturer,
// product-line and color name replaced by a generic one (CONTRIBUTING.md:
// no brand names in sample data). All text is made up.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(web, "package.json"));
const { createCanvas } = require("@napi-rs/canvas");
const OUT = join(web, "test/fixtures/ocr-engine/twoline.png");
const DPI = 200, S = DPI / 72;

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const CATS = [
  { pre: "CPT", mat: "CARPET TILE", mfr: ["VENDOR-A", "VENDOR-B", "VENDOR-C", "VENDOR-D"], size: ['24" x 24"', '18" x 36"', '12" x 48"'] },
  { pre: "LVT", mat: "LUXURY VINYL TILE", mfr: ["VENDOR-E", "VENDOR-F", "VENDOR-G", "VENDOR-H"], size: ['6" x 48"', '9" x 59"', '18" x 18"'] },
  { pre: "RB", mat: "RESILIENT BASE", mfr: ["VENDOR-J", "VENDOR-K", "VENDOR-L"], size: ['4"', '6"'] },
  { pre: "P", mat: "PAINT", mfr: ["VENDOR-M", "VENDOR-N", "VENDOR-P"], size: ["-"] },
  { pre: "ACT", mat: "ACOUSTICAL CEILING TILE", mfr: ["VENDOR-R", "VENDOR-F", "VENDOR-S"], size: ["2' x 2'", "2' x 4'"] },
  { pre: "CT", mat: "CERAMIC WALL TILE", mfr: ["VENDOR-T", "VENDOR-U", "VENDOR-V"], size: ['3" x 6"', '4" x 12"', '2" x 2"'] },
  { pre: "SV", mat: "SHEET VINYL", mfr: ["VENDOR-W", "VENDOR-X", "VENDOR-Y"], size: ["6' ROLL"] },
  { pre: "TS", mat: "TRANSITION STRIP", mfr: ["VENDOR-Z", "VENDOR-J"], size: ["TO FIT"] },
];
const STYLES = ["TEXTURED LOOP", "LINEAR PLANK", "FIELD SQUARE", "SMOOTH", "STANDARD SOLID", "FLECK", "HERRINGBONE", "STRIPE", "SOLID TONE", "MATTE"];
const COLORS = ["WARM WHITE 51839", "PEPPER 137", "LIGHT BEIGE 45", "DARK GRAY 7069", "WILLOW 42", "ALMOND 22", "CHARCOAL 4501", "MID GRAY 7029", "BURNT UMBER 63", "SLATE 220"];
const DESCS = ["TYP. ALL CORRIDORS", "OFFICES AND CONFERENCE", "INSTALL ASHLAR", "MONOLITHIC INSTALL", "WET AREAS ONLY", "SEE PLANS", "EGGSHELL FINISH", "SEMI-GLOSS AT DOORS", "HEAT WELD SEAMS", "PROVIDE ATTIC STOCK"];
const REMARKS = ["", "PROVIDE 2% ATTIC STOCK", "SEE SPEC 09 65 13", "", "GROUT: WHITE 00", "", "VERIFY WITH ARCHITECT", ""];
const HDR = ["CODE", "MATERIAL", "DESCRIPTION", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "REMARKS"];

function rowsFor(n) {
  const counter = {};
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = CATS[i % CATS.length];
    counter[c.pre] = (counter[c.pre] || 0) + 1;
    rows.push([`${c.pre}-${counter[c.pre]}`, c.mat, pick(DESCS), pick(c.mfr), pick(STYLES), pick(COLORS), pick(c.size), pick(REMARKS)]);
  }
  return rows;
}

/** The table in PDF points (scaled by S), wrapped cells on two lines. */
function drawTable(ctx, { x0, y0, colW, rowH, hdrH, rows, fontPt, title, wrap }) {
  const totalW = colW.reduce((a, b) => a + b, 0);
  const rowHs = rows.map((_, i) => (wrap[i] ? rowH * 1.75 : rowH));
  const totalH = hdrH + rowHs.reduce((a, b) => a + b, 0);
  ctx.save(); ctx.scale(S, S);
  ctx.fillStyle = "#000"; ctx.strokeStyle = "#000"; ctx.lineWidth = 0.7;
  ctx.font = `bold ${fontPt * 1.6}px Arial`;
  ctx.fillText(title, x0, y0 - 10);
  ctx.strokeRect(x0, y0, totalW, totalH);
  let x = x0;
  for (let c = 0; c < colW.length; c++) { if (c) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + totalH); ctx.stroke(); } x += colW[c]; }
  let y = y0 + hdrH;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + totalW, y); ctx.lineWidth = 1.4; ctx.stroke(); ctx.lineWidth = 0.7;
  ctx.font = `bold ${fontPt}px Arial`;
  x = x0;
  for (let c = 0; c < HDR.length; c++) {
    ctx.fillText(HDR[c], x + 4, y0 + hdrH / 2 + fontPt * 0.36);
    x += colW[c];
  }
  ctx.font = `${fontPt}px Arial`;
  for (let r = 0; r < rows.length; r++) {
    const rh = rowHs[r];
    x = x0;
    for (let c = 0; c < rows[r].length; c++) {
      const lines = wrap[r] && wrap[r][c] ? wrap[r][c] : [rows[r][c]];
      lines.forEach((ln, k) => {
        if (!ln) return;
        const by = lines.length > 1 ? y + rh / 2 - fontPt * 0.25 + (k - 0.5) * fontPt * 1.25 + fontPt * 0.36 : y + rh / 2 + fontPt * 0.36;
        ctx.fillText(ln, x + 4, by);
      });
      x += colW[c];
    }
    y += rh;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + totalW, y); ctx.stroke();
  }
  ctx.restore();
}

rowsFor(60); rowsFor(10); // the harness's two tables before this one
const rows = rowsFor(16);
const wrap = {};
const TWO = [["BULLNOSE EDGE AT", "VERTICAL TERMINATION"], ["INSTALL WITH", "PRESSURE SENSITIVE ADH."], ["HEAT WELD ALL", "SEAMS, COLOR MATCH"], ["SEMI-GLOSS AT", "DOOR FRAMES ONLY"], ["MONOLITHIC INSTALL", "TURN AT CORNERS"]];
[1, 4, 7, 10, 13].forEach((r, k) => { rows[r][2] = TWO[k].join(" "); wrap[r] = { 2: TWO[k] }; });
const canvas = createCanvas(Math.round(17 * 72 * S), Math.round(11 * 72 * S));
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
drawTable(ctx, { x0: 72, y0: 90, colW: [55, 130, 130, 120, 115, 150, 70, 150], rowH: 15, hdrH: 20, rows, fontPt: 7.5, title: "FINISH SCHEDULE", wrap });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, canvas.toBuffer("image/png"));
console.log(`wrote ${OUT} (${canvas.width} × ${canvas.height})`);
