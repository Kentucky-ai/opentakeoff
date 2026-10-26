# St. Cloud AF101 estimator-trace reference — notes

Source: `demo/sample-finish-plan.pdf` page 1 (AF101, First Floor Finish Plan), VA St. Cloud Bldg 28.
sha256 `53aa2a44efc8f9a2e625ed223fcfbf9ee19d15eb8469ba57183874b6a8e2a56f`.
Schedule read from page 2 (`page.get_text()`), sheet AF600 "MATERIAL AND ROOM FINISH SCHEDULE".

## Scale verification

`feet_per_image_px = 1/18 = 0.05555555555555555` (1/8" = 1'-0" → 9 pt/ft → ×2 render scale → 18 px/ft).
Verified against the printed "16 SF" in STORAGE 134A: my traced ring for that room shoelaces to
5298.7 px² × (1/18)² = **16.35 SF**, a +2.2% delta from the printed value — confirms the scale
constant to well within a rounding tolerance (printed SF is itself rounded to the nearest whole
number). No printed running-dimension string was in the ROI to cross-check against separately.

## Per-room table

| Label | Finish | Verts | Area px² | SF (computed) | Printed/Schedule | Delta |
|---|---|---|---:|---:|---:|---:|
| CONFERENCE/BREAK ROOM 134 | CPT-1 | 12 | 89,375.2 | 275.85 | — | — |
| CONFERENCE/BREAK ROOM 134 | VCT-1 | 6 | 20,890.1 | 64.48 | — | — |
| STORAGE 134A | CPT-1 | 9 | 5,298.7 | 16.35 | 16 (printed on sheet) | **+2.2%** |
| OFFICE 136 | CPT-1 | 6 | 42,256.0 | 130.42 | — | — |
| PATIENT ROOM 137 | CPT-1 | 15 | 82,519.2 | **254.69** (was 254.02) | — | — |
| TOILET 137A | PT-1/PT-2 | 7 | 20,156.0 | 62.21 | — | — |

**Revision (coordinator review):** PATIENT ROOM 137 was corrected — see "Door list" and Q6 below.
Net effect +0.67 SF (a real corridor door was added at x=2769.1/2775.4, y=1088.9–1177.0, and a
false door previously notched at y=931.0–950.6 in the same wall was removed).

Conference 134 total (CPT-1 + VCT-1) = 340.33 SF — a plausible size for a combined
conference/break room with a small kitchenette nook.

## Door list (jamb coordinates, tool px; notch depth = half the cited wall thickness)

