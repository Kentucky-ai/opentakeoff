// ImportSchedulePanel render (#468). A category guessed from the row's words
// (category_source "text" — no printed heading names one) must be FLAGGED for
// review: visible "from description" text, a sibling of the row's <label>
// (not inside it, so it isn't folded into the checkbox's accessible name), and
// tied to that row's checkbox by aria-describedby. Heading and none rows carry
// no flag. Select All / Deselect All render in the dialog, and the tag
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
  row("ACT-1", "ceiling", "heading"),
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

test("ImportSchedulePanel: text-sourced rows are flagged 'from description'; heading/none rows are not", () => {
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
  // accurate: a row under a printed MISC / ACCESSORIES heading is "text" too —
  // there IS a heading, it just names no category
  assert.match(html, /title="Category guessed from the row(&#x27;|')s own words — no printed heading names one"/);
  assert.doesNotMatch(html, /no printed section heading/);
});

test("ImportSchedulePanel: Select All / Deselect All render; the tag is an inline-edit button", () => {
  const html = render();
  assert.match(html, /<button[^>]*>Select all<\/button>/);
  assert.match(html, /<button[^>]*>Deselect all<\/button>/);
  assert.match(html, /<button[^>]*title="Click to fix the code"[^>]*>TS-1<\/button>/);
  // every suggested creatable row starts ticked → Create 5
  assert.match(html, /Create 5 conditions/);
});

test("ImportSchedulePanel: the dialog fits a phone-width viewport and its footer wraps", () => {
  const html = render();
  // no fixed 560px box: capped at the viewport less a 16px gutter each side
  assert.match(html, /width:min\(560px, calc\(100vw - 32px\)\)/);
  assert.doesNotMatch(html, /width:560px/);
  // the footer (Select all … Create) wraps instead of pushing Create off-screen
  const footer = html.slice(html.lastIndexOf("<div", html.indexOf(">Select all<")));
  assert.match(footer, /^<div[^>]*flex-wrap:wrap/);
});

test("ImportSchedulePanel: 'No section' is the first group", () => {
  const html = render();
  const order = ["No section", "Floor", "Wall Protection", "Transition", "Ceiling"].map((l) => html.indexOf(`>${l}<`));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("ImportSchedulePanel: the dialog is a labelled modal", () => {
  const html = render();
  const dlg = html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0];
  assert.ok(dlg, "has role=dialog");
  assert.match(dlg!, /aria-modal="true"/);
  const labelId = dlg!.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(labelId, "has aria-labelledby");
  const esc = labelId!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`<span[^>]*id="${esc}"[^>]*>Import from schedule`));
});

// ── #483: NOT USED rows, mixed group checkbox, duplicates, skipped codes ─────
// A row the schedule marks NOT USED / N.I.C. starts unticked but pickable, and
// carries a label after "from description": the marker as printed, plus a
// visually hidden note for screen readers (title = the same note). The label
// and the from-description flag describe the row's checkbox (aria-describedby);
// the in-use / duplicate flag is inside the <label> already and never is.
// A group whose pickable rows are partly picked is "some" (indeterminate, set
// by a ref — static markup shows data-state). The dialog's skipped notice and
// its zero-rows form (Close only) are pinned to their exact text.
const nu = (finish_tag: string, category: string, not_used_text: string, extra: Record<string, unknown> = {}) => ({
  ...row(finish_tag, category, "heading"), suggested: false, unticked_reason: "not-used", not_used_text, ...extra,
});
const renderWith = (props: Record<string, unknown>) => renderToStaticMarkup(
  React.createElement(ImportSchedulePanel as any, { existing: new Set(), palette: ["#111111"], onCreate: () => {}, onClose: () => {}, ...props }),
);
// one row's markup: from its row <div> to the next row or group
const rowOf = (html: string, tag: string) => {
  const at = html.indexOf(`>${tag}</button>`);
  assert.ok(at >= 0, `row ${tag} rendered`);
  const start = html.lastIndexOf("<div", html.lastIndexOf("<label", at));
  const next = html.slice(at).search(/<div style="display:flex;align-items:center;gap:10px;padding:5px 14px 5px 26px|<div><label|<\/div><\/div><div style="display:flex;flex-wrap:wrap/);
  return html.slice(start, next < 0 ? undefined : at + next);
};
const checkboxOf = (rowHtml: string) => rowHtml.match(/<label[^>]*><input type="checkbox"[^>]*>/)![0];
const HIDDEN = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";

