// The marked set's page-source decision (src/lib/markedsetSource.js), and the
// pdf-lib behaviour on an encrypted source that forces it — pinned on a real
// fixture: demo/sample-plan.pdf encrypted AES-256 (R6) with an owner password
// and an EMPTY user password, the export every viewer opens without asking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { sourcePageMode, sourceStampNote, noCanvasForRasterMessage } from "../src/lib/markedsetSource.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENCRYPTED = readFileSync(join(here, "fixtures/sample-plan-encrypted.pdf"));
const PLAIN = readFileSync(join(here, "../../demo/sample-plan.pdf"));

test("sourcePageMode: dark wins, then encrypted, else vector", () => {
  assert.equal(sourcePageMode({ dark: false, encrypted: false }), "vector");
  assert.equal(sourcePageMode({ dark: false, encrypted: true }), "raster");
  assert.equal(sourcePageMode({ dark: true, encrypted: false }), "raster-inverted");
  assert.equal(sourcePageMode({ dark: true, encrypted: true }), "raster-inverted");
  assert.equal(sourcePageMode(), "vector");
});

test("sourceStampNote: only the forced raster discloses, and it names the reason", () => {
  assert.equal(sourceStampNote("vector"), "");
  assert.equal(sourceStampNote("raster-inverted"), "");
  assert.match(sourceStampNote("raster"), /encrypted/);
  assert.match(sourceStampNote("raster"), /raster copy/);
});

test("noCanvasForRasterMessage: names the sheet, the reason, and the two ways out", () => {
  const m = noCanvasForRasterMessage("A-101");
  assert.match(m, /^A-101: /);
  assert.match(m, /encrypted/);
  assert.match(m, /no canvas/);
  assert.match(m, /from the app|unencrypted/);
  assert.doesNotMatch(noCanvasForRasterMessage(""), /^: /);
});

test("pdf-lib on the encrypted fixture: loads with ignoreEncryption, reports isEncrypted", async () => {
  await assert.rejects(PDFDocument.load(ENCRYPTED), /encrypted/i, "a plain load refuses");
  const src = await PDFDocument.load(ENCRYPTED, { ignoreEncryption: true });
  assert.equal(src.isEncrypted, true);
  assert.equal(src.getPageCount(), 1);
  const plain = await PDFDocument.load(PLAIN);
  assert.equal(plain.isEncrypted, false, "the control fixture is the same page, unencrypted");
});

test("the copyPages path (single sheet, light mode) saves a page whose content cannot be decoded — the silent blank sheet", async () => {
  const src = await PDFDocument.load(ENCRYPTED, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [0]);
  out.addPage(copied);
  const bytes = await out.save();   // no throw — that is the problem
  const back = await PDFDocument.load(bytes);
  assert.equal(back.isEncrypted, false, "the output is not marked encrypted, so viewers try to read the bytes as-is");
  const contents = back.getPage(0).node.lookup(PDFName.of("Contents"));
  assert.ok(contents instanceof PDFRawStream, "single content stream");
  assert.throws(() => decodePDFRawStream(contents).decode(), /compression|flate|decode/i, "the copied stream is still ciphertext");

  // control: the same page from the plain source decodes to real operators
  const plain = await PDFDocument.load(PLAIN);
  const out2 = await PDFDocument.create();
  const [c2] = await out2.copyPages(plain, [0]);
  out2.addPage(c2);
  const back2 = await PDFDocument.load(await out2.save());
  const s2 = back2.getPage(0).node.lookup(PDFName.of("Contents"));
  assert.ok(s2 instanceof PDFRawStream);
  const text = Buffer.from(decodePDFRawStream(s2).decode()).toString("latin1");
  assert.match(text, /\b(re|l|m|S|f|BT)\b/, "plain content decodes to PDF operators");
});

test("the embedPage path (stitch composite, light mode) throws at save on the encrypted source", async () => {
  const src = await PDFDocument.load(ENCRYPTED, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const emb = await out.embedPage(src.getPage(0));
  out.addPage([612, 792]).drawPage(emb, { x: 0, y: 0 });
  await assert.rejects(out.save(), /compression|flate|decode/i);
});
