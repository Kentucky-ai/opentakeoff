// Run from the repo root after `npm run build --prefix mcp`:
//   node --import ./web/node_modules/tsx/dist/loader.mjs docs/review/mcp-line-pricing/verify.mjs
// Two halves, both on placeholder prices and the bundled demo plan (no private drawings):
// 1. The BUILT MCP server over stdio (mcp/dist/server.js, the MCP SDK client): set_pricing prices
//    a condition's SF, LF and EA lines; estimate_summary lists every line; an old `unit` call is
//    unchanged; a bordered linear condition (imported, as the canvas writes it) reads complete.
// 2. Engine parity: the same saved bordered-linear projects priced by the engine before #597
//    (git d9d2fd15^), on main before this PR (0e1e0be0), and on this branch. Writes results.json next to this file.
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const req = createRequire(resolve(root, "mcp/package.json"));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");
const work = mkdtempSync(join(tmpdir(), "ot-line-pricing-"));
const PLAN = resolve(root, "demo/sample-plan.pdf");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });

async function open() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "mcp/dist/server.js")], cwd: root, env: { ...process.env, OPENTAKEOFF_ONE_CLICK: "0" }, stderr: "pipe" });
  const client = new Client({ name: "verify-line-pricing", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  };
  const refuse = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.isError ? r.content?.[0]?.text ?? "" : null; };
  return { client, call, refuse };
}
const lineRow = (l) => [l.unit, l.main, l.optional, l.material_qty, l.labor_qty, l.material_rate, l.labor_rate, l.status, l.missing];

// ── 1. stdio ────────────────────────────────────────────────────────────────
const a = await open();
const tools = (await a.client.listTools()).tools;
const sp = tools.find((t) => t.name === "set_pricing");
check("set_pricing advertises `line`; its description no longer says first line only", sp.inputSchema.properties.line && !/first line only|first one per condition/.test(sp.description + tools.find((t) => t.name === "estimate_summary").description));
const sheet = "sample-plan.pdf";
await a.call("load_plan", { path: PLAN });
await a.call("set_scale", { sheet, upp: 0.1 });   // 100 px = 10 ft
await a.call("measure_polygon", { sheet, verts: [[0, 0], [300, 0], [300, 300], [0, 300]], condition: "CPT-1", role: "floor_area" });   // 900 SF
await a.call("edit_condition", { condition: "CPT-1", waste_pct: 5 });
await a.call("measure_line", { sheet, pts: [[0, 400], [800, 400]], condition: "CPT-1" });   // 80 LF plain run
await a.call("place_count", { sheet, points: [[500, 500], [600, 500]], condition: "CPT-1" });   // 2 EA
const p1 = await a.call("set_pricing", { condition: "CPT-1", unit: "SY", material: 30, labor: 6 });
check("main-line call unchanged: SY rates on the main line, reply names the other unpriced lines", p1.line.unit === "SY" && p1.lines.length === 3 && /LF \(material, labor\); EA/.test(p1.note), { line: lineRow(p1.line), note: p1.note });
const p2 = await a.call("set_pricing", { condition: "CPT-1", line: "LF", material: 2, labor: 1.5 });
const p3 = await a.call("set_pricing", { condition: "CPT-1", line: "EA", material: 40, labor: 25 });
check("line LF / EA write pricing.by_unit", JSON.stringify(p3.pricing) === JSON.stringify({ unit: "SY", material: 30, labor: 6, by_unit: { LF: { material: 2, labor: 1.5 }, EA: { material: 40, labor: 25 } } }), p3.pricing);
const sum = await a.call("estimate_summary");
check("estimate_summary: every line with unit, quantities, rates, status, missing; complete", sum.complete === true && sum.lines.length === 3, sum.lines.map(lineRow));
// hand math: 900 SF × 1.05 ÷ 9 = 105 SY × 30 + 100 SY × 6; 84 LF × 2 + 80 × 1.5; 2 × 40 + 2 × 25
const expected = 105 * 30 + 100 * 6 + 84 * 2 + 80 * 1.5 + 2 * 40 + 2 * 25;
check("total equals the hand math", sum.total === expected, { total: sum.total, expected });
const r1 = await a.refuse("set_pricing", { condition: "CPT-1", line: "SF", material: 1 });
check("line SF on an SY main area line is refused (it would misprice the main line)", r1 && /main line, priced in SY/.test(r1), r1);
const old = await a.call("set_pricing", { condition: "CPT-1", unit: "LF", material: 2 });
check("old call: unit LF still switches the MAIN line's unit (by_unit untouched)", old.line.unit === "LF" && old.line.main === true && old.pricing.by_unit.LF.labor === 1.5, lineRow(old.line));

