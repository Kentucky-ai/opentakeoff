// Export everything / Import everything (.otkx) — every project in this
// browser as ONE file, and back.
//
// OpenTakeoff keeps a person's work in the browser (IndexedDB + localStorage),
// and a browser may clear that storage to free space. The .otk carries one
// project and the .otprofile one setup; this carries the whole browser:
//
//   backup.otkx = zip {
//     manifest.json             schema opentakeoff.browser_export.v1: app
//                               version, created, counts, every file below,
//                               and anything left out with the reason
//     local_storage.json        { key: raw string } — the app's own keys only
//     profile.otprofile         buildProfile() — the same file Export profile
//                               writes, so a person can take it out on its own
//     idb/<store>/000001.json   records of one IndexedDB store, in batches:
//                               [{ k: key, v: encoded value }, …]
//     bin/<store>/<n>.bin       a binary value inside a record (a PDF's bytes,
//                               a revision's bytes), stored, never recompressed
//   }
//
// Every record of the four stores goes in as it is stored (pdfs, pdf_revs,
// snapshots, meta: every annotations record, the libraries, sheet pages and
// rotations, sync state, OCR caches), so an import puts back exactly what was
// there. Two kinds of meta record are left out on purpose and listed in the
// manifest: a folder link (a FileSystemDirectoryHandle — it only works in the
// browser that made it) and sheet thumbnails (redrawn when needed).
//
// Streaming. A record is read on its own, its bytes are read in 8 MB slices
// and handed to fflate's streaming Zip, and each output chunk goes straight
// to the sink (a file on disk where the browser can write one). Import never
// inflates the archive whole either: it reads the zip's central directory,
// and a stored PDF goes back into IndexedDB as a slice of the chosen file,
// which the browser copies from disk.
//
// Limits. The same budgets as the .otk and the zip ingest: 2 GB and 10,000
// entries. Export skips what would cross them, in priority order (project
// records first, then snapshots, plans, older revisions, OCR caches), and the
// manifest lists each skipped record and its size. Import refuses a file over
// either budget before writing anything.

export const BROWSER_EXPORT_SCHEMA = "opentakeoff.browser_export.v1";
export const MANIFEST_NAME = "manifest.json";
export const LOCAL_STORAGE_NAME = "local_storage.json";
export const PROFILE_NAME = "profile.otprofile";
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_TOTAL_ENTRIES = 10_000;

const STORES = ["meta", "snapshots", "pdfs", "pdf_revs"];
const CHUNK = 8 * 1024 * 1024;            // bytes read from a Blob at a time
const BATCH_BYTES = 4 * 1024 * 1024;      // JSON per idb/<store>/NNNNNN.json
const RESERVE_BYTES = 4 * 1024 * 1024;    // manifest + local storage + profile
const RESERVE_ENTRIES = 3;
const TAG = "$otkx";

export function isBrowserExport(name) {
  return /\.otkx$/i.test(name || "");
}

// ── which records travel ───────────────────────────────────────────────────

/** Meta keys that never travel, and why (listed in the manifest). */
export function metaExclusion(key) {
  if (key === "fsync:handle") return "folder link: it only works in the browser that made it";
  if (typeof key === "string" && key.startsWith("thumb:")) return "sheet thumbnail: redrawn when needed";
  return null;
}

const OCR_PREFIX = "ocr:";
// Lower runs first; the budget skips from the end of this order.
function priority(store, key) {
  if (store === "meta") return typeof key === "string" && key.startsWith(OCR_PREFIX) ? 4 : 0;
  return { snapshots: 1, pdfs: 2, pdf_revs: 3 }[store] ?? 5;
}

/** localStorage keys that belong to OpenTakeoff. */
export function isAppStorageKey(key) {
  return typeof key === "string" && /^(opentakeoff|ot[-.]|m365:)/.test(key);
}

// App keys that stay in this browser: credentials (an AI key, the assistant
// link's token) and this browser's own backup state.
const STAY_KEYS = new Set(["opentakeoff_ai_key", "ot.assistant.link.v1", "opentakeoff_backup_state"]);
export function storageExclusion(key) {
  if (STAY_KEYS.has(key)) return key === "opentakeoff_backup_state" ? "this browser's backup state" : "a credential: stays in this browser";
  if (/(key|token|secret|password)$/i.test(key)) return "a credential: stays in this browser";
  return null;
}

