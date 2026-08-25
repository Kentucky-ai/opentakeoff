// Stamp library (#40) — the load gate + the pure placement math. The
// `stamp_library` meta record is browser-global (the app's first cross-project
// asset), so one corrupt item would otherwise wedge the palette and its
// seeding for EVERY project. The invariants:
//   - non-object records sanitize to { stamps: [], sets: [] };
//   - stamps need a non-empty string id (dedup, first-wins) AND a visible name;
//     elements is always an array of plain objects;
//   - sets need a string id (dedup); stampIds is an array of strings;
//   - unknown fields pass through (the scale_source precedent), so a valid
//     library survives the save → load round-trip unchanged;
//   - instantiateStamp translates element OFFSETS by the click point and drops
//     malformed elements; markupToStampElement is its per-element inverse;
//   - seedStampLibrary only seeds a TRULY empty library.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeStampLibrary, instantiateStamp, markupToStampElement, seedStampLibrary,
  DEFAULT_STAMPS, DEFAULT_STAMP_SETS,
  BUILT_IN_STAMP_IDS, stampDisplayName,
} from "../src/lib/stamps.js";
import { store } from "../src/lib/store.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// A well-formed library shaped like a saved one: one arrow stamp, one compound
// approval stamp, and a set referencing both.
const lib = () => ({
  stamps: [
    { id: "a", name: "Arrow", elements: [{ type: "arrow", from: [-0.05, 0], to: [0.05, 0], color: "#1f3fc7" }] },
    { id: "b", name: "APPROVED", elements: [{ type: "highlight", rect: [[-0.04, -0.02], [0.04, 0.02]], text: "APPROVED" }] },
  ],
  sets: [{ id: "s1", name: "Set one", stampIds: ["a", "b"] }],
});

// ── sanitizeStampLibrary ─────────────────────────────────────────────────────

test("round-trip: a valid library sanitizes unchanged (deep-equal)", () => {
  const saved = lib();
  assert.deepEqual(sanitizeStampLibrary(JSON.parse(JSON.stringify(saved))), saved);
});

test("non-object records sanitize to the empty library", () => {
  for (const raw of [undefined, null, 42, "x", [], [{ id: "a" }]]) {
    assert.deepEqual(sanitizeStampLibrary(raw), { stamps: [], sets: [] }, String(raw));
  }
});

test("stamps without a string id or a visible name are dropped", () => {
  const raw = {
    stamps: [
      ...lib().stamps,
      { name: "no id" },                    // missing id
      { id: "", name: "empty id" },         // empty id
      { id: "c" },                          // missing name
      { id: "d", name: "   " },             // blank name
      "nope",                               // primitive
    ],
    sets: [],
  };
  assert.deepEqual(sanitizeStampLibrary(raw).stamps.map((s: any) => s.id), ["a", "b"]);
});

test("duplicate stamp ids: first wins (matLib precedent)", () => {
  const raw = { stamps: [{ id: "a", name: "first" }, { id: "a", name: "second" }], sets: [] };
  const out = sanitizeStampLibrary(raw).stamps;
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "first");
});

test("elements is coerced to an array of plain objects", () => {
  const raw = { stamps: [{ id: "a", name: "A", elements: [{ type: "text", at: [0, 0] }, null, 7, "x", [1, 2]] }], sets: [] };
  assert.deepEqual(sanitizeStampLibrary(raw).stamps[0].elements, [{ type: "text", at: [0, 0] }]);
  // a stamp with no/invalid elements array becomes []
  assert.deepEqual(sanitizeStampLibrary({ stamps: [{ id: "b", name: "B", elements: 5 }], sets: [] }).stamps[0].elements, []);
});

test("sets need a string id (dedup) and coerce stampIds to a string array", () => {
  const raw = {
    stamps: [],
    sets: [
      { id: "s1", name: "ok", stampIds: ["a", 7, null, "b"] },
      { name: "no id" },
      { id: "s1", name: "dup" },
    ],
  };
  const sets = sanitizeStampLibrary(raw).sets;
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].stampIds, ["a", "b"]);
});

