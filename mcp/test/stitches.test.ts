import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const SAMPLE_PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session(), { oneClick: true });
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length === 1, `${name}: single content item`);
  assert.equal(res.content[0].type, "text");
  let data: any;
  try {
    data = JSON.parse(res.content[0].text);
  } catch {
    data = { error: res.content[0].text };
  }
  return { isError: !!res.isError, data };
}

async function setupTwoSheets() {
  const dir = await mkdtemp(path.join(tmpdir(), "opentakeoff-stitch-test-"));
  const p1 = path.join(dir, "plan-west.pdf");
  const p2 = path.join(dir, "plan-east.pdf");
  await copyFile(SAMPLE_PLAN, p1);
  await copyFile(SAMPLE_PLAN, p2);
  return { dir, p1, p2, k1: "plan-west.pdf", k2: "plan-east.pdf" };
}

test("stitch_sheets: input validation", async () => {
  const client = await pair();
  // No plan loaded
  const noPlan = await call(client, "stitch_sheets", { sheets: ["a.pdf", "b.pdf"] });
  assert.equal(noPlan.isError, true);
  assert.match(noPlan.data.error, /No plan loaded/);

  const { p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  // Less than 2 sheets (Zod schema rejects min(2))
  const oneSheet = await call(client, "stitch_sheets", { sheets: [k1] });
  assert.equal(oneSheet.isError, true);

  // Duplicate sheets
  const dup = await call(client, "stitch_sheets", { sheets: [k1, k1] });
  assert.equal(dup.isError, true);
  assert.match(dup.data.error, /unique/);

  // Unknown sheet
  const unknown = await call(client, "stitch_sheets", { sheets: [k1, "missing.pdf"] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /Unknown sheet/);
});

test("stitch_sheets: creation, scale inheritance, inspection, and measurement", async () => {
  const client = await pair();
  const { dir, p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  // Calibrate both sheets to identical scale
  await call(client, "set_scale", { sheet: k1, use_detected: true });
  await call(client, "set_scale", { sheet: k2, use_detected: true });

  // Get sheet 1 info for width
  const s1Info = await call(client, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;
  const h1 = s1Info.data.height_px;

  // Stitch sheets
  const res = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    name: "Level 1 Overall",
  });
  assert.equal(res.isError, false);
  assert.ok(res.data.stitch_id.startsWith("stitch:"));
  assert.equal(res.data.name, "Level 1 Overall");
  assert.equal(res.data.extent.width_px, w1 * 2);
  assert.equal(res.data.extent.height_px, h1);
  assert.equal(res.data.members.length, 2);
  assert.equal(res.data.members[0].key, k1);
  assert.equal(res.data.members[0].dx, 0);
  assert.equal(res.data.members[1].key, k2);
  assert.equal(res.data.members[1].dx, w1);
  // Scale was inherited from matching member sheets
  assert.ok(typeof res.data.scale.upp === "number");

  const stitchId = res.data.stitch_id;

  // Cannot nest stitches
  const nested = await call(client, "stitch_sheets", { sheets: [stitchId, k1] });
  assert.equal(nested.isError, true);
  assert.match(nested.data.error, /nested stitches/);

  // Inspect existing composite panels via list_stitches
  const list = await call(client, "list_stitches");
  assert.equal(list.isError, false);
  assert.equal(list.data.stitches.length, 1);
  assert.equal(list.data.stitches[0].id, stitchId);
  assert.equal(list.data.stitches[0].name, "Level 1 Overall");
  assert.equal(list.data.stitches[0].members.length, 2);

  // sheet_info on the stitch key
  const stInfo = await call(client, "sheet_info", { sheet: stitchId });
  assert.equal(stInfo.isError, false);
  assert.equal(stInfo.data.width_px, w1 * 2);
  assert.ok(stInfo.data.seg_count > 0, "has merged vector segments");

  // get_sheet_vectors on the stitch key
  const vectors = await call(client, "get_sheet_vectors", { sheet: stitchId, limit: 100 });
  assert.equal(vectors.isError, false);
  assert.ok(vectors.data.returned > 0);

  // Measure polygon across the stitch seam
  const poly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [
      [100, 100],
      [w1 + 100, 100],
      [w1 + 100, 200],
      [100, 200],
    ],
    condition: "CPT-1",
  });
  assert.equal(poly.isError, false);
  assert.ok(poly.data.area_sf > 0);

  // Shape listed in list_shapes
  const shapes = await call(client, "list_shapes", { sheet: stitchId });
  assert.equal(shapes.isError, false);
  assert.equal(shapes.data.shapes.length, 1);
  assert.equal(shapes.data.shapes[0].sheet, stitchId);

  // Verify list_stitches reflects the shape count
  const list2 = await call(client, "list_stitches");
  assert.equal(list2.data.stitches[0].shape_count, 1);

  // Export takeoff preserves stitch definitions
  const takeoffPath = path.join(dir, "takeoff.json");
  const exp = await call(client, "export_takeoff", { path: takeoffPath });
  assert.equal(exp.isError, false);
  assert.ok(Array.isArray(exp.data.stitches));
  assert.equal(exp.data.stitches.length, 1);
  assert.equal(exp.data.stitches[0].id, stitchId);
  assert.equal(exp.data.stitches[0].name, "Level 1 Overall");
  assert.deepEqual(exp.data.stitches[0].members, res.data.members);

  // Round-trip: import into fresh session
  const client2 = await pair();
  await call(client2, "load_plan", { path: p1 });
  await call(client2, "load_plan", { path: p2, merge: true });

  const imp = await call(client2, "import_takeoff", { path: takeoffPath });
  assert.equal(imp.isError, false);

  const listAfterImport = await call(client2, "list_stitches");
  assert.equal(listAfterImport.isError, false);
  assert.equal(listAfterImport.data.stitches.length, 1);
  assert.equal(listAfterImport.data.stitches[0].id, stitchId);
  assert.equal(listAfterImport.data.stitches[0].name, "Level 1 Overall");
  assert.equal(listAfterImport.data.stitches[0].shape_count, 1);

  // Verify re-export is identical in stitches
  const exp2 = await call(client2, "export_takeoff");
  assert.equal(exp2.isError, false);
  assert.deepEqual(exp2.data.stitches, exp.data.stitches);
});

