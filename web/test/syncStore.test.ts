// Annotation reconciler (sync/syncStore.js, Slice 4b) — push + seed + crash
// recovery. Runs against REAL IndexedDB meta + a REAL createLocalStore (via
// fake-indexeddb) and a fake provider, so the durable state machine and the
// crash-torn write ordering are exercised for real, not mocked away.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSyncStore } from "../src/lib/sync/syncStore.js";
import { createLocalStore, metaGet, metaPut } from "../src/lib/store.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// A provider mirroring createDriveProvider's pull/push contract over an in-memory
// remote { data, rev } | null. `_failPull` throws (offline); `_pullHook` runs at
// the start of pull (to simulate a concurrent edit landing mid-pull).
function fakeProvider(initial: any = null) {
  return {
    _remote: initial as any,
    _failPull: false,
    _pullHook: null as null | (() => Promise<void>),
    async pull() {
      if (this._pullHook) await this._pullHook();
      if (this._failPull) throw new Error("offline");
      return this._remote ? { data: this._remote.data, rev: this._remote.rev } : null;
    },
    async push(data: any, { expectedRev = null }: any = {}) {
      const remoteRev = this._remote ? this._remote.rev : null;
      if (expectedRev != null && remoteRev !== expectedRev) {
        return { conflict: true, remote: this._remote ? { data: this._remote.data, rev: remoteRev } : { data: null, rev: null } };
      }
      const nextRev = (expectedRev ?? remoteRev ?? 0) + 1;
      this._remote = { data, rev: nextRev };
      return { rev: nextRev };
    },
  };
}

const conds = (ann: any) => ann.conditions;

test("fresh project: save writes local, pushes rev 1, sets synced_rev + touched, clears marker", async () => {
  const base = createLocalStore("A");
  const provider = fakeProvider();
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "c1" }], shapes: [] });
  await sync.whenPushed();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "c1" }]); // local content
  assert.equal(provider._remote.rev, 1); // pushed at rev 1
  assert.deepEqual(provider._remote.data.conditions, [{ id: "c1" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 1);
  assert.equal(await metaGet("sync:A:touched"), true);
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(typeof (await metaGet("sync:A:last_pushed_at")), "number");
});

test("loadAnnotations returns local instantly and never throws a network error", async () => {
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "local" }], shapes: [] });
  const provider = fakeProvider();
  provider._failPull = true; // every pull throws
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  assert.deepEqual(conds(await sync.loadAnnotations()), [{ id: "local" }]); // must not throw
  await sync.whenSynced(); // bootstrap swallowed the failed pull
});

test("mount seed: an untouched project adopts remote wholesale and signals onRemoteUpdate", async () => {
  const base = createLocalStore("A");
  const provider = fakeProvider({ data: { conditions: [{ id: "remote" }], shapes: [] }, rev: 4 });
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", onRemoteUpdate: (d, r) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "remote" }]); // adopted
  assert.equal(await metaGet("sync:A:synced_rev"), 4);
  assert.equal(await metaGet("sync:A:touched"), undefined); // adopting is NOT a local edit
  assert.equal(updates.length, 1);
  assert.equal(updates[0].r, 4);
  assert.deepEqual(updates[0].d.conditions, [{ id: "remote" }]);
});

test("mount seed is skipped once touched — a prior edit is never overwritten by remote", async () => {
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await metaPut("sync:A:touched", true); // a prior session's real edit
  const provider = fakeProvider({ data: { conditions: [{ id: "remote" }], shapes: [] }, rev: 9 });
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", onRemoteUpdate: (_d, r) => updates.push(r) }) as any;
  await sync.whenSynced();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]);
  assert.equal(updates.length, 0);
});

