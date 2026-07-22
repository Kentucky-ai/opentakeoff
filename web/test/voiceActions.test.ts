// Voice wiring tests (RFC #59, slice 2) — the mutation-safety bar, two ways:
//
// Part A (call log): every mutating capability records into ONE ordered log and
// each case deep-equals the WHOLE log — proving an intent invokes exactly the
// UI's call sequence, in order, and a failed precondition or rejected
// transcript invokes NOTHING.
//
// Part B (state model): the RFC's bullet verbatim — "voice-produced actions
// must be identical to their UI-produced equivalents (assert deep-equal on
// resulting state)". makeApp() models the canvas state {conditions, activeCond,
// shapeLabels, activeLabel, markups} with the canvas's exact verb semantics;
// caps are bound over those SAME verbs precisely as buildVoiceCtx binds them.
// Each case seeds two identical apps, drives one by voice and one by the
// equivalent UI script, and asserts the final states deep-equal. The remaining
// link — buildVoiceCtx binding these capabilities to the canvas's real
// functions — is a 12-line by-inspection review in TakeoffCanvas.jsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyVoiceIntent, runVoiceCommand, REJECTION_MESSAGES,
  type VoiceCapabilities, type VoiceOutcome,
} from "../src/lib/voiceActions.ts";

// ── Part A: ordered call-log ────────────────────────────────────────────────

type LogEntry = [string, ...unknown[]];

function makeCtx(overrides: Partial<VoiceCapabilities> = {}) {
  const log: LogEntry[] = [];
  const caps: VoiceCapabilities = {
    getConditions: () => [
      { id: "cnd-1", finish_tag: "CPT-1" },
      { id: "cnd-2", finish_tag: "cpt 2" }, // non-canonical literal, like a schedule import might mint
    ],
    getShapeLabels: () => ["Phase 1", "Alternate"],
    getActiveConditionId: () => "cnd-1",
    activateCondition: (id) => { log.push(["activateCondition", id]); },
    createCondition: (tag) => { log.push(["createCondition", tag]); return { id: `cnd-${tag}`, finish_tag: tag }; },
    updateCondition: (id, patch) => { log.push(["updateCondition", id, patch]); },
    addLabel: (label) => { log.push(["addLabel", label]); },
    activateLabel: (label) => { log.push(["activateLabel", label]); },
    addNote: (text) => { log.push(["addNote", text]); },
    ...overrides,
  };
  return { caps, log };
}

test("activate known → exactly one activateCondition call", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "CPT-1", known: true });
  assert.deepEqual(out, { ok: true, message: "CPT-1 active." });
  assert.deepEqual(log, [["activateCondition", "cnd-1"]]);
});

test("activate known by non-canonical literal 'cpt 2' → exact finish_tag lookup", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "cpt 2", known: true });
  assert.equal(out.ok, true);
  assert.deepEqual(log, [["activateCondition", "cnd-2"]]);
});

test("activate known + waste → activate THEN update, by id, in order", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "CPT-1", known: true, waste: 7 });
  assert.deepEqual(out, { ok: true, message: "CPT-1 active — waste 7%." });
  assert.deepEqual(log, [
    ["activateCondition", "cnd-1"],
    ["updateCondition", "cnd-1", { waste_pct: 7 }],
  ]);
});

test("activate unknown → create then activate", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "LVT-2", known: false });
  assert.deepEqual(out, { ok: true, message: "Created LVT-2 — active." });
  assert.deepEqual(log, [["createCondition", "LVT-2"], ["activateCondition", "cnd-LVT-2"]]);
});

test("activate unknown + waste → create, activate, update", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "LVT-2", known: false, waste: 5 });
  assert.deepEqual(out, { ok: true, message: "Created LVT-2 — active, waste 5%." });
  assert.deepEqual(log, [
    ["createCondition", "LVT-2"],
    ["activateCondition", "cnd-LVT-2"],
    ["updateCondition", "cnd-LVT-2", { waste_pct: 5 }],
  ]);
});

test("activate unknown that already exists (case-insensitive) → dedup, no mint", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "CPT 2", known: false });
  assert.equal(out.ok, true);
  assert.deepEqual(log, [["activateCondition", "cnd-2"]]);
});

test("defensive: known tag missing from conditions → fail, ZERO calls", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "activate_condition", tag: "GHOST-9", known: true });
  assert.deepEqual(out, { ok: false, message: "Couldn't find condition GHOST-9." });
  assert.deepEqual(log, []);
});

test("set_waste → one by-id update on the active condition", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "set_waste", waste: 12.5 });
  assert.deepEqual(out, { ok: true, message: "Waste 12.5% on CPT-1." });
  assert.deepEqual(log, [["updateCondition", "cnd-1", { waste_pct: 12.5 }]]);
});

