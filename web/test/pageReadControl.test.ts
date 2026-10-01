// The canvas's Read page text control (#471): a pure function of its rows
// (each a sheet and lib/ocr/pageRead's view of it). Rendered to a string for
// what it says, and walked as an element tree to press its buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PageReadControl, { readControlPlacement, READ_CONTROL_LEFT } from "../src/components/PageReadControl.jsx";
import { CANVAS_EDGE, FLOAT_GAP } from "../src/lib/canvasConstants.js";
import type { PageReadView } from "../src/lib/ocr/pageRead.ts";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
type Row = { key: string; label: string; view: PageReadView };

function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (!node || typeof node !== "object") return out;
  const el = node as El;
  if (typeof el.type === "function") return walk((el.type as (p: unknown) => unknown)(el.props), out);
  out.push(el);
  walk(el.props?.children, out);
  return out;
}
const text = (el: El): string => [el.props.children].flat(9).filter((c) => typeof c === "string").join("");

function setup(rows: Row[]) {
  const calls: string[] = [];
  const props = {
    rows,
    onRead: (k: string) => calls.push(`read ${k}`),
    onReadAgain: (k: string) => calls.push(`again ${k}`),
    onCancel: (k: string) => calls.push(`cancel ${k}`),
  };
  const el = React.createElement(PageReadControl as never, props);
  const buttons = walk(el).filter((e) => e.type === "button");
  const press = (label: string, i = 0) => (buttons.filter((b) => text(b) === label)[i].props.onClick as () => void)();
  return { html: renderToStaticMarkup(el), buttons, press, calls };
}

test("nothing to show renders nothing", () => {
  assert.equal(setup([]).html, "");
  assert.equal(setup([{ key: "a", label: "A-1", view: { kind: "hidden" } }]).html, "");
});

test("a sheet with no text layer offers Read page text", () => {
  const t = setup([{ key: "a.pdf", label: "A-1", view: { kind: "read" } }]);
  assert.deepEqual(t.buttons.map(text), ["Read page text"]);
  t.press("Read page text");
  assert.deepEqual(t.calls, ["read a.pdf"]);
  assert.ok(!t.html.includes("A-1"), "one sheet: no label");
});

test("a failure note shows beside Read", () => {
  const t = setup([{ key: "a.pdf", label: "A-1", view: { kind: "read", note: "Couldn't read this page: boom" } }]);
  assert.ok(t.html.includes("Couldn&#x27;t read this page: boom"));
});

test("reading shows the phase and Cancel", () => {
  const t = setup([{ key: "a.pdf", label: "A-1", view: { kind: "reading", text: "Reading tiles 2/6" } }]);
  assert.ok(t.html.includes("Reading tiles 2/6"));
  assert.deepEqual(t.buttons.map(text), ["Cancel"]);
  t.press("Cancel");
  assert.deepEqual(t.calls, ["cancel a.pdf"]);
});

test("stopping shows Stopping… and no buttons", () => {
  const t = setup([{ key: "a.pdf", label: "A-1", view: { kind: "stopping", text: "Stopping…" } }]);
  assert.ok(t.html.includes("Stopping…"));
  assert.equal(t.buttons.length, 0);
});

test("done shows the time and OCR; Read again only when stale", () => {
  const fresh = setup([{ key: "a.pdf", label: "A-1", view: { kind: "done", text: "Read in 4.2 s · OCR", readAgain: false } }]);
  assert.ok(fresh.html.includes("Read in 4.2 s · OCR"));
  assert.equal(fresh.buttons.length, 0);
  const stale = setup([{ key: "a.pdf", label: "A-1", view: { kind: "done", text: "Read in 4.2 s · OCR", readAgain: true } }]);
  stale.press("Read again");
  assert.deepEqual(stale.calls, ["again a.pdf"]);
});

