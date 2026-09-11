import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, linkSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { adaptTakeoff } from "../src/adapters.mjs";
import { legacyId, draftId, validator, assertValid } from "./helpers.mjs";

const fixture = () => ({
  schema: legacyId, project_name: "Synthetic adapter fixture", units: "metric",
  sheets: [{ sheet_id: "sample-plan.pdf", units_per_px: 0.1, scale_confirmed: false }],
  conditions: [{ id: "floor", finish_tag: "F-1" }],
  shapes: [{ id: "room", sheet_id: "sample-plan.pdf", condition_id: "floor", measure_role: "floor_area",
    verts_norm: [[-0.1, 0.1], [0.2, 0.1], [0.2, 1.2]], computed: { area_sf: 100, perimeter_lf: 40 },
    origin: { method: "manual", actor: "agent", reviewed: false, edited: true,
      proposed_verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]],
      evidence: { matched_text: "101", custom: [null, 1, false] } },
    created_at: "2026-09-11T09:00:00-04:00" }],
  condition_edit_proposals: [{ id: "edit", condition_id: "floor", proposed: { waste_pct: 8 } }],
  layer_overrides: { sheet: { hidden: ["notes"] } },
  extension: JSON.parse('{"__proto__":{"retained":true},"constructor":{"prototype":{"retained":true}}}'),
});
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("both adapter directions and same-version calls preserve every JSON value and omission", () => {
  const ajv = validator();
  for (const sourceSchema of [legacyId, draftId]) {
    const record = fixture(); record.schema = sourceSchema;
    const before = JSON.stringify(record); freeze(record);
    for (const target of [draftId, legacyId]) {
      const result = adaptTakeoff(record, target);
      assert.equal(result.status, target === sourceSchema ? "unchanged" : "converted");
      assert.deepEqual(result.document, { ...record, schema: target });
      assert.deepEqual(result.preservation, { checked: true, scope: "json-values-except-schema",
        changedPaths: target === sourceSchema ? [] : ["/schema"], droppedPaths: [] });
      assertValid(assert, ajv, target === legacyId ? "legacy/takeoff-canvas.v1.schema.json" : "v1/takeoff-document.schema.json", result.document);
      const back = adaptTakeoff(result.document, sourceSchema);
      assert.equal(JSON.stringify(back.document), before);
      const again = adaptTakeoff(result.document, target);
      assert.equal(again.status, "unchanged"); assert.deepEqual(again.document, result.document);
      assert.equal(Object.hasOwn(result.document, "approvals"), false);
      assert.equal(Object.hasOwn(result.document.shapes[0].origin, "accepted_ts"), false);
      assert.deepEqual(result.document.conditions, record.conditions, "a proposed condition diff is not applied");
      assert.equal(result.document.shapes[0].created_at, "2026-09-11T09:00:00-04:00");
    }
    assert.equal(JSON.stringify(record), before);
  }
});

test("converted output is detached, with opaque keys retained and no prototype pollution", () => {
  const record = freeze(fixture()), result = adaptTakeoff(record, draftId);
  result.document.shapes[0].origin.proposed_verts_norm[0][0] = 999;
  result.document.layer_overrides.sheet.hidden.push("more");
  result.document.extension.__proto__.retained = false;
  assert.equal(record.shapes[0].origin.proposed_verts_norm[0][0], 0.1);
  assert.deepEqual(record.layer_overrides.sheet.hidden, ["notes"]);
  assert.equal(record.extension.__proto__.retained, true);
  assert.equal(Object.hasOwn(result.document.extension, "__proto__"), true);
  assert.equal({}.retained, undefined);
});

test("legacy count omissions and unavailable original history keep warnings without fabricated data", () => {
  const record = fixture(); record.sheets = [];
  record.shapes[0].measure_role = "count"; record.shapes[0].computed = {};
  delete record.shapes[0].origin.proposed_verts_norm;
  const result = adaptTakeoff(freeze(record), draftId);
  assert.equal(result.status, "converted");
  assert.deepEqual(result.document, { ...record, schema: draftId });
  for (const code of ["legacy_count_default", "original_geometry_unavailable", "authority_not_authenticated"])
    assert.ok(result.preflight.issues.some(i => i.code === code));
  assert.ok(result.preflight.notVerified.includes("history_completeness"));
});

