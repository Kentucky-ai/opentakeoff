// Tests for standardScalesForUnits — the pure filter that selects
// Imperial vs metric standard scales without mutating STANDARD_SCALES.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { standardScalesForUnits, STANDARD_SCALES } from "../src/lib/sheets";

describe("standardScalesForUnits", () => {
  const metricScales = standardScalesForUnits("metric");
  const imperialScales = standardScalesForUnits("imperial");

  // ── Imperial excludes metric ratio labels (1:NNN) ──────────────────────
  it("imperial excludes metric ratio labels", () => {
    for (const s of metricScales) {
      assert.ok(
        !imperialScales.some((e) => e.label === s.label),
        `Imperial list must not contain metric label "${s.label}"`
      );
    }
  });

  it("imperial includes architectural labels (contain \")", () => {
    const archLabels = imperialScales.filter((s) => s.label.includes('"'));
    assert.ok(archLabels.length > 0, "Imperial should have architectural scales");
    for (const s of archLabels) {
      assert.ok(s.label.includes("="), `Architectural label "${s.label}" should contain "="`);
    }
  });

  it("imperial includes engineering labels (1\" = N')", () => {
    const engLabels = imperialScales.filter(
      (s) => /^1"\s*=\s*\d+'/.test(s.label)
    );
    assert.ok(engLabels.length > 0, "Imperial should have engineering scales");
  });

  // ── Metric excludes architectural/engineering labels ────────────────────
  it("metric excludes architectural and engineering labels", () => {
    for (const s of imperialScales) {
      assert.ok(
        !metricScales.some((e) => e.label === s.label),
        `Metric list must not contain imperial label "${s.label}"`
      );
    }
  });

  it("metric includes only 1:NNN ratio labels", () => {
    assert.ok(metricScales.length > 0, "Metric should have scales");
    for (const s of metricScales) {
      assert.match(
        s.label,
        /^1:\d+$/,
        `Metric label "${s.label}" should match 1:NNN pattern`
      );
    }
  });

  // ── No mutation ────────────────────────────────────────────────────────
  it("does not mutate STANDARD_SCALES", () => {
    const before = STANDARD_SCALES.map((s) => s.label);
    standardScalesForUnits("metric");
    standardScalesForUnits("imperial");
    const after = STANDARD_SCALES.map((s) => s.label);
    assert.deepEqual(after, before, "STANDARD_SCALES should not be mutated");
  });

  it("returns new array references each call (no shared mutable state)", () => {
    const a = standardScalesForUnits("metric");
    const b = standardScalesForUnits("metric");
    assert.notEqual(a, b, "Each call should return a fresh array");
    // Same contents
    assert.deepEqual(
      a.map((s) => s.label),
      b.map((s) => s.label),
      "Fresh arrays should have identical contents"
    );
  });

  // ── Expected entry counts ──────────────────────────────────────────────
  it("metric returns exactly the 1:NNN entries from STANDARD_SCALES", () => {
    const expected = STANDARD_SCALES.filter((s) => /^1:\d+$/.test(s.label));
    assert.equal(metricScales.length, expected.length);
    for (const s of expected) {
      assert.ok(metricScales.some((e) => e.label === s.label), `Missing metric: "${s.label}"`);
    }
  });

  it("imperial returns all non-metric entries from STANDARD_SCALES", () => {
    const expected = STANDARD_SCALES.filter((s) => !/^1:\d+$/.test(s.label));
    assert.equal(imperialScales.length, expected.length);
    for (const s of expected) {
      assert.ok(imperialScales.some((e) => e.label === s.label), `Missing imperial: "${s.label}"`);
    }
  });

  // ── upp values preserved ───────────────────────────────────────────────
  it("preserves upp values from STANDARD_SCALES", () => {
    for (const s of metricScales) {
      const canon = STANDARD_SCALES.find((c) => c.label === s.label);
      assert.ok(canon, `Metric scale "${s.label}" should exist in STANDARD_SCALES`);
      assert.equal(s.upp, canon.upp, `upp for "${s.label}" should match`);
    }
    for (const s of imperialScales) {
      const canon = STANDARD_SCALES.find((c) => c.label === s.label);
      assert.ok(canon, `Imperial scale "${s.label}" should exist in STANDARD_SCALES`);
      assert.equal(s.upp, canon.upp, `upp for "${s.label}" should match`);
    }
  });

  // ── Union covers all of STANDARD_SCALES ────────────────────────────────
  it("imperial + metric union equals STANDARD_SCALES", () => {
    const union = [...imperialScales, ...metricScales].map((s) => s.label).sort();
    const all = STANDARD_SCALES.map((s) => s.label).sort();
    assert.deepEqual(union, all, "Union of filtered sets should cover STANDARD_SCALES");
  });
});
