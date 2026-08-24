// The synced-WORKSPACE composite, shared by every transport that shadows the
// anonymous local workspace (#316 folder, #315 365 library). The local store
// stays canonical — same IndexedDB, same PDFs, same annotations blob — and
// the transport is a best-effort sync target through the exact reconciler +
// snapshot + presence layers the Drive project path uses. Only the injected
// providers differ.
//
// Shape: { ...localStore, ...annSync, ...snapSync } — annSync overrides
// loadAnnotations/saveAnnotations, snapSync the 4 snapshot methods. No
// `listFolder`, so the canvas's cloudMode duck-typing stays false: a synced
// workspace is local mode with a shadow. The non-enumerable `syncBridge`
// carries the canvas handlers, checkRemote, and presence; the non-enumerable
// `dispose` stops the heartbeat when setActiveStore swaps the composite out.
//
// CUT-LINE: imported only by the transport composites, which main.jsx pulls
// in dynamically — the plain anonymous bundle never loads any of this.

import { localStore } from "../store.js";
import { createSyncStore } from "./syncStore.js";
import { createSnapshotSync } from "../google/snapshotSync.js";
import { createPresence, ensureDeviceId } from "./presence.js";
import { authorName } from "../provenance.js";

/**
 * @param {object} opts
 * @param {string} opts.scope     namespaces this transport's sync:<scope>:* meta
 * @param {any} opts.provider     annotation-sync provider (pull/push)
 * @param {any} opts.snapProvider snapshot-provider contract (findChild/createFolder/
 *   listChildren/getJson/putJson/deleteFile) — also carries presence
 * @param {() => Promise<string>} opts.ensureSidecarId shared `.opentakeoff` resolver
 *   for this transport (one sidecar, no split-brain)
 * @param {() => Promise<string|null>} [opts.findSidecarId] non-creating resolver —
 *   read paths (an anonymous presence pass) never litter a fresh transport
 * @param {number} [opts.presenceIntervalMs] heartbeat cadence — pick per
 *   transport quota (folder: cheap; Graph/Drive: lazy)
 */
export function buildSyncedWorkspaceStore({ scope, provider, snapProvider, ensureSidecarId, findSidecarId, presenceIntervalMs = 10 * 60_000 }) {
  const bridge = { onRemoteUpdate: null, isBusy: null, flushPending: null };

  const snapSync = createSnapshotSync({
    base: localStore,
    provider: snapProvider,
    ensureSidecarId,
    // null scope: the anonymous workspace's snapshot history stays ONE history
    // — snapshots made before syncing was linked keep appearing, and pulled
    // records materialize into the same scope they list from.
    folderId: null,
  });

  const annSync = createSyncStore({
    base: localStore, // createLocalStore(null) IS localStore — the workspace continues
    provider,
    folderId: scope,
    onRemoteUpdate: (data, rev) => bridge.onRemoteUpdate?.(data, rev),
    isBusy: () => bridge.isBusy?.() ?? false,
    saveSnapshot: (label, payload) => snapSync.saveSnapshot(label, payload, null),
  });
  bridge.flushPending = annSync.flushPending;
  bridge.checkRemote = annSync.checkRemote;
  // Quiescence hooks (non-enumerable on annSync, so the spread drops them) —
  // the gates and tests await these; the store shape itself stays clean.
  bridge.whenSynced = annSync.whenSynced;
  bridge.whenPushed = annSync.whenPushed;

  // Presence (#317) rides the same provider surface. Started async (device id
  // lives in IDB); advisory — a failure never blocks the store.
  (async () => {
    const deviceId = await ensureDeviceId();
    const presence = createPresence({
      provider: snapProvider,
      ensureSidecarId,
      findSidecarId,
      deviceId,
      getAuthor: authorName,
      getSheet: () => bridge.getSheet?.() ?? null,
      intervalMs: presenceIntervalMs,
    });
    bridge.presence = presence;
    presence.start();
  })().catch(() => { /* presence is advisory */ });

  const composite = { ...localStore, ...annSync, ...snapSync };
  Object.defineProperty(composite, "syncBridge", { value: bridge, enumerable: false });
  Object.defineProperty(composite, "dispose", { enumerable: false, value: () => bridge.presence?.stop() });
  return composite;
}
