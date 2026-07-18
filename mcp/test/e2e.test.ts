// End-to-end: the full agent recipe over MCP against the demo plan — load,
// adopt the detected scale, one-click all four rooms into a condition, read
// the summary, export, and round-trip the payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const approx = (a: number, b: number, tolFrac: number) => Math.abs(a - b) <= Math.abs(b) * tolFrac;

// seeds inside each room, at the room labels (see demo/make_sample_plan.py)
const ROOMS: [string, number, number][] = [
  ["OFFICE 101", 600, 1084],
  ["OFFICE 102", 1640, 1084],
  ["BREAK 103", 600, 464],
  ["CORRIDOR 104", 1600, 464],
];

test("e2e: load → set_scale(detected) → one_click × 4 rooms → summary → export round-trip", async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session()).connect(st);
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const data = JSON.parse(res.content[0].text);
    assert.ok(!res.isError, `${name} failed: ${data.error}`);
    return data;
  };

  const loaded = await call("load_plan", { path: PLAN });
  assert.equal(loaded.sheets[0].detected_scale, '1/4" = 1\'-0"');

  await call("set_scale", { sheet: KEY, use_detected: true });

  let total = 0;
  for (const [room, x, y] of ROOMS) {
    const r = await call("one_click", { sheet: KEY, x, y, condition: "CPT-1" });
    assert.ok(r.shape_id, `${room} committed`);
    assert.ok(approx(r.area_sf, 438.6, 0.05), `${room} ≈ 438.6 SF, got ${r.area_sf}`);
    total += r.area_sf;
  }

  const summary = await call("takeoff_summary");
  assert.equal(summary.conditions.length, 1);
  const row = summary.conditions[0];
  assert.equal(row.finish_tag, "CPT-1");
  assert.equal(row.shape_count, 4);
  assert.ok(approx(row.floor_sf, total, 0.001), "summary floor SF = sum of the four rooms");
  assert.ok(approx(summary.totals.total_sf, 1754.5, 0.05), `building interior ≈ 1754.5 SF, got ${summary.totals.total_sf}`);
  assert.equal(row.color, undefined, "presentation fields stripped from the summary");
  assert.equal(row.materials, undefined);

  const out = path.join(tmpdir(), `opentakeoff-mcp-e2e-${process.pid}.json`);
  try {
    const exported = await call("export_takeoff", { path: out });
    const onDisk = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual(onDisk, exported, "disk copy = inline copy");
    assert.equal(exported.schema, "opentakeoff.takeoff_canvas.v1");
    assert.equal(exported.shapes.length, 4);
    assert.equal(exported.conditions.length, 1);
    assert.equal(exported.sheets.length, 1);
    assert.equal(exported.sheets[0].sheet_id, KEY);
    for (const shp of exported.shapes) {
      assert.equal(shp.origin.method, "one_click_v1");
      assert.equal(shp.origin.actor, "agent", "agent commits are labeled agent in the export");
      assert.equal(shp.origin.reviewed, false, "nothing this server commits was human-reviewed");
      for (const [vx, vy] of shp.verts_norm) assert.ok(vx >= 0 && vx <= 1 && vy >= 0 && vy <= 1);
    }
  } finally {
    await rm(out, { force: true });
  }
});
