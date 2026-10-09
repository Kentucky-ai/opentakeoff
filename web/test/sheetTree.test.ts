// The Sheets panel's tree (sheetTree.ts): grouping, search, visible rows,
// focus after changes, and what each key does on a row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, filterTree, visibleRows, nextFocus, treeKey, rowTitle, type NavItem, type FolderNode, type SheetRow } from "../src/lib/sheetTree.ts";

const items: NavItem[] = [
  { key: "set.pdf", label: "set", file: "set.pdf", count: 2 },
  { key: "set.pdf#2", label: "set · 2", file: "set.pdf", count: 0, level: "L1" },
  { key: "set.pdf#3", label: "X1", file: "set.pdf", count: 1 },
  { key: "cover.pdf", label: "cover", file: "cover.pdf", count: 0 },
  { key: "new.pdf", label: "new", file: "new.pdf", count: 0 },
];
const numbers: Record<string, string | null> = { "set.pdf#1": "A-101", "set.pdf#2": null, "set.pdf#3": "A1-101", "cover.pdf#1": "G-001" };
const input = { items, countKnown: (f: string) => f !== "new.pdf", numberOf: (f: string, p: number) => numbers[`${f}#${p}`] };

test("multi-page files are folders, one-page files rows, unknown counts pending rows, in file order", () => {
  const t = buildTree(input);
  assert.deepEqual(t.map((n) => [n.kind, n.file]), [["folder", "set.pdf"], ["single", "cover.pdf"], ["pending", "new.pdf"]]);
  const f = t[0] as FolderNode;
  assert.equal(f.pages, 3);
  assert.equal(f.shapes, 3);
  assert.deepEqual(f.children.map((c) => [c.page, c.number, c.label, c.level]), [[1, "A-101", "set", ""], [2, null, "set · 2", "L1"], [3, "A1-101", "X1", ""]]);
});

test("a pending row keeps its slot when its count arrives", () => {
  const before = buildTree(input).map((n) => n.file);
  const after = buildTree({ ...input, countKnown: () => true, items: [...items, { key: "new.pdf#2", label: "new · 2", file: "new.pdf", count: 0 }] });
  assert.deepEqual(after.map((n) => n.file), before);
  assert.equal(after[2].kind, "folder");
});

test("search matches number, label and file name; folders with matches open, others hide", () => {
  const t = buildTree(input);
  let r = filterTree(t, "a1-101");
  assert.deepEqual(r.nodes.map((n) => n.file), ["set.pdf"]);
  assert.deepEqual((r.nodes[0] as FolderNode).children.map((c) => c.page), [3]);
  assert.deepEqual([...r.open], ["set.pdf"]);
  r = filterTree(t, "cover");
  assert.deepEqual(r.nodes.map((n) => n.file), ["cover.pdf"]);
  r = filterTree(t, "  ");
  assert.equal(r.nodes, t);
  r = filterTree(t, "zzz");
  assert.equal(r.nodes.length, 0);
});

test("a number that arrives during a search re-filters in place", () => {
  const later: Record<string, string | null> = { ...numbers, "set.pdf#2": "A-102" };
  const t = buildTree({ ...input, numberOf: (f: string, p: number) => later[`${f}#${p}`] });
  assert.deepEqual((filterTree(t, "a-102").nodes[0] as FolderNode).children.map((c) => c.page), [2]);
});

const t = buildTree(input);
const open = (f: string) => f === "set.pdf";
const rows = visibleRows(t, open);

test("visible rows: folders, then the pages of open ones", () => {
  assert.deepEqual(rows.map((r) => [r.id, r.depth]), [["f:set.pdf", 1], ["s:set.pdf", 2], ["s:set.pdf#2", 2], ["s:set.pdf#3", 2], ["s:cover.pdf", 1], ["s:new.pdf", 1]]);
  assert.equal(visibleRows(t, () => false).length, 3);
});

test("focus after a collapse goes to the folder; after a filter, to the nearest row", () => {
  const collapsed = visibleRows(t, () => false);
  assert.equal(nextFocus("s:set.pdf#3", rows, collapsed), 0);
  assert.equal(nextFocus("s:cover.pdf", rows, collapsed), 1);
  assert.equal(nextFocus("s:new.pdf", rows, collapsed.slice(0, 1)), 0);
  assert.equal(nextFocus("s:new.pdf", rows, []), -1);
});

