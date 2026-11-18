// Assemblies (lib/assemblies.js): a condition's items saved as a recipe and
// applied to another condition. Recipes only — never a price, a library link or
// a twin's family bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assemblyItem, sanitizeAssemblies, conditionToAssembly, assemblyRows,
  loadAssemblies, saveAssemblies, ASSEMBLY_STORAGE_KEY,
} from "../src/lib/assemblies.js";
import { conditionTotals } from "../src/lib/totals.js";

let n = 0;
const mint = (p: string) => `${p}-${++n}`;
const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const cnt = (id: string) => ({ condition_id: id, measure_role: "count", computed: { count: 1 } });

const source = {
  id: "src", finish_tag: "LVT-1",
  materials: [
    { id: "m1", name: "Primer", per: 150, basis: "area", unit: "gal", waste_pct: 10, price: 25, labor_price: 1, lib_id: "lib-1", inherited: true, origin_id: "p-1" },
    { id: "m2", name: "Floor box plate", rule: "each", per: 1, basis: "count", unit: "ea", price: 4 },
    { id: "m3", name: "", per: 1 },   // unnamed row: not a material line
    { id: "m4", name: "Grout", per: 512, basis: "area", unit: "bag", kind: "grout", grout: { tileL: 24, tileW: 12 } },
  ],
};

test("assemblyItem keeps the recipe and drops prices, ids, links and family state", () => {
  assert.deepEqual(assemblyItem(source.materials[0]), { name: "Primer", unit: "gal", per: 150, basis: "area", round: true, note: "", waste_pct: 10 });
  assert.deepEqual(assemblyItem(source.materials[1]), { name: "Floor box plate", unit: "ea", per: 1, basis: "count", round: true, note: "", rule: "each" });
  assert.equal(assemblyItem(source.materials[2]), null);
  assert.deepEqual(assemblyItem({ name: "X", per: -3, basis: "bogus", rule: "nope", waste_pct: "abc" }), { name: "X", unit: "", per: 0, basis: "area", round: true, note: "" });
  const g = assemblyItem(source.materials[3]) as any;
  assert.notEqual(g.grout, source.materials[3].grout);   // deep copy, never shared
  assert.deepEqual(g.grout, { tileL: 24, tileW: 12 });
});

test("conditionToAssembly saves the named items; nothing to save is null", () => {
  const a = conditionToAssembly(source, "  LVT glue-down  ", "asm-1")!;
  assert.equal(a.name, "LVT glue-down");
  assert.deepEqual(a.items.map((i: any) => i.name), ["Primer", "Floor box plate", "Grout"]);
  assert.ok(a.items.every((i: any) => !("price" in i) && !("labor_price" in i) && !("id" in i) && !("lib_id" in i)));
  assert.equal(conditionToAssembly({ materials: [{ name: "" }] }, "x", "asm-2"), null);
  assert.equal(conditionToAssembly(source, "   ", "asm-3"), null);
});

test("sanitizeAssemblies: ids unique (first wins), visible name, at least one valid item", () => {
  const out = sanitizeAssemblies([
    { id: "a", name: "One", items: [{ name: "Primer", per: 150 }] },
    { id: "a", name: "Dup", items: [{ name: "Other", per: 1 }] },
    { id: "", name: "No id", items: [{ name: "x" }] },
    { id: "b", name: "  ", items: [{ name: "x" }] },
    { id: "c", name: "Empty", items: [{ name: "" }, 3, null] },
    "junk",
  ]);
  assert.deepEqual(out.map((a: any) => a.id), ["a"]);
  assert.deepEqual(sanitizeAssemblies({}), []);
});

test("applying an assembly mints fresh rows, skips names the condition has, and measures the same on the new condition", () => {
  const a = conditionToAssembly(source, "LVT glue-down", "asm-1")!;
  const target = { id: "t", finish_tag: "LVT-2", waste_pct: 0, materials: [{ id: "x1", name: "primer", per: 300, basis: "area", unit: "gal" }] };
  const { rows, skipped } = assemblyRows(a, mint, target.materials);
  assert.deepEqual(skipped, ["Primer"]);   // case-insensitive: the target already buys primer
  assert.deepEqual(rows.map((r: any) => r.name), ["Floor box plate", "Grout"]);
  assert.ok(rows.every((r: any) => /^mat-\d+$/.test(r.id) && r.round === true));
  assert.notEqual((rows[1] as any).grout, (a.items[2] as any).grout);
  // a fresh condition gets every item, and its quantities follow its own measurements
  const fresh = { id: "f", finish_tag: "LVT-3", materials: assemblyRows(a, mint).rows };
  const [row] = conditionTotals([fresh], [area("f", 1500), cnt("f"), cnt("f")]);
  assert.deepEqual(row.materials.map((m: any) => [m.name, m.qty]), [["Primer", 11], ["Floor box plate", 2], ["Grout", 3]]);   // 1500/150 × 1.1 = 11
});

test("the library round-trips through localStorage and survives corrupt storage", () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); } };
  try {
    assert.deepEqual(loadAssemblies(), []);
    assert.equal(saveAssemblies([conditionToAssembly(source, "LVT glue-down", "asm-1"), { id: "bad" }]), true);
    const back = loadAssemblies();
    assert.deepEqual(back.map((a: any) => [a.id, a.name, a.items.length]), [["asm-1", "LVT glue-down", 3]]);
    assert.ok(!mem.get(ASSEMBLY_STORAGE_KEY)!.includes("price"));   // nothing priced is ever stored
    mem.set(ASSEMBLY_STORAGE_KEY, "{not json");
    assert.deepEqual(loadAssemblies(), []);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
