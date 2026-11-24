import { writeFileSync } from "node:fs";
const [root, tag, out] = process.argv.slice(2);
const { Session } = await import(root + "/mcp/src/session.ts");
const s = new Session();
const { sheets } = await s.loadPlan(root + "/demo/public-sheets/mo-veterans-home-A111-reflected-ceiling-plan.pdf");
const key = sheets[0].sheet;
s.setScale(key, { use_detected: true });
const K = 5184 / 2000;
const seeds: [string, number, number][] = [["N1",760,240],["N2",863,333],["N3",700,480],["N4",770,400],["E1",1000,625],["E2",1210,490],["E3",1260,640],["E4",1075,470],["W1",250,530],["W2",400,700],["S1",640,1000],["S2",900,1100],["COR",820,300]];
const rows: any[] = [];
for (const [id, ix, iy] of seeds) {
  const x = ix * K + 4, y = iy * K + 4;
  try {
    const r: any = await s.oneClick(key, x, y, { condition: "ACT-1", role: "floor_area", returnVerts: false });
    rows.push({ id, x: Math.round(x), y: Math.round(y), area_sf: r.area_sf ?? r.shape?.computed?.area_sf, conf: r.confidence, hatch: r.hatch_filtered ?? r.hatchFiltered, keys: rows.length ? undefined : Object.keys(r) });
  } catch (e: any) { rows.push({ id, x: Math.round(x), y: Math.round(y), error: String(e.message).slice(0, 160) }); }
}
for (const r of rows) console.log(tag, JSON.stringify(r));
console.log(tag, "committed", s.shapes.length, "total_sf", Math.round(s.shapes.reduce((n: number, x: any) => n + (x.computed?.area_sf ?? 0), 0)));
const v: any = await s.viewSheet(key, { px: 3000, overlay: true, region: { x0: 300, y0: 100, x1: 3700, y1: 3300 } });
writeFileSync(`${out}/${tag}.png`, Buffer.from(v.png ?? v.image, "base64"));
