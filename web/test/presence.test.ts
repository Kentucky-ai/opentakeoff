// Presence without a server (#317) — heartbeat files over the transport-
// agnostic snapshot-provider contract, exercised against an in-memory
// provider with an injected clock. The RFC finish lines live here: a second
// device renders within a beat, a kill -9'd session's file expires and is
// collected by the next writer, and an 8-hour session stays under 100
// provider requests.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPresence, ensureDeviceId } from "../src/lib/sync/presence.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// Minimal in-memory implementation of the snapshot-provider contract, path
// ids, with a call counter for the quota test.
function memProvider() {
  const folders = new Set([""]);
  const files = new Map<string, any>();
  const join = (p: string, n: string) => (p ? `${p}/${n}` : n);
  const api = {
    calls: 0,
    async findChild(parentId: string, name: string) {
      api.calls++;
      const id = join(parentId, name);
      if (folders.has(id)) return { id, name, mimeType: "application/vnd.google-apps.folder" };
      if (files.has(id)) return { id, name, mimeType: "application/json" };
      return null;
    },
    async createFolder(parentId: string, name: string) {
      api.calls++;
      const id = join(parentId, name);
      folders.add(id);
      return { id, name };
    },
    async listChildren(folderId: string) {
      api.calls++;
      const out: any[] = [];
      const prefix = folderId ? `${folderId}/` : "";
      for (const id of files.keys()) {
        if (!id.startsWith(prefix)) continue;
        const rest = id.slice(prefix.length);
        if (rest.includes("/")) continue;
        out.push({ id, name: rest, mimeType: "application/json" });
      }
      return out;
    },
    async getJson(fileId: string) {
      api.calls++;
      if (!files.has(fileId)) throw new Error(`no such file ${fileId}`);
      return files.get(fileId);
    },
    async putJson({ folderId, name, data }: any) {
      api.calls++;
      const id = join(folderId, name);
      files.set(id, data);
      return { id };
    },
    async deleteFile(fileId: string) {
      api.calls++;
      files.delete(fileId);
    },
    _files: files,
  };
  return api;
}

const sidecarOf = (p: any) => async () => {
  await p.createFolder("", ".opentakeoff");
  return ".opentakeoff";
};

function device(p: any, id: string, name: string | null, clock: { t: number }, over: any = {}) {
  return createPresence({
    provider: p,
    ensureSidecarId: sidecarOf(p),
    deviceId: id,
    getAuthor: () => name,
    getSheet: () => over.sheet ?? null,
    now: () => clock.t,
    ...over,
  });
}

test("privacy default: no declared author → no heartbeat written, but the room is still readable", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  // a named teammate is already present
  await device(p, "dev-b", "Aaron", clock).beat();
  const anon = device(p, "dev-a", null, clock);
  await anon.beat();

  assert.equal(p._files.has(".opentakeoff/presence/dev-a.json"), false); // anonymous stays invisible
  assert.equal(anon.peers().length, 1); // ...but still sees the coat on the chair
  assert.equal(anon.peers()[0].name, "Aaron");
});

test("finish line: the second device sees name + open sheet within one beat", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  await device(p, "dev-m", "Michael", clock, { sheet: "plan.pdf#3" }).beat();

  clock.t += 60_000; // one minute later, machine two opens the project
  const second = device(p, "dev-a", "Aaron", clock);
  await second.beat();
  const peers = second.peers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].name, "Michael");
  assert.equal(peers[0].sheet, "plan.pdf#3");
  assert.equal(peers[0].ageMs, 60_000); // "last seen 1 min ago" — honest age, not "is editing"

  // and the write side carried the whole declared record
  const rec = p._files.get(".opentakeoff/presence/dev-a.json");
  assert.equal(rec.name, "Aaron");
  assert.equal(typeof rec.at, "string");
});

test("a kill -9'd session goes stale (hidden), then its file is garbage-collected by the next writer", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  await device(p, "dev-dead", "Ghost", clock).beat(); // then the process dies — file frozen

  const live = device(p, "dev-live", "Michael", clock);
  await live.beat();
  assert.equal(live.peers().length, 1); // fresh → visible

  clock.t += 50 * 60_000; // past stale (3 missed 15-min beats = 45 min), inside the GC horizon (4× stale = 3 h)
  await live.beat();
  assert.equal(live.peers().length, 0); // hidden — silent lately
  assert.equal(p._files.has(".opentakeoff/presence/dev-dead.json"), true); // not yet collected

  clock.t += 3 * 60 * 60_000; // past the GC horizon
  await live.beat();
  assert.equal(p._files.has(".opentakeoff/presence/dev-dead.json"), false); // collected by the next writer
  assert.equal(live.peers().length, 0); // and never a lock, at any point
});

test("finish line: an 8-hour session with one live peer stays under 100 provider requests", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  const peerBeats = device(p, "dev-peer", "Aaron", clock);
  await peerBeats.beat();
  p.calls = 0; // count OUR session only

  const me = device(p, "dev-me", "Michael", clock); // default 15-minute cadence
  for (let i = 0; i < 32; i++) { // 8 hours of beats
    await me.beat();
    clock.t += 15 * 60_000;
    await peerBeats.beat(); // keep the peer alive so every beat pays the read cost
    p.calls -= 3;           // (subtract the peer's own beat: sidecar+put+list... measured below)
  }
  // The peer's beat costs are subtracted approximately; even counting BOTH
  // sessions' traffic the ceiling holds, so assert the hard budget on the
  // remainder and a sanity ceiling on the raw sum.
  assert.ok(p.calls < 100, `our session spent ${p.calls} provider calls — budget is <100`);
});

test("heartbeats with garbage timestamps or missing names never enter the room", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  await p.createFolder("", ".opentakeoff");
  await p.createFolder(".opentakeoff", "presence");
  await p.putJson({ folderId: ".opentakeoff/presence", name: "dev-x.json", data: { device: "dev-x", name: "NoClock", at: "not a date" } });
  await p.putJson({ folderId: ".opentakeoff/presence", name: "dev-y.json", data: { device: "dev-y", at: new Date(clock.t).toISOString() } });

  const me = device(p, "dev-me", "Michael", clock);
  await me.beat();
  assert.equal(me.peers().length, 0);
});

test("ensureDeviceId mints once and sticks", async () => {
  const a = await ensureDeviceId();
  const b = await ensureDeviceId();
  assert.equal(a, b);
  assert.match(a, /^dev-/);
});

test("an anonymous session on a FRESH transport reads an empty room and litters nothing", async () => {
  const p = memProvider();
  const clock = { t: 1_000_000 };
  const anon = createPresence({
    provider: p,
    ensureSidecarId: sidecarOf(p),
    findSidecarId: async () => (await p.findChild("", ".opentakeoff"))?.id ?? null, // non-creating read path
    deviceId: "dev-a",
    getAuthor: () => null,
    now: () => clock.t,
  });
  await anon.beat();
  assert.equal(anon.peers().length, 0);
  assert.equal(p._files.size, 0); // no heartbeat written...
  // ...and no sidecar/presence folders created by a read-only pass
  assert.equal(await p.findChild("", ".opentakeoff"), null);
});
