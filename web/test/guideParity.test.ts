// #196 — the in-app quick reference (UserGuide.jsx) and docs/USER_GUIDE.md §15
// are two hand-maintained key tables that claim to move together. This is the
// test that makes that claim enforceable: change a key in one file and this
// goes red, naming the mismatch.
//
// Direction asserted BOTH ways, but asymmetrically, on purpose:
//   1. Every combo the overlay shows must appear in §15 — this is the real
//      bug-catcher (the overlay promising a key the manual doesn't stand
//      behind). Asserted over ALL of §15's tables.
//   2. The reverse only for §15's "Tools" table: the overlay's stated job is
//      the key bindings an estimator needs mid-trace, and the tool keys are
//      that list — a new tool key documented in §15 must reach the overlay.
//      The rest of §15 (panels & fields, gallery/menu Esc variants, pinch) is
//      a DOCUMENTED superset the overlay deliberately omits, so equality
//      there would turn every legitimate §15 addition into a red build.
//
// Normalization (both sides funnel through the same canonicalizer):
// lowercase, backticks stripped, parentheticals dropped, "wheel" → "scroll"
// (§15 says `⇧`+wheel where the overlay says ⇧ scroll — same gesture),
// en-dash splits ranges (`1`–`9` → 1, 9), and glyph runs split from letters
// (the overlay stores ["⇧","D"], the markdown writes `⇧D`). Tokens are then
// partitioned into KEY tokens (single glyphs/letters/digits + the named keys)
// and WORD tokens (hold, click, scroll, drag, …). A §15 row matches an
// overlay combo iff the key tokens are EXACTLY equal and the overlay's word
// tokens are a subset of the row's — exact keys so that `D` cannot satisfy
// itself against the `⇧D` row, subset words so "Hold Space + drag" still
// matches [hold, Space].

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, DRAW, VIEW } from "../src/components/UserGuide.jsx";

const here = dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(join(here, "../../docs/USER_GUIDE.md"), "utf8");

const NAMED_KEYS = new Set(["esc", "space", "delete", "enter", "tab"]);
const GLYPHS = /[⇧⌘⌥⏎⌫?]/;

type Combo = { keys: string[]; words: string[]; raw: string };

function canonize(raw: string): Combo {
  const cleaned = raw
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\([^)]*\)/g, " ") // parentheticals are commentary, not keys
    .replace(/\bwheel\b/g, "scroll")
    .replace(/[–—]/g, " ") // en-dash range separator → token break
    .replace(/[+\-/]/g, " ")
    // split glyph runs from letters/digits: "⇧d" → "⇧ d"
    .replace(/([⇧⌘⌥⏎⌫?])/g, " $1 ");
  const keys: string[] = [];
  const words: string[] = [];
  for (const t of cleaned.split(/\s+/).filter(Boolean)) {
    if (t.length === 1 && (GLYPHS.test(t) || /[a-z0-9]/.test(t))) keys.push(t);
    else if (NAMED_KEYS.has(t)) keys.push(t);
    else words.push(t);
  }
  keys.sort();
  return { keys, words, raw: raw.trim() };
}

// Overlay side: each row is [comboTokens[], description]; the combo is the
// token array joined with spaces ("hold" and "M" are separate tokens).
const overlayCombos: Combo[] = [...TOOLS, ...DRAW, ...VIEW].map((row) =>
  canonize((row[0] as string[]).join(" "))
);

// §15 side: slice the section, take the first cell of every table body row,
// split " / " alternatives ("`⌫` / `Delete`" documents two keys) into
// separate combos.
const section15 = guide.slice(guide.indexOf("## 15."), guide.indexOf("## 16."));
assert.ok(section15.length > 0, "USER_GUIDE.md no longer has a §15 followed by §16 — update this test's slicing");

function tableCombos(md: string): Combo[] {
  return md
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|[\s|:-]+\|$/.test(l.trim()))
    .map((l) => l.split("|")[1]?.trim())
    .filter((c): c is string => !!c && !/^key\b|^key \/ action/i.test(c))
    .flatMap((cell) => cell.split(" / ").map(canonize));
}

const guideCombos = tableCombos(section15);
assert.ok(guideCombos.length >= 20, `parsed only ${guideCombos.length} combos from §15 — the table format likely changed`);

const matches = (overlay: Combo) => (row: Combo) =>
  overlay.keys.join(" ") === row.keys.join(" ") &&
  overlay.words.every((w) => row.words.includes(w));

test("every combo the overlay promises exists in USER_GUIDE.md §15", () => {
  for (const combo of overlayCombos) {
    assert.ok(
      guideCombos.some(matches(combo)),
      `overlay shows "${combo.raw}" but no §15 row documents it — if the binding changed, §15 and UserGuide.jsx move together`
    );
  }
});

test("every tool key in §15's Tools table reaches the overlay", () => {
  const toolsTable = section15.slice(section15.indexOf("### Tools"), section15.indexOf("### Conditions"));
  const toolRows = tableCombos(toolsTable);
  assert.ok(toolRows.length >= 10, `parsed only ${toolRows.length} rows from the §15 Tools table`);
  for (const row of toolRows) {
    assert.ok(
      overlayCombos.some(matches(row)),
      `§15 documents tool key "${row.raw}" but the overlay doesn't show it — add it to TOOLS (or VIEW) in UserGuide.jsx`
    );
  }
});
