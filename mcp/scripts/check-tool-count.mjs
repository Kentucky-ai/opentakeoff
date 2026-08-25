// The README's tool count is generated, not typed (issue: it rotted at "40"
// while the server registered 42). Every `<!--tool-count-->N<!--/tool-count-->`
// marker in the docs below must equal TOOL_NAMES.length — the same constant
// tools.test, staging.test and smoke-dist read. `--write` rewrites them;
// without it, a stale number fails (CI runs the check form).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/staging.ts";

const DOCS = ["../../README.md", "../../docs/USER_GUIDE.md"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const RE = /<!--tool-count-->(\d+)<!--\/tool-count-->/g;
const want = String(TOOL_NAMES.length);
const write = process.argv.includes("--write");
let stale = 0, seen = 0;
for (const file of DOCS) {
  const text = readFileSync(file, "utf8");
  const hits = [...text.matchAll(RE)];
  if (!hits.length) { console.error(`${file}: no tool-count marker — the count is not generated there`); process.exitCode = 1; continue; }
  seen += hits.length;
  const wrong = hits.filter((m) => m[1] !== want);
  if (!wrong.length) continue;
  stale += wrong.length;
  if (write) writeFileSync(file, text.replace(RE, `<!--tool-count-->${want}<!--/tool-count-->`));
  else console.error(`${file}: says ${[...new Set(wrong.map((m) => m[1]))].join("/")} tools, the server registers ${want} — run \`npm run check:tool-count -- --write\``);
}
if (stale && !write) process.exitCode = 1;
console.log(`${seen} marker(s), ${stale} ${write ? "rewritten" : "stale"}, TOOL_NAMES.length = ${want}`);
