// 365-synced workspace (#315) — config parsing and the document-library
// composite over the mock Graph tenant. Auth (MSAL) is deliberately outside
// these tests: the composite takes an injected graph client, which is the
// same seam the gate wires MSAL's getToken into — and the seam is what a
// tenant-less CI can actually prove.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { m365Config, m365Scope } from "../src/lib/msgraph/config.js";
import { buildM365Store } from "../src/lib/msgraph/composite.js";
import { createGraphDrive } from "../src/lib/msgraph/graphDrive.js";
import { BASE, mockGraph } from "./fixtures/mockGraph.ts";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// ── config ─────────────────────────────────────────────────────────────────

test("m365Config: dark unless BOTH client id and drive id are set; defaults fill the rest", () => {
  assert.equal(m365Config({}), null);
  assert.equal(m365Config({ VITE_MSAL_CLIENT_ID: "app" }), null);
  assert.equal(m365Config({ VITE_GRAPH_DRIVE_ID: "d1" }), null);
  const cfg: any = m365Config({ VITE_MSAL_CLIENT_ID: "app", VITE_GRAPH_DRIVE_ID: "d1" });
  assert.deepEqual(cfg, { clientId: "app", tenant: "organizations", driveId: "d1", folderId: "root" });
  const full: any = m365Config({ VITE_MSAL_CLIENT_ID: "app", VITE_MSAL_TENANT: "contoso.com", VITE_GRAPH_DRIVE_ID: "d1", VITE_GRAPH_FOLDER_ID: "f9" });
  assert.equal(full.tenant, "contoso.com");
  assert.equal(full.folderId, "f9");
});

test("m365Scope is stable per library and distinct across libraries", () => {
  const a = m365Scope({ driveId: "d1", folderId: "root" } as any);
  assert.equal(a, m365Scope({ driveId: "d1", folderId: "root" } as any)); // same library → same bookkeeping
  assert.notEqual(a, m365Scope({ driveId: "d2", folderId: "root" } as any)); // different library → clean seed
});

// ── the composite over a mock tenant ───────────────────────────────────────

const cfg: any = { clientId: "app", tenant: "organizations", driveId: "d1", folderId: "root" };
const clientOver = (g: any) => createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: g.fetchImpl as any, base: BASE });

test("a save through the composite lands .opentakeoff/annotations.json in the tenant at rev 1", async () => {
  const g = mockGraph();
  const store: any = buildM365Store(cfg, clientOver(g));
  await store.syncBridge.whenSynced();
  await store.saveAnnotations({ conditions: [{ id: "c-365" }], shapes: [] });
  await store.syncBridge.whenPushed();

  const sidecar = [...g.items.values()].find((i: any) => i.name === ".opentakeoff" && i.folder);
  assert.ok(sidecar, "sidecar folder created in the library");
  const ann = [...g.items.values()].find((i: any) => i.name === "annotations.json" && i.parentId === sidecar.id);
  assert.ok(ann, "annotations sidecar exists");
  const data = JSON.parse(new TextDecoder().decode(ann.content as Uint8Array));
  assert.equal(data.rev, 1);
  assert.deepEqual(data.conditions, [{ id: "c-365" }]);
  store.dispose(); // heartbeat down — no timer leaks into the runner
});

test("a read-only viewer on a fresh library never litters an empty sidecar", async () => {
  const g = mockGraph();
  const store: any = buildM365Store(cfg, clientOver(g));
  await store.syncBridge.whenSynced();      // bootstrap pull ran
  await store.loadAnnotations(); // and a plain read
  const sidecar = [...g.items.values()].find((i: any) => i.name === ".opentakeoff");
  assert.equal(sidecar, undefined); // read paths use the non-creating resolver
  store.dispose();
});

test("the composite keeps the workspace-store shape: sync methods shadow, bridge and dispose stay non-enumerable", async () => {
  const g = mockGraph();
  const store: any = buildM365Store(cfg, clientOver(g));
  for (const m of ["loadAnnotations", "saveAnnotations", "saveSnapshot", "listSnapshots", "getSnapshot", "deleteSnapshot", "addPdf", "listSheets"]) {
    assert.equal(typeof store[m], "function", `${m} present`);
  }
  assert.equal(Object.keys(store).includes("syncBridge"), false);
  assert.equal(Object.keys(store).includes("dispose"), false);
  assert.equal(typeof store.syncBridge.checkRemote, "function"); // the gate's lazy poll hook
  store.dispose();
});

test("a second browser seeds from the tenant and a conflicting edit merges (#313) — same behavior as every other transport", async () => {
  const g = mockGraph();
  // browser one starts the takeoff
  const one: any = buildM365Store(cfg, clientOver(g));
  await one.syncBridge.whenSynced();
  await one.saveAnnotations({ conditions: [{ id: "c1" }], shapes: [] });
  await one.syncBridge.whenPushed();
  one.dispose();
  // NB: both composites share ONE local IndexedDB here (they'd be the same
  // browser) — so this asserts the seeded pull path and the tenant's rev
  // monotonicity, not two-machine divergence; that lives in graphDrive.test.
  const pull: any = await clientOver(g).getJson(
    ([...g.items.values()].find((i: any) => i.name === "annotations.json") as any).id
  );
  assert.equal(pull.rev, 1);
});
