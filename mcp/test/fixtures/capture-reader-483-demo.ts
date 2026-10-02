// Writes the #483 PR A characterization goldens for the demo and tracked
// fixtures' marquee reads (reader483Reads.ts's DEMO_READS): one JSON file per
// read into mcp/test/fixtures/reader-483/. Run once, before any reader
// change (reader source == base 7e70bec8), from mcp/:
//   node --import tsx test/fixtures/capture-reader-483-demo.ts
// The goldens are committed and never edited; scheduleImport.test.ts's #483
// block compares live reads to them.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_READS, DEMO_GOLDEN_DIR_URL, liveDemoRead } from "./reader483Reads.ts";

const dir = fileURLToPath(DEMO_GOLDEN_DIR_URL);
mkdirSync(dir, { recursive: true });
for (const d of DEMO_READS) writeFileSync(`${dir}${d.name}.json`, JSON.stringify({ name: d.name, page: d.page, rect: d.rect, ...(await liveDemoRead(d)) }, null, 2) + "\n");
console.log(`wrote ${DEMO_READS.length} goldens to ${dir}`);
