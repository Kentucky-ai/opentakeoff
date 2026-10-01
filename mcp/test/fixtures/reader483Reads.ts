// The #483 PR A demo / tracked-fixture marquee reads: which page, which box.
// Shared by capture-reader-483-demo.ts (writes the goldens) and the golden
// block in scheduleImport.test.ts (compares live reads to them), so the two
// can't drift. Boxes are the ones scheduleImport.test.ts already reads.
import { fileURLToPath } from "node:url";
import { openPdf } from "../../src/pdf.ts";
import { pageSpans, spansInRect, graphSpans } from "../../../web/src/lib/pageSpans.ts";
import { readScheduleSpans } from "../../../web/src/lib/scheduleRead.ts";
import { readFinishTable } from "../../../web/src/lib/sheetgraph.ts";
import { RENDER_SCALE } from "../../../web/src/lib/takeoffConstants.ts";

type Rect = { x0: number; y0: number; x1: number; y1: number };
const fx = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = fx("../../../web/public/demo/sample-finish-plan.pdf");
const MEP = fx("./mep-set.pdf");
const SYMBOLS = fx("./symbol-set.pdf");
const MULTI = fx("./multibuilding-set.pdf");
/** the page box: a marquee around the whole sheet */
export const SHEET: Rect = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };

export interface DemoRead { name: string; file: string; page: number; rect: Rect }
export const DEMO_READS: DemoRead[] = [
  { name: "demo-p2-table", file: DEMO, page: 2, rect: { x0: 2950, y0: 250, x1: 4720, y1: 1900 } },
  { name: "demo-p2-page", file: DEMO, page: 2, rect: SHEET },
  { name: "symbols-p4-page", file: SYMBOLS, page: 4, rect: SHEET },
  { name: "multi-p3-page", file: MULTI, page: 3, rect: SHEET },
  { name: "mep-p2-page", file: MEP, page: 2, rect: SHEET },
  { name: "mep-p2-register-box", file: MEP, page: 2, rect: { x0: 100, y0: 575, x1: 1200, y1: 860 } },
];

/** The canvas's marquee read of the box (at the MCP's render scale): readScheduleSpans, and readFinishTable(…, { marquee: true }) rows. */
export async function liveDemoRead(d: DemoRead) {
  const ph = await (await openPdf(d.file)).page(d.page);
  const spans = graphSpans(spansInRect(pageSpans(ph.textContent.items, ph.viewport.transform, RENDER_SCALE), d.rect));
  const f = readFinishTable({ key: "crop", spans }, { marquee: true });
  return { readScheduleSpans: readScheduleSpans(spans), finishRows: f ? { otherFamily: "refused" in f, rows: f.table.rows } : null };
}
export const DEMO_GOLDEN_DIR_URL = new URL("./reader-483/", import.meta.url);
export const roundTrip = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));
