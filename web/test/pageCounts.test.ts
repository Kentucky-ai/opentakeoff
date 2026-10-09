// The page-count cache (pageCounts.ts): nothing is written until the stored
// map has loaded, so an early count can't wipe the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageCounts, type PageCountMap } from "../src/lib/pageCounts.ts";

function setup(stored: unknown, fail = false) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const saves: PageCountMap[] = [];
  let shown: PageCountMap = {};
  const pc = createPageCounts({
    load: async () => { await gate; if (fail) throw new Error("idb"); return stored; },
    save: async (m) => { saves.push({ ...m }); },
    onChange: (m) => { shown = m; },
  });
  return { pc, saves, shown: () => shown, release };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a count learned before the stored map loads waits, then joins it", async () => {
  const t = setup({ "a.pdf": 3, "b.pdf": 5 });
  t.pc.remember("c.pdf", 2);
  assert.equal(t.saves.length, 0, "nothing written before the map has loaded");
  assert.equal(t.pc.hydrated(), false);
  t.release(); await tick();
  assert.deepEqual(t.shown(), { "a.pdf": 3, "b.pdf": 5, "c.pdf": 2 });
  assert.deepEqual(t.saves.at(-1), { "a.pdf": 3, "b.pdf": 5, "c.pdf": 2 });
  assert.equal(t.pc.hydrated(), true);
});

test("no stored map, or a failed read: hydrated anyway, empty", async () => {
  for (const [stored, fail] of [[undefined, false], [null, false], ["junk", false], [{}, true]] as const) {
    const t = setup(stored, fail);
    t.release(); await tick();
    assert.equal(t.pc.hydrated(), true);
    t.pc.remember("a.pdf", 4);
    assert.deepEqual(t.pc.get(), { "a.pdf": 4 });
  }
});

test("an unchanged count writes nothing; forget drops counts and early ones", async () => {
  const t = setup({ "a.pdf": 3 });
  t.pc.remember("x.pdf", 9);
  t.pc.forget(["x.pdf"]);
  t.release(); await tick();
  assert.deepEqual(t.pc.get(), { "a.pdf": 3 });
  const n = t.saves.length;
  t.pc.remember("a.pdf", 3);
  assert.equal(t.saves.length, n);
  t.pc.forget(["a.pdf"]);
  assert.deepEqual(t.pc.get(), {});
});