test("arrows, Home and End move; Right opens then enters; Left closes then climbs", () => {
  assert.deepEqual(treeKey({ key: "ArrowDown" }, rows, 0, open), { swallow: true, move: 1 });
  assert.deepEqual(treeKey({ key: "ArrowUp" }, rows, 0, open), { swallow: true, move: 0 });
  assert.deepEqual(treeKey({ key: "End" }, rows, 0, open), { swallow: true, move: 5 });
  assert.deepEqual(treeKey({ key: "Home" }, rows, 4, open), { swallow: true, move: 0 });
  const closed = visibleRows(t, () => false);
  assert.deepEqual(treeKey({ key: "ArrowRight" }, closed, 0, () => false), { swallow: true, expand: "set.pdf" });
  assert.deepEqual(treeKey({ key: "ArrowRight" }, rows, 0, open), { swallow: true, move: 1 });
  assert.deepEqual(treeKey({ key: "ArrowLeft" }, rows, 0, open), { swallow: true, collapse: "set.pdf" });
  assert.deepEqual(treeKey({ key: "ArrowLeft" }, rows, 3, open), { swallow: true, move: 0 });
});

test("Enter and Space open a sheet or toggle a folder, whatever modifiers are held", () => {
  for (const mods of [{}, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.deepEqual(treeKey({ key: "Enter", ...mods }, rows, 2, open), { swallow: true, open: "set.pdf#2" });
    assert.deepEqual(treeKey({ key: " ", ...mods }, rows, 0, open), { swallow: true, toggle: "set.pdf" });
  }
});

test("Delete and Backspace are taken and do nothing, whatever modifiers are held", () => {
  for (const key of ["Delete", "Backspace"]) for (const mods of [{}, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }])
    assert.deepEqual(treeKey({ key, ...mods }, rows, 2, open), { swallow: true });
});

test("other unmodified keys are taken; Tab, Escape and Ctrl/⌘/Alt chords pass", () => {
  for (const key of ["v", "V", "1", "f", "a", "Shift"]) assert.deepEqual(treeKey({ key, shiftKey: key === "V" }, rows, 2, open), { swallow: true }, key);
  assert.deepEqual(treeKey({ key: "Tab" }, rows, 2, open), { swallow: false });
  assert.deepEqual(treeKey({ key: "Escape" }, rows, 2, open), { swallow: false });
  assert.deepEqual(treeKey({ key: "k", metaKey: true }, rows, 2, open), { swallow: false });
  assert.deepEqual(treeKey({ key: "z", ctrlKey: true }, rows, 2, open), { swallow: false });
});

test("while a schedule read holds keys, Enter and Space are left for it", () => {
  assert.deepEqual(treeKey({ key: "Enter" }, rows, 2, open, true), { swallow: false });
  assert.deepEqual(treeKey({ key: " " }, rows, 2, open, true), { swallow: false });
  assert.deepEqual(treeKey({ key: "Delete" }, rows, 2, open, true), { swallow: true });
});

test("a row's tooltip says when the tab shows something else", () => {
  const f = t[0] as FolderNode;
  assert.equal(rowTitle(f.children[0]), "Sheet A-101 — tab shows set · set.pdf");
  assert.equal(rowTitle({ ...f.children[2], label: "L1 · A1-101" } as SheetRow), "A1-101 · set.pdf");
  assert.equal(rowTitle(f.children[2]), "Sheet A1-101 — tab shows X1 · set.pdf");
  assert.equal(rowTitle(f.children[1]), "set · 2 · set.pdf");
});

test("a file name containing # still groups by page", () => {
  const its: NavItem[] = [
    { key: "plan#2.pdf", label: "plan#2", file: "plan#2.pdf", count: 0 },
    { key: "plan#2.pdf#2", label: "plan#2 · 2", file: "plan#2.pdf", count: 0 },
  ];
  const f = buildTree({ items: its, countKnown: () => true, numberOf: (_f, p) => `A-${p}` })[0] as FolderNode;
  assert.deepEqual(f.children.map((c) => [c.page, c.number]), [[1, "A-1"], [2, "A-2"]]);
});

test("a 5,000-sheet set builds, filters and lists quickly", () => {
  const big: NavItem[] = [];
  for (let f = 0; f < 100; f++) for (let p = 1; p <= 50; p++) big.push({ key: p > 1 ? `f${f}.pdf#${p}` : `f${f}.pdf`, label: `f${f} · ${p}`, file: `f${f}.pdf`, count: 0 });
  const a = performance.now();
  const tr = buildTree({ items: big, countKnown: () => true, numberOf: (f, p) => `${f}-${p}` });
  visibleRows(filterTree(tr, "f7").nodes, () => true);
  visibleRows(tr, () => true);
  assert.ok(performance.now() - a < 100, `${(performance.now() - a).toFixed(1)} ms`);
});

test("after a revision, unnumbered rows say file · page instead of the old tab label", () => {
  const tr = buildTree({ ...input, stale: (f: string) => f === "set.pdf", numberOf: (f: string, p: number) => (f === "set.pdf" && p === 1 ? "A-101" : undefined) });
  const f = tr[0] as FolderNode;
  assert.deepEqual(f.children.map((c) => [c.number, c.label]), [["A-101", "set"], [null, "L1 · set · 2"], [null, "set · 3"]]);
});
