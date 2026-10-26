# St. Cloud AF101 — Claude blind run 1 (Fable 5.1), 2026-09-12

Frozen export sha256: see FREEZE.sha256 (taken before scoring). 54 tool calls (23 view_sheet, 6 measure_polygon, 6 edit_shape for labels, 5 find_text, 5 resolve_tag, 0 geometry edits). Blind: only TASK.md sections + tools + wiki.

## Score vs reference v1 (the PR #421 reference): 0 of 6 rooms pass
| Room | IoU | boundary px | SF ref / got | verdict |
|---|---|---|---|---|
| CONFERENCE/BREAK ROOM 134 CPT-1 | 0.987 | 10.0 | 275.85 / 278.69 | FAIL |
| CONFERENCE/BREAK ROOM 134 VCT-1 | 0.890 | 44.7 | 64.48 / 57.49 | FAIL |
| STORAGE 134A | 0.992 | 3.6 | 16.35 / 16.29 | FAIL |
| OFFICE 136 | 0.972 | 40.5 | 130.42 / 129.27 | FAIL |
| PATIENT ROOM 137 | 0.972 | 28.5 | 254.69 / 251.60 | FAIL |
| TOILET 137A | 0.973 | 55.7 | 62.21 / 60.90 | FAIL |

## Zoom verdicts (zoom-*.png, green = reference, red = candidate)
Every disputed boundary inspected goes to the CANDIDATE. Reference v1 defects:
- (a) **134 → 136 door**: no notch in v1 on either ring (a swinging door is drawn at x 2380–2440 on the 134/136 wall). Candidate notched both rings to the centerline y = 934.8.
- (b) **136 → corridor door**: no notch in v1; candidate notched 2372–2432 to y = 1180.
- (c) **Wall stub in 136**: the 134A/136 partition continues as a 1.68 px double stub x 2444.2/2451.4 from y 1000 to 1040.6; v1 counted it as floor. Candidate wrapped it.
- (d) **Enclosed cell at the east end of the VCT strip** (double 1.68 px lines x 2292.7/2299.2, y 990.2/996.7 to 1034.9): a chase or closet, not floor; v1 included it (6.8 SF). Candidate traced around it.
- (e) **137 west chase + column** (enclosure x 2535–2564, y 902.6–952.8 with a filled column inside): v1 included it; candidate wrapped it.
- (f) **137A privacy stub** (x 2617.9/2625.4 from the north wall down to y 1065.4): v1 ran the north edge straight through it; candidate wrapped it.
- (g) **137A east door south jamb**: the leaf lies open along the south wall from the hinge at (2689.9, ≈1156); a 21 px wall stub remains below it to y 1177. v1 notched through the stub; candidate stopped the notch at ≈1159.
- (h) **Corridor doors of 134 and 137 (composite masonry + furring walls)**: v1 notched to the furring pair's midpoint (3 px); candidate notched to the midpoint of the whole wall's two faces (2110.3/2136 → 2123; 2769.1/2795 → 2782). Rule 3 says "the two faces of that wall", so the candidate reading is the literal one. New **Q15**: composite exterior walls, notch depth = half the full wall (carried) or half the furring.
Washes (≤ 9 px, both defensible): 134A door jamb positions (2451/2517 vs 2460/2520, door-frame rendering); the 1.3 in nib on 137's north wall.

## What this means
On this plan the blind Fable run traced better than the agent-authored reference on eight distinct boundary decisions and made no error of its own that I could find at zoom. Reference v2 is being re-authored from the linework for (a)–(h) (not copied from the candidate); scores against v2 will be appended.
