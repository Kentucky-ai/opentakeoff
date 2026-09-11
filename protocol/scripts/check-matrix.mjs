import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const marker = /<!--transport-matrix-->[\s\S]*?<!--\/transport-matrix-->/;
export function renderMatrix(rows) {
  const ids = new Set();
  const cell = value => String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  for (const row of rows) {
    if (!/^[a-z][a-z-]+$/.test(row.id) || ids.has(row.id)) throw new Error("Invalid or duplicate compatibility case ID");
    if (!["conforms", "needs-adapter", "unsupported"].includes(row.status) || !row.scope || !row.assertion)
      throw new Error(`Incomplete compatibility case: ${row.id}`);
    ids.add(row.id);
  }
  return ["<!--transport-matrix-->", "| Case | Outcome | Tested boundary | Assertion |", "|---|---|---|---|",
    ...rows.map(r => `| \`${r.id}\` | ${r.status} | ${cell(r.scope)} | ${cell(r.assertion)} |`),
    "<!--/transport-matrix-->"].join("\n");
}
export function refreshMatrix(text, rows) {
  if (!marker.test(text)) throw new Error("Missing transport-matrix block in protocol/COMPATIBILITY.md");
  return text.replace(marker, () => renderMatrix(rows));
}
export function checkMatrix(write = false) {
  const rows = JSON.parse(readFileSync(new URL("test/transport-matrix.json", root), "utf8"));
  const path = new URL("COMPATIBILITY.md", root);
  const current = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const expected = refreshMatrix(current, rows);
  if (current !== expected) {
    if (!write) throw new Error("Protocol transport matrix is stale. Run node protocol/scripts/check-matrix.mjs --write.");
    writeFileSync(path, expected);
  }
  console.log(`Protocol transport matrix matches ${rows.length} executable cases.`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { checkMatrix(process.argv.includes("--write")); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
