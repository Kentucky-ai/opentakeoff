// Layer-name semantics (lib/layers.ts, #85). The invariants:
//   - only POSITIVE identifications earn a role — bare/degenerate names are
//     unknown (refusal over guessing: unknown costs nothing downstream);
//   - demolition beats boundary ("A-WALL-DEMO" traced as a wall is a wrong
//     number produced confidently), pattern beats boundary;
//   - xref prefixes, separator drift, and truncation all resolve;
//   - conforming AIA names grade higher confidence than bare words;
//   - hidden wins over any role in the code table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLayerName, layerNameTokens, layerRoleCodes, segRoles, buildLayerInfos, effectiveLayerRoles, sanitizeLayerOverrides, ROLE_CODE, ROLE_HIDDEN, type LayerRole } from "../src/lib/layers.ts";

const role = (name: string): LayerRole => classifyLayerName(name).role;

test("AIA core names classify to their stated roles", () => {
  assert.equal(role("A-WALL-FULL"), "boundary");
  assert.equal(role("A-WALL-PRHT"), "boundary");
  assert.equal(role("A-FLOR-OTLN"), "boundary");
  assert.equal(role("A-GLAZ"), "boundary");
  assert.equal(role("A-DOOR"), "boundary");
  assert.equal(role("A-FLOR-PATT"), "finish-pattern");
  assert.equal(role("A-ANNO-TEXT"), "annotation");
  assert.equal(role("A-ANNO-DIMS"), "annotation");
  assert.equal(role("A-GRID"), "annotation");
  assert.equal(role("S-COLS"), "structure");
  assert.equal(role("S-BEAM"), "structure");
  assert.equal(role("A-WALL-DEMO"), "demolition");
  assert.equal(role("A-FURN"), "annotation");
});

test("the precedence that prevents confident wrong numbers: DEMO and PATT beat WALL/FLOR", () => {
  assert.equal(role("A-WALL-DEMO"), "demolition");
  assert.equal(role("WALL-DEMO"), "demolition");
  assert.equal(role("A-FLOR-PATT"), "finish-pattern");
});

test("field variants: xref prefixes, bind separators, spaces, truncation, bare words", () => {
  assert.equal(role("ARCH-FLOOR|A-WALL-FULL"), "boundary", "xref path strips to the last pipe");
  assert.equal(role("XREF$0$A-WALL-FULL"), "boundary", "AutoCAD bind separator folds");
  assert.equal(role("A-WALL FULL HT"), "boundary", "spaces tokenize like dashes");
  assert.equal(role("A-WALL-1"), "boundary", "renumbered variant");
  assert.equal(role("WALL"), "boundary", "bare word still identifies…");
  assert.ok(classifyLayerName("WALL").confidence < classifyLayerName("A-WALL-FULL").confidence,
    "…but a conforming AIA name grades surer than a bare word");
});

test("the degenerate cases are unknown — the exporter flattened, nothing is stated", () => {
  for (const name of ["0", "", "Layer 1", "Layer1", "LAYER 12", "XYZ-99", "MISC"]) {
    assert.equal(role(name), "unknown", name);
  }
  assert.equal(classifyLayerName("0").confidence, 0);
});

test("layerNameTokens: strips xref path, folds $n$, uppercases, splits on any separator run", () => {
  assert.deepEqual(layerNameTokens("arch|A-Wall_full ht"), ["A", "WALL", "FULL", "HT"]);
  assert.deepEqual(layerNameTokens("X$2$S-COLS"), ["X", "S", "COLS"]);
  assert.deepEqual(layerNameTokens(""), []);
});

