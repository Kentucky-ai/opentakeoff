import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// llms.txt is what AI crawlers read about the project. Its tool count must match
// the README's generated marker (checked against the server by check:tool-count).
const marker = /<!--tool-count-->(\d+)<!--\/tool-count-->/;
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");

test("llms.txt tool count matches the README's generated count", () => {
  const want = readme.match(marker)?.[1];
  const got = llms.match(marker)?.[1];
  assert.ok(want, "README has a tool-count marker");
  assert.equal(got, want);
  assert.doesNotMatch(llms.replace(marker, ""), /\b\d+ tools\b/, "no unmarked tool count");
});

test("llms.txt does not advertise the gated One-Click tool as available", () => {
  for (const line of llms.split("\n").filter((l) => /one.click/i.test(l))) {
    assert.match(line, /gated/i, `line mentions One-Click without the gate: ${line}`);
  }
});