// ── value encoding ─────────────────────────────────────────────────────────
// IndexedDB holds structured-clone values; the archive holds JSON. Anything
// JSON can't say exactly is tagged: binary (moved to its own bin/ entry),
// Date, undefined, non-finite numbers, and a plain object that happens to own
// the tag key. Anything else (a file handle, a class instance) can't travel,
// and its record is listed as left out.

const isBlob = (v) => typeof Blob !== "undefined" && v instanceof Blob;
const TYPED = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"];

class NotPortable extends Error {}

/**
 * Encode one value. `addBinary(blob)` is called for each binary part and
 * returns the entry path it will be written under.
 */
export function encodeValue(value, addBinary) {
  const walk = (v) => {
    if (v === undefined) return { [TAG]: "undef" };
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : { [TAG]: "num", v: String(v) };
    if (typeof v === "bigint") return { [TAG]: "bigint", v: String(v) };
    if (typeof v !== "object") throw new NotPortable(typeof v);
    if (isBlob(v)) {
      const out = { [TAG]: "blob", path: addBinary(v), size: v.size, type: v.type || "" };
      if (typeof File !== "undefined" && v instanceof File) Object.assign(out, { file: v.name, mtime: v.lastModified });
      return out;
    }
    if (v instanceof ArrayBuffer) return { [TAG]: "ab", path: addBinary(new Blob([v])), size: v.byteLength };
    if (ArrayBuffer.isView(v)) {
      const ctor = v.constructor?.name;
      if (ctor === "DataView" || TYPED.includes(ctor)) {
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
        return { [TAG]: "view", ctor, path: addBinary(new Blob([bytes])), size: v.byteLength };
      }
      throw new NotPortable(ctor);
    }
    if (v instanceof Date) return { [TAG]: "date", v: Number.isNaN(v.getTime()) ? null : v.toISOString() };
    if (Array.isArray(v)) return v.map(walk);
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new NotPortable(v.constructor?.name || "object");
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return Object.prototype.hasOwnProperty.call(v, TAG) ? { [TAG]: "obj", v: out } : out;
  };
  return walk(value);
}

/**
 * Decode an encoded value. `binary(tag)` returns the Blob for a binary tag
 * (synchronously — the reader hands out slices of the archive file).
 * Array buffers and typed arrays need their bytes, so they are collected in
 * `pending` and filled by `resolvePending`.
 */
function decodeValue(value, binary, pending) {
  const walk = (v, set) => {
    if (Array.isArray(v)) { const a = new Array(v.length); v.forEach((x, i) => walk(x, (y) => { a[i] = y; })); set(a); return; }
    if (!v || typeof v !== "object") { set(v); return; }
    const t = v[TAG];
    if (t === undefined) {
      const o = {};
      for (const [k, x] of Object.entries(v)) walk(x, (y) => { o[k] = y; });
      set(o); return;
    }
    if (t === "undef") { set(undefined); return; }
    if (t === "num") { set(Number(v.v)); return; }
    if (t === "bigint") { set(BigInt(v.v)); return; }
    if (t === "date") { set(new Date(v.v ?? NaN)); return; }
    if (t === "obj") { const o = {}; for (const [k, x] of Object.entries(v.v || {})) walk(x, (y) => { o[k] = y; }); set(o); return; }
    if (t === "blob") {
      const b = binary(v);
      set(v.file != null && typeof File !== "undefined" ? new File([b], v.file, { type: v.type, lastModified: v.mtime }) : b);
      return;
    }
    if (t === "ab" || t === "view") { pending.push({ tag: v, blob: binary(v), set }); set(null); return; }
    throw new Error(`unknown value tag "${t}"`);
  };
  let out;
  walk(value, (y) => { out = y; });
  return out;
}

async function resolvePending(pending) {
  for (const p of pending) {
    const buf = await p.blob.arrayBuffer();
    if (p.tag[TAG] === "ab") { p.set(buf); continue; }
    const C = p.tag.ctor === "DataView" ? DataView : globalThis[p.tag.ctor];
    p.set(p.tag.ctor === "DataView" ? new DataView(buf) : new C(buf));
  }
}

