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
import { classifyLayerName, layerNameTokens, layerRoleCodes, segRoles, ROLE_CODE, ROLE_HIDDEN, type LayerRole } from "../src/lib/layers.ts";

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
