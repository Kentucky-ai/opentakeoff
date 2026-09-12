# RUN-NOTES — St. Cloud AF101 floor takeoff (stcloud-before-1)

Blind trial. Inputs read: TASK-stcloud-stripped.md, server initialize instructions (opentakeoff 0.9.83),
tools/list schemas, wiki index + workflows + mcp + domain + tool-index, and the plan through the tools.
Nothing else opened.

Scale: `set_scale {sheet:"sample-finish-plan.pdf", upp:0.05555555555555555}` as stated (18 px/ft). Confirmed
against the burned-in grid on every crop (grid_px_per_foot 18).

Method: server doctrine — a room's polygon is its wall faces. Boundaries were taken from `sheet_context`
vector segments (axis-aligned wall lines, meta pen 18/20) and confirmed on `view_sheet` crops at 3–10x.
Doors do not alter a floor boundary (I trace to the wall line at every door). Casework (the 134 sink
counter, the 137A vanity) is not a wall, so the floor runs under it. Nothing approved; all six shapes
are unreviewed agent pencil (dashed blue in the overlay).

All coordinates below are full-sheet image px at render scale 2.0.

## Per room

### CONFERENCE/BREAK ROOM 134 — CPT-1 (carpet field) — 274.21 SF, shp-6aaa7a7f
Polygon (2136,704.9) (2526,704.9) (2526,931.2) (2361.4,931.2) (2361.4,933.8) (2136,933.8).
- North: inner face of the exterior wall at y=704.9 (the 697–704.9 band is the furring layer; windows
  sit inside the wall, no bay).
- West: face of the corridor wall at x=2136 (door to CONNECTING CORRIDOR T1 at y 848–920; traced
  straight across the opening).
- East: face of the 134/137 wall at x=2526.
- South: the CPT-1/VCT-1 transition line at y=933.8 (the line both finish arrows point at; vector segment
  933.8 from x 2135.8 to 2347) for x<2361.4, then the north face of the 134/136 wall at y=931.2 east of
  the column at 2347–2361.4 (column top ~932.6, treated as 931.2–933.8 step).
- Storage door opening (x 2460–2520) in that wall: traced straight along the wall line.

### CONFERENCE/BREAK ROOM 134 — VCT-1 (vinyl bay by the sink) — 57.43 SF, shp-72833100
Polygon (2136,933.8) (2341.7,933.8) (2341.7,990.2) (2292.7,990.2) (2292.7,1034.9) (2136,1034.9).
- North: the transition line y=933.8. West: corridor wall face x=2136. East: face of the 136 west wall
  x=2341.7. South: north face of the 134/135 wall y=1034.9.
- UNSURE 1 — the sink counter (x 2136–2292.7, y 997.4–1034.9, 18.1 SF): the plan's VCT hatch stops at
  the counter front and leaves the counter white. I ran the VCT under it (wall faces; casework is not a
  wall). If the reference stops at the hatch, VCT-1 would be ~39.4 SF instead of 57.4.
- UNSURE 2 — the 2'-4" x 2'-1" box at x 2299.2–2341.7, y 996.7–1034.9 (5.0 SF): it is enclosed on all
  four sides by wall-weight lines (an L-shaped stub at 2292.7–2299.2 / 990.2–996.7 plus the 136 wall
  and the 135 wall) yet the VCT hatch is drawn inside it. I treated it as a walled chase and excluded
  it. Including it would make VCT-1 62.4 SF.
- Not withheld, but noted: the P-1 tag inside the counter is a wall-paint tag, not a floor finish.

### STORAGE 134A — CPT-1 — 16.11 SF, shp-44eb13b0
Polygon (2451.4,938.4) (2526,938.4) (2526,952.8) (2554.8,952.8) (2554.8,992.9) (2451.4,992.9).
- The 134/137 wall (x 2526–2535.4) runs 14 px past the storage north wall into the room's NE corner, and
  the column pocket (2535.4–2563.9 x 902.6–953) sits east of it; the east face below that is x=2554.8.
  Tracing that jog gives 16.1 SF, which matches the "16 SF" printed on the sheet (a plain rectangle to
  2554.8 would be 17.4). Door in the north wall at x 2460–2520: traced along the wall line.

