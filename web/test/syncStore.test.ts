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

test("recovery (case c): a rev-less external write on a torn first push is RECONCILED — remote wins, local snapshotted (4c)", async () => {
  // First push torn: marker {targetRev:1, baseRev:null}. Meanwhile a flag-off teammate
  // wrote a rev-less doc. baseRev=null can't distinguish "our push never landed" from an
  // external write by REV alone (both leave remoteRev null) — but it CAN by DATA: our own
  // landed first push would show rev 1 (caught by the targetRev branch), so a null-rev
  // remote carrying actual data is provably external. 4c reconciles it (snapshot the opted
  // local, adopt the teammate's write) rather than blind-overwriting — closing the last
  // unsnapshotted-loss path. (A genuinely-empty remote — our own un-landed push — still
  // re-pushes; see the sibling "crashed FIRST push" test with fakeProvider(null).)
  await metaPut("sync:A:marker", { targetRev: 1, baseRev: null });
  await metaPut("sync:A:touched", true);
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: null }); // rev-less external write
  const snaps: any[] = [];
  const saveSnapshot = async (label: string, payload: any, folderId: string) => { snaps.push({ label, payload, folderId }); return { id: `s${snaps.length}` }; };
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot }) as any;
  await sync.whenSynced();
  await sync.whenPushed();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]); // teammate's write adopted, NOT clobbered
  assert.equal(await metaGet("sync:A:synced_rev"), null); // adopts the rev-less remote's (absent) rev
  assert.equal(snaps.length, 1); // the opted local is snapshotted (recoverable)...
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "mine" }]); // ...as our divergent work
  assert.equal(provider._remote.rev, null); // reconcile adopts LOCALLY — no re-push over the teammate's file
});

test("recovery: a diverged remote is reconciled — remote wins, local snapshotted, synced_rev adopts (4c)", async () => {
  await metaPut("sync:A:marker", { targetRev: 4, baseRev: 3 });
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const base = createLocalStore("A");
  await base.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] }); // our un-pushed local
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 7 }); // someone else moved it
  const snaps: any[] = [];
  const saveSnapshot = async (label: string, payload: any, folderId: string) => { snaps.push({ label, payload, folderId }); return { id: `s${snaps.length}` }; };
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, onRemoteUpdate: (d: any, r: any) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]); // remote adopted as canonical
  assert.equal(await metaGet("sync:A:synced_rev"), 7); // synced_rev advances to remote's rev
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(snaps.length, 1); // the losing local side is snapshotted...
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "mine" }]); // ...as our divergent work
  assert.equal(snaps[0].folderId, "A");
  assert.deepEqual(updates, [{ d: { conditions: [{ id: "theirs" }], shapes: [] }, r: 7 }]); // canvas re-hydrate signalled
  assert.equal(provider._remote.rev, 7); // reconcile adopts LOCALLY — it does not re-push
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

test("push conflict (remote moved out from under us): reconcile — remote wins, local snapshotted, synced_rev adopts (4c)", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 }); // external write at 8
  const snaps: any[] = [];
  const saveSnapshot = async (label: string, payload: any, folderId: string) => { snaps.push({ label, payload, folderId }); return { id: `s${snaps.length}` }; };
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, onRemoteUpdate: (d: any, r: any) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.equal(provider._remote.rev, 8); // remote untouched (push refused; reconcile adopts locally, no re-push)
  assert.deepEqual(provider._remote.data.conditions, [{ id: "theirs" }]);
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]); // remote adopted as canonical
  assert.equal(await metaGet("sync:A:synced_rev"), 8); // synced_rev advances to remote's rev
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(snaps.length, 1); // the losing local edit is snapshotted
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "mine" }]);
  assert.deepEqual(updates, [{ d: { conditions: [{ id: "theirs" }], shapes: [] }, r: 8 }]);
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

// ── Slice 4c: conflict reconciliation (uniform remote-wins + loser-snapshot + gate)

// Records loser-snapshot calls so a test can assert what got backed up.
function recorder() {
  const snaps: any[] = [];
  const saveSnapshot = async (label: string, payload: any, folderId: string) => {
    snaps.push({ label, payload, folderId });
    return { id: `s${snaps.length}` };
  };
  return { snaps, saveSnapshot };
}

