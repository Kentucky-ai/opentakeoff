// Microsoft Graph client (#315) — contract tests over a mock Graph tenant
// (in-memory driveItems, path addressing, paging, throttling), and the RFC's
// stated finish line: the reconciler runs against the Graph provider
// UNCHANGED — syncStore.js never learns which cloud it is on. The two-machine
// push/pull/conflict round-trip converges through the mock tenant with the
// #313 merge, zero loser-snapshots.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createGraphDrive } from "../src/lib/msgraph/graphDrive.js";
import { createDriveProvider } from "../src/lib/sync/provider.js";
import { createSyncStore } from "../src/lib/sync/syncStore.js";
import { createLocalStore } from "../src/lib/store.js";
import { BASE, FOLDER_MIME, mockGraph } from "./fixtures/mockGraph.ts";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

const clientOver = (g: any, extra: any = {}) =>
  createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: g.fetchImpl as any, base: BASE, ...extra });

// ── contract ───────────────────────────────────────────────────────────────

test("graph client: find/create/put/get/list/delete round-trip with Drive-shaped records", async () => {
  const g = mockGraph();
  const c = clientOver(g);

  assert.equal(await c.findChild("root", ".opentakeoff"), null);
  const folder: any = await c.createFolder("root", ".opentakeoff");
  const found: any = await c.findChild("root", ".opentakeoff");
  assert.equal(found.id, folder.id);
  assert.equal(found.mimeType, FOLDER_MIME); // folder facet mapped to the Drive mime

  const put: any = await c.putJson({ folderId: folder.id, name: "annotations.json", data: { rev: 1, conditions: [] } });
  assert.deepEqual(await c.getJson(put.id), { rev: 1, conditions: [] });

  await c.putJson({ folderId: folder.id, name: "annotations.json", data: { rev: 2 }, existingId: put.id });
  assert.deepEqual(await c.getJson(put.id), { rev: 2 }); // update-in-place by id

  const kids: any[] = await c.listChildren(folder.id);
  assert.deepEqual(kids.map((k) => k.name), ["annotations.json"]);

  await c.deleteFile(put.id);
  assert.deepEqual(await c.listChildren(folder.id), []);
});

test("graph createFolder: concurrent creators converge on ONE folder (conflictBehavior fail + path re-resolve)", async () => {
  const g = mockGraph();
  const c = clientOver(g);
  const a: any = await c.createFolder("root", ".opentakeoff");
  const b: any = await c.createFolder("root", ".opentakeoff"); // 409 → resolves the existing one
  assert.equal(a.id, b.id); // no "presence 1" split-brain, ever
});

test("graph listChildren follows @odata.nextLink paging to completion", async () => {
  const g = mockGraph({ pageSize: 2 });
  const c = clientOver(g);
  const f: any = await c.createFolder("root", "snapshots");
  for (let i = 0; i < 5; i++) await c.putJson({ folderId: f.id, name: `s${i}.json`, data: { i } });
  const kids: any[] = await c.listChildren(f.id);
  assert.equal(kids.length, 5);
});

test("graph 429: Retry-After is honored and the call succeeds; a sustained throttle throws (→ offline upstream)", async () => {
  const g = mockGraph();
  let throttleLeft = 2;
  const sleeps: number[] = [];
  const throttlingFetch = async (url: string, init: any) => {
    if (throttleLeft > 0) {
      throttleLeft--;
      return { ok: false, status: 429, headers: { get: (k: string) => (k === "Retry-After" ? "2" : null) }, json: async () => ({}), text: async () => "throttled", arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return g.fetchImpl(url, init);
  };
  const c = createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: throttlingFetch as any, base: BASE, sleep: async (ms: number) => { sleeps.push(ms); } });
  const f: any = await c.createFolder("root", "x");
  assert.equal(f.name, "x"); // two 429s absorbed, third attempt landed
  assert.deepEqual(sleeps, [2000, 2000]); // Retry-After seconds, honored

  throttleLeft = Infinity as any;
  await assert.rejects(c.createFolder("root", "y"), /429/); // bounded: degrade to offline, never a wedge
});

// ── the finish line: the reconciler never learns which cloud it is on ──────

const mkShape = (id: string) => ({
  id, sheet_id: "plan.pdf#1", condition_id: "c1",
  verts_norm: [[0, 0], [0.1, 0], [0.1, 0.1]],
  created_at: "2026-08-24T00:00:00.000Z",
});
const shapeIds = (ann: any) => ann.shapes.map((s: any) => s.id).sort();

// cloudStore.ensureSidecarId's locate-else-create, verbatim discipline,
// over the Graph client — the injected resolver both sync layers share.
function sidecarResolver(client: any) {
  let p: Promise<string> | null = null;
  return () => {
    if (!p) {
      p = (async () => {
        const child = await client.findChild("root", ".opentakeoff");
        if (child && child.mimeType === FOLDER_MIME) return child.id;
        const { id } = await client.createFolder("root", ".opentakeoff");
        return id;
      })().catch((e: any) => { p = null; throw e; });
    }
    return p;
  };
}

function machine(tag: string, g: any) {
  const snaps: any[] = [];
  const client = clientOver(g);
  const provider = createDriveProvider("root", client, { ensureSidecarId: sidecarResolver(client) });
  const base = createLocalStore(`g${tag}`);
  const sync = createSyncStore({
    base, provider, folderId: `gscope${tag}`,
    saveSnapshot: async (label: string, payload: any) => { snaps.push({ label, payload }); return { id: `s${snaps.length}` }; },
  }) as any;
  return { base, sync, snaps };
}

test("#315 finish line: two-machine push/pull/conflict round-trip through one Graph tenant — reconciler unchanged, #313 merge, zero loser-snapshots", async () => {
  const g = mockGraph();

  // Machine A starts the takeoff in the document library.
  const A = machine("A", g);
  await A.sync.whenSynced();
  const seed = { conditions: [{ id: "c1" }], shapes: [mkShape("S1")] };
  await A.sync.saveAnnotations(seed);
  await A.sync.whenPushed();

  // Machine B opens the same library folder and seeds from it.
  const B = machine("B", g);
  await B.sync.whenSynced();
  assert.deepEqual(shapeIds(await B.base.loadAnnotations()), ["S1"]);

  // Divergence: both add work; A pushes first, B's push hits the precondition.
  await A.sync.saveAnnotations({ ...seed, shapes: [...seed.shapes, mkShape("LA")] });
  await A.sync.whenPushed();
  await B.sync.saveAnnotations({ ...seed, shapes: [...seed.shapes, mkShape("LB")] });
  await B.sync.whenPushed(); // conflict → #313 merge → union re-pushed

  assert.deepEqual(shapeIds(await B.base.loadAnnotations()), ["LA", "LB", "S1"]);
  assert.equal(B.snaps.length, 0); // disjoint work: zero loser-snapshots

  // A notices the moved remote on its lazy check and merges forward.
  await A.sync.checkRemote();
  await A.sync.whenPushed();
  assert.deepEqual(shapeIds(await A.base.loadAnnotations()), ["LA", "LB", "S1"]);
  assert.equal(A.snaps.length, 0);

  // The tenant holds ONE converged file at rev 3, plain JSON, no tokens in it.
  const finalPull: any = await createDriveProvider("root", clientOver(g), { ensureSidecarId: sidecarResolver(clientOver(g)) }).pull();
  assert.equal(finalPull.rev, 3);
  assert.deepEqual(shapeIds(finalPull.data), ["LA", "LB", "S1"]);
});
