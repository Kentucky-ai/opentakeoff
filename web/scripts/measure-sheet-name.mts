// From web/: node --import tsx scripts/measure-sheet-name.mts 059ffa2
// Optional NODE_V8_COVERAGE=<directory> measures instrumentation overhead too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { densePage } from "../test/denseSheetPage.ts";
import { readSheetNumber as after } from "../src/lib/sheetName.ts";

const baseline = process.argv[2] || "059ffa2";
const temporary = mkdtempSync(join(tmpdir(), "sheet-reader-baseline-"));
try {
  const source = join(temporary, "baseline.ts");
  writeFileSync(source, execFileSync("git", ["show", `${baseline}:web/src/lib/sheetName.ts`]));
  const { readSheetNumber: before } = await import(pathToFileURL(source).href);
  const results = [];
  for (const [n, seed, notes] of [[30000, 1, 0], [30000, 3, 300], [59000, 1, 0]]) {
    const page = densePage(n, seed, notes);
    const expected = before(page);
    const samples: Record<string, number[]> = { before: [], after: [] };
    for (let round = 0; round < 18; round++) {
      const readers = round % 2 ? [["after", after], ["before", before]] as const : [["before", before], ["after", after]] as const;
      for (const [name, read] of readers) {
        const start = performance.now();
        const answer = read(page);
        const elapsed = performance.now() - start;
        assert.equal(answer, expected);
        if (round >= 3) samples[name].push(elapsed);
      }
    }
    const stats = Object.fromEntries(Object.entries(samples).map(([name, times]) => [name, {
      minMs: Math.min(...times), medianMs: times.sort((a, b) => a - b)[7],
    }]));
    results.push({ items: page.items.length, notes, answer: expected, ...stats });
  }
  console.log(JSON.stringify({ baseline, node: process.version, coverage: !!process.env.NODE_V8_COVERAGE, results }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
