# Roseburg A-03a estimator trace -- notes

Source: `va-roseburg-b1ac-dwing-replace-finishes.pdf`, page 8 (sheet A-03a, Floor Plan - Area A), region x
2800-4720 / y 1760-3000 in the tool frame (PDF pt x2, page rotation 270 applied, matching `roseburg-offices.json`
and `roseburg-offices.png`). Finish schedule read from page 14 (sheet A-05). Tracing method followed
`CONVENTIONS.md` literally: innermost interior wall face, vertices snapped to cited V/H segments from
`lines.py` output, door notches to wall centerline, no boundary to hatch.

All four rings were built from a widened line dump (`roseburg/wide.json`, region x2750-4700/y1780-3150,
minlen 8) because the original region cut off D105's east/south walls. Every room was then checked against the
actual rendered linework with high-zoom crops (`roseburg/*.png`, listed below) before being locked in, and
finally verified with `overlay_clip.py`/`overlay_region.py` at zoom 2 (all four together) and zoom 4-6 (each
room, plus two tight corner checks) -- see "Overlay verification" below. All four rings snap to the wall lines
with no visible gap or overshoot at zoom 4-6.

## Scale derivation (fpp)

Per the task, `feet_per_image_px` is derived from D105 OFFICE (printed 231.6 NSF), the largest simple room:

```
ring_area_px^2 (D105, shoelace of the 16-vertex ring) = 394,765.5
fpp = sqrt(231.6 / 394,765.5) = 0.024221 ft/px   (1 ft = 41.29 tool-px)
```

D105's own delta is 0.00% by construction (it is the calibration room).

### Independent checks against the other three rooms' printed NSF

| Label | Finish | Verts | Area px^2 | SF @ fpp | Printed NSF | Delta % |
|---|---|---:|---:|---:|---:|---:|
| D105B STORAGE | VSF | 10 | 173,495.7 | 101.79 | 58.6 | **+73.7%** |
| D105A OFFICE | VSF | 13 | 483,321.3 | 283.55 | 165.2 | **+71.6%** |
| D104 OFFICE | VSF | 8 | 357,158.5 | 209.54 | 129.6 | **+61.7%** |
| D105 OFFICE | VSF | 16 | 394,765.5 | 231.60 | 231.6 | 0.0% (reference) |

### Door-width sanity check

Every door opening on this sheet is a strikingly consistent width in tool-px: 198.0px for the four doors at
D105A/D105 (west), D105/113.6-office, D104/corridor, and D105/corridor; 188.5-189.0px for the D105B/D105A door
(same door family, ~5% narrower, plausibly a 2'-10" or hand-measured variant of the same block). Treating
198px as a standard 3'-0" door gives a *second* candidate scale:

```
door-implied fpp = 3 / 198 = 0.015152 ft/px
```

This disagrees with the D105-derived fpp by a factor of **1.60x** (0.024221 / 0.015152 = 1.599). Applying the
door-implied fpp to D105's own ring gives 394,765.5 x 0.015152^2 = 90.65 SF -- far below the printed 231.6 NSF.

### Reading these two findings together (open question, rule 9)

Both checks point the same direction and by a similar, non-trivial margin (linear-scale factors of 1.27-1.32
for the three room-area checks, 1.60 for the door-width check). Given:

1. every ring was independently verified against the actual vector linework at zoom 4-6 and matches the wall
   faces with no visible offset (see overlay list below), and
2. the sheet is explicitly labeled **NOT TO SCALE**,

the most literal, best-supported reading is that this sheet's room-box linework is a schematic ("bubble
diagram") layout -- box sizes and door symbols were drawn to fit the room-name/SF text and to show adjacency,
not to a consistent real-world scale -- so the printed NSF numbers are the only trustworthy quantity on the
sheet, and a single global `feet_per_image_px` cannot make the drawing's own geometry self-consistent. This
was carried through literally per the task's instruction (derive fpp from D105, report but do not adjust to
match), rather than picking whichever fpp makes the numbers look nicer. Flagged as the primary open question
for human review; a reviewer may prefer per-room fpp or may prefer to treat the printed NSF as authoritative
and disregard `tolerances.area_percent` for this sheet.

## Per-room detail

### D105B STORAGE (VSF)
- 10 vertices; one door (east wall, to D105A), jamb y = 1927.3 to 2116.3 on the x=3250.8/3277.8 wall pair
  (width 188.5px = 4.57 ft @ fpp), notch depth 13.5px (half of 27px wall thickness) to centerline x=3264.3.
- NE corner has a small (67 x 63px) structural-column pilaster (I-beam plan symbol) projecting into the room
  from the exterior-wall corner; traced around per rule 5. Confirmed by direct crop (`roseburg/corner-zoom.png`).
- North/west (exterior) and south (to "NO WORK", not traced) walls are solid, no additional openings.

### D105A OFFICE (VSF)
- 13 vertices; two doors: west to D105B (shares the notch above), south to D105 (jamb x=4092.4-4290.4, width
  198.0px, notch depth 11.25px to centerline y=2370.55).
- East boundary steps around a dogleg pier shared with a small (113.6 NSF, not a target room) office to the
  east: x=4126.1 down to y=2118.6, east to x=4290.4, down to the south wall. Confirmed by direct crops
  (`roseburg/pier-zoom2.png`, `roseburg/pier-check.png`) that this is a single continuous inner-face line, not
  two separate walls with a gap.

