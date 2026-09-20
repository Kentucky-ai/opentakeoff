// Current-facing docs use generated counts. Historical changelog/test reports
// keep their original numbers; they are deliberately outside this allowlist.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES, ALL_TOOL_NAMES, stagesFor } from "../src/staging.ts";

const DOCS = ["../../README.md", "../../FEATURES.md", "../../AGENT_BRIEF.md",
  "../../README.zh-Hans.md", "../../README.ja.md", "../../README.ko.md", "../../README.th.md",
  "../../docs/USER_GUIDE.md", "../README.md", "../../docs/MCP.md", "../../docs/AGENT_GUIDE.md",
].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const RE = /<!--(tool-count(?:-all|-setup)?)-->(\d+)<!--\/\1-->/g;
const counts = { "tool-count": TOOL_NAMES.length, "tool-count-all": ALL_TOOL_NAMES.length,
  "tool-count-setup": stagesFor(false).setup.length };
const write = process.argv.includes("--write");
let stale = 0, seen = 0;
// Release metadata must agree before --write can mutate generated counts. The
// version checker is read-only and deliberately refuses --write repair.
await import("../../scripts/check-version-consistency.mjs");
for (const file of DOCS) {
  const text = readFileSync(file, "utf8");
  const hits = [...text.matchAll(RE)];
  if (!hits.length) { console.error(`${file}: no tool-count marker — the count is not generated there`); process.exitCode = 1; continue; }
  seen += hits.length;
  const wrong = hits.filter((m) => Number(m[2]) !== counts[m[1]]);
  stale += wrong.length;
  if (wrong.length) {
    if (write) writeFileSync(file, text.replace(RE, (_, kind) => `<!--${kind}-->${counts[kind]}<!--/${kind}-->`));
    else { console.error(`${file}: stale count — run npm run check:tool-count -- --write`); process.exitCode = 1; }
  }
  // A correct generated count must not hide a second stale prose claim.
  const unmarked = [...text.replace(RE, "GENERATED").matchAll(/\b\d+ (?:MCP tools|tools|tool schemas)\b/g)];
  if (unmarked.length) {
    console.error(`${file}: ungenerated tool counts: ${unmarked.map(m => m[0]).join(", ")} — mark default/all/setup counts explicitly`);
    process.exitCode = 1;
  }
}
console.log(`${seen} marker(s), ${stale} ${write ? "rewritten" : "stale"}, ${TOOL_NAMES.length} default / ${ALL_TOOL_NAMES.length} gated / ${counts["tool-count-setup"]} setup tools`);
// Run in this process so --write also reaches the schema-backed inventory.
await import("./check-tool-inventory.mjs");
