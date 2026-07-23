# Voice dictation — on-device push-to-talk (RFC #59)

Hold **M** (or the **Voice** toolbar button) and speak a takeoff command —
*"carpet one, waste seven"*, *"label phase two"*, *"note verify sheet vinyl
with GC"*, or *"CPT-1, this room"* with the pointer resting on a room.
Release to run; **Esc** discards. The transcript flashes in a chip
(the receipt), and the outcome lands in the message bar exactly like a typed
Command-box entry — because it IS one: speech feeds the same deterministic
grammar, dispatcher, and app actions the Command box runs. No AI in the loop,
no new mutation path.

**Audio never leaves the browser.** Recognition is whisper-tiny.en running in
WebAssembly inside a Web Worker, on your machine. There is no cloud
recognizer, no fallback to one, and no telemetry — see the privacy proof
below.

## Staging the model (self-hosters, deploys, contributors)

The ~44 MB model is deliberately **not** in git and not fetched by the app at
runtime from any third party. It is staged same-origin at build/dev time:

```bash
cd web
node scripts/fetch-voice-model.mjs     # → web/public/models/ (gitignored)
```

Serve the build and voice lights up. Without the staged model the feature
says so plainly ("Voice isn't installed on this deployment") — feature
absence, never breakage. CI stages it behind `actions/cache`; a deploy that
wants voice enabled runs the same script before `vite build`.

## Engine choice (the RFC asked for benchmarks)

Measured on the committed real-speaker corpus (28 quiet + 9 noisy recordings):

| engine / configuration | model size | intent recall (quiet / noisy) | decode speed | notes |
|---|---|---|---|---|
| **transformers.js, whisper-tiny.en, greedy** (q8 encoder + uint8 decoder) | 43.5 MB | **82.1% / 66.7%** | ~4× realtime (Node) / ~1.2× realtime (browser wasm, single thread) | **shipped.** Same artifact runs headless in CI and in the browser Worker — the corpus numbers ARE the browser engine's numbers. Cold init ~1.5 s Node / ~8 s browser; ~685 MB RSS (Node). |
| transformers.js, whisper-**base**.en, greedy | 76.9 MB | 60.7% / 44.4% | 2.3× realtime (Node) | rejected: bigger AND worse on the real corpus (its keyword mishears just differ — "carpet wand", "rubber bass one"). |
| transformers.js, whisper-tiny.en, **beam 5** | 43.5 MB | 75.0% / 55.6% | 2.5× realtime (Node) | rejected: worse than greedy, plus a repetition pathology on noisy audio ("1.0.0.0.0…"). |
| whisper.cpp WASM | — | — | — | **not browser-viable here:** maintained wrappers require `SharedArrayBuffer`, and OpenTakeoff deliberately ships no COOP/COEP (adding them would break the cross-origin font/Google-Identity loads under the current CSP). That constraint decided the benchmark. |
| (variant) q4 decoder | 99.5 MB total | — | — | rejected: 2.8× the size AND audibly worse transcripts on identical audio. |

Implementation notes pinned in code: the ORT wasm runtime rides Vite's asset
pipeline (`?url`) so it ships same-origin in dev and build (never a CDN);
the browser session runs `graphOptimizationLevel: "basic"` because ort-web's
extended QDQ fusion rejects these quantized decoders; decode runs in
`stt.worker.ts`, never the main thread. Re-run the table anytime:

```bash
node --import tsx scripts/voice-benchmark.mjs            # over the corpus
node --import tsx scripts/voice-benchmark.mjs --dir …    # over any WAVs
```

## The corpus gate

`web/test/fixtures/voice/` holds the recorded fixture corpus (see
`RECORDING.md` there): scripted phrases run through the REAL chain
(WAV → whisper → intent parser) in CI. **Current coverage: one real speaker
(s1), 28 quiet + 9 noisy takes** — additional speakers are invited and slot
in by filename alone (`s2-…`), no harness changes. Two gates:

1. **Hard invariant — zero wrong actions.** A mishear may cost a re-say
   (safe refusal) or drift note prose; it must never mutate state
   differently than the speaker intended. Held over 400+ recognition
   attempts (real + synthetic stress audio); one violation fails the build.