test("both directions refuse unsupported or invalid sources without a converted document", () => {
  const mutations = [
    d => { d.shapes[0].curved = true; },
    d => { d.shapes[0].verts_norm_holes = [[[0, 0], [1, 0], [1, 1]]]; },
    d => { d.shapes[0].origin.cuts_shape_id = "parent"; },
    d => { d.shapes[0].sheet_id = "stitch:join"; },
    ...["rules", "markups", "rfis"].map(key => d => { d[key] = [{}]; }),
    d => { d.sheets = []; },
    d => { delete d.sheets; },
    d => { d.shapes[0].condition_id = "missing"; },
    d => { d.shapes[0].computed.area_sf = -1; },
    d => { d.schema = "future.v2"; },
  ];
  for (const sourceSchema of [legacyId, draftId]) for (const mutate of mutations) {
    const record = fixture(); record.schema = sourceSchema; mutate(record);
    const before = JSON.stringify(record); freeze(record);
    const result = adaptTakeoff(record, sourceSchema === legacyId ? draftId : legacyId);
    assert.equal(result.status, "refused"); assert.equal(result.preservation.checked, false);
    assert.equal(Object.hasOwn(result, "document"), false);
    assert.notEqual(result.preflight.status, "eligible");
    assert.equal(JSON.stringify(record), before);
  }
});

test("unsupported targets and unsafe JavaScript data cannot bypass preflight or execute getters", () => {
  for (const target of [undefined, null, {}, "future.v2"]) {
    const result = adaptTakeoff(freeze(fixture()), target);
    assert.equal(result.status, "refused"); assert.equal(Object.hasOwn(result, "document"), false);
    assert.ok(result.preflight.issues.some(i => i.code === "unsupported_target"));
  }
  let calls = 0;
  const record = fixture(); Object.defineProperty(record, "extension", { enumerable: true, get() { calls++; throw Error("must not run"); } });
  assert.equal(adaptTakeoff(record, draftId).status, "refused"); assert.equal(calls, 0);
  const nonfinite = fixture(); nonfinite.extension = { value: Infinity };
  assert.equal(adaptTakeoff(nonfinite, draftId).status, "refused");
});

const cli = fileURLToPath(new URL("../scripts/adapt.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "ot-adapter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test("CLI round trip writes separate importable files and reports preservation without exposing records", t => {
  const dir = directory(t), input = join(dir, "source.json"), draft = join(dir, "draft.json"), back = join(dir, "back.json");
  const record = fixture(); record.project_name = "PRIVATE_SOURCE_VALUE";
  const originalBytes = JSON.stringify(record, null, 4) + "\n"; writeFileSync(input, originalBytes);
  for (const [target, source, output] of [["draft", input, draft], ["canvas", draft, back], ["canvas", back, join(dir, "same.json")]]) {
    const result = run("--to", target, source, output);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, source === back ? "unchanged" : "converted");
    assert.equal(report.preservation.checked, true); assert.equal(Object.hasOwn(report, "document"), false);
    assert.doesNotMatch(result.stdout, /PRIVATE_SOURCE_VALUE/);
  }
  assert.deepEqual(JSON.parse(readFileSync(back, "utf8")), record);
  assert.equal(readFileSync(input, "utf8"), originalBytes);
  assert.deepEqual(readdirSync(dir).sort(), ["back.json", "draft.json", "same.json", "source.json"]);
});

test("CLI refuses incompatibility before creating output and never overwrites input, files or aliases", t => {
  const dir = directory(t), input = join(dir, "source.json"), output = join(dir, "output.json");
  const bad = fixture(); bad.rules = [{}]; writeFileSync(input, JSON.stringify(bad));
  const refused = run("--to", "draft", input, output);
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stdout).status, "refused");
  assert.equal(existsSync(output), false); assert.deepEqual(JSON.parse(readFileSync(input, "utf8")), bad);
  const bytes = JSON.stringify(fixture()); writeFileSync(input, bytes); writeFileSync(output, "existing output");
  const hard = join(dir, "hard.json"); linkSync(input, hard);
  const aliases = [input, output, hard];
  if (process.platform !== "win32") { const sym = join(dir, "sym.json"); symlinkSync(input, sym); aliases.push(sym); }
  for (const path of aliases) {
    const result = run("--to", "draft", input, path);
    assert.equal(result.status, 2); assert.match(result.stderr, /already exists/);
    assert.equal(result.stdout, "");
  }
  assert.equal(readFileSync(input, "utf8"), bytes); assert.equal(readFileSync(hard, "utf8"), bytes);
  assert.equal(readFileSync(output, "utf8"), "existing output");
  assert.ok(readdirSync(dir).every(name => !name.startsWith(".ot-adapt-")));
});

test("CLI usage, parse, missing input and destination failures return exit 2 without leftover files", t => {
  const dir = directory(t), input = join(dir, "source.json"), output = join(dir, "output.json");
  writeFileSync(input, "{ broken");
  for (const args of [[], ["--to", "future", input, output], ["--to", "draft", input],
    ["--to", "draft", input, output, "extra"], ["--to", "draft", input, output], ["--to", "draft", join(dir, "absent"), output]]) {
    const result = run(...args); assert.equal(result.status, 2); assert.equal(result.stdout, "");
  }
  assert.equal(readFileSync(input, "utf8"), "{ broken");
  writeFileSync(input, JSON.stringify(fixture()));
  assert.equal(run("--to", "draft", input, join(dir, "absent", "out.json")).status, 2);
  assert.deepEqual(readdirSync(dir), ["source.json"]);
});