### D104 OFFICE (VSF)
- 8 vertices, simplest room; one door (south, to corridor E124), jamb x=3664.8-3862.8 (198.0px), notch depth
  10.15px to centerline y=2937.65 (keyed note 3 callout, seam mid-door).
- West wall (shared with "NO WORK", not traced) is drawn with a heavier (1.68pt) lineweight for its upper half
  and thin (0.12pt) for its lower half but is one continuous, ungapped face at x=3228.2 -- no door there.
  Confirmed by direct crop (`roseburg/d104-west.png`): the fixture visible in "NO WORK" (rounded mop-sink/
  shower-pan symbol) sits entirely on the far side of that line and does not touch it (rule 1, fixtures never
  define a boundary).

### D105 OFFICE (VSF) -- fpp reference room
- 16 vertices, three doors: two side-by-side in the north wall (west one to D105A, sharing the notch above;
  east one to the small 113.6-office, jamb x=4344.4-4542.4, width 198.0px, notch depth 10.1px to centerline
  y=2371.75) separated by a 54.0px mullion, plus one south to corridor E124 (jamb x=4254.4-4452.4, 198.0px,
  notch depth 10.15px to centerline y=2937.65, keyed note 3).
- The two north doors' swing arcs are mirror images, each hinged at the mullion/pier corner and drawn resting
  flush against the adjacent pier wall when open -- confirmed visually (`roseburg/office113-full.png`,
  `roseburg/pier-zoom.png`, `roseburg/d105-door-zoom.png`).
- East (exterior) wall face used is x=4615.4, the long continuous building-perimeter line (spans the full
  building height, y153.7-3716.8). A short jamb tick from the south wall lands at x=4609.8 instead (5.6px
  short) -- see open question below.

## Doors summary

| Rooms | Wall | Jamb range (px) | Width (ft @ fpp) | Notch depth (px) | Centerline |
|---|---|---|---:|---:|---|
| D105B <-> D105A | x=3250.8/3277.8 | y 1927.3-2116.3 | 4.57 | 13.5 | x=3264.3 |
| D105A <-> D105 | y=2359.3/2381.8 | x 4092.4-4290.4 | 4.80 | 11.25 | y=2370.55 |
| D105 <-> 113.6-office (not traced) | y=2361.6/2381.8 | x 4344.4-4542.4 | 4.80 | 10.1 | y=2371.75 |
| D104 <-> E124 corridor (not traced) | y=2927.5/2947.8 | x 3664.8-3862.8 | 4.80 | 10.15 | y=2937.65 |
| D105 <-> E124 corridor (not traced) | y=2927.5/2947.8 | x 4254.4-4452.4 | 4.80 | 10.15 | y=2937.65 |

All five doors are the same drawn family (~198px, one at 188.5px); see the door-width sanity check above for
why 198px does not cleanly equal a real 3'-0" at the D105-derived fpp.

## Open questions (rule 9)

1. **Global scale inconsistency (primary finding).** See "Reading these two findings together" above. D105's
   fpp does not reproduce D105B/D105A/D104's printed NSF (61.7-73.7% high) nor a standard 3'-0" door (60% high).
   All four rings were re-verified against the vector linework at zoom 4-6 with no offset found, so this is
   read as a property of the NTS source sheet, not a tracing error. Alternative not taken: deriving fpp from
   the mean of all four rooms (least-squares) gives fpp=0.018670, which still misses D105 itself by -40% and
   the door width by +23% -- no single fpp reconciles all of it, reinforcing (1) rather than pointing at a
   different "correct" fpp.
2. **D105 SE corner, 5.6px discrepancy.** The long exterior-wall line (x=4615.4, continuous full building
   height) and the south-wall's own jamb tick (x=4609.8, y2927.5-2947.8) disagree by 5.6px at the corner where
   they should coincide. Used x=4615.4 (the more literal/long-run citation) for the corner; if a reviewer
   prefers the jamb tick, D105's SE corner (and the adjoining NE corner at the same x) would move ~5.6px west,
   a sub-0.01% effect on D105's area.
3. **113.6-office and corridor E124 were read only far enough to place D105A's and D105's shared walls/doors
   correctly; their own rings were not traced** (out of scope: 113.6-office is not one of the four target
   rooms, and the corridor was explicitly excluded by the task).

## Files produced

- `reference.json` -- the four room rings, scale, tolerances, review block.
- `notes.md` -- this file.
- `context.png` -- whole displayed page at matrix 0.25 with the traced region outlined in red.
- `overlay-all.png` -- all four rings at zoom 2.
- `overlay-D105B.png`, `overlay-D105A.png`, `overlay-D104.png`, `overlay-D105.png` -- each ring at zoom 4.
- Working/verification crops (not deliverables, kept for traceability): `wide.json`, `wide-context.png`,
  `d105-zoom.png`, `d105-door-zoom.png`, `corner-zoom.png`, `step-zoom.png`, `pier-zoom.png`, `pier-zoom2.png`,
  `pier-check.png`, `d104-west.png`, `office113-full.png`, `d105-north.png`, `se-corner.png`.
