# Porterville A1-101 — Claude blind run 1 (Fable 5.1), 2026-09-12

Frozen export sha256: see FREEZE.sha256 (taken before scoring). 44 tool calls (14 view_sheet, 7 find_text, 6 measure_polygon, 6 edit_shape for labels, 0 geometry edits). Blind: only TASK.md sections + tools + wiki.

## Score vs reference v1 (the PR #421 reference): 0 of 6 rooms pass
| Room | IoU | boundary px | SF ref / got | verdict |
|---|---|---|---|---|
| LIVING | 0.986 | 12.3 | 256.40 / 254.64 | FAIL |
| BATH | 0.893 | 57.4 | 55.74 / 51.30 | FAIL |
| PANTRY | 0.866 | 5.1 | 4.25 / 4.21 | FAIL |
| W/D | 0.825 | 12.0 | 6.88 / 5.68 | FAIL |
| CL. | 0.941 | 4.4 | 12.90 / 12.85 | FAIL |
| OPT. BEDROOM | 0.978 | 7.3 | 93.51 / 91.47 | FAIL |

## Zoom verdicts (zoom-*.png, green = reference, red = candidate)
Four of the five disputed boundaries go to the CANDIDATE; the reference v1 is wrong there:
1. **Bath NE corner: framed chase.** A grey-poché U enclosure with a void (lines at x 1620/1622, y 2003/2005/2015.5/2017.2). Reference v1 ran straight through it as floor; the candidate traced around it (rule 5). Candidate right.
2. **Pantry door: centerline notch.** The pantry's west side is an opening between two poché wall stubs spanning x ≈ 1317–1329; the door's wall centerline is ≈ 1324. Reference v1 met both rings flush on the pantry-side face x = 1329 ("single line"); the candidate notched to the centerline (rule 3). Candidate right.
3. **Front entry door.** A swinging door in the south exterior wall (leaf + arc drawn). Reference v1 skipped its notch as "exterior"; rule 3 says every door. Candidate notched to the exterior-wall centerline y ≈ 2657. Candidate right.
4. **Bedroom door jamb.** The partition-door notch in reference v1 starts at y = 2300 through the door frame block (y 2300–2316); the opening starts below the block at y ≈ 2316. Candidate right.
5. **W/D mouth (Q11 territory).** Reference v1 split BATH/W-D on the heavy double line at y 2180.6/2184.7 across the mouth; the candidate split at y = 2196.5, which coincides with the thin W/D appliance outline (a fixture line). Reference reading preferred; carried as part of Q11, not a defect of either.
Systematic: the candidate took the room-side gypsum-board line as the wall face; reference v1 took the stud line 1.9 px (0.6 in) inside it. The finished wall surface is the GWB line, so the candidate's face is the more literal reading of rule 1 (new Q14). This alone is under the 2.5 px gate; the failures above come from items 1–5.

## What this means
On this plan the blind Fable run traced better than the agent-authored reference. Reference v2 is being re-authored from the linework for items 1–4 (not copied from the candidate); scores against v2 will be appended below.