test("set_waste guard: no active condition → exact message, ZERO calls", () => {
  const { caps, log } = makeCtx({ getActiveConditionId: () => "" });
  const out = applyVoiceIntent(caps, { kind: "set_waste", waste: 7 });
  assert.deepEqual(out, { ok: false, message: "Couldn't set waste — no active condition." });
  assert.deepEqual(log, []);
});

test("set_label known → activate only, vocabulary untouched", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "set_label", label: "Phase 1", known: true });
  assert.deepEqual(out, { ok: true, message: "Label Phase 1 active." });
  assert.deepEqual(log, [["activateLabel", "Phase 1"]]);
});

test("set_label unknown → addLabel THEN activate (vocabulary learns it)", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "set_label", label: "East Mezzanine", known: false });
  assert.deepEqual(out, { ok: true, message: "Added label East Mezzanine — active." });
  assert.deepEqual(log, [["addLabel", "East Mezzanine"], ["activateLabel", "East Mezzanine"]]);
});

test("clear_label → activateLabel(null)", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "clear_label" });
  assert.deepEqual(out, { ok: true, message: "Label cleared." });
  assert.deepEqual(log, [["activateLabel", null]]);
});

test("add_note → one addNote call with verbatim text", () => {
  const { caps, log } = makeCtx();
  const out = applyVoiceIntent(caps, { kind: "add_note", text: "verify seam direction with GC" });
  assert.deepEqual(out, { ok: true, message: "Note added — see Markups." });
  assert.deepEqual(log, [["addNote", "verify seam direction with GC"]]);
});

test("runVoiceCommand end-to-end: homophone + percent through parse and apply", () => {
  const { caps, log } = makeCtx();
  const out = runVoiceCommand(caps, "cpt one waist 7.5 percent");
  assert.deepEqual(out, { ok: true, message: "CPT-1 active — waste 7.5%." });
  assert.deepEqual(log, [
    ["activateCondition", "cnd-1"],
    ["updateCondition", "cnd-1", { waste_pct: 7.5 }],
  ]);
});

test("rejected transcript → mapped message, ZERO calls", () => {
  const { caps, log } = makeCtx();
  const out = runVoiceCommand(caps, "carpet one seven");
  assert.deepEqual(out, { ok: false, message: REJECTION_MESSAGES.trailing_words });
  assert.deepEqual(log, []);
});

test("every failure message starts with \"Couldn't\" (the isDangerMsg red/sticky contract)", () => {
  for (const msg of Object.values(REJECTION_MESSAGES))
    assert.ok(msg.startsWith("Couldn't"), msg);
  const { caps } = makeCtx({ getActiveConditionId: () => "" });
  const fails: VoiceOutcome[] = [
    applyVoiceIntent(caps, { kind: "set_waste", waste: 7 }),
    applyVoiceIntent(caps, { kind: "activate_condition", tag: "GHOST-9", known: true }),
  ];
  for (const f of fails) assert.ok(!f.ok && f.message.startsWith("Couldn't"), f.message);
});

// ── Part B: state-model deep-equal (RFC bullet 7 verbatim) ─────────────────
// makeApp() mirrors the canvas verbs' exact semantics with deterministic ids
// and no timestamps; caps are bound over the SAME verbs, exactly as
// buildVoiceCtx binds the real ones.

type AppState = {
  conditions: Array<{ id: string; finish_tag: string; waste_pct: number }>;
  activeCond: string;
  shapeLabels: string[];
  activeLabel: string | null;
  markups: Array<{ id: string; sheet_id: string; rfi_id: string; type: string; at: [number, number]; text: string }>;
};

