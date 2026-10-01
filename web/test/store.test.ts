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
import { store, localStore, createLocalStore, metaGet, metaPut, metaDelete, isStaleTabError, ANN_SCHEMA, STALE_TAB_MESSAGE, friendlyStoreError } from "../src/lib/store.js";
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
    { id: b.id, ts: b.ts, label: "second", conditions: 0, shapes: 0 },   // newest first
    { id: a.id, ts: a.ts, label: "first", conditions: 0, shapes: 1 },    // counts derived, payload still stripped
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
  assert.deepEqual(await store.listSnapshots("A"), [{ id: a.id, ts: a.ts, label: "in-A", conditions: 0, shapes: 0 }]);
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
  // (a payload-less legacy record counts as zero conditions/shapes)
  assert.deepEqual(await store.listSnapshots(), [{ id: "snap_legacy", ts: 111, label: "old", conditions: 0, shapes: 0 }]);
  const rec = await store.getSnapshot("snap_legacy");
  assert.ok(rec);
  assert.equal(rec.label, "old");
  // and it is NOT visible to a project scope
  assert.deepEqual(await store.listSnapshots("A"), []);
  assert.equal(await store.getSnapshot("snap_legacy", "A"), null);
});

test("putSnapshot: idempotent, id-preserving upsert of a verbatim record incl. scope", async () => {
  // A record as it would arrive from elsewhere (e.g. a pulled remote file):
  // full shape, its OWN id (not minted here), an explicit project scope.
  const rec = { id: "snap_abc123", ts: 4242, label: "pulled", project: "A", payload: { shapes: [{ id: "s1" }] } };

  await store.putSnapshot(rec);
  // materialized verbatim, under the given scope, keyed by its own id
  assert.deepEqual(await store.getSnapshot("snap_abc123", "A"), rec);
  assert.deepEqual((await store.listSnapshots("A")).map((r: any) => r.id), ["snap_abc123"]);
  // scope is honored: invisible to local and to another project
  assert.equal(await store.getSnapshot("snap_abc123"), null);
  assert.deepEqual(await store.listSnapshots("B"), []);

  // idempotent: re-putting the SAME id doesn't duplicate (upsert, not append);
  // new content overwrites in place — this is what makes a union merge safe.
  await store.putSnapshot({ ...rec, label: "relabeled" });
  assert.deepEqual((await store.listSnapshots("A")).map((r: any) => r.id), ["snap_abc123"]);
  assert.equal((await store.getSnapshot("snap_abc123", "A"))!.label, "relabeled");

  // guards the fields that make a record "complete": id (SNAP_STORE keyPath),
  // a finite ts (list UI renders new Date(ts)), and a payload (diff/load reads it)
  await assert.rejects(store.putSnapshot({ ts: 1, payload: {} } as any), /record\.id/);
  await assert.rejects(store.putSnapshot({ id: "   ", ts: 1, payload: {} } as any), /record\.id/);
  await assert.rejects(store.putSnapshot(null as any), /record\.id/);
  await assert.rejects(store.putSnapshot({ id: "snap_x", payload: {} } as any), /record\.ts/);
  await assert.rejects(store.putSnapshot({ id: "snap_x", ts: NaN, payload: {} } as any), /record\.ts/);
  await assert.rejects(store.putSnapshot({ id: "snap_x", ts: 1 } as any), /record\.payload/);
});

test("createLocalStore(null) is the same global store — anonymous app is byte-identical", async () => {
  // null scope returns the very same object: no new key, no migration, the
  // existing "annotations" blob IS the anonymous project.
  assert.equal(createLocalStore(null), localStore);
  assert.equal(createLocalStore(), localStore);
  // "" is anonymous too (projectIdFromUrl() returns "" for local mode) — it must
  // NOT become a distinct "annotations:" scope
  assert.equal(createLocalStore(""), localStore);
  // and it reads/writes the same legacy key
  await localStore.saveAnnotations({ conditions: [{ id: "c1" }], shapes: [] } as any);
  const viaNull = await createLocalStore(null).loadAnnotations();
  assert.deepEqual(viaNull.conditions, [{ id: "c1" }]);
});

