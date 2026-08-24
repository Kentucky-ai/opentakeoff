// Filesystem sync provider (#316) — contract tests over a memory-backed
// FileSystemDirectoryHandle fake that mirrors the platform's write discipline
// (createWritable buffers; content commits ONLY on close), plus the flagship:
// two REAL reconcilers (createSyncStore + #313 merge, real fake-indexeddb
// local stores) converging through a simulated sync client that replicates
// whole files between two roots — including the forced-concurrent-write
// sibling fork the RFC's finish line names.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFsProvider, createFsSnapshotProvider, listConflictCopies } from "../src/lib/fs/fsProvider.js";
import { createSyncStore } from "../src/lib/sync/syncStore.js";
import { createLocalStore } from "../src/lib/store.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// ── the fake File System Access surface ────────────────────────────────────
// Files hold a string; createWritable buffers and commits on close() — the
// platform's temp-write-then-commit atomicity, which the crash test leans on.

function fakeRoot(name = "root") {
  type Node = { kind: "file"; contents: string } | { kind: "directory"; children: Map<string, Node> };
  const mkDir = (): Node => ({ kind: "directory", children: new Map() });
  const root: Node = mkDir();

  function dirHandle(node: Node, dname: string): any {
    if (node.kind !== "directory") throw new Error("not a directory");
    return {
      kind: "directory",
      name: dname,
      async getDirectoryHandle(n: string, { create = false } = {}) {
        let child = node.children.get(n);
        if (!child) {
          if (!create) throw new Error(`NotFoundError: ${n}`);
          child = mkDir();
          node.children.set(n, child);
        }
        if (child.kind !== "directory") throw new Error(`TypeMismatchError: ${n}`);
        return dirHandle(child, n);
      },
      async getFileHandle(n: string, { create = false } = {}) {
        let child = node.children.get(n);
        if (!child) {
          if (!create) throw new Error(`NotFoundError: ${n}`);
          child = { kind: "file", contents: "" };
          node.children.set(n, child);
        }
        if (child.kind !== "file") throw new Error(`TypeMismatchError: ${n}`);
        const f = child as { kind: "file"; contents: string };
        return {
          kind: "file",
          name: n,
          async getFile() {
            return { text: async () => f.contents };
          },
          async createWritable() {
            let buf = "";
            return {
              async write(s: string) { buf += s; },
              async close() { f.contents = buf; }, // commit happens HERE, atomically
            };
          },
        };
      },
      async removeEntry(n: string) {
        if (!node.children.delete(n)) throw new Error(`NotFoundError: ${n}`);
      },
      async *entries() {
        for (const [n, child] of node.children) {
          yield [n, child.kind === "directory" ? dirHandle(child, n) : { kind: "file", name: n }];
        }
      },
    };
  }
  return dirHandle(root, name);
}

// The "sync client": whole-file replication of the annotations sidecar from
// one root to another — exactly what a real agent does (never live appends).
async function replicate(from: any, to: any) {
  const src = await from.getDirectoryHandle(".opentakeoff");
  const fh = await src.getFileHandle("annotations.json");
  const text = await (await fh.getFile()).text();
  const dst = await to.getDirectoryHandle(".opentakeoff", { create: true });
  const out = await dst.getFileHandle("annotations.json", { create: true });
  const w = await out.createWritable();
  await w.write(text);
  await w.close();
}

const getDirOf = (root: any) => async () => root;

// ── provider contract ──────────────────────────────────────────────────────

test("fs pull: fresh folder → null; push mints rev 1 and pull round-trips it", async () => {
  const root = fakeRoot();
  const p = createFsProvider(getDirOf(root));
  assert.equal(await p.pull(), null);

  const res: any = await p.push({ conditions: [{ id: "c1" }], shapes: [] }, { expectedRev: null });
  assert.equal(res.rev, 1);
  const pulled: any = await p.pull();
  assert.equal(pulled.rev, 1);
  assert.deepEqual(pulled.data.conditions, [{ id: "c1" }]);
});

test("fs push precondition: a remote at a different rev is refused with the remote handed back", async () => {
  const root = fakeRoot();
  const p = createFsProvider(getDirOf(root));
  await p.push({ conditions: [{ id: "theirs" }], shapes: [] }, { expectedRev: null }); // rev 1

  const res: any = await p.push({ conditions: [{ id: "mine" }], shapes: [] }, { expectedRev: 4 } as any);
  assert.equal(res.conflict, true);
  assert.equal(res.remote.rev, 1);
  assert.deepEqual(res.remote.data.conditions, [{ id: "theirs" }]);
  const pulled: any = await p.pull();
  assert.deepEqual(pulled.data.conditions, [{ id: "theirs" }]); // nothing was written
});