function makeApp() {
  const state: AppState = {
    conditions: [
      { id: "cnd-1", finish_tag: "CPT-1", waste_pct: 0 },
      { id: "cnd-2", finish_tag: "cpt 2", waste_pct: 3 },
    ],
    activeCond: "cnd-1",
    shapeLabels: ["Phase 1"],
    activeLabel: null,
    markups: [],
  };
  let seq = 0;

  // UI verbs, modeled on the canvas's exact semantics
  const mintCondition = (tag: string) => {
    const c = { id: `cnd-m${++seq}`, finish_tag: tag, waste_pct: 0 };
    state.conditions = [...state.conditions, c];
    return c;
  };
  const activateCondition = (id: string) => { state.activeCond = id; };
  const updateCondById = (id: string, patch: { waste_pct: number }) => {
    state.conditions = state.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c));
  };
  const updateCond = (patch: { waste_pct: number }) => updateCondById(state.activeCond, patch);
  const addLabel = (v: string) => { if (!state.shapeLabels.includes(v)) state.shapeLabels = [...state.shapeLabels, v]; };
  const activateLabel = (v: string | null) => { state.activeLabel = v; };
  const addMarkup = (m: { type: string; at: [number, number]; text: string }, key: string) => {
    state.markups = [...state.markups, { id: `mk-${++seq}`, sheet_id: key, rfi_id: "", ...m }];
  };

  // caps bound over the SAME verbs — the buildVoiceCtx binding, verbatim
  const caps: VoiceCapabilities = {
    getConditions: () => state.conditions.map((c) => ({ id: c.id, finish_tag: c.finish_tag })),
    getShapeLabels: () => state.shapeLabels,
    getActiveConditionId: () => state.activeCond,
    activateCondition,
    createCondition: (tag) => mintCondition(tag),
    updateCondition: updateCondById,
    addLabel,
    activateLabel,
    addNote: (text) => addMarkup({ type: "text", at: [0.5, 0.06], text }, "plan.pdf"),
  };

  return { state, caps, ui: { mintCondition, activateCondition, updateCond, updateCondById, addLabel, activateLabel, addMarkup } };
}

type App = ReturnType<typeof makeApp>;

const EQUIV: Array<{ name: string; transcript: string; uiScript: (app: App) => void }> = [
  { name: "activate known ≡ clicking the condition chip", transcript: "cpt one",
    uiScript: ({ ui }) => ui.activateCondition("cnd-1") },
  { name: "activate non-canonical literal ≡ clicking its chip", transcript: "cpt two",
    uiScript: ({ ui }) => ui.activateCondition("cnd-2") },
  { name: "create+activate ≡ +condition button flow", transcript: "lvt two",
    uiScript: ({ ui }) => { const c = ui.mintCondition("LVT-2"); ui.activateCondition(c.id); } },
  { name: "activate+waste combo ≡ chip click then editor save", transcript: "cpt one waste seven",
    uiScript: ({ ui }) => { ui.activateCondition("cnd-1"); ui.updateCond({ waste_pct: 7 }); } },
  { name: "create+activate+waste ≡ +condition then editor save", transcript: "tile three waste five",
    uiScript: ({ ui }) => { const c = ui.mintCondition("CT-3"); ui.activateCondition(c.id); ui.updateCond({ waste_pct: 5 }); } },
  { name: "waste alone ≡ editor save on the active condition", transcript: "waste twelve",
    uiScript: ({ ui }) => ui.updateCond({ waste_pct: 12 }) },
  { name: "homophone+decimal+percent ≡ same editor save", transcript: "cpt one waist 7.5 percent",
    uiScript: ({ ui }) => { ui.activateCondition("cnd-1"); ui.updateCond({ waste_pct: 7.5 }); } },
  { name: "label known ≡ picking it in the label select", transcript: "label Phase 1",
    uiScript: ({ ui }) => ui.activateLabel("Phase 1") },
  { name: "label unknown ≡ add-to-vocabulary then pick", transcript: "label East Mezzanine",
    uiScript: ({ ui }) => { ui.addLabel("East Mezzanine"); ui.activateLabel("East Mezzanine"); } },
  { name: "clear label ≡ selecting No label", transcript: "clear label",
    uiScript: ({ ui }) => ui.activateLabel(null) },
  { name: "note ≡ placing a text markup on the focused sheet", transcript: "note check seams at door",
    uiScript: ({ ui }) => ui.addMarkup({ type: "text", at: [0.5, 0.06], text: "check seams at door" }, "plan.pdf") },
];

for (const c of EQUIV)
  test(`state-equal: ${c.name}`, () => {
    const voiceApp = makeApp();
    const uiApp = makeApp();
    const out = runVoiceCommand(voiceApp.caps, c.transcript);
    assert.equal(out.ok, true, out.message);
    c.uiScript(uiApp);
    assert.deepEqual(voiceApp.state, uiApp.state);
  });

test("state-equal: rejected transcript mutates NOTHING", () => {
  const app = makeApp();
  const before = structuredClone(app.state);
  const out = runVoiceCommand(app.caps, "carpet one seven");
  assert.equal(out.ok, false);
  assert.deepEqual(app.state, before);
});

test("state-equal: set_waste with no active condition mutates NOTHING", () => {
  const app = makeApp();
  app.state.activeCond = "";
  const before = structuredClone(app.state);
  const out = runVoiceCommand(app.caps, "waste 7");
  assert.deepEqual(out, { ok: false, message: "Couldn't set waste — no active condition." });
  assert.deepEqual(app.state, before);
});
