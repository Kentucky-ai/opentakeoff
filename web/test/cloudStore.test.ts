// Drive-backed store adapter — the same seam contract as store.test.ts, but
// against an in-memory fake Drive (a Map) and a recording fake localStore. No
// network, no IndexedDB, no DOM: we prove listSheets/addPdf/annotations hit
// Drive with the localStore-compatible shapes, and that the browser-global
// methods delegate straight through to localStore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudStore } from "../src/lib/cloudStore.js";
import { ANN_SCHEMA } from "../src/lib/store.js";

const PDF_MIME = "application/pdf";

// Fake Drive over a Map<id, record>. Records are
// { id, name, mimeType, bytes, parent?, modifiedTime?, size? }.
// Enough of the createDrive surface for cloudStore to run. `parent` lets a test
// place a file in a SUBFOLDER: listChildren(folderId) returns only that folder's
// children, and findChild(folderId, name) matches only same-folder files —
// records seeded WITHOUT a parent stay findable in any folder (back-compat).
function fakeDrive() {
  const byId = new Map<string, any>();
  let seq = 0;
  const newId = () => `id_${++seq}`;
  const find = (folderId: string, name: string) => {
    for (const rec of byId.values()) {
      if (rec.name !== name) continue;
      if (rec.parent !== undefined && rec.parent !== folderId) continue;
      return rec;
    }
    return null;
  };
  return {
    _byId: byId,
    async listChildren(folderId: string, { mimeType }: any = {}) {
      const out = [];
      for (const rec of byId.values()) {
        if (rec.parent !== folderId) continue;
        if (mimeType && rec.mimeType !== mimeType) continue;
        out.push({ id: rec.id, name: rec.name, mimeType: rec.mimeType, modifiedTime: rec.modifiedTime ?? "t", size: rec.size });
      }
      return out;
    },
    async findChild(folderId: string, name: string) {
      const rec = find(folderId, name);
      // return the record's real modifiedTime (like listChildren) so the
      // sidecar-vs-legacy tiebreak is testable
      return rec ? { id: rec.id, name: rec.name, mimeType: rec.mimeType, modifiedTime: rec.modifiedTime ?? "t" } : null;
    },
    async createFolder(parentId: string, name: string) {
      const id = newId();
      byId.set(id, { id, name, parent: parentId, mimeType: "application/vnd.google-apps.folder" });
      return { id, name };
    },
    async getFileBytes(fileId: string) {
      return new Uint8Array(byId.get(fileId).bytes);
    },
    async getJson(fileId: string) {
      return JSON.parse(new TextDecoder().decode(byId.get(fileId).bytes));
    },
    async uploadFile({ name, parentId, mimeType, bytes }: any) {
      const id = newId();
      byId.set(id, { id, name, parent: parentId, mimeType, bytes: new Uint8Array(bytes) });
      return { id, name };
    },
    async updateFileBytes(fileId: string, bytes: Uint8Array, mimeType?: string) {
      const rec = byId.get(fileId);
      rec.bytes = new Uint8Array(bytes);
      if (mimeType) rec.mimeType = mimeType;
      return { id: fileId };
    },
    // Set _failPutJsonOnce = true to make the NEXT putJson reject (persist
    // failure), then it auto-clears — lets a test prove memory doesn't diverge.
    _failPutJsonOnce: false as boolean,
    async putJson({ folderId, name, data, existingId }: any) {
      if (this._failPutJsonOnce) { this._failPutJsonOnce = false; throw new Error("putJson boom"); }
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      if (existingId) return this.updateFileBytes(existingId, bytes, "application/json");
      return this.uploadFile({ name, parentId: folderId, mimeType: "application/json", bytes });
    },
    async deleteFile(fileId: string) {
      byId.delete(fileId);
    },
  };
}

