// The row→symbol ruler (scripts/graph-eval.mjs, metric 3) on the synthetic
// equipment fixture: every keyed mark resolves, the never-drawn one refuses,
// and a phantom or a miss would show up as such. Runs the real script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("graph-eval rowsym: 5/5 resolved, 1/1 refused, counts reported with their method", () => {
  const corpus = fileURLToPath(new URL("./fixtures/eval-corpus", import.meta.url));
  const script = fileURLToPath(new URL("../scripts/graph-eval.mjs", import.meta.url));
  // the script reports on stdout at a terminal and on stderr under a pipe —
  // read both, the ruler's text is what is asserted
  const r = spawnSync(process.execPath, ["--import", "tsx", script, corpus], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const out = r.stdout + r.stderr;
  assert.match(out, /row → symbol/);
  const lines = out.split("\n");
  const hdr = lines.findIndex((l) => l.includes("row → symbol"));
  const line = lines.slice(hdr).find((l) => l.startsWith("mep-set"))!;
  assert.ok(line, out);
  assert.match(line, /^mep-set\s+6\s+100\.0%\s+100\.0%\s+0\s+0/);
  // every keyed mark resolves to exactly the drawn count; the method is disclosed
  // (L = by label). EBB-2 is a longer bar than EBB-1 — geometry cannot reach it.
  for (const c of ["EBB-1:1→1", "EBB-2:1→1L", "EBB-3:1→1", "EF-1:1→1L", "SR-1:1→1"]) assert.ok(line.includes(c), `${c} in ${line}`);
  // the never-drawn material code refused — no phantom
  assert.doesNotMatch(line, /CPT-1/);
});
