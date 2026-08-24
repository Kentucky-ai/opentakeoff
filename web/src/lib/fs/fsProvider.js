// Filesystem sync providers (#316) — any synced folder is a team transport.
// The provider seam (sync/provider.js) was written so that any backend that
// can read-then-write a JSON blob qualifies; a directory IS that backend. The
// OS sync client the shop already runs (a document-library agent, a network
// share, a peer-to-peer daemon) owns transport, auth, and encryption — the app
// holds a FileSystemDirectoryHandle and ZERO credentials, and adds no network
// code.
//
// Two providers over one handle:
//   • createFsProvider     — the annotation reconciler's pull/push contract,
//     writing <folder>/.opentakeoff/annotations.json (the SAME sidecar name
//     and rev discipline as the Drive provider, so the payload is transport-
//     portable byte-for-byte).
//   • createFsSnapshotProvider — the snapshot-sync provider contract
//     (findChild/createFolder/listChildren/getJson/putJson/deleteFile) with
//     RELATIVE PATHS as ids, so snapshotSync (and anything else built on that
//     contract) rides the folder unchanged.
//
// Write discipline: createWritable() writes to a temp file and commits on
// close() — that atomicity is the whole crash story. The push path never
// leaves a half-written sidecar for the sync client to replicate.
//
// The sync client is a Byzantine peer (RFC hazards, all handled ABOVE the
// provider or surfaced by it):
//   • It never fails a precondition — it mints CONFLICT-COPY siblings
//     ("annotations (1).json", "annotations.sync-conflict-…"). listConflictCopies
//     surfaces them by name; the UI shows them instead of orphaning a fork.
//   • Replication lag can serve yesterday's file. The rev INSIDE the payload is
//     the only truth; a rev regression reads as divergence and routes through
//     the reconciler's existing conflict handling (merge with an ancestor,
//     remote-wins without) — never a crash.
//
// getDir is an async () => FileSystemDirectoryHandle. It throws when the
// handle is gone or permission lapsed; that throw propagates out of pull/push,
// which the reconciler already treats as "offline" (local stays canonical).

const SIDECAR_NAME = ".opentakeoff";
const ANN_NAME = "annotations.json";
// snapshotSync compares against the Drive folder mime; the fs provider speaks
// the same token so the consumer stays provider-blind.
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Same rev semantics as sync/provider.js: an INTEGER or null. Non-integers
// (corrupt/hand-edited) are treated as absent rather than trusted.
function revOf(data) {
  return Number.isInteger(data?.rev) ? data.rev : null;
}