// A localStore stand-in that records which delegated method was called.
function fakeLocal() {
  const calls: { method: string; args: any[] }[] = [];
  const rec = (method: string) => (...args: any[]) => { calls.push({ method, args }); return `ret:${method}`; };
  return {
    _calls: calls,
    loadTemplates: rec("loadTemplates"),
    saveTemplates: rec("saveTemplates"),
    loadMaterialLibrary: rec("loadMaterialLibrary"),
    saveMaterialLibrary: rec("saveMaterialLibrary"),
    loadStampLibrary: rec("loadStampLibrary"),
    saveStampLibrary: rec("saveStampLibrary"),
    saveSnapshot: rec("saveSnapshot"),
    listSnapshots: rec("listSnapshots"),
    getSnapshot: rec("getSnapshot"),
    deleteSnapshot: rec("deleteSnapshot"),
  };
}

// Minimal File stand-in: node has no DOM File, and cloudStore only needs
// `name` + `arrayBuffer()`.
function fakeFile(name: string, bytes: Uint8Array) {
  return { name, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}

test("listSheets returns the manifest's chosen PDFs, not everything in the folder", async () => {
  const drive = fakeDrive();
  // an un-manifested PDF sitting in the project folder must NOT surface
  drive._byId.set("id_a", { id: "id_a", name: "spec-book.pdf", parent: "folder1", mimeType: PDF_MIME, bytes: new Uint8Array() });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual(await store.listSheets(), []); // empty manifest → []

  await store.addSheets([{ id: "id_pick", name: "plan-a.pdf" }]);
  assert.deepEqual(await store.listSheets(), [{ name: "plan-a.pdf" }]);
});

test("addSheets dedupes by id and by name, keeps pick order, persists sheets.json", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });

  await store.addSheets([{ id: "1", name: "a.pdf" }, { id: "2", name: "b.pdf" }]);
  // same id (different name) and same name (different id) are both skipped
  const files = await store.addSheets([{ id: "1", name: "renamed.pdf" }, { id: "9", name: "b.pdf" }, { id: "3", name: "c.pdf" }]);
  assert.deepEqual(files, [{ id: "1", name: "a.pdf" }, { id: "2", name: "b.pdf" }, { id: "3", name: "c.pdf" }]);

  // exactly one sheets.json, holding the deduped set
  const sheetsFiles = [...drive._byId.values()].filter((r) => r.name === "sheets.json");
  assert.equal(sheetsFiles.length, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sheetsFiles[0].bytes)).files.map((f: any) => f.name), ["a.pdf", "b.pdf", "c.pdf"]);
});

test("concurrent addSheets with no sheets.json yet creates exactly ONE, keeping both sets of picks", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // two picks race before any sheets.json exists — the write chain must serialize
  // them so the first creates the file and the second reuses its id (no dup, no
  // lost picks).
  await Promise.all([
    store.addSheets([{ id: "1", name: "a.pdf" }]),
    store.addSheets([{ id: "2", name: "b.pdf" }]),
  ]);
  const sheetsFiles = [...drive._byId.values()].filter((r) => r.name === "sheets.json");
  assert.equal(sheetsFiles.length, 1);
  assert.deepEqual((await store.listSheets()).map((s) => s.name).sort(), ["a.pdf", "b.pdf"]);
});

test("a failed putJson leaves the in-memory manifest unchanged and rethrows", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addSheets([{ id: "1", name: "a.pdf" }]);

  drive._failPutJsonOnce = true;
  await assert.rejects(store.addSheets([{ id: "2", name: "b.pdf" }]), /putJson boom/);
  // memory did not absorb the failed pick, and disk still holds only a.pdf
  assert.deepEqual(await store.listSheets(), [{ name: "a.pdf" }]);
  // the write chain recovered — a later write still lands
  await store.addSheets([{ id: "3", name: "c.pdf" }]);
  assert.deepEqual((await store.listSheets()).map((s) => s.name), ["a.pdf", "c.pdf"]);
});

test("addSheets name-dedupe keeps the first id when a later pick reuses the name", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addSheets([{ id: "X", name: "plan.pdf" }]);
  const files = await store.addSheets([{ id: "Y", name: "plan.pdf" }]);
  // second (different id, same name) is dropped — the store pins name-dedupe even
  // though the picker also guards this in the UI.
  assert.deepEqual(files, [{ id: "X", name: "plan.pdf" }]);
});

