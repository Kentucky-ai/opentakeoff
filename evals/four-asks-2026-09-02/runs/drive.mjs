#!/usr/bin/env node
// Scripted MCP session driver for this eval: read a JSON array of {tool, args, note?, save?,
// openings_from?} steps from argv[1], run them in ONE stdio session against the published
// opentakeoff-mcp server, print each structured result with its wall-clock ms, and save any
// image content when `save` names a stem (argv[2] = output dir). `openings_from` resolves
// derive_base openings from the previous list_shapes reply. No app UI, no human edits mid-run.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const steps = JSON.parse(readFileSync(process.argv[2], "utf8"));
const OUT = process.argv[3] ?? join(HERE, "..", "out");
mkdirSync(OUT, { recursive: true });

// OT_SERVER overrides the published dist — e.g. a source checkout's server
// via tsx, for testing an unreleased engine against real sheets.
const server = process.env.OT_SERVER
  ? process.env.OT_SERVER.split(" ")
  : [join(HERE, "..", "node_modules", "opentakeoff-mcp", "dist", "server.js")];
const proc = spawn(process.execPath, server, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const pending = new Map(); let id = 0;
createInterface({ input: proc.stdout }).on("line", (l) => {
  try { const m = JSON.parse(l); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
});
const req = (method, params) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => { if (pending.has(i)) rej(new Error(`timeout ${method}`)); }, 300_000);
});
await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drive", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const last = {};
const walk = (o, out=[]) => { if (Array.isArray(o)) o.forEach(v=>walk(v,out)); else if (o && typeof o==="object") { if (o.id && (o.condition||o.tag)) out.push(o); for (const v of Object.values(o)) walk(v,out); } return out; };
for (const step of steps) {
  if (step.openings_from) { const shapes = walk(last.list_shapes).filter(s => (s.condition===step.openings_from.condition || s.tag===step.openings_from.condition) && (!s.role || s.role==="floor_area")); step.args.openings = shapes.map(s => ({shape_id: s.id, lf: step.openings_from.lf})); console.log(`\n--- openings resolved from list_shapes: ${JSON.stringify(step.args.openings)}`); }
  const t0 = Date.now(); const r = await req("tools/call", { name: step.tool, arguments: step.args }); const ms = Date.now() - t0;
  const res = r.result ?? {};
  last[step.tool] = res.structuredContent ?? (()=>{try{return JSON.parse((res.content??[]).find(c=>c.type==="text")?.text)}catch{return null}})();
  const data = res.structuredContent ?? (res.content ?? []).find((c) => c.type === "text")?.text ?? r.error ?? null;
  console.log(`\n=== ${step.tool} ${step.note ?? ""} ${res.isError ? "ERROR" : ""} [${ms} ms]`);
  console.log(typeof data === "string" ? data.slice(0, 40000) : JSON.stringify(data).slice(0, 40000));
  if (step.save) {
    let n = 0;
    for (const c of res.content ?? []) if (c.type === "image" && c.data) {
      const f = join(OUT, `${step.save}${n ? "-" + n : ""}.png`);
      writeFileSync(f, Buffer.from(c.data, "base64"));
      console.log(`PNG ${f}`); n++;
    }
  }
}
proc.kill(); process.exit(0);