| Room(s) | Door | Jambs | Centerline | Notch depth |
|---|---|---|---|---|
| CONFERENCE 134 ↔ west (out of ROI) | west-wall door | y=844.8 / y=950.6 | x=2132.9 | 3.1 px (wall 2129.8/2136.0) |
| CONFERENCE 134 ↔ STORAGE 134A | header door | x=2451.4 / x=2517.1 | y=934.8 | 3.6 px (wall y=931.2/938.4) |
| **PATIENT ROOM 137 ↔ corridor** | **east-wall entry door** | **y=1088.9 (north jamb, where V 2769.1/2775.4 stroke ends) / y=1177.0 (south jamb, coincides with the room's own SE corner — no separate jamb block found, same pattern as the toilet door)** | **x=2772.25** | **3.15 px (wall 2769.1/2775.4)** |
| PATIENT ROOM 137 ↔ TOILET 137A | east-wall-of-toilet door | y=1099.0 / y=1177.0 (opens to room corner, no far jamb block) | x=2686.3 | 3.6 px (wall 2682.7/2689.9) — **notched identically on both the 137 ring and the 137A ring; confirmed by direct comparison, they share this exact centerline segment** |

The west-wall door on CONFERENCE 134 spans the CPT-1/VCT-1 finish split (y=933.8), so its notch is
divided between the two rings at the shared centerline rather than drawn once — see Q2.

**Correction (coordinator review, this revision):** the corridor door above was missing from the
first pass — that stretch of wall (x=2769.1/2775.4) had simply been walked straight from y=950.6 to
the south wall at y=1177.0. Re-reading the plan: the vector wall stroke actually ends at y=1088.9
and does not resume before the south wall, and a hinge/swing-arc symbol reads from right at that
jamb, sweeping into the vestibule east of TOILET 137A — confirmed at zoom-8 (`/tmp` working crop,
reproduced during authoring) with the ring's notch vertices landing exactly on the jamb and on the
SE corner. This is PATIENT ROOM 137's entry door from the corridor. A second, previously-notched
"door" at y=931.0–950.6 in the SAME wall (only 19.6 px = ~1'-1" wide, no leaf, no arc) was removed —
see Q6.

## Open questions (rule 9)

**Q1 — OFFICE 136 / CONFERENCE 134 boundary between x=2349.1 and x=2444.2 (the "west pocket").**
No wall stroke ≥1.5px (checked directly against the un-filtered PDF vectors for y=985–1002 and for
the header band y=931–938) spans this x-range on either its north or south side. A seed dropped
inside this pocket finds no wall going up (all the way into CONFERENCE's main volume) or down
(straight into OFFICE). I resolved this by giving CONFERENCE's ring a bridge segment from
(2444.2, 931.2) to (2341.7, 933.4) and starting OFFICE's ring at y=938.4 for this column — i.e. I
split the ambiguous ~5–7 px vertical band between the two rooms roughly at the header-door
elevation. **Alternative A:** assign the whole pocket (x2349.1–2444.2, y938.4–992.9) to a *separate*
STORAGE 134A room instead of the "east box" I used — this happens to shoelace to almost exactly
16.00 SF (95.1 × 54.5 px = 5182.95 px² = 16.00 SF), a suspiciously perfect match to the printed
value. I did NOT use this reading because its south side has no drawn wall at all connecting
x=2349.1 to x=2444.2 (checked directly), so it fails rule 1 more literally than the east-box
reading (16.35 SF, +2.2%), which is enclosed by real ≥1.5px strokes on all four sides. Pixel effect
if Alternative A is preferred instead: STORAGE 134A becomes ~16.00 SF (−0.35 SF from my figure),
OFFICE 136 loses ~95×54=5130 px²≈15.8 SF, and CONFERENCE 134 CPT-1 is roughly unchanged either way.
**Also flagged:** a small gray jamb/corner-guard block (~19.7×9.6 px ≈0.5 SF) at (2341.7–2361.4,
933.4–948.0) was left inside OFFICE's simple rectangle rather than notched out (rule 5) — pixel
effect ≈0.5 SF.

**Q2 — CPT-1/VCT-1 split line (CONFERENCE 134, rule 6).** Two candidate transition indicators exist
near the tag callouts: (a) a short vertical dashed pair at x=2249.3 (y 889.7–967.9, w=0.48), and
(b) a horizontal line at y=933.8 (w=0.72) spanning the full nook width x=2135.8–2341.7. The two
finish tags ("CPT-1 ↓" at (2249,878), "↑ VCT-1" at (2249,983)) sit directly above and below (b) at
the same x, with their leader arrows pointing at each other — the classic drafting convention for
calling out a *horizontal* transition, with the vertical dashes at x=2249.3 being the leader/arrow
strokes, not the transition line itself. I used (b) as the split line. **Alternative:** if the
split were actually vertical at x=2249.3, VCT-1 would be a much smaller area confined to the SW
corner (roughly 113×101 px ≈ 35 SF instead of 64.48 SF) and a strip of CPT-1 would run across the
top of the nook down to y=933.8. I judged (a) as leader-line based on stroke pattern and position,
not a boundary, but flag this as the largest single area-interpretation risk in the whole trace.

**Q3 — STORAGE 134A alternative.** See Q1; the same ambiguity is restated here from STORAGE's side.
The "east box" I used is bounded on all four sides by confirmed ≥1.5px wall strokes: west
2444.2/2451.4, east 2554.8/2563.9, south 992.9/1000.1, north via the door (931.2/938.4 header with
small corner-return stubs at both jambs). This is the more literal (rule 1) reading even though the
west-pocket alternative matches the printed SF almost exactly.

**Q4 — OFFICE 136 south wall (y=1177.0) for x<2561.8.** The building's south exterior wall is
confirmed by ≥1.5px strokes for x=2561.8–2769.4 (y=1177.0/1183.7) but no matching stroke was found
in the walls JSON for x<2561.8 at that y, even though the room clearly runs to the same latitude
visually (VENDING 135 and the "EXIST" callout sit just below it in the wider crop) and the vertical
walls on both sides (x=2136.0/2129.8 and x=2341.7/2349.1) terminate at y≈1174.8–1176.2, consistent
with a south wall there. I extended y=1177.0 west as the office/vending south wall by inference
from those two terminating verticals rather than a directly-cited horizontal stroke. Pixel effect
if the true wall is a few px off 1177.0: negligible (<1% of OFFICE's area).

**Q5 — Schedule-row substitution for 137 / 137A.** The finish schedule on sheet AF600 has no row
numbered "137" or "137A"; it has generic rows "ROOM FINISH SCHEDULE – PATIENT ROOMS (TYPICAL)"
(FLOOR FINISH = CPT-1) and "PATIENT TOILET ROOMS" (FLOOR FINISH = PT-1/PT-2). I used these typical
rows, which matches the plan tags printed directly in each room (no plan tag conflicts with the
schedule). No SF or dimension is printed for either room to cross-check against.

**Q6 — PATIENT ROOM 137 east side: the corridor door, the false door, and the x≈2795 step
(REWRITTEN after coordinator review).** Patient room 137's east wall (x=2769.1/2775.4) has two
features that needed to be told apart:

- At y=931.0–950.6, a 19.6 px gap (≈1'-1" at 18 px/ft) — far short of any door on this sheet
  (which run roughly 50–90 px). A zoom-8 crop shows a small rectangular reveal boxed by corner
  strokes (w=0.72/0.96/1.68) with the local face stepping to x=2767.2 (1.9 px into the room from
  the main face at 2769.1) — no leaf, no swing arc. This is a wall-face reveal/thickening, not a
  door. Per rule 5 it should be "followed," but at 1.9 px it is under the 2.5 px boundary
  tolerance, so it is walked straight through in this reference (documented here rather than
  literally traced). **This was previously mis-notched as a door — now corrected.**
- At y=1088.9–1177.0 (88.1 px, a normal door width band for this sheet given the wide storage/
  toilet doors already on this plan), the wall stroke simply ends at 1088.9 and does not resume;
  a hinge/swing-arc reads right at that jamb, sweeping into the vestibule east of TOILET 137A. This
  IS a door — patient room's own entry door from the corridor — and is now notched (jambs 1088.9 /
  1177.0, centerline x=2772.25). **This was previously missing (the wall was walked straight through
  it) — now corrected.**

Separately, a parallel wall further east (x=2795.0/2801.3, y=829.0–1074.5, resuming 1157.8–1290.7,
with its own door-sized gap 1074.5–1157.8) was NOT incorporated into this ring. Its horizontal tie
(H y=1074.5/1081.7, x=2795.0–2904.0) points toward it being PATIENT ROOM 138's own west wall /
corridor wall (138's schedule tag sits around x=2902, matching the H segment's far end), not part
of 137 — treated as out of scope. If 137 in fact extends east to x=2795.0 in its lower portion
instead of stopping at 2769.1, this ring under-counts by up to roughly
(2795.0−2769.1)×(1074.5−950.6) ≈ 3,205 px² ≈ 9.9 SF.

**Wall-mounted fixture symbol, OFFICE/TOILET shared wall.** A thin-stroke (0.48/0.72 px) mark sits
directly on x=2563.9 at y=1093.7–1156.6 — the same x as the confirmed-solid 1.68 px OFFICE/TOILET
wall (2554.8/2563.9, continuous 958.3–1177.7 with no gap). A zoom-7 crop shows a small
rounded-rectangle symbol attached to the wall face with no leaf and no swing arc — a wall-mounted
accessory (e.g. grab bar or dispenser), not a door. No notch was placed there. (The room's real
door to/from the north is the one already documented above, at x=2682.7/2689.9, y=1099.0–1177.0,
shared identically between the PATIENT ROOM 137 and TOILET 137A rings.)

**Sink alcove partition, TOILET 137A.** The short return wall at (2617.9/2625.4, y=1016.9–1065.4)
inside the toilet was treated as casework (sink counter divider) per rule 1/8, not a room-defining
face, since it does not appear to close off a separately-enclosed space (the floor hatch runs
continuously underneath/around it). If it were treated as a true partition, TOILET 137A's shape
would gain a small notch around it (~7.5×48 px ≈ 1.1 SF removed from the open-floor reading, then
returned since finishes run under casework anyway per rule 1 — net effect judged to be zero for SF,
only affects whether the trace should show a jog there).

**Diagonal lines.** Two short diagonal segments were found near the PATIENT ROOM 137/TOILET 137A
corner (≈(2565,952)-(2585,1002)) and inside the toilet (the "X" ADA symbol, ≈(2564,1064)-
(2618,1010)). Both were checked directly against the PDF vectors and are 0.48px width — well under
the 1.5px wall threshold — confirmed to be hatch/fixture graphics, not walls (rule 8). They were
excluded from every boundary.

**Fake "wall-width" tag box.** The rectangle drawn tightly around the "134A" text
(x=2457.8–2525.5, y=958.1/980.6) is a Revit room-tag outline drawn at 1.68px width — the same
width as real walls — and would have been picked up by the width-only wall filter. It was
identified as non-structural by its exact coincidence with the text bounding box and excluded
(rule 1, tags/text never define a boundary).

## Files in `$A/stcloud/`

- `reference.json` — the reference geometry (6 room/finish rings across 5 rooms).
- `notes.md` — this file.
- `context.png` — whole sheet at matrix 0.25 with the ROI outlined in red.
- `overlay-all.png` — all rings, zoom 2.
- `overlay-134.png` — CONFERENCE/BREAK ROOM 134 (both CPT-1 and VCT-1 rings), zoom 4.
- `overlay-134A.png` — STORAGE 134A, zoom 4.
- `overlay-136.png` — OFFICE 136, zoom 4.
- `overlay-137.png` — PATIENT ROOM 137, zoom 4.
- `overlay-137A.png` — TOILET 137A, zoom 4.

All six overlays were opened and checked corner-by-corner and notch-by-notch against the underlying
plan linework before being accepted; the STORAGE 134A, OFFICE 136, PATIENT ROOM 137 and TOILET 137A
overlays are reproduced in full above during authoring. Open questions Q1, Q2, Q4 and Q6 are the
places where the ring is a documented judgment call rather than an unambiguous wall trace.
