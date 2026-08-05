// The overwrite guard (src/safewrite.ts). The export path stays unconstrained
// on purpose — writing the marked set into a job folder is the point — so what
// is tested here is authorship, not location: our own prior export overwrites
// silently, a stranger's file does not, and overwrite:true always wins.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { assertWritable, PDF_PRODUCER } from "../src/safewrite.ts";
import { UserError } from "../src/format.ts";

const dir = async () => mkdtemp(path.join(tmpdir(), "ot-safewrite-"));

/** Did it refuse, and with a message an agent can act on? */
async function refuses(p: string, kind: "json" | "pdf", overwrite?: boolean) {
  await assert.rejects(
    () => assertWritable(p, kind, overwrite),
    (e: unknown) => {
      assert.ok(e instanceof UserError, `expected UserError, got ${e}`);
      return true;
    },
  );
}

test("a path with nothing at it is writable", async () => {
  const d = await dir();
  await assertWritable(path.join(d, "takeoff.json"), "json");
  await assertWritable(path.join(d, "nested", "marked.pdf"), "pdf");
});

test("our own takeoff export overwrites silently — the re-export loop keeps working", async () => {
  const d = await dir();
  const p = path.join(d, "takeoff.json");
  await writeFile(p, JSON.stringify({ schema: "opentakeoff.takeoff_canvas.v1", shapes: [] }));
  await assertWritable(p, "json");
});

test("our own report export overwrites silently", async () => {
  const d = await dir();
  const p = path.join(d, "report.json");
  await writeFile(p, JSON.stringify({ schema: "opentakeoff.report.v1", rows: [] }));
  await assertWritable(p, "json");
});

test("a stranger's file is refused, and the bytes survive", async () => {
  const d = await dir();
  const p = path.join(d, "bid-recap.json");
  const precious = JSON.stringify({ bid: "Mayflower", total: 128400 });
  await writeFile(p, precious);
  await refuses(p, "json");
  assert.equal(await readFile(p, "utf8"), precious, "guard must not have touched the file");
});

test("refuses a same-named file that is not JSON at all", async () => {
  const d = await dir();
  const p = path.join(d, "takeoff.json");
  await writeFile(p, "PK not json, a zip that got misnamed");
  await refuses(p, "json");
});

test("refuses JSON carrying somebody else's schema", async () => {
  const d = await dir();
  const p = path.join(d, "x.json");
  await writeFile(p, JSON.stringify({ schema: "com.competitor.takeoff.v1", rows: [] }));
  await refuses(p, "json");
});

test("overwrite:true replaces a stranger's file — explicit is allowed", async () => {
  const d = await dir();
  const p = path.join(d, "anything.json");
  await writeFile(p, "mine, all mine");
  await assertWritable(p, "json", true);
  await assertWritable(p, "pdf", true);
});

test("a directory is refused with its own message, not an EISDIR later", async () => {
  const d = await dir();
  const sub = path.join(d, "exports");
  await mkdir(sub);
  await refuses(sub, "json");
  await refuses(sub, "pdf");
});

test("a marked set we produced is recognized by its Producer and overwrites", async () => {
  const d = await dir();
  const p = path.join(d, "plan - marked set.pdf");
  const doc = await PDFDocument.create();
  doc.setProducer(PDF_PRODUCER);
  doc.addPage([612, 792]);
  await writeFile(p, await doc.save());
  await assertWritable(p, "pdf");
});

test("somebody else's PDF is refused even at a marked-set-shaped path", async () => {
  const d = await dir();
  const p = path.join(d, "plan - marked set.pdf");
  const doc = await PDFDocument.create();          // pdf-lib's default Producer
  doc.addPage([612, 792]);
  await writeFile(p, await doc.save());
  await refuses(p, "pdf");
});

test("the signed contract nobody wants overwritten is refused", async () => {
  const d = await dir();
  const p = path.join(d, "subcontract-executed.pdf");
  const doc = await PDFDocument.create();
  doc.setProducer("Adobe Acrobat");
  doc.addPage([612, 792]);
  const bytes = await doc.save();
  await writeFile(p, bytes);
  await refuses(p, "pdf");
  assert.deepEqual(new Uint8Array(await readFile(p)), new Uint8Array(bytes));
});

test("a corrupt or unreadable file fails CLOSED — unknown is protected, not clobbered", async () => {
  const d = await dir();
  const truncated = path.join(d, "half.pdf");
  await writeFile(truncated, "%PDF-1.7\nthis stops mid-object and never had an xref");
  await refuses(truncated, "pdf");

  const empty = path.join(d, "empty.json");
  await writeFile(empty, "");
  await refuses(empty, "json");

  const unreadable = path.join(d, "locked.json");
  await writeFile(unreadable, JSON.stringify({ schema: "opentakeoff.report.v1" }));
  await chmod(unreadable, 0o000);
  try {
    await refuses(unreadable, "json");
  } finally {
    await chmod(unreadable, 0o600);
  }
});

test("whitespace-formatted JSON is still recognized as ours", async () => {
  const d = await dir();
  const p = path.join(d, "pretty.json");
  await writeFile(p, JSON.stringify({ schema: "opentakeoff.takeoff_canvas.v1" }, null, 2));
  await assertWritable(p, "json");
});

test("the marker must be in the head, not smuggled in from deep in the file", async () => {
  const d = await dir();
  const p = path.join(d, "decoy.json");
  // a stranger's file that happens to mention our schema 8KB down does not
  // become ours — the real payload stamps it as the first key
  await writeFile(p, JSON.stringify({ note: "x".repeat(9000), schema: "opentakeoff.report.v1" }));
  await refuses(p, "json");
});
