import { writeFileSync, copyFileSync, mkdirSync } from "node:fs";
const [root, tag, out, mode] = process.argv.slice(2);          // mode: upright | turned
const { Client } = await import(root + "/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { InMemoryTransport } = await import(root + "/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
const { buildServer } = await import(root + "/mcp/server.ts");
const { Session } = await import(root + "/mcp/src/session.ts");
const built: any = buildServer(new Session(), { suites: ["masonry"], stagedTools: false });
const [a, b] = InMemoryTransport.createLinkedPair();
await (built.server ?? built).connect(a);
const client = new Client({ name: "proof", version: "0" }); await client.connect(b);
const call = async (name: string, args: any = {}) => { const r: any = await client.callTool({ name, arguments: args }); const tx = r.content?.find((c: any) => c.type === "text")?.text ?? "{}"; let d: any; try { d = JSON.parse(tx); } catch { d = { text: tx }; } if (r.isError) console.log(tag, name, "ERROR", JSON.stringify(d).slice(0, 300)); return { d, r }; };
mkdirSync(out + "/work-" + tag, { recursive: true });
const src = out + "/work-" + tag + "/A201.pdf";
copyFileSync(root + "/demo/public-sheets/mo-state-fair-fire-station-A201-exterior-elevations.pdf", src);
const lp = (await call("load_plan", { path: src })).d; let key = lp.sheets?.[0]?.sheet ?? "A201.pdf";
const W = 5184, H = 3456;
let T = (x: number, y: number): [number, number] => [x, y];
if (mode === "turned") {
  const rot = (await call("rotate_page", { sheet: key, angle: 90, output_path: out + "/work-" + tag + "/A201-turned.pdf" })).d;
  console.log(tag, "rotate_page", JSON.stringify(rot).slice(0, 300));
  key = rot.sheet ?? rot.sheets?.[0]?.sheet ?? key;
  T = (x, y) => [H - y, x];                                  // 90° clockwise
}
console.log(tag, "set_scale", JSON.stringify((await call("set_scale", { sheet: key, use_detected: true })).d).slice(0, 200));
const rect = (x0: number, y0: number, x1: number, y1: number) => [T(x0, y0), T(x1, y0), T(x1, y1), T(x0, y1)];
// North elevation brick veneer wainscot, traced on the sheet's own vectors (sheet px, 18 px = 1 ft):
// ground line y 812, top of brick y 746, door 132B trim x 572, door 100A trim x 1857.5
console.log(tag, "wall", JSON.stringify((await call("measure_polygon", { sheet: key, verts: rect(572, 746, 1857.5, 812), condition: "M-WALL-BRICK" })).d).slice(0, 200));
for (const [name, x0, x1] of [["132A/100E pair", 1145.5, 1289], ["100D overhead", 1341.5, 1521.5], ["100C overhead", 1628, 1808]] as [string, number, number][])
  console.log(tag, "opening", name, JSON.stringify((await call("measure_polygon", { sheet: key, verts: rect(x0, 746, x1, 812), condition: "M-OPEN" })).d).slice(0, 160));
const args: any = { walls: "M-WALL-BRICK", unit: "8x2.667", height_ft: 3.6667, joint_reinf_spacing_in: 16, lintel_bearing_in: 8, apply: mode !== "turned" };
if (process.argv[6]) args.view_rotation_deg = Number(process.argv[6]);
const r = (await call("masonry_takeoff", args)).d;
console.log(tag, "RESULT", JSON.stringify({ args, gross_sf: r.gross_sf, openings_sf: r.openings_sf, net_sf: r.net_sf, units_per_sf: r.units_per_sf, unit_count: r.unit_count, unit_count_order: r.unit_count_order, wall_length_lf: r.wall_length_lf, joint_reinforcement_lf: r.joint_reinforcement_lf, lintels: r.lintels }));
const v: any = await client.callTool({ name: "view_sheet", arguments: mode === "turned" ? { sheet: key, overlay: true, px: 2000, region: { x0: H - 880, y0: 420, x1: H - 500, y1: 2000 } } : { sheet: key, overlay: true, px: 2000, region: { x0: 440, y0: 520, x1: 1990, y1: 860 } } });
const img = v.content?.find((c: any) => c.type === "image"); if (img) writeFileSync(`${out}/${tag}.png`, Buffer.from(img.data, "base64")); else console.log(tag, "no image", JSON.stringify(v).slice(0, 300));
process.exit(0);
