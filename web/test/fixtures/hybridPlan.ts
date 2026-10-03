// The synthetic hybrid sheet (#489), built in-test: the bundled demo's page 1
// (a vector finish plan, ~160 lines of text layer) with a raster picture of
// a schedule pasted into a clear band, the case the scan rule never offers a
// read for. The picture (hybrid/material-floor-base.png, from
// mcp/scripts/make-hybrid-png.mjs) is page 2's MATERIAL SCHEDULE FLOORING
// and BASE blocks at 216 DPI, so its codes are on page 2's text layer but
// nowhere on page 1's. Only the tag and MATERIAL/PRODUCT columns are left in
// it: everything right of the MATERIAL/PRODUCT | MANUFACTURER ruling is
// painted white (no brand names in sample data), the rulings between rows
// kept. Not a test file: pictures.test.ts builds it, and
// scripts/write-hybrid-fixture.ts writes it to disk for the browser checks.
//
// The band 580–1880 × 1240–1740 pt (from the top) of demo page 1 holds no
// ink, no text run and no image, so the picture lands on blank paper. Over
// it go short vector callouts (text runs, so they're on the text layer):
// "callouts" draws 2 over the picture and 1 beside it, so the picture stays
// unread (≤ 8 lines over it); "notes" draws 9 note lines over it, one past
// the line limit, the negative case.
//
// pdf-lib metadata stamping is off (load and create), so the same inputs give
// the same bytes.
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const DEMO = new URL("../../public/demo/sample-finish-plan.pdf", import.meta.url);
const PNG = new URL("./hybrid/material-floor-base.png", import.meta.url);

/** Where the picture sits, in pt from the page's top-left (944 × 249.8 pt, 45.5 sq in). */
export const PICTURE = { x0: 640, y0: 1320, x1: 1584, y1: 1569.8 };

/** Callout text, in pt from the top-left: [text, x, baseline y]. */
const CALLOUTS: Array<[string, number, number]> = [
  ["SEE NOTE 4", 700, 1400],
  ["MATCH EXISTING", 900, 1500],
  ["FIELD VERIFY", 1650, 1450],   // beside the picture
];
/** Nine note lines over the picture, 25 pt apart. */
const NOTES: Array<[string, number, number]> = Array.from({ length: 9 }, (_, i) =>
  [`NOTE ${i + 1} PROVIDE TRANSITION AT DOOR`, 680, 1345 + i * 25]);

export type HybridVariant = "callouts" | "notes";

/** The hybrid sheet as PDF bytes: one 3024 × 2160 pt page. `rotate` sets the
 *  page's /Rotate. */
export async function buildHybridPlan(variant: HybridVariant = "callouts", rotate = 0): Promise<Uint8Array> {
  const src = await PDFDocument.load(readFileSync(DEMO), { updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  const [sheet] = await out.embedPdf(src, [0]);
  const { width: W, height: H } = sheet;
  const page = out.addPage([W, H]);
  page.drawPage(sheet, { x: 0, y: 0 });
  const img = await out.embedPng(readFileSync(PNG));
  // pdf-lib draws from the bottom-left
  page.drawImage(img, { x: PICTURE.x0, y: H - PICTURE.y1, width: PICTURE.x1 - PICTURE.x0, height: PICTURE.y1 - PICTURE.y0 });
  const font = await out.embedFont(StandardFonts.Helvetica);
  for (const [text, x, y] of variant === "notes" ? NOTES : CALLOUTS) {
    page.drawText(text, { x, y: H - y, size: 12, font, color: rgb(0.8, 0, 0) });
  }
  if (rotate) page.setRotation(degrees(rotate));
  return out.save();
}
