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
    // Another tab still holds an older-version connection (nothing closes
    // connections today), so the upgrade can't proceed until it's gone.
    req.onblocked = () => reject(Object.assign(
      new Error("OpenTakeoff is open in another tab with older data — close it or reload."),
      { name: "BlockedError" },
    ));
    req.onsuccess = () => resolve(req.result);
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
    const db = await openDB();
    const names = await tx(db, PDF_STORE, "readonly", (os) => os.getAllKeys());
    db.close();
    // preserve insertion order (IndexedDB getAllKeys sorts by key; we keep the
    // saved order from annotations.sheet_tabs at the canvas layer, so name-sort
    // here is fine for the gallery)
    return (names || []).map((name) => ({ name }));
  },

  async loadPdfData(name) {
    const db = await openDB();
    const rec = await tx(db, PDF_STORE, "readonly", (os) => os.get(name));
    db.close();
    if (!rec) throw new Error(`PDF not found in local store: ${name}`);
    // hand pdf.js a fresh view each call — getDocument({data}) may detach it
    return new Uint8Array(rec.bytes);
  },

  async addPdf(file) {
    const bytes = await file.arrayBuffer();
    const db = await openDB();
    // de-dupe by name: a re-dropped file replaces the old bytes
    await tx(db, PDF_STORE, "readwrite", (os) => os.put({ name: file.name, bytes }));
    db.close();
    return { name: file.name };
  },

  async removePdf(name) {
    const db = await openDB();
    await tx(db, PDF_STORE, "readwrite", (os) => os.delete(name));
    db.close();
  },

  async loadAnnotations() {
    const db = await openDB();
    const a = await tx(db, META_STORE, "readonly", (os) => os.get(ANN_KEY));
    db.close();
    return a || { schema: ANN_SCHEMA, conditions: [], shapes: [], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [] };
  },

  async saveAnnotations(payload) {
    const db = await openDB();
    await tx(db, META_STORE, "readwrite", (os) => os.put({ ...payload, schema: ANN_SCHEMA }, ANN_KEY));
    db.close();
  },

  async saveSnapshot(label, payload) {
    const id = "snap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ts = Date.now();
    const db = await openDB();
    await tx(db, SNAP_STORE, "readwrite", (os) => os.put({ id, ts, label: String(label || "").trim() || null, payload }));
    db.close();
    return { id, ts };
  },

  async listSnapshots() {
    const db = await openDB();
    const recs = await tx(db, SNAP_STORE, "readonly", (os) => os.getAll());
    db.close();
    // strip payloads (they can be MBs of shapes) — the list UI only needs metadata
    return (recs || [])
      .map(({ id, ts, label }) => ({ id, ts, label }))
      .sort((a, b) => b.ts - a.ts);
  },

  async getSnapshot(id) {
    const db = await openDB();
    const rec = await tx(db, SNAP_STORE, "readonly", (os) => os.get(id));
    db.close();
    return rec || null;
  },

  async deleteSnapshot(id) {
    const db = await openDB();
    await tx(db, SNAP_STORE, "readwrite", (os) => os.delete(id));
    db.close();
  },
};

// Optional backend adapter — implement the same four methods against the
// `../server` AI sandbox (or any host) to enable shared/multi-device storage.
// Left intentionally unimplemented; the default build never touches it.
export const apiStore = null;

export const store = localStore;
export { ANN_SCHEMA };
