# Open estimator questions

Each question names the option the reference carries (first) and the alternative, with
the effect in pixels or SF where measured. Nothing here blocks the evaluation; a human
ruling changes the reference and bumps its `reference_id`.

## All plans

**Q1. Door openings: where does the room's floor stop?**
- (a) *Carried.* At the wall centerline across the opening: the ring follows the jamb into the wall to the midpoint between the two face lines. This is the estimator convention the reference follows (a flooring seam lands under the closed door leaf; Roseburg A-03a keyed note 3 says the same in the architect's words).
- (b) At the face line, closing the opening as if the wall were continuous. Effect: each door removes a notch of (opening width × half wall thickness); a 3 ft door in a 6 in wall is 0.75 SF per door.
- (c) At the far face (the whole wall thickness under the door). Effect: doubles (b).

**Q2. Windows and non-passable openings** are ignored (ring runs along the face). Alternative: none carried; a window sill is not floor.

## St. Cloud AF101 (`stcloud/`)

**Q5. Room 134 finish split.** (a) *Carried.* The CPT-1/VCT-1 transition is the horizontal line at y = 933.8 px (the counter-edge line that both the CPT-1 ▼ and VCT-1 ▲ arrows point at), giving VCT-1 ≈ 64.5 SF across the full width of the kitchenette strip. (b) The vertical dashed marks at x ≈ 2249 are the transition and VCT-1 is only the sink half of the strip; effect: VCT-1 roughly halves and CPT-1 grows by the same.

**Q6. Pocket between STORAGE 134A and OFFICE 136** (x 2349–2444, y ≈ 933–1000): no wall stroke closes it on either side. (a) *Carried.* Split at y ≈ 935 so 134A stays enclosed by drawn walls on four sides; 134A then reads 16.35 SF against the printed 16 SF (+2.2 %). (b) Give the whole pocket to 134A (exact 16.00 SF but no drawn south wall). Swing ≈ 16–20 SF between the two rooms.

**Q7. PATIENT ROOM 137 east wall recess** (x 2769–2775, y 931–951, about 1 ft wide): not a door. (a) *Carried.* Followed as a step in the wall face (rule 5). (b) Ignore as a wall-mounted symbol. Effect under 0.4 SF.

**Q8. Finish schedule rows.** Page 2 has no rows for 137 / 137A by number; the reference uses the "PATIENT ROOMS (TYPICAL)" CPT-1 row and the "PATIENT TOILET ROOMS" PT-1/PT-2 row, which match the plan tags. 134A uses the storage row (CPT-1).

## Roseburg A-03a (`roseburg/`)

**Q3. Scale and the printed net SF.** The sheet is NOT TO SCALE and its room boxes do not agree with the printed NSF: as drawn, D105A (483,321 px²) is a larger box than D105 (394,766 px²), while the sheet prints 165.2 NSF and 231.6 NSF respectively. No single scale reconciles the four rooms (deriving it from D105 puts the other three 62–74 % over their printed values; deriving it from D104 puts D105 38 % under).
- (a) *Carried.* Treat the plan as geometry only: nominal scale = a 3 ft 0 in door leaf over the 198 px door openings drawn on the sheet (0.015152 ft/px); rings are scored by IoU and boundary distance in pixels; SF under this scale is a geometry check, not a building area; the printed NSF is recorded beside each room as a space-inventory figure and is not a target.
- (b) Drop the plan from the set and replace it with a to-scale public floor plan.
- (c) Keep the printed NSF as the answer key and abandon geometric scoring for this plan (an estimator would use the printed NSF for a budget and never trace this sheet).

**Q4. D105 SE corner:** a 5.6 px disagreement between the long exterior-wall line and a south-wall jamb tick; the ring uses the longer line (sub-0.01 % of area).

## Porterville A1-101 (`porterville/`)

**Q9. KITCHEN and LIVING** are one open space with the same finish (LVP): (a) *Carried.* One ring labeled LIVING covers both. (b) Two rings split on the finish plan's hatch boundary; no drawn transition line exists on the floor plan.

**Q10. PANTRY and W/D have no finish-schedule row.** (a) *Carried.* LVP, continuing the living-area finish. (b) RFI to the architect; carry LVP meanwhile. Effect: 11 SF total.

**Q11. W/D is an open alcove** (no wall or door on its open side). (a) *Carried.* Its own ring, closed on the wall-face line across the opening. (b) Fold its floor into the room it opens to. Effect: 6.9 SF moves between rings.

**Q12. OPT. BEDROOM and CL.** are shown with an optional wall and door ("OPT WALL & DOOR TO CREATE BEDROOM"); the schedule notes LVP when the bedroom is not provided. (a) *Carried.* Trace the plan as drawn: bedroom and closet as CPT rings bounded by the optional wall. (b) Bedroom not built: OPT. BEDROOM and CL. fold into LIVING as LVP (LIVING ≈ 361 SF instead of ≈ 256 SF).