test("layerRoleCodes + segRoles: hidden wins over role; −1/unknown stay 0; all-unknown short-circuits to null", () => {
  const ids = ["w", "p", "d"];
  const info = new Map<string, { role: LayerRole; visible: boolean }>([
    ["w", { role: "boundary", visible: true }],
    ["p", { role: "finish-pattern", visible: true }],
    ["d", { role: "demolition", visible: false }],   // hidden beats demolition
  ]);
  const codes = layerRoleCodes(ids, info);
  assert.deepEqual([...codes], [ROLE_CODE.boundary, ROLE_CODE["finish-pattern"], ROLE_HIDDEN]);
  const roles = segRoles(Int32Array.from([0, 1, 2, -1]), codes)!;
  assert.deepEqual([...roles], [1, 2, ROLE_HIDDEN, 0]);
  // nothing classified → null, so buildMask takes the identical pre-#85 path
  assert.equal(segRoles(Int32Array.from([0, 1]), layerRoleCodes(["a", "b"], new Map())), null);
  assert.equal(segRoles(undefined, codes), null);
});

test("buildLayerInfos: joins ids + attribution to the document's declarations; undeclared ids refuse to classify", () => {
  const byId = new Map([
    ["oc1", { name: "A-WALL-FULL", visible: true }],
    ["oc2", { name: "A-WALL-DEMO", visible: false }],
  ]);
  const infos = buildLayerInfos(["oc1", "oc2", "oc9"], Int32Array.from([0, 0, 1, -1, 0]), byId);
  assert.equal(infos.length, 3);
  assert.deepEqual(infos[0], { id: "oc1", name: "A-WALL-FULL", role: "boundary", confidence: 0.9, visible: true, seg_count: 3 });
  assert.equal(infos[1].role, "demolition");
  assert.equal(infos[1].visible, false);
  assert.equal(infos[1].seg_count, 1);
  // a dangling /OC ref the catalog never declared: unknown role, visible, no name
  assert.deepEqual(infos[2], { id: "oc9", name: "", role: "unknown", confidence: 0, visible: true, seg_count: 0 });
  assert.deepEqual(buildLayerInfos([], undefined, byId), []);
});

test("effectiveLayerRoles: include forces hard boundary, exclude drops, stale ids no-op — the MCP filter semantics", () => {
  const infos = buildLayerInfos(["w", "p", "d"], Int32Array.from([0, 1, 2]), new Map([
    ["w", { name: "A-WALL-FULL", visible: true }],
    ["p", { name: "A-FLOR-PATT", visible: true }],
    ["d", { name: "A-WALL-DEMO", visible: false }],
  ]));
  // no overrides: the classified table verbatim
  const base = effectiveLayerRoles(infos);
  assert.deepEqual(base.get("p"), { role: "finish-pattern", visible: true });
  // include resurrects even a hidden demolition layer as hard boundary;
  // exclude hides whatever the name says; an id the sheet no longer carries is inert
  const ov = effectiveLayerRoles(infos, { d: "include", w: "exclude", gone: "exclude" });
  assert.deepEqual(ov.get("d"), { role: "boundary", visible: true });
  assert.deepEqual(ov.get("w"), { role: "boundary", visible: false });
  assert.equal(ov.has("gone"), false);
  // and through the code table: hidden-by-exclude wins over the boundary role
  const codes = layerRoleCodes(["w", "p", "d"], ov);
  assert.deepEqual([...codes], [ROLE_HIDDEN, ROLE_CODE["finish-pattern"], ROLE_CODE.boundary]);
});

test("sanitizeLayerOverrides: object-shape gate, value whitelist, else-clear on junk", () => {
  assert.deepEqual(sanitizeLayerOverrides(undefined), {});
  assert.deepEqual(sanitizeLayerOverrides(null), {});
  assert.deepEqual(sanitizeLayerOverrides([1, 2]), {});
  assert.deepEqual(sanitizeLayerOverrides("include"), {});
  assert.deepEqual(sanitizeLayerOverrides({
    "plan.pdf": { oc1: "include", oc2: "exclude", oc3: "banana", oc4: 7 },
    "scan.pdf#2": "exclude",           // per-sheet value must be an object
    "empty.pdf": { oc9: "nope" },      // sanitizes empty → the sheet key drops
  }), { "plan.pdf": { oc1: "include", oc2: "exclude" } });
});