test("NOT USED row: the marker as printed, a hidden note, a title; unchecked, not disabled", () => {
  const html = renderWith({ rows: [row("CPT-1", "floor", "heading"), nu("CPT-2", "floor", "(NOT USED)")] });
  const r = rowOf(html, "CPT-2");
  const note = " The schedule marks this row not used. Select it to create a condition anyway.";
  const m = r.match(/<span id="([^"]+)" title="([^"]+)" style="([^"]*)">\(NOT USED\)<span style="([^"]*)">([^<]*)<\/span><\/span>/);
  assert.ok(m, `NOT USED label in: ${r}`);
  assert.equal(m![2], note.trimStart());
  assert.equal(m![4], HIDDEN);
  assert.equal(m![5], note);
  // styled like the from-description flag, normal case, ink text, warning rule
  assert.match(m![3], /text-transform:none/);
  assert.match(m![3], /color:var\(--ink\)/);
  assert.match(m![3], /border-left:2px solid var\(--c-warning\)/);
  assert.match(m![3], /padding-left:4px/);
  assert.match(m![3], /position:relative/);
  // outside the label; the checkbox points at it; unchecked, not disabled
  const cb = checkboxOf(r);
  assert.equal(cb.match(/aria-describedby="([^"]+)"/)?.[1], m![1]);
  assert.doesNotMatch(cb, /checked|disabled/);
  for (const l of r.matchAll(/<label[^>]*>(.*?)<\/label>/gs)) assert.doesNotMatch(l[1], /NOT USED/);
  // the ticked row next to it still counts; the NOT USED row doesn't
  assert.match(html, /Create 1 condition</);
});

test("N.I.C. row: the not-in-contract note", () => {
  const html = renderWith({ rows: [nu("CPT-3", "floor", "N.I.C.")] });
  assert.match(rowOf(html, "CPT-3"), /title="The schedule marks this row N\.I\.C\. \(not in contract\)\. Select it to create a condition anyway\."/);
});

test("from description, then NOT USED: both describe the checkbox, in that order", () => {
  const html = renderWith({ rows: [nu("HR-1", "wall_protection", "NOT USED", { category_source: "text" })] });
  const r = rowOf(html, "HR-1");
  const guess = r.match(/<span id="([^"]+)"[^>]*>from description<\/span>/)?.[1];
  const notUsed = r.match(/<span id="([^"]+)"[^>]*>NOT USED<span/)?.[1];
  assert.ok(guess && notUsed && guess !== notUsed);
  assert.ok(r.indexOf(">from description<") < r.indexOf(">NOT USED<"));
  assert.equal(checkboxOf(r).match(/aria-describedby="([^"]+)"/)?.[1], `${guess} ${notUsed}`);
});

test("a NOT USED CPT-2 before a real CPT-2: the real one is checked and counted; the NOT USED one is the duplicate", () => {
  const html = renderWith({ rows: [nu("CPT-2", "floor", "NOT USED"), row("CPT-2", "floor", "heading")] });
  const [first, second] = [...html.matchAll(/<label[^>]*><input type="checkbox"[^>]*>/g)].map((m) => m[0]).slice(1);
  assert.doesNotMatch(first, /checked/);
  assert.match(first, /disabled/);
  assert.match(second, /checked/);
  assert.match(html, /Create 1 condition</);
  // the duplicate flag says how to fix it, and stays out of aria-describedby
  assert.match(html, /<span title="Click the code to rename it\."[^>]*>duplicate<\/span>/);
  // the locked row's hidden note: no "Select it" (it can't be selected)
  assert.match(html, /<span style="[^"]*">\s?The schedule marks this row not used\.<\/span>/);
  assert.doesNotMatch(html, /Select it to create a condition anyway/);
});

