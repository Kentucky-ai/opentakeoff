# Roseburg A-03a — Claude blind run 1 (Fable 5.1), 2026-09-12

Frozen export sha256: see FREEZE.sha256 (taken before scoring). 29 tool calls (11 view_sheet, 4 measure_polygon, 4 edit_shape for labels, 0 geometry edits). Blind: only TASK.md sections + tools + wiki.

## Score vs reference v1 (the PR #421 reference): 2 of 4 rooms pass
| Room | IoU | boundary px | SF ref / got | verdict |
|---|---|---|---|---|
| D105B STORAGE | 1.000 | 0.0 | 39.83 / 39.83 | PASS |
| D105A OFFICE | 0.993 | 13.4 | 110.96 / 111.70 | FAIL (v1) |
| D104 OFFICE | 0.940 | 108.0 | 81.99 / 87.23 | FAIL |
| D105 OFFICE | 1.000 | 0.1 | 90.63 / 90.62 | PASS |

## Zoom verdicts (zoom-*.png, both rings drawn)
- **D105A east stub: the REFERENCE is wrong, the candidate is right.** Three verticals: 4280.6 / 4290.4 / 4303.8. The 4280–4290 pair spanning y 2161–2359 is the door leaf drawn standing open (its swing arc lands on it); the scope hatch runs through the leaf to 4303.8, which is the wall face. Reference v1 traced the leaf line, violating rule 1. Corrected in `roseburg-reference-v2-proposed.json` (reference_id bumped, note written). Re-scored: D105A passes v2 (IoU 1.0, 0 px).
- **D104 sink alcove: genuine estimator question, not a tracing error (new Q13).** The alcove (x 3120–3228, y 2380–2591) is bounded on the room side by ONE heavy 1.68 px stroke with no wall thickness on a sheet whose every wall is a double line; the scope hatch is continuous across it. The candidate read it as a screen line and included the alcove (+5.2 SF); reference v1 read it as a wall and excluded it. Carried for Michael: (a) include (finish runs under the sink, hatch is continuous) or (b) exclude (heavy stroke = wall). Score stays FAIL against v1 until ruled.

## Score vs reference v2-proposed: 3 of 4 pass (D104 open on Q13)

## What the blind run did well
Every door notched to the centerline on both sides; L-jog and pilaster followed; glazing run straight; scale set as instructed; nothing approved; self-audited with overlay renders before export. It also flagged that D105 is clipped by the sheet border (true: the sheet is a partial plan).
