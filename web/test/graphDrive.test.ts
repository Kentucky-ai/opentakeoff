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
import { createGraphDrive, GraphAuthError, retryAfterMs } from "../src/lib/msgraph/graphDrive.js";
import { createDriveProvider } from "../src/lib/sync/provider.js";
import { createSyncStore } from "../src/lib/sync/syncStore.js";
import { createLocalStore } from "../src/lib/store.js";
import { BASE, FOLDER_MIME, DOWNLOAD_HOST, mockGraph } from "./fixtures/mockGraph.ts";

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

// ── #315 hardening: the real-tenant corners, over the mock tenant ──────────

test("file content is read through the item's pre-authenticated download URL with NO bearer; the /content stream is the fallback only when the item has none", async () => {
  const g = mockGraph();
  const c = clientOver(g);
  const f: any = await c.createFolder("root", ".opentakeoff");
  const put: any = await c.putJson({ folderId: f.id, name: "annotations.json", data: { rev: 7 } });
  g.calls.length = 0;
  assert.deepEqual(await c.getJson(put.id), { rev: 7 });
  assert.ok(g.calls.some((u) => u.includes(`/items/${put.id}?$select=id,content.downloadUrl`)), "reads the URL off the item");
  assert.ok(g.calls.some((u) => u.startsWith(`GET ${DOWNLOAD_HOST}/dl/${put.id}`)), "then fetches it on the download host (which refuses a bearer)");
  assert.ok(!g.calls.some((u) => u.endsWith("/content")), "never the /content redirect");

  const plain = mockGraph({ downloadUrls: false });   // a tenant that hands out no downloadUrl on the item
  const c2 = clientOver(plain);
  const f2: any = await c2.createFolder("root", ".opentakeoff");
  const put2: any = await c2.putJson({ folderId: f2.id, name: "annotations.json", data: { rev: 1 } });
  assert.deepEqual(await c2.getJson(put2.id), { rev: 1 });
  assert.ok(plain.calls.some((u) => u === `GET ${BASE}/drives/d1/items/${put2.id}/content`), "the /content stream with the bearer, as before");
});

test("a 401 mid-session asks the token source for ONE forced refresh and retries with the new token; a second 401 is a readable sign-in error, not 'offline'", async () => {
  const g = mockGraph({ expireToken: 1 });
  const asks: any[] = [];
  let n = 0;
  const c = createGraphDrive({ getToken: async (opts?: any) => { asks.push(opts); return `tok${++n}`; }, driveId: "d1", fetch: g.fetchImpl as any, base: BASE });
  const f: any = await c.createFolder("root", ".opentakeoff");
  assert.equal(f.name, ".opentakeoff", "the call succeeded after the refresh");
  assert.deepEqual(asks, [undefined, { forceRefresh: true }], "exactly one forced refresh");
  assert.deepEqual(g.tokensSeen, ["tok1", "tok2"], "the retry carried the NEW token");

  const dead = mockGraph({ expireToken: 99 });
  const c2 = createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: dead.fetchImpl as any, base: BASE });
  await assert.rejects(c2.findChild("root", "x"), (e: any) => e instanceof GraphAuthError && e.stage === "sign-in" && /sign in again/.test(e.message));
  assert.equal(dead.tokensSeen.length, 2, "one retry, then stop — never a refresh loop");

  const refuse = mockGraph({ expireToken: 1 });
  const c3 = createGraphDrive({ getToken: async (opts?: any) => { if (opts?.forceRefresh) throw new Error("interaction_required"); return "tok"; }, driveId: "d1", fetch: refuse.fetchImpl as any, base: BASE });
  await assert.rejects(c3.findChild("root", "x"), (e: any) => e instanceof GraphAuthError && /could not be refreshed silently/.test(e.message) && /interaction_required/.test(e.message));
});

test("403 names the permission stage; 504 is throttled like 429; Retry-After as an HTTP-date is honored", async () => {
  const g = mockGraph();
  const forbidding = async (url: string, init: any) => (url.includes("/children") ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => "Access denied", arrayBuffer: async () => new ArrayBuffer(0) } : g.fetchImpl(url, init));
  const c = createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: forbidding as any, base: BASE });
  await assert.rejects(c.listChildren("root"), (e: any) => e instanceof GraphAuthError && /Files\.ReadWrite\.All/.test(e.message) && e.status === 403);

  let gateways = 1;
  const sleeps: number[] = [];
  const now = Date.now();
  const flaky = async (url: string, init: any) => {
    if (gateways > 0) { gateways--; return { ok: false, status: 504, headers: { get: (k: string) => (k === "Retry-After" ? new Date(now + 3000).toUTCString() : null) }, json: async () => ({}), text: async () => "gateway", arrayBuffer: async () => new ArrayBuffer(0) }; }
    return g.fetchImpl(url, init);
  };
  const c2 = createGraphDrive({ getToken: async () => "tok", driveId: "d1", fetch: flaky as any, base: BASE, sleep: async (ms: number) => { sleeps.push(ms); } });
  const f: any = await c2.createFolder("root", "z");
  assert.equal(f.name, "z");
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1500 && sleeps[0] <= 3000, `HTTP-date Retry-After → ~3 s wait, got ${sleeps[0]}`);
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("garbage"), 1000);
  assert.equal(retryAfterMs(null, 0, 500), 500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
});