test("fs write atomicity: a crash before close leaves the previous sidecar intact", async () => {
  const root = fakeRoot();
  const p = createFsProvider(getDirOf(root));
  await p.push({ conditions: [{ id: "v1" }], shapes: [] }, { expectedRev: null });

  // wrap the root so the NEXT createWritable's close crashes mid-commit
  const sabotaged = {
    ...root,
    async getDirectoryHandle(n: string, opts: any) {
      const dir = await root.getDirectoryHandle(n, opts);
      return {
        ...dir,
        async getFileHandle(fn: string, fopts: any) {
          const fh = await dir.getFileHandle(fn, fopts);
          return {
            ...fh,
            async createWritable() {
              return { async write() {}, async close() { throw new Error("disk full"); } };
            },
          };
        },
      };
    },
  };
  const p2 = createFsProvider(async () => sabotaged);
  await assert.rejects(p2.push({ conditions: [{ id: "v2" }], shapes: [] }, { expectedRev: 1 } as any));
  const pulled: any = await p.pull();
  assert.equal(pulled.rev, 1); // old content fully intact — no half-written sidecar
  assert.deepEqual(pulled.data.conditions, [{ id: "v1" }]);
});

test("fs pull propagates corrupt JSON (caller keeps local canonical)", async () => {
  const root = fakeRoot();
  const sidecar = await root.getDirectoryHandle(".opentakeoff", { create: true });
  const fh = await sidecar.getFileHandle("annotations.json", { create: true });
  const w = await fh.createWritable();
  await w.write("{ this is not json");
  await w.close();
  const p = createFsProvider(getDirOf(root));
  await assert.rejects(p.pull());
});

test("conflict copies are surfaced by name — sync-client fork styles all match", async () => {
  const root = fakeRoot();
  const sidecar = await root.getDirectoryHandle(".opentakeoff", { create: true });
  for (const name of [
    "annotations.json",                                  // ours — excluded
    "annotations (1).json",                              // Drive/OneDrive style
    "annotations.sync-conflict-20260824-142233-ABCDEF.json", // Syncthing style
    "annotations (Ed's MacBook's conflicted copy 2026-08-24).json", // Dropbox style
    "snapshots.json",                                    // unrelated — excluded
  ]) {
    await (async () => {
      const fh = await sidecar.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write("{}");
      await w.close();
    })();
  }
  const copies = await listConflictCopies(getDirOf(root));
  assert.deepEqual(copies, [
    "annotations (1).json",
    "annotations (Ed's MacBook's conflicted copy 2026-08-24).json",
    "annotations.sync-conflict-20260824-142233-ABCDEF.json",
  ]);
});

test("fs snapshot provider satisfies the snapshot-sync contract (paths as ids)", async () => {
  const root = fakeRoot();
  const sp = createFsSnapshotProvider(getDirOf(root));

  assert.equal(await sp.findChild("", ".opentakeoff"), null);
  await sp.createFolder("", ".opentakeoff");
  const side: any = await sp.findChild("", ".opentakeoff");
  assert.equal(side.id, ".opentakeoff");
  assert.equal(side.mimeType, "application/vnd.google-apps.folder");

  await sp.createFolder(".opentakeoff", "snapshots");
  const put: any = await sp.putJson({ folderId: ".opentakeoff/snapshots", name: "s1.json", data: { id: "s1", project: null } });
  assert.equal(put.id, ".opentakeoff/snapshots/s1.json");
  assert.deepEqual(await sp.getJson(put.id), { id: "s1", project: null });

  const kids: any[] = await sp.listChildren(".opentakeoff/snapshots");
  assert.deepEqual(kids.map((k) => k.name), ["s1.json"]);

  await sp.deleteFile(put.id);
  assert.deepEqual(await sp.listChildren(".opentakeoff/snapshots"), []);
});

// ── the flagship: two machines, one synced folder ──────────────────────────

const mkShape = (id: string) => ({
  id, sheet_id: "plan.pdf#1", condition_id: "c1",
  verts_norm: [[0, 0], [0.1, 0], [0.1, 0.1]],
  created_at: "2026-08-24T00:00:00.000Z",
});
const shapeIds = (ann: any) => ann.shapes.map((s: any) => s.id).sort();