test("addPdf uploads a new file, then updates on re-add (dedupe by name), and manifests it", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });

  await store.addPdf(fakeFile("plan.pdf", new Uint8Array([1, 2, 3])) as any);
  const pdfs = () => [...drive._byId.values()].filter((r) => r.mimeType === PDF_MIME);
  assert.equal(pdfs().length, 1);
  assert.deepEqual(pdfs()[0].bytes, new Uint8Array([1, 2, 3]));
  // the dropped PDF joined the working set
  assert.deepEqual(await store.listSheets(), [{ name: "plan.pdf" }]);

  const ret = await store.addPdf(fakeFile("plan.pdf", new Uint8Array([9, 9])) as any);
  assert.deepEqual(ret, { name: "plan.pdf" });
  assert.equal(pdfs().length, 1); // replaced, not duplicated
  assert.deepEqual(pdfs()[0].bytes, new Uint8Array([9, 9]));
  assert.deepEqual(await store.listSheets(), [{ name: "plan.pdf" }]); // re-add didn't dup the manifest entry
});

test("loadPdfData resolves by manifest id; throws when not in the working set", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addPdf(fakeFile("plan.pdf", new Uint8Array([37, 80, 68, 70])) as any);
  assert.deepEqual(await store.loadPdfData("plan.pdf"), new Uint8Array([37, 80, 68, 70]));
  await assert.rejects(store.loadPdfData("missing.pdf"), /PDF not in project sheet set: missing\.pdf/);
});

test("loadPdfData resolves a file living in a SUBFOLDER purely via the manifest id", async () => {
  const drive = fakeDrive();
  // the picked PDF lives in a subfolder, NOT the project folder — a
  // findChild-by-name in the project folder would never find it.
  drive._byId.set("sub_pdf", { id: "sub_pdf", name: "wing-b.pdf", parent: "subfolder1", mimeType: PDF_MIME, bytes: new Uint8Array([5, 6, 7]) });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addSheets([{ id: "sub_pdf", name: "wing-b.pdf" }]);
  assert.deepEqual(await store.loadPdfData("wing-b.pdf"), new Uint8Array([5, 6, 7]));
  // prove the project-folder name lookup is not the path: there is no such file
  // in folder1, yet the load succeeds.
  assert.equal(await drive.findChild("folder1", "wing-b.pdf"), null);
});

test("listFolder splits folders vs pdfs, carries size+modifiedTime, defaults to the project folder", async () => {
  const drive = fakeDrive();
  drive._byId.set("d1", { id: "d1", name: "Wing B", parent: "folder1", mimeType: "application/vnd.google-apps.folder", bytes: new Uint8Array() });
  drive._byId.set("p1", { id: "p1", name: "plan.pdf", parent: "folder1", mimeType: PDF_MIME, size: "2048", modifiedTime: "m1", bytes: new Uint8Array() });
  drive._byId.set("j1", { id: "j1", name: "annotations.json", parent: "folder1", mimeType: "application/json", bytes: new Uint8Array() });
  drive._byId.set("p2", { id: "p2", name: "wing.pdf", parent: "subfolder1", mimeType: PDF_MIME, size: "99", modifiedTime: "m2", bytes: new Uint8Array() });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });

  const root = await store.listFolder(); // defaults to folder1
  assert.deepEqual(root.folders, [{ id: "d1", name: "Wing B" }]);
  assert.deepEqual(root.pdfs, [{ id: "p1", name: "plan.pdf", size: "2048", modifiedTime: "m1" }]); // json ignored

  // drilling into a subfolder returns THAT folder's children
  const sub = await store.listFolder("subfolder1");
  assert.deepEqual(sub.folders, []);
  assert.deepEqual(sub.pdfs, [{ id: "p2", name: "wing.pdf", size: "99", modifiedTime: "m2" }]);
});

