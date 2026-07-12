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

const DB_NAME = "opentakeoff";
const DB_VERSION = 2;              // v2: adds the revisions store
const PDF_STORE = "pdfs";          // key: file name -> { name, bytes: ArrayBuffer }
const META_STORE = "meta";         // key: "annotations" -> payload object
const REV_STORE = "revisions";     // key: id -> { id, name, created_at, payload }
const ANN_KEY = "annotations";
const ANN_SCHEMA = "opentakeoff.takeoff_canvas.v1";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PDF_STORE)) db.createObjectStore(PDF_STORE, { keyPath: "name" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(REV_STORE)) db.createObjectStore(REV_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const out = fn(os);
    t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
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

  // ── revisions: named takeoff snapshots for bid-revision compare ───────────
  // The payload is the annotations subset the compare needs (conditions,
  // shapes, markups, project_name, units) — never the PDFs, so a revision is
  // a few hundred KB at the very worst, not a plan set.

  async listRevisions() {
    const db = await openDB();
    const all = await tx(db, REV_STORE, "readonly", (os) => os.getAll());
    db.close();
    return (all || [])
      .map((r) => ({ id: r.id, name: r.name, created_at: r.created_at, conditions: (r.payload?.conditions || []).length, shapes: (r.payload?.shapes || []).length }))
      .sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));   // newest first
  },

  async saveRevision({ name, payload }) {
    const rec = {
      id: `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: name || "Revision",
      created_at: new Date().toISOString(),
      payload,
    };
    const db = await openDB();
    await tx(db, REV_STORE, "readwrite", (os) => os.put(rec));
    db.close();
    return { id: rec.id, name: rec.name, created_at: rec.created_at };
  },

  async loadRevision(id) {
    const db = await openDB();
    const rec = await tx(db, REV_STORE, "readonly", (os) => os.get(id));
    db.close();
    if (!rec) throw new Error(`Revision not found: ${id}`);
    return rec;
  },

  async deleteRevision(id) {
    const db = await openDB();
    await tx(db, REV_STORE, "readwrite", (os) => os.delete(id));
    db.close();
  },
};

// Optional backend adapter — implement the same four methods against the
// `../server` AI sandbox (or any host) to enable shared/multi-device storage.
// Left intentionally unimplemented; the default build never touches it.
export const apiStore = null;

export const store = localStore;
export { ANN_SCHEMA };
