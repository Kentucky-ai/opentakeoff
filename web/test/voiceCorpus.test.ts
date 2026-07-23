// Voice corpus harness (RFC #59 recognizer slice, testing-bar bullet 2).
// Runs every committed WAV in test/fixtures/voice/ through the REAL chain —
// wav decode → whisper (same artifact the browser uses) → parseVoiceIntent —
// and gates intent-level accuracy: quiet ≥ 0.90, noisy ≥ 0.75 (the proposed
// floor; regressions fail the build). Rejection phrases count as CORRECT when
// the chain produces a typed rejection — never-guess, proven through audio.
//
// No recordings or no staged model → the corpus tests SKIP LOUDLY (never
// silently green); the phrase-table sanity checks below always run. CI stages
// the model, so the gate is real where it counts.
//
// Comparison policy (documented for reviewers): kind/tag/known/waste compare
// exactly (tags are deterministic under the fixed harness ctx); LABEL text
// compares after normalization — lowercase, punctuation stripped — against
// any listed alternative (a label is a vocabulary entry; the wrong string is
// the wrong action). NOTE prose gates only on the ACTION (kind + non-empty
// text): a note is freeform dictation whose transcript flashes as the receipt
// and lands editable in the Markups dock — "check seems at the door" for
// "check seams" is a homophone slip in prose, not a wrong mutation. Prose
// fidelity is still REPORTED per fixture (the ≈/✗ column) so drift is
// visible, it just doesn't fail the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { wavToModelPcm } from "../src/lib/stt/wav.ts";
import { createEngine } from "../src/lib/stt/recognizer.ts";
import { parseVoiceIntent, type VoiceContext } from "../src/lib/voiceIntent.ts";

export const QUIET_FLOOR = 0.9;
export const NOISY_FLOOR = 0.75;

// Fixed ctx every fixture is scored under — phrases.json expectations assume it.
const HARNESS_CTX: VoiceContext = {
  conditionTags: ["CPT-1", "VCT-1", "RB-1"],
  shapeLabels: ["Phase 1"],
  hasActiveCondition: true,
};