test("unknown fields pass through (a future field survives save → load)", () => {
  const raw = { stamps: [{ id: "a", name: "A", elements: [], future: { x: 1 } }], sets: [], meta: 9, schema: "opentakeoff.stamp_library.v1" } as any;
  const out = sanitizeStampLibrary(raw) as any;
  assert.deepEqual(out.stamps[0].future, { x: 1 });   // element-level passthrough
  assert.equal(out.meta, 9);                           // top-level passthrough (the round-trip contract)
  assert.equal(out.schema, "opentakeoff.stamp_library.v1");
});

// ── instantiateStamp ─────────────────────────────────────────────────────────

test("instantiateStamp translates every element's offsets by the click point", () => {
  const stamp = {
    id: "n", name: "North", elements: [
      { type: "arrow", from: [0, 0.045], to: [0, -0.045], color: "#000" },
      { type: "text", at: [-0.006, -0.055], text: "N" },
    ],
  };
  const out = instantiateStamp(stamp, [0.5, 0.5]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { color: "#000", type: "arrow", from: [0.5, 0.545], to: [0.5, 0.455], text: "" });
  assert.deepEqual(out[1], { type: "text", at: [0.494, 0.445], text: "N" });
});

test("instantiateStamp resolves a bubble radius and flags a prompt element", () => {
  const stamp = { id: "d", name: "Detail", elements: [{ type: "bubble", at: [0, 0], r: 0.022, text: "", prompt: true }] };
  const [b] = instantiateStamp(stamp, [0.2, 0.3]) as any[];
  assert.deepEqual(b.at, [0.2, 0.3]);
  assert.equal(b.r, 0.022);
  assert.equal(b._prompt, true);
});

test("instantiateStamp drops malformed elements but keeps the good ones", () => {
  const stamp = {
    id: "x", name: "X", elements: [
      { type: "arrow", from: [0, 0] },                  // missing `to`
      { type: "bubble" },                                // missing `at`
      { type: "text", at: [0.01, 0], text: "ok" },      // good
    ],
  };
  const out = instantiateStamp(stamp, [0, 0]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).text, "ok");
});

// ── markupToStampElement (the per-element inverse) ───────────────────────────

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("markupToStampElement re-expresses coords as anchor-relative offsets", () => {
  // a placed arrow whose midpoint is (0.5,0.5) → element centered on the origin
  const el: any = markupToStampElement({ type: "arrow", from: [0.45, 0.5], to: [0.55, 0.5], color: "#1f3fc7" });
  assert.equal(el.type, "arrow");
  assert.equal(el.color, "#1f3fc7");
  near(el.from[0], -0.05); near(el.from[1], 0);
  near(el.to[0], 0.05); near(el.to[1], 0);
});

test("place → save → place is position independent (round-trip through the origin)", () => {
  const stamp = { id: "a", name: "A", elements: [{ type: "arrow", from: [-0.05, 0], to: [0.05, 0] }] };
  const placed = instantiateStamp(stamp, [0.7, 0.3])[0];   // dropped somewhere
  const el = markupToStampElement(placed);                 // saved back to a stamp
  const replaced: any = instantiateStamp({ id: "b", name: "B", elements: [el!] }, [0.1, 0.9])[0];
  // geometry (the from→to vector) is preserved regardless of where it was placed
  near(replaced.to[0] - replaced.from[0], 0.1);
  near(replaced.to[1] - replaced.from[1], 0);
});

test("markupToStampElement returns null for a markup with no usable geometry", () => {
  assert.equal(markupToStampElement({ type: "arrow" } as any), null);
  assert.equal(markupToStampElement(null as any), null);
});

// ── svg element (a vector path) ──────────────────────────────────────────────