function machine(tag: string, root: any) {
  const snaps: any[] = [];
  const base = createLocalStore(`m${tag}`);
  const sync = createSyncStore({
    base,
    provider: createFsProvider(getDirOf(root)),
    folderId: `scope${tag}`, // each machine mints its OWN sync scope, like fsAccess does
    saveSnapshot: async (label: string, payload: any) => { snaps.push({ label, payload }); return { id: `s${snaps.length}` }; },
  }) as any;
  return { base, sync, snaps };
}

test("#316 finish line: two machines converge through the folder; a forced concurrent write is detected and resolved with zero losers", async () => {
  const rootA = fakeRoot("A");
  const rootB = fakeRoot("B");

  // Machine A starts the takeoff and pushes.
  const A = machine("A", rootA);
  await A.sync.whenSynced();
  const seed = { conditions: [{ id: "c1" }], shapes: [mkShape("S1"), mkShape("S2")] };
  await A.sync.saveAnnotations(seed);
  await A.sync.whenPushed();

  // The sync client replicates to machine B, which seeds from the folder.
  await replicate(rootA, rootB);
  const B = machine("B", rootB);
  await B.sync.whenSynced();
  assert.deepEqual(shapeIds(await B.base.loadAnnotations()), ["S1", "S2"]); // seeded

  // FORCED CONCURRENT WRITE: both machines commit new work and push before
  // either syncs — both mint rev 2 in their own copy of the folder.
  await A.sync.saveAnnotations({ ...seed, shapes: [...seed.shapes, mkShape("LA")] });
  await A.sync.whenPushed();
  await B.sync.saveAnnotations({ ...seed, shapes: [...seed.shapes, mkShape("LB")] });
  await B.sync.whenPushed();

  // The sync client picks a file-level winner: A's rev 2 lands on B's disk,
  // burying B's rev 2. Same rev, different content — the sibling fork.
  await replicate(rootA, rootB);

  // B's lazy remote check sees content at its own rev that isn't what it
  // synced → fork → UNION merge (no fabricated deletions) → re-push rev 3.
  await B.sync.checkRemote();
  await B.sync.whenPushed();
  assert.deepEqual(shapeIds(await B.base.loadAnnotations()), ["LA", "LB", "S1", "S2"]);
  assert.equal(B.snaps.length, 0); // zero losers — nothing needed rescuing

  // Replication brings B's union back to A; A three-way merges forward.
  await replicate(rootB, rootA);
  await A.sync.checkRemote();
  await A.sync.whenPushed();
  assert.deepEqual(shapeIds(await A.base.loadAnnotations()), ["LA", "LB", "S1", "S2"]);
  assert.equal(A.snaps.length, 0);

  // Both roots hold the identical converged payload at the same rev.
  const finalA: any = await createFsProvider(getDirOf(rootA)).pull();
  const finalB: any = await createFsProvider(getDirOf(rootB)).pull();
  assert.equal(finalA.rev, 3);
  assert.equal(finalB.rev, 3);
  assert.deepEqual(shapeIds(finalA.data), ["LA", "LB", "S1", "S2"]);
});

test("#316 rev regression (sync client restores an old file) routes through the reconciler — snapshotted remote-wins, never a wrong-ancestor merge", async () => {
  const root = fakeRoot();
  const A = machine("R", root);
  await A.sync.whenSynced();
  await A.sync.saveAnnotations({ conditions: [{ id: "c1" }], shapes: [mkShape("S1")] });
  await A.sync.whenPushed();
  await A.sync.saveAnnotations({ conditions: [{ id: "c1" }], shapes: [mkShape("S1"), mkShape("S2")] });
  await A.sync.whenPushed(); // rev 2 on disk, ancestor rev 2

  // The sync client "restores" rev 1 over the sidecar (an old backup wins).
  const p = createFsProvider(getDirOf(root));
  const sidecar = await root.getDirectoryHandle(".opentakeoff");
  const fh = await sidecar.getFileHandle("annotations.json");
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ conditions: [{ id: "c1" }], shapes: [mkShape("S1")], rev: 1 }));
  await w.close();

  await A.sync.checkRemote(); // regression detected: rev 1 < synced 2, content ≠ ancestor
  // Uniform remote-wins with the local side snapshotted — S2 is in the backup,
  // not silently deleted by a three-way against a NEWER ancestor.
  assert.deepEqual(shapeIds(await A.base.loadAnnotations()), ["S1"]);
  assert.equal(A.snaps.length, 1);
  assert.deepEqual(shapeIds(A.snaps[0].payload), ["S1", "S2"]);
  const cur: any = await p.pull();
  assert.equal(cur.rev, 1); // reconcile adopts locally; no re-push over the restore
});
