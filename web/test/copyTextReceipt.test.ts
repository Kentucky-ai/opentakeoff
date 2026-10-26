// The Copy text receipt (#471) rendered to a string — the repo's one
// React seam (renderToStaticMarkup; no DOM). Plus the docs rows a keyless
// tool can't be held to by guideParity (an empty key combo matches §15's
// "Click" row, so that test passes whatever the row says).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CopyTextReceipt from "../src/components/CopyTextReceipt.jsx";
import { TOOLS, Keys } from "../src/components/UserGuide.jsx";
import { makeReceipt, receiptPlacement, TEXT_LAYER, RECEIPT_W, type TextOutcome } from "../src/lib/copyText";

const OUT: TextOutcome = { kind: "text", reader: TEXT_LAYER, lines: [], text: "GENERAL NOTES\nSEE A-101 & B", lineCount: 2, skipped: 0 };
const render = (receipt: object, extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(CopyTextReceipt as never, {
  receipt, placement: receiptPlacement({ sweepOpen: false, zoneOpen: false, narrow: false }), onClose() {}, onCopyPage() {}, onCopied() {}, ...extra,
}));

test("a written copy: Copied, the line count, the reader, the preview; no textarea", () => {
  const html = render(makeReceipt(OUT, { failed: false, scope: "box", key: "a.pdf" }));
  assert.match(html, /Copied/);
  assert.match(html, /2 lines/);
  assert.match(html, /Text layer/);
  assert.match(html, /GENERAL NOTES\nSEE A-101 &amp; B/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /rotated/);
  assert.match(html, /role="status"/);
});

test("one line reads singular", () => {
  assert.match(render(makeReceipt({ ...OUT, lineCount: 1 }, { failed: false, scope: "box", key: "k" })), /1 line(?!s)/);
});

test("skipped rotated runs are counted on the receipt", () => {
  const html = render(makeReceipt({ ...OUT, skipped: 3 }, { failed: false, scope: "box", key: "k" }));
  assert.match(html, / · 3 rotated left out/);
});

test("a refused write: the full text in a read-only textarea, a Copy button, Close", () => {
  const long = `${"A".repeat(400)}\nEND`;
  const html = render(makeReceipt({ ...OUT, text: long }, { failed: true, scope: "box", key: "k" }));
  assert.match(html, /Couldn&#x27;t copy automatically — use Copy below/);
  const ta = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(ta, "a textarea holds the text");
  assert.match(ta[0], /readonly/i);
  assert.equal(ta[1].replace(/^\n/, ""), long, "the whole text, not the preview");
  assert.match(html, />Copy<\/button>/);
  assert.match(html, />Close<\/button>/);
  assert.match(html, /role="dialog"/);
});

test("a box receipt offers Copy page text; a page receipt says it was the whole page", () => {
  assert.match(render(makeReceipt(OUT, { failed: false, scope: "box", key: "k" })), />Copy page text<\/button>/);
  const page = render(makeReceipt(OUT, { failed: false, scope: "page", key: "k" }));
  assert.doesNotMatch(page, /Copy page text/);
  assert.match(page, /whole page/i);
});

test("placed where the caller says, inside the canvas (left of a live Sweep panel)", () => {
  const pl = receiptPlacement({ sweepOpen: true, zoneOpen: false, narrow: false });
  const html = render(makeReceipt(OUT, { failed: false, scope: "box", key: "k" }), { placement: pl });
  assert.match(html, /position:absolute/);
  assert.doesNotMatch(html, /position:fixed/);
  assert.match(html, new RegExp(`right:${pl.right}px`));
  assert.match(html, new RegExp(`width:${RECEIPT_W}px`));
});

test("a keyless row shows that it lives on the rail, not an empty key cell", () => {
  const html = renderToStaticMarkup(React.createElement(Keys as never, { combo: [] }));
  assert.match(html, /rail/);
  assert.match(html, /font-family:var\(--f-mono\)/, "the shared mono label style");
  assert.doesNotMatch(html, /<kbd/);
});

// ── docs ─────────────────────────────────────────────────────────────────────

test("the in-app guide lists Copy text as a keyless tool", () => {
  const row = TOOLS.find((r) => String(r[1]).startsWith("Copy text"));
  assert.ok(row, "UserGuide TOOLS has a Copy text row");
  assert.deepEqual(row[0], [], "Copy text has no key (T is trace-another)");
});

test("USER_GUIDE.md documents Copy text", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const guide = readFileSync(join(here, "../../docs/USER_GUIDE.md"), "utf8");
  assert.match(guide, /^### Copy text$/m);
  const section = guide.slice(guide.search(/^### Copy text$/m)).split(/\n##/)[0];
  assert.match(section, /Copy page text/);
  assert.match(section, /Text layer/);
  // beside Import from schedule, the other box-a-region-of-text tool
  const at = guide.search(/^### Copy text$/m), imp = guide.search(/^### Import from schedule$/m);
  assert.ok(imp > 0 && at > imp && !/\n## /.test(guide.slice(imp, at)), "Copy text follows Import from schedule in the same chapter");
});

test("an OCR copy names OCR as the reader, and counts lines split at a seam", () => {
  const html = render(makeReceipt({ ...OUT, reader: "OCR", clipped: 2 }, { failed: true, scope: "box", key: "k" }));
  assert.match(html, /OCR/);
  assert.match(html, /2 split at a seam/);
  assert.match(html, /<textarea/, "an async OCR copy usually loses the click: the textarea holds the text");
  assert.doesNotMatch(render(makeReceipt(OUT, { failed: false, scope: "box", key: "k" })), /split at a seam/);
});