test("4c mixed fleet: a rev-LESS remote (flag-off teammate) WINS and the local side is snapshotted", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 2);
  await metaPut("sync:A:touched", true);
  // A flag-off teammate wrote a rev-less doc (unconditional putJson, no rev).
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: null });
  const { snaps, saveSnapshot } = recorder();
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, onRemoteUpdate: (d: any, r: any) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]); // the teammate's real edit survives as canonical
  assert.equal(await metaGet("sync:A:synced_rev"), null); // adopts the rev-less remote's (absent) rev
  assert.equal(snaps.length, 1); // and the opted user's local is recoverable...
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "mine" }]); // ...on the party who can actually see it
  assert.equal(updates.length, 1);
  assert.equal(updates[0].r, null);
});

test("4c defer: while isBusy() the adopt is held (no overwrite, no snapshot); flushPending drains once idle", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const { snaps, saveSnapshot } = recorder();
  const updates: any[] = [];
  let busy = true;
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, isBusy: () => busy, onRemoteUpdate: (d: any, r: any) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  // Busy: nothing adopted, nothing snapshotted, canvas not touched — in-flight work is safe.
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 3);
  assert.equal(snaps.length, 0);
  assert.equal(updates.length, 0);

  // The user goes idle → Slice 5's canvas effect calls flushPending → the adopt runs.
  busy = false;
  await sync.flushPending();
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 8);
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "mine" }]);
  assert.equal(updates.length, 1);
});

test("4c defer: a burst of conflicts while busy yields ONE snapshot of the cumulative local, not O(conflicts)", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const { snaps, saveSnapshot } = recorder();
  let busy = true;
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, isBusy: () => busy }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "v1" }], shapes: [] });
  await sync.saveAnnotations({ conditions: [{ id: "v2" }], shapes: [] });
  await sync.saveAnnotations({ conditions: [{ id: "v3" }], shapes: [] });
  await sync.whenPushed();
  assert.equal(snaps.length, 0); // held while busy

  busy = false;
  await sync.flushPending();
  assert.equal(snaps.length, 1); // exactly one backup...
  assert.deepEqual(snaps[0].payload.conditions, [{ id: "v3" }]); // ...of the latest cumulative local
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]);
});

test("4c collapse: while deferred the freshest discovered remote wins the pending slot", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs1" }], shapes: [] }, rev: 5 });
  const { saveSnapshot } = recorder();
  let busy = true;
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, isBusy: () => busy }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "m1" }], shapes: [] }); // conflicts vs theirs1@5 → pending
  await sync.whenPushed();
  provider._remote = { data: { conditions: [{ id: "theirs2" }], shapes: [] }, rev: 9 }; // remote moves again
  await sync.saveAnnotations({ conditions: [{ id: "m2" }], shapes: [] }); // conflicts vs theirs2@9 → pending replaced
  await sync.whenPushed();

  busy = false;
  await sync.flushPending();
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs2" }]); // freshest, not the stale theirs1
  assert.equal(await metaGet("sync:A:synced_rev"), 9);
});

test("4c degrade: with no saveSnapshot sink, a conflict leaves local ahead (4b behavior) — never a lossy adopt", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", onRemoteUpdate: (_d: any, r: any) => updates.push(r) }) as any; // no saveSnapshot
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]); // local NOT overwritten (loser would be unrecoverable)
  assert.equal(await metaGet("sync:A:synced_rev"), 3); // stays ahead
  assert.deepEqual(provider._remote.data.conditions, [{ id: "theirs" }]); // remote untouched
  assert.equal(await metaGet("sync:A:marker"), undefined);
  assert.equal(updates.length, 0); // no canvas re-hydrate
});

test("4c: a data-less remote (deleted/unreadable) is never adopted over local", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider(null); // remote gone; push with expectedRev set → conflict {data:null, rev:null}
  const { snaps, saveSnapshot } = recorder();
  const updates: any[] = [];
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, onRemoteUpdate: (_d: any, r: any) => updates.push(r) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]); // not overwritten with null
  assert.equal(await metaGet("sync:A:synced_rev"), 3);
  assert.equal(snaps.length, 0);
  assert.equal(updates.length, 0);
});

