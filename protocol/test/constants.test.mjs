// Parity: the legacy schema the protocol package validates against is the same
// id the app writes and the server stamps — pinned to the shared module rather
// than re-typed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAKEOFF_SCHEMA } from "../../web/src/lib/takeoffConstants.ts";
import { legacyId } from "../src/validation.mjs";

test("legacyId equals the shared takeoff schema id", () => {
  assert.equal(legacyId, TAKEOFF_SCHEMA);
});

test("the legacy JSON schema pins the same id", () => {
  const schema = JSON.parse(readFileSync(new URL("../legacy/takeoff-canvas.v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schema.const, TAKEOFF_SCHEMA);
});