2. **Regression floor — quiet ≥ 0.75, noisy ≥ 0.55 intent recall**, set just
   under the committed corpus's measured baseline (82.1% / 66.7%,
   whisper-tiny.en greedy) so any change that degrades recall fails the
   build. The bar's words are "regressions fail the build" — the floor is a
   tripwire under measured reality, not an aspiration above it. Rejection
   phrases count as correct only when the chain refuses them.

Two grammar normalizations were EARNED by corpus evidence and are pinned by
tests: `bass→base` (true homophone, heard in "rubber bass one") and
number-slot-only `to/too→two, won→one` ("transition to") — slot-restricted so
note prose keeps its literal words, and `for→four` deliberately excluded (a
literal preposition there could mint a wrong waste value).

## The synthetic accent stress set (what it proved)

Before the recorded corpus landed, a 185-clip TTS set (ElevenLabs, five
synthetic accent voices — **not committed**: generated voices aren't corpus
material per the recording rules, and redistribution licensing is
tier-dependent) was run through the full chain as a stress test. The
finding that matters:

> **370 recognition attempts across whisper-tiny.en and whisper-base.en
> produced ZERO wrong actions.** Every keyword mishear ("carpet" → "Copy",
> "waste seven" → "With Sabin") was refused loudly by the never-guess
> grammar; the only non-refusal misses were notes/labels where the action
> was right and the free text drifted by a homophone ("seams" → "seems").

Raw intent recall on that synthetic-accent audio was low (tiny 36–40%,
base 49–60% — synthetic accented speech is a known whisper weak spot and a
stress floor, not a forecast), but the safety property held absolutely:
a mishear costs a re-say, never corrupted takeoff data. The committed
corpus of real recorded speech is what the CI floor applies to.

## Privacy proof

- `web/test/voicePrivacy.test.ts` replaces `fetch`/`XMLHttpRequest`/`WebSocket`
  with recorders before the engine loads and asserts a full init + transcribe
  cycle records **zero** network calls.
- Manual half (browser): open devtools → Network, complete one dictation
  after the model is cached — the log stays empty. Screenshot in the PR.
- `Permissions-Policy` grants the mic to `self` only; camera and geolocation
  stay fully disabled.

## Lifecycle states — manual checklist

Every state below is wired to a loud, specific message. Verified per release
(states marked ✓ are also covered by automated browser drives):

| state | expected behavior | verified |
|---|---|---|
| model not staged on origin | "Voice isn't installed on this deployment — see docs/VOICE.md" | ✓ automated |
| PTT while model downloading | chip shows "voice model loading… N%" — never a silent drop; the press also kicks/retries the load | ✓ automated + manual |
| model download failure | red sticky "Couldn't load the voice model — … Hold M to retry."; retry works | ✓ automated |
| mic permission denied | red sticky "Couldn't start dictation — microphone permission denied." | ✓ automated |
| no microphone device | red sticky "… no microphone found." | code-pathed with mic-denied; untested (needs mic-less hardware) |
| mic revoked mid-hold (site toggle) | session discarded; "… the microphone was revoked." | ✓ manual |
| tab backgrounded mid-dictation | session discarded; "Dictation discarded — the tab went to the background." | ✓ manual |
| Esc mid-hold | session discarded silently (deliberate cancel) | ✓ manual |
| key-tap (<0.1 s) | ignored — a tap is not an utterance | ✓ automated |
| unmount / navigate away | AudioContext closed, tracks stopped, worker terminated | ✓ manual — `chrome://media-internals` clean after tab close |
| unsupported browser (no getUserMedia) | Voice button hidden entirely — feature absence, not breakage | by construction (`captureSupported()` gates the render) |

## Browser matrix

| browser | platform | status |
|---|---|---|
| Chrome (latest) | Windows x64 | ✓ full flow — automated fake-mic drives + manual real-mic pass (all lifecycle states) |
| Firefox (latest) | Windows x64 | ✓ manual — dictation end-to-end |
| Edge (latest) | Windows x64 | ✓ manual — dictation end-to-end |
| Safari (latest) | macOS Apple Silicon | **requested from maintainer** — no Mac access on the contributing side |
| Safari (latest) | macOS x86 | **requested from maintainer** |

WASM SIMD is required (baseline in all evergreen browsers since 2021);
without it ORT fails init and voice reports the load error — the feature
degrades to absent, the canvas is untouched.