test("constructing the store and listing sheets triggers ZERO PDF downloads", async () => {
  const drive = fakeDrive();
  // a folder full of PDFs, none picked into the working set
  for (let i = 0; i < 5; i++) {
    drive._byId.set(`big_${i}`, { id: `big_${i}`, name: `spec-${i}.pdf`, parent: "folder1", mimeType: PDF_MIME, bytes: new Uint8Array([i]) });
  }
  let downloads = 0;
  const orig = drive.getFileBytes.bind(drive);
  (drive as any).getFileBytes = async (id: string) => { downloads++; return orig(id); };

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.listSheets();
  assert.equal(downloads, 0); // the core fix: no auto-download of the whole folder

  // a download happens ONLY when a picked sheet is actually loaded
  await store.addSheets([{ id: "big_2", name: "spec-2.pdf" }]);
  await store.loadPdfData("spec-2.pdf");
  assert.equal(downloads, 1);
});

test("removePdf drops the entry from the manifest but LEAVES the Drive file", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addPdf(fakeFile("plan.pdf", new Uint8Array([1])) as any);
  const pdfId = [...drive._byId.values()].find((r) => r.mimeType === PDF_MIME)!.id;

  await store.removePdf("plan.pdf");
  assert.deepEqual(await store.listSheets(), []); // out of the working set
  assert.ok(drive._byId.has(pdfId)); // but the shared Drive file survives

  await store.removePdf("nope.pdf"); // no-op, no throw
});

test("removeFromProject deletes the Drive file AND drops it from the manifest", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.addPdf(fakeFile("plan.pdf", new Uint8Array([1])) as any);
  const pdfId = [...drive._byId.values()].find((r) => r.mimeType === PDF_MIME)!.id;

  await store.removeFromProject("plan.pdf");
  assert.deepEqual(await store.listSheets(), []); // out of the working set
  assert.ok(!drive._byId.has(pdfId)); // and the Drive file is gone (unlike removePdf)

  await store.removeFromProject("nope.pdf"); // not in the manifest → no-op, no throw
});

test("loadAnnotations returns the localStore default shape when absent", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual(await store.loadAnnotations(), {
    schema: ANN_SCHEMA, conditions: [], shapes: [], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [],
  });
});

test("saveAnnotations round-trips, stamps schema, and updates in place", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });

  const payload = { conditions: [{ id: "c1" }], shapes: [{ id: "s1" }], markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [] };
  await store.saveAnnotations(payload);
  assert.deepEqual(await store.loadAnnotations(), { ...payload, schema: ANN_SCHEMA });

  // second save must update the same file, not create a second annotations.json
  await store.saveAnnotations({ ...payload, conditions: [{ id: "c2" }] });
  const jsonFiles = [...drive._byId.values()].filter((r) => r.name === "annotations.json");
  assert.equal(jsonFiles.length, 1);
  assert.deepEqual((await store.loadAnnotations()).conditions, [{ id: "c2" }]);
});

test("saveAnnotations after loadAnnotations reuses the discovered file id", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.saveAnnotations({ shapes: [] }); // creates the file
  // fresh store instance: loadAnnotations must find + cache the id so the next save updates
  const store2 = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store2.loadAnnotations();
  await store2.saveAnnotations({ shapes: [{ id: "s9" }] });
  const jsonFiles = [...drive._byId.values()].filter((r) => r.name === "annotations.json");
  assert.equal(jsonFiles.length, 1);
});

test("loadAnnotations throws a tagged CloudLoadError when the file exists but is unreadable", async () => {
  const drive = fakeDrive();
  // a present-but-corrupt annotations.json: getJson (JSON.parse) will throw
  drive._byId.set("id_x", { id: "id_x", name: "annotations.json", mimeType: "application/json", bytes: new TextEncoder().encode("{not json") });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await assert.rejects(store.loadAnnotations(), (e: any) => {
    assert.equal(e.name, "CloudLoadError");   // canvas routes on this to leave autosave DISARMED
    return true;
  });
});

