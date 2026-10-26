// Which PDFs the canvas keeps loaded (lib/stitches.ts pinnedFiles): every
// file an open sheet comes from, stitches through their members. The document
// cache never trims a pinned file, so a miss here frees a document in use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedFiles } from "../src/lib/stitches.js";

const st = (id: string, keys: string[]) => ({ id, name: id, members: keys.map((key) => ({ key, dx: 0, dy: 0 })) });

test("a page key pins its file, page 1 or later", () => {
  assert.deepEqual([...pinnedFiles({ keys: ["a.pdf", "b.pdf#3"], stitchById: {} })].sort(), ["a.pdf", "b.pdf"]);
});

test("a file name with a # in it is still one file", () => {
  assert.deepEqual([...pinnedFiles({ keys: ["plan #2.pdf", "plan #2.pdf#4"], stitchById: {} })], ["plan #2.pdf"]);
});

test("a stitch pins the files of all its members", () => {
  const s = st("stitch:x", ["a.pdf#2", "b.pdf", "a.pdf#3"]);
  assert.deepEqual([...pinnedFiles({ keys: ["stitch:x"], stitchById: { "stitch:x": s } })].sort(), ["a.pdf", "b.pdf"]);
});

test("a stitch that no longer exists pins nothing, and doesn't throw", () => {
  assert.deepEqual([...pinnedFiles({ keys: ["stitch:gone", "c.pdf"], stitchById: {} })], ["c.pdf"]);
});

test("each file is listed once", () => {
  const s = st("stitch:x", ["a.pdf", "a.pdf#2"]);
  const files = [...pinnedFiles({ keys: ["a.pdf", "stitch:x", "a.pdf#5", ""], stitchById: { "stitch:x": s } })];
  assert.deepEqual(files, ["a.pdf"]);
});
