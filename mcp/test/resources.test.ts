// Conformance tests for the resource surface (issue #29): list/read behavior
// empty and loaded, list_changed on load_plan, PNG integrity, and clean errors
// on bad URIs — all over the real wire (in-memory transport, real client).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cp, mkdir, mkdtemp, readFile as readFileAsync, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { WIKI_PAGES } from "../src/wiki.generated.ts";

const PROTOCOL_SCHEMAS = [
  ["legacy", "takeoff-canvas.v1.schema.json"],
  ["v1", "calibration.schema.json"],
  ["v1", "common.schema.json"],
  ["v1", "condition.schema.json"],
  ["v1", "document-fields.schema.json"],
  ["v1", "evidence.schema.json"],
  ["v1", "measurement.schema.json"],
  ["v1", "provenance.schema.json"],
  ["v1", "review.schema.json"],
  ["v1", "stitch.schema.json"],
  ["v1", "takeoff-document.schema.json"],
] as const;
const PROTOCOL_ROOT = resolve(fileURLToPath(new URL("../../protocol/", import.meta.url)));
const protocolUri = ([family, name]: readonly [string, string]) => `takeoff://protocol/${family}/${name}`;
const canonicalSchema = async ([family, name]: readonly [string, string]) => {
  const raw = await readFile(resolve(PROTOCOL_ROOT, family, name), "utf8");
  const text = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  return { text, value: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
};

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function connect() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session()).connect(st);
  const client = new Client({ name: "resources-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

async function connectWithOptions(opts: { stagedTools?: boolean }) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), opts).connect(st);
  const client = new Client({ name: "resources-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

async function connectWithSession() {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(session).connect(st);
  const client = new Client({ name: "resources-test", version: "0.0.0" });
  await client.connect(ct);
  return { client, session };
}

test("empty session: protocol index and every embedded schema are listed and exact", async () => {
  const { client, session } = await connectWithSession();
  const before = structuredClone({ index: session.index(), shapes: session.shapes, conditions: session.conditions, approvals: session.approvals, rfis: session.rfis });
  const { resources } = await client.listResources();
  const uris = resources.map((resource) => resource.uri);
  assert.ok(uris.includes("takeoff://protocol"), "protocol index is available before loading a plan");
  assert.deepEqual(
    PROTOCOL_SCHEMAS.map(protocolUri).filter((uri) => !uris.includes(uri)),
    [],
    "all allowlisted protocol schemas are listed",
  );
  const indexRead: any = await client.readResource({ uri: "takeoff://protocol" });
  assert.equal(indexRead.contents[0].mimeType, "application/json");
  const index = JSON.parse(indexRead.contents[0].text);
  assert.match(index.protocol, /^TakeoffDocument v1/);
  assert.equal(index.resources.length, PROTOCOL_SCHEMAS.length);
  assert.deepEqual(index.resources.map((entry: { uri: string }) => entry.uri).sort(), PROTOCOL_SCHEMAS.map(protocolUri).sort());
  assert.deepEqual(index.roles, ["floor_area", "deduct", "linear", "surface_area", "count"]);

  for (const spec of PROTOCOL_SCHEMAS) {
    const expected = await canonicalSchema(spec);
    const read: any = await client.readResource({ uri: protocolUri(spec) });
    assert.equal(read.contents[0].mimeType, "application/schema+json", protocolUri(spec));
    assert.equal(read.contents[0].text, expected.text, `embedded JSON for ${protocolUri(spec)}`);
    assert.equal(createHash("sha256").update(read.contents[0].text).digest("hex"), expected.sha256);
    assert.deepEqual(JSON.parse(read.contents[0].text), expected.value);
    const listed = resources.find((resource) => resource.uri === protocolUri(spec));
    assert.ok(listed);
    assert.equal(listed.mimeType, "application/schema+json");
    const row = index.resources.find((entry: { uri: string }) => entry.uri === protocolUri(spec));
    assert.deepEqual(row, {
      uri: protocolUri(spec),
      id: expected.value.$id,
      title: expected.value.title,
      source: `protocol/${spec[0]}/${spec[1]}`,
      sha256: expected.sha256,
    });
  }
  assert.deepEqual(structuredClone({ index: session.index(), shapes: session.shapes, conditions: session.conditions, approvals: session.approvals, rfis: session.rfis }), before, "resource reads do not mutate session state");
});

test("protocol resources remain available in staged mode", async () => {
  const client = await connectWithOptions({ stagedTools: true });
  const { resources } = await client.listResources();
  assert.deepEqual(
    PROTOCOL_SCHEMAS.map(protocolUri).filter((uri) => !resources.some((resource) => resource.uri === uri)),
    [],
  );
  const read: any = await client.readResource({ uri: protocolUri(PROTOCOL_SCHEMAS[0]) });
  assert.equal(read.contents[0].mimeType, "application/schema+json");
});

test("protocol URI allowlist rejects unknown and traversal-looking addresses", async () => {
  const client = await connect();
  const alias: any = await client.readResource({ uri: "takeoff://protocol/../v1/common.schema.json" });
  assert.equal(alias.contents[0].mimeType, "application/schema+json");
  assert.equal(alias.contents[0].text, (await canonicalSchema(PROTOCOL_SCHEMAS[2])).text, "URL canonicalization preserves the known resource");
  for (const uri of [
    "takeoff://protocol/nope",
    "takeoff://protocol/v1/%2e%2e/secret.schema.json",
    "takeoff://protocol/v1/%2e%2e/common.schema.json",
    "takeoff://protocol/v1/common.schema.json?x=1",
  ]) {
    await assert.rejects(client.readResource({ uri }), /unknown|not found|resource|URI|protocol/i, uri);
  }
  const ok: any = await client.readResource({ uri: protocolUri(PROTOCOL_SCHEMAS[2]) });
  assert.equal(ok.contents[0].mimeType, "application/schema+json");
});

test("protocol generator detects stale, missing, extra, duplicate-id, and dangling-ref mutations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ot-protocol-check-"));
  try {
    await mkdir(resolve(root, "mcp/scripts"), { recursive: true });
    await mkdir(resolve(root, "mcp/src"), { recursive: true });
    await cp(resolve(PROTOCOL_ROOT, "../mcp/scripts/check-protocol-resources.mjs"), resolve(root, "mcp/scripts/check-protocol-resources.mjs"));
    await cp(resolve(PROTOCOL_ROOT, "../mcp/src/protocol.generated.ts"), resolve(root, "mcp/src/protocol.generated.ts"));
    for (const [family, name] of PROTOCOL_SCHEMAS) {
      await mkdir(resolve(root, "protocol", family), { recursive: true });
      await cp(resolve(PROTOCOL_ROOT, family, name), resolve(root, "protocol", family, name));
    }
    const check = (...args: string[]) => spawnSync(process.execPath, ["mcp/scripts/check-protocol-resources.mjs", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(check().status, 0, "a copied generated registry is current");
    await rm(resolve(root, "mcp/src/protocol.generated.ts"));
    assert.equal(check().status, 1, "a missing generated artifact is stale");
    assert.equal(check("--write").status, 0, "a missing generated artifact is recreated");

    const commonPath = resolve(root, "protocol/v1/common.schema.json");
    const original = await readFileAsync(commonPath, "utf8");
    const common = JSON.parse(original);
    common.description += " mutation";
    await writeFile(commonPath, JSON.stringify(common, null, 2));
    const stale = check();
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /is stale/);
    assert.equal(check("--write").status, 0, "--write refreshes after a source mutation");

    await writeFile(resolve(root, "protocol/v1/extra.schema.json"), "{}\n");
    const extra = check("--write");
    assert.equal(extra.status, 1, "an unlisted schema refuses regeneration");
    assert.match(extra.stderr, /allowlist|schema files/i);
    await rm(resolve(root, "protocol/v1/extra.schema.json"));

    const duplicate = JSON.parse(original);
    duplicate.$id = "https://opentakeoff.kentucky-ai.com/protocol/v1/calibration.schema.json";
    await writeFile(commonPath, JSON.stringify(duplicate, null, 2));
    const duplicateResult = check("--write");
    assert.equal(duplicateResult.status, 1, "duplicate canonical ids refuse regeneration");
    assert.match(duplicateResult.stderr, /unique.*\$id|duplicate/i);

    const dangling = JSON.parse(original);
    dangling.$defs = { ...(dangling.$defs ?? {}), broken: { $ref: "common.schema.json#/$defs/missing" } };
    await writeFile(commonPath, JSON.stringify(dangling, null, 2));
    const danglingResult = check("--write");
    assert.equal(danglingResult.status, 1, "missing JSON pointer fragments refuse regeneration");
    assert.match(danglingResult.stderr, /does not exist|fragment/i);

    const external = JSON.parse(original);
    external.$defs = { ...(external.$defs ?? {}), broken: { $ref: "https://example.invalid/schema.json" } };
    await writeFile(commonPath, JSON.stringify(external, null, 2));
    const externalResult = check("--write");
    assert.equal(externalResult.status, 1, "unknown external refs refuse regeneration");
    assert.match(externalResult.stderr, /unknown schema.*\$ref|external/i);

    const nestedId = JSON.parse(original);
    nestedId.$defs = { ...(nestedId.$defs ?? {}), nested: { $id: nestedId.$id, type: "object" } };
    await writeFile(commonPath, JSON.stringify(nestedId, null, 2));
    const nestedResult = check("--write");
    assert.equal(nestedResult.status, 1, "nested ids refuse regeneration");
    assert.match(nestedResult.stderr, /nested.*\$id|outside/i);

    const dynamic = JSON.parse(original);
    dynamic.$defs = { ...(dynamic.$defs ?? {}), dynamic: { $dynamicRef: "#point", $anchor: "point" } };
    await writeFile(commonPath, JSON.stringify(dynamic, null, 2));
    const dynamicResult = check("--write");
    assert.equal(dynamicResult.status, 1, "dynamic references and anchors refuse regeneration");
    assert.match(dynamicResult.stderr, /dynamic|anchor/i);

    const encodedPointer = JSON.parse(original);
    encodedPointer.$defs = { ...(encodedPointer.$defs ?? {}), encoded: { $ref: "common.schema.json#%2F$defs%2Fpoint" } };
    await writeFile(commonPath, JSON.stringify(encodedPointer, null, 2));
    assert.equal(check("--write").status, 0, "percent-encoded JSON pointers resolve offline");

    await writeFile(commonPath, original);
    for (const [family, name] of PROTOCOL_SCHEMAS) {
      const path = resolve(root, "protocol", family, name);
      const text = await readFileAsync(path, "utf8");
      await writeFile(path, text.replace(/\n/g, "\r\n"));
    }
    // Restore the generated artifact and sources before the stability check.
    await cp(resolve(PROTOCOL_ROOT, "../mcp/src/protocol.generated.ts"), resolve(root, "mcp/src/protocol.generated.ts"));
    assert.equal(check().status, 0, "CRLF sources normalize to the same generated bytes");
    await rm(resolve(root, "protocol/v1/common.schema.json"));
    const missing = check("--write");
    assert.equal(missing.status, 1, "a missing canonical schema refuses regeneration");
    assert.match(missing.stderr, /missing|allowlist|found/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty session: knowledge and the sheet index list; sheet index reads sensibly", async () => {
  const client = await connect();

  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), [...WIKI_PAGES.map(p => p.uri), "takeoff://protocol", ...PROTOCOL_SCHEMAS.map(protocolUri), "takeoff://sheets"].sort(), "knowledge is readable before loading a plan");

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
    [...WIKI_PAGES.map(p => p.uri), "takeoff://protocol", ...PROTOCOL_SCHEMAS.map(protocolUri), "takeoff://sheet/1", "takeoff://sheet/1/image", "takeoff://sheet/1/text", "takeoff://sheets"].sort(),
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

  await assert.rejects(client.readResource({ uri: "takeoff://sheet/99" }), /No sheet 99/);
  await assert.rejects(client.readResource({ uri: "takeoff://sheet/99/image" }), /No sheet 99/);
  await assert.rejects(client.readResource({ uri: "takeoff://sheet/abc" }), /page number/);

  // the wire stayed healthy after every rejection
  const ok: any = await client.readResource({ uri: "takeoff://sheets" });
  assert.equal(JSON.parse(ok.contents[0].text).page_count, 1);
});
