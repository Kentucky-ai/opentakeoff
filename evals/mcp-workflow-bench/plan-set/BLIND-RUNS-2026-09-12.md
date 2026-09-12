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
