import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderReference, refreshReference } from "../scripts/check-docs.mjs";

test("generated references detect changed fields, constraints and schema references", () => {
  const schemas = [{ path: "v1/example.schema.json", schema: { title: "Example", properties: { confidence: { type: "number", maximum: 1 }, origin: { $ref: "provenance.schema.json" } } } }];
  const rendered = renderReference(schemas);
  for (const change of [
    (s) => { s[0].schema.properties.actor = { type: "string" }; },
    (s) => { s[0].schema.properties.confidence.maximum = 0.5; },
    (s) => { s[0].schema.properties.origin.$ref = "evidence.schema.json"; },
  ]) {
    const revised = structuredClone(schemas); change(revised);
    assert.notEqual(renderReference(revised), rendered);
    assert.notEqual(refreshReference(rendered, revised), rendered);
  }
  assert.equal(refreshReference(rendered, schemas), rendered);
});

test("a removed generated block fails instead of silently bypassing the check", () => {
  assert.throws(() => refreshReference("# Readme with no marker", []), /missing/);
});

test("the CI command exits nonzero for stale documentation, repairs only with --write", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-protocol-docs-"));
  try {
    for (const path of ["scripts", "legacy", "v1"]) mkdirSync(join(dir, path));
    copyFileSync(new URL("../scripts/check-docs.mjs", import.meta.url), join(dir, "scripts/check-docs.mjs"));
    writeFileSync(join(dir, "v1/example.schema.json"), JSON.stringify({ title: "Example", properties: { actor: { type: "string" } } }));
    writeFileSync(join(dir, "README.md"), "# Fixture\n<!--schema-reference-->stale<!--/schema-reference-->\n");
    const run = (...args) => spawnSync(process.execPath, [join(dir, "scripts/check-docs.mjs"), ...args], { encoding: "utf8" });
    const stale = run();
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale/);
    assert.equal(run("--write").status, 0);
    assert.equal(run().status, 0);
    const crlf = readFileSync(join(dir, "README.md"), "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(join(dir, "README.md"), crlf);
    assert.equal(run().status, 0, "Windows checkout line endings are not documentation drift");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), crlf, "read-only check preserves checkout bytes");
    writeFileSync(join(dir, "README.md"), "# Missing generated block\n");
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