test("createLocalStore(folderId) scopes annotations per project and isolates them", async () => {
  const A = createLocalStore("folderA");
  const B = createLocalStore("folderB");

  await A.saveAnnotations({ conditions: [{ id: "a" }], shapes: [] } as any);
  await B.saveAnnotations({ conditions: [{ id: "b" }], shapes: [] } as any);

  assert.deepEqual((await A.loadAnnotations()).conditions, [{ id: "a" }]);
  assert.deepEqual((await B.loadAnnotations()).conditions, [{ id: "b" }]);

  // a scoped project never sees the global/anonymous blob, and vice-versa
  await localStore.saveAnnotations({ conditions: [{ id: "global" }], shapes: [] } as any);
  assert.deepEqual((await A.loadAnnotations()).conditions, [{ id: "a" }]);
  assert.deepEqual((await localStore.loadAnnotations()).conditions, [{ id: "global" }]);

  // an untouched scope hydrates the empty shape, not another project's data
  assert.deepEqual((await createLocalStore("folderC").loadAnnotations()).conditions, []);

  // saveAnnotations stamps the schema like the global store does
  assert.equal((await A.loadAnnotations() as any).schema, ANN_SCHEMA);
});

test("meta KV: round-trips values, misses read undefined, delete removes, keys are independent", async () => {
  // miss → undefined (not a throw, not null)
  assert.equal(await metaGet("sync:A:synced_rev"), undefined);

  // primitives, objects, null, false all round-trip verbatim
  await metaPut("sync:A:synced_rev", 7);
  await metaPut("sync:A:touched", true);
  await metaPut("sync:A:marker", { targetRev: 8 });
  await metaPut("sync:A:last_pushed_at", null);
  assert.equal(await metaGet("sync:A:synced_rev"), 7);
  assert.equal(await metaGet("sync:A:touched"), true);
  assert.deepEqual(await metaGet("sync:A:marker"), { targetRev: 8 });
  assert.equal(await metaGet("sync:A:last_pushed_at"), null);

  // each field is its OWN key — deleting one leaves the others (no shared record)
  await metaDelete("sync:A:marker");
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(await metaGet("sync:A:synced_rev"), 7);
  assert.equal(await metaGet("sync:A:touched"), true);

  // per-project isolation via the folderId in the key
  assert.equal(await metaGet("sync:B:synced_rev"), undefined);

  // overwriting a key replaces in place
  await metaPut("sync:A:synced_rev", 9);
  assert.equal(await metaGet("sync:A:synced_rev"), 9);

  // false round-trips too (a boolean flipped true -> false must read back false,
  // not undefined/null — the read path has no `|| default` to swallow it)
  await metaPut("sync:A:touched", false);
  assert.equal(await metaGet("sync:A:touched"), false);
});

test("meta KV does not collide with the annotations blob", async () => {
  await localStore.saveAnnotations({ conditions: [{ id: "c" }], shapes: [] } as any);
  await metaPut("sync::touched", true); // even a null-scope-ish sync key
  // the sync key write left the annotations untouched, and vice-versa
  assert.deepEqual((await localStore.loadAnnotations()).conditions, [{ id: "c" }]);
  assert.equal(await metaGet("sync::touched"), true);
});