// ── reading the browser's IndexedDB ────────────────────────────────────────

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

async function storeKeys(db, name) {
  if (!db.objectStoreNames.contains(name)) return [];
  return req(db.transaction(name, "readonly").objectStore(name).getAllKeys());
}

async function storeGet(db, name, key) {
  return req(db.transaction(name, "readonly").objectStore(name).get(key));
}

// ── manifest ───────────────────────────────────────────────────────────────

/** Annotation keys are projects: "annotations" (this browser's default
 * workspace) and "annotations:<id>" (a linked folder or Drive project). */
export function isProjectKey(key) {
  return key === "annotations" || (typeof key === "string" && key.startsWith("annotations:"));
}

/**
 * The manifest for a finished export. Pure: the writer gathers the parts.
 */
export function buildManifest({ appVersion = "", created, stores, files, localStorageKeys, libraries, omitted, excluded, binaryBytes, totalBytes, entries }) {
  const count = (s) => stores[s]?.length || 0;
  return {
    schema: BROWSER_EXPORT_SCHEMA,
    app: "opentakeoff",
    app_version: appVersion,
    created,
    complete: omitted.length === 0,
    counts: {
      projects: (stores.meta || []).filter(isProjectKey).length,
      pdfs: count("pdfs"),
      pdf_revs: count("pdf_revs"),
      snapshots: count("snapshots"),
      meta_records: count("meta"),
      local_storage_keys: localStorageKeys.length,
      libraries,
      binary_bytes: binaryBytes,
      total_bytes: totalBytes,
      entries,
    },
    projects: (stores.meta || []).filter(isProjectKey),
    files,
    local_storage_keys: localStorageKeys,
    omitted,
    excluded,
    limits: { max_bytes: MAX_TOTAL_BYTES, max_entries: MAX_TOTAL_ENTRIES },
  };
}

/** Throws a "Couldn't import…" error unless `m` is a manifest this build reads. */
export function validateManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("Couldn't import: the backup's manifest is missing or unreadable.");
  if (m.schema !== BROWSER_EXPORT_SCHEMA) {
    throw new Error(`Couldn't import: backup version "${m.schema || "unknown"}" — this build reads ${BROWSER_EXPORT_SCHEMA}. Update OpenTakeoff and try again.`);
  }
  if (!m.files || typeof m.files !== "object" || !STORES.every((s) => Array.isArray(m.files[s] ?? []))) {
    throw new Error("Couldn't import: the backup's manifest lists no files.");
  }
  return m;
}

// ── export ─────────────────────────────────────────────────────────────────

/**
 * Write every project in this browser to `sink` as a .otkx.
 * @param {{
 *   withDb: (fn: (db: IDBDatabase) => Promise<any>) => Promise<any>,
 *   sink: { write: (chunk: Uint8Array) => any, close?: () => any },
 *   storage?: Storage,
 *   buildProfile?: () => Promise<object>,
 *   appVersion?: string,
 *   now?: () => Date,
 *   limits?: { bytes?: number, entries?: number },
 *   onProgress?: (msg: string) => void,
 *   flush?: () => Promise<void>,   // write pending autosaves before reading (lib/pendingSaves.js)
 * }} opts
 * @returns {Promise<any>} the manifest written
 */
