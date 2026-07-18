// Provenance primitives (lib/provenance.js) — id minting and the edit stamp.
// The invariants:
//   - mintUuid: unique per call; without crypto.randomUUID (plain-HTTP LAN
//     self-host) it falls back to a time+random token, never throws;
//   - stampEdit: pure (never mutates its input); every shape gets updated_at;
//     a machine-origin shape gets origin.edited + a per-kind origin.edits
//     bump, and the FIRST edit freezes origin.proposed_verts_norm from the
//     PRE-edit verts_norm as a deep copy; manual/no-origin shapes get
//     updated_at and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintUuid, nowIso, stampEdit } from "../src/lib/provenance.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A committed one-click shape as the canvas mints it (subset of fields).
const machineShape = () => ({
  id: "shp-1", sheet_id: "a.pdf#1", condition_id: "cnd-1", measure_role: "floor_area",
  verts_norm: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4]],
  computed: { area_sf: 100, perimeter_lf: 40 },
  origin: { method: "one_click_v1", seed_norm: [0.3, 0.2], reviewed: true },
});

// ── mintUuid ─────────────────────────────────────────────────────────────────

test("mintUuid: unique across many calls", () => {
  const seen = new Set(Array.from({ length: 1000 }, () => mintUuid()));
  assert.equal(seen.size, 1000);
});

test("mintUuid: falls back to time+random shape when crypto.randomUUID is absent", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    const a = mintUuid();
    // `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    assert.match(a, /^[0-9a-z]+-[0-9a-z]+$/);
    assert.notEqual(a, mintUuid());
  } finally {
    Object.defineProperty(globalThis, "crypto", desc);
  }
  assert.match(mintUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // restored → real UUID again
});

// ── nowIso ───────────────────────────────────────────────────────────────────

test("nowIso: ISO-8601 UTC", () => {
  assert.match(nowIso(), ISO);
});

// ── stampEdit ────────────────────────────────────────────────────────────────

test("stampEdit: first edit of a machine shape freezes proposed_verts_norm from the PRE-edit verts (deep copy)", () => {
  const s = machineShape();
  const preVerts = s.verts_norm.map((v) => [...v]);
  const out = stampEdit(s, "vertex");
  assert.deepEqual(out.origin.proposed_verts_norm, preVerts);
  // deep copy — mutating the live ring must not reach into the frozen trace
  out.verts_norm[0][0] = 0.99;
  s.verts_norm[1][1] = 0.77;
  assert.deepEqual(out.origin.proposed_verts_norm, preVerts);
  assert.equal(out.origin.edited, true);
  assert.deepEqual(out.origin.edits, { vertex: 1 });
  assert.match(out.updated_at, ISO);
});

test("stampEdit: later edits bump per-kind counts and never re-freeze", () => {
  const first = stampEdit(machineShape(), "vertex");
  const frozen = first.origin.proposed_verts_norm;
  first.verts_norm = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.5]];   // geometry moved since the freeze
  const second = stampEdit(first, "vertex");
  const third = stampEdit(second, "move");
  assert.deepEqual(third.origin.edits, { vertex: 2, move: 1 });
  assert.deepEqual(third.origin.proposed_verts_norm, frozen); // still the FIRST pre-edit ring
});

test("stampEdit: manual origin gets updated_at and nothing else", () => {
  const s = { ...machineShape(), origin: { method: "manual" } };
  const out = stampEdit(s, "reassign");
  assert.match(out.updated_at, ISO);
  assert.deepEqual(out.origin, { method: "manual" });         // no edited, no edits, no freeze
  const { updated_at: _u, ...rest } = out;
  const { updated_at: _u2, ...restIn } = s as Record<string, unknown>;
  assert.deepEqual(rest, restIn);                             // every other field rides through untouched
});

test("stampEdit: no origin at all — updated_at only", () => {
  const { origin: _o, ...bare } = machineShape();
  const out = stampEdit(bare, "edge");
  assert.match(out.updated_at, ISO);
  assert.equal("origin" in out, false);
});

test("stampEdit: pure — the input shape (and its origin) are not mutated", () => {
  const s = machineShape();
  const snapshot = structuredClone(s);
  stampEdit(s, "edge");
  assert.deepEqual(s, snapshot);
});
