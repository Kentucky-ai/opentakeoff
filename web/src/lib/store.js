// Storage adapter — the seam that replaces the backend.
//
// OpenTakeoff is client-only by default: the takeoff canvas talks to `store`,
// never to a server. `localStore` keeps PDFs in IndexedDB (they're too big for
// localStorage) and the annotations JSON in localStorage. The same four-method
// interface is all the canvas needs, so a hosted backend can be dropped in later
// by implementing the same shape (see `apiStore` stub at the bottom).
//
//   listSheets()              -> [{ name }]                (the loaded plan PDFs)
//   loadPdfData(name)         -> Uint8Array                (bytes for pdf.js)
//   loadAnnotations()         -> { conditions, shapes, ... }
//   saveAnnotations(payload)  -> Promise<void>
//
// Plus local-only helpers the drag-drop entry needs: addPdf(file), removePdf(name).
// And local-only snapshot helpers (like addPdf/removePdf, not part of the seam):
// saveSnapshot(label, payload), listSnapshots(), getSnapshot(id), deleteSnapshot(id).

import { sanitizeTemplates } from "./templates.js";
import { sanitizeMaterialLibrary } from "./materials.js";
import { sanitizeStampLibrary } from "./stamps.js";

const DB_NAME = "opentakeoff";
const DB_VERSION = 2;
const PDF_STORE = "pdfs";          // key: file name -> { name, bytes: ArrayBuffer }
const META_STORE = "meta";         // key: "annotations" -> payload object
const SNAP_STORE = "snapshots";    // key: id -> { id, ts, label, payload }
const ANN_KEY = "annotations";
// condition template library — browser-global (not part of a project payload),
// lives under its own key in the keyPath-less meta store: no DB version bump
const TPL_KEY = "condition_templates";
// material library — same browser-global pattern as templates. Conditions
// COPY a library material on attach (plus an additive lib_id link), so the
// library is never load-bearing for totals, exports, or old snapshots.
const MATLIB_KEY = "material_library";
// stamp library — the FIRST cross-project asset (#40): same browser-global
// pattern as templates/materials, its own key in the keyPath-less meta store
// (no DB version bump). Persists across projects; export/import as JSON.
const STAMPLIB_KEY = "stamp_library";
const ANN_SCHEMA = "opentakeoff.takeoff_canvas.v1";

// The empty-project annotations shape. One definition so the local store and the
// Drive-backed cloud store (cloudStore.js) hydrate a fresh project identically —
// a new field added here reaches both, instead of silently drifting apart.
export function emptyAnnotations() {
  return { schema: ANN_SCHEMA, conditions: [], shapes: [], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [] };
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // contains-guards make this run for both fresh creates and v1->v2 upgrades
      if (!db.objectStoreNames.contains(PDF_STORE)) db.createObjectStore(PDF_STORE, { keyPath: "name" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(SNAP_STORE)) db.createObjectStore(SNAP_STORE, { keyPath: "id" });
    };
    // Another tab still holds an older-version connection, so the upgrade
    // can't proceed until it's gone. We reject rather than wait — but the
    // open request stays pending and may still succeed once the blocker
    // closes, so onsuccess must clean up after a settled reject (below).
    let settled = false;
    req.onblocked = () => {
      settled = true;
      reject(Object.assign(
        new Error("OpenTakeoff is open in another tab with older data — close it or reload."),
        { name: "BlockedError" },
      ));
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // late success after onblocked already rejected — close the orphaned
        // connection or it would block every future upgrade in turn (safe:
        // success fires only after the upgrade transaction commits)
        db.close();
        return;
      }
      // if another tab bumps the version later, get out of its way
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      if (req.error?.name === "VersionError") {
        // This build is OLDER than the database — a stale tab after a future bump.
        reject(Object.assign(
          new Error("This tab is running an older OpenTakeoff — reload to update."),
          { name: "VersionError" },
        ));
      } else {
        reject(req.error);
      }
    };
  });
}