test("a group lists each qualifying sheet by label, and skips the rest", () => {
  const t = setup([
    { key: "a.pdf", label: "A-1", view: { kind: "read" } },
    { key: "a.pdf#2", label: "A-2", view: { kind: "hidden" } },
    { key: "b.pdf", label: "B-1", view: { kind: "reading", text: "Joining seams 1/2" } },
  ]);
  assert.ok(t.html.includes("A-1") && t.html.includes("B-1"));
  assert.ok(!t.html.includes("A-2"));
  t.press("Read page text");
  t.press("Cancel");
  assert.deepEqual(t.calls, ["read a.pdf", "cancel b.pdf"]);
});

test("status text is announced; nothing announced holds a button", () => {
  const t = setup([
    { key: "a.pdf", label: "A-1", view: { kind: "reading", text: "Reading tiles 2/6" } },
    { key: "b.pdf", label: "B-1", view: { kind: "done", text: "Read in 4.2 s · OCR", readAgain: true } },
    { key: "c.pdf", label: "C-1", view: { kind: "read", note: "Couldn't read this page: boom" } },
  ]);
  const el = React.createElement(PageReadControl as never, { rows: [
    { key: "a.pdf", label: "A-1", view: { kind: "reading", text: "Reading tiles 2/6" } },
    { key: "b.pdf", label: "B-1", view: { kind: "done", text: "Read in 4.2 s · OCR", readAgain: true } },
    { key: "c.pdf", label: "C-1", view: { kind: "read", note: "Couldn't read this page: boom" } },
  ], onRead() {}, onReadAgain() {}, onCancel() {} } as never);
  const live = walk(el).filter((e) => e.props["aria-live"]);
  assert.deepEqual(live.map(text), ["Reading tiles 2/6", "Read in 4.2 s · OCR", "Couldn't read this page: boom"]);
  for (const l of live) assert.equal(walk(l.props.children).filter((e) => e.type === "button").length, 0);
  assert.ok(t.html.includes("data-page-read"), "the focus fallback can find it");
});

test("a background row names its sheet in its own text and offers Cancel", () => {
  const t = setup([{ key: "z.pdf", label: "Z-9", view: { kind: "reading", text: "Reading Z-9…" }, background: true } as Row]);
  assert.ok(t.html.includes("Reading Z-9…"));
  t.press("Cancel");
  assert.deepEqual(t.calls, ["cancel z.pdf"]);
});

test("readControlPlacement: beside the corner cluster, above the rule banner while one shows", () => {
  assert.deepEqual(readControlPlacement({ bannerHeight: 0 }), { position: "absolute", left: READ_CONTROL_LEFT, bottom: CANVAS_EDGE });
  assert.deepEqual(readControlPlacement({ bannerHeight: 40 }), { position: "absolute", left: READ_CONTROL_LEFT, bottom: CANVAS_EDGE + 40 + FLOAT_GAP });
  assert.equal(READ_CONTROL_LEFT, CANVAS_EDGE + 34 + 8, "clears the 34 px cluster by its 8 px gap");
});

test("a page that can't be read says why, with no button", () => {
  const t = setup([{ key: "a.pdf", label: "A-1", view: { kind: "unreadable", text: "This page is too large for the on-device text reader (OCR)." } }]);
  assert.deepEqual(t.buttons, []);
  assert.ok(t.html.includes("too large"));
});

test("a reader the probe couldn't reach says so, with Retry", () => {
  let retried = 0;
  const el = React.createElement(PageReadControl as never, {
    rows: [{ key: "a.pdf", label: "A-1", view: { kind: "unreachable", text: "The on-device text reader (OCR) couldn't be reached" } }],
    onRead: () => {}, onReadAgain: () => {}, onCancel: () => {}, onRetry: () => { retried++; },
  });
  const html = renderToStaticMarkup(el);
  assert.match(html, /couldn&#x27;t be reached/);
  const buttons = walk(el).filter((e) => e.type === "button");
  assert.deepEqual(buttons.map(text), ["Retry"]);
  (buttons[0].props.onClick as () => void)();
  assert.equal(retried, 1);
});
