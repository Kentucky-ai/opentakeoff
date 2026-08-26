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
//
// Sheet revisions (CO-1): a re-dropped file whose BYTES differ is never a silent
// overwrite. addPdf content-hashes every file; changed bytes archive the old
// record as a numbered revision (pdf_revs store) before the new bytes become
// current, and the return value says so ({ revised, rev, prev_rev }) so the
// canvas can tell the estimator their markups now sit on different paper.
// Local-only, like addPdf itself — cloud mode's addPdf rides Drive's native
// revision history instead. Readers: listPdfRevisions(name) (metadata only),
// loadPdfRevisionData(name, rev) (bytes, for the CO-2 overlay).

import { sanitizeTemplates } from "./templates.js";
import { sanitizeMaterialLibrary } from "./materials.js";
import { sanitizeStampLibrary } from "./stamps.js";
import i18n from "../i18n/index.js";
import { markDanger } from "./danger.js";

const _t = (key, opts) => i18n.t(key, { ns: "lib", ...opts });

const DB_NAME = "opentakeoff";
const DB_VERSION = 3;
const PDF_STORE = "pdfs";          // key: file name -> { name, bytes: ArrayBuffer, hash?, rev?, ts? }
const META_STORE = "meta";         // key: "annotations" -> payload object
const SNAP_STORE = "snapshots";    // key: id -> { id, ts, label, payload }
// Archived sheet revisions (v3). key: "name + NUL + rev" — NUL can't appear in
// a file name on any OS, so the compound key can't collide with a sibling name.
// Records mirror the pdfs shape plus their frozen rev number; the "name" index
// is how removePdf and listPdfRevisions find a file's whole trail.
const REV_STORE = "pdf_revs";      // key -> { key, name, rev, hash, ts, bytes }
const revKey = (name, rev) => `${name}\u0000${rev}`;
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
  // rules (#88): project-scoped correction rules — deterministic predicates
  // seeded by an estimator's edit, re-runnable across the project. Local to
  // the project file by the RFC's scope boundary (never on the MCP export or
  // contribution wire).
  // approvals: approval seals (lib/approvals.js) — estimator APPROVED ink +
  // agent AGENT marks. Same scope boundary as rules: project data, never on
  // the MCP export or contribution wire (the estimator tool is human-only).
  // stitches (#161): match-line composite surfaces — additive, sanitize-gated
  // on hydrate (lib/stitches.ts), omitted from saves while empty.
  return { schema: ANN_SCHEMA, conditions: [], shapes: [], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [], rules: [], approvals: [], stitches: [] };
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // contains-guards make this run for fresh creates and every vN->v3 upgrade
      if (!db.objectStoreNames.contains(PDF_STORE)) db.createObjectStore(PDF_STORE, { keyPath: "name" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(SNAP_STORE)) db.createObjectStore(SNAP_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(REV_STORE)) {
        db.createObjectStore(REV_STORE, { keyPath: "key" }).createIndex("name", "name");
      }
    };
    // Another tab still holds an older-version connection, so the upgrade
    // can't proceed until it's gone. We reject rather than wait — but the
    // open request stays pending and may still succeed once the blocker
    // closes, so onsuccess must clean up after a settled reject (below).
    let settled = false;
    req.onblocked = () => {
      settled = true;
      reject(Object.assign(
        new Error(markDanger(_t("store.blocked_error"))),
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
          new Error(markDanger(_t("store.version_error"))),
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
// STALE_TAB_KEY is the stable, language-independent token for comparisons;
// STALE_TAB_MESSAGE is the translated display string (frozen at import time).
export const STALE_TAB_KEY = "__stale_tab__";
export const STALE_TAB_MESSAGE = markDanger(_t("store.stale_tab"));

/** Resolve the stale-tab message at call time (reflects a mid-session
 *  language switch). Use where the display string must be current. */
export function staleTabMessage() { return markDanger(_t("store.stale_tab")); }

// Map raw store errors to copy the user can act on; falls back to the
// error's own message for everything unrecognized.
export function friendlyStoreError(e) {
  if (e?.name === "QuotaExceededError") {
    return markDanger(_t("store.quota_error"));
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

// Like tx, but spanning several stores in ONE transaction — fn gets the
// transaction itself. This is what makes a revision archive atomic: the
// old-bytes put and the new-current put commit together or not at all, so
// a failure mid-swap can never lose the only copy of a sheet.
function txAll(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// SHA-256 of a PDF's bytes as lowercase hex — the identity a revision is keyed
// on. WebCrypto is available in every target (browsers, the Node 24 test env).
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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
    if (!rec) throw new Error(markDanger(_t("store.pdf_not_found", { name })));
    // hand pdf.js a fresh view each call — getDocument({data}) may detach it
    return new Uint8Array(rec.bytes);
  },

  async addPdf(file) {
    // read the bytes BEFORE opening — don't hold a connection across an
    // unrelated (possibly slow, file-sized) await. Same rule for the hash:
    // subtle.digest is async, and an IDB transaction commits the moment its
    // event loop drains, so ALL hashing happens outside every transaction.
    const bytes = await file.arrayBuffer();
    const hash = await sha256Hex(bytes);
    const ts = Date.now();
    const existing = await withDb((db) => tx(db, PDF_STORE, "readonly", (os) => os.get(file.name)));
    if (!existing) {
      await withDb((db) => tx(db, PDF_STORE, "readwrite", (os) => os.put({ name: file.name, bytes, hash, rev: 1, ts })));
      return { name: file.name, rev: 1 };
    }
    // de-dupe by name, but never by silent overwrite: same bytes are a no-op,
    // different bytes archive the old record as a revision first (CO-1).
    // Records written before v3 carry no hash/rev — hash their bytes now and
    // treat them as rev 1, so legacy sheets version correctly on first re-drop.
    const prevRev = existing.rev || 1;
    const prevHash = existing.hash || await sha256Hex(existing.bytes);
    if (prevHash === hash) {
      if (!existing.hash || !existing.rev) {
        // backfill the legacy record's identity so the next compare is cheap
        await withDb((db) => tx(db, PDF_STORE, "readwrite", (os) => os.put({ ...existing, hash: prevHash, rev: prevRev, ts: existing.ts ?? ts })));
      }
      return { name: file.name, rev: prevRev, unchanged: true };
    }
    // one transaction across both stores: archive + swap commit atomically
    await withDb((db) => txAll(db, [PDF_STORE, REV_STORE], "readwrite", (t) => {
      t.objectStore(REV_STORE).put({ key: revKey(file.name, prevRev), name: file.name, rev: prevRev, hash: prevHash, ts: existing.ts ?? ts, bytes: existing.bytes });
      t.objectStore(PDF_STORE).put({ name: file.name, bytes, hash, rev: prevRev + 1, ts });
    }));
    return { name: file.name, rev: prevRev + 1, prev_rev: prevRev, revised: true };
  },

  async removePdf(name) {
    // the revision trail goes with the file — locally, close = delete the
    // stored bytes (see closePdf), and keeping orphaned revisions would leak
    // whole PDFs into storage with no surface that ever lists them again
    await withDb((db) => txAll(db, [PDF_STORE, REV_STORE], "readwrite", (t) => {
      t.objectStore(PDF_STORE).delete(name);
      const req = t.objectStore(REV_STORE).index("name").openCursor(IDBKeyRange.only(name));
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
    }));
  },

  // Revision metadata for one file, newest first, current included — never the
  // bytes (a trail can be many full PDFs; the list UI only needs numbers).
  async listPdfRevisions(name) {
    const out = await withDb((db) => txAll(db, [PDF_STORE, REV_STORE], "readonly", (t) => {
      const list = [];
      const cur = t.objectStore(PDF_STORE).get(name);
      cur.onsuccess = () => { const r = cur.result; if (r) list.push({ rev: r.rev || 1, hash: r.hash || null, ts: r.ts ?? null, current: true }); };
      const req = t.objectStore(REV_STORE).index("name").openCursor(IDBKeyRange.only(name));
      req.onsuccess = () => {
        const c = req.result;
        if (c) { const { rev, hash, ts } = c.value; list.push({ rev, hash: hash || null, ts: ts ?? null, current: false }); c.continue(); }
      };
      return list;
    }));
    return out.sort((a, b) => b.rev - a.rev);
  },

  // Bytes of one specific revision — the CO-2 overlay's read path. The current
  // record answers for its own rev so callers can hold any rev number from
  // listPdfRevisions without caring which side of the archive it lives on.
  async loadPdfRevisionData(name, rev) {
    const cur = await withDb((db) => tx(db, PDF_STORE, "readonly", (os) => os.get(name)));
    if (cur && (cur.rev || 1) === rev) return new Uint8Array(cur.bytes);
    const rec = await withDb((db) => tx(db, REV_STORE, "readonly", (os) => os.get(revKey(name, rev))));
    if (!rec) throw new Error(markDanger(_t("store.revision_not_found", { rev, name })));
    return new Uint8Array(rec.bytes);
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

  // Idempotent upsert of a COMPLETE snapshot record, keyed by its own `id`.
  // Unlike saveSnapshot (which mints a fresh id every call), this preserves the
  // record's id verbatim — so a record that already exists elsewhere can be
  // re-materialized here without spawning a duplicate. The caller owns every
  // field, including the `project` scope. Deliberately does no minting, no
  // normalizing, and no network: it's the plain-local counterpart saveSnapshot
  // can't be, and the one primitive a later id-preserving merge needs.
  /** @param {{id: string, ts: number, label?: string|null, project?: string|null, payload: any}} record */
  async putSnapshot(record) {
    // Guard the fields that make a record "complete" — the list UI renders
    // new Date(ts) and the diff/load path reads payload, so a record missing
    // either would persist and then surface as Invalid Date or a runtime error
    // far from here. Reject at the boundary instead. Still no minting/normalizing.
    if (!record || typeof record.id !== "string" || !record.id.trim()) throw new Error("putSnapshot: record.id (non-empty string) required");
    if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) throw new Error("putSnapshot: record.ts (finite number) required");
    if (record.payload == null) throw new Error("putSnapshot: record.payload required");
    await withDb((db) => tx(db, SNAP_STORE, "readwrite", (os) => os.put(record)));
  },

  /** @param {string|null} [project] cloud project scope (Drive folderId); null = local */
  async listSnapshots(project = null) {
    const scope = project ?? null;
    // cursor walk, collecting metadata only — the list UI never needs the
    // payloads (they can be MBs of shapes), and getAll() would materialize
    // every one of them at once; this bounds peak memory to a single record.
    // conditions/shapes are COUNTS derived during the walk (the cursor already
    // holds the record), so the return stays payload-free while list UIs can
    // still say how big each snapshot is.
    const metas = await withDb((db) => tx(db, SNAP_STORE, "readonly", (os) => {
      const out = [];
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        // only this scope's snapshots — legacy records (no `project`) are null-scope
        if ((cur.value.project ?? null) === scope) {
          const { id, ts, label, payload } = cur.value;
          out.push({ id, ts, label, conditions: (payload?.conditions || []).length, shapes: (payload?.shapes || []).length });
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

// A localStore instance whose ANNOTATIONS are scoped to a single project, so an
// opted-in cloud project keeps its own local-first annotation blob instead of
// sharing the one global "annotations" key. This is the local half of the
// local-first composite: annotations become per-project locally, while the cloud
// sync layer (lib/google/, dynamically imported by the app shell) is what makes
// them visible on another machine.
//
// Deliberately narrow:
//   • folderId == null returns the SAME `localStore` object — the anonymous,
//     browser-only app is byte-identical (same reference, same "annotations"
//     key), so no importer, DB version, or migration changes.
//   • Only loadAnnotations/saveAnnotations are re-scoped (key "annotations:<id>").
//     The existing global "annotations" blob simply IS the null-scope project.
//   • PDFs and the browser-global libraries (templates/materials/stamps) stay
//     GLOBAL — cloud mode routes PDFs to cloudStore, and the libraries are
//     cross-project by design (see their key comments above).
//   • Snapshots keep their explicit `project` argument (cloudStore/snapshotSync
//     pass the scope), so they are untouched here.
// Spreading `localStore` is safe: none of its methods use `this` (they close over
// module scope), so the copied methods keep working and we override just two.
/** @param {string|null} [folderId] Drive project folder id; null/"" = the global anonymous store */
export function createLocalStore(folderId = null) {
  // Treat empty string like null: projectIdFromUrl() returns "" for anonymous
  // mode, so a caller threading it through here must land on the global
  // "annotations" blob, NOT a distinct "annotations:" scope.
  if (folderId == null || folderId === "") return localStore;
  const annKey = ANN_KEY + ":" + folderId;
  return {
    ...localStore,
    async loadAnnotations() {
      const a = await withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(annKey)));
      return a || emptyAnnotations();
    },
    async saveAnnotations(payload) {
      await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put({ ...payload, schema: ANN_SCHEMA }, annKey)));
    },
  };
}

// Durable key-value on the keyPath-less meta store — a cloud-free primitive for
// bookkeeping that isn't part of an annotations payload. The optional annotation
// sync layer uses it for per-project `sync:<folderId>:*` fields, each stored under
// its OWN key so the separate async paths that touch them (autosave / push /
// crash-recovery) each do a single put — there is no shared record to suffer a
// lost update.
// Generic and Drive-free: nothing here reaches the network, so exposing it does
// not compromise the snapshot cut-line. Callers own key namespacing; the sync
// layer confines itself to the `sync:` prefix (distinct from the annotation /
// library keys above).
/** @param {string} key @returns {Promise<any>} stored value, or undefined if absent */
export async function metaGet(key) {
  return withDb((db) => tx(db, META_STORE, "readonly", (os) => os.get(key)));
}
/** @param {string} key @param {any} value */
export async function metaPut(key, value) {
  await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.put(value, key)));
}
/** @param {string} key */
export async function metaDelete(key) {
  await withDb((db) => tx(db, META_STORE, "readwrite", (os) => os.delete(key)));
}
/** Delete every meta key that starts with `prefix` (one transaction). Keys are
 *  strings, so a bound range [prefix, prefix + U+FFFF) is the prefix scan.
 *  @param {string} prefix @returns {Promise<number>} keys removed */
export async function metaDeletePrefix(prefix) {
  if (!prefix) return 0;
  return withDb((db) => new Promise((resolve, reject) => {
    const t = db.transaction(META_STORE, "readwrite");
    const os = t.objectStore(META_STORE);
    let n = 0;
    const req = os.openKeyCursor(IDBKeyRange.bound(prefix, prefix + "\uffff", false, true));
    req.onsuccess = () => { const c = req.result; if (c) { os.delete(c.primaryKey); n++; c.continue(); } };
    t.oncomplete = () => resolve(n);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

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
  const prev = store;
  store = next || localStore;
  // An outgoing composite may hold live timers (the presence heartbeat, #317).
  // dispose is a non-enumerable, optional hook — best-effort, never throws
  // into the swap, and skipped when the store isn't actually changing.
  if (prev !== store && typeof prev?.dispose === "function") {
    try { prev.dispose(); } catch { /* teardown is best-effort */ }
  }
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
