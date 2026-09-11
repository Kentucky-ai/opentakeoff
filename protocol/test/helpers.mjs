import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const protocolRoot = new URL("../", import.meta.url);
export const schemaBase = "https://opentakeoff.kentucky-ai.com/protocol/";
export const legacyId = "opentakeoff.takeoff_canvas.v1";
export const draftId = "opentakeoff.takeoff-document.v1";
export const schemas = ["v1", "legacy"].flatMap((dir) =>
  readdirSync(new URL(`${dir}/`, protocolRoot)).filter((name) => name.endsWith(".schema.json"))
    .map((name) => ({ path: `${dir}/${name}`, schema: JSON.parse(readFileSync(new URL(`${dir}/${name}`, protocolRoot), "utf8")) })),
);

export function validator() {
  // Required properties can be defined through allOf/$ref. No coercion,
  // default insertion, removal, or network schema loading is enabled.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  addFormats(ajv);
  schemas.forEach(({ schema }) => ajv.addSchema(schema));
  return ajv;
}

export function assertValid(assert, ajv, path, record) {
  const check = ajv.getSchema(schemaBase + path);
  assert.ok(check, `schema exists: ${path}`);
  const before = structuredClone(record);
  assert.equal(check(record), true, JSON.stringify(check.errors, null, 2));
  assert.deepEqual(record, before, "validation must not mutate the record");
}