test("in-use flag: inside the label, never in aria-describedby; aria-describedby omitted when nothing describes the row", () => {
  const html = renderWith({ rows: [row("CPT-1", "floor", "heading"), nu("CPT-2", "floor", "NOT USED")], existing: new Set(["CPT-2"]) });
  const r = rowOf(html, "CPT-2");
  const cb = checkboxOf(r);
  const ids = cb.match(/aria-describedby="([^"]+)"/)![1].split(" ");
  assert.equal(ids.length, 1);
  assert.match(r, new RegExp(`<span id="${ids[0]}"[^>]*>NOT USED<span`));
  assert.match(r.match(/<label[^>]*>(.*?)<\/label>/s)![1], />in use</);
  assert.doesNotMatch(checkboxOf(rowOf(html, "CPT-1")), /aria-describedby/);
});

test("row layout: wraps; label flex 1 1 160px; descriptors pushed right; locked rows dim the label only", () => {
  const html = renderWith({ rows: [row("CPT-1", "floor", "heading"), nu("CPT-2", "floor", "NOT USED"),
    nu("HR-1", "wall_protection", "NOT USED", { category_source: "text" })], existing: new Set(["CPT-2"]) });
  const locked = rowOf(html, "CPT-2");
  const rowDiv = locked.match(/^<div style="([^"]*)"/)![1];
  assert.match(rowDiv, /flex-wrap:wrap/);
  assert.doesNotMatch(rowDiv, /opacity/);
  const label = locked.match(/<label style="([^"]*)"/)![1];
  assert.match(label, /flex:1 1 160px/);
  assert.match(label, /min-width:0/);
  assert.match(label, /opacity:0\.55/);
  // the NOT USED label on a locked row is at full opacity
  assert.doesNotMatch(locked.match(/<span id="[^"]+" title="[^"]*" style="([^"]*)">NOT USED/)![1], /opacity/);
  assert.match(locked, /<\/label><span[^>]*margin-left:auto[^>]*>NOT USED/);
  // a pickable row's label is at full opacity
  assert.doesNotMatch(rowOf(html, "CPT-1").match(/<label style="([^"]*)"/)![1], /opacity/);
  // two descriptors: one group pushed right, flex, gap as the row's
  const two = rowOf(html, "HR-1");
  assert.match(two, /<\/label><div style="margin-left:auto;display:flex;gap:10px[^"]*"><span[^>]*>from description<\/span><span[^>]*>NOT USED<span/);
});

test("group checkbox: a partly picked group is data-state=some and unchecked; all → checked; none → unchecked", () => {
  const groupBox = (html: string, label: string) => {
    const at = html.indexOf(`>${label}</span>`);
    return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", html.lastIndexOf("<input", at)) + 1);
  };
  const html = renderWith({ rows: [row("CPT-1", "floor", "heading"), nu("CPT-2", "floor", "NOT USED"),
    row("RB-1", "base", "heading"), nu("ACT-9", "ceiling", "NOT USED")] });
  const floor = groupBox(html, "Floor");
  assert.match(floor, /data-state="some"/);
  assert.doesNotMatch(floor, /checked/);
  const base = groupBox(html, "Base");
  assert.match(base, /data-state="all"/);
  assert.match(base, /checked/);
  const ceiling = groupBox(html, "Ceiling");
  assert.match(ceiling, /data-state="none"/);
  assert.doesNotMatch(ceiling, /checked|disabled/);
});

