// Drive sync for report templates (#115) — the folder/file orchestration and
// the per-user namespacing, exercised against a FAKE drive (a plain object with
// the four primitives this module calls). No network, no login, no createDrive.
// Push must create-or-update the user's file under a hidden ".opentakeoff"
// folder; Load must return [] until something is there, then round-trip; and two
// different users must resolve to two different files (no clobber).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSyncTemplates, templatesFileName, pushTemplatesToDrive, loadTemplatesFromDrive } from "../src/lib/reportTemplatesSync.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT = "root-folder";

// An in-memory Drive: a flat list of { id, name, parents, mimeType, data },
// implementing only findChild / createFolder / putJson / getJson. Records calls
// so a test can assert e.g. that putJson updated in place vs created.
function fakeDrive(seed: any[] = []) {
  let seq = 0;
  const files: any[] = [...seed];
  const calls: any[] = [];
  return {
    calls,
    files,
    async listChildren(folderId: string, { mimeType }: any = {}) {
      calls.push({ op: "listChildren", folderId, mimeType: mimeType ?? null });
      return files
        .filter((x) => x.parents?.includes(folderId) && (!mimeType || x.mimeType === mimeType))
        .map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType }));
    },
    async findChild(folderId: string, name: string) {
      calls.push({ op: "findChild", folderId, name });
      const f = files.find((x) => x.parents?.includes(folderId) && x.name === name);
      return f ? { id: f.id, name: f.name, mimeType: f.mimeType } : null;
    },
    async createFolder(parentId: string, name: string) {
      calls.push({ op: "createFolder", parentId, name });
      const f = { id: `fld${++seq}`, name, parents: [parentId], mimeType: FOLDER_MIME, data: null };
      files.push(f);
      return { id: f.id, name: f.name };
    },
    async putJson({ folderId, name, data, existingId }: any) {
      calls.push({ op: "putJson", folderId, name, existingId: existingId ?? null });
      if (existingId) {
        const f = files.find((x) => x.id === existingId);
        f.data = data;
        return { id: f.id };
      }
      const f = { id: `file${++seq}`, name, parents: [folderId], mimeType: "application/json", data };
      files.push(f);
      return { id: f.id };
    },
    async getJson(fileId: string) {
      calls.push({ op: "getJson", fileId });
      return files.find((x) => x.id === fileId)?.data;
    },
  };
}

// ── canSyncTemplates (pure gate) ─────────────────────────────────────────────

test("canSyncTemplates: needs both a user with an email AND a Drive root", () => {
  assert.equal(canSyncTemplates({ email: "a@b.com" }, ROOT), true);
  assert.equal(canSyncTemplates(null, ROOT), false);
  assert.equal(canSyncTemplates({ email: "" }, ROOT), false);
  assert.equal(canSyncTemplates({ email: "   " }, ROOT), false);
  assert.equal(canSyncTemplates({ name: "no email" }, ROOT), false);
  assert.equal(canSyncTemplates({ email: "a@b.com" }, ""), false);
});

// ── templatesFileName (per-user namespacing) ─────────────────────────────────

test("templatesFileName: per-user, lower-cased so casing can't split a user's file", () => {
  assert.equal(templatesFileName("Estimator@345Flooring.com"), "report-templates-estimator@345flooring.com.json");
  assert.notEqual(templatesFileName("a@x.com"), templatesFileName("b@x.com"));
});

// ── push ─────────────────────────────────────────────────────────────────────

test("push: creates the hidden folder then the user's file on a first push", async () => {
  const drive = fakeDrive();
  const res = await pushTemplatesToDrive(drive, ROOT, "a@x.com", [{ id: "t1", name: "A" }]);
  assert.equal(res.count, 1);
  assert.ok(drive.calls.some((c) => c.op === "createFolder" && c.name === ".opentakeoff"));
  const put = drive.calls.find((c) => c.op === "putJson");
  assert.equal(put.name, "report-templates-a@x.com.json");
  assert.equal(put.existingId, null, "first push creates, not updates");
  // the folder was created under the ROOT, and the file under that folder
  const folder = drive.files.find((f) => f.name === ".opentakeoff");
  assert.deepEqual(folder.parents, [ROOT]);
});