test("loadAnnotations falls back to the empty default when the file parses to null", async () => {
  const drive = fakeDrive();
  drive._byId.set("id_n", { id: "id_n", name: "annotations.json", mimeType: "application/json", bytes: new TextEncoder().encode("null") });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual((await store.loadAnnotations()).conditions, []);
  assert.equal((await store.loadAnnotations()).schema, ANN_SCHEMA);
});

test("concurrent saves on a fresh project create exactly one annotations.json (no dup race)", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // two autosaves fire before the first resolves — the memoized file id must
  // funnel both to the same file instead of each taking the create branch.
  await Promise.all([
    store.saveAnnotations({ shapes: [{ id: "a" }] }),
    store.saveAnnotations({ shapes: [{ id: "b" }] }),
  ]);
  const jsonFiles = [...drive._byId.values()].filter((r) => r.name === "annotations.json");
  assert.equal(jsonFiles.length, 1);
});

// ── sidecar folder: location + migration ─────────────────────────────────────

// find the id of the .opentakeoff folder created inside a given project folder
function sidecarIdOf(drive: ReturnType<typeof fakeDrive>, parent: string) {
  const rec = [...drive._byId.values()].find(
    (r) => r.name === ".opentakeoff" && r.parent === parent && r.mimeType === "application/vnd.google-apps.folder",
  );
  return rec?.id as string | undefined;
}

test("annotations.json and sheets.json land INSIDE .opentakeoff/, not loose in the project", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.saveAnnotations({ shapes: [{ id: "s1" }] });
  await store.addSheets([{ id: "1", name: "a.pdf" }]);

  const sidecarId = sidecarIdOf(drive, "folder1");
  assert.ok(sidecarId, "expected a .opentakeoff folder parented to the project");

  // assert LOCATION (a record with parent === sidecarId), not just content — the
  // id-cache migration bug would preserve content while never creating a sidecar
  const ann = [...drive._byId.values()].find((r) => r.name === "annotations.json");
  assert.equal(ann!.parent, sidecarId);
  const sheets = [...drive._byId.values()].find((r) => r.name === "sheets.json");
  assert.equal(sheets!.parent, sidecarId);
  // and nothing loose in the project folder
  assert.equal([...drive._byId.values()].some((r) => r.name === "annotations.json" && r.parent === "folder1"), false);
  assert.equal([...drive._byId.values()].some((r) => r.name === "sheets.json" && r.parent === "folder1"), false);
});

test("concurrent first-writes create the .opentakeoff folder exactly once", async () => {
  const drive = fakeDrive();
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // annotations + sheets first-writes race before any .opentakeoff exists — the
  // memoized ensureSidecarId must serialize them into a single folder.
  await Promise.all([
    store.saveAnnotations({ shapes: [{ id: "a" }] }),
    store.addSheets([{ id: "1", name: "a.pdf" }]),
    store.addSheets([{ id: "2", name: "b.pdf" }]),
  ]);
  const folders = [...drive._byId.values()].filter(
    (r) => r.name === ".opentakeoff" && r.mimeType === "application/vnd.google-apps.folder",
  );
  assert.equal(folders.length, 1);
});

test("MIGRATION: legacy loose annotations.json → first save migrates it into the sidecar, leaves legacy in place", async () => {
  const drive = fakeDrive();
  // a legacy project: annotations.json sits LOOSE in the project folder (parented
  // to it, so findChild(sidecarId, ...) can't spuriously match it), no sidecar
  const legacyBytes = new TextEncoder().encode(JSON.stringify({ conditions: [{ id: "legacy" }], shapes: [] }));
  drive._byId.set("legacy_ann", { id: "legacy_ann", name: "annotations.json", parent: "folder1", mimeType: "application/json", bytes: legacyBytes });

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // first load reads the legacy content (no sidecar yet)
  assert.deepEqual((await store.loadAnnotations()).conditions, [{ id: "legacy" }]);

  // first save must create .opentakeoff/annotations.json seeded from legacy, then
  // apply the new payload — NOT rewrite the loose file in place
  await store.saveAnnotations({ conditions: [{ id: "updated" }], shapes: [] });
  const sidecarId = sidecarIdOf(drive, "folder1");
  assert.ok(sidecarId);
  const migrated = [...drive._byId.values()].find((r) => r.name === "annotations.json" && r.parent === sidecarId);
  assert.ok(migrated, "sidecar annotations.json must exist");
  // the legacy loose file is left untouched (still parented to the project)
  assert.ok(drive._byId.has("legacy_ann"));
  assert.equal(drive._byId.get("legacy_ann").parent, "folder1");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(drive._byId.get("legacy_ann").bytes)).conditions, [{ id: "legacy" }]);

  // a fresh store reload returns the migrated (sidecar) content, not legacy
  const store2 = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual((await store2.loadAnnotations()).conditions, [{ id: "updated" }]);
});

