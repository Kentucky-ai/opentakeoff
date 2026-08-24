import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "src/pages/TakeoffCanvas.jsx",
  "src/components/ReportPanel.jsx",
  "src/components/RollPanel.jsx",
  "src/components/TakeoffsPanel.jsx",
  "src/main.jsx",
  "src/lib/markedset.js",
  "src/lib/revisions.js",
  "src/lib/rfi.js",
  "src/lib/totals.js",
  "src/lib/xlsx.js",
];

test("user-facing message sinks do not contain direct English literals", () => {
  const violations: string[] = [];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (/setCommitMsg\((?:["'`])[^"'`]+|window\.prompt\((?:["'`])[^"'`]+/.test(line)) {
        violations.push(`${relative}:${index + 1}:${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `hardcoded user-facing messages:\n${violations.join("\n")}`);
});
