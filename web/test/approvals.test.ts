// Approval seals (lib/approvals.js): the pure command layer the shared undo
// stack rides — every command must return the EXACT-restore inverse (deep
// equal, array order included) — plus the load gate, the cover tally, and the
// annotations-payload round-trip. The canvas rendering and the marked-set
// drawing are verified by hand (DOM / pdf-lib bound); everything here is the
// CI-testable surface.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyApprovalCommand, sanitizeApprovals, approvalTally, approvalInk,
  APPROVAL_POLICY, APPROVAL_ACTORS, APPROVAL_R,
} from "../src/lib/approvals.js";
import { localStore, emptyAnnotations } from "../src/lib/store.js";

const seal = (over: Record<string, unknown> = {}) => ({
  id: "apr-a", actor: "estimator", ts: "2026-08-02T00:00:00.000Z",
  sheet_id: "plan.pdf#1", at: [0.5, 0.5], ...over,
});

// ── add ──────────────────────────────────────────────────────────────────────

test("add mints id (apr- prefix) + ts and appends; caller fields carry through", () => {
  const { approvals, inverse } = applyApprovalCommand([], {
    type: "add",
    approvals: [{ actor: "estimator", sheet_id: "plan.pdf#1", at: [0.25, 0.75], shape_id: "shp-1" }],
  });
  assert.equal(approvals.length, 1);
  const a = approvals[0];
  assert.match(a.id, /^apr-/);
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
  assert.equal(a.actor, "estimator");
  assert.equal(a.shape_id, "shp-1");
  assert.deepEqual(a.at, [0.25, 0.75]);
  assert.deepEqual(inverse, { type: "delete", ids: [a.id] });
});

test("add keeps a caller-provided id/ts verbatim (no re-mint)", () => {
  const { approvals } = applyApprovalCommand([], { type: "add", approvals: [seal()] });
  assert.deepEqual(approvals, [seal()]);
});

test("add refuses an unknown actor before anything mints", () => {
  assert.throws(
    () => applyApprovalCommand([], { type: "add", approvals: [{ actor: "intern", sheet_id: "p#1", at: [0, 0] }] }),
    /Unknown approval actor/,
  );
  assert.deepEqual(APPROVAL_ACTORS, ["estimator", "agent"]);
});

test("agent verdicts are first-class records of the same family", () => {
  const { approvals } = applyApprovalCommand([], {
    type: "add",
    approvals: [{ actor: "agent", sheet_id: "plan.pdf#2", at: [0.1, 0.2] }],
  });
  assert.equal(approvals[0].actor, "agent");
});

// ── delete + the undo round-trip ─────────────────────────────────────────────

test("delete of a middle record: the inverse restores the ORIGINAL array verbatim, order included", () => {
  const input = [seal({ id: "apr-a" }), seal({ id: "apr-b", actor: "agent" }), seal({ id: "apr-c" })];
  const del = applyApprovalCommand(input, { type: "delete", ids: ["apr-b"] });
  assert.deepEqual(del.approvals.map((a: any) => a.id), ["apr-a", "apr-c"]);
  const undo = applyApprovalCommand(del.approvals, del.inverse);
  assert.deepEqual(undo.approvals, input);
  // and undo's own inverse re-deletes — redo-of-undo lands where delete did
  const redo = applyApprovalCommand(undo.approvals, undo.inverse);
  assert.deepEqual(redo.approvals, del.approvals);
});

test("add → undo (inverse delete) → back to the input array", () => {
  const input = [seal({ id: "apr-a" })];
  const add = applyApprovalCommand(input, { type: "add", approvals: [{ actor: "agent", sheet_id: "p#1", at: [0, 0] }] });
  const undo = applyApprovalCommand(add.approvals, add.inverse);
  assert.deepEqual(undo.approvals, input);
});

test("input arrays are never mutated", () => {
  const input = [seal()];
  const frozen = JSON.stringify(input);
  applyApprovalCommand(input, { type: "add", approvals: [{ actor: "agent", sheet_id: "p#1", at: [0, 0] }] });
  applyApprovalCommand(input, { type: "delete", ids: ["apr-a"] });
  assert.equal(JSON.stringify(input), frozen);
});

// ── replace + the policy gate ────────────────────────────────────────────────

test("replace is the hydrate non-edit: inverse null, non-array loads as []", () => {
  const rep = applyApprovalCommand([seal()], { type: "replace", approvals: [seal({ id: "apr-z" })] });
  assert.deepEqual(rep.approvals.map((a: any) => a.id), ["apr-z"]);
  assert.equal(rep.inverse, null);
  assert.deepEqual(applyApprovalCommand([seal()], { type: "replace", approvals: undefined }).approvals, []);
});

test("an unknown command type throws — the APPROVAL_POLICY table is the gate", () => {
  assert.throws(() => applyApprovalCommand([], { type: "stamp" }), /Unknown approval command type/);
  for (const t of ["add", "delete", "replace"]) assert.ok(t in APPROVAL_POLICY);
});

// ── load gate ────────────────────────────────────────────────────────────────

test("sanitizeApprovals: non-arrays load as [], junk drops, valid records survive with unknown fields intact", () => {
  assert.deepEqual(sanitizeApprovals(undefined), []);
  assert.deepEqual(sanitizeApprovals({ length: 2 }), []);
  const good = seal({ future_field: "kept" });
  const out = sanitizeApprovals([
    good,
    null,
    "apr-x",
    seal({ id: "" }),                              // no id
    seal({ id: "apr-2", actor: "intern" }),        // unknown actor
    seal({ id: "apr-3", sheet_id: 7 }),            // bad sheet key
    seal({ id: "apr-4", at: [0.1] }),              // bad point
    seal({ id: "apr-5", at: [0.1, NaN] }),         // non-finite point
    seal({ actor: "agent" }),                      // duplicate id — first wins
  ]);
  assert.deepEqual(out, [good]);
});

// ── tally + ink ──────────────────────────────────────────────────────────────

test("approvalTally is zero-filled and counts by actor", () => {
  assert.deepEqual(approvalTally([]), { estimator: 0, agent: 0 });
  assert.deepEqual(approvalTally(undefined), { estimator: 0, agent: 0 });
  const list = [seal(), seal({ id: "apr-b", actor: "agent" }), seal({ id: "apr-c" })];
  assert.deepEqual(approvalTally(list), { estimator: 2, agent: 1 });
});

test("the two actors read in DIFFERENT inks, in both themes", () => {
  for (const dark of [false, true]) {
    assert.notEqual(approvalInk("estimator", dark), approvalInk("agent", dark));
  }
  assert.ok(APPROVAL_R > 0 && APPROVAL_R < 0.1);   // a seal, not a poster
});

// ── persistence round-trip ───────────────────────────────────────────────────

test("approvals ride the annotations payload verbatim; the empty project carries the field", async () => {
  assert.deepEqual(emptyAnnotations().approvals, []);
  const payload = { ...emptyAnnotations(), approvals: [seal(), seal({ id: "apr-b", actor: "agent" })] };
  await localStore.saveAnnotations(payload);
  const back = await localStore.loadAnnotations();
  assert.deepEqual(back.approvals, payload.approvals);
});
