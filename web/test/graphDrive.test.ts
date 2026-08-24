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

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

const BASE = "https://graph.test/v1.0";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// ── a tiny Graph tenant: driveItems in memory, real URL shapes ─────────────
function mockGraph({ pageSize = 200 }: { pageSize?: number } = {}) {
  type Item = { id: string; name: string; parentId: string | null; folder: boolean; content: Uint8Array | null };
  const items = new Map<string, Item>();
  items.set("root", { id: "root", name: "root", parentId: null, folder: true, content: null });
  let nextId = 1;
  const mint = () => `it${nextId++}`;

  const childrenOf = (pid: string) => [...items.values()].filter((i) => i.parentId === pid);
  const byPath = (pid: string, name: string) => childrenOf(pid).find((i) => i.name === name) || null;
  const asItem = (i: Item) => ({
    id: i.id, name: i.name, lastModifiedDateTime: "2026-08-24T00:00:00Z", size: i.content?.length ?? 0,
    ...(i.folder ? { folder: { childCount: childrenOf(i.id).length } } : { file: { mimeType: "application/json" } }),
  });

  const resp = (status: number, body: any = null, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
    text: async () => (body == null ? "" : JSON.stringify(body)),
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer.slice(0) : new TextEncoder().encode(JSON.stringify(body)).buffer),
  });

  const calls: string[] = [];
  async function fetchImpl(url: string, init: any = {}) {
    const method = (init.method || "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (!init.headers?.Authorization?.startsWith("Bearer ")) return resp(401, { error: "no token" });
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const m = path.match(/\/drives\/([^/]+)\/items\/(.+)$/);
    if (!m) return resp(400, { error: `bad url ${path}` });
    const rest = m[2];

    // /items/{parent}:/{name}(:/content)?  — path addressing
    const pm = rest.match(/^([^:]+):\/([^:]+)(?::?\/content)?$/);
    const isContent = /:\/content$/.test(rest) || /\/content$/.test(rest);
    if (pm && rest.includes(":")) {
      const [, pid, name] = pm;
      const parent = items.get(pid);
      if (!parent || !parent.folder) return resp(404, { error: "no parent" });
      const hit = byPath(pid, name);
      if (method === "GET") {
        return hit ? resp(200, asItem(hit)) : resp(404, { error: "not found" });
      }
      if (method === "PUT" && isContent) {
        const bytes = init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body));
        if (hit) { hit.content = bytes; return resp(200, asItem(hit)); }
        const it: Item = { id: mint(), name, parentId: pid, folder: false, content: bytes };
        items.set(it.id, it);
        return resp(201, asItem(it));
      }
      return resp(405, { error: "method" });
    }

    // /items/{id}/children
    const cm = rest.match(/^([^/:]+)\/children$/);
    if (cm) {
      const pid = cm[1];
      const parent = items.get(pid);
      if (!parent || !parent.folder) return resp(404, { error: "no folder" });
      if (method === "GET") {
        const all = childrenOf(pid).map(asItem);
        const skip = Number(u.searchParams.get("$skip") || 0);
        const page = all.slice(skip, skip + pageSize);
        const body: any = { value: page };
        if (skip + pageSize < all.length) {
          body["@odata.nextLink"] = `${BASE}/drives/${m[1]}/items/${pid}/children?$skip=${skip + pageSize}`;
        }
        return resp(200, body);
      }
      if (method === "POST") {
        const meta = JSON.parse(String(init.body));
        const existing = byPath(pid, meta.name);
        if (existing) {
          if (meta["@microsoft.graph.conflictBehavior"] === "fail") return resp(409, { error: "nameAlreadyExists" });
        }
        const it: Item = { id: mint(), name: meta.name, parentId: pid, folder: !!meta.folder, content: null };
        items.set(it.id, it);
        return resp(201, asItem(it));
      }
    }

    // /items/{id}/content
    const km = rest.match(/^([^/:]+)\/content$/);
    if (km) {
      const it = items.get(km[1]);
      if (!it || it.folder) return resp(404, { error: "not found" });
      if (method === "GET") return resp(200, it.content ?? new Uint8Array());
      if (method === "PUT") {
        it.content = init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body));
        return resp(200, asItem(it));
      }
    }

    // /items/{id}
    const im = rest.match(/^([^/:]+)$/);
    if (im) {
      const it = items.get(im[1]);
      if (method === "DELETE") {
        if (!it) return resp(404, { error: "gone" });
        items.delete(it.id);
        return resp(204);
      }
      if (method === "GET") return it ? resp(200, asItem(it)) : resp(404, { error: "not found" });
    }
    return resp(400, { error: `unhandled ${method} ${rest}` });
  }

  return { fetchImpl, items, calls };
}

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
