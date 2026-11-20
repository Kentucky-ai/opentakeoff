// Export everything / Import everything (.otkx): the manifest, the value
// encoding, the budgets, the overwrite refusal, and a full round trip from a
// seeded browser (two projects, plans with revisions, snapshots, libraries,
// local storage) into an empty one, compared deep-equal record by record.
// Runs on fake-indexeddb; each test swaps in a fresh IDBFactory.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { localStore, createLocalStore, metaPut, withStoreDb, setDeferHashBytes } from "../src/lib/store.js";
import {
  BROWSER_EXPORT_SCHEMA, MANIFEST_NAME, LOCAL_STORAGE_NAME, PROFILE_NAME,
  writeBrowserExport, openBrowserExport, inspectBrowserExport, applyBrowserExport,
  buildManifest, validateManifest, encodeValue, isBrowserExport, isAppStorageKey, storageExclusion, metaExclusion, blobSink,
} from "../src/lib/browserExport.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
  setDeferHashBytes(32 * 1024 * 1024);
});

class MemStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

const enc = new TextEncoder();
const pdf = (name: string, tag: string, size = 0) => {
  const head = enc.encode(`%PDF-1.4 ${tag}\n`);
  const body = new Uint8Array(Math.max(size, head.length));
  body.set(head);
  for (let i = head.length; i < body.length; i++) body[i] = (i * 31 + tag.length) & 0xff;
  return new File([body], name, { type: "application/pdf" });
};

const STORES = ["pdfs", "pdf_revs", "snapshots", "meta"];

