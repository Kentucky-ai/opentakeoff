import { schemaBase } from "../src/validation.mjs";
export { protocolRoot, schemaBase, legacyId, draftId, schemas, validator } from "../src/validation.mjs";

export function assertValid(assert, ajv, path, record) {
  const check = ajv.getSchema(schemaBase + path);
  assert.ok(check, `schema exists: ${path}`);
  const before = structuredClone(record);
  assert.equal(check(record), true, JSON.stringify(check.errors, null, 2));
  assert.deepEqual(record, before, "validation must not mutate the record");
}
