import { readFile, writeFile, mkdtemp, link, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { adaptTakeoff } from "../src/adapters.mjs";
import { legacyId, draftId } from "../src/validation.mjs";

const [flag, target, input, output, ...extra] = process.argv.slice(2);
if (flag !== "--to" || !["draft", "canvas"].includes(target) || !input || !output || extra.length) {
  console.error("Usage: node protocol/scripts/adapt.mjs --to <draft|canvas> <input.json> <new-output.json>");
  process.exitCode = 2;
} else {
  let record;
  try { record = JSON.parse(await readFile(input, "utf8")); }
  catch {
    console.error("Could not read a JSON takeoff. No output was written.");
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const result = adaptTakeoff(record, target === "draft" ? draftId : legacyId);
    const { document, ...report } = result;
    if (result.status === "refused") {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = 1;
    } else {
      let temporary;
      try {
        // Write completely beside the destination, then link into place. Link
        // creates a new name atomically and refuses any existing destination,
        // including the input, a symlink or a hard link. No overwrite fallback.
        const destination = resolve(output);
        temporary = await mkdtemp(join(dirname(destination), ".ot-adapt-"));
        const staged = join(temporary, "takeoff.json");
        await writeFile(staged, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
        await link(staged, destination);
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } catch (error) {
        console.error(error.code === "EEXIST"
          ? "Output already exists. Choose a new output file; existing files were not overwritten."
          : "Could not create the converted file. The destination directory must exist and support hard links.");
        process.exitCode = 2;
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {
          console.error("Could not remove the temporary adapter directory; inspect the destination directory.");
          process.exitCode = 2;
        });
      }
    }
  }
}