test("MIGRATION: legacy loose sheets.json → first addSheets migrates it into the sidecar, leaves legacy in place", async () => {
  const drive = fakeDrive();
  const legacyBytes = new TextEncoder().encode(JSON.stringify({ files: [{ id: "old", name: "old.pdf" }] }));
  drive._byId.set("legacy_sheets", { id: "legacy_sheets", name: "sheets.json", parent: "folder1", mimeType: "application/json", bytes: legacyBytes });

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // first read sees the legacy working set
  assert.deepEqual((await store.listSheets()).map((s) => s.name), ["old.pdf"]);

  // first mutation migrates the set into the sidecar and appends the new pick
  await store.addSheets([{ id: "new", name: "new.pdf" }]);
  const sidecarId = sidecarIdOf(drive, "folder1");
  assert.ok(sidecarId);
  const migrated = [...drive._byId.values()].find((r) => r.name === "sheets.json" && r.parent === sidecarId);
  assert.ok(migrated, "sidecar sheets.json must exist");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(migrated!.bytes)).files.map((f: any) => f.name), ["old.pdf", "new.pdf"]);
  // legacy loose file left untouched
  assert.ok(drive._byId.has("legacy_sheets"));
  assert.equal(drive._byId.get("legacy_sheets").parent, "folder1");

  // reload returns the migrated set
  const store2 = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual((await store2.listSheets()).map((s) => s.name), ["old.pdf", "new.pdf"]);
});

test("MIGRATION: a CORRUPT legacy annotations.json doesn't wedge the first save (empty sidecar)", async () => {
  const drive = fakeDrive();
  drive._byId.set("legacy_bad", { id: "legacy_bad", name: "annotations.json", parent: "folder1", mimeType: "application/json", bytes: new TextEncoder().encode("{not json") });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // the save must succeed rather than propagate the corrupt-legacy parse error
  await store.saveAnnotations({ conditions: [{ id: "fresh" }], shapes: [] });
  const sidecarId = sidecarIdOf(drive, "folder1");
  assert.ok(sidecarId);
  const created = [...drive._byId.values()].find((r) => r.name === "annotations.json" && r.parent === sidecarId);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(created!.bytes)).conditions, [{ id: "fresh" }]);
});

test("MIGRATION: a CORRUPT legacy sheets.json doesn't wedge the first addSheets (empty sidecar)", async () => {
  const drive = fakeDrive();
  drive._byId.set("legacy_bad_sheets", { id: "legacy_bad_sheets", name: "sheets.json", parent: "folder1", mimeType: "application/json", bytes: new TextEncoder().encode("{not json") });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // ensureManifest must swallow the corrupt legacy parse (mutateManifest awaits
  // it) so the write lands into a fresh sidecar rather than throwing
  await store.addSheets([{ id: "1", name: "a.pdf" }]);
  const sidecarId = sidecarIdOf(drive, "folder1");
  assert.ok(sidecarId);
  const created = [...drive._byId.values()].find((r) => r.name === "sheets.json" && r.parent === sidecarId);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(created!.bytes)).files.map((f: any) => f.name), ["a.pdf"]);
});