### OFFICE 136 — CPT-1 — 127.68 SF, shp-d47d2884
Polygon (2361.4,938.4) (2444.2,938.4) (2444.2,1040.6) (2451.4,1040.6) (2451.4,1000.1) (2554.8,1000.1)
(2554.8,1174.8) (2349.1,1174.8) (2349.1,950) (2361.4,950).
- North: south face of the 134/136 wall y=938.4. West: x=2349.1. East: x=2554.8 (wall shared with the
  toilet). South: north face of the corridor wall y=1174.8.
- Notched out: the storage block with its walls (2444.2–2554.8 x 938.4–1000.1), the wall stub that
  continues below the storage south wall (2444.2–2451.4 x 1000.1–1040.6), and the NW column
  (2349.1–2361.4 x 938.4–950). The SW column sits below y 1174.8 and does not intrude.
- Doors (from 134 at x ~2380–2437, to the corridor at x ~2372–2432): traced along the wall lines.

### PATIENT ROOM 137 — CPT-1 — 248.41 SF, shp-d6b2a22d
Polygon (2535.4,704.9) (2769.1,704.9) (2769.1,1177) (2689.9,1177) (2689.9,1002.2) (2563.9,1002.2)
(2563.9,902.6) (2535.4,902.6).
- North: y=704.9 (three windows in the exterior wall). East: inner face of the east wall x=2769.1 (the
  small pilaster at y 931–950.6 is flush within ~2 px; ignored).
- West: x=2535.4 down to y=902.6, then the boundary steps east to x=2563.9 around the enclosed
  column pocket (2535.4–2563.9 x 902.6–953), then down x=2563.9 to the toilet's north wall.
- South: the toilet's north wall face y=1002.2 (x 2563.9–2689.9), the toilet's east wall face x=2689.9
  (down to 1177), then the south wall face y=1177 east of the toilet to x=2769.1. The toilet door
  (opening y 1099–1159 in that east wall) swings into 137; traced along the wall line.
- UNSURE 3 — the "door to the corridor": no door leaf/arc is drawn on 137's south wall (wall lines in
  this set are not broken at doors; doors show only as leaf + swing). The only swing touching 137 is
  the 137A door. A revision cloud sits over the SE corner / elevator lobby below. This does not change
  the floor boundary, so I left it as a note rather than an RFI.
- resolve_tag returns "unresolved" for 137 (no room-finish schedule row). Finish CPT-1 taken from the
  task list; the plan's own CPT-1 arrow at the toilet door threshold corroborates it. Flag for the
  estimator: the schedule needs a 137 row.

### TOILET 137A — PT-1/PT-2 — 60.40 SF, shp-faf4297f
Polygon (2563.9,1008.7) (2617.9,1008.7) (2617.9,1065.4) (2625.4,1065.4) (2625.4,1008.7) (2682.7,1008.7)
(2682.7,1177) (2563.9,1177).
- West x=2563.9, north y=1008.7, east x=2682.7 (the hatch edge / wall face), south y=1177.
- Excluded the privacy partition (2617.9–2625.4 x 1008.7–1065.4).
- UNSURE 4 — the vanity alcove (x 2625.4–2682.7, y 1008.7–1054.8, 8.2 SF): the dense tile hatch stops at
  the counter front; the strip above it (1008.7–1016.9) reads as a shelf/ledge. I ran the tile to the wall
  face under the counter (casework is not a wall). Hatch-only would be ~52.3 SF.
- resolve_tag returns "unresolved" for 137A (no schedule row). PT-1/PT-2 is printed on the plan at the
  room with an arrow to the door threshold, and the task lists it; used as given. Flag with 137.

## Totals reported by the tool (export_report)
CPT-1 666.41 SF (4 shapes) · VCT-1 57.43 SF · PT-1/PT-2 60.40 SF. Waste 0, multiplier 1 (untouched).

## Exports
- out/export_takeoff.json — opentakeoff.takeoff_canvas.v1, 6 shapes, 3 conditions, labels attached.
- out/report.json — opentakeoff.report.v1.
- out/marked.pdf — 2 pages (legend cover + AF101), 6 shapes drawn, 0 approvals.

## Tool-call count
MCP tool calls: 44
- load_plan 1, set_scale 1, find_text 13, resolve_tag 5, view_sheet 9 (1 full sheet, 5 crops, 3 zooms —
  one of the 9 is the overlay audit), sheet_context 1, measure_polygon 6, edit_shape 6 (labels only —
  measure_polygon has no label field), export_takeoff 1, export_report 1, export_marked_pdf 1.
Non-tool relay reads: initialize 1, tools/list 1, resources/list 1, wiki resource reads 5. Total relay
requests 52.