// Every record of every store, Blobs turned into their bytes so deep-equal
// compares content, not identity.
async function dumpDb() {
  const norm = async (v: any): Promise<any> => {
    if (v instanceof Blob) return { blob: Array.from(new Uint8Array(await v.arrayBuffer())), type: v.type, file: v instanceof File ? v.name : null };
    if (v instanceof ArrayBuffer) return { ab: Array.from(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { view: v.constructor.name, bytes: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Date) return { date: v.toISOString() };
    if (Array.isArray(v)) return Promise.all(v.map(norm));
    if (v && typeof v === "object") {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) o[k] = await norm(x);
      return o;
    }
    return v;
  };
  const raw = await withStoreDb((db: IDBDatabase) => new Promise<any>((resolve, reject) => {
    const t = db.transaction(STORES, "readonly");
    const out: any = {};
    for (const s of STORES) {
      out[s] = [];
      const r = t.objectStore(s).openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return; out[s].push([c.key, c.value]); c.continue(); };
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  }));
  const out: any = {};
  for (const s of STORES) out[s] = await Promise.all(raw[s].map(async ([k, v]: any) => [k, await norm(v)]));
  return out;
}

async function seed(storage: MemStorage) {
  // project 1: the default workspace, a plan revised twice
  await localStore.addPdf(pdf("A1.pdf", "a1 v1", 5000));
  await localStore.addPdf(pdf("A1.pdf", "a1 v2", 6000));
  await localStore.addPdf(pdf("A1.pdf", "a1 v3", 7000));
  await localStore.addPdf(pdf("A2 floor plan.pdf", "a2", 3000));
  await localStore.saveAnnotations({
    conditions: [{ id: "c1", name: "Carpet", finish_tag: "CPT-1", waste_pct: 10 }],
    shapes: [{ id: "s1", condition_id: "c1", sheet_id: "A1.pdf", verts_norm: [[0, 0], [0.5, 0], [0.5, 0.25]] }],
    markups: [], sheets: [{ sheet_id: "A1.pdf", units_per_px: 0.125 }],
  });
  // project 2: a linked-folder project, its own annotations record
  const p2 = createLocalStore("folder-xyz");
  await p2.saveAnnotations({ conditions: [{ id: "c9", name: "LVT", finish_tag: "LVT-2" }], shapes: [], markups: [], sheets: [] });
  // snapshots of both
  await localStore.saveSnapshot("Before revision", { conditions: [{ id: "c1" }], shapes: [] });
  await localStore.saveSnapshot("  Bid day ", { conditions: [], shapes: [{ id: "s2", verts_norm: [[0.1, 0.2]] }] });
  // libraries
  await localStore.saveTemplates([{ id: "t1", name: "Carpet tile", unit: "SF" }]);
  await localStore.saveMaterialLibrary([{ id: "m1", name: "Adhesive", coverage: 200 }]);
  // other meta: tricky values the encoder must carry exactly
  await metaPut("sheet_pages:default", { "A1.pdf": [1, 2, 3] });
  await metaPut("sync:folder-xyz:base", { rev: 4, at: new Date("2026-11-01T10:00:00Z"), gone: undefined, inf: Infinity, nan: NaN, $otkx: "not a tag" });
  await metaPut("ocr:v1:" + "a".repeat(64) + ":1", { words: [{ t: "ROOM", b: new Float32Array([1.5, 2.5, 3, 4]) }], raw: new Uint8Array([9, 8, 7]).buffer });
  await metaPut("thumb:v3:A1.pdf", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  await metaPut("fsync:handle", { kind: "directory", name: "Jobs" });
  // local storage: app keys, a credential, and someone else's key
  storage.setItem("opentakeoff_company", JSON.stringify({ name: "Acme Floors" }));
  storage.setItem("opentakeoff_units", "metric");
  storage.setItem("ot-author", "EJ");
  storage.setItem("opentakeoff.ui-language", "en");
  storage.setItem("ot.workspace-layout.v1", "{\"left\":320}");
  storage.setItem("m365:enabled", "true");
  storage.setItem("opentakeoff_ai_key", "sk-secret");
  storage.setItem("ot.assistant.link.v1", "{\"port\":1,\"token\":\"t\"}");
  storage.setItem("opentakeoff_backup_state", "{}");
  storage.setItem("unrelated_site_key", "x");
}

async function exportBytes(storage: MemStorage, opts: any = {}) {
  const sink = blobSink();
  const manifest = await writeBrowserExport({
    withDb: withStoreDb, sink, storage, appVersion: "9.9.9",
    buildProfile: async () => ({ schema: "opentakeoff.profile.v1", app: "opentakeoff", condition_templates: [] }),
    now: () => new Date("2026-11-19T12:00:00Z"),
    ...opts,
  });
  return { manifest, blob: sink.blob() };
}

test("otkx: extension and key rules", () => {
  assert.equal(isBrowserExport("opentakeoff-backup-2026-11-19.otkx"), true);
  assert.equal(isBrowserExport("x.OTKX"), true);
  assert.equal(isBrowserExport("x.otk"), false);
  for (const k of ["opentakeoff_company", "opentakeoff.ui-language", "ot-author", "ot.workspace-layout.v1", "m365:enabled", "opentakeoff:theme"]) assert.equal(isAppStorageKey(k), true, k);
  for (const k of ["msal.token", "other", "otter"]) assert.equal(isAppStorageKey(k), false, k);
  assert.ok(storageExclusion("opentakeoff_ai_key"));
  assert.ok(storageExclusion("ot.assistant.link.v1"));
  assert.ok(storageExclusion("opentakeoff_backup_state"));
  assert.ok(storageExclusion("opentakeoff_some_token"));
  assert.equal(storageExclusion("opentakeoff_company"), null);
  assert.ok(metaExclusion("fsync:handle"));
  assert.ok(metaExclusion("thumb:v3:A1.pdf"));
  assert.equal(metaExclusion("fsync:scope"), null);
  assert.equal(metaExclusion("annotations"), null);
});

test("otkx manifest: schema, counts, projects, completeness", () => {
  const m = buildManifest({
    appVersion: "1.2.3", created: "2026-11-19T00:00:00.000Z",
    stores: { meta: ["annotations", "annotations:abc", "condition_templates"], pdfs: ["A1.pdf"], pdf_revs: ["A1.pdf\u00001"], snapshots: ["s1", "s2"] },
    files: { meta: ["idb/meta/000001.json"], pdfs: [], pdf_revs: [], snapshots: [], bin: 2 },
    localStorageKeys: ["opentakeoff_units"], libraries: { condition_templates: 1, materials: 0, stamps: 0 },
    omitted: [], excluded: [], binaryBytes: 10, totalBytes: 100, entries: 5,
  });
  assert.equal(m.schema, BROWSER_EXPORT_SCHEMA);
  assert.equal(m.app_version, "1.2.3");
  assert.equal(m.complete, true);
  assert.deepEqual(m.projects, ["annotations", "annotations:abc"]);
  assert.equal(m.counts.projects, 2);
  assert.equal(m.counts.pdfs, 1);
  assert.equal(m.counts.pdf_revs, 1);
  assert.equal(m.counts.snapshots, 2);
  assert.equal(m.counts.meta_records, 3);
  assert.equal(m.counts.local_storage_keys, 1);
  assert.deepEqual(m.limits, { max_bytes: 2 * 1024 ** 3, max_entries: 10_000 });
  assert.equal(validateManifest(m), m);
  const partial = buildManifest({ ...m, stores: {}, files: m.files, localStorageKeys: [], libraries: {}, omitted: [{ store: "pdfs", key: "B.pdf", bytes: 1, reason: "size limit" }], excluded: [], binaryBytes: 0, totalBytes: 0, entries: 1, created: m.created });
  assert.equal(partial.complete, false);
});

test("otkx manifest: unknown or hollow manifests are refused", () => {
  assert.throws(() => validateManifest(null), /Couldn't import/);
  assert.throws(() => validateManifest({ schema: "opentakeoff.browser_export.v2", files: {} }), /backup version "opentakeoff.browser_export.v2"/);
  assert.throws(() => validateManifest({ schema: BROWSER_EXPORT_SCHEMA }), /lists no files/);
});

test("otkx encode: binary leaves the JSON, tags are exact, handles are refused", () => {
  const bins: Blob[] = [];
  const add = (b: Blob) => { bins.push(b); return `bin/x/${bins.length}.bin`; };
  const e = encodeValue({ a: 1, b: undefined, c: [NaN, -Infinity], d: new Date(0), blob: new Blob(["hi"], { type: "text/plain" }), $otkx: 5 }, add) as any;
  assert.equal(e.$otkx, "obj");
  assert.deepEqual(e.v.b, { $otkx: "undef" });
  assert.deepEqual(e.v.c, [{ $otkx: "num", v: "NaN" }, { $otkx: "num", v: "-Infinity" }]);
  assert.deepEqual(e.v.d, { $otkx: "date", v: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual(e.v.blob, { $otkx: "blob", path: "bin/x/1.bin", size: 2, type: "text/plain" });
  assert.equal(bins.length, 1);
  class Handle { kind = "directory"; }
  assert.throws(() => encodeValue({ h: new Handle() }, add), /Handle/);
});

test("otkx round trip: two projects, revisions, snapshots, libraries and settings into an empty browser", async () => {
  const src = new MemStorage();
  await seed(src);
  const before = await dumpDb();
  const { manifest, blob } = await exportBytes(src);

  // the manifest says what is inside
  assert.equal(manifest.schema, BROWSER_EXPORT_SCHEMA);
  assert.equal(manifest.app_version, "9.9.9");
  assert.equal(manifest.created, "2026-11-19T12:00:00.000Z");
  assert.equal(manifest.complete, true);
  assert.deepEqual([...manifest.projects].sort(), ["annotations", "annotations:folder-xyz"]);
  assert.equal(manifest.counts.pdfs, 2);
  assert.equal(manifest.counts.pdf_revs, 2);
  assert.equal(manifest.counts.snapshots, 2);
  assert.equal(manifest.counts.libraries.condition_templates, 1);
  assert.equal(manifest.counts.libraries.materials, 1);
  assert.deepEqual(manifest.local_storage_keys, ["m365:enabled", "opentakeoff.ui-language", "opentakeoff_company", "opentakeoff_units", "ot-author", "ot.workspace-layout.v1"]);
  assert.ok(manifest.excluded.some((x: any) => x.key === "opentakeoff_ai_key"));
  assert.ok(manifest.excluded.some((x: any) => x.store === "meta" && /thumbnail/.test(x.reason) && x.count === 1));
  assert.ok(manifest.excluded.some((x: any) => x.store === "meta" && /folder link/.test(x.reason) && x.count === 1));

  // the zip itself is plain: any unzip tool reads it
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(files[MANIFEST_NAME] && files[LOCAL_STORAGE_NAME] && files[PROFILE_NAME]);
  const ls = JSON.parse(strFromU8(files[LOCAL_STORAGE_NAME]));
  assert.equal(ls.opentakeoff_ai_key, undefined, "credentials never leave the browser");
  assert.equal(ls.unrelated_site_key, undefined);
  assert.equal(JSON.parse(strFromU8(files[PROFILE_NAME])).schema, "opentakeoff.profile.v1");
  assert.equal(Object.keys(files).filter((n) => n.startsWith("bin/pdfs/")).length, 2);
  assert.equal(Object.keys(files).filter((n) => n.startsWith("bin/pdf_revs/")).length, 2);

  // import into an empty browser
  (globalThis as any).indexedDB = new IDBFactory();
  const dst = new MemStorage();
  const file = new File([blob], "backup.otkx");
  const bundle = await openBrowserExport(file);
  const plan = await inspectBrowserExport(bundle, { withDb: withStoreDb, storage: dst });
  assert.equal(plan.conflictCount, 0);
  assert.deepEqual(plan.incoming, { meta: before.meta.length - 2, snapshots: 2, pdfs: 2, pdf_revs: 2, localStorage: 6 });
  const res = await applyBrowserExport(bundle, { withDb: withStoreDb, storage: dst });
  assert.equal(res.written.pdfs, 2);
  assert.equal(res.written.localStorage, 6);

  const after = await dumpDb();
  const expected = { ...before, meta: before.meta.filter(([k]: any) => k !== "fsync:handle" && !String(k).startsWith("thumb:")) };
  assert.deepEqual(after, expected);
  for (const k of manifest.local_storage_keys) assert.equal(dst.getItem(k), src.getItem(k), k);
  assert.equal(dst.getItem("opentakeoff_ai_key"), null);

  // and the store reads them back the way the canvas does
  const sheets = await localStore.listSheets();
  assert.deepEqual(sheets.map((s: any) => s.name).sort(), ["A1.pdf", "A2 floor plan.pdf"]);
  const revs = await localStore.listPdfRevisions("A1.pdf");
  assert.deepEqual(revs.map((r: any) => r.rev), [3, 2, 1]);
  const old = await localStore.loadPdfRevisionData("A1.pdf", 1);
  assert.equal(strFromU8(old.slice(0, 15)), "%PDF-1.4 a1 v1\n");
  const ann = await createLocalStore("folder-xyz").loadAnnotations();
  assert.equal(ann.conditions[0].finish_tag, "LVT-2");
});

test("otkx import refuses to replace existing data without the person's say-so", async () => {
  const src = new MemStorage();
  await seed(src);
  const { blob } = await exportBytes(src);
  // same browser, nothing changed: every key is here, but identical records
  // are not conflicts
  const same = await inspectBrowserExport(await openBrowserExport(new File([blob], "b.otkx")), { withDb: withStoreDb, storage: src });
  assert.equal(same.conflictCount, 0);
  // then change one project and one plan
  await localStore.saveAnnotations({ conditions: [{ id: "new", name: "Changed after backup" }], shapes: [], markups: [], sheets: [] });
  await localStore.addPdf(pdf("A2 floor plan.pdf", "a2 changed", 3100));
  const bundle = await openBrowserExport(new File([blob], "b.otkx"));
  const plan = await inspectBrowserExport(bundle, { withDb: withStoreDb, storage: src });
  assert.ok(plan.conflicts.meta.includes("annotations"));
  assert.deepEqual(plan.conflicts.pdfs, ["A2 floor plan.pdf"]);
  assert.deepEqual(plan.conflicts.pdf_revs, [], "the revision archived by the change is new, not a conflict");
  assert.equal(plan.conflictCount, 2);
  await assert.rejects(applyBrowserExport(bundle, { withDb: withStoreDb, storage: src }), (e: any) => e.name === "ImportConflictError" && /would be replaced/.test(e.message));
  // nothing was written
  assert.equal((await localStore.loadAnnotations()).conditions[0].id, "new");
  await applyBrowserExport(bundle, { withDb: withStoreDb, storage: src, overwrite: true });
  assert.equal((await localStore.loadAnnotations()).conditions[0].id, "c1");
});

test("otkx limits: records that don't fit are left out and listed, project records first", async () => {
  const src = new MemStorage();
  await seed(src);
  // room for the project records but not every plan
  const { manifest, blob } = await exportBytes(src, { limits: { bytes: 4 * 1024 * 1024 + 12_000 } });
  assert.equal(manifest.complete, false);
  assert.ok(manifest.omitted.length > 0);
  assert.ok(manifest.omitted.every((o: any) => o.reason === "size limit" && o.bytes > 0));
  assert.ok(manifest.projects.includes("annotations") && manifest.projects.includes("annotations:folder-xyz"), "project records go first");
  // entry budget
  const tight = await exportBytes(src, { limits: { entries: 8 } });
  assert.ok(tight.manifest.omitted.some((o: any) => o.reason === "entry limit"));
  assert.ok(tight.manifest.counts.entries <= 8);
  // what was written still imports
  (globalThis as any).indexedDB = new IDBFactory();
  const bundle = await openBrowserExport(new File([blob], "partial.otkx"));
  await applyBrowserExport(bundle, { withDb: withStoreDb, storage: new MemStorage() });
  assert.equal((await localStore.loadAnnotations()).conditions[0].finish_tag, "CPT-1");
});

test("otkx open: not a zip, no manifest, damaged bytes", async () => {
  await assert.rejects(openBrowserExport(new Blob(["not a zip at all"])), /isn't a zip file/);
  const { zipSync, strToU8 } = await import("fflate");
  await assert.rejects(openBrowserExport(new Blob([zipSync({ "x.txt": strToU8("hi") })])), /no manifest\.json/);
  const src = new MemStorage();
  await seed(src);
  const { blob } = await exportBytes(src);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // flip a byte inside the first plan's stored bytes
  const at = bytes.findIndex((_, i) => bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46);
  assert.ok(at > 0);
  bytes[at + 20] ^= 0xff;
  await assert.rejects(openBrowserExport(new Blob([bytes])), /damaged/);
});

test("otkx inspect: local storage conflicts count only keys an import would write", async () => {
  // a hand-edited backup carrying a credential and a foreign key alongside a real setting
  const bundle = {
    manifest: { files: { meta: [], snapshots: [], pdfs: [], pdf_revs: [] } },
    json: async (name: string) => (name === LOCAL_STORAGE_NAME
      ? { opentakeoff_units: "metric", opentakeoff_ai_key: "sk-from-file", other_site: "x", "ot.assistant.link.v1": "{}" }
      : []),
  };
  const here = new MemStorage();
  here.setItem("opentakeoff_units", "imperial");
  here.setItem("opentakeoff_ai_key", "sk-mine");
  here.setItem("other_site", "y");
  const plan = await inspectBrowserExport(bundle, { withDb: withStoreDb, storage: here });
  assert.deepEqual(plan.conflicts.localStorage, ["opentakeoff_units"]);
  assert.equal(plan.conflictCount, 1);
  assert.equal(plan.incoming.localStorage, 1);
  await applyBrowserExport(bundle, { withDb: withStoreDb, storage: here, overwrite: true });
  assert.equal(here.getItem("opentakeoff_units"), "metric");
  assert.equal(here.getItem("opentakeoff_ai_key"), "sk-mine", "a credential in a backup never replaces this browser's");
  assert.equal(here.getItem("other_site"), "y");
});
