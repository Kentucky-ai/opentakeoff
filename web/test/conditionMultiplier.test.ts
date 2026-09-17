// The repeating-unit multiplier as the panel shows it. A multiplier silently
// scales every quantity under a condition, so the invariants are about it
// being SEEN and being safe to type into:
//   - the row chip is absent at ×1 (and for junk), present and explicit above;
//   - the editor field is labelled ("× N units"), singular at 1, and lit
//     cobalt only while it is actually multiplying;
//   - typing never yields less than 1 or a fraction: blanks, zero, negatives
//     and decimals all land on a whole number ≥ 1;
//   - the row's tag holds a floor, so the action cluster wraps under it on a
//     narrow panel instead of squeezing the tag to nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MultiplierChip, MultiplierField, ROW_TAG_MIN_W, ConditionAppearanceEditor } from "../src/components/TakeoffsPanel.jsx";
import { PALETTE, NO_FILL } from "../src/components/hatches.jsx";

const html = (type: any, props: any) => renderToStaticMarkup(React.createElement(type, props));

test("row chip: nothing at ×1, undefined or junk", () => {
  for (const mult of [1, 0, undefined, null, NaN]) assert.equal(html(MultiplierChip, { mult }), "");
});

test("row chip: ×N in cobalt with the consequence spelled out", () => {
  const out = html(MultiplierChip, { mult: 120 });
  assert.match(out, /data-multiplier-chip/);
  assert.match(out, />×<!-- -->120<|>×120</);
  assert.match(out, /multiplied by 120/);
  assert.match(out, /var\(--cobalt\)/);
});

test("editor field: labelled, singular at 1 and unlit", () => {
  const out = html(MultiplierField, { value: 1, onChange: () => {} });
  assert.match(out, /name="condition-multiplier"/);
  assert.match(out, />unit</);
  assert.doesNotMatch(out, /var\(--cobalt\)/);
  assert.match(out, /Duplicate for another area/, "points at the ×1-elsewhere answer");
});

test("editor field: plural and lit while multiplying", () => {
  const out = html(MultiplierField, { value: 120, onChange: () => {} });
  assert.match(out, />units</);
  assert.match(out, /value="120"/);
  assert.match(out, /border:1px solid var\(--cobalt\)/);
});

test("editor field: typing lands on a whole number ≥ 1", () => {
  const got: number[] = [];
  const el: any = (MultiplierField as any)({ value: 1, onChange: (n: number) => got.push(n) });
  const input = React.Children.toArray(el.props.children).find((c: any) => c?.type === "input") as any;
  for (const v of ["120", "", "0", "-4", "2.9", "abc"]) input.props.onChange({ target: { value: v } });
  assert.deepEqual(got, [120, 1, 1, 1, 2, 1]);
});

test("the condition editor renders the labelled field, not a bare ×", () => {
  const cond = { id: "c1", finish_tag: "CPT-1", color: PALETTE[2], fill: NO_FILL, hatch: "solid", multiplier: 120 };
  const noop = () => {};
  const out = html(ConditionAppearanceEditor, { cond, onUpdateCond: noop, onSetCondParam: noop, onAssignAttr: noop, layout: "stack" });
  assert.match(out, /value="120"/);
  assert.match(out, />units</);
});

test("row tag floor fits a real tag with its chip", () => {
  assert.ok(ROW_TAG_MIN_W >= 96 && ROW_TAG_MIN_W <= 140, "wide enough for CPT-12 ×120, not so wide the row always wraps");
});
