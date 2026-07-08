import { test } from "node:test";
import assert from "node:assert/strict";
// coverage.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { materialKind, MATERIAL_PRESETS, GROUT_DEFAULTS, groutCoverageSfPerBag } from "../src/lib/coverage.js";

const within = (actual: number, expected: number, tolPct: number) =>
  Math.abs(actual - expected) <= expected * (tolPct / 100);

// 12×24 tile, 3/8″ thick, 1/8″ joint — the classic large-format wall/floor case.
const BASE = { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125 };

test("grout coverage: known vectors for a 12×24×3/8″ tile @ 1/8″ joint", () => {
  const sf10 = groutCoverageSfPerBag({ ...BASE, bagLbs: 10 });
  const sf25 = groutCoverageSfPerBag({ ...BASE, bagLbs: 25 });
  assert.ok(within(sf10, 207, 2), `10 lb bag → ${sf10} SF, expected ≈207 ±2%`);
  assert.ok(within(sf25, 518, 2), `25 lb bag → ${sf25} SF, expected ≈518 ±2%`);
});

test("grout coverage: halving the joint exactly doubles coverage (and vice versa)", () => {
  const at = (joint: number) => groutCoverageSfPerBag({ ...BASE, joint, bagLbs: 25 });
  assert.equal(at(1 / 32), 2 * at(1 / 16));   // 1/32″ vs 1/16″ → exactly 2×
  assert.equal(at(0.5), at(0.25) / 2);        // 1/2″ vs 1/4″ → exactly half
});

test("grout coverage: strictly decreasing as the joint widens", () => {
  const joints = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 3 / 8, 1 / 2];
  const cov = joints.map((joint) => groutCoverageSfPerBag({ ...BASE, joint, bagLbs: 25 }));
  for (let i = 1; i < cov.length; i++) {
    assert.ok(cov[i] < cov[i - 1], `coverage must fall: joint ${joints[i]} → ${cov[i]} !< ${cov[i - 1]}`);
  }
});

test("grout coverage: any non-positive parameter → 0, never NaN/Infinity", () => {
  const good = { ...GROUT_DEFAULTS };
  for (const key of ["tileL", "tileW", "tileT", "joint", "bagLbs"] as const) {
    assert.equal(groutCoverageSfPerBag({ ...good, [key]: 0 }), 0, `${key}=0`);
    assert.equal(groutCoverageSfPerBag({ ...good, [key]: -1 }), 0, `${key}=-1`);
  }
});

test("grout defaults round to the CT-1 seed rate (512 SF/bag)", () => {
  assert.equal(Math.round(groutCoverageSfPerBag(GROUT_DEFAULTS)), 512);
});

test("materialKind: name regex classifies mortar / grout / adhesive", () => {
  assert.equal(materialKind({ name: "Thin-set" }), "mortar");
  assert.equal(materialKind({ name: "Grout" }), "grout");
  assert.equal(materialKind({ name: "Cove base adhesive" }), "adhesive");
});

test("materialKind: an explicit kind wins over the name", () => {
  assert.equal(materialKind({ name: "Grout", kind: "mortar" }), "mortar");
});

test("materialKind: unknown names (and empty input) → \"\"", () => {
  assert.equal(materialKind({ name: "Polyurethane (2K finish)" }), "");
  assert.equal(materialKind({}), "");
  assert.equal(materialKind(undefined), "");
});

test("presets: every kind with a preset table has positive generic rates", () => {
  for (const [kind, list] of Object.entries(MATERIAL_PRESETS)) {
    assert.ok((list as any[]).length > 0, kind);
    for (const p of list as any[]) {
      assert.ok(p.label && p.per > 0, `${kind}: ${p.label}`);
    }
  }
});