const BANNER_TAIL = "A four- or five-letter code with no number is read only when the header or a read row is above it, it fills two or more other columns, and a row with a numbered code, like CPT-1, comes after it — ";
const bannerOf = (html: string) => html.match(/<div role="note" id="([^"]+)" style="([^"]*)">([^<]*)<\/div>/);
const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

test("skipped notice: exact text one / several / repeated / > 8; a note the dialog is described by", () => {
  const rs = [row("CPT-1", "floor", "heading")];
  const cases: [string[], string][] = [
    [["EPOX"], `1 code wasn't read: EPOX. ${BANNER_TAIL}if it's a finish, add it as a condition yourself.`],
    [["EPOX", "SEAL"], `2 codes weren't read: EPOX, SEAL. ${BANNER_TAIL}if they're finishes, add them as conditions yourself.`],
    [["EPOX", "EPOX"], `1 code wasn't read: EPOX (2 lines). ${BANNER_TAIL}if it's a finish, add it as a condition yourself.`],
    [["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH", "IIII", "JJJJ"],
      `10 codes weren't read: AAAA, BBBB, CCCC, DDDD, EEEE, FFFF, GGGG, HHHH, and 2 more. ${BANNER_TAIL}if they're finishes, add them as conditions yourself.`],
  ];
  for (const [skipped, text] of cases) {
    const html = renderWith({ rows: rs, skipped });
    const b = bannerOf(html);
    assert.ok(b, `banner for ${skipped}`);
    assert.equal(unesc(b![3]), text);
    for (const s of ["font-size:var(--fs-s)", "color:var(--ink)", "border-left:3px solid var(--c-warning)", "padding-left:8px", "margin:8px 14px"]) assert.ok(b![2].includes(s), `${s} in ${b![2]}`);
    assert.doesNotMatch(b![2], /background|text-transform/);
    assert.match(html.match(/<div[^>]*role="dialog"[^>]*>/)![0], new RegExp(`aria-describedby="${b![1]}"`));
  }
  // none → no notice, no aria-describedby on the dialog, no scan-era sentence
  const none = renderWith({ rows: rs });
  assert.equal(bannerOf(none), null);
  assert.doesNotMatch(none.match(/<div[^>]*role="dialog"[^>]*>/)![0], /aria-describedby/);
  assert.doesNotMatch(none, /skipped \(couldn/);
});

test("zero rows: its own title, Close (autofocus) only — no Select all, Deselect all or Create", () => {
  const html = renderWith({ rows: [], skipped: ["EPOX"] });
  assert.match(html, />Import from schedule — no rows read</);
  assert.doesNotMatch(html, /Select all|Deselect all|Create \d/);
  assert.match(html, /<button autofocus=""[^>]*>Close<\/button>/);
  assert.doesNotMatch(html, />Cancel</);
  assert.ok(bannerOf(html));
});

// ── a key_rule row ranks below a row read today ──────
// The dialog's rank puts a row only the newer rules read (key_rule) below a
// row read the usual way, so the later plain CT-1 keeps the code — checked,
// counted in Create N — and the earlier key_rule CT-1 shows duplicate.
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import { build, M, MMC } from "./fixtures/reader483Fixtures.ts";

const ctRows = (html: string) => {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<label[^>]*>(<input type="checkbox"[^>]*>)(.*?)<\/label>/gs)) {
    const desc = m[2].match(/<\/button><span[^>]*>([^<]*)/)?.[1];
    if (m[2].includes(">CT-1</button>") && desc) out[desc] = `${/checked/.test(m[1]) ? "on" : "off"}|${/>duplicate</.test(m[2]) ? "duplicate" : ""}`;
  }
  return out;
};

test("a key_rule CT-1 before a plain CT-1: the plain one is checked and counted; the key_rule one is duplicate", () => {
  const html = renderWith({ rows: [
    { ...row("CT-1", "base", "heading"), description: "COVE BASE", key_rule: "extended" },
    { ...row("CT-1", "floor", "heading"), description: "CERAMIC TILE" },
  ] });
  assert.deepEqual(ctRows(html), { "COVE BASE": "off|duplicate", "CERAMIC TILE": "on|" });
  assert.match(html, /Create 1 condition</);
});

test("end to end: the reader's CT-1 COVE line above a floor CT-1 → two items, CT-1COVE and CT-1, both picked (the collision rule)", () => {
  const read = readScheduleSpans(build({ cols: MMC, items: [
    M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), M("CT-1 COVE", "CERAMIC TILE BASE", "VENDOR-F", "WHITE"),
    M("CT-1", "CERAMIC TILE", "VENDOR-F", "WHITE"), M("PT-1", "PAINT", "VENDOR-E", "WHITE 601"),
  ] }));
  assert.deepEqual(read.rows.map((r) => r.finish_tag), ["CPT-1", "CT-1COVE", "CT-1", "PT-1"]);
  const html = renderWith({ rows: read.rows });
  assert.deepEqual(ctRows(html), { "CERAMIC TILE": "on|" });
  assert.deepEqual(tagRows(html, "CT-1COVE"), { "CERAMIC TILE BASE": "on|" });
});

