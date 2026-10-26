// The scan star — the agent's mark, drawn in the app (brand/marks.jsx) and on every exported
// PDF's watermark (lib/pdfWatermark.js) from one geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { scanStarRows } from "../src/lib/scanStar.js";
import { stampWatermark, STAR_OPACITY } from "../src/lib/pdfWatermark.js";

test("scanStarRows: the centre row runs tip to tip, rows mirror about it and narrow toward the points", () => {
  for (const [n, reach] of [[7, 1], [11, 1.6], [23, 2.4]]) {
    const rows = scanStarRows(n, reach);
    const mid = (n - 1) / 2;
    assert.equal(rows.length, n);
    assert.equal(rows[mid].w, 2 * reach);
    for (let i = 0; i < mid; i++) {
      assert.ok(Math.abs(rows[i].w - rows[n - 1 - i].w) < 1e-9, "mirrored");
      assert.ok(rows[i].w <= rows[i + 1].w, "narrows toward the top point");
      assert.ok(rows[i].x >= -reach && rows[i].y >= -1 && rows[i].y + rows[i].h <= 1, "inside its box");
    }
  }
});

test("watermark: every page gets the centre star and the footer star, on a rotated sheet too", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [size, rot] of [[[612, 792], 0], [[792, 612], 90]] as const) {
    const page = doc.addPage([...size]); page.setRotation(degrees(rot));
    const rects: any[] = [];
    const real = page.drawRectangle.bind(page);
    page.drawRectangle = (o: any) => { rects.push(o); real(o); };
    stampWatermark(page, { font, rgb, degrees });
    assert.equal(rects.filter((r) => r.opacity === STAR_OPACITY).length, 23, "centre star: 23 faint rows");
    assert.equal(rects.filter((r) => r.opacity === undefined).length, 7, "footer star: 7 solid rows");
    assert.ok(rects.every((r) => r.rotate.angle === rot), "rows follow the page's /Rotate");
  }
});