export async function writeBrowserExport({ withDb, sink, storage, buildProfile, appVersion = "", now = () => new Date(), limits = {}, onProgress, flush }) {
  // An edit still waiting for its autosave is written first, or the backup
  // would hold the copy from before it. A failed write stops the export.
  if (flush) {
    onProgress?.("Saving your latest changes…");
    try { await flush(); }
    catch (e) { throw new Error(`your latest changes couldn't be saved first (${e?.message || e}), so the backup would miss them. Free some space or reload, then export again.`); }
  }
  const { Zip, ZipPassThrough, ZipDeflate, strToU8 } = await import("fflate");
  const maxBytes = limits.bytes ?? MAX_TOTAL_BYTES;
  const maxEntries = limits.entries ?? MAX_TOTAL_ENTRIES;
  let usedBytes = 0, usedEntries = 0, binaryBytes = 0;

  // fflate's Zip calls back synchronously from push(); chunks queue here and
  // reach the sink (which may be async — a file on disk) after each push.
  const out = [];
  let zipErr = null;
  const zip = new Zip((err, chunk) => { if (err) zipErr = err; else if (chunk?.length) out.push(chunk); });
  const drain = async () => {
    if (zipErr) throw zipErr;
    while (out.length) await sink.write(out.shift());
  };
  const addBytes = async (name, bytes, deflate = true) => {
    const f = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(f);
    f.push(bytes, true);
    await drain();
  };
  const addBlob = async (name, blob) => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    if (!blob.size) { f.push(new Uint8Array(0), true); await drain(); return; }
    for (let o = 0; o < blob.size; o += CHUNK) {
      const end = Math.min(blob.size, o + CHUNK);
      f.push(new Uint8Array(await blob.slice(o, end).arrayBuffer()), end === blob.size);
      await drain();
    }
  };

  // local storage and the profile first: small, and they are someone's setup
  const ls = {};
  const excluded = [];
  if (storage) {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!isAppStorageKey(k)) continue;
      const why = storageExclusion(k);
      if (why) { excluded.push({ store: "localStorage", key: k, reason: why }); continue; }
      const v = storage.getItem(k);
      if (v != null) ls[k] = v;
    }
  }
  const localStorageKeys = Object.keys(ls).sort();
  const lsBytes = strToU8(JSON.stringify(ls));
  let profile = null;
  try { profile = buildProfile ? await buildProfile() : null; } catch { profile = null; }
  const profileBytes = profile ? strToU8(JSON.stringify(profile, null, 2)) : null;

  onProgress?.("Listing projects…");
  const keys = await withDb(async (db) => {
    const all = {};
    for (const s of STORES) all[s] = await storeKeys(db, s);
    return all;
  });
  const queue = [];
  const excludedByReason = new Map();
  for (const s of STORES) {
    for (const k of keys[s]) {
      const why = s === "meta" ? metaExclusion(k) : null;
      if (why) { excludedByReason.set(why, (excludedByReason.get(why) || 0) + 1); continue; }
      queue.push({ store: s, key: k, p: priority(s, k) });
    }
  }
  for (const [reason, count] of excludedByReason) excluded.push({ store: "meta", count, reason });
  queue.sort((a, b) => a.p - b.p);

  // the small fixed entries, counted before any record
  usedBytes += lsBytes.length + (profileBytes?.length || 0);
  usedEntries += 1 + (profileBytes ? 1 : 0);
  await addBytes(LOCAL_STORAGE_NAME, lsBytes);
  if (profileBytes) await addBytes(PROFILE_NAME, profileBytes);

  const files = { meta: [], snapshots: [], pdfs: [], pdf_revs: [], bin: 0 };
  const written = { meta: [], snapshots: [], pdfs: [], pdf_revs: [] };
  const omitted = [];
  const batches = {};          // store -> { parts: string[], bytes }
  const binSeq = {};
  const flushBatch = async (s) => {
    const b = batches[s];
    if (!b || !b.parts.length) return;
    const name = `idb/${s}/${String(files[s].length + 1).padStart(6, "0")}.json`;
    await addBytes(name, strToU8(`[${b.parts.join(",")}]`));
    files[s].push(name);
    batches[s] = null;
  };

  let done = 0;
  for (const item of queue) {
    const { store: s, key } = item;
    if (done++ % 25 === 0) onProgress?.(`Packing ${s === "pdfs" || s === "pdf_revs" ? "plans" : s === "snapshots" ? "snapshots" : "projects"}… (${done} of ${queue.length})`);
    if (typeof key !== "string" && typeof key !== "number") {
      omitted.push({ store: s, key: String(key), bytes: 0, reason: "key type can't be written" });
      continue;
    }
    const value = await withDb((db) => storeGet(db, s, key));
    if (value === undefined) continue; // removed while packing
    const blobs = [];
    let encoded;
    try {
      encoded = encodeValue(value, (blob) => {
        binSeq[s] = (binSeq[s] || 0) + 1;
        const path = `bin/${s}/${binSeq[s]}.bin`;
        blobs.push({ path, blob });
        return path;
      });
    } catch (e) {
      if (!(e instanceof NotPortable)) throw e;
      omitted.push({ store: s, key, bytes: 0, reason: `not portable (${e.message})` });
      continue;
    }
    const json = JSON.stringify({ k: key, v: encoded });
    const jsonBytes = json.length * 3; // worst-case UTF-8, so the budget never under-counts
    const bin = blobs.reduce((n, b) => n + b.blob.size, 0);
    const needEntries = blobs.length + (batches[s] ? 0 : 1);
    if (usedBytes + bin + jsonBytes > maxBytes - RESERVE_BYTES || usedEntries + needEntries > maxEntries - RESERVE_ENTRIES) {
      omitted.push({ store: s, key, bytes: bin + json.length, reason: usedEntries + needEntries > maxEntries - RESERVE_ENTRIES ? "entry limit" : "size limit" });
      if (binSeq[s]) binSeq[s] -= blobs.length;
      continue;
    }
    for (const b of blobs) { await addBlob(b.path, b.blob); files.bin += 1; }
    usedBytes += bin + jsonBytes;
    binaryBytes += bin;
    usedEntries += needEntries;
    if (!batches[s]) batches[s] = { parts: [], bytes: 0 };
    batches[s].parts.push(json);
    batches[s].bytes += json.length;
    written[s].push(key);
    if (batches[s].bytes >= BATCH_BYTES) await flushBatch(s);
  }
  for (const s of STORES) await flushBatch(s);

  const libraries = await withDb(async (db) => {
    const has = db.objectStoreNames.contains("meta");
    const tpl = has ? await storeGet(db, "meta", "condition_templates") : null;
    const mat = has ? await storeGet(db, "meta", "material_library") : null;
    const stamps = has ? await storeGet(db, "meta", "stamp_library") : null;
    return {
      condition_templates: Array.isArray(tpl) ? tpl.length : 0,
      materials: Array.isArray(mat) ? mat.length : 0,
      stamps: Array.isArray(stamps?.stamps) ? stamps.stamps.length : 0,
    };
  });
  const manifest = buildManifest({
    appVersion,
    created: now().toISOString(),
    stores: written,
    files,
    localStorageKeys,
    libraries,
    omitted,
    excluded,
    binaryBytes,
    totalBytes: usedBytes,
    entries: usedEntries + 1,
  });
  await addBytes(MANIFEST_NAME, strToU8(JSON.stringify(manifest, null, 2)));
  zip.end();
  await drain();
  await sink.close?.();
  return manifest;
}