// a bordered linear condition as the canvas saves it: thickness 4 in, border SF on each run
await a.call("measure_line", { sheet, pts: [[0, 700], [1200, 700]], condition: "BR-1" });   // 120 LF
await a.call("set_pricing", { condition: "BR-1", material: 5, labor: 3 });
const doc = await a.call("export_takeoff");
const br = doc.conditions.find((c) => c.finish_tag === "BR-1");
br.thickness_in = 4;
for (const s of doc.shapes.filter((s) => s.condition_id === br.id)) s.computed.area_sf = +(s.computed.perimeter_lf * 4 / 12).toFixed(2);
const file = join(work, "bordered.json");
writeFileSync(file, JSON.stringify(doc));
const b = await open();
await b.call("load_plan", { path: PLAN });
await b.call("import_takeoff", { path: file });
await b.call("set_pricing", { condition: "CPT-1", unit: "SY" });
const bs = await b.call("estimate_summary");
const brLines = bs.lines.filter((l) => l.finish_tag === "BR-1");
check("bordered BR-1 priced on its SF: SF priced, LF optional, nothing unpriced, complete", bs.complete === true && bs.unpriced.length === 0 && JSON.stringify(brLines.map((l) => [l.unit, l.status])) === '[["SF","priced"],["LF","optional"]]', { lines: brLines.map(lineRow), note: bs.note });
check("BR-1 totals 40 SF × $5 + 40 SF × $3 = $320, as one line did before #597", brLines[0].total === 320 && brLines[1].total === 0, brLines.map((l) => l.total));
const x = await b.call("export_estimate", { path: join(work, "b - estimate.xlsx"), project_name: "B" });
check("export_estimate: no Unpriced tab", JSON.stringify(x.tabs) === '["Estimate","Materials"]', x.tabs);
await b.call("set_estimate_settings", { proposal: { itemized: true } });
const pdf = join(work, "proposal.pdf");
const pr = await b.call("export_proposal", { path: pdf, project_name: "Line pricing sample", company: { name: "Sample Flooring Co" } });
check("export_proposal: complete, nothing unpriced", pr.complete === true && pr.unpriced.length === 0, pr.unpriced);
try { execFileSync("pdftoppm", ["-png", "-r", "80", "-f", "1", "-l", "1", "-singlefile", pdf, join(here, "proposal-included")]); check("proposal page rendered to proposal-included.png", true); }
catch { check("proposal render skipped (pdftoppm missing)", true); }
await a.client.close(); await b.client.close();

// ── 2. engine parity: pre-#597 / main / this branch ─────────────────────────
const W = resolve(root, "web/src/lib");
const engine = (rev, name) => {
  const src = execFileSync("git", ["show", `${rev}:web/src/lib/estimate.js`], { cwd: root, encoding: "utf8" })
    .replace(/"\.\/num\.js"/, JSON.stringify(pathToFileURL(join(W, "num.js")).href))
    .replace(/"\.\/totals\.js"/, JSON.stringify(pathToFileURL(join(W, "totals.js")).href));
  const f = join(work, `${name}.mjs`); writeFileSync(f, src); return f;
};
const { conditionTotals } = await import(pathToFileURL(join(W, "totals.js")).href);
const { priceEstimate: branch } = await import(pathToFileURL(join(W, "estimate.js")).href);
const { priceEstimate: pre } = await import(pathToFileURL(engine("d9d2fd15^", "pre597")).href);
const { priceEstimate: main } = await import(pathToFileURL(engine("0e1e0be0", "main")).href);
const lin = (id, lf, tin) => ({ condition_id: id, measure_role: "linear", computed: { perimeter_lf: lf, area_sf: +(lf * tin / 12).toFixed(2) } });
const cases = [
  ["BR-1 4 in border, priced on SF, 10% waste", [{ id: "a", finish_tag: "BR-1", thickness_in: 4, waste_pct: 10, pricing: { material: 5, labor: 3 } }], [lin("a", 80, 4), lin("a", 40, 4)]],
  ["BR-2 6 in border, SY picked", [{ id: "b", finish_tag: "BR-2", thickness_in: 6, waste_pct: 5, pricing: { unit: "SY", material: 42, labor: 9 } }], [lin("b", 212.5, 6)]],
  ["RB-4 4 in run, LF picked", [{ id: "c", finish_tag: "RB-4", thickness_in: 4, waste_pct: 3, pricing: { unit: "LF", material: 1.8, labor: 1.1 } }], [lin("c", 310, 4), lin("c", 95.25, 4)]],
  ["BR-3 12 in border, labor only (material $0)", [{ id: "d", finish_tag: "BR-3", thickness_in: 12, pricing: { material: 0, labor: 4 } }], [lin("d", 66, 12)]],
];
const parity = cases.map(([name, conds, shapes]) => {
  const rows = conditionTotals(conds, shapes);
  const sumUp = (f) => { const e = f({ rows, conditions: conds }); return { total: e.total, complete: e.complete, lines: e.lines.map((l) => `${l.unit}:${l.status}`) }; };
  return { case: name, pre597: sumUp(pre), main: sumUp(main), branch: sumUp(branch) };
});
for (const p of parity) check(`parity: ${p.case} — same total and complete as pre-#597`, p.branch.total === p.pre597.total && p.branch.complete === p.pre597.complete, p);

const passed = checks.filter((c) => c.ok).length;
writeFileSync(join(here, "results.json"), JSON.stringify({ passed, total: checks.length, checks }, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
console.log(`${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
