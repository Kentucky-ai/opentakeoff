import assert from "node:assert/strict";
import test from "node:test";

import { familyCases, gateCases } from "./hatchPolicyReferenceCorpus.js";
import {
  analyzeLineFamilies,
  classifyLineFamily,
  fitNormalOffsetLattice,
  gateTransparentRetry,
  proposeLineFamilies,
} from "../src/lib/hatchPolicyReference.js";

test("normal-offset fit recovers pitch and phase with a missing row", () => {
  const segments = [10, 20, 30, 50, 60, 70].map((x, index) => ({
    id: `s${index}`,
    x1: x,
    y1: 0,
    x2: x,
    y2: 100,
    strokeWidth: 1,
  }));
  const fit = fitNormalOffsetLattice(segments);
  assert.ok(fit);
  assert.ok(Math.abs(fit.pitch - 10) < 1e-6);
  assert.equal(fit.rowCount, 6);
  assert.equal(fit.occupancy, 6 / 7);
  assert.equal(fit.inlierRate, 1);
});

test("lattice evidence survives translation, scale, order, endpoint reversal, and row splitting", () => {
  const base = [10, 20, 30, 40, 50, 60, 70].map((x, index) => ({
    id: `s${index}`, x1: x, y1: 0, x2: x, y2: 100, strokeWidth: 1,
  }));
  const variants = [
    base.map((segment) => ({
      ...segment,
      id: `translated-${segment.id}`,
      x1: segment.x1 + 10000,
      x2: segment.x2 + 10000,
      y1: segment.y1 - 5000,
      y2: segment.y2 - 5000,
    })),
    base.map((segment) => ({
      ...segment,
      id: `small-${segment.id}`,
      x1: segment.x1 * 0.1,
      x2: segment.x2 * 0.1,
      y1: segment.y1 * 0.1,
      y2: segment.y2 * 0.1,
    })),
    base.map((segment) => ({
      ...segment,
      id: `large-${segment.id}`,
      x1: segment.x1 * 1000,
      x2: segment.x2 * 1000,
      y1: segment.y1 * 1000,
      y2: segment.y2 * 1000,
    })),
    base.slice().reverse().map((segment) => ({
      ...segment,
      id: `reversed-${segment.id}`,
      x1: segment.x2,
      y1: segment.y2,
      x2: segment.x1,
      y2: segment.y1,
    })),
    base.flatMap((segment) => Array.from({ length: 5 }, (_, part) => ({
      ...segment,
      id: `split-${segment.id}-${part}`,
      y1: part * 20,
      y2: (part + 1) * 20,
    }))),
  ];
  const expectedScales = [1, 0.1, 1000, 1, 1];
  variants.forEach((segments, index) => {
    const fit = fitNormalOffsetLattice(segments);
    assert.ok(fit, `variant ${index}`);
    assert.ok(Math.abs(fit.pitch - 10 * expectedScales[index]) < 1e-6, `variant ${index}`);
    assert.equal(fit.rowCount, 7, `variant ${index}`);
    assert.equal(fit.rowInlierRate, 1, `variant ${index}`);
  });
});

test("synthetic family cases produce the declared conservative labels", () => {
  for (const fixture of familyCases) {
    const proposals = proposeLineFamilies(fixture.segments, fixture.options);
    if (fixture.expectedLabel === null) {
      assert.equal(proposals.length, 0, fixture.name);
      continue;
    }
    assert.ok(proposals.length > 0, `${fixture.name}: expected a family proposal`);
    const decisions = proposals.map(
      (family) => classifyLineFamily(family, fixture.context, fixture.options),
    );
    assert.ok(
      decisions.every((decision) => decision.label === fixture.expectedLabel),
      `${fixture.name}: got ${decisions.map((decision) => decision.label).join(", ")}`,
    );
  }
});