// ── reading a .otkx ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crcUpdate(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const bad = (why) => new Error(`Couldn't import: ${why}`);

/** The zip's central directory: name -> { method, crc, compSize, size, offset }. */
export async function readZipDirectory(blob) {
  const tailLen = Math.min(blob.size, 65_557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad("this isn't a zip file — choose a .otkx backup.");
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw bad("the backup uses a zip format this build can't read.");
  if (count > MAX_TOTAL_ENTRIES) throw bad(`the backup holds ${count} files, over the ${MAX_TOTAL_ENTRIES.toLocaleString("en-US")} limit.`);
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();
  let p = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014b50) throw bad("the backup's file list is damaged.");
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    const ent = { method: u16(cd, p + 10), crc: u32(cd, p + 16), compSize: u32(cd, p + 20), size: u32(cd, p + 24), offset: u32(cd, p + 42) };
    if (ent.method !== 0 && ent.method !== 8) throw bad(`"${name}" is packed in a way this build can't read.`);
    total += ent.size;
    if (total > MAX_TOTAL_BYTES) throw bad("the backup unpacks to more than 2 GB, over this build's limit.");
    out.set(name, ent);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function entryData(blob, ent) {
  if (ent.start == null) {
    const h = new DataView(await blob.slice(ent.offset, ent.offset + 30).arrayBuffer());
    if (h.byteLength < 30 || u32(h, 0) !== 0x04034b50) throw bad("a file inside the backup is damaged.");
    ent.start = ent.offset + 30 + u16(h, 26) + u16(h, 28);
  }
  return blob.slice(ent.start, ent.start + ent.compSize);
}

/**
 * Open a .otkx: read its directory and manifest, check every entry's CRC.
 * Nothing is written. Returns a bundle for inspectBrowserExport /
 * applyBrowserExport.
 * @param {Blob} file
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<any>}
 */
export async function openBrowserExport(file, { onProgress } = {}) {
  const { inflateSync, strFromU8 } = await import("fflate");
  const dir = await readZipDirectory(file);
  const bytesOf = async (name) => {
    const ent = dir.get(name);
    if (!ent) throw bad(`"${name}" is missing from the backup.`);
    const raw = new Uint8Array(await (await entryData(file, ent)).arrayBuffer());
    const data = ent.method === 8 ? inflateSync(raw) : raw;
    if (data.length !== ent.size || crcUpdate(0, data) !== ent.crc) throw bad(`"${name}" inside the backup is damaged.`);
    return data;
  };
  if (!dir.has(MANIFEST_NAME)) throw bad("no manifest.json inside — this isn't an OpenTakeoff backup.");
  let manifest;
  try { manifest = JSON.parse(strFromU8(await bytesOf(MANIFEST_NAME))); }
  catch (e) { throw String(e?.message || "").startsWith("Couldn't") ? e : bad("the backup's manifest isn't valid JSON."); }
  validateManifest(manifest);
  // every stored binary is checked in slices, before anything is written
  let n = 0;
  for (const [name, ent] of dir) {
    if (!name.startsWith("bin/")) continue;
    if (++n % 10 === 0) onProgress?.(`Checking the backup… (${n} files)`);
    const slice = await entryData(file, ent);
    if (ent.method !== 0) { await bytesOf(name); continue; }
    if (ent.compSize !== ent.size) throw bad(`"${name}" inside the backup is damaged.`);
    let crc = 0;
    for (let o = 0; o < slice.size; o += CHUNK) crc = crcUpdate(crc, new Uint8Array(await slice.slice(o, o + CHUNK).arrayBuffer()));
    if (crc !== ent.crc) throw bad(`"${name}" inside the backup is damaged.`);
  }
  const json = async (name) => JSON.parse(strFromU8(await bytesOf(name)));
  const binary = async (path) => {
    const ent = dir.get(path);
    if (!ent) throw bad(`"${path}" is missing from the backup.`);
    if (ent.method === 0) return entryData(file, ent);
    return new Blob([await bytesOf(path)]);
  };
  return { file, dir, manifest, json, binary };
}

/** Records of one batch file, decoded: [{ key, value }]. */
async function batchRecords(bundle, name) {
  const out = [];
  const rows = await bundle.json(name);
  if (!Array.isArray(rows)) throw bad(`"${name}" isn't a list of records.`);
  // binary parts as archive slices, fetched before the synchronous decode
  const tags = [];
  const collect = (v) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (!v || typeof v !== "object") return;
    if (v[TAG] === "blob" || v[TAG] === "ab" || v[TAG] === "view") { tags.push(v); return; }
    Object.values(v[TAG] === "obj" ? v.v || {} : v).forEach(collect);
  };
  rows.forEach((r) => collect(r?.v));
  const blobs = new Map();
  for (const t of tags) {
    const b = await bundle.binary(t.path);
    blobs.set(t, t[TAG] === "blob" ? (t.type ? b.slice(0, b.size, t.type) : b) : b);
  }
  const pending = [];
  for (const r of rows) {
    if (!r || (typeof r.k !== "string" && typeof r.k !== "number")) throw bad(`"${name}" holds a record without a key.`);
    out.push({ key: r.k, value: decodeValue(r.v, (t) => blobs.get(t), pending) });
  }
  await resolvePending(pending);
  return out;
}

