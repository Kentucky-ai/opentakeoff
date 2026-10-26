// export_dxf — the CAD handoff, end to end through the MCP client: a measured
// room on the sample plan lands as a closed LWPOLYLINE on its finish layer in
// a file a strict reader accepts, the ring's CAD area equals the Report's,
// the sheet argument resolves by key and by title-block number, refusals
// (no plan / no scale / ambiguous sheet / stranger's file) are clean, and the
// overwrite guard recognizes our own DXF by its stamp.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { exportDxfOutput } from "../src/outputs.ts";
import { assertWritable } from "../src/safewrite.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session());
  await server.connect(st);
  const client = new Client({ name: "dxf-test", version: "0" });
  await client.connect(ct);
  return client;
}
async function callOk(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; structuredContent?: unknown; content: { type: string; text?: string }[] };
  assert.equal(r.isError ?? false, false, `expected ok from ${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent as Record<string, any>;
}
async function callErr(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text?: string }[] };
  assert.equal(r.isError, true, `expected an error from ${name}`);
  return r.content[0].text ?? "";
}

/** Model-space entities of a DXF text: {type, layer, pts, closed}. */
function entities(dxf: string) {
  const lines = dxf.split(/\r?\n/);
  const p: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) p.push([Number(lines[i]), lines[i + 1]]);
  const start = p.findIndex(([c, v], i) => c === 2 && v === "ENTITIES" && p[i - 1][1] === "SECTION");
  const out: { type: string; layer: string; pts: [number, number][]; closed: boolean }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (let i = start + 1; i < p.length; i++) {
    const [c, v] = p[i];
    if (c === 0) { if (v === "ENDSEC") break; cur = { type: v, layer: "", pts: [], closed: false }; out.push(cur); }
    else if (cur) {
      if (c === 8) cur.layer = v;
      if (c === 10) cur.pts.push([Number(v), 0]);
      if (c === 20) cur.pts[cur.pts.length - 1][1] = Number(v);
      if (c === 70) cur.closed = (Number(v) & 1) === 1;
    }
  }
  return out;
}
const shoelace = (pts: [number, number][]) => Math.abs(pts.reduce((a, [x0, y0], i) => { const [x1, y1] = pts[(i + 1) % pts.length]; return a + x0 * y1 - x1 * y0; }, 0)) / 2;

test("export_dxf: a measured room lands as a closed LWPOLYLINE on OT-<TAG>, area = report SF, schema-valid reply", async () => {
  const client = await pair();
  const dir = await mkdtemp(path.join(tmpdir(), "ot-dxf-"));
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  // a 40 ft × 25 ft rectangle at upp 1/36: 1440 × 900 px
  const poly = await callOk(client, "measure_polygon", { sheet: KEY, verts: [[200, 200], [1640, 200], [1640, 1100], [200, 1100]], condition: "LVT-1" });
  assert.ok(Math.abs(poly.area_sf - 1000) < 0.01, `1000 SF, got ${poly.area_sf}`);

  const out = path.join(dir, "a101.dxf");
  const r = await callOk(client, "export_dxf", { path: out });
  z.object(exportDxfOutput).parse(r);
  assert.equal(r.sheet, KEY);
  assert.equal(r.sheet_number, "A-101");
  assert.equal(r.units, "ft");
  assert.deepEqual(r.layers, ["OT-LVT-1"]);
  assert.equal(r.entities, 1);
  assert.equal(r.shapes, 1);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.bytes > 1000);

  const text = await readFile(out, "utf8");
  assert.match(text, /^999\nOpenTakeoff DXF export — sheet A-101 — units feet/);
  assert.match(text, /\$ACADVER\n1\nAC1015\n/);
  assert.match(text, /\$INSUNITS\n70\n2\n/);
  assert.ok(text.trimEnd().endsWith("\n0\nEOF"));
  const [ring] = entities(text);
  assert.equal(ring.type, "LWPOLYLINE");
  assert.equal(ring.layer, "OT-LVT-1");
  assert.equal(ring.closed, true);
  assert.equal(ring.pts.length, 4);
  assert.ok(Math.abs(shoelace(ring.pts) - 1000) < 0.01, "CAD area equals the takeoff's");
  // Y flipped: the top edge of the rectangle (y=200 px, near the sheet's top)
  // is the HIGHER Y in CAD
  const ys = ring.pts.map((p) => p[1]);
  assert.ok(Math.max(...ys) > Math.min(...ys));
  // extents are the unrounded frame; the file carries 4-decimal coordinates
  const xs = ring.pts.map((p) => p[0]);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  assert.ok(near(r.extents.min[0], Math.min(...xs)) && near(r.extents.min[1], Math.min(...ys)) && near(r.extents.max[0], Math.max(...xs)) && near(r.extents.max[1], Math.max(...ys)), `extents ${JSON.stringify(r.extents)} vs ring`);

  // metres, by title-block number, re-export over our own file without overwrite
  const m = await callOk(client, "export_dxf", { path: out, sheet: "a-101", units: "m" });
  assert.equal(m.units, "m");
  const [ringM] = entities(await readFile(out, "utf8"));
  assert.ok(Math.abs(shoelace(ringM.pts) - 1000 * 0.3048 * 0.3048) < 1e-6);
});

test("export_dxf refusals: no plan, no scale, ambiguous sheet, unknown sheet, a stranger's file", async () => {
  const client = await pair();
  const dir = await mkdtemp(path.join(tmpdir(), "ot-dxf-"));
  const out = path.join(dir, "x.dxf");
  assert.match(await callErr(client, "export_dxf", { path: out }), /No plan loaded/);

  await callOk(client, "load_plan", { path: PLAN });
  assert.match(await callErr(client, "export_dxf", { path: out }), /No sheet carries committed shapes/);
  assert.match(await callErr(client, "export_dxf", { path: out, sheet: KEY }), /no scale/);
  assert.match(await callErr(client, "export_dxf", { path: out, sheet: "Z-999" }), /Z-999/);

  // a stranger's file at path is protected; overwrite:true replaces it
  await writeFile(out, "not ours\n");
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  await callOk(client, "measure_polygon", { sheet: KEY, verts: [[200, 200], [900, 200], [900, 900]], condition: "CPT-1" });
  assert.match(await callErr(client, "export_dxf", { path: out }), /not an OpenTakeoff export/);
  await callOk(client, "export_dxf", { path: out, overwrite: true });
  await assertWritable(out, "dxf");   // now recognized as ours: no throw
});

test("recalibrated void geometry agrees with report and DXF, and scale undo validates on the wire", async () => {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(session); await server.connect(st);
  const client = new Client({ name: "phase1-dxf", version: "0" }); await client.connect(ct);
  try {
    await callOk(client, "load_plan", { path: PLAN });
    await callOk(client, "set_scale", { sheet: KEY, upp: 1 / 36 });
    const poly = await callOk(client, "measure_polygon", { sheet: KEY, verts: [[0,0],[720,0],[720,720],[0,720]], condition: "TILE-1" });
    await callOk(client, "cut_out", { parent_shape_id: poly.shape_id, verts: [[180,180],[540,180],[540,540],[180,540]] });
    await callOk(client, "set_scale", { sheet: KEY, upp: 1 / 18 });
    const cad = entities(session.exportDxf(KEY).build.dxf).filter((e) => e.type === "LWPOLYLINE");
    const area = cad.reduce((n, e) => n + (e.layer.endsWith("-HOLE") ? -1 : 1) * shoelace(e.pts), 0);
    assert.equal(area, 1200);
    assert.equal((session.exportReport() as any).totals.total_sf, area);
    const undo = await callOk(client, "undo_last", {});
    assert.equal(undo.steps[0].op, "scale");
    assert.equal(session.summary().totals.total_sf, 300);
  } finally { await client.close(); await server.close(); }
});
