// sourceTrace.ts — pure helpers behind the ◎ source-trace mechanism
// (Captures slice 3): rectMidpoint (the trace's centering anchor) and
// pendingSourceOutcome (the pendingSourceRef staleness guard — the plan's
// "riskiest mechanism", since pendingSourceRef carries no markup id to
// re-validate against). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { rectMidpoint, pendingSourceOutcome, MAX_SOURCE_TRACE_ATTEMPTS } from "../src/lib/sourceTrace.ts";

// ── rectMidpoint ─────────────────────────────────────────────────────────────
test("rectMidpoint: normal rect → average of the two corners", () => {
  assert.deepEqual(rectMidpoint([[0.2, 0.3], [0.6, 0.7]]), [0.4, 0.5]);
});

test("rectMidpoint: order-independent — swapped corners give the same midpoint", () => {
  const a = rectMidpoint([[0.2, 0.3], [0.6, 0.7]]);
  const b = rectMidpoint([[0.6, 0.7], [0.2, 0.3]]);
  assert.deepEqual(a, b);
});

test("rectMidpoint: a degenerate rect (both corners equal) → that point", () => {
  assert.deepEqual(rectMidpoint([[0.5, 0.5], [0.5, 0.5]]), [0.5, 0.5]);
});

test("rectMidpoint: malformed shapes → null, never throw", () => {
  assert.equal(rectMidpoint(null), null);
  assert.equal(rectMidpoint(undefined), null);
  assert.equal(rectMidpoint([]), null);
  assert.equal(rectMidpoint([[0, 0]]), null);                 // only one corner
  assert.equal(rectMidpoint([[0, 0], [1, 1], [2, 2]]), null); // three corners
  assert.equal(rectMidpoint([[0, 0], [1]]), null);            // short corner
  assert.equal(rectMidpoint(["a", "b"]), null);                // corners aren't arrays
  assert.equal(rectMidpoint([[0, 0], [1, "x"]]), null);        // non-numeric coordinate
  assert.equal(rectMidpoint([[0, 0], [1, Infinity]]), null);   // non-finite coordinate
  assert.equal(rectMidpoint([[NaN, 0], [1, 1]]), null);        // NaN coordinate
});

// ── pendingSourceOutcome ─────────────────────────────────────────────────────
const ref = (attempts: number) => ({ sheet_id: "A.pdf", rect: [[0, 0], [1, 1]] as [[number, number], [number, number]], token: 1, attempts });

test("pendingSourceOutcome: null ref → null (nothing to decide)", () => {
  assert.equal(pendingSourceOutcome(null, { status: "ready", sheetIsLive: true, panelReady: true }), null);
});

test("pendingSourceOutcome: status===\"error\" → give-up, even if the panel looks ready", () => {
  assert.deepEqual(
    pendingSourceOutcome(ref(0), { status: "error", sheetIsLive: true, panelReady: true }),
    { action: "give-up" },
  );
});

test("pendingSourceOutcome: sheet no longer resolves to a real sheet → give-up, even mid-ready", () => {
  assert.deepEqual(
    pendingSourceOutcome(ref(0), { status: "ready", sheetIsLive: false, panelReady: true }),
    { action: "give-up" },
  );
});

test("pendingSourceOutcome: ready + panel bitmap present → complete", () => {
  assert.deepEqual(
    pendingSourceOutcome(ref(3), { status: "ready", sheetIsLive: true, panelReady: true }),
    { action: "complete" },
  );
});

test("pendingSourceOutcome: still loading (not ready, or ready but no bitmap yet) → wait, attempts increments", () => {
  assert.deepEqual(
    pendingSourceOutcome(ref(0), { status: "loading", sheetIsLive: true, panelReady: false }),
    { action: "wait", attempts: 1 },
  );
  assert.deepEqual(
    pendingSourceOutcome(ref(4), { status: "ready", sheetIsLive: true, panelReady: false }),
    { action: "wait", attempts: 5 },
  );
});

test("pendingSourceOutcome: attempt budget — one below the cap still waits, reaching the cap gives up", () => {
  assert.deepEqual(
    pendingSourceOutcome(ref(MAX_SOURCE_TRACE_ATTEMPTS - 2), { status: "loading", sheetIsLive: true, panelReady: false }),
    { action: "wait", attempts: MAX_SOURCE_TRACE_ATTEMPTS - 1 },
  );
  assert.deepEqual(
    pendingSourceOutcome(ref(MAX_SOURCE_TRACE_ATTEMPTS - 1), { status: "loading", sheetIsLive: true, panelReady: false }),
    { action: "give-up" },
  );
});

test("pendingSourceOutcome: never left pending on a terminal status — every non-wait outcome is either give-up or complete", () => {
  const statuses = ["loading", "ready", "error"];
  for (const status of statuses) {
    for (const sheetIsLive of [true, false]) {
      for (const panelReady of [true, false]) {
        const out = pendingSourceOutcome(ref(0), { status, sheetIsLive, panelReady });
        assert.ok(out !== null, "a non-null ref must always produce a decision");
        assert.ok(out.action === "give-up" || out.action === "wait" || out.action === "complete");
        // the terminal cases (give-up/complete) must never carry stale wait bookkeeping
        if (out.action !== "wait") assert.equal("attempts" in out, false);
      }
    }
  }
});
