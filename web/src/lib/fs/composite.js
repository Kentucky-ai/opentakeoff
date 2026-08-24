// Assemble the FOLDER-SYNCED local-first store (#316). The anonymous local
// workspace stays canonical — same IndexedDB, same PDFs, same annotations blob
// — and the linked folder becomes a best-effort sync target through the exact
// reconciler + snapshot layers the Drive path uses. Only the provider differs:
// a directory handle instead of a Drive client, zero credentials, zero network
// code.
//
// Mirrors sync/composite.js deliberately:
//   { ...localStore, ...annSync, ...snapSync }
// localStore keeps PDFs/manifest local (a synced folder is an ANNOTATION
// transport — plan PDFs already live in the folder via the shop's own sync
// client, and the app never duplicates them into it). annSync overrides
// loadAnnotations/saveAnnotations; snapSync the 4 snapshot methods. No
// `listFolder`, so the canvas's cloudMode duck-typing stays false — folder
// mode is local mode with a shadow.
//
// CUT-LINE: dynamically imported by main.jsx only when a folder link exists,
// so the plain anonymous bundle never pulls in any sync code.

import { localStore } from "../store.js";
import { createSyncStore } from "../sync/syncStore.js";
import { createSnapshotSync } from "../google/snapshotSync.js";
import { createPresence, ensureDeviceId } from "../sync/presence.js";
import { authorName } from "../provenance.js";
import { createFsProvider, createFsSnapshotProvider } from "./fsProvider.js";

/**
 * @param {string} scope    the minted fsync-<uuid> namespacing this link's sync meta
 * @param {() => Promise<FileSystemDirectoryHandle>} getDir resolves the linked
 *   folder handle (throws when gone/denied — the reconciler reads that as offline)
 * @returns the composite store carrying a non-enumerable `syncBridge`, same
 *   contract the canvas already binds for the Drive composite.
 */
export function buildFolderStore(scope, getDir) {
  const bridge = { onRemoteUpdate: null, isBusy: null, flushPending: null };

  const snapProvider = createFsSnapshotProvider(getDir);
  // The fs transport's shared-sidecar resolver: locate-or-create is one call
  // (path ids), so snapshots and presence agree on ".opentakeoff" for free.
  const ensureSidecarId = async () => {
    await snapProvider.createFolder("", ".opentakeoff");
    return ".opentakeoff";
  };

  const snapSync = createSnapshotSync({
    base: localStore,
    provider: snapProvider,
    ensureSidecarId,
    // null scope: the anonymous workspace's own snapshot history stays ONE
    // history — snapshots made before the folder was linked keep appearing,
    // and pulled records materialize into the same scope they list from.
    folderId: null,
  });

  const annSync = createSyncStore({
    base: localStore, // createLocalStore(null) IS localStore — the workspace continues
    provider: createFsProvider(getDir),
    folderId: scope,  // sync:<scope>:* bookkeeping, distinct per linked folder
    onRemoteUpdate: (data, rev) => bridge.onRemoteUpdate?.(data, rev),
    isBusy: () => bridge.isBusy?.() ?? false,
    saveSnapshot: (label, payload) => snapSync.saveSnapshot(label, payload, null),
  });
  bridge.flushPending = annSync.flushPending;
  // Folder reads are free and local — expose the lazy remote check so the
  // gate can poll on a slow cadence (a teammate's push through the sync
  // client is noticed without waiting for a local edit to conflict).
  bridge.checkRemote = annSync.checkRemote;

  // Presence (#317) rides the same provider surface. A 2-minute beat is
  // gentle on any sync client while keeping "last seen" honest; writes only
  // happen once an author name is declared (privacy default). The gate stops
  // it on unmount via bridge.presence.
  (async () => {
    const deviceId = await ensureDeviceId();
    const presence = createPresence({
      provider: snapProvider,
      ensureSidecarId,
      deviceId,
      getAuthor: authorName,
      getSheet: () => bridge.getSheet?.() ?? null,
      intervalMs: 2 * 60_000,
    });
    bridge.presence = presence;
    presence.start();
  })().catch(() => { /* presence is advisory — never blocks the store */ });

  const composite = { ...localStore, ...annSync, ...snapSync };
  Object.defineProperty(composite, "syncBridge", { value: bridge, enumerable: false });
  // setActiveStore calls this when the composite is swapped out — the
  // heartbeat must not keep writing into a folder the user left.
  Object.defineProperty(composite, "dispose", { enumerable: false, value: () => bridge.presence?.stop() });
  return composite;
}
