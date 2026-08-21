// Project archive (.otk) round-trip — pure zip/manifest machinery (#300), so it
// runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectArchive, parseProjectArchive, isProjectArchive } from "../src/lib/projectArchive.js";

const enc = new TextEncoder();

// deterministic fake plan bytes — content only matters for byte-equality
const planBytes = (tag: string) => enc.encode(`%PDF-1.4 fake ${tag}`);

const TAKEOFF = {
  schema: "opentakeoff.takeoff_canvas.v1",
  project_name: "School Renovation",
  conditions: [{ id: "c1", finish_tag: "CPT-1" }],
  shapes: [{ id: "s1", sheet_id: "A1.pdf", pts: [[0, 0], [1, 0], [1, 1]] }],
  markups: [],
  sheets: [{ sheet_id: "A1.pdf", units_per_px: 0.125 }],
};

async function buildFixture() {
  return buildProjectArchive({
    takeoff: TAKEOFF,
    sheets: [{ name: "A1.pdf" }, { name: "S1.0 plan.pdf" }],
    loadPdfData: async (name: string) => planBytes(name),
    projectName: "School Renovation",
  });
}

test("otk: extension detection", () => {
  assert.equal(isProjectArchive("School-Renovation.otk"), true);
  assert.equal(isProjectArchive("School-Renovation.OTK"), true);
  assert.equal(isProjectArchive("plans.zip"), false);
  assert.equal(isProjectArchive(""), false);
});

test("otk: build → parse round-trips the takeoff verbatim and every plan's bytes", async () => {
  const bytes = await buildFixture();
  const { takeoff, pdfs, projectName } = await parseProjectArchive(bytes);
  // the takeoff document is the EXACT payload in, not an export-only reshaping
  assert.deepEqual(takeoff, TAKEOFF);
  assert.equal(projectName, "School Renovation");
  assert.deepEqual(pdfs.map((f) => f.name).sort(), ["A1.pdf", "S1.0 plan.pdf"]);
  for (const f of pdfs) {
    const got = new Uint8Array(await f.arrayBuffer());
    assert.deepEqual(got, planBytes(f.name), `bytes of ${f.name} survive the round trip`);
  }
});

test("otk: refuses a zip with no manifest (a plain plan-set zip is not a project)", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const plain = zipSync({ "plans/A1.pdf": strToU8("%PDF-1.4") });
  await assert.rejects(() => parseProjectArchive(plain), /isn't an OpenTakeoff project archive/);
});

test("otk: refuses an unknown archive schema loudly instead of half-loading", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const future = zipSync({
    "opentakeoff.project.json": strToU8(JSON.stringify({ schema: "opentakeoff.project_archive.v9", takeoff: {} })),
  });
  await assert.rejects(() => parseProjectArchive(future), /archive version/);
});

test("otk: refuses a manifest with no takeoff document", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const hollow = zipSync({
    "opentakeoff.project.json": strToU8(JSON.stringify({ schema: "opentakeoff.project_archive.v1", plans: [] })),
  });
  await assert.rejects(() => parseProjectArchive(hollow), /no takeoff document/);
});

test("otk: ignores non-plan entries smuggled into the archive", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const mixed = zipSync({
    "opentakeoff.project.json": strToU8(JSON.stringify({ schema: "opentakeoff.project_archive.v1", takeoff: { schema: "x", shapes: [] } })),
    "plans/A1.pdf": strToU8("%PDF-1.4"),
    "plans/evil.html": strToU8("<script>"),
    "unrelated.txt": strToU8("junk"),
  });
  const { pdfs } = await parseProjectArchive(mixed);
  assert.deepEqual(pdfs.map((f) => f.name), ["A1.pdf"]);
});
