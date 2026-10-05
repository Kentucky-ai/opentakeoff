// Writes the synthetic hybrid sheet (#489, test/fixtures/hybridPlan.ts) to
// disk, for the browser checks and the replay capture: hybrid-plan.pdf (2
// callouts over the picture, the sheet the read is offered on) and
// hybrid-plan-notes.pdf (9 note lines over it, no offer). Not committed:
// the tests build the same bytes in memory.
//   node --import tsx scripts/write-hybrid-fixture.ts <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildHybridPlan } from "../test/fixtures/hybridPlan.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node --import tsx scripts/write-hybrid-fixture.ts <out-dir>");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
for (const [name, variant] of [["hybrid-plan.pdf", "callouts"], ["hybrid-plan-notes.pdf", "notes"]] as const) {
  const bytes = await buildHybridPlan(variant);
  const file = resolve(join(dir, name));
  writeFileSync(file, bytes);
  console.log(`wrote ${file} (${bytes.length} bytes)`);
}
