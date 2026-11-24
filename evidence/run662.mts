import { writeFileSync } from "node:fs";
const [root, out] = process.argv.slice(2);
const { Client } = await import(root + "/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { InMemoryTransport } = await import(root + "/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
const { buildServer } = await import(root + "/mcp/server.ts");
const { Session } = await import(root + "/mcp/src/session.ts");
const [ct, st] = InMemoryTransport.createLinkedPair();
await buildServer(new Session(), { suites: ["concrete"], stagedTools: false }).connect(st);
const c = new Client({ name: "s101", version: "0" }); await c.connect(ct);
const call = async (name: string, args: any = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; let d; try { d = JSON.parse(t) } catch { d = t } if (r.isError) console.log("ERR", name, t.slice(0, 300)); return d; };
const PDF = root + "/demo/public-sheets/mo-albany-maintenance-S-101-foundation.pdf";
const KEY = "mo-albany-maintenance-S-101-foundation.pdf";
await call("load_plan", { path: PDF });
const sc = await call("set_scale", { sheet: KEY, label: '1/8" = 1\'-0"' }); console.log("scale", JSON.stringify(sc).slice(0, 200));
const P = (x: number, y: number) => [440 + 1.5 * x, 1080 + 1.5 * y];
const rect = (a: number[], b: number[]) => [a, [b[0], a[1]], b, [a[0], b[1]]];
await call("measure_polygon", { sheet: KEY, verts: rect(P(100, 190), P(620, 1230)), condition: "C-SOG-6" });
const g = rect(P(88, 183), P(632, 1225)); await call("measure_line", { sheet: KEY, pts: [...g, g[0]], condition: "C-FTG-GB1" });
await call("place_count", { sheet: KEY, condition: "C-PAD-A", points: [[88,183],[270,183],[452,183],[88,1225],[270,1225],[452,1225],[632,1225]].map(([x,y]) => P(x,y)) });
await call("place_count", { sheet: KEY, condition: "C-PAD-B", points: [[88,520],[88,748],[88,975],[610,520],[610,748],[610,975]].map(([x,y]) => P(x,y)) });
await call("place_count", { sheet: KEY, condition: "C-PAD-C", points: [P(632, 183)] });
const r = await call("concrete_takeoff", {
  slabs: [{ condition: "C-SOG-6", thickness_in: 6, edge_form: false, bars: { size: "#4", spacing_in: 12 }, base_depth_in: 4, vapor_barrier: true }],
  footings: [{ condition: "C-FTG-GB1", width_in: 18, depth_in: 36, bars: { size: "#6", count: 6 } }],
  pads: [
    { condition: "C-PAD-A", length_ft: 4, width_ft: 4, depth_in: 12 },
    { condition: "C-PAD-B", length_ft: 5.5, width_ft: 5.5, depth_in: 12 },
    { condition: "C-PAD-C", length_ft: 7.5, width_ft: 7.5, depth_in: 18 }],
});
writeFileSync(out + "/s101-concrete.json", JSON.stringify(r, null, 2));

const vr: any = await c.callTool({ name: "view_sheet", arguments: { sheet: KEY, overlay: true, px: 1400, region: { x0: 440, y0: 1080, x1: 1640, y1: 3180 } } });
const im = vr.content.find((x: any) => x.type === "image"); writeFileSync(out + "/s101-overlay.png", Buffer.from(im.data, "base64"));
const rep = await call("export_report"); writeFileSync(out + "/s101-report.json", JSON.stringify(rep, null, 2));
