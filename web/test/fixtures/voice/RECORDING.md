# Voice corpus — recording guide (RFC #59 recognizer slice)

The testing bar requires WAV fixtures **recorded for this project** (no
third-party audio), multiple speakers/accents/noise profiles, with expected
transcripts + intents. This directory is that corpus; [`phrases.json`](./phrases.json)
is the phrase table; `voiceCorpus.test.ts` runs every committed WAV through the
real chain (decode → whisper → intent parser) and gates CI on intent accuracy.

## What to record

- **Each speaker**: all 28 phrases in `phrases.json` (the `say` field,
  verbatim), in a **quiet** room.
- **At least one speaker** (more is better): re-record the 9 phrases in
  `noisySubset` with realistic background noise — a fan, radio at low volume,
  or an open window. Don't shout over it; speak like you would at a desk.
- Speak naturally at normal pace. Commas in the phrase are a beat, not a stop.
  One phrase per file, with ~half a second of silence before and after.

## File format + naming

- **WAV, 16-bit PCM, mono.** 16 kHz preferred; 44.1/48 kHz is fine (the
  harness resamples). Keep each file under ~6 seconds.
- Name: `<speaker>-<noise>-<phrase>.wav` — e.g. `s1-quiet-p01.wav`,
  `s2-noisy-p07.wav`. Speakers are `s1`, `s2`, `s3`… in recording order;
  noise is `quiet` or `noisy`; phrase ids come from `phrases.json`.
- The harness derives everything from the filename — you never edit a
  manifest. Drop the files in this directory and run the test.

## Tools

- **Audacity** (free): set the project rate to 16000 Hz (bottom-left), record,
  `File → Export → Export as WAV` → "WAV (Microsoft) signed 16-bit PCM".
  Trim leading/trailing silence to ~0.5 s.
- Any recorder that produces WAV works; if yours only makes M4A/MP3, export
  through Audacity to WAV 16-bit.

## Privacy (matches the repo's provenance ethos)

- Speakers are identified ONLY as `s1`/`s2`/`s3` — no names anywhere, in
  filenames or file metadata. Audacity's default WAV export carries no
  personal metadata; don't add ID3-style tags.
- Recruited speakers should know the clips ship in a public repo forever and
  agree to that. An optional one-line accent descriptor per speaker
  ("s2: non-native, Indian English") may go in the PR description —
  self-reported, no other personal information.
- No third-party audio, ever — no clips from videos, datasets, or other
  people's recordings. Everything here is recorded for this project.

## Checking your recordings

From `web/` (model staged via `node scripts/fetch-voice-model.mjs`):

```bash
node --import tsx --test test/voiceCorpus.test.ts
```

The report lists every file: the transcript whisper heard, the intent parsed,
and ✓/✗ against the expected intent. Quiet-set accuracy must be ≥ 0.90 and
noisy ≥ 0.75 (the proposed CI floor). A rejected garbage phrase (`p21`–`p23`)
counts as CORRECT when it produces a typed rejection — the never-guess rule,
end to end.
