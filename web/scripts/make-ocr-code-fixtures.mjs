// Provenance recipe, not needed to run the frozen PNG fixtures.
// Rendering depends on installed fonts and canvas/platform versions. Write to
// a separate directory; compare hashes before deliberately replacing fixtures.
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/make-ocr-code-fixtures.mjs <new-output-directory>");
const output = resolve(destination);
const truth = JSON.parse(readFileSync(new URL("../test/fixtures/ocr-codes/truth.json", import.meta.url), "utf8"));
const fonts = GlobalFonts.families;
for (const fixture of truth.fixtures) if (!fonts.some((f) => f.family === fixture.font)) throw new Error(`Install ${fixture.font} to reproduce this recipe; no font files are bundled.`);
mkdirSync(output, { recursive: true });
for (const fixture of truth.fixtures) {
  const s = fixture.dpi / 72, rowH = 20 * s, x0 = 16 * s, y0 = 28 * s, keyW = 65 * s, descW = 195 * s;
  const canvas = createCanvas(fixture.width, fixture.height), g = canvas.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000"; g.strokeStyle = "#000"; g.lineWidth = 0.5 * s;
  g.font = `${fixture.weight} ${fixture.fontPt * s}px "${fixture.font}"`; g.textBaseline = "middle";
  ["CODE", ...fixture.rows.map((r) => r.expected)].forEach((code, i) => {
    const y = y0 + i * rowH;
    g.strokeRect(x0, y, keyW, rowH); g.strokeRect(x0 + keyW, y, descW, rowH);
    g.fillText(code, x0 + 2 * s, y + rowH / 2);
    g.fillText(i ? "MATERIAL / SERIES ALPHA / GREY" : "DESCRIPTION", x0 + keyW + 4 * s, y + rowH / 2);
  });
  const png = canvas.toBuffer("image/png"); writeFileSync(join(output, fixture.file), png);
  const hash = createHash("sha256").update(png).digest("hex");
  console.log(`${fixture.id}: ${hash === fixture.sha256 ? "matches" : "DIFFERS"} ${hash}`);
}
