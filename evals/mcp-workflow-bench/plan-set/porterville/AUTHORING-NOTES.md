# Porterville ADU A1-101 -- estimator-trace reference notes

**REV 2** -- incorporates 3 coordinator corrections (rule-3 notches on both sides of the OPT. BEDROOM
partition door and the CL. bifold door; the PANTRY wall end-cap traced explicitly instead of simplified
away). W/D left unchanged (open alcove, no door) per the coordinator's instruction, restated as an open
question below.

Source: `the 43-sheet Porterville pre-approved ADU set (page 14 extracted to porterville-adu-a1-101.pdf)`, page 14
(sheet A1-101, "FLOOR PLANS & FINISH PLANS", City of Porterville pre-approved ADU prototype; sheet states
the plans are public domain). Region traced: tool-frame px `[800, 1880, 1960, 2760]` (GROUND FLOOR PLAN,
1/4"=1'-0", lower-left of the sheet). Geometry taken from `page.get_drawings()` vector linework; finishes
from `page.get_text()` (FINISH SCHEDULE, upper plan). SHA-256 of the source PDF as currently on disk:
`e5dad484a85ec03a3fdd8a67460fee8003e17b9cd9b773eda628c0cc88d1a7f9`.

## Scale verification

Assumed `feet_per_image_px = 1/36 = 0.027777...` (1/4"=1'-0" -> 18 pt/ft -> 36 px/ft at render_scale 2).
Verified against **six** printed dimension strings by measuring tick-to-tick pixel distance between the
dimension extension lines (`lines.py` V/H dumps, thin `w=0.48` ticks) and comparing to `feet*36`:

Bottom horizontal chain (ticks at x = 803.0, 1073.3, 1289.0, 1368.5, 1577.0, 1874.6):

| segment | printed | expected px (x36) | measured px | delta |
|---|---|---|---|---|
| 1073.3-1289.0 | 6'-0" | 216.0 | 215.7 | 0.3 px |
| 1289.0-1368.5 | 2'-2 1/2" | 79.5 | 79.5 | 0.0 px |
| 1368.5-1577.0 | 5'-9 1/2" | 208.5 | 208.5 | 0.0 px |

Right vertical chain (ticks at y = 2005.0, 2105.3, 2198.4, 2289.8):

| segment | printed | expected px | measured px | delta |
|---|---|---|---|---|
| 2005.0-2105.3 | 2'-9 1/2" | 100.5 | 100.3 | 0.2 px |
| 2105.3-2198.4 | 2'-7" | 93.0 | 93.1 | 0.1 px |
| 2198.4-2289.8 | 2'-6 1/2" | 91.5 | 91.4 | 0.1 px |

All six segments match to within 0.3 px. Scale confirmed as exactly 36 px/ft; no adjustment made. The
overall building footprint (outer sheathing corners) measures 24.27 ft x 20.27 ft against printed 24'-0" x
20'-0"; the ~1.1% difference is expected because printed dimensions are "TO FACE OF FRAMING" (sheet
general note #5) while the outer sheathing line I measured sits beyond the stud face -- not a scale error.

## Per-room table (REV 2)

| Label | Finish | Finish source | Vertices | Area px² | SF | Delta vs. REV 1 |
|---|---|---|---|---:|---:|---:|
| LIVING (incl. KITCHEN) | LVP | Finish Sched. KITCHEN=LVP, LIVING=LVP (merged) | 19 | 332,294.5 | 256.40 | +0.36 SF (end-cap + notch geometry) |
| BATH | CT | Finish Sched. BATH=CT | 10 | 72,238.1 | 55.74 | unchanged |
| PANTRY | LVP (assumed) | not in schedule; assumed = adjoining open floor | 4 | 5,506.7 | 4.25 | unchanged |
| W/D | LVP (assumed) | not in schedule; assumed = adjoining open floor | 4 | 8,919.0 | 6.88 | unchanged (left as traced) |
| CL. | CPT | Finish Sched. CL.=CPT (base case: bedroom provided) | 8 | 16,714.3 | 12.90 | unchanged |
| OPT. BEDROOM | CPT | Finish Sched. OPT. BEDROOM=CPT (base case: wall/door built) | 11 | 121,190.4 | 93.51 | +1.35 SF (two new notches) |
| **Total** | | | | **556,862.9** | **429.68** | +1.71 SF vs. REV 1's 427.97 |

