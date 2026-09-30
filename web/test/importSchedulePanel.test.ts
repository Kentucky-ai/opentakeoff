// ImportSchedulePanel render (#468). A category guessed from the row's words
// (category_source "text" — no printed section heading) must be FLAGGED for
// review: visible "from description" text, a sibling of the row's <label>
// (not inside it, so it isn't folded into the checkbox's accessible name), and
// tied to that row's checkbox by aria-describedby. Heading, none and scan rows
// carry no flag. Select All / Deselect All render in the dialog, and the tag
// stays a one-act inline edit (a button that becomes a focused input).
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImportSchedulePanel from "../src/components/ImportSchedulePanel.jsx";

const row = (finish_tag: string, category: string, category_source: string) => ({
  finish_tag, category, category_source, description: `${finish_tag} desc`, section: "", manufacturer: "VENDOR-A",
  style: "", spec_color: "", size: "", remarks: "", suggested: true,
});
const rows = [
  row("TS-1", "transition", "text"),
  row("CPT-1", "floor", "heading"),
  row("PR-1", "unassigned", "none"),
  row("ACT-1", "ceiling", "scan"),
  row("HR-1", "wall_protection", "text"),
];
const render = (rs: any[] = rows) => renderToStaticMarkup(
  React.createElement(ImportSchedulePanel as any, { rows: rs, existing: new Set(), palette: ["#111111"], onCreate: () => {}, onClose: () => {} }),
);

// Each checkbox's aria-describedby, keyed by the tag shown in its row.
const describedBy = (html: string) => {
  const out = new Map<string, string | null>();
  for (const m of html.matchAll(/<label[^>]*>(.*?)<\/label>/gs)) {
    const tag = m[1].match(/<button[^>]*>([^<]*)<\/button>/)?.[1];
    if (!tag) continue; // group header label
    out.set(tag, m[1].match(/aria-describedby="([^"]+)"/)?.[1] ?? null);
  }
  return out;
};

test("ImportSchedulePanel: text-sourced rows are flagged 'from description'; heading/none/scan rows are not", () => {
  const html = render();
  const flags = [...html.matchAll(/<span[^>]*id="([^"]+)"[^>]*>from description<\/span>/g)].map((m) => m[1]);
  assert.equal(flags.length, 2);
  const by = describedBy(html);
  assert.equal(by.size, 5);
  // TS-1 and HR-1 point at a flag; the ids are distinct and each one exists
  assert.ok(by.get("TS-1") && by.get("HR-1"));
  assert.notEqual(by.get("TS-1"), by.get("HR-1"));
  assert.deepEqual([by.get("TS-1"), by.get("HR-1")].sort(), [...flags].sort());
  for (const t of ["CPT-1", "PR-1", "ACT-1"]) assert.equal(by.get(t), null, `${t} has no flag`);
});

test("ImportSchedulePanel: the flag is a sibling of the row's <label>, not inside it", () => {
  const html = render();
  for (const m of html.matchAll(/<label[^>]*>(.*?)<\/label>/gs)) assert.doesNotMatch(m[1], /from description/);
  assert.match(html, /<\/label><span[^>]*id="[^"]+"[^>]*>from description<\/span>/);
  // warning colour + a tooltip saying why
  assert.match(html, /<span[^>]*color:var\(--c-warning\)[^>]*>from description</);
  assert.match(html, /title="Category guessed from the row(&#x27;|')s description — no printed section heading"/);
});

test("ImportSchedulePanel: Select All / Deselect All render; the tag is an inline-edit button", () => {
  const html = render();
  assert.match(html, /<button[^>]*>Select all<\/button>/);
  assert.match(html, /<button[^>]*>Deselect all<\/button>/);
  assert.match(html, /<button[^>]*title="Click to fix the code"[^>]*>TS-1<\/button>/);
  // every suggested creatable row starts ticked → Create 5
  assert.match(html, /Create 5 conditions/);
});

test("ImportSchedulePanel: 'No section' is the first group", () => {
  const html = render();
  const order = ["No section", "Floor", "Wall Protection", "Transition", "Ceiling"].map((l) => html.indexOf(`>${l}<`));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
