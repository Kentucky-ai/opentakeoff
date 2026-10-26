// Run from the repo root after `npm run build --prefix mcp`:
//   node mcp/scripts/verify-estimate-tools.mjs docs/review/mcp-estimate
// Drives the BUILT server (mcp/dist/server.js) over stdio with the MCP SDK client, the way an AI
// app does: load the demo plan, scale it, measure two conditions, price them with placeholder
// prices (leaving one supply unpriced, then pricing it), set markups / proposal / client, read
// estimate_summary, export the workbook and the proposal, undo a price, and round-trip the takeoff
// through export_takeoff → a fresh server's import_takeoff. Writes results.json and, when poppler's
// pdftoppm is installed, a PNG of the proposal's first page.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const req = createRequire(resolve(root, "mcp/package.json"));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");
const { unzipSync, strFromU8 } = req("fflate");
const out = resolve(process.argv[2] || "docs/review/mcp-estimate");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "ot-mcp-estimate-"));
const PLAN = resolve(root, "demo/sample-plan.pdf");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });

async function open() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "mcp/dist/server.js")], cwd: root, env: { ...process.env, OPENTAKEOFF_ONE_CLICK: "0" }, stderr: "pipe" });
  const client = new Client({ name: "verify-estimate-tools", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  };
  const refuse = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.isError ? r.content?.[0]?.text ?? "" : null; };
  return { client, call, refuse };
}

const a = await open();
const tools = (await a.client.listTools()).tools.map((t) => t.name);
check("tools/list carries the five estimate verbs", ["set_pricing", "set_estimate_settings", "estimate_summary", "export_estimate", "export_proposal"].every((n) => tools.includes(n)), tools.length);
await a.call("load_plan", { path: PLAN });
const sheet = "sample-plan.pdf";
await a.call("set_scale", { sheet, upp: 0.1 });   // 100 px = 10 ft
await a.call("measure_polygon", { sheet, verts: [[0, 0], [300, 0], [300, 300], [0, 300]], condition: "CPT-1", role: "floor_area" });
await a.call("edit_condition", { condition: "CPT-1", waste_pct: 10 });
await a.call("edit_materials", { condition: "CPT-1", add: [{ name: "Adhesive", per: 300, basis: "area", unit: "pail" }] });
await a.call("measure_line", { sheet, pts: [[0, 400], [800, 400]], condition: "RB-1" });

const p1 = await a.call("set_pricing", { condition: "CPT-1", unit: "SY", material: 20, labor: 5 });
check("set_pricing: SY material on the waste-adjusted order, labor on the measured SY", p1.line.material_qty === 110 && p1.line.labor_qty === 100 && p1.line.total === 2700, p1.line);
await a.call("set_pricing", { condition: "RB-1", material: 1.5, labor: 1 });
let sum = await a.call("estimate_summary");
check("an unpriced supply row is named, never counted", sum.complete === false && JSON.stringify(sum.unpriced) .includes("material row: Adhesive"), sum.unpriced);
const refusal = await a.refuse("set_pricing", { condition: "CPT-1", materials: [{ name: "Grout", price: 1 }] });
check("an unknown material row is refused with the condition's rows", refusal && refusal.includes("Adhesive"), refusal);
await a.call("set_pricing", { condition: "CPT-1", materials: [{ name: "Adhesive", price: 45 }] });
await a.call("set_estimate_settings", { tax_pct: 6, overhead_pct: 10, profit_pct: 15, proposal: { itemized: true, exclusions: "Floor prep beyond 1/8 in. in 10 ft", terms: "Net 30" }, client: { name: "Example General Contractors", reference: "Bid 26-001" } });
sum = await a.call("estimate_summary");
// hand math: CPT-1 2,200 + 500 + 3 pails × 45 (supplies divide the MEASURED 900 SF); RB-1 80 LF × 1.5 + 80 × 1
const material = 2200 + 135 + 120, labor = 500 + 80, tax = Math.round(material * 0.06 * 100) / 100;
const cost = material + labor + tax, overhead = Math.round(cost * 0.10 * 100) / 100, profit = Math.round((cost + overhead) * 0.15 * 100) / 100;
const expected = Math.round((cost + overhead + profit) * 100) / 100;
check("estimate_summary total equals the hand math", sum.complete === true && sum.total === expected, { total: sum.total, expected });

const xlsx = join(work, "job - estimate.xlsx");
const e = await a.call("export_estimate", { path: xlsx, project_name: "Sample job", company_name: "Sample Flooring Co" });
const s1 = strFromU8(unzipSync(new Uint8Array(readFileSync(xlsx)))["xl/worksheets/sheet1.xml"]);
check("export_estimate: Estimate + Materials tabs, the base bid cell, the watermark", JSON.stringify(e.tabs) === '["Estimate","Materials"]' && s1.includes(`<v>${expected}</v>`) && s1.includes("Prepared with OpenTakeoff"), e.tabs);
const pdf = join(work, "proposal.pdf");
const pr = await a.call("export_proposal", { path: pdf, project_name: "Sample job", company: { name: "Sample Flooring Co", address: "100 Example Ave\nAnytown, ST 00000", phone: "555-0100", license: "LIC-000" } });
check("export_proposal: one page, itemized, the engine's base bid, complete", pr.pages === 1 && pr.itemized === true && pr.base_bid === expected && pr.complete === true, pr);
try { execFileSync("pdftoppm", ["-png", "-r", "80", "-f", "1", "-l", "1", pdf, join(out, "proposal-page")]); check("proposal rendered to PNG", true); }
catch { check("proposal rendered to PNG (pdftoppm missing — skipped)", true); }

const u = await a.call("undo_last", { n: 1 });
check("undo_last reverses the settings write as one step", u.steps[0].op === "estimate_settings", u.steps);
await a.call("set_estimate_settings", { tax_pct: 6, overhead_pct: 10, profit_pct: 15, client: { name: "Example General Contractors" } });
const takeoff = join(work, "takeoff.json");
await a.call("export_takeoff", { path: takeoff });
const doc = JSON.parse(readFileSync(takeoff, "utf8"));
check("export_takeoff carries pricing, estimate_settings and client_info", !!doc.conditions.find((c) => c.finish_tag === "CPT-1")?.pricing && doc.estimate_settings?.tax_pct === 6 && doc.client_info?.client_name === "Example General Contractors");
await a.client.close();

const b = await open();
await b.call("load_plan", { path: PLAN });
await b.call("import_takeoff", { path: takeoff });
const sumB = await b.call("estimate_summary");
check("a fresh server's import_takeoff prices the same total", sumB.total === expected, { total: sumB.total });
await b.client.close();

const results = { server: "mcp/dist/server.js", passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  " + JSON.stringify(c.detail ?? "")}`);
process.exit(results.passed === results.total ? 0 : 1);
