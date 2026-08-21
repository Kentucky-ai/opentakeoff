// Estimator profile (.otprofile) — the pure parse/validate gate (#299). The
// store-backed halves (buildProfile/applyProfile) ride IndexedDB and are
// exercised in the running app; what node can hold is the file-format door:
// what gets in, what is refused, and how it is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfile, isProfileFile, PROFILE_SCHEMA } from "../src/lib/profile.js";

test("otprofile: extension detection", () => {
  assert.equal(isProfileFile("John-ABC-Construction.otprofile"), true);
  assert.equal(isProfileFile("SETUP.OTPROFILE"), true);
  assert.equal(isProfileFile("takeoff.json"), false);
  assert.equal(isProfileFile(""), false);
});

test("otprofile: a well-formed v1 profile parses through", () => {
  const p = parseProfile(JSON.stringify({
    schema: PROFILE_SCHEMA,
    name: "John — ABC Construction",
    condition_templates: [],
    material_library: [],
  }));
  assert.equal(p.name, "John — ABC Construction");
});

test("otprofile: refuses non-JSON, non-objects, and unknown schemas loudly", () => {
  assert.throws(() => parseProfile("not json {"), /isn't valid JSON/);
  assert.throws(() => parseProfile('"a string"'), /not a profile file/);
  assert.throws(() => parseProfile("[1,2]"), /not a profile file/);
  assert.throws(() => parseProfile(JSON.stringify({ schema: "opentakeoff.profile.v9" })), /version/);
  assert.throws(() => parseProfile(JSON.stringify({ conditions: [] })), /version/);
});