No printed room-area callouts exist on this sheet to check against. Gross building footprint to outside of
framing is ~24.0' x 20.0' = 480 SF; 429.68 SF interior + ~50 SF of wall/partition footprint reconciles
reasonably.

## The three notch geometries (as requested)

### 1. OPT. BEDROOM partition door (LIVING <-> OPT. BEDROOM)

- **Partition wall face lines** (both real, `w=1.44`, gray/optional stroke -- cited from `porterville-floor.json`):
  `V x=1358.2, y0=2411.5, y1=2644.6` (LIVING/living-side face) and `V x=1368.5, y0=2411.5, y1=2644.6`
  (OPT. BEDROOM/bedroom-side face). Both also carry a `w=0` hairline continuation from `y0=2300.2/2302.1`
  up to the same wall line, which is what fixes the opening's **top jamb** at y=2300.2 (the utility-row
  bottom -- where PANTRY/W-D/CL.'s own south wall sits) even though the *solid* wall drawing doesn't start
  until y=2411.5.
- **Wall thickness**: 1368.5 - 1358.2 = 10.3 px. **Centerline**: (1358.2+1368.5)/2 = **1363.35**.
- **Jamb ends**: top jamb y=**2300.2** (utility-row bottom, hairline start); bottom jamb y=**2411.5** (top
  of the partition's solid/drawn wall, matching where the door's closed-swept leaf also lands -- see below).
- **Door evidence**: the leaf is drawn OPEN, a horizontal `w=1.44` gray line at `y=2315.5/2319.6,
  x0=1370.4, x1=1466.4` (length 96.0 px = 2'-8", matching door schedule #2, type E). Hinge sits at its
  west end (~1370.4, ~2317.5), essentially flush with the wall's bedroom-face (1368.5); swinging closed
  (down) lands the leaf vertically at ~y=2317.5+96=2413.5, matching the solid wall's top (2411.5) within
  2 px. I used the full utility-row-to-solid-wall span (2300.2-2411.5, 111.3 px) as the notch, not just
  the 96 px leaf length, because that full span is where NO solid wall is drawn on either the LIVING or
  BEDROOM ring's outer-face line -- the ~15 px difference is a small fixed jamb/trim return above the
  hinge, not a second independent opening.
- **Notch depth**: 1363.35 - 1358.2 = 1368.5 - 1363.35 = **5.15 px** (half the 10.3 px wall thickness) on
  each ring.
- **Result**: LIVING's ring runs face(1358.2) -> notch to (1363.35,2300.2) -> centerline down to
  (1363.35,2411.5) -> notch out to face(1358.2). OPT. BEDROOM's ring runs the mirror image at the identical
  (x,y) pairs. The two rings share the segment `(1363.35,2300.2)-(1363.35,2411.5)` exactly -- confirmed
  visually at zoom-4 (the red boundary line sits centered between the two gray wall-face lines in both
  overlays, with no gap or overlap).

### 2. CL. bifold door (CL. <-> OPT. BEDROOM), mirrored

- **Jambs**: x=1537.7 (left) and x=1681.4 (right) -- these are the two ends of the combined bifold-leaf
  lines (`H y=2292.0/2296.1, x0=1537.7,x1=1612.6` and `x0=1606.6,x1=1681.4`, both `w=1.44`), which together
  span 143.7 px, matching door #3 (type B, 4'-0"=144 px) almost exactly.
- **Centerline** (used directly, a real drawn line rather than an estimated half-thickness, since CL.'s own
  south-wall inner face is only cleanly drawn as this one line): **y=2292.0**.
- **CL.'s own inner face**: y=2287.9 (`H y=2287.9, x0=1329.1..1395.1`-style face, CL.'s own segment
  `x0=1509.8..1713.4` context). **Notch depth**: 2292.0 - 2287.9 = **4.1 px**.
