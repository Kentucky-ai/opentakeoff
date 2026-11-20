// Rebuild the safe UI example using the repository's existing public PDF.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildProjectArchive, parseProjectArchive } from "../../../web/src/lib/projectArchive.js";
const takeoff = JSON.parse(await fs.readFile(process.argv[3] || new URL("./sample.takeoff.json", import.meta.url), "utf8"));
const pdf = new Uint8Array(await fs.readFile(new URL("../../../demo/sample-finish-plan.pdf", import.meta.url)));
const archive = await buildProjectArchive({ takeoff, sheets: [{ name: "sample-finish-plan.pdf" }], loadPdfData: async () => pdf, projectName: takeoff.project_name });
assert.deepEqual((await parseProjectArchive(archive)).takeoff, takeoff);
const output = process.argv[2] || fileURLToPath(new URL("./bulk-review-example.otk", import.meta.url));
await fs.writeFile(output, archive);
console.log(`Wrote ${output}: ${takeoff.shapes.length} entries, ${takeoff.shapes.filter(s => s.origin?.reviewed === false).length} pending. Reviewed fixture states are synthetic test data.`);