const svgEl = () => ({ type: "svg", path: "M0 0 L10 0 L10 10 Z", vb: [10, 10], at: [0.02, -0.03], w: 0.12, color: "#0d9488", fill: "#eee" });

test("instantiateStamp translates an svg element's at and carries path/vb/w/fill", () => {
  const stamp = { id: "v", name: "V", elements: [svgEl()] };
  const [s] = instantiateStamp(stamp, [0.5, 0.5]) as any[];
  assert.equal(s.type, "svg");
  assert.equal(s.path, "M0 0 L10 0 L10 10 Z");
  assert.deepEqual(s.vb, [10, 10]);
  assert.equal(s.w, 0.12);
  assert.equal(s.fill, "#eee");
  assert.equal(s.color, "#0d9488");
  assert.deepEqual(s.at, [0.52, 0.47]);
});

test("instantiateStamp defaults svg fill to none and w to 0.08 when omitted/invalid", () => {
  const stamp = { id: "v", name: "V", elements: [{ type: "svg", path: "M0 0 L1 1", vb: [1, 1], at: [0, 0], w: 0 }] };
  const [s] = instantiateStamp(stamp, [0.2, 0.3]) as any[];
  assert.equal(s.fill, "none");
  assert.equal(s.w, 0.08);
});

test("instantiateStamp drops an svg element with no path (or missing vb/at)", () => {
  const stamp = {
    id: "v", name: "V", elements: [
      { type: "svg", vb: [1, 1], at: [0, 0] },              // missing path
      { type: "svg", path: "M0 0", at: [0, 0] },            // missing vb
      { type: "svg", path: "M0 0", vb: [1, 1] },            // missing at
    ],
  };
  assert.equal(instantiateStamp(stamp, [0.5, 0.5]).length, 0);
});

test("REGRESSION: an svg element instantiates as type 'svg', NOT mis-routed to text", () => {
  // svg has a valid `at`; without its own branch the text default would claim it.
  const stamp = { id: "v", name: "V", elements: [svgEl()] };
  const [s] = instantiateStamp(stamp, [0.5, 0.5]) as any[];
  assert.equal(s.type, "svg");
  assert.notEqual(s.type, "text");
});

test("svg place → markupToStampElement → place preserves path/vb/w and re-centers at", () => {
  const stamp = { id: "v", name: "V", elements: [svgEl()] };
  const placed: any = instantiateStamp(stamp, [0.7, 0.3])[0];   // dropped somewhere
  const el: any = markupToStampElement(placed);                 // saved back to a stamp
  assert.equal(el.type, "svg");
  assert.equal(el.path, "M0 0 L10 0 L10 10 Z");
  assert.deepEqual(el.vb, [10, 10]);
  assert.equal(el.w, 0.12);
  assert.equal(el.fill, "#eee");
  assert.deepEqual(el.at, [0, 0]);   // re-centered (position independent)
  const replaced: any = instantiateStamp({ id: "b", name: "B", elements: [el] }, [0.1, 0.9])[0];
  assert.deepEqual(replaced.at, [0.1, 0.9]);   // back to the click point
});

test("markupToStampElement returns null for an svg markup with no path", () => {
  assert.equal(markupToStampElement({ type: "svg" } as any), null);
  assert.equal(markupToStampElement({ type: "svg", vb: [1, 1], at: [0, 0] } as any), null);
});

test("sanitizeStampLibrary passes an svg element through unchanged (unknown fields ride)", () => {
  const raw = { stamps: [{ id: "v", name: "V", elements: [svgEl()] }], sets: [] };
  assert.deepEqual(sanitizeStampLibrary(JSON.parse(JSON.stringify(raw))).stamps[0].elements, [svgEl()]);
});

// ── seedStampLibrary ─────────────────────────────────────────────────────────

