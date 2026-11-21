// Reproduces the numbers in the PR that added revision_delta.
//   cd mcp && node --import tsx ../docs/reviews/revision-delta-ledger/measure.mts
// Pass a directory as the first argument to also write the ledger and crops there.
//
// The sheets are real: Missouri OA/FMDC project T2327-01, sheet A-100 as bid and
// as reissued by Addendum 2 (demo/public-sheets/README.md has the sources).
// The takeoff below is small and illustrative: one slab traced on the wall
// faces and sixteen bollards counted at the door jambs.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Session } from "../../../mcp/src/session.ts";

const sheets = fileURLToPath(new URL("../../../demo/public-sheets/", import.meta.url));
const B = "mo-albany-maintenance-A-100-floor-plan.pdf";
const R = "mo-albany-maintenance-A-100-floor-plan-addendum-2.pdf";
const out = process.argv[2];

const s = new Session();
await s.loadPlan(sheets + B);
await s.loadPlan(sheets + R, { merge: true });

const qty = (rows: { condition: string; floor_sf?: number; ea?: number }[]) =>
  rows.map((q) => `${q.condition} ${q.floor_sf !== undefined ? `${q.floor_sf} SF` : `${q.ea} EA`}`).join(", ") || "none";
const report = (label: string, d: Awaited<ReturnType<Session["revisionDelta"]>>) => {
  console.log(`\n${label}`);
  console.log(`  entries ${d.counts.entries}, needing review ${d.counts.needs_review}, by status ${JSON.stringify(d.counts.by_status)}`);
  console.log(`  exposure: ${qty(d.totals.exposure)} | delta: ${qty(d.totals.delta)} | unattributed: ${qty(d.totals.unattributed)}`);
  for (const e of d.entries.filter((x) => x.status !== "outside_takeoff")) {
    console.log(`  ${e.id} ${e.status} [${e.review.join(", ")}] before: ${qty(e.before.quantities)} | after: ${qty(e.after.quantities)} | delta: ${e.delta ? qty(e.delta) : "not stated"}`);
  }
};

let t = performance.now();
let d = await s.revisionDelta({ base: B, revised: R });
const ms = Math.round(performance.now() - t);
const text = d.entries.flatMap((e) => e.text_changes);
console.log(`No takeoff: ${d.sheets[0].changed_regions} changed regions (${d.sheets[0].specks_ignored} speck ignored), ${d.sheets[0].text_changes} text changes, alignment ${d.sheets[0].alignment.method} ${d.sheets[0].alignment.confidence}, ${ms} ms including geometry extraction`);
const detail = d.entries.find((e) => e.text_changes.some((x) => x.after === "BOLLARD LOCATION PLAN"))!;
console.log(`Added detail: ${detail.id} ${detail.change}, ${detail.segment_count} segments, bounds ${detail.bounds_base!.map(Math.round).join(" ")}`);
console.log(`Title block: ${text.filter((x) => x.type === "changed").map((x) => `${x.before} -> ${x.after}`).join("; ")}; added ${["ADDENDUM #2", "07/16/25"].filter((w) => text.some((x) => x.after === w)).join(", ")}; removed ${["DRAFT"].filter((w) => text.some((x) => x.before === w)).join(", ")}`);

s.setScale(B, { label: `3/16" = 1'-0"` });
s.setScale(R, { label: `3/16" = 1'-0"` });
s.measurePolygon(B, [[2294, 626.5], [3477.5, 626.5], [3477.5, 3021.5], [2294, 3021.5]], { condition: "SC-1", role: "floor_area" });
const rows = [882.6, 1338.3, 1395.3, 1851, 1907.9, 2363.6, 2420.6, 2876.3];
s.placeCount(B, rows.flatMap((y) => [[3462.8, y], [3520.2, y]] as [number, number][]), { condition: "BOLLARD" });

// What compare_sheets flags for the same takeoff (shape ids on the base sheet).
const cmp = await s.compareSheets(B, R);
const baseShapes = s.listShapes({ sheet: B }).shapes;
const flagged = baseShapes.filter((x) => cmp.flagged_shape_ids.includes(x.id));
console.log(`\ncompare_sheets on 17 shapes: flags ${flagged.filter((x) => x.measure_role === "floor_area").length} slab, ${flagged.filter((x) => x.measure_role === "count").length} of 16 bollards`);

report("1. Base takeoff only", await s.revisionDelta({ base: B, revised: R }));
d = await s.revisionDelta({ base: B, revised: R, carry: true });
report(`2. After carry (${JSON.stringify(d.carry!.carried)})`, d);

const revised = s.listShapes({ sheet: R }).shapes;
const d3 = d.entries.find((e) => e.before.quantities.some((q) => q.condition === "BOLLARD"))!;
const moved = d3.after.shape_ids.filter((id) => revised.find((x) => x.id === id)!.measure_role === "count");
const targets: [number, number][] = [[3461.3, 1850.1], [3520.9, 1850.1], [3461.3, 1908.6], [3520.7, 1908.5]];
moved.forEach((id, i) => s.editShape(id, { verts: [targets[i]] }));
s.markVerdict({ shape_id: revised.find((x) => x.measure_role === "floor_area")!.id, text: "Addendum 2: slab outline unchanged" });
d = await s.revisionDelta({ base: B, revised: R });
report("3. After recheck (4 bollards re-placed, slab marked checked)", d);

if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/ledger.json`, JSON.stringify(d, null, 1));
  writeFileSync(`${out}/ledger.csv`, s.revisionDeltaCsv(d));
  const shots: [string, string, [number, number, number, number], boolean][] = [
    ["1-base-grid-D3", B, [3330, 1760, 3760, 2020], true],
    ["2-addendum-2-grid-D3", R, [3330, 1760, 3760, 2020], true],
    ["3-addendum-2-added-detail", R, [3700, 2450, 4650, 3420], false],
  ];
  for (const [name, sheet, [x0, y0, x1, y1], overlay] of shots) {
    const v = await s.viewSheet(sheet, { region: { x0, y0, x1, y1 }, px: 1100, overlay });
    writeFileSync(`${out}/${name}.png`, Buffer.from(v.png));
  }
}
