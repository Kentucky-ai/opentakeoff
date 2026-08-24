// Microsoft 365 sync configuration (#315) — build-time, self-hoster-owned.
// The feature is DARK unless the build names an Entra app registration and a
// document-library drive; an unconfigured build renders no 365 UI at all.
// See SELF_HOSTING.md ("Microsoft 365 annotation sync") for the app
// registration walkthrough and how to find the drive id.
//
//   VITE_MSAL_CLIENT_ID   Entra application (client) id — SPA platform,
//                         redirect URI = the app's own origin
//   VITE_MSAL_TENANT      tenant id or domain; defaults to "organizations"
//                         (any work/school account)
//   VITE_GRAPH_DRIVE_ID   the document library's Graph drive id
//   VITE_GRAPH_FOLDER_ID  driveItem id of the project folder (default: "root")
//
// Tiny and dependency-free on purpose: PlanNavigator imports this statically
// to decide whether to render the entry point; MSAL itself loads dynamically
// only when the user opts in.

export function m365Config(env = import.meta.env) {
  const clientId = env?.VITE_MSAL_CLIENT_ID || "";
  const driveId = env?.VITE_GRAPH_DRIVE_ID || "";
  if (!clientId || !driveId) return null;
  return {
    clientId,
    tenant: env?.VITE_MSAL_TENANT || "organizations",
    driveId,
    folderId: env?.VITE_GRAPH_FOLDER_ID || "root",
  };
}

export const m365SyncConfigured = (env) => m365Config(env) != null;

// Stable sync-meta scope per (drive, folder): the same library keeps its
// bookkeeping across sessions; pointing the build at a different library
// starts a clean seed/merge instead of inheriting the old one's revs.
export const m365Scope = (cfg) => `m365-${cfg.driveId}-${cfg.folderId}`;

// Opt-in is per-browser and persisted (meta key) — configuration alone never
// changes anyone's store.
export const M365_ENABLED_KEY = "m365:enabled";