type Expect = {
  reject?: boolean;
  kind?: string;
  tag?: string;
  known?: boolean;
  waste?: number;
  labelAlts?: string[];
  textAlts?: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const voiceDir = join(here, "fixtures", "voice");
const modelsDir = join(here, "..", "public", "models");

const table = JSON.parse(readFileSync(join(voiceDir, "phrases.json"), "utf8")) as {
  phrases: Record<string, { say: string; expect: Expect }>;
  noisySubset: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

function intentMatches(expect: Expect, parsed: ReturnType<typeof parseVoiceIntent>): boolean {
  if (expect.reject) return !parsed.ok;
  if (!parsed.ok) return false;
  const it = parsed.intent as Record<string, unknown>;
  if (it.kind !== expect.kind) return false;
  if (expect.tag !== undefined && it.tag !== expect.tag) return false;
  if (expect.known !== undefined && it.known !== expect.known) return false;
  if (expect.waste !== undefined && it.waste !== expect.waste) return false;
  if (expect.labelAlts && !expect.labelAlts.some((a) => norm(String(it.label ?? "")) === norm(a))) return false;
  // note prose: the action is the gate; exact text is diagnostic (see header)
  if (expect.textAlts && String(it.text ?? "").trim() === "") return false;
  return true;
}

/** Diagnostic only: did the note prose match an alternative exactly (post-norm)? */
function proseExact(expect: Expect, parsed: ReturnType<typeof parseVoiceIntent>): boolean | null {
  if (!expect.textAlts || !parsed.ok) return null;
  const it = parsed.intent as Record<string, unknown>;
  return expect.textAlts.some((a) => norm(String(it.text ?? "")) === norm(a));
}

// ── phrase-table sanity (always runs — keeps the committed table honest) ───

test("corpus table: every phrase has a say + a well-formed expectation", () => {
  const kinds = new Set(["activate_condition", "set_waste", "set_label", "clear_label", "add_note", "trace_at_cursor"]);
  for (const [id, p] of Object.entries(table.phrases)) {
    assert.ok(/^p\d\d$/.test(id), `phrase id ${id}`);
    assert.ok(p.say.trim().length > 0, `${id} say`);
    assert.ok(p.expect.reject === true || kinds.has(p.expect.kind ?? ""), `${id} expect kind`);
  }
  for (const id of table.noisySubset) assert.ok(table.phrases[id], `noisySubset ${id} exists`);
});

test("corpus table: expectations agree with the parser on the CLEAN transcript", () => {
  // The say-text itself must parse to the expected intent — if it doesn't,
  // the fixture is mis-specified and no recording could ever pass.
  for (const [id, p] of Object.entries(table.phrases)) {
    const parsed = parseVoiceIntent(p.say, HARNESS_CTX);
    assert.ok(intentMatches(p.expect, parsed), `${id} "${p.say}" → ${JSON.stringify(parsed)}`);
  }
});

// ── the corpus run (needs recordings + staged model) ────────────────────────

const wavs = existsSync(voiceDir)
  ? readdirSync(voiceDir).filter((f) => /^s\d+-(quiet|noisy)-p\d\d\.wav$/.test(f)).sort()
  : [];
const modelPresent = existsSync(join(modelsDir, "onnx-community", "whisper-tiny.en", "onnx"));

const skip = !modelPresent
  ? "voice model not staged — run: node scripts/fetch-voice-model.mjs"
  : wavs.length === 0
    ? "no corpus recordings yet — see test/fixtures/voice/RECORDING.md"
    : false;

test("voice corpus: end-to-end intent accuracy over recorded fixtures", { skip, timeout: 600000 }, async () => {
  const engine = await createEngine("transformers-js");
  await engine.init({ baseUrl: modelsDir });

  const byProfile: Record<"quiet" | "noisy", { pass: number; total: number }> = {
    quiet: { pass: 0, total: 0 },
    noisy: { pass: 0, total: 0 },
  };
  const lines: string[] = [];

  for (const f of wavs) {
    const m = /^(s\d+)-(quiet|noisy)-(p\d\d)\.wav$/.exec(f)!;
    const [, , profile, pid] = m;
    const phrase = table.phrases[pid];
    assert.ok(phrase, `${f}: unknown phrase id ${pid}`);
    const pcm = wavToModelPcm(new Uint8Array(readFileSync(join(voiceDir, f))));
    const text = await engine.transcribe(pcm);
    const parsed = parseVoiceIntent(text, HARNESS_CTX);
    const okHit = intentMatches(phrase.expect, parsed);
    const p = byProfile[profile as "quiet" | "noisy"];
    p.total++;
    if (okHit) p.pass++;
    const prose = proseExact(phrase.expect, parsed);
    lines.push(
      `  ${okHit ? (prose === false ? "≈" : "✓") : "✗"} ${f.padEnd(20)} heard "${text}"  (script: "${phrase.say}") → ${
        parsed.ok ? (parsed.intent as { kind: string }).kind : `reject:${parsed.reason}`
      }`,
    );
  }
  await engine.dispose();

  const pct = (v: { pass: number; total: number }) => (v.total ? v.pass / v.total : null);
  const fmt = (v: { pass: number; total: number }) =>
    v.total ? `${v.pass}/${v.total} = ${((v.pass / v.total) * 100).toFixed(1)}%` : "—";
  console.log(
    [
      "",
      `Voice corpus — intent accuracy (${wavs.length} recordings)`,
      ...lines,
      "  " + "-".repeat(64),
      `  quiet ${fmt(byProfile.quiet)} (floor ${QUIET_FLOOR * 100}%)   noisy ${fmt(byProfile.noisy)} (floor ${NOISY_FLOOR * 100}%)`,
      "",
    ].join("\n"),
  );

  // the gate — per profile, only when that profile has recordings
  const q = pct(byProfile.quiet);
  const n = pct(byProfile.noisy);
  if (q !== null) assert.ok(q >= QUIET_FLOOR, `quiet-set intent accuracy ${q.toFixed(3)} below floor ${QUIET_FLOOR}`);
  if (n !== null) assert.ok(n >= NOISY_FLOOR, `noisy-set intent accuracy ${n.toFixed(3)} below floor ${NOISY_FLOOR}`);
});
