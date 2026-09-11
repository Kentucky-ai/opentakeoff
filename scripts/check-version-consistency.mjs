// Check published MCP metadata and the independently versioned web package.
// This checker is intentionally read-only: --write never repairs agreement
// because a release version is an explicit maintainer decision.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const fields = [
  ["mcp/package.json version", "mcp/package.json", (json) => json.version],
  ["mcp/package-lock.json top-level version", "mcp/package-lock.json", (json) => json.version],
  ["mcp/package-lock.json root package version", "mcp/package-lock.json", (json) => json.packages?.[""]?.version],
  ["mcp/server.json version", "mcp/server.json", (json) => json.version],
  ["mcp/server.json packages[0].version", "mcp/server.json", (json) => json.packages?.[0]?.version],
  ["web/.well-known/mcp.json version", "web/public/.well-known/mcp.json", (json) => json.version],
  ["web/.well-known/mcp.json packages[0].version", "web/public/.well-known/mcp.json", (json) => json.packages?.[0]?.version],
];
const webFields = [
  ["web/package.json version", "web/package.json", (json) => json.version],
  ["web/package-lock.json top-level version", "web/package-lock.json", (json) => json.version],
  ["web/package-lock.json root package version", "web/package-lock.json", (json) => json.packages?.[""]?.version],
];

function checkAgreement(group, label) {
  const values = group.map(([name, path, get]) => ({ name, path, value: get(readJson(path)) }));
  const missing = values.filter(({ value }) => typeof value !== "string" || !value);
  const expected = values[0]?.value;
  const mismatches = values.filter(({ value }) => value !== expected);
  if (missing.length || mismatches.length) {
    for (const field of missing) console.error(`::error file=${field.path}::${label} field ${field.name} is missing or not a string (got ${JSON.stringify(field.value)})`);
    for (const field of (mismatches.length ? values : [])) console.error(`::error file=${field.path}::${label} mismatch: ${field.name}=${JSON.stringify(field.value)}; expected ${JSON.stringify(expected)}`);
    return false;
  }
  console.log(`${label} version agreement: ${expected} (${values.length} fields)`);
  return true;
}

const ok = checkAgreement(fields, "MCP published") && checkAgreement(webFields, "web package");
if (!ok) {
  if (process.argv.includes("--write")) console.error("--write is refused for version mismatches; update each named release field explicitly.");
  throw new Error("version agreement check failed");
}