// True when a store call failed because this tab is out of step with the DB
// version (either older or newer than another open tab) — the fix is the same
// either way: reload / close the other tab.
export function isStaleTabError(e) {
  return e?.name === "VersionError" || e?.name === "BlockedError";
}

// The one UI copy for stale-tab failures. TakeoffCanvas routes its message
// tint on exact equality with this string, so every surface must use the
// constant — a local paraphrase would silently render in the success color.
export const STALE_TAB_MESSAGE = "OpenTakeoff was updated in another tab — reload this tab to continue.";

// Map raw store errors to copy the user can act on; falls back to the
// error's own message for everything unrecognized.
export function friendlyStoreError(e) {
  if (e?.name === "QuotaExceededError") {
    return "Not enough storage space for this snapshot — delete old snapshots or unused PDFs and try again.";
  }
  return e?.message || String(e);
}

// Open, run, ALWAYS close — even when fn throws (a DataCloneError inside a
// put, say). A leaked open connection blocks every future version upgrade
// in every tab.
async function withDb(fn) {
  const db = await openDB();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const out = fn(os);
    // If fn returned an IDBRequest, resolve with its result — even when that
    // result is undefined (a get() miss must yield undefined, not the request).
    t.oncomplete = () => resolve(out && typeof out.readyState === "string" ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const localStore = {
  async listSheets() {
    const names = await withDb((db) => tx(db, PDF_STORE, "readonly", (os) => os.getAllKeys()));
    // preserve insertion order (IndexedDB getAllKeys sorts by key; we keep the
    // saved order from annotations.sheet_tabs at the canvas layer, so name-sort
    // here is fine for the gallery)
    return (names || []).map((name) => ({ name }));
  },

  async loadPdfData(name) {
    const rec = await withDb((db) => tx(db, PDF_STORE, "readonly", (os) => os.get(name)));
    if (!rec) throw new Error(`PDF not found in local store: ${name}`);
    // hand pdf.js a fresh view each call — getDocument({data}) may detach it
    return new Uint8Array(rec.bytes);
  },

  async addPdf(file) {
    // read the bytes BEFORE opening — don't hold a connection across an
    // unrelated (possibly slow, file-sized) await
    const bytes = await file.arrayBuffer();
    // de-dupe by name: a re-dropped file replaces the old bytes
    await withDb((db) => tx(db, PDF_STORE, "readwrite", (os) => os.put({ name: file.name, bytes })));
    return { name: file.name };
  },

  async removePdf(name) {
    await withDb((db) => tx(db, PDF_STORE, "readwrite", (os) => os.delete(name)));
  },

  async loadAnnotations() {
    const a = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(ANN_KEY)));
    return a || emptyAnnotations();
  },

  async saveAnnotations(payload) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put({ ...payload, schema: ANN_SCHEMA }, ANN_KEY)));
  },

  async loadTemplates() {
    // sanitize on load, not just save: the record is browser-global, so a
    // corrupt item (any writer, any past version) would otherwise throw inside
    // EVERY project's hydrate — wiping or wedging all of them at once
    const t = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(TPL_KEY)));
    return sanitizeTemplates(t);
  },

  async saveTemplates(list) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put(Array.isArray(list) ? list : [], TPL_KEY)));
  },

  async loadMaterialLibrary() {
    // sanitize on load for the same reason as loadTemplates: browser-global
    // record, and one corrupt item would crash the canvas for every project
    const m = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(MATLIB_KEY)));
    return sanitizeMaterialLibrary(m);
  },

  async saveMaterialLibrary(list) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put(Array.isArray(list) ? list : [], MATLIB_KEY)));
  },

  async loadStampLibrary() {
    // sanitize on load for the same reason as templates/materials: the record
    // is browser-global, and one corrupt stamp would otherwise wedge the
    // palette (and its seeding) for every project at once
    const s = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(STAMPLIB_KEY)));
    return sanitizeStampLibrary(s);
  },

  async saveStampLibrary(lib) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put(sanitizeStampLibrary(lib), STAMPLIB_KEY)));
  },

  // `project` scopes a snapshot to a cloud project folder (cloudStore passes the
  // Drive folderId). Anonymous/local snapshots use the default null scope. The
  // field is additive: records saved before it read back as null (the local
  // scope), so no DB version bump or migration is needed. `?? null` everywhere
  // so a project can never see another project's — or the local — snapshots.
  // JSDoc widens `project` past the `= null` default's inferred `null` type so
  // cloud callers can pass a string folderId under strict tsc (which checks the
  // .ts tests even though checkJs is off for this source).
  /** @param {string|null} [project] cloud project scope (Drive folderId); null = local */
  async saveSnapshot(label, payload, project = null) {
    const id = "snap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ts = Date.now();
    await withDb((db) => tx(db, SNAP_STORE, "readwrite", (os) => os.put({ id, ts, label: String(label || "").trim() || null, project: project ?? null, payload })));
    return { id, ts };
  },

  /** @param {string|null} [project] cloud project scope (Drive folderId); null = local */
  async listSnapshots(project = null) {
    const scope = project ?? null;
    // cursor walk, collecting metadata only — the list UI never needs the
    // payloads (they can be MBs of shapes), and getAll() would materialize
    // every one of them at once; this bounds peak memory to a single record
    const metas = await withDb((db) => tx(db, SNAP_STORE, "readonly", (os) => {
      const out = [];
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        // only this scope's snapshots — legacy records (no `project`) are null-scope
        if ((cur.value.project ?? null) === scope) {
          const { id, ts, label } = cur.value;
          out.push({ id, ts, label });
        }
        cur.continue();
      };
      return out;
    }));
    // cursor order is key order, not time order — keep newest-first
    return metas.sort((a, b) => b.ts - a.ts);
  },

  /** @param {string} id @param {string|null} [project] cloud project scope (Drive folderId); null = local */
  async getSnapshot(id, project = null) {
    const rec = await withDb((db) => tx(db, SNAP_STORE, "readonly", (os) => os.get(id)));
    if (!rec) return null;
    // scope guard: never hand back a snapshot that belongs to a different project
    // (or a local one to a cloud project, and vice versa), even if the id is known
    if ((rec.project ?? null) !== (project ?? null)) return null;
    return rec;
  },

  async deleteSnapshot(id) {
    await withDb((db) => tx(db, SNAP_STORE, "readwrite", (os) => os.delete(id)));
  },
};

