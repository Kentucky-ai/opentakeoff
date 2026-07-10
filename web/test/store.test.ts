// Storage adapter: snapshot CRUD, the v1->v2 IndexedDB upgrade, and the
// stale-tab error surface. Runs on fake-indexeddb — the /auto import installs
// a global `indexedDB` BEFORE the store module is loaded (test-only; src never
// imports it). Isolation: each test gets a brand-new database by swapping
// `globalThis.indexedDB = new IDBFactory()` in beforeEach, so no test sees
// another's stores or version.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store, localStore, isStaleTabError, ANN_SCHEMA, STALE_TAB_MESSAGE, friendlyStoreError } from "../src/lib/store.js";
import { createCloudStore } from "../src/lib/cloudStore.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Raw indexedDB.open outside the store module — for seeding v1 / v99 databases.
function rawOpen(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("opentakeoff", version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Version-bump probe: succeeds only if no connection is still open at a lower
// version. On regression it goes red promptly via the onblocked reject — a
// bare `await open(...)` would hang forever instead (fake-indexeddb's
// waitForOthersClosed loops indefinitely; node:test has no default timeout).
function probeUpgrade(version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("opentakeoff", version);
    req.onblocked = () => reject(new Error("upgrade blocked — a store connection leaked"));
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function rawPut(db: IDBDatabase, storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, "readwrite");
    t.objectStore(storeName).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

test("snapshot round-trip: payload deep-equal, label trimmed, empty label -> null", async () => {
  const payload = {
    conditions: [{ id: "c1", name: "Carpet", color: "#a33", unit: "SF" }],
    shapes: [
      { id: "s1", condition_id: "c1", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }] },
      { id: "s2", condition_id: "c1", points: [{ x: 3, y: 3 }], holes: [[{ x: 4, y: 4 }]] },
    ],
  };
  const { id, ts } = await store.saveSnapshot("  Bid day  ", payload);
  assert.match(id, /^snap_[a-z0-9]+$/);
  assert.equal(typeof ts, "number");

  const rec = await store.getSnapshot(id);
  assert.ok(rec);
  assert.equal(rec.label, "Bid day");           // trimmed
  assert.equal(rec.ts, ts);
  assert.deepEqual(rec.payload, payload);       // structured-clone round-trip

  const { id: id2 } = await store.saveSnapshot("", { shapes: [] });
  assert.equal((await store.getSnapshot(id2)).label, null);

  assert.equal(await store.getSnapshot("snap_nope"), null);
});

test("listSnapshots strips payloads, sorts ts desc; deleteSnapshot removes", async () => {
  const a = await store.saveSnapshot("first", { shapes: [{ id: "big" }] });
  await sleep(3); // distinct Date.now() for the ts-desc ordering check
  const b = await store.saveSnapshot("second", { shapes: [] });
  assert.ok(b.ts > a.ts);

  const list = await store.listSnapshots();
  assert.deepEqual(list, [
    { id: b.id, ts: b.ts, label: "second" },   // newest first
    { id: a.id, ts: a.ts, label: "first" },
  ]);
  assert.ok(list.every((r: any) => !("payload" in r)));

  await store.deleteSnapshot(a.id);
  assert.deepEqual((await store.listSnapshots()).map((r: any) => r.id), [b.id]);
  assert.equal(await store.getSnapshot(a.id), null);
});

test("project scope isolates listSnapshots: A sees A, not B, not local", async () => {
  const a = await store.saveSnapshot("in-A", { shapes: [] }, "A");
  await sleep(3);
  const b = await store.saveSnapshot("in-B", { shapes: [] }, "B");
  await sleep(3);
  const loc = await store.saveSnapshot("local", { shapes: [] }); // default null scope

  assert.deepEqual((await store.listSnapshots("A")).map((r: any) => r.id), [a.id]);
  assert.deepEqual((await store.listSnapshots("B")).map((r: any) => r.id), [b.id]);
  assert.deepEqual((await store.listSnapshots()).map((r: any) => r.id), [loc.id]);
  // metadata-only rows in scoped listing too
  assert.deepEqual(await store.listSnapshots("A"), [{ id: a.id, ts: a.ts, label: "in-A" }]);
});

test("getSnapshot scope guard: right scope returns record, wrong scope returns null", async () => {
  const { id } = await store.saveSnapshot("scoped", { shapes: [{ id: "s1" }] }, "A");

  const rec = await store.getSnapshot(id, "A");
  assert.ok(rec);
  assert.equal(rec.label, "scoped");
  assert.equal(rec.project, "A");
  assert.deepEqual(rec.payload, { shapes: [{ id: "s1" }] });

  // id exists, but wrong scope (other project / local) must be refused
  assert.equal(await store.getSnapshot(id, "B"), null);
  assert.equal(await store.getSnapshot(id), null);
});

test("null (local) scope is isolated from project scopes both ways", async () => {
  const { id } = await store.saveSnapshot("local-only", { shapes: [] }); // default null

  // visible to the local scope
  assert.deepEqual((await store.listSnapshots()).map((r: any) => r.id), [id]);
  assert.ok(await store.getSnapshot(id));
  assert.ok(await store.getSnapshot(id, null));

  // invisible to any project scope
  assert.deepEqual(await store.listSnapshots("A"), []);
  assert.equal(await store.getSnapshot(id, "A"), null);
});

test("legacy snapshot record with no `project` field reads back as null (local) scope", async () => {
  // Seed a record the pre-scoping code would have written: no `project` field.
  // Raw put mirrors the shipped v2 layout (SNAP_STORE keyPath "id").
  const db = await rawOpen(2, (dbToUpgrade) => {
    if (!dbToUpgrade.objectStoreNames.contains("pdfs")) dbToUpgrade.createObjectStore("pdfs", { keyPath: "name" });
    if (!dbToUpgrade.objectStoreNames.contains("meta")) dbToUpgrade.createObjectStore("meta");
    if (!dbToUpgrade.objectStoreNames.contains("snapshots")) dbToUpgrade.createObjectStore("snapshots", { keyPath: "id" });
  });
  await rawPut(db, "snapshots", { id: "snap_legacy", ts: 111, label: "old" }); // NO project field
  db.close();

  // no migration needed: legacy record is the null (local) scope
  assert.deepEqual(await store.listSnapshots(), [{ id: "snap_legacy", ts: 111, label: "old" }]);
  const rec = await store.getSnapshot("snap_legacy");
  assert.ok(rec);
  assert.equal(rec.label, "old");
  // and it is NOT visible to a project scope
  assert.deepEqual(await store.listSnapshots("A"), []);
  assert.equal(await store.getSnapshot("snap_legacy", "A"), null);
});

test("v1->v2 upgrade preserves pdfs + annotations, and snapshots work after", async () => {
  // Seed a v1 database exactly the way the shipped v1 code laid it out.
  const v1 = await rawOpen(1, (db) => {
    db.createObjectStore("pdfs", { keyPath: "name" });
    db.createObjectStore("meta");
  });
  const bytes = new Uint8Array([37, 80, 68, 70, 45]).buffer; // "%PDF-"
  await rawPut(v1, "pdfs", { name: "plan-a.pdf", bytes });
  const ann = { schema: ANN_SCHEMA, conditions: [{ id: "c1" }], shapes: [{ id: "s1" }], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: ["plan-a.pdf"] };
  await rawPut(v1, "meta", ann, "annotations");
  v1.close();

  // Store methods open at DB_VERSION 2 — onupgradeneeded's contains-guards
  // must add only the snapshots store and leave v1 data intact.
  assert.deepEqual(await store.listSheets(), [{ name: "plan-a.pdf" }]);
  assert.deepEqual(await store.loadAnnotations(), ann);
  assert.deepEqual(await store.loadPdfData("plan-a.pdf"), new Uint8Array([37, 80, 68, 70, 45]));

  const { id } = await store.saveSnapshot("post-upgrade", { shapes: [{ id: "s1" }] });
  assert.equal((await store.getSnapshot(id)).label, "post-upgrade");
});

test("database newer than this build surfaces as a stale-tab VersionError", async () => {
  const future = await rawOpen(99, (db) => {
    db.createObjectStore("pdfs", { keyPath: "name" });
    db.createObjectStore("meta");
    db.createObjectStore("snapshots", { keyPath: "id" });
  });
  future.close(); // no live connection — this is a version mismatch, not a block

  await assert.rejects(store.listSheets(), (e: any) => {
    assert.equal(e.name, "VersionError");
    assert.equal(isStaleTabError(e), true);
    assert.match(e.message, /older OpenTakeoff/);
    return true;
  });
  // sanity: garden-variety errors are NOT stale-tab errors
  assert.equal(isStaleTabError(new Error("boom")), false);
  assert.equal(isStaleTabError(null), false);
});

test("a failed put closes the connection anyway (withDb error path)", async () => {
  // functions aren't structured-cloneable — the put throws DataCloneError
  await assert.rejects(store.saveSnapshot("x", { evil: () => {} }), /clon/i);
  // if saveSnapshot leaked its connection, this version bump would block
  await probeUpgrade(3);
});

test("blocked open rejects BlockedError, then closes its late success (no zombie connection)", async () => {
  const v1 = await rawOpen(1);
  // v1 stays open — the store's v2 open blocks behind it and must reject
  await assert.rejects(store.listSheets(), (e: any) => e.name === "BlockedError");
  // Once the blocker closes, the store's orphaned open finally succeeds; the
  // settled flag must close that connection, or THIS probe blocks in turn.
  // (Deterministic: fake-indexeddb chains opens on one connection queue and
  // fires onsuccess before advancing it — no sleeps needed.)
  v1.close();
  await probeUpgrade(3);
});

test("friendlyStoreError maps quota to actionable copy; other errors pass through", () => {
  assert.equal(
    friendlyStoreError(Object.assign(new Error("raw engine text"), { name: "QuotaExceededError" })),
    "Not enough storage space for this snapshot — delete old snapshots or unused PDFs and try again.",
  );
  assert.equal(friendlyStoreError(new Error("boom")), "boom");
  // TakeoffCanvas routes its message tint on EXACT equality with this string —
  // pin the copy so an edit there can't silently turn the warning green
  assert.equal(STALE_TAB_MESSAGE, "OpenTakeoff was updated in another tab — reload this tab to continue.");
});

test("two cloudStores over one IndexedDB scope snapshots by folderId (end-to-end)", async () => {
  // Real localStore on fake-indexeddb — not the recording fake. The snapshot
  // methods never touch Drive, so a stub drive is enough to build the stores.
  const drive = {} as any;
  const a = createCloudStore("folderA", drive, { local: localStore });
  const b = createCloudStore("folderB", drive, { local: localStore });

  const { id } = await a.saveSnapshot("from-A", { shapes: [{ id: "s1" }] });

  // store A sees its own snapshot
  assert.deepEqual((await a.listSnapshots()).map((r: any) => r.id), [id]);
  const recA = await a.getSnapshot(id);
  assert.ok(recA);
  assert.equal(recA.project, "folderA");

  // store B (different folder) is fully isolated — can't list or fetch it
  assert.deepEqual(await b.listSnapshots(), []);
  assert.equal(await b.getSnapshot(id), null);

  // and the anonymous/local scope can't see it either
  assert.deepEqual(await store.listSnapshots(), []);
  assert.equal(await store.getSnapshot(id), null);
});

test("annotations round-trip still works against the v2 database (regression)", async () => {
  // fresh DB -> defaults
  const empty = await store.loadAnnotations();
  assert.equal(empty.schema, ANN_SCHEMA);
  assert.deepEqual(empty.conditions, []);

  const payload = { conditions: [{ id: "c9", name: "LVP" }], shapes: [{ id: "s9", points: [{ x: 1, y: 2 }] }], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [] };
  await store.saveAnnotations(payload);
  assert.deepEqual(await store.loadAnnotations(), { ...payload, schema: ANN_SCHEMA });
});