test("the same periodic rows change label when native provenance is present", () => {
  const plain = {
    segments: [10, 20, 30, 40, 50, 60, 70].map((x, index) => ({
      id: `plain-${index}`, x1: x, y1: 0, x2: x, y2: 100, strokeWidth: 1,
    })),
    context: {},
  };
  const native = familyCases.find((fixture) => fixture.name === "native-hatch");
  assert.ok(native);
  const plainDecision = classifyLineFamily(proposeLineFamilies(plain.segments)[0], plain.context);
  const nativeDecision = classifyLineFamily(
    proposeLineFamilies(native.segments, native.options)[0],
    native.context,
    native.options,
  );
  assert.equal(plainDecision.label, "uncertain");
  assert.equal(plainDecision.testable, false);
  assert.equal(nativeDecision.label, "hatch");
  assert.deepEqual(nativeDecision.reasons, ["native-hatch-provenance"]);
});

test("cross-connected grids are not silently suppressed", () => {
  const fixture = familyCases.find((row) => row.name === "ceiling-grid-without-provenance");
  assert.ok(fixture);
  const decisions = proposeLineFamilies(fixture.segments)
    .map((family) => classifyLineFamily(family, fixture.context));
  assert.ok(decisions.length >= 2);
  assert.ok(decisions.every((decision) => decision.label === "uncertain"));
  assert.ok(decisions.every((decision) => decision.testable === false));
});

test("analysis reports every segment not assigned to a fitted family", () => {
  const fixture = familyCases.find((row) => row.name === "stair-treads");
  assert.ok(fixture);
  const analysis = analyzeLineFamilies(fixture.segments, fixture.options);
  const assigned = new Set(analysis.proposals.flatMap((proposal) => proposal.memberIds));
  const unassigned = new Set(analysis.unassignedIds);
  assert.equal(assigned.size + unassigned.size, fixture.segments.length);
  for (const segment of fixture.segments) {
    assert.notEqual(assigned.has(segment.id), unassigned.has(segment.id));
  }
});

test("retry gate keeps strict output unless every declared budget passes", () => {
  for (const fixture of gateCases) {
    const outcome = gateTransparentRetry(fixture);
    assert.equal(outcome.action, fixture.expectedAction, fixture.name);
    assert.equal(outcome.strict, fixture.strict, fixture.name);
    assert.equal(outcome.retry, fixture.retry, fixture.name);
    assert.equal(
      outcome.selected,
      fixture.expectedAction === "accept-transparent-retry" ? fixture.retry : fixture.strict,
      fixture.name,
    );
  }
});

test("an uncertain family cannot trigger transparency", () => {
  const strict = gateCases[0].strict;
  const outcome = gateTransparentRetry({
    decision: { label: "uncertain", confidence: 0.9, testable: true },
    strict,
  });
  assert.equal(outcome.action, "keep-strict");
  assert.equal(outcome.selected, strict);
});

test("retry gate rejects missing topology metrics and room merges", () => {
  const fixture = gateCases[0];
  const missing = gateTransparentRetry({
    decision: fixture.decision,
    strict: fixture.strict,
    retry: { status: "ok" },
  });
  assert.equal(missing.action, "keep-strict");
  assert.ok(missing.reasons.some((reason) => reason.startsWith("retry-missing-")));

  const mergeStrict = {
    ...fixture.strict,
    assignedSeedIds: ["room-a", "room-c"],
    roomBySeed: { "room-a": "strict-a", "room-c": "strict-c" },
  };
  const mergeRetry = {
    ...fixture.retry,
    assignedSeedIds: ["room-a", "room-c", "room-b"],
    roomBySeed: { "room-a": "retry-merged", "room-c": "retry-merged", "room-b": "retry-b" },
  };
  const merged = gateTransparentRetry({ decision: fixture.decision, strict: mergeStrict, retry: mergeRetry });
  assert.equal(merged.action, "keep-strict");
  assert.ok(merged.reasons.includes("room-merge"));

  const lostRecovery = {
    ...fixture.retry,
    assignedSeedIds: ["room-a"],
    trappedSeedIds: [],
    roomBySeed: { "room-a": "retry-a" },
  };
  const lost = gateTransparentRetry({
    decision: fixture.decision,
    strict: fixture.strict,
    retry: lostRecovery,
  });
  assert.equal(lost.action, "keep-strict");
  assert.ok(lost.reasons.includes("trapped-seed-not-recovered"));
});

test("provenance must belong to a separately trusted extractor group", () => {
  const fixture = familyCases.find((row) => row.name === "native-hatch");
  assert.ok(fixture);
  const proposal = proposeLineFamilies(fixture.segments)[0];
  assert.equal(classifyLineFamily(proposal).label, "uncertain");
});

