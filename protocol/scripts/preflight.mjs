import { readFile } from "node:fs/promises";
import { preflightTakeoff } from "../src/preflight.mjs";

if (process.argv.length !== 3) {
  console.error("Usage: node protocol/scripts/preflight.mjs <takeoff.json>");
  process.exitCode = 2;
} else {
  let record;
  try {
    record = JSON.parse(await readFile(process.argv[2], "utf8"));
  } catch {
    console.error("Could not read a JSON takeoff. The input file was not changed.");
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const report = preflightTakeoff(record);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.status === "eligible" ? 0 : 1;
  }
}
