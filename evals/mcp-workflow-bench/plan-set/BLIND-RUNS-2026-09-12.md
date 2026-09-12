# Blind agent runs, 2026-09-12

Four blind runs of one agent (Claude Fable 5.1) through the public OpenTakeoff MCP server
(built from main `9e55c61`, flat tool mode, One-Click off), one run per plan, each on a
fresh server. The agent received only the task text in `TASK.md`, the tool schemas, the
packaged wiki, and the plan through the tools. It did not see any reference, and every
export was hashed (`FREEZE.sha256`) before it was scored. The three public runs are in
`blind-runs-2026-09-12/`; a fourth run on a private client plan is not published.

What the runs exposed first was defects in the **references**, not in the candidate. Zoom
inspection of every disputed boundary (green reference, red candidate, in each run's
`zoom-*.png`) found the v1 references had traced a door leaf as a wall face, missed door
notches, and counted wall stubs, chases and an enclosed cell as floor. Each reference was
re-authored from the PDF linework for those items (not copied from the candidate) and is
now `reference.json` (v2); v1 is kept as `reference-v1.json`.

| Plan | Rooms | Score vs v1 | Score vs v2 | Residual after v2 |
|---|---|---|---|---|
| St. Cloud AF101 | 6 rings | 0 / 6 | 1 / 6 pass; all within 0.05–0.39 % SF and 0.2–6.2 px | door-jamb readings (3–6 px) |
| Roseburg A-03a | 4 rings | 2 / 4 | 3 / 4 | D104 sink alcove: Q13 |
| Porterville A1-101 | 6 rings | 0 / 6 | 0 / 6 pass; 4 within 0.4–2 % SF | W/D alcove mouth (Q11), pantry jamb, gypsum-board face vs stud line (Q14) |

The pass gate (IoU ≥ 0.985 and every vertex within 2.5 px of the other ring) is strict on
purpose: a skipped 1 ft door notch fails a room. Read the SF and IoU columns in each run's
`score*.json` with the gate, not instead of it.

New estimator questions raised by these runs are Q13–Q17 in `QUESTIONS.md`. Boundaries: one
run per plan, one model; nothing here is repeatability evidence, and none of the references
has been human-reviewed. The agent's own notes for each run are in `RESULT.md` beside the
frozen export.

## A second agent on the same task (added 2026-09-12)

The same three tasks were run through a second agent (OpenAI Codex CLI 0.154.0, model `gpt-6-astra`, reasoning effort high) with the identical prompt, task text, server build and blind rules, one run each, exports frozen before scoring. Its runs are in `<plan>-codex/`. Scored against the v2 references:

| Plan | Room | Claude: SF err / IoU / max px | Codex: SF err / IoU / max px |
|---|---|---|---|
| stcloud | CONFERENCE/BREAK ROOM 134 CPT-1 | 0.05 % / 0.999 / 6 | 0.04 % / 0.998 / 6 |
| stcloud | CONFERENCE/BREAK ROOM 134 VCT-1 | 0.11 % / 0.999 / 0 | 0.03 % / 0.999 / 0 |
| stcloud | STORAGE 134A CPT-1 | 0.39 % / 0.992 / 4 | 0.88 % / 0.991 / 4 |
| stcloud | OFFICE 136 CPT-1 | 0.27 % / 0.997 / 3 | 1.04 % / 0.989 / 4 |
| stcloud | PATIENT ROOM 137 CPT-1 | 0.13 % / 0.998 / 6 | 0.05 % / 0.995 / 6 |
| stcloud | TOILET 137A PT-1/PT-2 | 0.06 % / 0.999 / 3 | 4.40 % / 0.955 / 15 |
| roseburg | D105B STORAGE VSF | 0.00 % / 1.000 / 0 | 0.00 % / 1.000 / 0 |
| roseburg | D105A OFFICE VSF | 0.00 % / 1.000 / 0 | 0.01 % / 1.000 / 0 |
| roseburg | D104 OFFICE VSF | 6.39 % / 0.940 / 108 | 6.39 % / 0.940 / 108 |
| roseburg | D105 OFFICE VSF | 0.01 % / 1.000 / 0 | 0.00 % / 1.000 / 0 |
| porterville | LIVING LVP | 0.83 % / 0.991 / 12 | 0.86 % / 0.991 / 12 |
| porterville | BATH CT | 0.75 % / 0.962 / 12 | 0.75 % / 0.962 / 12 |
| porterville | PANTRY LVP | 6.51 % / 0.922 / 5 | 6.51 % / 0.922 / 5 |
| porterville | W/D LVP | 17.47 % / 0.825 / 12 | 17.47 % / 0.825 / 12 |
| porterville | CL. CPT | 0.36 % / 0.941 / 4 | 0.67 % / 0.943 / 3 |
| porterville | OPT. BEDROOM CPT | 2.12 % / 0.978 / 3 | 2.16 % / 0.978 / 3 |

Read: Roseburg and Porterville are ties down to the hundredth, including the same estimator calls where the plan is ambiguous (Q11, Q13, Q14). St. Cloud goes to the first agent: all six rings within 0.4 % SF, while the second stopped TOILET 137A at the lavatory counter front instead of running the tile under it to the wall face (rule 1), −4.4 % on that room. Tool calls: 54 / 29 / 44 (first agent) versus 49 / 33 / 51 (second). Two agents, one run each: a comparison, not a population claim.
