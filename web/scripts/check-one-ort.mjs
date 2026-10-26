// One onnxruntime-web for the whole app (#469).
//
// Voice (@huggingface/transformers) and on-device OCR (ppu-paddle-ocr) share
// one ORT runtime, so the app ships a single ~24 MB wasm. package.json pins
// onnxruntime-web to the exact version transformers declares and overrides
// every copy to it. The override would also hide a transformers bump that
// moves its pin, so this check compares the installed tree with the pin.
//
//   node scripts/check-one-ort.mjs
//
// It fails unless every onnxruntime-web in the tree is one version, that
// version equals transformers' declared dependency, and npm reports no
// problem at all (no missing or invalid copy, no entry in problems[]).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "onnxruntime-web";

/** Pure: an `npm ls <PKG> --all --json` tree and the transformers pin →
 *  { ok, versions, errors }. */
export function analyze(lsJson, transformersPin) {
  const versions = new Set();
  const errors = [];
  const walk = (deps, path) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      const here = `${path} > ${name}`;
      if (name === PKG) {
        if (node.missing) errors.push(`${here}: missing (wants ${node.required ?? "?"})`);
        if (node.invalid) errors.push(`${here}: invalid (${node.invalid})`);
        if (node.version) versions.add(node.version);
      }
      walk(node.dependencies, here);
    }
  };
  walk(lsJson?.dependencies, lsJson?.name ?? "root");
  for (const p of lsJson?.problems ?? []) errors.push(`npm: ${p}`);
  const list = [...versions].sort();
  if (list.length === 0) errors.push(`${PKG} is not installed`);
  else if (list.length > 1) errors.push(`${list.length} versions of ${PKG} installed: ${list.join(", ")}`);
  else if (list[0] !== transformersPin) errors.push(`${PKG} ${list[0]} differs from the transformers pin ${transformersPin}`);
  return { ok: errors.length === 0, versions: list, errors };
}

function main() {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tf = JSON.parse(readFileSync(join(web, "node_modules/@huggingface/transformers/package.json"), "utf8"));
  const pin = tf.dependencies?.[PKG];
  // npm ls exits non-zero when it finds a problem; the JSON on stdout is
  // still complete, and analyze() reports the problem itself.
  const ls = spawnSync("npm", ["ls", PKG, "--all", "--json"], { cwd: web, encoding: "utf8", shell: process.platform === "win32" });
  if (!ls.stdout) {
    console.error(`npm ls produced no output: ${ls.stderr || ls.error}`);
    process.exit(1);
  }
  const r = analyze(JSON.parse(ls.stdout), pin);
  if (!r.ok) {
    for (const e of r.errors) console.error(`check-one-ort: ${e}`);
    if (r.errors.some((e) => !e.startsWith("npm: "))) console.error(`Set onnxruntime-web in package.json to transformers' pin (${pin}) and reinstall.`);
    if (r.errors.some((e) => e.startsWith("npm: "))) console.error("Reinstall (npm ci) and fix what `npm ls` reports.");
    process.exit(1);
  }
  console.log(`check-one-ort: one ${PKG} (${r.versions[0]}), matching the transformers pin.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
