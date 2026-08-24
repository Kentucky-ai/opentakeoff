// Assemble the OPTED-IN local-first composite store (Slice 5). Local IndexedDB is
// canonical for annotations + snapshots (with optional best-effort Drive sync),
// while PDFs / the sheet manifest stay Drive-canonical (big, team-owned, shared).
//
// Built by spread-composition — later spreads shadow earlier methods:
//   { ...cloud, ...annSync, ...snapSync }
// annSync overrides loadAnnotations/saveAnnotations; snapSync overrides the 4
// snapshot methods; cloud keeps PDFs/manifest/listFolder (so the canvas's
// `cloudMode` duck-typing on `store.listFolder` still holds) plus the sidecar
// resolvers. `addPdf`'s internal `this.addSheets` still resolves because neither
// sync layer shadows addSheets.
//
// CUT-LINE: this module (and the sync modules it imports) is dynamically imported
// by main.jsx ONLY on the opted-in path, so the legacy path and the anonymous
// bundle never pull in any Drive-sync code.

import { createLocalStore, localStore } from "../store.js";
import { createSyncStore } from "./syncStore.js";
import { createDriveProvider } from "./provider.js";
import { createPresence, ensureDeviceId } from "./presence.js";
import { authorName } from "../provenance.js";
import { createSnapshotSync } from "../google/snapshotSync.js";
import { driveSnapshotProvider } from "../google/snapshotSyncAdapter.js";

/**
 * @param {string} projectId Drive project folder id (also the local sync/snapshot scope)
 * @param {any} drive        createDrive({ getToken }) instance
 * @param {any} cloud        an already-built createCloudStore(projectId, drive) — supplies
 *   PDFs/manifest + the shared sidecar resolvers (ensureSidecarId/findSidecarFolder)
 * @returns the composite store, carrying a non-enumerable `syncBridge` the canvas
 *   registers its onRemoteUpdate/isBusy handlers into on mount.
 */
export function buildLocalFirstStore(projectId, drive, cloud) {
  // The bridge carries the canvas's reconcile handlers into the otherwise plain-JS
  // reconciler and hands its flushPending back out. Handlers start null (the store's
  // bootstrap seed can fire before the canvas registers) and are null-guarded at
  // both call sites in createSyncStore's options below.
  const bridge = { onRemoteUpdate: null, isBusy: null, flushPending: null };

  const snapSync = createSnapshotSync({
    base: localStore,                          // snapshots stay browser-local, scoped by folderId
    provider: driveSnapshotProvider(drive),
    folderId: projectId,
    ensureSidecarId: cloud.ensureSidecarId,    // shared resolver (F4 — one `.opentakeoff`, no split-brain)
  });

  const annSync = createSyncStore({
    base: createLocalStore(projectId),         // per-project local annotations (canonical)
    provider: createDriveProvider(projectId, drive, {
      ensureSidecarId: cloud.ensureSidecarId,  // shared resolver (F4)
      findSidecarId: cloud.findSidecarFolder,  // non-creating read path (a viewer never litters an empty sidecar)
    }),
    folderId: projectId,
    onRemoteUpdate: (data, rev) => bridge.onRemoteUpdate?.(data, rev),  // null until the canvas registers
    isBusy: () => bridge.isBusy?.() ?? false,                          // null → not busy (safe default)
    saveSnapshot: (label, payload, fid) => snapSync.saveSnapshot(label, payload, fid), // loser backups sync via Slice 2
  });
  bridge.flushPending = annSync.flushPending;  // canvas idle-drain hook (used in Slice 5b)

  // Presence (#317) — the same heartbeat files, through the Drive provider
  // surface snapshots already ride. A 10-minute beat keeps an 8-hour session
  // to ~50 writes plus one read per live peer per beat: background noise on
  // Drive quota. Writes only once an author name is declared (#314).
  (async () => {
    const deviceId = await ensureDeviceId();
    const presence = createPresence({
      provider: driveSnapshotProvider(drive),
      ensureSidecarId: cloud.ensureSidecarId,   // shared resolver (F4 — one `.opentakeoff`)
      deviceId,
      getAuthor: authorName,
      getSheet: () => bridge.getSheet?.() ?? null,
      intervalMs: 10 * 60_000,
    });
    bridge.presence = presence;
    presence.start();
  })().catch(() => { /* presence is advisory — never blocks the store */ });

  const composite = { ...cloud, ...annSync, ...snapSync };
  // Non-enumerable so it rides the live `store` binding to the canvas without
  // polluting the store shape or the composite spread. Canvas reads store.syncBridge.
  Object.defineProperty(composite, "syncBridge", { value: bridge, enumerable: false });
  // setActiveStore calls this when the composite is swapped out (project
  // switch, exit to local) — the heartbeat must not keep writing into a
  // project the user left.
  Object.defineProperty(composite, "dispose", { enumerable: false, value: () => bridge.presence?.stop() });
  return composite;
}
