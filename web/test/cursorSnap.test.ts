// One rule for Snap's endpoint pull (lib/cursorSnap.ts): the canvas's preview
// (moveCrosshair: crosshair, box corner, snap star, "snap" chip) and its click
// both ask snapsToVectors, so with Snap on a tool's previewed corner is the
// corner it places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapsToVectors } from "../src/lib/cursorSnap.js";

test("selection boxes place the raw cursor: import, image, pin, Copy text, Select", () => {
  for (const tool of ["schedule", "image", "pin", "textcopy", "select"])
    assert.equal(snapsToVectors(tool), false, tool);
});

test("drawing tools and the Symbol marquee still snap", () => {
  for (const tool of ["area", "rect", "linear", "surface", "count", "deduct", "calibrate", "check", "symbol"])
    assert.equal(snapsToVectors(tool), true, tool);
});
