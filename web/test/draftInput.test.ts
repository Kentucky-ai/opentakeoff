// Draft-buffered numeric input decision rules (lib/draftInput.js) — the pure
// core of GroutParamInput, extracted so the commit/clamp behavior that made
// the joint field typeable again (round-1 fix) is pinned without a DOM:
//   - typing commits ONLY a fully valid in-range positive value; anything
//     else commits nothing and the last good committed value stands;
//   - blur clamps a positive out-of-range value into [min, max] and ABANDONS
//     an empty/invalid draft (null), so a committed value can never be
//     invalid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftCommitValue, blurCommitValue, blurCommitNonNegative } from "../src/lib/draftInput.js";

// the joint field's range — the case that used to be untypeable
const MIN = 0.03125, MAX = 0.5;

test("draftCommitValue: a valid in-range draft commits its parsed value", () => {
  assert.equal(draftCommitValue("0.125", MIN, MAX), 0.125);
  assert.equal(draftCommitValue("0.5", MIN, MAX), 0.5);      // inclusive max
  assert.equal(draftCommitValue("0.03125", MIN, MAX), 0.03125);   // inclusive min
  assert.equal(draftCommitValue("12", 0), 12);               // no max
  assert.equal(draftCommitValue("2.5", 0), 2.5);
});

test("draftCommitValue: transient keystrokes commit NOTHING (typing '0.125' char by char)", () => {
  // every prefix of "0.125" until it's in range must be a no-commit — this is
  // exactly what made the joint field untypeable when onChange clamped
  assert.equal(draftCommitValue("0", MIN, MAX), null);
  assert.equal(draftCommitValue("0.", MIN, MAX), null);      // parseFloat("0.") = 0, not > 0
  assert.equal(draftCommitValue("0.1", MIN, MAX), 0.1);      // in range already — live re-derive kicks in
  assert.equal(draftCommitValue("0.12", MIN, MAX), 0.12);
  assert.equal(draftCommitValue("0.125", MIN, MAX), 0.125);
});

test("draftCommitValue: empty, non-numeric, non-positive, out-of-range → null", () => {
  for (const t of ["", ".", "-", "abc", "0", "-1", "0.01", "0.7", "NaN"]) {
    assert.equal(draftCommitValue(t, MIN, MAX), null, JSON.stringify(t));
  }
});

test("draftCommitValue: leading zeros parse, they don't invalidate", () => {
  assert.equal(draftCommitValue("0.25", MIN, MAX), 0.25);
  assert.equal(draftCommitValue("00.25", MIN, MAX), 0.25);   // parseFloat tolerates it
});

test("blurCommitValue: clamps a positive out-of-range draft into [min, max]", () => {
  assert.equal(blurCommitValue("0.7", MIN, MAX), MAX);       // above max → max
  assert.equal(blurCommitValue("0.01", MIN, MAX), MIN);      // below min → min
  assert.equal(blurCommitValue("5", MIN, MAX), MAX);
  assert.equal(blurCommitValue("0.125", MIN, MAX), 0.125);   // in range passes through
  assert.equal(blurCommitValue("7", 0), 7);                  // no max: unclamped above
});

test("blurCommitValue: abandons an empty/invalid/non-positive draft (null — last good value redisplays)", () => {
  for (const t of ["", ".", "-", "abc", "0", "0.", "-3", null, undefined]) {
    assert.equal(blurCommitValue(t as any, MIN, MAX), null, JSON.stringify(t));
  }
});

// round-3 finding 5: LibDraftInput (the Materials tab's per field) had no
// abandon rule — clearing the field and blurring committed 0 through
// libEntryPatch, whose perChanged detach destroyed the entry's tile geometry
// and note with no undo. blurCommitNonNegative is its blur gate: abandon
// empty/unparseable, commit anything parseable clamped non-negative.

test("blurCommitNonNegative: abandons an empty/unparseable draft (null — last good value redisplays)", () => {
  for (const t of ["", ".", "-", "abc", "NaN", null, undefined]) {
    assert.equal(blurCommitNonNegative(t as any), null, JSON.stringify(t));
  }
});

test("blurCommitNonNegative: an intentional 0 typed as \"0\" still commits; positives pass; negatives clamp to 0", () => {
  assert.equal(blurCommitNonNegative("0"), 0);       // unlike blurCommitValue, 0 is a legal library per
  assert.equal(blurCommitNonNegative("0."), 0);
  assert.equal(blurCommitNonNegative("512"), 512);
  assert.equal(blurCommitNonNegative("2.49"), 2.49);
  assert.equal(blurCommitNonNegative("007"), 7);
  assert.equal(blurCommitNonNegative("-5"), 0);      // the input's min — matches the field's Math.max(0, …) commit
});

test("committed values can never be invalid: whatever either helper returns is in range", () => {
  const texts = ["", "0", "0.", "0.0001", "0.03125", "0.1", "0.5", "0.51", "9", "-2", "abc", "1e-9", "1e9"];
  for (const t of texts) {
    for (const v of [draftCommitValue(t, MIN, MAX), blurCommitValue(t, MIN, MAX)]) {
      if (v != null) assert.ok(v >= MIN && v <= MAX && Number.isFinite(v), `${JSON.stringify(t)} → ${v}`);
    }
  }
});
