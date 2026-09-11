# Task: trace these rooms like an estimator

You are given one construction plan sheet and a list of rooms. Produce a floor takeoff
of those rooms using only the public OpenTakeoff MCP tools and resources. Do not read
any file under `evals/`.

## Deliverable

One committed floor-area shape per room **and per floor finish**, labeled with the room
name and number exactly as the room list prints it, assigned to a condition whose finish
tag is exactly the finish listed, on the sheet named. Export the takeoff JSON. Leave
human review pending; do not approve anything.

## How an estimator traces a room

1. The boundary is the **innermost interior wall face**. Never the wall centerline, never
   the far face, never under a wall. Casework, counters, fixtures, plumbing, hatch
   patterns, dimension strings, text and leaders never define the boundary; finishes run
   under casework and fixtures.
2. Corners sit where two adjacent wall faces meet. Read the wall lines from the sheet's
   vectors and confirm them on a zoomed render; do not trace to a hatch edge or a raster
   guess.
3. At every **door or cased opening** the ring follows the wall face to the jamb, turns
   into the opening along the jamb, runs across the opening on the **wall centerline**
   (midway between the two faces of that wall), and returns along the far jamb. Every
   door gets this notch. The door leaf and swing arc are not part of the boundary.
4. **Windows** and other non-passable openings in exterior walls do not break the ring;
   run straight along the wall face.
5. Columns, pilasters, chases and furred bumps that project into the room: trace around
   them. Stepped or offset faces: follow each step.
6. A **finish split** inside one room: two rings sharing the split edge exactly, the
   edge on the drawn finish-transition line (or the hatch boundary if that is the only
   drawn evidence). No overlap, no gap.
7. If the sheet has a finish schedule, read the finish there; a plan tag alone is a
   cross-check.
8. When something is genuinely ambiguous, pick the reading that follows rules 1–7 most
   literally, carry it, and say so in the shape's label or a note. Do not stop.

## Plans and rooms

Filled per plan below. Scale is given so the trial measures drawing, not scale reading;
set it with `set_scale` exactly as stated before measuring.

### St. Cloud AF101 (`demo/sample-finish-plan.pdf`, page 1; sheet id `sample-finish-plan.pdf`)

Scale: 1/8" = 1'-0", `set_scale { sheet: "sample-finish-plan.pdf", upp: 0.05555555555555555 }`
(18 image px per foot). The finish schedule is page 2 (`sample-finish-plan.pdf#2`).

| Room label | Floor finish | Note |
|---|---|---|
| `CONFERENCE/BREAK ROOM 134` | `CPT-1` | the carpet field |
| `CONFERENCE/BREAK ROOM 134` | `VCT-1` | the vinyl area at the west end by the sink; the transition is the line both finish arrows point at |
| `STORAGE 134A` | `CPT-1` | the sheet prints 16 SF in this room |
| `OFFICE 136` | `CPT-1` | |
| `PATIENT ROOM 137` | `CPT-1` | door to the corridor and door to 137A; windows on the north wall |
| `TOILET 137A` | `PT-1/PT-2` | dense tile hatch |

### Roseburg A-03a (`evals/mcp-workflow-bench/plan-set/roseburg/va-roseburg-a03a.pdf`; sheet id `va-roseburg-a03a.pdf`)

The sheet is NOT TO SCALE and its room boxes do not agree with the printed net SF. Use the
nominal scale `set_scale { sheet: "va-roseburg-a03a.pdf", upp: 0.015151515151515152 }`
(a 3 ft 0 in door leaf over the 198 px door openings). The printed NSF figures are not a
target; trace the linework. Text is outlined: `read_sheet_text` returns nothing, so read
labels from the render. Floor finish for all four rooms is `VSF` (sheet A-05 schedule).

| Room label | Floor finish |
|---|---|
| `D105B STORAGE` | `VSF` |
| `D105A OFFICE` | `VSF` |
| `D104 OFFICE` | `VSF` |
| `D105 OFFICE` | `VSF` |

### Porterville A1-101 (`evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf`; sheet id `porterville-adu-a1-101.pdf`)

Use the GROUND FLOOR PLAN (lower left of the sheet) for geometry and the FINISH SCHEDULE on
the same sheet for finishes. Scale 1/4" = 1'-0",
`set_scale { sheet: "porterville-adu-a1-101.pdf", upp: 0.027777777777777776 }` (36 image px per foot).

| Room label | Floor finish | Note |
|---|---|---|
| `LIVING` | `LVP` | one ring covering LIVING and the open KITCHEN (same finish, no wall between) |
| `BATH` | `CT` | |
| `PANTRY` | `LVP` | no schedule row; carried as LVP with the living area |
| `W/D` | `LVP` | no schedule row; carried as LVP; open alcove, no door |
| `CL.` | `CPT` | bifold door |
| `OPT. BEDROOM` | `CPT` | trace the bedroom as drawn with the optional wall built |