test("mount seed aborts if the user starts editing during the pull (re-check touched)", async () => {
  const base = createLocalStore("A");
  const provider = fakeProvider({ data: { conditions: [{ id: "remote" }], shapes: [] }, rev: 2 });
  provider._pullHook = async () => { await metaPut("sync:A:touched", true); }; // edit lands mid-pull
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  assert.notDeepEqual(conds(await base.loadAnnotations()), [{ id: "remote" }]); // not adopted
  assert.equal(await metaGet("sync:A:synced_rev"), undefined);
});

test("crash ordering: touched is written BEFORE content, so a torn save never loses the edit to a later seed", async () => {
  const base = createLocalStore("A");
  const provider = fakeProvider(); // no remote yet → the mount seed is a no-op
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  // simulate a crash between the touched-put and the content write
  const realSave = base.saveAnnotations;
  base.saveAnnotations = async () => { throw new Error("crash before content persists"); };
  await assert.rejects(sync.saveAnnotations({ conditions: [{ id: "edit" }], shapes: [] }));
  assert.equal(await metaGet("sync:A:touched"), true); // set even though content didn't persist (safe tear)
  base.saveAnnotations = realSave;

  // remote now appears; a fresh mount must NOT seed-adopt it over this intended edit
  provider._remote = { data: { conditions: [{ id: "remote" }], shapes: [] }, rev: 3 };
  const updates: any[] = [];
  const sync2 = createSyncStore({ base, provider, folderId: "A", onRemoteUpdate: (_d, r) => updates.push(r) }) as any;
  await sync2.whenSynced();
  assert.equal(updates.length, 0, "touched=true blocks the seed");
});

test("recovery: a marker matching remote's rev means the push HAD landed → adopt, clear marker", async () => {
  await metaPut("sync:A:marker", { targetRev: 5, baseRev: 4 });
  await metaPut("sync:A:synced_rev", 4);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [], shapes: [] }, rev: 5 }); // it landed
  const sync = createSyncStore({ base: createLocalStore("A"), provider, folderId: "A" }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.equal(await metaGet("sync:A:synced_rev"), 5);
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(provider._remote.rev, 5); // no spurious re-push
});

test("recovery: remote still at our baseRev means the push never landed → re-push", async () => {
  await metaPut("sync:A:marker", { targetRev: 5, baseRev: 4 });
  await metaPut("sync:A:synced_rev", 4);
  await metaPut("sync:A:touched", true);
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "ahead" }], shapes: [] }); // local one ahead
  const provider = fakeProvider({ data: { conditions: [], shapes: [] }, rev: 4 }); // did NOT land (still at base 4)
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 5); // re-pushed
  assert.deepEqual(provider._remote.data.conditions, [{ id: "ahead" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 5);
  assert.equal(await metaGet("sync:A:marker"), undefined);
});

test("recovery: a crashed FIRST push (rev-less base) re-pushes instead of silently dropping", async () => {
  // first push: synced_rev was unset, so the marker recorded baseRev null / targetRev 1
  await metaPut("sync:A:marker", { targetRev: 1, baseRev: null });
  await metaPut("sync:A:touched", true);
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "first" }], shapes: [] });
  const provider = fakeProvider(null); // remote still empty — the push never landed
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 1); // re-pushed, not silently lost to Drive
  assert.deepEqual(provider._remote.data.conditions, [{ id: "first" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 1);
  assert.equal(await metaGet("sync:A:marker"), undefined);
});

test("recovery (case c): a rev-less external write on a torn first push is blind-overwritten (intentional 4c deferral)", async () => {
  // First push torn: marker {targetRev:1, baseRev:null}. Meanwhile a flag-off
  // teammate wrote a rev-less doc. baseRev=null can't distinguish "our push never
  // landed" from that external write, so 4b re-pushes over it — the SAME outcome a
  // normal no-crash save produces (a rev-less remote loses in 4b; 4c is what
  // snapshots the local side). Pinned so 4c can't silently regress this behavior.
  await metaPut("sync:A:marker", { targetRev: 1, baseRev: null });
  await metaPut("sync:A:touched", true);
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: null }); // rev-less external write
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 1); // re-pushed (not stranded locally)
  assert.deepEqual(provider._remote.data.conditions, [{ id: "mine" }]); // 4b overwrites the rev-less remote
});