// ── #482: a code repaired from an OCR misread ──────────────────────────────────
// A row whose code the reader repaired (read_as: PT-O1 imported as PT-01) shows
// "read as PT-O1" after the row's label, built like the NOT USED label: the
// code in the edit button's mono at 12.5px so O and 0 can be told apart, a
// title and a hidden sentence saying what to check, and the checkbox described
// by it. With more than one descriptor they wrap as one group: from
// description, read as, NOT USED. A row read right claims a code over a
// repaired row with the same code.
const ra = (finish_tag: string, read_as: string, extra: Record<string, unknown> = {}) => ({ ...row(finish_tag, "floor", "heading"), read_as, ...extra });
const tagRows = (html: string, tag: string) => {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<label[^>]*>(<input type="checkbox"[^>]*>)(.*?)<\/label>/gs)) {
    const desc = m[2].match(/<\/button><span[^>]*>([^<]*)/)?.[1];
    if (m[2].includes(`>${tag}</button>`) && desc) out[desc] = `${/checked/.test(m[1]) ? "on" : "off"}|${/>duplicate</.test(m[2]) ? "duplicate" : ""}`;
  }
  return out;
};

test("read as: the code as read, mono 12.5px, warning color, a title and hidden sentence; it describes the checkbox", () => {
  const html = renderWith({ rows: [ra("PT-01", "PT-O1")] });
  const r = rowOf(html, "PT-01");
  const sentence = "Repaired from PT-O1; check the code against the schedule.";
  const m = r.match(/<span id="([^"]+)" title="([^"]+)" style="([^"]*)">read as <span style="([^"]*)">PT-O1<\/span><span style="([^"]*)">([^<]*)<\/span><\/span>/);
  assert.ok(m, `read as flag in: ${r}`);
  assert.equal(m![2], sentence);
  assert.match(m![3], /text-transform:none/);
  assert.match(m![3], /color:var\(--c-warning\)/);
  assert.match(m![3], /cursor:help/);
  assert.match(m![4], /font-family:var\(--f-mono\)/);
  assert.match(m![4], /font-size:12\.5px/);
  assert.equal(m![5], HIDDEN);
  // the hidden text doesn't repeat the code the visible text just read out
  assert.equal(m![6], " — check the code against the schedule.");
  // outside the label, pushed right on its own; the checkbox points at it
  for (const l of r.matchAll(/<label[^>]*>(.*?)<\/label>/gs)) assert.doesNotMatch(l[1], /read as/);
  assert.match(r, /<\/label><span[^>]*margin-left:auto[^>]*>read as /);
  assert.equal(checkboxOf(r).match(/aria-describedby="([^"]+)"/)?.[1], m![1]);
  // a row with no read_as has none
  assert.doesNotMatch(renderWith({ rows: [row("PT-01", "floor", "heading")] }), /read as/);
});

test("three descriptors: one group pushed right, in the order from description, read as, NOT USED", () => {
  const html = renderWith({ rows: [nu("HR-01", "wall_protection", "NOT USED", { category_source: "text", read_as: "HR-O1" })] });
  const r = rowOf(html, "HR-01");
  assert.match(r, /<\/label><div style="margin-left:auto;display:flex;gap:10px"><span[^>]*>from description<\/span><span[^>]*>read as <span[^>]*>HR-O1<\/span><span[^>]*>[^<]*<\/span><\/span><span[^>]*>NOT USED<span/);
  const guess = r.match(/<span id="([^"]+)"[^>]*>from description<\/span>/)?.[1];
  const readAs = r.match(/<span id="([^"]+)"[^>]*>read as /)?.[1];
  const notUsed = r.match(/<span id="([^"]+)"[^>]*>NOT USED<span/)?.[1];
  assert.equal(checkboxOf(r).match(/aria-describedby="([^"]+)"/)?.[1], `${guess} ${readAs} ${notUsed}`);
  // the group's descriptors aren't each pushed right
  assert.doesNotMatch(r.slice(r.indexOf('<div style="margin-left:auto')), /<span[^>]*margin-left:auto/);
});

test("a PT-01 read right claims the code over a repaired PT-01, in either order", () => {
  for (const rows of [
    [{ ...ra("PT-01", "PT-O1"), description: "REPAIRED" }, { ...row("PT-01", "floor", "heading"), description: "PLAIN" }],
    [{ ...row("PT-01", "floor", "heading"), description: "PLAIN" }, { ...ra("PT-01", "PT-O1"), description: "REPAIRED" }],
  ]) {
    const html = renderWith({ rows });
    assert.deepEqual(tagRows(html, "PT-01"), { REPAIRED: "off|duplicate", PLAIN: "on|" });
  }
});

