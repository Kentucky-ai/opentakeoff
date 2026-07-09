// Project home — the testable core of the `/` landing screen.
//
// Two concerns, both free of DOM/React so they run under node: listing the
// project folders inside the team's "Projects" Shared Drive root (the browse
// list), and a browser-local recents list so a returning estimator can jump
// straight back into the folders they had open. Recents are per-browser by
// design — they are a convenience pointer, not shared state. Accepted
// non-goal: two tabs remembering projects at once race on the single storage
// key and the last write wins; losing one recency bump is harmless.

export function projectHomeFolderId() {
  // Vite inlines this at build; empty string = project home off. Guarded read
  // because under node (tests) import.meta.env is undefined.
  return (import.meta.env && import.meta.env.VITE_DRIVE_ROOT_FOLDER_ID) || "";
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * List the project folders inside the Projects root, name-sorted. The mimeType
 * option makes the real drive client filter SERVER-side (injected into the q
 * query). Drive shortcuts to folders won't appear — a shortcut carries its own
 * shortcut mimeType, consistent with cloudStore.listFolder.
 * @param {ReturnType<import('./google/drive.js').createDrive>} drive
 * @param {string} folderId
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function listProjectFolders(drive, folderId) {
  const children = await drive.listChildren(folderId, { mimeType: FOLDER_MIME });
  return children
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The storage to hand createRecents in a browser. Not just a null-check:
// with site data blocked, ACCESSING window.localStorage throws a
// SecurityError — before any getItem/setItem createRecents could guard.
// Degrade to an inert storage so the home screen still renders.
export function browserStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* blocked site data — fall through */ }
  return { getItem: () => null, setItem: () => {} };
}

const RECENTS_KEY = "opentakeoff_recent_projects";
const RECENTS_MAX = 12;

/**
 * Browser-local recently-opened projects over an injected Web-Storage-like
 * object (prod passes localStorage). Entries are plain { id, name }.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} storage
 */
export function createRecents(storage) {
  return {
    /** @returns {{ id: string, name: string }[]} most-recent-first */
    list() {
      let parsed;
      try {
        parsed = JSON.parse(storage.getItem(RECENTS_KEY));
      } catch {
        return [];   // corrupt JSON, or getItem itself threw — treat as empty
      }
      if (!Array.isArray(parsed)) return [];
      // Only well-formed { id, name } entries survive — anything else under our
      // key (older shapes, hand edits) is dropped rather than crashing the UI.
      return parsed
        .filter((e) => e && typeof e.id === "string" && typeof e.name === "string")
        .map((e) => ({ id: e.id, name: e.name }));
    },
    /** @param {{ id: string, name: string }} entry */
    remember({ id, name }) {
      // Move-to-front on a repeat visit; the fresh name wins (folder renames).
      const rest = this.list().filter((e) => e.id !== id);
      const next = [{ id, name }, ...rest].slice(0, RECENTS_MAX);
      // Best-effort: setItem can throw (Safari private mode, quota) and losing
      // a recency bump must never break opening the project.
      try { storage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    },
  };
}