// An encoded value with its archive paths dropped: two records that encode
// alike are the same record (binary parts compared by size and type, and a
// plan record also carries its sha256).
function sameEncoded(a, b) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== "object") return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!(k === "path" && v[TAG])) o[k] = strip(x);
    return o;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * What an import would do here: counts, and every key that already exists in
 * this browser (an import replaces those only with the person's say-so).
 * @param {any} bundle  from openBrowserExport
 * @param {{ withDb: Function, storage?: any }} opts
 * @returns {Promise<any>}
 */
export async function inspectBrowserExport(bundle, { withDb, storage }) {
  // one batch file at a time, like apply: a large meta store (OCR caches) is
  // never held decoded all at once
  const incoming = {};
  const conflicts = {};
  for (const s of STORES) {
    incoming[s] = 0;
    conflicts[s] = [];
    for (const name of bundle.manifest.files[s] || []) {
      const rows = await bundle.json(name);
      if (!Array.isArray(rows)) throw bad(`"${name}" isn't a list of records.`);
      incoming[s] += rows.length;
      // A key already here is a conflict only when the record differs:
      // putting back an identical record changes nothing.
      const differing = await withDb(async (db) => {
        if (!db.objectStoreNames.contains(s)) return [];
        const here = new Set(await storeKeys(db, s));
        const out = [];
        for (const r of rows) {
          if (!here.has(r?.k)) continue;
          let same = false;
          try { same = sameEncoded(encodeValue(await storeGet(db, s, r.k), () => ""), r.v); } catch { same = false; }
          if (!same) out.push(r.k);
        }
        return out;
      });
      conflicts[s].push(...differing);
    }
  }
  // local storage: only the keys apply would write
  const ls = await bundle.json(LOCAL_STORAGE_NAME).catch(() => ({}));
  const lsKeys = Object.keys(ls || {}).filter((k) => isAppStorageKey(k) && !storageExclusion(k) && typeof ls[k] === "string");
  conflicts.localStorage = lsKeys.filter((k) => storage && storage.getItem(k) != null && storage.getItem(k) !== ls[k]);
  let conflictCount = 0;
  for (const s of [...STORES, "localStorage"]) conflictCount += conflicts[s].length;
  return {
    manifest: bundle.manifest,
    incoming: { ...incoming, localStorage: lsKeys.length },
    conflicts,
    conflictCount,
  };
}

/**
 * Write the bundle into this browser. Refuses when anything would be
 * replaced unless `overwrite` is true. Records not in the backup stay.
 * @param {any} bundle  from openBrowserExport
 * @param {{ withDb: Function, storage?: any, overwrite?: boolean, onProgress?: (msg: string) => void }} opts
 * @returns {Promise<any>}
 */
export async function applyBrowserExport(bundle, { withDb, storage, overwrite = false, onProgress }) {
  const plan = await inspectBrowserExport(bundle, { withDb, storage });
  if (plan.conflictCount && !overwrite) {
    const err = new Error(`Couldn't import: ${plan.conflictCount} item${plan.conflictCount === 1 ? "" : "s"} in this browser would be replaced. Confirm the replacement to continue.`);
    err.name = "ImportConflictError";
    throw err;
  }
  const written = {};
  for (const s of STORES) {
    onProgress?.(`Restoring ${s === "pdfs" || s === "pdf_revs" ? "plans" : s === "snapshots" ? "snapshots" : "projects"}…`);
    written[s] = 0;
    // one batch file at a time: decoded, written in one transaction, let go
    for (const name of bundle.manifest.files[s] || []) {
      const recs = await batchRecords(bundle, name);
      written[s] += recs.length;
      if (!recs.length) continue;
      await withDb((db) => new Promise((resolve, reject) => {
        const t = db.transaction(s, "readwrite");
        const os = t.objectStore(s);
        for (const { key, value } of recs) {
          if (os.keyPath == null) os.put(value, key);
          else os.put(value);
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("The browser's database stopped the import."));
      }));
    }
  }
  const ls = await bundle.json(LOCAL_STORAGE_NAME).catch(() => ({}));
  written.localStorage = 0;
  for (const [k, v] of Object.entries(ls || {})) {
    if (!isAppStorageKey(k) || storageExclusion(k) || typeof v !== "string") continue;
    storage?.setItem(k, v);
    written.localStorage += 1;
  }
  return { written, manifest: bundle.manifest };
}

// ── sinks ──────────────────────────────────────────────────────────────────

/** Collect the archive in memory as Blob parts (the browser can page Blob
 * parts to disk) — the fallback where a file can't be written directly. */
export function blobSink(type = "application/zip") {
  const parts = [];
  let pending = [];
  let pendingBytes = 0;
  const roll = () => { if (pending.length) { parts.push(new Blob(pending)); pending = []; pendingBytes = 0; } };
  return {
    write(chunk) { pending.push(chunk); pendingBytes += chunk.length; if (pendingBytes >= 64 * 1024 * 1024) roll(); },
    close() { roll(); },
    blob() { roll(); return new Blob(parts, { type }); },
  };
}