test("a key_rule row that was also repaired ranks with key_rule rows: under a repaired row, over a NOT USED one", () => {
  const krRa = { ...ra("PT-01", "PT-O1", { key_rule: "extended" }), description: "BOTH" };
  // under a repaired row read the usual way
  assert.deepEqual(tagRows(renderWith({ rows: [krRa, { ...ra("PT-01", "PT-O1"), description: "REPAIRED" }] }), "PT-01"), { BOTH: "off|duplicate", REPAIRED: "on|" });
  // level with a key_rule row: the first one claims it
  assert.deepEqual(tagRows(renderWith({ rows: [krRa, { ...row("PT-01", "floor", "heading"), key_rule: "extended", description: "RULE" }] }), "PT-01"), { BOTH: "on|", RULE: "off|duplicate" });
  // over a NOT USED row
  const notUsed = { ...nu("PT-01", "floor", "NOT USED"), description: "UNUSED" };
  assert.deepEqual(tagRows(renderWith({ rows: [notUsed, krRa] }), "PT-01"), { UNUSED: "off|duplicate", BOTH: "on|" });
});

test("a historical flat code is visibly held, unchecked and disabled while a distinct suffix stays creatable", () => {
  const html = renderWith({ rows: [row("G-01(C)", "floor", "heading"), row("G-01(W)", "floor", "heading")], existing: new Set(["G-01C"]) });
  const held = rowOf(html, "G-01(C)");
  assert.match(held, /check existing G-01C/);
  assert.match(checkboxOf(held), /disabled/);
  assert.doesNotMatch(checkboxOf(held), /checked/);
  assert.match(checkboxOf(rowOf(html, "G-01(W)")), /checked/);
  assert.match(html, /Create 1 condition</);
  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)![0];
  const id = dialog.match(/aria-describedby="([^"]+)"/)![1];
  assert.ok(html.includes(`role="note" id="${id}"`));
  assert.match(html, /if it is the same finish, rename it before importing again/);
});

test("after the existing condition is renamed to its printed suffix, re-import is in use with no historical hold", () => {
  const html = renderWith({ rows: [row("G-01(C)", "floor", "heading")], existing: new Set(["G-01 (C)"]) });
  assert.match(rowOf(html, "G-01(C)"), />in use</);
  assert.doesNotMatch(html, /check existing|Some codes may already exist without parentheses/);
  assert.match(html, /Create 0 conditions/);
});

test("OCR disagreement and historical identity holds coexist without hiding either notice or enabling duplicate creation", () => {
  const html = renderWith({ rows: [
    { ...row("G-01(C)", "floor", "heading"), code_checks: [{ first: "G-01(C)", second: "G-01C" }] },
    { ...row("S-2", "floor", "heading"), code_checks: [{ first: "S-2", second: "SS-2" }] },
    row("PT-1", "floor", "heading"),
  ], existing: new Set(["G-01C"]), skipped: ["EPOX"] });
  const held = rowOf(html, "G-01(C)");
  assert.match(held, /check existing G-01C/);
  assert.match(held, /Check code: G-01\(C\) \/ G-01C/);
  assert.match(checkboxOf(held), /disabled/);
  assert.doesNotMatch(checkboxOf(held), /checked/);
  const uncertain = rowOf(html, "S-2");
  assert.doesNotMatch(checkboxOf(uncertain), /checked|disabled/);
  const warningId = checkboxOf(uncertain).match(/aria-describedby="([^"]+)"/)![1];
  assert.ok(html.includes(`id="${warningId}"`));
  assert.match(checkboxOf(rowOf(html, "PT-1")), /checked/);
  assert.match(html, /Create 1 condition</);
  const ids = html.match(/role="dialog"[^>]*aria-describedby="([^"]+)"/)![1].split(" ");
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(html.includes(`role="note" id="${id}"`));
});

test("an unconfirmed second read remains visible and unchecked even when every row was suggested", () => {
  const html = renderWith({ rows: [{ ...row("P1", "floor", "heading"), code_checks: [{ first: "P1", second: "" }] }] });
  assert.match(html, /Check code: P1 \/ second read did not confirm/);
  assert.doesNotMatch(checkboxOf(rowOf(html, "P1")), /checked|disabled/);
  assert.match(html, /Create 0 conditions/);
});
