// Assemble the FOLDER-SYNCED local-first store (#316) — the folder flavor of
// the shared synced-workspace composite (sync/workspaceComposite.js). The
// anonymous local workspace stays canonical; the linked folder is a
// best-effort sync target with zero credentials and zero network code — the
// OS sync client owns transport. Plan PDFs are NOT duplicated into the folder
// (a synced folder is an ANNOTATION transport; the plans already live there
// via the shop's own sync client).
//
// CUT-LINE: dynamically imported by main.jsx only when a folder link exists.

import { buildSyncedWorkspaceStore } from "../sync/workspaceComposite.js";
import { createFsProvider, createFsSnapshotProvider } from "./fsProvider.js";

/**
 * @param {string} scope    the minted fsync-<uuid> namespacing this link's sync meta
 * @param {() => Promise<FileSystemDirectoryHandle>} getDir resolves the linked
 *   folder handle (throws when gone/denied — the reconciler reads that as offline)
 */
export function buildFolderStore(scope, getDir) {
  const snapProvider = createFsSnapshotProvider(getDir);
  // The fs transport's shared-sidecar resolver: locate-or-create is one call
  // (path ids), so snapshots and presence agree on ".opentakeoff" for free.
  const ensureSidecarId = async () => {
    await snapProvider.createFolder("", ".opentakeoff");
    return ".opentakeoff";
  };
  return buildSyncedWorkspaceStore({
    scope,
    provider: createFsProvider(getDir),
    snapProvider,
    ensureSidecarId,
    findSidecarId: async () => (await snapProvider.findChild("", ".opentakeoff"))?.id ?? null,
    // A 2-minute beat is gentle on any sync client while keeping "last seen"
    // honest; folder reads/writes are free and local.
    presenceIntervalMs: 2 * 60_000,
  });
}
