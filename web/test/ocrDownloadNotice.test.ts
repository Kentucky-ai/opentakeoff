// OcrDownloadNotice (#469): the one-time notice before on-device OCR
// downloads its files. Rendered to a string for the copy and attributes, and
// walked as an element tree to press its buttons and keys (the component is a
// pure function of its props, so no DOM is needed). The repo has no DOM test
// setup, so focus is pinned by the props that drive it (autoFocus, and the
// key that remounts Cancel), not by document.activeElement.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OcrDownloadNotice, { formatMB, announcedPct, noticeKeyDown } from "../src/components/OcrDownloadNotice.jsx";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(OcrDownloadNotice as never, props));

/** Every element in a tree (expanding function components). */
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (!node || typeof node !== "object") return out;
  const el = node as El;
  if (typeof el.type === "function") return walk((el.type as (p: unknown) => unknown)(el.props), out);
  out.push(el);
  walk(el.props?.children, out);
  return out;
}
/** An element's own string children (the buttons' labels). */
const text = (el: El): string => [el.props.children].flat(9).filter((c) => typeof c === "string").join("");
const buttons = (props: Record<string, unknown>) =>
  walk(React.createElement(OcrDownloadNotice as never, props)).filter((e) => e.type === "button");

test("says up to how many MB, from the raw download size", () => {
  // The staged manifest's total (det + rec + dict + runtime wasm).
  const html = render({ downloadBytes: 36_243_408, progress: null, onDownload() {}, onCancel() {} });
  assert.match(html, /up to 36\.3 MB/);
  assert.equal(formatMB(36_200_000), "36.2 MB");
  assert.equal(formatMB(1_417), "0.1 MB");
});

test("says what downloads, where the files come from, where they're kept, and where the read runs", () => {
  const html = render({ downloadBytes: 36_200_000, progress: null, onDownload() {}, onCancel() {} });
  // det + rec models, the dict, and the ORT wasm: four files, not "a model"
  assert.match(html, /two recognition models, a character list and their runtime/);
  assert.match(html, /from this site/);
  assert.match(html, /kept in your browser/);
  assert.match(html, /on this device/);
});

test("only Download calls onDownload; Cancel calls onCancel", () => {
  const calls: string[] = [];
  const props = { downloadBytes: 1e6, progress: null, onDownload: () => calls.push("download"), onCancel: () => calls.push("cancel") };
  const bs = buttons(props);
  assert.deepEqual(bs.map(text), ["Cancel", "Download"]);
  (bs[0].props.onClick as () => void)();
  assert.deepEqual(calls, ["cancel"]);
  (bs[1].props.onClick as () => void)();
  assert.deepEqual(calls, ["cancel", "download"]);
});

test("while downloading: a progress bar, no Download button, and Cancel still cancels", () => {
  const calls: string[] = [];
  const props = { downloadBytes: 1e6, progress: { loaded: 420, total: 1000, pct: 42 }, onDownload: () => calls.push("download"), onCancel: () => calls.push("cancel") };
  const html = render(props);
  assert.match(html, /<progress[^>]*value="42"[^>]*max="100"/);
  assert.match(html, /42%/);
  const bs = buttons(props);
  assert.deepEqual(bs.map(text), ["Cancel"]);
  (bs[0].props.onClick as () => void)();
  assert.deepEqual(calls, ["cancel"]);
});

// ── accessibility ───────────────────────────────────────────────────────────

const tree = (props: Record<string, unknown>) => walk(React.createElement(OcrDownloadNotice as never, props));
const idle = (calls: string[] = []) => ({ downloadBytes: 1e6, progress: null, onDownload: () => calls.push("download"), onCancel: () => calls.push("cancel") });
const busy = (pct: number, calls: string[] = []) => ({ ...idle(calls), progress: { loaded: pct, total: 100, pct } });

test("a modal dialog, labelled by its title", () => {
  const html = render(idle());
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby="ocr-download-title"/);
  assert.match(html, /id="ocr-download-title"/);
});

test("Download has focus when the notice opens; Cancel takes it once the download starts", () => {
  const before = tree(idle()).filter((e) => e.type === "button");
  assert.equal(before.find((b) => text(b) === "Download")?.props.autoFocus, true);
  assert.notEqual(before.find((b) => text(b) === "Cancel")?.props.autoFocus, true);
  const during = tree(busy(3)).filter((e) => e.type === "button");
  const cancel = during.find((b) => text(b) === "Cancel")!;
  assert.equal(cancel.props.autoFocus, true);
  // A new key remounts Cancel, so React focuses it when Download unmounts.
  const keyOf = (els: El[]) => (els.find((b) => text(b) === "Cancel") as unknown as { key: unknown }).key;
  assert.notEqual(keyOf(before), keyOf(during));
});

test("Escape cancels, before and during the download; other keys don't", () => {
  for (const props of [idle, (c: string[]) => busy(40, c)]) {
    const calls: string[] = [];
    const dialog = tree(props(calls)).find((e) => e.props.role === "dialog")!;
    const ev = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });
    (dialog.props.onKeyDown as (e: unknown) => void)(ev("Enter"));
    assert.deepEqual(calls, []);
    (dialog.props.onKeyDown as (e: unknown) => void)(ev("Escape"));
    assert.deepEqual(calls, ["cancel"]);
  }
});

test("the status region is always there, and announces progress in whole tens", () => {
  assert.match(render(idle()), /role="status"/);
  assert.equal(announcedPct(0), 0);
  assert.equal(announcedPct(9), 0);
  assert.equal(announcedPct(42), 40);
  assert.equal(announcedPct(49.9), 40);
  assert.equal(announcedPct(100), 100);
  const statusText = (pct: number) => {
    const html = render(busy(pct));
    return html.match(/role="status"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
  };
  assert.equal(statusText(41), statusText(48), "no new announcement within a ten");
  assert.notEqual(statusText(48), statusText(51));
  assert.match(statusText(51), /50%/);
  assert.doesNotMatch(statusText(51), /51%/, "the per-percent readout stays outside the live region");
});

// aria-modal promises focus stays inside: Tab from the last control wraps to
// the first and Shift+Tab from the first to the last (measured in Chromium:
// without this, one Tab left the notice and Escape stopped working).
test("Tab and Shift+Tab wrap inside the notice; Escape cancels", () => {
  const a = { focus() { focused = "a"; } }, b = { focus() { focused = "b"; } };
  // A disabled button after b: the wrap must skip it, as the real selector does.
  const off = { disabled: true, focus() { focused = "off"; } };
  let focused = "", prevented = 0, cancelled = 0;
  const box = {
    querySelectorAll: (sel: string) => {
      const all = [a, b, off] as { disabled?: boolean }[];
      return /:not\(\[disabled\]\)/.test(sel) ? all.filter((x) => !x.disabled) : all;
    },
  };
  const ev = (key: string, target: unknown, shiftKey = false) =>
    ({ key, shiftKey, target, currentTarget: box, preventDefault() { prevented++; }, stopPropagation() {} });
  const onKey = noticeKeyDown(() => { cancelled++; });

  onKey(ev("Tab", b));
  assert.equal(focused, "a", "Tab from the last wraps to the first");
  onKey(ev("Tab", a, true));
  assert.equal(focused, "b", "Shift+Tab from the first wraps to the last");
  focused = ""; const before = prevented;
  onKey(ev("Tab", a));
  assert.equal(focused, "", "Tab between inner controls is left to the browser");
  assert.equal(prevented, before);
  onKey(ev("Escape", a));
  assert.equal(cancelled, 1);
});
