// Conformance tests for the resource surface (issue #29): list/read behavior
// empty and loaded, list_changed on load_plan, PNG integrity, and clean errors
// on bad URIs — all over the real wire (in-memory transport, real client).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function connect() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session()).connect(st);
  const client = new Client({ name: "resources-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

test("empty session: index lists alone and reads sensibly", async () => {
  const client = await connect();

  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri), ["takeoff://sheets"], "no plan → only the index is listed");

  const read: any = await client.readResource({ uri: "takeoff://sheets" });
  const index = JSON.parse(read.contents[0].text);
  assert.equal(index.file, null);
  assert.deepEqual(index.sheets, []);
  assert.match(index.hint, /load_plan/);

  await assert.rejects(client.readResource({ uri: "takeoff://sheet/1" }), /No plan loaded/, "sheet read before load names the fix");
});

test("loaded session: list_changed fires, sheets browse as index → metadata → text → image", async () => {
  const client = await connect();

  let listChanged = 0;
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { listChanged++; });

  const res: any = await client.callTool({ name: "load_plan", arguments: { path: PLAN } });
  assert.ok(!res.isError, "load_plan succeeded");
  assert.equal(listChanged, 1, "load_plan announced the new resource surface");

  const { resources } = await client.listResources();
  assert.deepEqual(
    resources.map((r) => r.uri).sort(),
    ["takeoff://sheet/1", "takeoff://sheet/1/image", "takeoff://sheet/1/text", "takeoff://sheets"],
    "index + metadata/text/image per sheet",
  );
  const meta = resources.find((r) => r.uri === "takeoff://sheet/1")!;
  assert.match(meta.title ?? "", /A-101/, "title-block number surfaces in the listing");

  const index = JSON.parse(((await client.readResource({ uri: "takeoff://sheets" })) as any).contents[0].text);
  assert.equal(index.file, KEY);
  assert.equal(index.page_count, 1);
  assert.equal(index.sheets[0].sheet_number, "A-101");
  assert.equal(index.sheets[0].scale_set, false);

  const sheet = JSON.parse(((await client.readResource({ uri: "takeoff://sheet/1" })) as any).contents[0].text);
  assert.equal(sheet.sheet, KEY);
  assert.equal(sheet.page, 1);
  assert.equal(sheet.detected_scale, '1/4" = 1\'-0"');
  assert.equal(sheet.shape_count, 0);

  const text: any = await client.readResource({ uri: "takeoff://sheet/1/text" });
  assert.equal(text.contents[0].mimeType, "text/plain");
  assert.match(text.contents[0].text, /OFFICE 101/);
  assert.match(text.contents[0].text, /SCALE/);

  const image: any = await client.readResource({ uri: "takeoff://sheet/1/image" });
  assert.equal(image.contents[0].mimeType, "image/png");
  const png = Buffer.from(image.contents[0].blob, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a real PNG signature");
  assert.ok(png.length > 1000, `render is not a stub (${png.length} bytes)`);
  // long edge ≤ 1568: PNG IHDR carries width/height at fixed offsets 16/20
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.ok(Math.max(w, h) <= 1568, `long edge capped (${w}x${h})`);

  // second read serves the cached render — same bytes, no re-rasterize
  const again: any = await client.readResource({ uri: "takeoff://sheet/1/image" });
  assert.equal(again.contents[0].blob, image.contents[0].blob);
});

test("bad URIs fail with named errors, not crashes", async () => {
  const client = await connect();
  await client.callTool({ name: "load_plan", arguments: { path: PLAN } });

  await assert.rejects(client.readResource({ uri: "takeoff://sheet/99" }), /No page 99/);
  await assert.rejects(client.readResource({ uri: "takeoff://sheet/99/image" }), /No page 99/);
  await assert.rejects(client.readResource({ uri: "takeoff://sheet/abc" }), /page number/);

  // the wire stayed healthy after every rejection
  const ok: any = await client.readResource({ uri: "takeoff://sheets" });
  assert.equal(JSON.parse(ok.contents[0].text).page_count, 1);
});
