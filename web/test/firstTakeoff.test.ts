// The guided first takeoff (lib/firstTakeoff.js): steps complete on the real
// action, in order, and never un-complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOUR_STEPS, countFloorShapes, advanceTour, currentStep } from "../src/lib/firstTakeoff.js";

const idle = { sheetOpen: false, scaled: false, tool: "select", floorShapes: 0, reportOpen: false };

test("a fresh tour starts on Open a plan", () => {
  assert.equal(currentStep([])?.id, "open");
  assert.deepEqual(advanceTour([], idle, 0), []);
});

test("each real action completes its step, in order", () => {
  let done: string[] = [];
  done = advanceTour(done, { ...idle, sheetOpen: true }, 0);
  assert.equal(currentStep(done)?.id, "scale");
  done = advanceTour(done, { ...idle, sheetOpen: true, scaled: true }, 0);
  assert.equal(currentStep(done)?.id, "tool");
  done = advanceTour(done, { ...idle, sheetOpen: true, scaled: true, tool: "area" }, 0);
  assert.equal(currentStep(done)?.id, "trace");
  done = advanceTour(done, { ...idle, sheetOpen: true, scaled: true, tool: "area", floorShapes: 1 }, 0);
  assert.equal(currentStep(done)?.id, "report");
  done = advanceTour(done, { ...idle, sheetOpen: true, scaled: true, floorShapes: 1, reportOpen: true }, 0);
  assert.equal(currentStep(done), null);
  assert.deepEqual(done, TOUR_STEPS.map((s) => s.id));
});

test("Rectangle counts as arming a floor tool", () => {
  const done = advanceTour(["open", "scale"], { ...idle, sheetOpen: true, scaled: true, tool: "rect" }, 0);
  assert.equal(currentStep(done)?.id, "trace");
});

test("steps never un-complete when the canvas moves on", () => {
  const done = ["open", "scale", "tool", "trace"];
  // back to Select, report closed — nothing regresses, same array returned
  assert.equal(advanceTour(done, { ...idle, sheetOpen: true, scaled: true, floorShapes: 1 }, 0), done);
});

test("shapes that existed before the tour don't count as the trace", () => {
  const done = advanceTour(["open", "scale", "tool"], { ...idle, sheetOpen: true, scaled: true, tool: "area", floorShapes: 3 }, 3);
  assert.equal(currentStep(done)?.id, "trace");
});

test("opening the Report before tracing doesn't complete it", () => {
  const done = advanceTour(["open", "scale"], { ...idle, sheetOpen: true, scaled: true, reportOpen: true }, 0);
  assert.ok(!done.includes("report"));
});

test("a trace proves the steps before it", () => {
  const done = advanceTour([], { ...idle, sheetOpen: true, scaled: true, floorShapes: 1 }, 0);
  assert.equal(currentStep(done)?.id, "report");
});

test("countFloorShapes skips cut-outs and shapes with no area", () => {
  const shapes = [
    { computed: { area_sf: 120 } },
    { computed: { area_sf: 40 }, measure_role: "deduct" },
    { computed: { perimeter_lf: 30 } },
    { computed: { area_sf: 0 } },
    {},
  ];
  assert.equal(countFloorShapes(shapes), 1);
  assert.equal(countFloorShapes(undefined), 0);
});