- **Mirror on OPT. BEDROOM**: previously (REV 1) OPT. BEDROOM's north edge ran flat at y=2300.2 across this
  whole span, leaving CL.'s notch (2287.9-2292.0) and a further sliver (2292.0-2300.2, ~0.9 SF) unclaimed
  by either ring. **Fixed**: OPT. BEDROOM's north edge now steps from y=2300.2 up to y=2292.0 at x=1537.7,
  runs across at y=2292.0 to x=1681.4, then steps back down to y=2300.2. CL. and OPT. BEDROOM now meet
  exactly on the segment `(1537.7,2292.0)-(1681.4,2292.0)` -- confirmed visually at zoom-4 in both
  `overlay-cl.png` and `overlay-optbedroom.png` (the boundary lines land exactly on the drawn bifold-leaf
  lines in both images, no gap between the two colored fills).

### 3. PANTRY west opening (PANTRY <-> LIVING)

- **Jamb line**: a **single** drawn hairline, `V x=1329.1, y0=2208.7, y1=2289.8` (`w=0`) -- verified at
  zoom-10 (see REV 1 investigation) that there is no second parallel face at this location (the door swings
  fully open into the Kitchen; there is no wall thickness to cross here, only the doorway's own plane).
  Per the coordinator's own fallback rule ("if it is a single line, both rings meet on that line"), PANTRY
  and LIVING both close directly on x=1329.1 for y=2208.7 to 2289.8 -- no centerline offset, since there
  is nothing to offset from. This was already the case in REV 1 and remains unchanged.
- **What WAS an unclaimed strip** (now fixed, correction 3): at the NW corner of this same wall run, the
  wall's *north* face steps between its outer/kitchen-side line (`H y=2198.4, x0=1318.8..1395.1, w=1.44`)
  and its inner/pantry-side line (`H y=2208.7, x0=1329.1..1395.1, w=1.44`) via a small end-cap poche at
  x=1318.8-1329.1 (10.3 px wide, matching wall thickness), verified visually at zoom-10 against the source
  linework (points ~(1318.8,2198.4) outer corner, ~(1329.1,2208.7) inner corner, with small intermediate
  jamb-return marks around (1320-1331, 2210-2213) reflecting the drawn corner detail within the 2.5 px
  boundary tolerance). REV 1 skipped straight from (1395.1,2198.4) to (1329.1,2198.4), omitting this ~0.03
  SF end-cap from both rings. REV 2 routes LIVING's boundary around it explicitly:
  `(1395.1,2198.4) -> (1318.8,2198.4) -> (1318.8,2208.7) -> (1329.1,2208.7)`, so the wall material is
  correctly excluded from LIVING (traced tight to its actual face) rather than silently omitted. PANTRY's
  own ring is unaffected (it never reached this corner). Confirmed visually at zoom-4 in `overlay-living.png`
  -- the boundary now hugs the small gray corner nub exactly.
- Regarding the coordinator's cited pixel range "x~935-950 (tool px)": that literal tool-frame location
  falls inside the KITCHEN counter run (near the DW/B01 cabinets, well west of any room boundary) and has
  no bearing on a room edge. Converting the same numbers as **local pixel coordinates inside
  `overlay-all.png`** (zoom 2, crop origin at tool x=854.9) instead lands at tool x = 854.9 + 935/2..950/2
  = 1322.4-1329.9 -- which matches the PANTRY/LIVING opening corner discussed above almost exactly. I have
  treated that as the intended location and fixed the end-cap gap there; flagging the coordinate-frame
  mismatch here in case a different location was actually intended.

## Doors / openings, by room (updated)

| Room | Opening | Jamb coordinates (tool px) | Centerline / notch depth | Treatment |
|---|---|---|---|---|
| LIVING/KITCHEN <-> BATH | cased opening (no leaf drawn) | x=1397.0/1407.6 faces, jambs y=2089.0 and y=2184.7 | centerline x=1402.3, depth 5.3 px | Rule 3 notch, both rings (unchanged) |
| LIVING/KITCHEN <-> PANTRY | swinging door, drawn fully open | opening plane x=1329.1 (single line), y=2208.7 to 2289.8 | none -- single line, both rings meet on it | Flush shared edge (unchanged); NW end-cap now traced (correction 3) |
| CL. <-> OPT. BEDROOM | 4'-0" double-sliding door (door #3, type B) | jambs x=1537.7 / x=1681.4 | centerline y=2292.0 (real drawn line), depth 4.1 px on CL. | Rule 3 notch, BOTH rings now (correction 2) |
| OPT. BEDROOM <-> LIVING | optional door #2, type E, 2'-8", hinged ~(1370,2317) | wall faces x=1358.2/1368.5, jambs y=2300.2 and y=2411.5 | centerline x=1363.35, depth 5.15 px | Rule 3 notch, BOTH rings now (correction 1) |
| OPT. BEDROOM south wall <-> exterior | sliding glass door, ~4'-0" (x 1505.0-1648.8) | n/a -- exterior opening | n/a | Rule 4: ring runs straight through (leads outside, not "another room") |
| Various | windows in exterior walls | n/a | n/a | Rule 4: ring runs straight through |
| W/D <-> LIVING/KITCHEN | **open alcove, no door** | header line y=2184.7/2180.6, full width x=1409.5-1505.3 | n/a | No door exists -- see open question below; left as traced (own ring, closed at the header line) |

## Open questions (rule 9)

1. **KITCHEN + LIVING merge.** Finish Schedule gives both LVP (identical). Traced as one ring labeled
   `LIVING`, KITCHEN included, per task instructions.

2. **PANTRY and W/D have no FINISH SCHEDULE row.** Assumed LVP, matching the open KITCHEN/LIVING floor they
   open onto. SF is unaffected either way; only the material call is at stake.

3. **W/D has no door -- is it a room at all?** Confirmed by close visual inspection: no wall, no door leaf,
   no swing arc on its north (open) side, only a 4 px header line. Left as its own ring (per the task's
   explicit room list), closed at that header line, but this is explicitly an open question: an estimator
   could reasonably fold this 6.88 SF into the continuous open `LIVING` LVP field instead, exactly as
   KITCHEN was folded in. Total conditioned SF is unchanged either way; only whether W/D gets its own line
   item is at stake. **Left as traced, per the coordinator's explicit instruction.**

4. **OPT. BEDROOM partition-door notch span.** I used the full utility-row-to-solid-wall gap (2300.2 to
   2411.5, 111.3 px) as the rule-3 notch span rather than just the door leaf's own drawn length (96 px),
   because no solid wall face is drawn on either ring's outer line anywhere in that full gap -- the ~15 px
   difference reads as a fixed trim/jamb return above the hinge, not a second, independent opening.
   Alternative: notch only the 96 px leaf span and treat the remaining ~15 px as if solid wall existed
   there (it doesn't, per the linework) -- rejected as less literal.

5. **CL. notch centerline uses a real drawn line (y=2292.0), not a computed half-thickness.** CL.'s own
   south wall doesn't carry a second, independently-drawn outer face the way PANTRY/W-D's does; the
   clearest real citation at this location is the bifold-leaf/track line itself. Both CL. and (now)
   OPT. BEDROOM meet there.

6. **OPT. BEDROOM / CL. base case vs. alternate.** The dividing wall (both the CL. one, always built, and
   the OPT. one, explicitly optional) matters here only for OPT. BEDROOM: traced base case = wall built.
   Documented alternative (per the schedule's own "LVP WHEN BEDROOM NOT PROVIDED" notes on both the
   OPT. BEDROOM and CL. rows): if not built, OPT. BEDROOM's 93.51 SF and CL.'s 12.90 SF both fold into
   `LIVING` as LVP -- LIVING would grow from 256.40 SF to 256.40 + 93.51 + 12.90 = 362.81 SF.

7. **BATH/CL./PANTRY north-wall step under W/D.** BATH's south boundary steps between y=2208.7 (over
   PANTRY and CL.) and y=2184.7 (over W/D). Traced literally per rule 5.

## Unresolved / not independently verified

- No printed room-area callouts exist on this sheet to cross-check the SF totals against.
- The exterior porch alternates (CAL RANCH / AGRARIAN / CRAFTSMAN / SPANISH) are outside the traced region.
- Human review of this trace has not occurred (`review.human_reviewed: false` in reference.json).

## File list

- `reference.json` -- the reference geometry (REV 2), scale, finishes, tolerances
- `notes.md` -- this file
- `context.png` -- whole sheet at matrix 0.25 with the traced region outlined in red
- `overlay-all.png` -- zoom 2, all six rooms overlaid together (regenerated, REV 2)
- `overlay-living.png`, `overlay-cl.png`, `overlay-optbedroom.png` -- zoom 4, regenerated (REV 2)
- `overlay-bath.png`, `overlay-pantry.png`, `overlay-wd.png` -- zoom 4, unchanged from REV 1 (rings unchanged)