test("4c crash order: a failing loser-snapshot aborts the adopt — local and synced_rev are untouched (never a partial adopt)", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const updates: any[] = [];
  const saveSnapshot = async () => { throw new Error("snapshot store down"); };
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, onRemoteUpdate: (_d: any, r: any) => updates.push(r) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  // Loser-first ordering: the snapshot precedes the overwrite and synced_rev advances
  // LAST, so a snapshot failure leaves everything as it was — local intact and ahead,
  // recoverable on the next save (never local=remote with the loser unbacked-up).
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]);
  assert.equal(await metaGet("sync:A:synced_rev"), 3);
  assert.equal(updates.length, 0);
});

test("4c crash order: synced_rev advances AFTER the local adopt — a torn adopt-save leaves synced_rev NOT advanced", async () => {
  // Pins the OTHER half of the ordering (the dangerous one): if metaPut(synced_rev)
  // ran BEFORE base.saveAnnotations(remote), a tear would leave synced_rev ahead of an
  // un-adopted local → the next save pushes stale content over the winner at the
  // matching expectedRev and the winner is gone, unsnapshotted. Reverse the two writes
  // in syncStore and this test fails (synced_rev===8).
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const { snaps, saveSnapshot } = recorder();
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot }) as any;
  await sync.whenSynced();

  // Crash the ADOPT save (content === "theirs") but let the user's own save through.
  const realSave = base.saveAnnotations.bind(base);
  base.saveAnnotations = async (p: any) => {
    if (p?.conditions?.[0]?.id === "theirs") throw new Error("adopt-save crash");
    return realSave(p);
  };
  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  assert.equal(snaps.length, 1); // snapshot ran FIRST (loser preserved before any overwrite)
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]); // adopt-save threw → local intact
  assert.equal(await metaGet("sync:A:synced_rev"), 3); // synced_rev NOT advanced → proves it's written LAST
});

test("4c TOCTOU: going busy DURING the pre-adopt snapshot defers the overwrite and RETAINS the pending remote for retry", async () => {
  const base = createLocalStore("A");
  await metaPut("sync:A:synced_rev", 3);
  await metaPut("sync:A:touched", true);
  const provider = fakeProvider({ data: { conditions: [{ id: "theirs" }], shapes: [] }, rev: 8 });
  const snaps: any[] = [];
  const updates: any[] = [];
  let busy = false;
  // The user starts in-flight work exactly during the loser-snapshot await — the window
  // the loop-top isBusy() check can't see. Arm it to fire once so the retry can succeed.
  let armed = true;
  const saveSnapshot = async (label: string, payload: any, folderId: string) => {
    snaps.push({ label, payload, folderId });
    if (armed) { armed = false; busy = true; }
    return { id: `s${snaps.length}` };
  };
  const sync = createSyncStore({ base, provider, folderId: "A", saveSnapshot, isBusy: () => busy, onRemoteUpdate: (d: any, r: any) => updates.push({ d, r }) }) as any;
  await sync.whenSynced();

  await sync.saveAnnotations({ conditions: [{ id: "mine" }], shapes: [] });
  await sync.whenPushed();

  // The re-check right before the destructive overwrite caught the flip → deferred, NOT clobbered.
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "mine" }]); // local intact
  assert.equal(await metaGet("sync:A:synced_rev"), 3); // synced_rev not advanced
  assert.equal(updates.length, 0); // canvas not re-rendered
  assert.equal(snaps.length, 1); // the deferred attempt's backup is durable (harmless immutable extra)

  // Pending was RETAINED (not dropped on defer) → once idle, flushPending adopts it.
  busy = false;
  await sync.flushPending();
  assert.deepEqual(conds(await base.loadAnnotations()), [{ id: "theirs" }]); // now adopted
  assert.equal(await metaGet("sync:A:synced_rev"), 8);
  assert.equal(updates.length, 1);
});

test("4c: flushPending is callable but non-enumerable (survives neither Object.keys nor the composite spread)", async () => {
  const sync = createSyncStore({ base: createLocalStore("A"), provider: fakeProvider(), folderId: "A" }) as any;
  await sync.whenSynced();
  assert.equal(typeof sync.flushPending, "function"); // Slice 5 calls it via the raw annSync ref
  assert.ok(!Object.keys(sync).includes("flushPending")); // but it's invisible to the spread
  await sync.flushPending(); // no-op safe when nothing is pending
});
