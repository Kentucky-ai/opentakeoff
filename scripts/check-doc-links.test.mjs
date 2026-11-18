import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function fixture(t, eol, target = "#a-heading") {
  // Include spaces to exercise file-URL decoding as well as Windows drives.
  const root = mkdtempSync(join(tmpdir(), "opentakeoff doc links "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "docs/wiki", "protocol"]) mkdirSync(join(root, dir), { recursive: true });
  const script = join(root, "scripts/check-doc-links.mjs");
  copyFileSync(new URL("./check-doc-links.mjs", import.meta.url), script);
  writeFileSync(join(root, "README.md"), [
    "# A heading", "", `[Jump](${target})`, "", "```md", "[Example](missing.md)", "```", "",
  ].join(eol));
  return () => execFileSync(process.execPath, [script], { cwd: resolve(root), encoding: "utf8", stdio: "pipe" });
}

for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`documentation anchors resolve with ${label} in a path containing spaces`, (t) => {
    assert.match(fixture(t, eol)(), /doc links OK/);
  });
}

test("a missing anchor still fails the documentation check", (t) => {
  assert.throws(fixture(t, "\r\n", "#missing"), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /dead anchor "#missing"/);
    return true;
  });
});
