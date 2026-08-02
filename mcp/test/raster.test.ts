// The raster fallback over MCP (#154) — one_click on a SCANNED sheet.
//
// Fixture: test/fixtures/scanned-plan.pdf (scripts/make-scan-fixture.mjs) —
// the bundled demo plan rasterized and re-wrapped as an image-only PDF: zero
// vector segments, zero text layer, same MediaBox, so the vector e2e's rooms
// sit at the same image-px coordinates and the two paths are directly
// comparable. Ground truth per room is the VECTOR e2e's ≈438.6 SF; the raster
// ring bounds at the ink edge rather than the stroke centerline, so a small
// negative bias inside a 5% band is expected, not a defect.
//
// The contract under test, both directions:
//   scanned sheet → automatic raster fallback, raster_traced disclosed on the
//     reply AND on the committed shape's origin (an agent-committed raster
//     trace must be distinguishable from a vector trace in the record);
//   vector sheet → the vector path exactly as before, NO raster_traced;
//   featureless white space → a structured refusal with a reason, never a
//     garbage polygon; layer overrides on scan pixels → refused, not no-opped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { oneClickOutput } from "../src/outputs.ts";

const SCAN = fileURLToPath(new URL("./fixtures/scanned-plan.pdf", import.meta.url));
const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const SCAN_KEY = "scanned-plan.pdf";
const PLAN_KEY = "sample-plan.pdf";
const SCALE_LABEL = "1/4\" = 1'-0\""; // the scan has no text layer to detect it from — stated explicitly
const ROOM_SF = 438.6; // the vector e2e's per-room ground truth
const approx = (a: number, b: number, tolFrac: number) => Math.abs(a - b) <= Math.abs(b) * tolFrac;

// Room seeds chosen away from the label glyphs: on the raster path text IS
// ink (islands the flood goes around), and a seed on a glyph would test the
// nudge, not the room. Rooms span x 240..1220 / 1220..2200, y 204..784 /
// 784..1364 image px (demo/make_sample_plan.py, ×2, y flipped).
const SEEDS: [string, number, number][] = [
  ["OFFICE 101", 500, 1000],
  ["CORRIDOR 104", 1600, 380],
];

async function pair(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session()).connect(st);
  const client = new Client({ name: "raster-e2e", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  const data = JSON.parse(res.content[0].text);
  assert.ok(!res.isError, `${name} failed: ${data.error}`);
  return data;
}

async function callErr(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.equal(!!res.isError, true, `${name} should have refused`);
  return JSON.parse(res.content[0].text).error;
}

test("e2e (#154): one_click on a scanned sheet — raster fallback, disclosed both on the reply and on origin", async () => {
  const client = await pair();

  const loaded = await callOk(client, "load_plan", { path: SCAN });
  assert.equal(loaded.page_count, 1);
  const info = await callOk(client, "sheet_info", { sheet: SCAN_KEY });
  assert.equal(info.has_vector_linework, false, "the fixture must be image-only — zero vector segments");
  assert.equal(info.seg_count, 0);
  assert.equal(info.detected_scale, undefined, "no text layer, no detected scale");

  await callOk(client, "set_scale", { sheet: SCAN_KEY, label: SCALE_LABEL });

  for (const [room, x, y] of SEEDS) {
    const r = await callOk(client, "one_click", { sheet: SCAN_KEY, x, y, condition: "CPT-1", return_verts: true });
    z.object(oneClickOutput).parse(r); // the disclosure is part of the declared contract, not a bonus field
    assert.equal(r.raster_traced, true, `${room}: the raster path must disclose itself`);
    assert.ok(r.shape_id, `${room} committed`);
    assert.ok(r.nverts >= 4, `${room}: a sane room ring, got ${r.nverts} verts`);
    assert.ok(approx(r.area_sf, ROOM_SF, 0.05), `${room} ≈ ${ROOM_SF} SF (vector ground truth ±5%), got ${r.area_sf}`);
    for (const [vx, vy] of r.verts) {
      assert.ok(vx >= 0 && vx <= 2448 && vy >= 0 && vy <= 1584, `${room}: verts inside the sheet`);
    }
  }

  // provenance on the record: raster_traced rides origin, vector-only fields don't
  const exported = await callOk(client, "export_takeoff");
  assert.equal(exported.shapes.length, SEEDS.length);
  for (const shp of exported.shapes) {
    assert.equal(shp.origin.method, "one_click_v1", "same method vocabulary as the canvas — raster is a boundary source, not a new method");
    assert.equal(shp.origin.raster_traced, true, "an agent-committed raster trace is distinguishable in the record");
    assert.equal(shp.origin.actor, "agent");
    assert.equal(shp.origin.reviewed, false);
    assert.equal(shp.origin.layer_bounded, undefined, "the raster mask never saw the layer table");
    assert.equal(shp.origin.fill_sensitivity, undefined, "the knob is inert on a single-tier raster mask");
  }

  const summary = await callOk(client, "takeoff_summary");
  assert.equal(summary.conditions[0].shape_count, SEEDS.length);
});

test("refusals (#154): featureless white space, and layer overrides on scan pixels", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: SCAN });
  await callOk(client, "set_scale", { sheet: SCAN_KEY, label: SCALE_LABEL });

  // the sheet margin: white in every direction until the paper edge — a
  // structured refusal with a reason, never a garbage polygon
  assert.match(
    await callErr(client, "one_click", { sheet: SCAN_KEY, x: 60, y: 60 }),
    /isn't enclosed on the scan/,
  );

  // layer overrides name PDF Optional Content; scan pixels carry none —
  // refused (resolve-or-error), never silently no-opped
  assert.match(
    await callErr(client, "one_click", { sheet: SCAN_KEY, x: 500, y: 1000, layers: { exclude: ["A-WALL-FULL"] } }),
    /carries no PDF layers/,
  );
});

test("vector sheets keep the vector path: no raster_traced anywhere in reply or record", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: PLAN_KEY, use_detected: true });

  const r = await callOk(client, "one_click", { sheet: PLAN_KEY, x: 600, y: 1084, condition: "CPT-1" });
  assert.equal(r.raster_traced, undefined, "a pure-vector sheet never touches pixels");
  assert.ok(approx(r.area_sf, ROOM_SF, 0.05));

  const exported = await callOk(client, "export_takeoff");
  assert.equal(exported.shapes[0].origin.raster_traced, undefined);
  assert.equal(exported.shapes[0].origin.method, "one_click_v1");
});

test("detect_rooms on a pure scan: the sweep runs on the raster mask instead of refusing — no text layer means zero rooms, honestly", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: SCAN });
  await callOk(client, "set_scale", { sheet: SCAN_KEY, label: SCALE_LABEL });

  // pre-#154 this refused outright ("no vector linework"); now the mask
  // resolves and the honest answer is an empty sweep — the scan simply has
  // no labels to seed from (an OCR'd scan would)
  const dr = await callOk(client, "detect_rooms", { sheet: SCAN_KEY });
  assert.equal(dr.detected, 0);
  assert.deepEqual(dr.rooms, []);
});
