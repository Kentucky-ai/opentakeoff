// Saved report templates (issue #114) — named bundles of column-visibility +
// grouping, persisted per-user in localStorage (mirrors identity.js / the report
// prefs). Invariants: quota/private-mode safe (no localStorage → [] / no throw),
// sanitize + dedupe-by-name on load, save-as overwrites a same-name template
// (keeping its id), delete/rename by id, round-trip through the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTemplates, loadTemplates, saveTemplate, deleteTemplate, renameTemplate } from "../src/lib/reportTemplates.js";

// ── sanitizeTemplates (pure) ─────────────────────────────────────────────────

test("sanitizeTemplates: non-array → []", () => {
  for (const raw of [undefined, null, 42, "x", {}]) assert.deepEqual(sanitizeTemplates(raw), [], String(raw));
});

test("sanitizeTemplates: drops malformed items; coerces missing cols/groupBy", () => {
  const out = sanitizeTemplates([
    { id: "t1", name: "By division", cols: { csv: true }, groupBy: "col-a" },
    { id: "t2", name: "Bare" },                       // missing cols/groupBy → coerced
    { name: "no id" },                                // no id → dropped
    { id: "t3", name: "" },                           // empty name → dropped
    { id: 7, name: "numeric id" },                    // non-string id → dropped
    "nope",                                            // not an object → dropped
  ]);
  assert.deepEqual(out, [
    { id: "t1", name: "By division", cols: { csv: true }, groupBy: "col-a" },
    { id: "t2", name: "Bare", cols: {}, groupBy: "" },
  ]);
});

test("sanitizeTemplates: dedupes by name (first wins) — names key the list UI", () => {
  const out = sanitizeTemplates([
    { id: "t1", name: "Phase view", cols: {}, groupBy: "label" },
    { id: "t2", name: "Phase view", cols: { csv: false }, groupBy: "sheet" },
  ]);
  assert.deepEqual(out.map((t) => t.id), ["t1"]);
});

test("sanitizeTemplates: name is trimmed", () => {
  const [t] = sanitizeTemplates([{ id: "t1", name: "  Trimmed  ", cols: {}, groupBy: "" }]);
  assert.equal(t.name, "Trimmed");
});

// ── localStorage-backed load/save/delete/rename ──────────────────────────────

test("no localStorage (node env): loadTemplates → [], mutations don't throw", () => {
  assert.equal(typeof globalThis.localStorage, "undefined");
  assert.deepEqual(loadTemplates(), []);
  assert.doesNotThrow(() => saveTemplate("X", { csv: true }, "sheet"));   // quota/absent swallowed
  assert.doesNotThrow(() => deleteTemplate("nope"));
});

function withMockStorage(fn: () => void) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  try { fn(); } finally { delete (globalThis as any).localStorage; }
}

test("save → load round-trip; save-as overwrites a same-name template (keeps id)", () => {
  withMockStorage(() => {
    let list = saveTemplate("Ordering view", { csv: true, json: false }, "sheet");
    assert.equal(list.length, 1);
    const id = list[0].id;
    assert.deepEqual(loadTemplates(), list);                       // persisted + reloads identical
    // save-as with the same name overwrites in place, keeping the id
    list = saveTemplate("Ordering view", { csv: false }, "label");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);                                  // same template, updated
    assert.deepEqual(list[0].cols, { csv: false });
    assert.equal(list[0].groupBy, "label");
    // a different name appends
    list = saveTemplate("Phase view", {}, "label");
    assert.deepEqual(list.map((t: any) => t.name), ["Ordering view", "Phase view"]);
  });
});

test("delete by id; rename by id", () => {
  withMockStorage(() => {
    saveTemplate("A", {}, "");
    let list = saveTemplate("B", {}, "sheet");
    const bId = list.find((t: any) => t.name === "B")!.id;
    list = renameTemplate(bId, "B renamed");
    assert.equal(list.find((t: any) => t.id === bId)!.name, "B renamed");
    list = deleteTemplate(bId);
    assert.deepEqual(list.map((t: any) => t.name), ["A"]);
    assert.deepEqual(loadTemplates().map((t: any) => t.name), ["A"]);   // persisted
  });
});

test("rename to an EXISTING name is a no-op — never persist a same-name pair (would drop one on reload)", () => {
  withMockStorage(() => {
    saveTemplate("A", {}, "");
    let list = saveTemplate("B", { csv: false }, "sheet");
    const bId = list.find((t: any) => t.name === "B")!.id;
    // rename B → "A" (taken by another id): rejected, B keeps its name
    list = renameTemplate(bId, "A");
    assert.deepEqual(list.map((t: any) => t.name), ["A", "B"]);
    assert.deepEqual(loadTemplates().map((t: any) => t.name), ["A", "B"]);   // both survive a reload
    // renaming to a FREE name still works
    list = renameTemplate(bId, "B2");
    assert.equal(list.find((t: any) => t.id === bId)!.name, "B2");
  });
});

test("empty/whitespace name is a no-op save (can't create a nameless template)", () => {
  withMockStorage(() => {
    assert.deepEqual(saveTemplate("   ", {}, ""), []);
    assert.deepEqual(loadTemplates(), []);
  });
});
