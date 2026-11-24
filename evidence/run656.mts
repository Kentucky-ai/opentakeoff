import { writeFileSync } from "node:fs";
const root = process.argv[2], out = process.argv[3];
const { Session } = await import(root + "/mcp/src/session.ts");
const PLAN = root + "/demo/public-sheets/mo-veterans-home-A101-overall-floor-plan.pdf";
async function run(tag: string, prefixes?: string[]) {
  const s = new Session();
  const { sheets } = await s.loadPlan(PLAN);
  const key = sheets[0].sheet;
  s.setScale(key, { use_detected: true });
  const r: any = await s.detectRooms(key, { condition: "FLOOR", role: "floor_area", returnVerts: false, ...(prefixes ? { labelPrefixes: prefixes } : {}) });
  const labels = s.shapes.map((x: any) => x.label).sort();
  const sf = s.shapes.reduce((n: number, x: any) => n + (x.computed?.area_sf ?? 0), 0);
  console.log(JSON.stringify({ tag, key, detected: r.detected, committed: s.shapes.length, total_sf: Math.round(sf), labels, keys: Object.keys(r), withheld: (r.withheld ?? r.skipped ?? []).length }, null, 0));
  const v: any = await s.viewSheet(key, { px: 3000, overlay: true });
  const img = v.png ?? v.image ?? v.data ?? v.content?.find?.((c: any) => c.type === "image")?.data;
  if (!img) console.log("view keys", Object.keys(v)); else writeFileSync(`${out}/${tag}.png`, typeof img === "string" ? Buffer.from(img, "base64") : img);
  return r;
}
await run("before-no-prefix");
const r = await run("after-prefix-C", ["C"]);
console.log(JSON.stringify(r).slice(0, 1500));
