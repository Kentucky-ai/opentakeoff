import { readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const marker = /<!--schema-reference-->[\s\S]*?<!--\/schema-reference-->/;

function fields(schema, prefix = "") {
  const result = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key;
    result.push(name);
    result.push(...fields(value, name + "."));
    if (value.items && typeof value.items === "object") result.push(...fields(value.items, name + "[]."));
  }
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    result.push(...fields(definition, `$defs.${name}.`));
  }
  return result;
}

export function renderReference(schemas) {
  const rows = schemas.map(({ path, schema }) => {
    // The digest catches changes to constraints, descriptions and references,
    // not only additions to the visible field list. It is a docs freshness key,
    // not a signature or takeoff-integrity claim.
    const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 12);
    const names = fields(schema).map((name) => `\`${name}\``).join(", ") || "Through referenced definitions";
    return `| [${schema.title}](${path}) | ${names} | \`${digest}\` |`;
  });
  return ["<!--schema-reference-->", "| Schema | Declared fields | Schema digest |", "|---|---|---|", ...rows, "<!--/schema-reference-->"].join("\n");
}

export function refreshReference(text, schemas) {
  if (!marker.test(text)) throw new Error("protocol/README.md is missing the schema-reference block");
  return text.replace(marker, () => renderReference(schemas));
}

export function checkDocs(write = false) {
  const schemas = ["legacy", "v1"].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, root)).filter((name) => name.endsWith(".schema.json")).sort()
      .map((name) => ({ path: `${dir}/${name}`, schema: JSON.parse(readFileSync(new URL(`${dir}/${name}`, root), "utf8")) })),
  );
  const path = new URL("README.md", root);
  const current = readFileSync(path, "utf8");
  const expected = refreshReference(current, schemas);
  if (current !== expected) {
    if (!write) throw new Error("Protocol schema reference is stale. Run node protocol/scripts/check-docs.mjs --write and review the diff.");
    writeFileSync(path, expected);
  }
  console.log(`Protocol documentation matches ${schemas.length} schema files.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { checkDocs(process.argv.includes("--write")); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
