// Shape-level phase/area labels (issue #110) — the data-model half, the
// shape-level analogue of conditionColumns. The invariants under test:
//   - a well-formed shape_labels vocabulary (a FLAT string list, not the
//     {id,name,values} column shape) survives the save → JSON → hydrate
//     round-trip unchanged (sanitizeShapeLabels is hydrate's gate);
//   - hydrate defensiveness: non-array → [], non-string/empty/whitespace
//     values dropped, dupes deduped (first wins), visible strings kept untrimmed;
//   - shapeLabelValue is the one assigned-value rule — visible string or "";
//   - sanitizeShapeLabelsOnShapes hydrates per-shape defensively but preserves
//     object identity everywhere it can (the shapes array is large; a new
//     reference forces a React re-render);
//   - renameShapeLabel rewrites exact matches only — other shapes keep identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeShapeLabels, shapeLabelValue, sanitizeShapeLabelsOnShapes, renameShapeLabel, assignShapeLabel } from "../src/lib/shapeLabels.js";

const vocab = () => ["Phase 1", "Phase 2", "Level 1 — Slab"];   // untrimmed em-dash content is legal

// ── sanitizeShapeLabels ──────────────────────────────────────────────────────

test("round-trip: a saved shape_labels vocabulary hydrates unchanged", () => {
  const saved = vocab();
  const hydrated = sanitizeShapeLabels(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(hydrated, saved);
});

test("non-array payloads hydrate to []", () => {
  for (const raw of [undefined, null, 42, "Phase 1", {}, { 0: "Phase 1" }]) {
    assert.deepEqual(sanitizeShapeLabels(raw), [], String(raw));
  }
});

test("vocabulary drops non-strings, empties, whitespace-only; dedupes; keeps untrimmed visible strings", () => {
  const out = sanitizeShapeLabels(["Phase 1", 3, null, { v: "x" }, "", "  ", "Phase 1", " Phase 2 "]);
  assert.deepEqual(out, ["Phase 1", " Phase 2 "]);   // dupe dropped, whitespace-padded string kept untrimmed
});

test("dedupe keeps the first occurrence", () => {
  assert.deepEqual(sanitizeShapeLabels(["a", "b", "a", "b", "c"]), ["a", "b", "c"]);
});

// ── shapeLabelValue ──────────────────────────────────────────────────────────

test("shapeLabelValue: the one assigned-value rule — visible string or empty", () => {
  assert.equal(shapeLabelValue({ label: "Phase 1" }), "Phase 1");
  assert.equal(shapeLabelValue({ label: " Phase 2 " }), " Phase 2 ");   // visible content — returned untrimmed
  assert.equal(shapeLabelValue({ label: "" }), "");                     // empty
  assert.equal(shapeLabelValue({ label: "   " }), "");                  // whitespace-only
  assert.equal(shapeLabelValue({ label: 42 }), "");                     // non-string
  assert.equal(shapeLabelValue({ label: null }), "");
  assert.equal(shapeLabelValue({}), "");                                // absent
  assert.equal(shapeLabelValue(undefined), "");                        // no shape at all
});

// ── sanitizeShapeLabelsOnShapes ──────────────────────────────────────────────

test("sanitizeShapeLabelsOnShapes: non-array → []", () => {
  assert.deepEqual(sanitizeShapeLabelsOnShapes("nope" as any), []);
  assert.deepEqual(sanitizeShapeLabelsOnShapes(undefined as any), []);
});

test("a shape with NO label passes through by identity — no new object", () => {
  const s = { id: "s1", kind: "poly", points: [1, 2, 3, 4] };
  const [out] = sanitizeShapeLabelsOnShapes([s]);
  assert.equal(out, s);   // same reference — no re-render churn
});

test("a shape with a visible label passes through by identity", () => {
  const s = { id: "s2", kind: "poly", label: " Phase 2 " };   // padded but visible → kept, untrimmed
  const [out] = sanitizeShapeLabelsOnShapes([s]);
  assert.equal(out, s);
});

test("a shape with an invalid label gets a new object with label removed, other fields intact", () => {
  for (const bad of [42, "", "   ", null]) {
    const s = { id: "s3", kind: "poly", points: [0, 0], label: bad };
    const [out] = sanitizeShapeLabelsOnShapes([s]);
    assert.notEqual(out, s);                          // new object (label was rewritten)
    assert.equal("label" in out, false, String(bad)); // the key is gone, not just falsy
    assert.equal(out.id, "s3");
    assert.equal(out.kind, "poly");
    assert.deepEqual(out.points, [0, 0]);
  }
});

// ── renameShapeLabel ─────────────────────────────────────────────────────────

const shapes = () => [
  { id: "s1", kind: "poly", label: "Phase 1" },
  { id: "s2", kind: "poly", label: "Phase 2" },
  { id: "s3", kind: "line" },                     // no label at all
];

test("rename rewrites exact matches to a new object", () => {
  const out = renameShapeLabel(shapes(), "Phase 1", "Phase 1A");
  assert.equal(out[0].label, "Phase 1A");   // matched → rewritten
  assert.equal(out[1].label, "Phase 2");    // other value untouched
  assert.equal(out[0].kind, "poly");        // rest of the shape intact
});

test("rename leaves non-matching shapes with their object identity", () => {
  const input = shapes();
  const out = renameShapeLabel(input, "Phase 1", "Phase 1A");
  assert.notEqual(out[0], input[0]);   // rewritten → new object (React re-render)
  assert.equal(out[1], input[1]);      // untouched → same reference
  assert.equal(out[2], input[2]);      // labelless shape untouched
});

// ── assignShapeLabel (single-shape reassign, #111) ───────────────────────────

test("assign sets the label on the matching shape only; others keep identity", () => {
  const input = shapes();
  const out = assignShapeLabel(input, "s2", "East Wing");
  assert.equal(out[1].label, "East Wing");   // matched → set
  assert.notEqual(out[1], input[1]);          // new object (re-render)
  assert.equal(out[0], input[0]);             // untouched → identity
  assert.equal(out[2], input[2]);
  assert.equal(out[1].kind, "poly");          // other fields intact
});

test("assign an empty/whitespace/nullish value CLEARS the label (removes the key)", () => {
  for (const clear of ["", "   ", null, undefined]) {
    const out = assignShapeLabel(shapes(), "s1", clear);
    assert.equal("label" in out[0], false, String(clear));   // key gone, not just falsy
    assert.equal(out[0].id, "s1");
    assert.equal(out[0].kind, "poly");                        // rest intact
  }
});

test("clearing an already-unlabeled shape keeps its identity (no needless clone)", () => {
  const input = shapes();
  const out = assignShapeLabel(input, "s3", "");   // s3 has no label
  assert.equal(out[2], input[2]);
});

test("a non-matching id leaves every shape untouched by identity", () => {
  const input = shapes();
  const out = assignShapeLabel(input, "nope", "East Wing");
  for (let i = 0; i < out.length; i++) assert.equal(out[i], input[i]);
});

// ── omit-when-empty (buildPayload behavior) ──────────────────────────────────

test("payload omits shape_labels when empty — byte-stable for older projects", () => {
  // buildPayload's exact spread: `...(shapeLabels.length ? { shape_labels: shapeLabels } : {})`,
  // mirroring the condition_columns omit-when-empty convention. Empty → the key
  // never appears, so a project that predates shape labels serializes
  // byte-identically to before this feature.
  const payload = (shapeLabels: string[]) => ({ conditions: [], ...(shapeLabels.length ? { shape_labels: shapeLabels } : {}), shapes: [] });
  assert.equal(JSON.stringify(payload([])), JSON.stringify({ conditions: [], shapes: [] }));
  assert.ok("shape_labels" in payload(vocab()));
  // and hydrate closes the loop: the absent key sets state back to []
  assert.deepEqual(sanitizeShapeLabels((payload([]) as any).shape_labels), []);
});
