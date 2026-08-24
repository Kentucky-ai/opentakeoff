// Folder-sync access layer (#316) — the browser-facing half: feature
// detection, the persisted FileSystemDirectoryHandle, and the permission
// lifecycle. The provider (fsProvider.js) stays pure over an injected getDir;
// everything Chromium-specific lives here.
//
// Handle persistence: FileSystemDirectoryHandle is structured-cloneable, so it
// persists in the same IndexedDB meta store the sync layer already owns
// (fsync:handle). Persisted handles come back with permission in the "prompt"
// state after a browser restart — the re-grant is a ONE-CLICK readable state
// (FolderGate renders it), never a mystery: requestPermission needs a user
// gesture, so boot can only query, and the gate's button does the asking.
//
// The File System Access API is Chromium-only today. isFolderSyncSupported()
// gates every entry point, so on other engines the feature degrades to the
// existing stores with no dead UI.

import { metaGet, metaPut, metaDelete } from "../store.js";
import { mintUuid } from "../provenance.js";

const K_HANDLE = "fsync:handle";
const K_SCOPE = "fsync:scope"; // namespaces this link's sync:<scope>:* meta

export function isFolderSyncSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** The persisted link, or null. { handle, scope, name } */
export async function loadFolderLink() {
  const handle = await metaGet(K_HANDLE);
  const scope = await metaGet(K_SCOPE);
  if (!handle || typeof scope !== "string") return null;
  return { handle, scope, name: handle.name };
}

/** "granted" | "prompt" | "denied" — query only (no gesture needed). */
export async function queryFolderPermission(handle) {
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

/** Ask for readwrite on the persisted handle. MUST run in a user gesture. */
export async function requestFolderPermission(handle) {
  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

// Pick a folder and persist the link. MUST run in a user gesture. Each link
// mints a fresh scope so its sync bookkeeping (sync:<scope>:*) never inherits
// a previous folder's touched/synced_rev/base — linking folder B after
// folder A starts from a clean seed/merge, not A's revision history.
// Returns the link, or null when the user cancels the picker.
export async function linkFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return null; // user cancelled (AbortError) — not an error state
  }
  const scope = `fsync-${mintUuid()}`;
  await metaPut(K_HANDLE, handle);
  await metaPut(K_SCOPE, scope);
  return { handle, scope, name: handle.name };
}

/** Drop the link and its sync bookkeeping. Local annotations are untouched. */
export async function forgetFolder() {
  const scope = await metaGet(K_SCOPE);
  await metaDelete(K_HANDLE);
  await metaDelete(K_SCOPE);
  if (typeof scope === "string") {
    for (const k of ["touched", "synced_rev", "marker", "last_pushed_at", "synced_base"]) {
      await metaDelete(`sync:${scope}:${k}`);
    }
  }
}
