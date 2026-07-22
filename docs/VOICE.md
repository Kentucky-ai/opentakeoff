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

| engine | model size | cold init | decode speed | peak RSS | notes |
|---|---|---|---|---|---|
| **transformers.js** — whisper-tiny.en ONNX, q8 encoder + uint8 decoder | 43.5 MB | ~1.5 s (Node) / ~8 s cold in-browser | ~4× realtime (Node native) / ~1.2× realtime (browser wasm, single thread) | ~685 MB (Node) | **shipped.** Same artifact runs headless in CI and in the browser Worker — the corpus numbers ARE the browser engine's numbers. |
| whisper.cpp WASM | — | — | — | — | **not browser-viable here:** maintained wrappers require `SharedArrayBuffer`, and OpenTakeoff deliberately ships no COOP/COEP (adding them would break the cross-origin font/Google-Identity loads under the current CSP). That constraint decided the benchmark. |
| (variant) q4 decoder | 99.5 MB total | — | — | — | evaluated and rejected: 2.8× the size AND audibly worse transcripts on identical audio. |

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
`RECORDING.md` there): scripted phrases across speakers and noise profiles,
run through the REAL chain (WAV → whisper → intent parser) in CI. Intent
accuracy gates the build: **quiet ≥ 0.90, noisy ≥ 0.75**; rejection phrases
count as correct only when the chain refuses them — never-guess, proven
through audio.

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

| state | expected behavior | |
|---|---|---|
| model not staged on origin | "Voice isn't installed on this deployment — see docs/VOICE.md" | ✓ |
| PTT while model downloading | chip shows "voice model loading… N%" — never a silent drop; the press also kicks/retries the load | ✓ |
| model download failure | red sticky "Couldn't load the voice model — … Hold M to retry."; retry works | ✓ |
| mic permission denied | red sticky "Couldn't start dictation — microphone permission denied." | ✓ |
| no microphone device | red sticky "… no microphone found." | |
| mic revoked mid-hold (OS/site toggle) | session discarded; "… the microphone was revoked." | |
| tab backgrounded mid-dictation | session discarded; "Dictation discarded — the tab went to the background." | |
| Esc mid-hold | session discarded silently (deliberate cancel) | ✓ |
| key-tap (<0.1 s) | ignored — a tap is not an utterance | ✓ |
| unmount / navigate away | AudioContext closed, tracks stopped, worker terminated — verify no orphans in `chrome://media-internals` | |
| unsupported browser (no getUserMedia) | Voice button hidden entirely — feature absence, not breakage | |

## Browser matrix

| browser | platform | status |
|---|---|---|
| Chrome (latest) | Windows x64 | ✓ full flow (automated drive + manual) |
| Edge (latest) | Windows x64 | manual pass pending |
| Firefox (latest) | Windows x64 | manual pass pending |
| Safari (latest) | macOS Apple Silicon | **requested from maintainer** — no Mac access on the contributing side |
| Safari (latest) | macOS x86 | **requested from maintainer** |

WASM SIMD is required (baseline in all evergreen browsers since 2021);
without it ORT fails init and voice reports the load error — the feature
degrades to absent, the canvas is untouched.
