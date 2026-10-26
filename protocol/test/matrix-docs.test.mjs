import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderMatrix, refreshMatrix } from "../scripts/check-matrix.mjs";

const row = { id: "fixture", status: "conforms", scope: "Browser → MCP", assertion: "Exact records" };
test("matrix generation rejects unclassified, duplicate or incomplete cases and missing markers", () => {
  assert.throws(() => renderMatrix([row, row]), /duplicate/);
  assert.throws(() => renderMatrix([{ ...row, status: "probably works" }]), /Incomplete/);
  assert.throws(() => renderMatrix([{ ...row, assertion: "" }]), /Incomplete/);
  assert.throws(() => refreshMatrix("# No generated matrix", [row]), /Missing/);
});
test("CI rejects changed matrix evidence and repairs only explicitly; CRLF is stable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-matrix-docs-"));
  try {
    for (const name of ["scripts", "test"]) mkdirSync(join(dir, name));
    copyFileSync(new URL("../scripts/check-matrix.mjs", import.meta.url), join(dir, "scripts/check-matrix.mjs"));
    const source = join(dir, "test/transport-matrix.json"), doc = join(dir, "COMPATIBILITY.md");
    writeFileSync(source, JSON.stringify([row]));
    writeFileSync(doc, "# Matrix\n<!--transport-matrix-->stale<!--/transport-matrix-->\n");
    const run = (...args) => spawnSync(process.execPath, [join(dir, "scripts/check-matrix.mjs"), ...args], { encoding: "utf8" });
    assert.equal(run().status, 1);
    assert.equal(run("--write").status, 0);
    assert.equal(run().status, 0);
    writeFileSync(doc, readFileSync(doc, "utf8").replace(/\n/g, "\r\n"));
    assert.equal(run().status, 0);
    for (const update of [{ status: "unsupported" }, { assertion: "New preservation evidence" }, { scope: "Archive only" }]) {
      writeFileSync(source, JSON.stringify([{ ...row, ...update }]));
      const stale = run(); assert.equal(stale.status, 1); assert.match(stale.stderr, /stale/);
      assert.equal(run("--write").status, 0);
    }
    writeFileSync(doc, "# Deleted marker\n");
    assert.match(run().stderr, /Missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