async function dirChild(dir, name, { create = false } = {}) {
  try {
    return await dir.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
}
async function fileChild(dir, name, { create = false } = {}) {
  try {
    return await dir.getFileHandle(name, { create });
  } catch {
    return null;
  }
}
async function readJson(fileHandle) {
  const f = await fileHandle.getFile();
  return JSON.parse(await f.text());
}
// The atomic write: temp-file-then-commit is createWritable's own contract.
async function writeJson(fileHandle, data) {
  const w = await fileHandle.createWritable();
  await w.write(JSON.stringify(data));
  await w.close();
}

/** The annotation reconciler's provider (pull/push) over a directory handle. */
export function createFsProvider(getDir) {
  return {
    // { data, rev } | null when no sidecar/file exists yet (fresh folder —
    // the caller seeds). A handle failure or corrupt JSON PROPAGATES, exactly
    // like the Drive provider: the reconciler keeps local canonical.
    async pull() {
      const dir = await getDir();
      const sidecar = await dirChild(dir, SIDECAR_NAME);
      if (!sidecar) return null;
      const fh = await fileChild(sidecar, ANN_NAME);
      if (!fh) return null;
      const data = await readJson(fh); // corrupt JSON throws → caller decides
      return { data, rev: revOf(data) };
    },

    // App-level precondition, same as every provider: re-read the current
    // remote rev and compare. The sync client can't refuse a write for us —
    // this check is the only precondition there is, which is exactly why the
    // reconciler treats its answer as advisory (a client-minted conflict copy
    // or a lag-served old file still resolves upstream via the rev counter).
    async push(data, { expectedRev = null } = {}) {
      const dir = await getDir();
      const sidecar = await dir.getDirectoryHandle(SIDECAR_NAME, { create: true });
      const fh = await sidecar.getFileHandle(ANN_NAME, { create: true });
      let remote = null;
      try {
        remote = await readJson(fh); // a just-created file is empty → parse throws → null
      } catch {
        remote = null;
      }
      const remoteRev = revOf(remote);
      if (expectedRev != null && remoteRev !== expectedRev) {
        return { conflict: true, remote: { data: remote, rev: remoteRev } };
      }
      const nextRev = (expectedRev ?? remoteRev ?? 0) + 1;
      await writeJson(fh, { ...data, rev: nextRev });
      return { rev: nextRev };
    },
  };
}

// Conflict-copy siblings of the annotations sidecar, surfaced BY NAME. Sync
// clients fork instead of failing: "annotations (1).json" (Drive/OneDrive
// style), "annotations.sync-conflict-20260824-…" (Syncthing),
// "annotations (…ConflictedCopy…).json" (Dropbox). Anything in the sidecar
// folder that looks like our file but isn't exactly it is a fork someone has
// to look at — returning it is the feature.
export async function listConflictCopies(getDir) {
  const dir = await getDir();
  const sidecar = await dirChild(dir, SIDECAR_NAME);
  if (!sidecar) return [];
  const names = [];
  for await (const [name, handle] of sidecar.entries()) {
    if (handle.kind !== "file" || name === ANN_NAME) continue;
    const stem = ANN_NAME.replace(/\.json$/, "");
    if (name.startsWith(stem) || /conflict/i.test(name)) names.push(name);
  }
  return names.sort();
}

// ── the snapshot-sync provider contract over the same handle ───────────────
// Ids are RELATIVE PATHS from the project folder root ("" = the root itself),
// so ids stay stable across sessions and derivable from names — the same
// property Drive file-ids give snapshotSync's enumeration.

const joinPath = (parent, name) => (parent ? `${parent}/${name}` : name);

export function createFsSnapshotProvider(getDir) {
  async function resolveDir(pathId, { create = false } = {}) {
    let dir = await getDir();
    if (!pathId) return dir;
    for (const seg of pathId.split("/")) {
      const next = await dirChild(dir, seg, { create });
      if (!next) return null;
      dir = next;
    }
    return dir;
  }

  return {
    async findChild(parentId, name) {
      const dir = await resolveDir(parentId);
      if (!dir) return null;
      const sub = await dirChild(dir, name);
      if (sub) return { id: joinPath(parentId, name), name, mimeType: FOLDER_MIME };
      const fh = await fileChild(dir, name);
      if (fh) return { id: joinPath(parentId, name), name, mimeType: "application/json" };
      return null;
    },

    async createFolder(parentId, name) {
      const dir = await resolveDir(parentId, { create: true });
      await dir.getDirectoryHandle(name, { create: true });
      return { id: joinPath(parentId, name), name };
    },

    async listChildren(folderId) {
      const dir = await resolveDir(folderId);
      if (!dir) return [];
      const out = [];
      for await (const [name, handle] of dir.entries()) {
        out.push({
          id: joinPath(folderId, name),
          name,
          mimeType: handle.kind === "directory" ? FOLDER_MIME : "application/json",
        });
      }
      return out;
    },

    async getJson(fileId) {
      const i = fileId.lastIndexOf("/");
      const dir = await resolveDir(i === -1 ? "" : fileId.slice(0, i));
      if (!dir) throw new Error(`fs provider: no such folder for ${fileId}`);
      const fh = await fileChild(dir, fileId.slice(i + 1));
      if (!fh) throw new Error(`fs provider: no such file ${fileId}`);
      return readJson(fh);
    },

    async putJson({ folderId, name, data }) {
      const dir = await resolveDir(folderId, { create: true });
      const fh = await dir.getFileHandle(name, { create: true });
      await writeJson(fh, data); // atomic: temp-write, commit on close
      return { id: joinPath(folderId, name) };
    },

    async deleteFile(fileId) {
      const i = fileId.lastIndexOf("/");
      const dir = await resolveDir(i === -1 ? "" : fileId.slice(0, i));
      if (!dir) return;
      await dir.removeEntry(fileId.slice(i + 1)).catch(() => {});
    },
  };
}