test("stitch_sheets: alignment with anchor and moving points", async () => {
  const client = await pair();
  const { p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  const s1Info = await call(client, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;

  // Align moving sheet (k2 starts at dx = w1 in auto-butt) so point (w1 + 50, 200) aligns with point (w1 - 50, 200) on k1
  const res = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    name: "Aligned Stitch",
    align: {
      anchor: [w1 - 50, 200],
      moving: [w1 + 50, 200],
    },
  });
  assert.equal(res.isError, false);
  assert.equal(res.data.name, "Aligned Stitch");
  assert.equal(res.data.members.length, 2);
  // After alignment, sheet 2 moved left by 100px so dx is w1 - 100
  assert.equal(res.data.members[1].dx, w1 - 100);
});

test("stitch_sheets: security bounds, view refusal, cutout, and undo", async () => {
  const client = await pair();
  const { p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  // 1. Excessive offset rejected
  const badOffset = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    members: [
      { key: k1, dx: 0, dy: 0 },
      { key: k2, dx: 1e8, dy: 0 },
    ],
  });
  assert.equal(badOffset.isError, true);
  assert.match(badOffset.data.error, /excessive/);

  // 2. Non-finite align rejected
  const badAlign = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    align: {
      anchor: [NaN, 100],
      moving: [100, 100],
    },
  });
  assert.equal(badAlign.isError, true);
  assert.match(badAlign.data.error, /expected number|finite/);

  // 3. Valid stitch creation
  const stitchRes = await call(client, "stitch_sheets", { sheets: [k1, k2] });
  assert.equal(stitchRes.isError, false);
  const stitchId = stitchRes.data.stitch_id;

  // 4. view_sheet refuses stitched composite
  const viewRes = await call(client, "view_sheet", { sheet: stitchId });
  assert.equal(viewRes.isError, true);
  assert.match(viewRes.data.error, /does not support view_sheet/);

  // 5. Measure and cutout on stitch
  await call(client, "set_scale", { sheet: stitchId, upp: 0.05 });
  const poly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [[100, 100], [500, 100], [500, 500], [100, 500]],
    condition: "CPT-1",
  });
  assert.equal(poly.isError, false);
  const parentId = poly.data.shape_id;
  assert.ok(parentId);

  // Cutout hole
  const cut = await call(client, "cut_out", {
    parent_shape_id: parentId,
    verts: [[200, 200], [300, 200], [300, 300], [200, 300]],
  });
  assert.equal(cut.isError, false);
  assert.ok(cut.data.hole_sf > 0);

  // 6. Undo cutout and parent
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.isError, false);
  assert.equal(undo.data.undone, 1);
  assert.equal(undo.data.steps.length, 1);
});

