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

const DB_NAME = "opentakeoff";
const DB_VERSION = 2;
const PDF_STORE = "pdfs";          // key: file name -> { name, bytes: ArrayBuffer }
const META_STORE = "meta";         // key: "annotations" -> payload object
const SNAP_STORE = "snapshots";    // key: id -> { id, ts, label, payload }
const ANN_KEY = "annotations";
// condition template library — browser-global (not part of a project payload),
// lives under its own key in the keyPath-less meta store: no DB version bump
const TPL_KEY = "condition_templates";
const ANN_SCHEMA = "opentakeoff.takeoff_canvas.v1";

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
    return a || { schema: ANN_SCHEMA, conditions: [], shapes: [], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [] };
  },

  async saveAnnotations(payload) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put({ ...payload, schema: ANN_SCHEMA }, ANN_KEY)));
  },

  async loadTemplates() {
    const t = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(TPL_KEY)));
    return Array.isArray(t) ? t : [];
  },

  async saveTemplates(list) {
    await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put(Array.isArray(list) ? list : [], TPL_KEY)));
  },

  async saveSnapshot(label, payload) {
    const id = "snap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ts = Date.now();
    await withDb((db) => tx(db, SNAP_STORE, "readwrite", (os) => os.put({ id, ts, label: String(label || "").trim() || null, payload })));
    return { id, ts };
  },

  async listSnapshots() {
    // cursor walk, collecting metadata only — the list UI never needs the
    // payloads (they can be MBs of shapes), and getAll() would materialize
    // every one of them at once; this bounds peak memory to a single record
    const metas = await withDb((db) => tx(db, SNAP_STORE, "readonly", (os) => {
      const out = [];
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const { id, ts, label } = cur.value;
        out.push({ id, ts, label });
        cur.continue();
      };
      return out;
    }));
    // cursor order is key order, not time order — keep newest-first
    return metas.sort((a, b) => b.ts - a.ts);
  },

  async getSnapshot(id) {
    const rec = await withDb((db) => tx(db, SNAP_STORE, "readonly", (os) => os.get(id)));
    return rec || null;
  },

  async deleteSnapshot(id) {
    await withDb((db) => tx(db, SNAP_STORE, "readwrite", (os) => os.delete(id)));
  },
};

// Optional backend adapter — implement the same four methods against the
// `../server` AI sandbox (or any host) to enable shared/multi-device storage.
// Left intentionally unimplemented; the default build never touches it.
export const apiStore = null;

export const store = localStore;
export { ANN_SCHEMA };
