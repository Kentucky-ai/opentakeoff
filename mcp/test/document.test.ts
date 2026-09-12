// The server writes the takeoff document with the app's own writer. These
// tests pin what that buys: the app's reader lands the server's export
// losslessly, a fresh session reproduces it, and the envelope follows the
// app's conventions rather than a second hand-built one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import { importTakeoff } from "../src/importing.ts";
import { TAKEOFF_DOCUMENT_KEYS, buildTakeoffDocument } from "../../web/src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../../web/src/lib/importTakeoff.js";
import { emptyAnnotations } from "../../web/src/lib/store.js";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function worked() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 0.5 });
  s.measurePolygon(KEY, [[100, 100], [400, 100], [400, 300], [100, 300]], { condition: "CPT-1", role: "floor_area" });
  s.measurePolygon(KEY, [[500, 100], [700, 100], [700, 300], [500, 300]], { condition: "VCT-1", role: "floor_area" });
  return s;
}

test("no hand-built envelope remains in mcp/src", () => {
  const src = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
  assert.equal(src.split("buildTakeoffDocument(").length - 1, 1);
  assert.equal(/sheet_group:\s*\[\]/.test(src), false, "navigation keys come from the writer, not a literal");
});

test("envelope: the app's key order and conventions", async () => {
  const s = await worked();
  const p = s.exportPayload();
  const keys = Object.keys(p);
  assert.ok(keys.every((k) => TAKEOFF_DOCUMENT_KEYS.includes(k)), "no key the app does not write");
  assert.deepEqual(keys, TAKEOFF_DOCUMENT_KEYS.filter((k) => keys.includes(k)), "keys in the app's order");
  assert.equal("units" in p, false, "imperial omits units");
  assert.deepEqual(p.rfis, []);
  assert.equal(p.sheets[0].scale_confirmed, false, "agent-set scale rides as unconfirmed");
  assert.deepEqual(buildTakeoffDocument(p), p, "the writer is idempotent over the server's document");
});

test("a server-minted condition is field-identical to the canvas's, created_at included", async () => {
  const s = await worked();
  const c = s.exportPayload().conditions[0];
  assert.deepEqual(Object.keys(c).sort(), ["color", "created_at", "fill", "finish_tag", "hatch", "id", "materials", "multiplier", "waste_pct"]);
  assert.ok(!Number.isNaN(Date.parse(c.created_at!)), "ISO-8601 mint time");
  assert.ok(c.created_at!.endsWith("Z"));
});

test("the app's reader lands the server's document losslessly, and a fresh session reproduces it", async () => {
  const s = await worked();
  const p = s.exportPayload();
  const landed = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(JSON.stringify(p)), [KEY]).payload;
  assert.deepEqual(landed.conditions, p.conditions);
  assert.deepEqual(landed.shapes, p.shapes);
  assert.deepEqual(landed.sheets, p.sheets);
  const dir = mkdtempSync(join(tmpdir(), "ot-doc-"));
  const file = join(dir, "export.json");
  writeFileSync(file, JSON.stringify(p));
  const s2 = new Session();
  await s2.loadPlan(PLAN);
  await importTakeoff(s2, file);
  assert.deepEqual(s2.exportPayload(), p, "byte-for-byte the same document from a fresh process");
});
