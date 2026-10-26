// Writes the #483 PR A characterization goldens for the web reader: one JSON
// file per twin (reader483Fixtures.ts's TWINS) plus the shape controls, into
// web/test/fixtures/reader-483/. Run once, before any reader change
// (reader source == base 7e70bec8), from web/:
//   node --import tsx test/fixtures/capture-reader-483.ts
// The goldens are committed and never edited; reader483Goldens.test.ts
// compares live reads to them.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TWINS, liveTwin, liveControls, GOLDEN_DIR_URL, CONTROLS_GOLDEN, goldenFile } from "./reader483Fixtures.ts";

const dir = fileURLToPath(GOLDEN_DIR_URL);
mkdirSync(dir, { recursive: true });
const write = (file: string, v: unknown) => writeFileSync(dir + file, JSON.stringify(v, null, 2) + "\n");
for (const t of TWINS) write(goldenFile(t.name), liveTwin(t));
write(CONTROLS_GOLDEN, liveControls());
console.log(`wrote ${TWINS.length + 1} goldens to ${dir}`);
