# Task: floor takeoff of the listed rooms

You are given one construction plan sheet and a list of rooms. Produce a floor takeoff of those rooms using only the public OpenTakeoff MCP tools and resources. Do not read any file under `evals/`.

## Deliverable

One committed floor-area shape per room **and per floor finish**, labeled with the room
name and number exactly as the room list prints it, assigned to a condition whose finish
tag is exactly the finish listed, on the sheet named. Export the takeoff JSON. Leave
human review pending; do not approve anything.

## Plans and rooms

Scale is given; set it with `set_scale` exactly as stated before measuring.

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