test("a caller-authored native role cannot forge trusted provenance", () => {
  const proposal = proposeLineFamilies(familyCases[0].segments)[0];
  assert.ok(proposal);
  assert.equal(classifyLineFamily({ ...proposal, nativeRole: "hatch" }).label, "uncertain");
});

test("trusted proposals cannot be mutated after provenance validation", () => {
  const fixture = familyCases.find((row) => row.name === "native-hatch");
  assert.ok(fixture);
  const proposal = proposeLineFamilies(fixture.segments, fixture.options)[0];
  assert.ok(proposal);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.memberIds), true);
  assert.equal(Reflect.set(proposal, "memberIds", ["forged-wall"]), false);
  assert.equal(Reflect.set(proposal.memberIds, "0", "forged-wall"), false);
  assert.equal(Reflect.set(proposal, "score", 0), false);
  assert.equal(classifyLineFamily(proposal).label, "hatch");
});

test("retry gate rejects a recovered seed merged into an existing room", () => {
  const fixture = gateCases[0];
  const retry = {
    ...fixture.retry,
    roomBySeed: { "room-a": "retry-a", "room-b": "retry-a" },
  };
  const outcome = gateTransparentRetry({ decision: fixture.decision, strict: fixture.strict, retry });
  assert.equal(outcome.action, "keep-strict");
  assert.ok(outcome.reasons.includes("room-merge"));
});

test("retry gate rejects zero-area and shrinking retries", () => {
  const fixture = gateCases[0];
  for (const area of [0, fixture.strict.area - 1]) {
    const retry = { ...fixture.retry, area };
    const outcome = gateTransparentRetry({ decision: fixture.decision, strict: fixture.strict, retry });
    assert.equal(outcome.action, "keep-strict");
    assert.ok(outcome.reasons.includes("area-regression"));
  }
});

test("retry gate rejects out-of-range and internally inconsistent metrics", () => {
  const fixture = gateCases[0];
  const invalidRuns = [
    { ...fixture.retry, area: -1 },
    { ...fixture.retry, coverage: 1.1 },
    { ...fixture.retry, wallEdgeFraction: -0.1 },
    { ...fixture.retry, invalidPolygonCount: -1 },
    { ...fixture.retry, invalidPolygonCount: 0.5 },
    { ...fixture.retry, errorCount: 0.5 },
    { ...fixture.retry, status: "" },
    { ...fixture.retry, trapped: "no" },
    { ...fixture.retry, assignedSeedIds: ["room-a", "room-a", "room-b"] },
    { ...fixture.retry, assignedSeedIds: ["room-a", "room-b"], trappedSeedIds: ["room-b"] },
  ];
  for (const retry of invalidRuns) {
    const outcome = gateTransparentRetry({ decision: fixture.decision, strict: fixture.strict, retry });
    assert.equal(outcome.action, "keep-strict");
    assert.ok(outcome.reasons.some((reason) => reason.startsWith("retry-")));
  }
});

test("invalid inputs fail closed", () => {
  assert.throws(
    () => fitNormalOffsetLattice([{ id: "bad", x1: 0, y1: 0, x2: NaN, y2: 1 }]),
    /must be finite/,
  );
  assert.throws(() => classifyLineFamily(null), /family is required/);
  assert.throws(() => gateTransparentRetry({}), /required/);
  assert.throws(
    () => proposeLineFamilies([
      { id: "same", x1: 0, y1: 0, x2: 1, y2: 0 },
      { id: "same", x1: 0, y1: 1, x2: 1, y2: 1 },
    ]),
    /duplicate segment id/,
  );
  const strict = gateCases[0].strict;
  const invalidConfidence = gateTransparentRetry({
    decision: { label: "hatch", testable: true, confidence: NaN },
    strict,
  });
  assert.equal(invalidConfidence.action, "keep-strict");
  assert.throws(
    () => gateTransparentRetry(
      { decision: { label: "hatch", testable: true, confidence: 1 }, strict },
      { minDecisionConfidence: NaN },
    ),
    /between 0 and 1/,
  );
});
