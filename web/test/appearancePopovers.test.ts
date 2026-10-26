import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionAppearanceEditor } from "../src/components/TakeoffsPanel.jsx";
import { PALETTE, NO_FILL } from "../src/components/hatches.jsx";

const cond = { id: "c1", finish_tag: "CPT-1", color: PALETTE[2], fill: NO_FILL, hatch: "solid" };
const noop = () => {};
const render = (layout: string) => renderToStaticMarkup(
  React.createElement(ConditionAppearanceEditor as any, { cond, onUpdateCond: noop, onSetCondParam: noop, onAssignAttr: noop, layout })
);

test("top-bar band (row): Line and Fill are two swatch buttons, palettes closed until clicked", () => {
  const html = render("row");
  assert.match(html, /data-testid="line-swatch"/);
  assert.match(html, /data-testid="fill-swatch"/);
  assert.match(html, /aria-expanded="false"/);
  const swatches = (html.match(/title="#[0-9a-f]{6}"/g) || []).length;
  assert.equal(swatches, 0, "no inline palette swatches in the band");
  assert.match(html, new RegExp(PALETTE[2]), "line swatch carries the current color");
  assert.match(html, /⦸/, "no-fill reads as ⦸ on the fill swatch");
});

test("docked panel (stack): inline palettes stay — it has the room", () => {
  const html = render("stack");
  assert.doesNotMatch(html, /data-testid="line-swatch"/);
  const swatches = (html.match(/title="#[0-9a-f]{6}"/g) || []).length;
  assert.equal(swatches, PALETTE.length * 2, "line + fill palettes inline");
});