test("SPLIT-BRAIN tiebreak: when both a sidecar and a newer legacy file exist, read returns the newer legacy", async () => {
  const drive = fakeDrive();
  // sidecar folder + an OLD sidecar annotations.json
  drive._byId.set("sc", { id: "sc", name: ".opentakeoff", parent: "folder1", mimeType: "application/vnd.google-apps.folder" });
  drive._byId.set("sc_ann", { id: "sc_ann", name: "annotations.json", parent: "sc", mimeType: "application/json", modifiedTime: "2020-01-01", bytes: new TextEncoder().encode(JSON.stringify({ conditions: [{ id: "sidecar-old" }], shapes: [] })) });
  // a NEWER legacy loose file (an old tab wrote it after the sidecar existed)
  drive._byId.set("lg_ann", { id: "lg_ann", name: "annotations.json", parent: "folder1", mimeType: "application/json", modifiedTime: "2020-06-01", bytes: new TextEncoder().encode(JSON.stringify({ conditions: [{ id: "legacy-new" }], shapes: [] })) });

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual((await store.loadAnnotations()).conditions, [{ id: "legacy-new" }]);
});

test("SPLIT-BRAIN tiebreak: a newer sidecar wins over an older legacy", async () => {
  const drive = fakeDrive();
  drive._byId.set("sc", { id: "sc", name: ".opentakeoff", parent: "folder1", mimeType: "application/vnd.google-apps.folder" });
  drive._byId.set("sc_ann", { id: "sc_ann", name: "annotations.json", parent: "sc", mimeType: "application/json", modifiedTime: "2020-06-01", bytes: new TextEncoder().encode(JSON.stringify({ conditions: [{ id: "sidecar-new" }], shapes: [] })) });
  drive._byId.set("lg_ann", { id: "lg_ann", name: "annotations.json", parent: "folder1", mimeType: "application/json", modifiedTime: "2020-01-01", bytes: new TextEncoder().encode(JSON.stringify({ conditions: [{ id: "legacy-old" }], shapes: [] })) });

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  assert.deepEqual((await store.loadAnnotations()).conditions, [{ id: "sidecar-new" }]);
});

test("SPLIT-BRAIN write: a sidecar sheets.json already exists but a newer legacy wins the read → mutate UPDATES the sidecar file in place, never duplicates it", async () => {
  const drive = fakeDrive();
  // sidecar folder + an OLD sidecar sheets.json, plus a NEWER legacy loose one:
  // the tiebreak makes the READ prefer legacy (so sheetsId is left null), but the
  // WRITE must still target the EXISTING sidecar file rather than create a second.
  drive._byId.set("sc", { id: "sc", name: ".opentakeoff", parent: "folder1", mimeType: "application/vnd.google-apps.folder" });
  drive._byId.set("sc_sheets", { id: "sc_sheets", name: "sheets.json", parent: "sc", mimeType: "application/json", modifiedTime: "2020-01-01", bytes: new TextEncoder().encode(JSON.stringify({ files: [{ id: "sc-old", name: "sidecar-old.pdf" }] })) });
  drive._byId.set("lg_sheets", { id: "lg_sheets", name: "sheets.json", parent: "folder1", mimeType: "application/json", modifiedTime: "2020-06-01", bytes: new TextEncoder().encode(JSON.stringify({ files: [{ id: "lg-new", name: "legacy-new.pdf" }] })) });

  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  // read prefers the newer legacy set
  assert.deepEqual((await store.listSheets()).map((s) => s.name), ["legacy-new.pdf"]);
  await store.addSheets([{ id: "add", name: "added.pdf" }]);

  // exactly ONE sheets.json parented to the sidecar (no duplicate spawned)
  const sidecarSheets = [...drive._byId.values()].filter((r) => r.name === "sheets.json" && r.parent === "sc");
  assert.equal(sidecarSheets.length, 1, "must update the existing sidecar sheets.json, not create a second");
  // and it's the SAME file id, updated in place, carrying the migrated set + new pick
  assert.equal(sidecarSheets[0].id, "sc_sheets");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sidecarSheets[0].bytes)).files.map((f: any) => f.name), ["legacy-new.pdf", "added.pdf"]);
});

