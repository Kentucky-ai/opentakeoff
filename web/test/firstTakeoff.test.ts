// The guided first takeoff (lib/firstTakeoff.js): steps complete on the real
// action, in order, and never un-complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOUR_STEPS, countFloorShapes, advanceTour, currentStep, cardPlacement, stepBody } from "../src/lib/firstTakeoff.js";

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

test("the card lifts above a bottom-docked tool rail it would cover", () => {
  // the hosted demo at 1423x835: rail docked bottom from x 289..1134, top 735
  const p = cardPlacement({ side: "bottom", left: 289, right: 1134, top: 735 }, 835, 78);
  assert.equal(p.bottom, 835 - 735 + 10);
  assert.equal(p.side, "bottom");
});

test("the card keeps its corner when the rail is docked left or doesn't reach it", () => {
  assert.equal(cardPlacement({ side: "left", left: 0, right: 64, top: 100 }, 800, 78).bottom, 38);
  assert.equal(cardPlacement({ side: "bottom", left: 600, right: 1100, top: 700 }, 800, 78).bottom, 38);
  assert.equal(cardPlacement(null, 800).bottom, 38);
});

test("step 3 names where the tool rail actually is", () => {
  const tool = TOUR_STEPS.find((s) => s.id === "tool");
  assert.match(stepBody(tool, "bottom"), /tool rail along the bottom/);
  assert.match(stepBody(tool, "left"), /tool rail on the left/);
  assert.doesNotMatch(stepBody(tool, "bottom"), /on the left/);
  const scale = TOUR_STEPS.find((s) => s.id === "scale")!;
  assert.equal(stepBody(scale, "bottom"), scale.body);
});