test("recovery: no re-push when the remote diverged from our base (left for 4c)", async () => {
  await metaPut("sync:A:marker", { targetRev: 4, baseRev: 3 });
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 7 }); // someone else moved it
  const sync = createSyncStore({ base: createLocalStore("A"), provider, folderId: "A" }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 7); // NOT blindly re-pushed over a divergent remote
  assert.deepEqual(provider._remote.data.conditions, [{ id: "theirs" }]);
  assert.equal(await metaGet("sync:A:marker"), undefined); // 4c reconciles the local-ahead state
});

test("recovery offline: marker kept and synced_rev untouched when Drive can't be read", async () => {
  await metaPut("sync:A:marker", { targetRev: 5, baseRev: 4 });
  await metaPut("sync:A:synced_rev", 4);
  const provider = fakeProvider({ data: {}, rev: 5 });
  provider._failPull = true; // offline
  const sync = createSyncStore({ base: createLocalStore("A"), provider, folderId: "A" }) as any;
  await sync.whenSynced();

  assert.deepEqual(await metaGet("sync:A:marker"), { targetRev: 5, baseRev: 4 }); // kept for a later retry
  assert.equal(await metaGet("sync:A:synced_rev"), 4); // never assumed
});

test("recovery drops a garbage marker", async () => {
  await metaPut("sync:A:marker", { nope: true });
  const sync = createSyncStore({ base: createLocalStore("A"), provider: fakeProvider(), folderId: "A" }) as any;
  await sync.whenSynced();
  assert.equal(await metaGet("sync:A:marker"), undefined);
});

test("expectedRev comes from durable synced_rev: a restored OLD snapshot pushes clean (#73 stays retired)", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 5);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [], shapes: [] }, rev: 5 });
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  // a restore replays old content (with no/stale rev) through saveAnnotations
  await sync.saveAnnotations({ conditions: [{ id: "restored" }], shapes: [] });
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 6); // synced_rev+1, NOT rejected
  assert.deepEqual(provider._remote.data.conditions, [{ id: "restored" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 6);
});

test("push conflict (remote moved out from under us): no write, marker cleared, synced_rev held for 4c", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 }); // external write at 8
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 8); // remote untouched (push refused)
  assert.deepEqual(provider._remote.data.conditions, [{ id: "theirs" }]);
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(await metaGet("sync:A:synced_rev"), 3); // local stays ahead; 4c reconciles
});

test("rapid saves coalesce: the remote ends at the latest content", async () => {
  const base = createLocalStore("A");
  const provider = fakeProvider();
  const sync = createSyncStore({ base, provider, folderId: "A" }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "v1" }], shapes: [] });
  await sync.saveAnnotations({ conditions: [{ id: "v2" }], shapes: [] });
  await sync.saveAnnotations({ conditions: [{ id: "v3" }], shapes: [] });
  await sync.whenPushed();

  assert.deepEqual(provider._remote.data.conditions, [{ id: "v3" }]); // latest
  assert.equal(await metaGet("sync:A:synced_rev"), provider._remote.rev);
});

test("createSyncStore fails fast on a miswired base or provider", () => {
  const base = createLocalStore("A");
  assert.throws(() => createSyncStore({ base, provider: null as any, folderId: "A" }), /provider/);
  assert.throws(() => createSyncStore({ base, provider: {} as any, folderId: "A" }), /provider/);
  assert.throws(() => createSyncStore({ base: null as any, provider: fakeProvider(), folderId: "A" }), /base/);
});

test("the sync store exposes ONLY loadAnnotations + saveAnnotations", async () => {
  const sync = createSyncStore({ base: createLocalStore("A"), provider: fakeProvider(), folderId: "A" }) as any;
  await sync.whenSynced();
  assert.deepEqual(Object.keys(sync).sort(), ["loadAnnotations", "saveAnnotations"]);
});