test("seedStampLibrary seeds ONLY a truly empty library", () => {
  const empty = seedStampLibrary({ stamps: [], sets: [] });
  assert.equal(empty.stamps.length, DEFAULT_STAMPS.length);
  assert.equal(empty.sets.length, DEFAULT_STAMP_SETS.length);
  // a non-empty library is returned as-is (sanitized), not replaced
  const mine = { stamps: [{ id: "z", name: "Mine", elements: [] }], sets: [] };
  assert.deepEqual(seedStampLibrary(mine).stamps.map((s: any) => s.id), ["z"]);
});

test("seedStampLibrary deep-clones the defaults (mutating the result can't corrupt the module constant)", () => {
  const a = seedStampLibrary(null);
  a.stamps[0].name = "MUTATED";
  assert.notEqual(DEFAULT_STAMPS[0].name, "MUTATED");
});

test("every default stamp instantiates into at least one placeable markup", () => {
  for (const s of DEFAULT_STAMPS) {
    assert.ok(instantiateStamp(s, [0.5, 0.5]).length >= 1, s.id);
  }
});

// ── store round-trip (the load gate is wired) ────────────────────────────────

test("store.saveStampLibrary → loadStampLibrary round-trips a valid library", async () => {
  const saved = lib();
  await store.saveStampLibrary(saved);
  assert.deepEqual(await store.loadStampLibrary(), saved);
});

test("store.loadStampLibrary sanitizes a corrupt record to the empty library", async () => {
  // write a malformed record straight to the meta store, bypassing the sanitizer
  await store.saveAnnotations({ conditions: [] } as any);   // ensures the DB + meta store exist
  await store.saveStampLibrary({ stamps: "boom", sets: null } as any);
  const out = await store.loadStampLibrary();
  assert.deepEqual(out, { stamps: [], sets: [] });
});

// ── stampDisplayName (shared i18n helper) ────────────────────────────────────

// Stub `t` that returns the key itself — makes the test locale-agnostic while
// still verifying the dispatch logic (built-in id → key, custom → raw name).
const fakeT = (key: string) => key;

test("stampDisplayName returns the i18n key for every built-in stamp id", () => {
  for (const s of DEFAULT_STAMPS) {
    const expected = BUILT_IN_STAMP_IDS.get(s.id);
    assert.ok(expected, `BUILT_IN_STAMP_IDS has entry for ${s.id}`);
    assert.equal(stampDisplayName(s, fakeT), expected, s.id);
  }
});

test("stampDisplayName returns the raw .name for custom / imported stamps", () => {
  const custom = { id: "user-arrow", name: "My Custom Arrow", elements: [] };
  assert.equal(stampDisplayName(custom, fakeT), "My Custom Arrow");
});

test("stampDisplayName returns empty string for null / undefined stamp", () => {
  assert.equal(stampDisplayName(null as any, fakeT), "");
  assert.equal(stampDisplayName(undefined as any, fakeT), "");
});

test("REGRESSION: built-in stamp status message uses localized name, not English fallback", () => {
  // Simulates the TakeoffCanvas status-bar path: placeStamp calls
  //   t('status.placed_stamp', { name: stampDisplayName(armedStamp, t) })
  // Verify the name reaching the interpolation is the i18n key (which `t`
  // resolves to the locale string at runtime), NOT the raw English `.name`.
  const armed = DEFAULT_STAMPS.find((s) => s.id === "stmp-direction")!;
  const name = stampDisplayName(armed, fakeT);
  // English fallback would be "Plank / tile direction"; localized should be the key
  assert.notEqual(name, armed.name, "must not be the raw English name");
  assert.equal(name, "stamp.stmp_direction", "must be the i18n key for pt-BR/en resolution");
});

test("BUILT_IN_STAMP_IDS covers all DEFAULT_STAMPS and no extra entries", () => {
  const defaultIds = DEFAULT_STAMPS.map((s) => s.id).sort();
  const mapIds = [...BUILT_IN_STAMP_IDS.keys()].sort();
  assert.deepEqual(mapIds, defaultIds, "every default stamp has a localization entry and vice versa");
});