// ── the mode-aware store seam ──────────────────────────────────────────────
// The default build is byte-for-byte the old client-only app: `store` is
// `localStore` and nothing here touches the network. The optional, team-only
// cloud mode (Google sign-in + Drive, see lib/google/ and lib/cloudStore.js)
// swaps in a Drive-backed adapter that implements this SAME interface, so the
// canvas — which reads the live `store` binding at call time — needs no changes.
//
// `store` is a live ESM binding: importers (`import { store } from …`) see the
// reassignment `setActiveStore` makes, so switching to cloud mode BEFORE the
// canvas mounts is enough. The switch is driven from the app shell (main.jsx),
// which alone pulls in the Google/Drive modules — the anonymous bundle never
// loads them.
export let store = localStore;

// Point the shared `store` at a cloud (or any drop-in) adapter; pass nothing to
// fall back to the local, browser-only store. Called from the app shell once a
// deep-linked project is signed in and its Drive-backed store is built.
export function setActiveStore(next) {
  store = next || localStore;
}

// The deep-link contract with Glide: `…/?project=<driveFolderId>` selects which
// shared-Drive project folder to open. A folder id is not a credential — Google
// still gates who can read it — so it's safe in the URL. Empty string = the
// default anonymous, local-only mode.
export function projectIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("project") || "";
  } catch {
    return "";   // no window (SSR/tests) or a malformed query — stay local
  }
}

export { ANN_SCHEMA };
