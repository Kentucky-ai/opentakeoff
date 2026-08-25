// Assemble the 365-SYNCED local-first store (#315) — the document-library
// flavor of the shared synced-workspace composite. The anonymous local
// workspace stays canonical; the tenant's library folder is the sync target
// through the SAME reconciler + snapshot + presence layers, riding
// createDriveProvider verbatim over the Graph client — the provider seam's
// whole point. Plan PDFs are not duplicated into the library (it is an
// ANNOTATION transport; the plans already live wherever the shop keeps them).
//
// The graph client is injected so tests build this over a mock tenant; the
// gate builds it with createGraphDrive + MSAL's getToken.
//
// CUT-LINE: dynamically imported by main.jsx only on the opted-in 365 path.

import { buildSyncedWorkspaceStore } from "../sync/workspaceComposite.js";
import { createDriveProvider } from "../sync/provider.js";
import { m365Scope } from "./config.js";

const SIDECAR_NAME = ".opentakeoff";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * @param {{driveId: string, folderId: string, clientId?: string, tenant?: string}} cfg
 * @param {any} graph a createGraphDrive-shaped client (injected — MSAL-backed
 *   in the app, a mock tenant in tests)
 */
export function buildM365Store(cfg, graph) {
  // Shared `.opentakeoff` resolver under the configured project folder —
  // memoized locate-else-create (cleared on failure so a blip retries), the
  // same F4 one-sidecar discipline every transport enforces.
  let sidecarP = null;
  const ensureSidecarId = () => {
    if (!sidecarP) {
      sidecarP = (async () => {
        const child = await graph.findChild(cfg.folderId, SIDECAR_NAME);
        if (child && child.mimeType === FOLDER_MIME) return child.id;
        const { id } = await graph.createFolder(cfg.folderId, SIDECAR_NAME);
        return id;
      })().catch((e) => { sidecarP = null; throw e; });
    }
    return sidecarP;
  };
  // Non-creating read path: a viewer pulling a fresh library never litters an
  // empty sidecar folder into the tenant.
  const findSidecarId = async () => {
    const child = await graph.findChild(cfg.folderId, SIDECAR_NAME);
    return child && child.mimeType === FOLDER_MIME ? child.id : null;
  };

  return buildSyncedWorkspaceStore({
    scope: m365Scope(cfg),
    provider: createDriveProvider(cfg.folderId, graph, { ensureSidecarId, findSidecarId }),
    snapProvider: graph, // the Graph client IS the snapshot-provider contract
    ensureSidecarId,
    findSidecarId,
    // Graph quota is generous but not free — the Drive path's lazy 10-minute
    // heartbeat is the right neighbor here too.
    presenceIntervalMs: 10 * 60_000,
  });
}