test("push: reuses an existing folder+file and UPDATES the file in place", async () => {
  const drive = fakeDrive();
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", [{ id: "t1", name: "A" }]);
  const foldersAfterFirst = drive.files.filter((f) => f.mimeType === FOLDER_MIME).length;
  drive.calls.length = 0;
  const res = await pushTemplatesToDrive(drive, ROOT, "a@x.com", [{ id: "t1", name: "A" }, { id: "t2", name: "B" }]);
  assert.equal(res.count, 2);
  assert.equal(drive.files.filter((f) => f.mimeType === FOLDER_MIME).length, foldersAfterFirst, "no second folder");
  const put = drive.calls.find((c) => c.op === "putJson");
  assert.ok(put.existingId, "second push updates the same file in place");
  assert.equal(drive.calls.some((c) => c.op === "createFolder"), false);
});

test("push: a stray FILE named .opentakeoff is not mistaken for the sync folder", async () => {
  // seed a non-folder file with the reserved name at the root
  const drive = fakeDrive([{ id: "stray", name: ".opentakeoff", parents: [ROOT], mimeType: "application/json", data: null }]);
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", []);
  assert.ok(drive.calls.some((c) => c.op === "createFolder"), "creates a real folder rather than using the stray file");
});

// ── load ─────────────────────────────────────────────────────────────────────

test("load: no synced folder yet → [] (a normal first-Load state, not an error)", async () => {
  const drive = fakeDrive();
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), []);
});

test("load: folder exists but this user's file doesn't → []", async () => {
  const drive = fakeDrive();
  await pushTemplatesToDrive(drive, ROOT, "other@x.com", [{ id: "o", name: "O" }]);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), []);
});

test("load: round-trips what push wrote", async () => {
  const drive = fakeDrive();
  const templates = [{ id: "t1", name: "A", cols: {}, groupBy: "sheet" }];
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", templates);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), templates);
});

test("load: a stray FILE named .opentakeoff beside the real folder does NOT shadow it", async () => {
  // The bug the folder resolution guards against: findChild matches on name only,
  // so a non-folder named ".opentakeoff" could sort ahead of the real folder and
  // make load return [] while the templates sit right beside it. Resolving the
  // folder by folder-typed listing must ignore the stray file.
  const drive = fakeDrive([{ id: "stray", name: ".opentakeoff", parents: [ROOT], mimeType: "application/json", data: null }]);
  const templates = [{ id: "t1", name: "A", cols: {}, groupBy: "" }];
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", templates);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), templates);
});

test("load: if .opentakeoff exists only as a FILE (no real folder), return [] (don't treat a file as a folder)", async () => {
  const drive = fakeDrive([{ id: "bad", name: ".opentakeoff", parents: [ROOT], mimeType: "application/json", data: null }]);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), []);
});

test("load: an empty pushed set round-trips as [] (not null/undefined)", async () => {
  const drive = fakeDrive();
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", []);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), []);
});

test("load: non-array file contents coerce to [] (never hand junk to the merger)", async () => {
  const drive = fakeDrive();
  await pushTemplatesToDrive(drive, ROOT, "a@x.com", [{ id: "t", name: "A" }]);
  // corrupt the stored data to a non-array
  drive.files.find((f) => f.name === "report-templates-a@x.com.json").data = { not: "an array" };
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "a@x.com"), []);
});

// ── isolation ────────────────────────────────────────────────────────────────

test("two users share the folder but not the file — no clobber", async () => {
  const drive = fakeDrive();
  await pushTemplatesToDrive(drive, ROOT, "alice@x.com", [{ id: "a", name: "Alice layout" }]);
  await pushTemplatesToDrive(drive, ROOT, "bob@x.com", [{ id: "b", name: "Bob layout" }]);
  // one shared folder, two distinct files
  assert.equal(drive.files.filter((f) => f.mimeType === FOLDER_MIME).length, 1);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "alice@x.com"), [{ id: "a", name: "Alice layout" }]);
  assert.deepEqual(await loadTemplatesFromDrive(drive, ROOT, "bob@x.com"), [{ id: "b", name: "Bob layout" }]);
});