test("createLocalStore(folderId): PDFs and browser-global libraries stay global (unscoped)", async () => {
  const A = createLocalStore("folderA");
  // a PDF added through a scoped store is visible to the global store — PDFs are
  // intentionally NOT per-project locally (cloud mode routes them to cloudStore)
  await A.addPdf({ name: "plan.pdf", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any);
  assert.deepEqual((await localStore.listSheets()).map((s: any) => s.name), ["plan.pdf"]);
  // browser-global libraries delegate to the same keys too: a save through a
  // scoped store is read back by the global store (materials/stamps/templates
  // are cross-project by design — the scoped store overrides only annotations)
  await A.saveMaterialLibrary([{ id: "m1", name: "Carpet", unit: "sqft" }] as any);
  assert.equal((await localStore.loadMaterialLibrary()).length, 1);
});

test("v1->v3 upgrade preserves pdfs + annotations, and snapshots work after", async () => {
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

  // Store methods open at DB_VERSION 3 — onupgradeneeded contains-guards
  // must add only the missing stores (snapshots, pdf_revs) and leave v1 data intact.
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
  await probeUpgrade(4);
});

test("blocked open rejects BlockedError, then closes its late success (no zombie connection)", async () => {
  const v1 = await rawOpen(1);
  // v1 stays open — the store's v3 open blocks behind it and must reject
  await assert.rejects(store.listSheets(), (e: any) => e.name === "BlockedError");
  // Once the blocker closes, the store's orphaned open finally succeeds; the
  // settled flag must close that connection, or THIS probe blocks in turn.
  // (Deterministic: fake-indexeddb chains opens on one connection queue and
  // fires onsuccess before advancing it — no sleeps needed.)
  v1.close();
  await probeUpgrade(4);
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

// ── CO-1: sheet revisions at addPdf ─────────────────────────────────────────
// A re-dropped file whose bytes differ must never silently overwrite — the old
// bytes become a numbered revision and the return value says so.

const fileOf = (name: string, bytes: number[]) =>
  ({ name, arrayBuffer: async () => new Uint8Array(bytes).buffer } as any);

test("addPdf: new file is rev 1; identical re-add is a no-op; changed bytes archive a revision", async () => {
  const first = await store.addPdf(fileOf("plan.pdf", [1, 2, 3]));
  assert.equal(first.rev, 1);
  assert.equal(first.revised, undefined);

  // same bytes → unchanged, no new revision minted
  const again = await store.addPdf(fileOf("plan.pdf", [1, 2, 3]));
  assert.equal(again.unchanged, true);
  assert.equal(again.rev, 1);
  assert.deepEqual((await store.listPdfRevisions("plan.pdf")).map((r: any) => r.rev), [1]);

  // changed bytes → archive + swap, atomically visible on both read paths
  const rev2 = await store.addPdf(fileOf("plan.pdf", [9, 9, 9]));
  assert.equal(rev2.revised, true);
  assert.equal(rev2.rev, 2);
  assert.equal(rev2.prev_rev, 1);
  assert.deepEqual(await store.loadPdfData("plan.pdf"), new Uint8Array([9, 9, 9]));
  assert.deepEqual(await store.loadPdfRevisionData("plan.pdf", 1), new Uint8Array([1, 2, 3]));
  // the current record answers for its own rev too
  assert.deepEqual(await store.loadPdfRevisionData("plan.pdf", 2), new Uint8Array([9, 9, 9]));

  const revs = await store.listPdfRevisions("plan.pdf");
  assert.deepEqual(revs.map((r: any) => [r.rev, r.current]), [[2, true], [1, false]]);
  assert.ok(revs.every((r: any) => typeof r.hash === "string" && r.hash.length === 64));
  // metadata only — a trail entry must never carry the PDF bytes
  assert.ok(revs.every((r: any) => !("bytes" in r)));

  await assert.rejects(store.loadPdfRevisionData("plan.pdf", 7), /not found/);
});

test("legacy (pre-v3) pdf records version correctly on first re-drop", async () => {
  // Seed a v2 database the way shipped v2 code wrote it: bytes only, no hash/rev.
  const v2 = await rawOpen(2, (db) => {
    db.createObjectStore("pdfs", { keyPath: "name" });
    db.createObjectStore("meta");
    db.createObjectStore("snapshots", { keyPath: "id" });
  });
  await rawPut(v2, "pdfs", { name: "old.pdf", bytes: new Uint8Array([5, 5]).buffer });
  v2.close();

  // identical re-drop of a legacy record: no phantom revision, identity backfilled
  const same = await store.addPdf(fileOf("old.pdf", [5, 5]));
  assert.equal(same.unchanged, true);
  assert.equal(same.rev, 1);
  assert.deepEqual((await store.listPdfRevisions("old.pdf")).map((r: any) => r.rev), [1]);

  // changed re-drop: the legacy bytes are archived as rev 1
  const rev2 = await store.addPdf(fileOf("old.pdf", [6, 6]));
  assert.equal(rev2.revised, true);
  assert.equal(rev2.prev_rev, 1);
  assert.deepEqual(await store.loadPdfRevisionData("old.pdf", 1), new Uint8Array([5, 5]));
});

test("removePdf clears the revision trail; re-add starts fresh at rev 1", async () => {
  await store.addPdf(fileOf("plan.pdf", [1]));
  await store.addPdf(fileOf("plan.pdf", [2]));
  await store.addPdf(fileOf("plan.pdf", [3]));
  assert.equal((await store.listPdfRevisions("plan.pdf")).length, 3);

  await store.removePdf("plan.pdf");
  assert.deepEqual(await store.listSheets(), []);
  assert.deepEqual(await store.listPdfRevisions("plan.pdf"), []);

  // a fresh add after removal is a new trail, not a continuation
  const back = await store.addPdf(fileOf("plan.pdf", [4]));
  assert.equal(back.rev, 1);
  assert.deepEqual((await store.listPdfRevisions("plan.pdf")).map((r: any) => r.rev), [1]);
});

test("revision trails are per-name: revising A leaves B untouched", async () => {
  await store.addPdf(fileOf("a.pdf", [1]));
  await store.addPdf(fileOf("b.pdf", [1]));
  await store.addPdf(fileOf("a.pdf", [2]));
  assert.deepEqual((await store.listPdfRevisions("a.pdf")).map((r: any) => r.rev), [2, 1]);
  assert.deepEqual((await store.listPdfRevisions("b.pdf")).map((r: any) => [r.rev, r.current]), [[1, true]]);
  // and removing A's trail can't touch B's
  await store.removePdf("a.pdf");
  assert.deepEqual((await store.listPdfRevisions("b.pdf")).map((r: any) => r.rev), [1]);
});

// ── #471 OCR page cache: pdfHash and removal cleanup ────────────────────────
// pdfHash is the cache's identity for a file's bytes. Removal drops the
// removed file's cached reads unless a remaining file or revision still
// carries the same bytes.

const sha = async (bytes: number[]) => Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
const ocrKey = (hash: string, page = 1) => `ocr:v1:${hash}:${page}`;
const OCR_VAL = { v: 1, rev: "r", opts: "x", rs: 2, lines: [], ms: 1, rasters: 1, at: 1 };

async function seedLegacy(name: string, bytes: number[]) {
  const v2 = await rawOpen(2, (db) => {
    db.createObjectStore("pdfs", { keyPath: "name" });
    db.createObjectStore("meta");
    db.createObjectStore("snapshots", { keyPath: "id" });
  });
  await rawPut(v2, "pdfs", { name, bytes: new Uint8Array(bytes).buffer });
  v2.close();
}

// count crypto.subtle.digest calls while fn runs
async function countDigests(fn: () => Promise<void>): Promise<number> {
  const subtle = crypto.subtle as any;
  const orig = subtle.digest;
  let n = 0;
  subtle.digest = function (...args: any[]) { n++; return orig.apply(this, args); };
  try { await fn(); } finally { delete subtle.digest; if (subtle.digest !== orig) subtle.digest = orig; }
  return n;
}

test("pdfHash (local): the record's stored hash, without hashing again; null for a missing file", async () => {
  await store.addPdf(fileOf("h-plan.pdf", [1, 2, 3]));
  let h: any;
  const n = await countDigests(async () => { h = await store.pdfHash("h-plan.pdf"); });
  assert.equal(h, await sha([1, 2, 3]));
  assert.equal(n, 0);
  assert.equal(await store.pdfHash("nope.pdf"), null);
  // a revised file answers with its new bytes' hash
  await store.addPdf(fileOf("h-plan.pdf", [4, 5]));
  assert.equal(await store.pdfHash("h-plan.pdf"), await sha([4, 5]));
  // the scoped store (a project folder) shares the same PDFs
  assert.equal(await createLocalStore("folderX").pdfHash("h-plan.pdf"), await sha([4, 5]));
});

// count IDBObjectStore.get calls on the pdfs store while fn runs
async function countPdfGets(fn: () => Promise<void>): Promise<number> {
  const proto = (globalThis as any).IDBObjectStore.prototype;
  const orig = proto.get;
  let n = 0;
  proto.get = function (...args: any[]) { if (this.name === "pdfs") n++; return orig.apply(this, args); };
  try { await fn(); } finally { proto.get = orig; }
  return n;
}

test("pdfHash (local): memoized per name for the session, so a page-by-page lookup reads the record once", async () => {
  await store.addPdf(fileOf("h-memo.pdf", [3, 1, 4]));
  const want = await sha([3, 1, 4]);
  let got: any[] = [];
  const n = await countPdfGets(async () => {
    got = await Promise.all([1, 2, 3, 4, 5].map(() => store.pdfHash("h-memo.pdf")));
    got.push(await store.pdfHash("h-memo.pdf"), await createLocalStore("folderY").pdfHash("h-memo.pdf"));
  });
  assert.deepEqual(got, Array(7).fill(want));
  assert.equal(n, 1, "one IDB read of the (whole-PDF) record, not one per call");
  // a revision forgets it: the new bytes' hash
  await store.addPdf(fileOf("h-memo.pdf", [2, 7]));
  assert.equal(await store.pdfHash("h-memo.pdf"), await sha([2, 7]));
  // removal forgets it too
  await store.removePdf("h-memo.pdf");
  assert.equal(await store.pdfHash("h-memo.pdf"), null);
  // a miss isn't memoized: the file added later answers
  await store.addPdf(fileOf("h-memo.pdf", [9]));
  assert.equal(await store.pdfHash("h-memo.pdf"), await sha([9]));
});

test("pdfHash (local): a hash asked while addPdf revises the file never sticks with the old bytes", async () => {
  await store.addPdf(fileOf("h-race.pdf", [1, 1]));
  const during = store.pdfHash("h-race.pdf");
  await store.addPdf(fileOf("h-race.pdf", [2, 2]));
  await during;
  assert.equal(await store.pdfHash("h-race.pdf"), await sha([2, 2]));
});

test("pdfHash (local): a hash read from the old record while addPdf revises it is forgotten once the new bytes land", async () => {
  await store.addPdf(fileOf("h-race2.pdf", [5, 5]));
  const proto = (globalThis as any).IDBObjectStore.prototype;
  const orig = proto.get;
  let during: Promise<unknown> | null = null;
  // addPdf's own read of the existing record comes after its first forget:
  // a pdfHash asked right then reads the old record and would be memoized
  proto.get = function (this: any, key: unknown) {
    const req = orig.call(this, key);
    if (this.name === "pdfs" && key === "h-race2.pdf" && !during) during = store.pdfHash("h-race2.pdf");
    return req;
  };
  try { await store.addPdf(fileOf("h-race2.pdf", [6, 6])); } finally { proto.get = orig; }
  assert.ok(during, "the hook ran");
  assert.equal(await during, await sha([5, 5]), "it did read the old record");
  assert.equal(await store.pdfHash("h-race2.pdf"), await sha([6, 6]));
});

test("pdfHashIfKnown (local): the stored record's hash, with no hashing; null for a missing file", async () => {
  await store.addPdf(fileOf("k-plan.pdf", [4, 4]));
  let h: any;
  const n = await countDigests(async () => { h = await store.pdfHashIfKnown("k-plan.pdf"); });
  assert.equal(h, await sha([4, 4]));
  assert.equal(n, 0, "no digest");
  assert.equal(await store.pdfHashIfKnown("k-missing.pdf"), null);
});

test("pdfHashIfKnown (local): an unhashed legacy record is null until pdfHash hashes it", async () => {
  await seedLegacy("ki-legacy.pdf", [5, 5, 5]);
  let h: any;
  const m = await countDigests(async () => { h = await store.pdfHashIfKnown("ki-legacy.pdf"); });
  assert.equal(h, null);
  assert.equal(m, 0, "a legacy record isn't hashed by a background ask");
  // once pdfHash has hashed it this session, it's known
  await store.pdfHash("ki-legacy.pdf");
  assert.equal(await store.pdfHashIfKnown("ki-legacy.pdf"), await sha([5, 5, 5]));
});

test("pdfHash (local): a legacy record is hashed once per session and NOT written back", async () => {
  await seedLegacy("h-legacy.pdf", [7, 7, 7]);
  let a: any, b: any;
  const n = await countDigests(async () => {
    a = await store.pdfHash("h-legacy.pdf");
    b = await store.pdfHash("h-legacy.pdf");
  });
  assert.equal(a, await sha([7, 7, 7]));
  assert.equal(b, a);
  assert.equal(n, 1, "memoized for the session");
  const db = await rawOpen(3);
  const rec = await new Promise<any>((res) => { const r = db.transaction("pdfs").objectStore("pdfs").get("h-legacy.pdf"); r.onsuccess = () => res(r.result); });
  db.close();
  assert.equal(rec.hash, undefined, "not written back");
});

test("pdfHash (local): no crypto.subtle resolves null for a legacy record; an empty file is null", async () => {
  await seedLegacy("h-nosubtle.pdf", [8, 8]);
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    assert.equal(await store.pdfHash("h-nosubtle.pdf"), null);
  } finally {
    Object.defineProperty(globalThis, "crypto", desc);
  }
  // a null isn't memoized: with subtle back, it hashes
  assert.equal(await store.pdfHash("h-nosubtle.pdf"), await sha([8, 8]));
  await store.addPdf(fileOf("h-empty.pdf", []));
  assert.equal(await store.pdfHash("h-empty.pdf"), null, "the empty-input hash is never an identity");
});

test("removePdf: drops cached OCR reads of the file's current bytes and every revision", async () => {
  await store.addPdf(fileOf("r-plan.pdf", [1]));
  await store.addPdf(fileOf("r-plan.pdf", [2]));
  await store.addPdf(fileOf("r-plan.pdf", [3]));
  const [h1, h2, h3, other] = await Promise.all([sha([1]), sha([2]), sha([3]), sha([99])]);
  for (const h of [h1, h2, h3, other]) { await metaPut(ocrKey(h, 1), OCR_VAL); await metaPut(ocrKey(h, 12), OCR_VAL); }
  await store.saveAnnotations({ conditions: [], shapes: [] });

  await store.removePdf("r-plan.pdf");
  for (const h of [h1, h2, h3]) {
    assert.equal(await metaGet(ocrKey(h, 1)), undefined);
    assert.equal(await metaGet(ocrKey(h, 12)), undefined);
  }
  // another PDF's reads and everything else in meta stay
  assert.deepEqual(await metaGet(ocrKey(other, 1)), OCR_VAL);
  assert.ok(await metaGet("annotations"));
});

test("removePdf: keeps cached reads whose bytes another file still has", async () => {
  await store.addPdf(fileOf("s-a.pdf", [1]));
  await store.addPdf(fileOf("s-copy.pdf", [1]));   // same bytes, another name
  const h = await sha([1]);
  await metaPut(ocrKey(h), OCR_VAL);
  await store.removePdf("s-a.pdf");
  assert.deepEqual(await metaGet(ocrKey(h)), OCR_VAL);
  await store.removePdf("s-copy.pdf");
  assert.equal(await metaGet(ocrKey(h)), undefined, "gone with the last file that had it");
});

test("removePdf: keeps cached reads whose bytes are another file's revision", async () => {
  await store.addPdf(fileOf("t-b.pdf", [5]));
  await store.addPdf(fileOf("t-b.pdf", [6]));     // [5] is now t-b's rev 1
  await store.addPdf(fileOf("t-a.pdf", [5]));
  await store.addPdf(fileOf("t-a.pdf", [7]));     // t-a has [5] as a revision too
  const [h5, h7] = await Promise.all([sha([5]), sha([7])]);
  await metaPut(ocrKey(h5), OCR_VAL);
  await metaPut(ocrKey(h7), OCR_VAL);
  await store.removePdf("t-a.pdf");
  assert.deepEqual(await metaGet(ocrKey(h5)), OCR_VAL, "t-b's revision still has these bytes");
  assert.equal(await metaGet(ocrKey(h7)), undefined);
});

test("removePdf: a legacy record's cached reads go too", async () => {
  await seedLegacy("u-legacy.pdf", [4, 4]);
  const h = await sha([4, 4]);
  await metaPut(ocrKey(h), OCR_VAL);
  await store.removePdf("u-legacy.pdf");
  assert.equal(await metaGet(ocrKey(h)), undefined);
});

// OCR cleanup is bookkeeping: it must never fail or block a removal. Faults
// and counts go in at the IndexedDB layer (fake-indexeddb's prototypes),
// patched only while removePdf runs:
//   • existence check  = a key cursor on "meta" in a readonly transaction
//   • prefix delete    = a key cursor on "meta" in a readwrite transaction
//   • the file's hashes = the pre-delete get of its "pdfs" record
//   • the walk         = a value cursor on the "pdfs" store
type Patch = { proto: any; method: string; wrap: (orig: Function) => Function };

const txMode = (os: any) => os.transaction.mode;
const onStore = (os: any, name: string, mode?: string) => os.name === name && (!mode || txMode(os) === mode);

async function underPatches(patches: Patch[], fn: () => Promise<void>) {
  const saved = patches.map((p) => [p.proto, p.method, p.proto[p.method]] as const);
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  for (const p of patches) p.proto[p.method] = p.wrap(p.proto[p.method]);
  try { await fn(); } finally {
    for (const [proto, method, orig] of saved) proto[method] = orig;
    console.warn = warn;
  }
  return warnings;
}

// fail (or count) the calls on IDBObjectStore.prototype[method] (or another
// IDB class's, via `proto`) that `hit` picks
function storeFault(method: string, hit: (os: any) => boolean, counter?: { n: number }, fail = true, proto: any = (globalThis as any).IDBObjectStore.prototype): Patch {
  return {
    proto,
    method,
    wrap: (orig) => function (this: any, ...args: any[]) {
      if (hit(this)) {
        if (counter) counter.n++;
        if (fail) throw new Error(`injected ${method} failure`);
      }
      return orig.apply(this, args);
    },
  };
}

async function trailGone(name: string) {
  assert.deepEqual(await store.listPdfRevisions(name), []);
  assert.ok(!(await store.listSheets()).some((s: any) => s.name === name));
}

// the Nth readonly existence check (1 = before the delete, 2 = after)
const nthExistenceCheck = (nth: number) => {
  let seen = 0;
  return (os: any) => onStore(os, "meta", "readonly") && ++seen === nth;
};

// the warning pins which catch block ran
const BEFORE = /couldn't read the removed file's hashes/;
const AFTER = /couldn't clear/;

for (const [label, make, warned] of [
  ["the existence check before the delete", () => storeFault("openKeyCursor", nthExistenceCheck(1)), BEFORE],
  ["the existence check after the delete", () => storeFault("openKeyCursor", nthExistenceCheck(2)), AFTER],
  ["reading the file's hashes (its pdfs record)", () => storeFault("get", (os) => onStore(os, "pdfs")), BEFORE],
  // listPdfRevisions' readonly index cursor; the delete's readwrite one still runs
  ["reading the revision trail", () => storeFault("openCursor", (idx) => onStore(idx.objectStore, "pdf_revs", "readonly"), undefined, true, (globalThis as any).IDBIndex.prototype), BEFORE],
  ["walking the remaining records", () => storeFault("openCursor", (os) => onStore(os, "pdfs")), AFTER],
  ["metaDeletePrefix", () => storeFault("openKeyCursor", (os) => onStore(os, "meta", "readwrite")), AFTER],
] as const) {
  test(`removePdf: a throw in ${label} still removes the file and its revisions`, async () => {
    await store.addPdf(fileOf("f-plan.pdf", [1]));
    await store.addPdf(fileOf("f-plan.pdf", [2]));
    await metaPut(ocrKey(await sha([1])), OCR_VAL);
    await metaPut(ocrKey(await sha([2])), OCR_VAL);
    const hits = { n: 0 };
    const patch = make() as Patch;
    const wrap = patch.wrap;
    patch.wrap = (orig) => { const w = wrap(orig); return function (this: any, ...a: any[]) { try { return w.apply(this, a); } catch (e) { hits.n++; throw e; } }; };
    const warnings = await underPatches([patch], async () => { await store.removePdf("f-plan.pdf"); });
    assert.equal(hits.n, 1, "the fault was reached");
    await trailGone("f-plan.pdf");
    assert.equal(warnings.length, 1, "the failure is logged once, not swallowed silently");
    assert.match(String(warnings[0][0]), warned);
  });
}

test("removePdf: with no cached OCR reads at all, nothing is hashed and no trail is read", async () => {
  await seedLegacy("q-legacy.pdf", [3, 3, 3]);
  await store.addPdf(fileOf("q-plan.pdf", [1]));
  await store.addPdf(fileOf("q-plan.pdf", [2]));
  const gets = { n: 0 };
  const walks = { n: 0 };
  let digests = -1;
  await underPatches([
    storeFault("get", (os) => onStore(os, "pdfs"), gets, false),
    storeFault("openCursor", (os) => onStore(os, "pdfs"), walks, false),
  ], async () => {
    digests = await countDigests(async () => {
      await store.removePdf("q-legacy.pdf");
      await store.removePdf("q-plan.pdf");
    });
  });
  assert.equal(digests, 0, "no legacy digest");
  assert.equal(gets.n, 0, "the file's record isn't read for hashes");
  assert.equal(walks.n, 0, "no walk");
  await trailGone("q-legacy.pdf");
  await trailGone("q-plan.pdf");
});

test("removePdf: skips the walk over every stored PDF unless the removed file's hashes have cached reads", async () => {
  await store.addPdf(fileOf("w-plan.pdf", [1]));
  await store.addPdf(fileOf("w-other.pdf", [9]));
  await metaPut(ocrKey(await sha([9])), OCR_VAL);   // cached reads exist, but not this file's
  const walks = { n: 0 };
  const countWalks = () => [storeFault("openCursor", (os) => onStore(os, "pdfs"), walks, false)];
  await underPatches(countWalks(), async () => { await store.removePdf("w-plan.pdf"); });
  assert.equal(walks.n, 0);
  await metaPut(ocrKey(await sha([9, 9])), OCR_VAL);
  await store.addPdf(fileOf("w-two.pdf", [9, 9]));
  await underPatches(countWalks(), async () => { await store.removePdf("w-two.pdf"); });
  assert.equal(walks.n, 1, "walks once when there is something to decide");
  assert.equal(await metaGet(ocrKey(await sha([9, 9]))), undefined);
  assert.deepEqual(await metaGet(ocrKey(await sha([9]))), OCR_VAL);
});

test("removePdf: a legacy file hashed this session keeps the reads of the bytes it shares", async () => {
  await seedLegacy("k-legacy.pdf", [6, 6]);
  assert.equal(await store.pdfHash("k-legacy.pdf"), await sha([6, 6]));
  await store.addPdf(fileOf("k-a.pdf", [6, 6]));
  await metaPut(ocrKey(await sha([6, 6])), OCR_VAL);
  await store.removePdf("k-a.pdf");
  assert.deepEqual(await metaGet(ocrKey(await sha([6, 6]))), OCR_VAL);
});