test("listFolder hides the .opentakeoff sidecar folder from the picker", async () => {
  const drive = fakeDrive();
  drive._byId.set("sc", { id: "sc", name: ".opentakeoff", parent: "folder1", mimeType: "application/vnd.google-apps.folder", bytes: new Uint8Array() });
  drive._byId.set("d1", { id: "d1", name: "Design Documents", parent: "folder1", mimeType: "application/vnd.google-apps.folder", bytes: new Uint8Array() });
  drive._byId.set("dot", { id: "dot", name: ".config", parent: "folder1", mimeType: "application/vnd.google-apps.folder", bytes: new Uint8Array() });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  const { folders } = await store.listFolder();
  // .opentakeoff is filtered by EXACT name; a legit dot-prefixed folder is not
  assert.deepEqual(folders.map((f) => f.name).sort(), [".config", "Design Documents"]);
});

test("a stray NON-folder file named .opentakeoff is ignored; a real sidecar folder is created", async () => {
  const drive = fakeDrive();
  // a rogue FILE (not a folder) named .opentakeoff sits in the project — findChild
  // matches by name only, so findSidecarFolder must reject it on mimeType.
  drive._byId.set("rogue", { id: "rogue", name: ".opentakeoff", parent: "folder1", mimeType: "application/json", bytes: new TextEncoder().encode("{}") });
  const store = createCloudStore("folder1", drive as any, { local: fakeLocal() as any });
  await store.saveAnnotations({ conditions: [{ id: "x" }], shapes: [] });

  // the write went into a real FOLDER named .opentakeoff, not the rogue file
  const sidecarFolder = [...drive._byId.values()].find((r) => r.name === ".opentakeoff" && r.mimeType === "application/vnd.google-apps.folder");
  assert.ok(sidecarFolder, "a real .opentakeoff folder must be created");
  const ann = [...drive._byId.values()].find((r) => r.name === "annotations.json");
  assert.equal(ann!.parent, sidecarFolder!.id);
  // the rogue file is left untouched and was never used as a parent
  assert.ok(drive._byId.has("rogue"));
  assert.equal([...drive._byId.values()].some((r) => r.parent === "rogue"), false);
});

test("browser-global methods delegate to localStore untouched", async () => {
  const drive = fakeDrive();
  const local = fakeLocal();
  const store = createCloudStore("folder1", drive as any, { local: local as any });

  assert.equal(store.loadTemplates(), "ret:loadTemplates");
  assert.equal(store.saveTemplates(["t"]), "ret:saveTemplates");
  assert.equal(store.loadMaterialLibrary(), "ret:loadMaterialLibrary");
  assert.equal(store.saveMaterialLibrary(["m"]), "ret:saveMaterialLibrary");
  assert.equal(store.loadStampLibrary(), "ret:loadStampLibrary");
  assert.equal(store.saveStampLibrary({ s: 1 }), "ret:saveStampLibrary");
  assert.equal(store.saveSnapshot("label", { x: 1 }), "ret:saveSnapshot");
  assert.equal(store.listSnapshots(), "ret:listSnapshots");
  assert.equal(store.getSnapshot("snap_1"), "ret:getSnapshot");
  assert.equal(store.deleteSnapshot("snap_1"), "ret:deleteSnapshot");

  assert.deepEqual(local._calls.map((c) => c.method), [
    "loadTemplates", "saveTemplates", "loadMaterialLibrary", "saveMaterialLibrary",
    "loadStampLibrary", "saveStampLibrary", "saveSnapshot", "listSnapshots",
    "getSnapshot", "deleteSnapshot",
  ]);
  // snapshot delegates inject this store's folderId ("folder1") as the scope;
  // deleteSnapshot is by unique id and stays unscoped.
  assert.deepEqual(local._calls[6].args, ["label", { x: 1 }, "folder1"]); // saveSnapshot
  assert.deepEqual(local._calls[7].args, ["folder1"]);                    // listSnapshots
  assert.deepEqual(local._calls[8].args, ["snap_1", "folder1"]);          // getSnapshot
  assert.deepEqual(local._calls[9].args, ["snap_1"]);                     // deleteSnapshot
});
