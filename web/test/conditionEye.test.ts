// Condition visibility (#440) — the panel half: the eye that leads a row and
// the hidden-conditions bar. Rendered on their own (the docked panel takes
// dozens of props), and the handlers are called straight off the element so
// the click contract is under test, not just the markup:
//   - the eye reads Hide/Show + the tag, and aria-pressed tracks "showing";
//   - click reports plain vs ⌥ (isolate) and never bubbles to the row, whose
//     own click activates the condition and whose double-click zooms to it;
//   - the bar renders nothing while everything shows, and says N of M with a
//     Show all that fires the callback.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionEye, HiddenConditionsBar } from "../src/components/TakeoffsPanel.jsx";
import { Icon } from "../src/brand/icons.jsx";

const html = (el: any) => renderToStaticMarkup(el);
const evt = (altKey = false) => {
  const e = { altKey, stopped: 0, stopPropagation() { this.stopped += 1; } };
  return e;
};

test("eye on a showing condition: Hide label, pressed, open-eye icon", () => {
  const out = html(React.createElement(ConditionEye as any, { tag: "REC-1", hidden: false, onToggle: () => {} }));
  assert.match(out, /aria-label="Hide REC-1 on the plan"/);
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, /Hiding never changes a quantity/);
  assert.doesNotMatch(out, /<line /, "open eye carries no strike");
});

test("eye on a hidden condition: Show label, not pressed, struck icon, danger fill", () => {
  const out = html(React.createElement(ConditionEye as any, { tag: "REC-1", hidden: true, onToggle: () => {} }));
  assert.match(out, /aria-label="Show REC-1 on the plan"/);
  assert.match(out, /aria-pressed="false"/);
  assert.match(out, /Still counted in totals, report and exports/);
  assert.match(out, /<line /, "struck eye");
  assert.match(out, /background:var\(--c-danger\)/);
});

test("eye click: plain → toggle, ⌥ → isolate, and neither bubbles to the row", () => {
  const calls: boolean[] = [];
  const el: any = (ConditionEye as any)({ tag: "REC-1", hidden: false, onToggle: (iso: boolean) => calls.push(iso) });
  const plain = evt(false), alt = evt(true), dbl = evt();
  el.props.onClick(plain);
  el.props.onClick(alt);
  el.props.onDoubleClick(dbl);
  assert.deepEqual(calls, [false, true]);
  assert.equal(plain.stopped, 1);
  assert.equal(alt.stopped, 1);
  assert.equal(dbl.stopped, 1, "a fast double toggle must not zoom-to");
  assert.equal(calls.length, 2, "double-click itself toggles nothing");
});

test("hidden bar: nothing while everything shows", () => {
  assert.equal(html(React.createElement(HiddenConditionsBar as any, { hidden: 0, total: 9, onShowAll: () => {} })), "");
});

test("hidden bar: N of M, totals-unchanged promise, Show all fires", () => {
  let shown = 0;
  const props = { hidden: 8, total: 9, onShowAll: () => { shown += 1; } };
  const out = html(React.createElement(HiddenConditionsBar as any, props));
  assert.match(out, /role="status"/);
  assert.match(out, /8<!-- --> of <!-- -->9<!-- --> hidden on the plan — totals unchanged|8 of 9 hidden on the plan — totals unchanged/);
  assert.match(out, />Show all</);
  const el: any = (HiddenConditionsBar as any)(props);
  const btn = React.Children.toArray(el.props.children).find((c: any) => c?.type === "button") as any;
  btn.props.onClick();
  assert.equal(shown, 1);
});

test("eye / eyeOff icons render, and differ only by the strike", () => {
  const open = html(React.createElement(Icon as any, { name: "eye", size: 15 }));
  const off = html(React.createElement(Icon as any, { name: "eyeOff", size: 15 }));
  assert.match(open, /<svg/);
  assert.match(open, /<circle /);
  assert.doesNotMatch(open, /<line /);
  assert.match(off, /<line /);
});
