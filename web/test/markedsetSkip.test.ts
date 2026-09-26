// #462: closing a PDF out of the plan set keeps its takeoffs, so the marked
// set used to call loadPdfData on bytes that were gone and fail the whole
// export. splitLoadedSheets exports what's loaded and names what isn't.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLoadedSheets, skippedPdfsNote } from "../src/lib/markedset.js";

const sheet = (file: string, page = 1) => ({ key: page > 1 ? `${file}#${page}` : file, file, page, label: file });

test("every PDF loaded: all sheets kept, nothing missing", () => {
  const sheets = [sheet("a.pdf"), sheet("b.pdf")];
  const { kept, missingFiles } = splitLoadedSheets(sheets, ["a.pdf", "b.pdf"]);
  assert.deepEqual(kept, sheets);
  assert.deepEqual(missingFiles, []);
});

test("a closed PDF's sheets are skipped and named once, the rest still export", () => {
  const sheets = [sheet("a.pdf"), sheet("gone.pdf"), sheet("gone.pdf", 2)];
  const { kept, missingFiles } = splitLoadedSheets(sheets, ["a.pdf"]);
  assert.deepEqual(kept.map((s) => s.file), ["a.pdf"]);
  assert.deepEqual(missingFiles, ["gone.pdf"]);
});

test("a stitch is skipped when any member PDF is closed", () => {
  const stitch = { key: "stitch:1", label: "L1", stitch: { members: [{ file: "a.pdf" }, { file: "gone.pdf" }] } };
  const { kept, missingFiles } = splitLoadedSheets([sheet("a.pdf"), stitch], ["a.pdf"]);
  assert.deepEqual(kept.map((s) => s.key), ["a.pdf"]);
  assert.deepEqual(missingFiles, ["gone.pdf"]);
});

test("the status note is empty when nothing was skipped, and names the files when something was", () => {
  assert.equal(skippedPdfsNote([]), "");
  assert.equal(skippedPdfsNote(["gone.pdf"]), "skipped takeoffs on 1 closed PDF (gone.pdf). Re-open it to include it.");
  assert.match(skippedPdfsNote(["a.pdf", "b.pdf"]), /^skipped takeoffs on 2 closed PDFs \(a\.pdf, b\.pdf\)\. Re-open them/);
});
