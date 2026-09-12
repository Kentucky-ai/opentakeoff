# RUN-NOTES — St. Cloud AF101 blind trial (stcloud-after-1)

Server: opentakeoff 0.9.84 via local relay. Plan: `demo/sample-finish-plan.pdf` (AF101 page 1, AF600 finish schedule page 2).
Scale set exactly as the task states: `set_scale { sheet: "sample-finish-plan.pdf", upp: 0.05555555555555555 }` (18 px/ft, unconfirmed agent calibration).
Guidance followed: server initialize instructions + `takeoff://wiki`, `takeoff://wiki/workflows` ("Trace a room the way an estimator does"), `takeoff://wiki/mcp`.
Method for every room: `find_text` to locate the tag, `resolve_tag` for the schedule row, `get_sheet_vectors` over x 2100-2820 / y 660-1220 and a local axis-aligned stroke sort (pen weight + position) to find the innermost wall-face strokes, `view_sheet` crops (grid:"auto", px 2000) to confirm, `measure_polygon` with `condition`, `edit_shape` to set the label, `view_sheet overlay:true` tight crops to audit. No edits to geometry were needed after the audit.
All six shapes sit in one proposal (`prop-6b632ef0-...`), all `reviewed: false`. Nothing approved.

Outputs: `out/export_takeoff.json`, `out/report.json`, `out/marked.pdf` (2 pages: legend cover + AF101, 6 shapes drawn).

## Schedule evidence
- 134 CONFERENCE/BREAK: AF600 row 134 FLOOR = `CPT-1/VCT-1` (resolved).
- 134A STORAGE: AF600 row 134A FLOOR = `CPT-1` (resolved).
- 136 OFFICE: AF600 row 136 FLOOR = `CPT-1` (resolved).
- 137 PATIENT ROOM and 137A TOILET: `resolve_tag` returns **unresolved — no schedule row**. The plan tags on AF101 read `CPT-1` (arrow at the 137A door, 137 side) and `PT-1/PT-2` (inside 137A). I carried the task's tags (CPT-1, PT-1/PT-2), which match those plan tags. Flag for the estimator: the room finish schedule does not list 137/137A; a human should confirm or RFI before pricing.

## Per-room rings (sheet image px, render scale 2.0)

### CONFERENCE/BREAK ROOM 134 — CPT-1 — 278.43 SF (perimeter 70.99 LF, 20 verts)
Boundary: north = inner face of exterior wall y=704.9 (windows at 2212-2270, 2347-2364, 2423-2482 run straight past); east = x=2526 (the 134/137 partition's west face); west = x=2136 (inner face of the furred partition in front of the existing wall at 2110-2130); south = the office/storage wall's top face y=931.2 from x=2341.7 to 2526, and the drawn CPT/VCT transition line y=933.8 from x=2136 to 2341.7 (the line both finish arrows point at). Small 2.6 px step between the two at x=2341.7 (the corner block's top face is 931.2, the transition line 933.8).
Doors crossed on wall centerline: (a) corridor door on the west wall, opening y 844.8-919.7 (4'-0" leaf), crossed at x=2123.2 = mid of 2110.3/2136; (b) office 136 door on the south wall, x 2380.3-2434.6, crossed at y=934.8 = mid of 931.2/938.4; (c) storage 134A door, x 2460.2-2514.5, crossed at y=934.8. Door leaves/arcs ignored.
Unsure: the west door's south jamb — the furred face (2135.8) resumes at y=931.0 while the base-wall face (2129.8) resumes at 922.8; I followed the strokes literally (2123.2 -> 2129.8 at 919.7, -> 2135.8 at 931.0). Effect < 0.3 SF.

### CONFERENCE/BREAK ROOM 134 — VCT-1 — 57.43 SF (34.09 LF, 6 verts)
Boundary: north = transition line y=933.8 shared exactly with the CPT-1 ring; west = x=2136; east = x=2341.7 (west face of the 134/136 wall); south = y=1034.9, the wall face behind the sink counter (counter box 997.4-1033.4 is casework; finish runs under it, ring goes to the wall).
Decision: the enclosed cell at x 2292.7-2341.7, y 990.2-1034.9 (about 2'-8" x 2'-6") at the east end of the counter is outlined with wall-weight (pen 2) double lines on all sides and has no door. Per the workflow rule "an enclosed cell drawn with wall-weight lines is not floor" I EXCLUDED it (~6.8 SF). If the estimator reads it as a pantry/alcove with VCT, VCT-1 becomes ~64.2 SF. Flagged.

### STORAGE 134A — CPT-1 — 16.72 SF (17.94 LF, 10 verts)
Boundary: west x=2451.4, east x=2554.8, south y=992.9, north y=938.4. The 134/137 partition (2526-2535.4) and its column block run down into the room's NE corner to y=952.8, so the ring wraps that block (2526-2554.8 x 938.4-952.8). Door on the north wall x 2460.2-2514.5 crossed at y=934.8 (shared with the 134 CPT-1 ring).
Sheet prints 16 SF; wall-face ring gives 16.72 SF (17.4 SF without the block wrap, 16.1 SF without the door notch). Consistent.

### OFFICE 136 — CPT-1 — 130.12 SF (50.13 LF, 16 verts)
L-shaped: north part x 2349.1-2444.2 (storage's west wall face) from y=938.4 to 1000.1 (storage south wall's bottom face); south part x 2349.1-2554.8 from y=1000.1 to the south wall's inner face y=1174.8. Column block at the NW corner (2349.1-2363.5 x 938.4-950.2) wrapped. Doors: north door x 2380.3-2434.6 crossed at y=934.8; south door (to the EXIST FLOOR FINISH corridor) between jambs x 2372.4-2432.4 crossed at y=1180.3 (the drawn threshold line, mid of 1174.8/1185.6). Window in the south wall x 2458.8-2530.8 does not break the ring.
Unsure: the north door's east jamb — leaf sits at 2434.6-2437.2, frame line at 2440.3; I used 2434.6 (3'-0" opening, matching the other doors). Effect < 0.1 SF.

### PATIENT ROOM 137 — CPT-1 — 251.82 SF (80.26 LF, 16 verts)
Boundary: north y=704.9 (windows run past; a 5" recess in the wall face at 2542-2562 ignored); east x=2769.1 (west face of the partition against the thick existing wall 2775-2795); west x=2535.4 down to y=902.6, then wrapping the pilaster/column block (2535.4-2563.9 x 902.6-952.8) and continuing on x=2563.9 (east face of the storage/toilet wall) down to y=1002.2; then east along the toilet's north wall top face y=1002.2 to x=2689.9 (toilet east wall's outer face), south to the south wall face y=1177.0, east to 2769.1.
Doors: (a) corridor door in the east wall, opening y 1088.9-1157.8, crossed at x=2782.0 = mid of the composite wall 2769.1/2795.0; (b) 137A door in the toilet's east wall, opening y 1099.0-1159.0, crossed at x=2686.3 = mid of 2682.7/2689.9 — this is also the drawn threshold line the PT/CPT arrows meet at, so the tile/carpet split is exactly that segment, shared with the 137A ring.
Note: the thin lines inset ~1.3 ft from the walls with mitered corners are the wall-paint extent lines (P-1/P-2/P-3 leaders), not walls; ignored.

### TOILET 137A — PT-1/PT-2 — 60.90 SF (38.49 LF, 12 verts)
Boundary: west x=2563.9, south y=1177.0, east x=2682.7 with the door crossed at x=2686.3 (y 1099.0-1159.0), north y=1009.7 on the west part and y=1008.7 on the east part. The pen-2 wall stub between the shower area and the lavatory (x 2617.9-2625.4, from the north wall down to y=1065.4) is wrapped. Lav counter, toilet, grab bars and the hatched shelf strip (2624.4-2683.7 x 1008.7-1016.9, tile hatch drawn under it) are fixtures/casework — tile runs under them.
Unsure: whether the shelf strip is a wall-hung element or a low wall; the floor hatch continues under it and it is not a closed cell, so I treated it as floor (~1.5 SF either way).

## Totals (report.json)
CPT-1 677.09 SF (134: 278.43, 134A: 16.72, 136: 130.12, 137: 251.82); VCT-1 57.43 SF; PT-1/PT-2 60.90 SF.

## Tool calls
47 MCP tool calls: load_plan 1, set_scale 1, find_text 10, resolve_tag 5, get_sheet_vectors 1, view_sheet 12 (9 to read the plan, 3 overlay audits), propose_takeoff 1, measure_polygon 6, edit_shape 6 (labels only), export_takeoff 1, export_report 1, export_marked_pdf 1, list_shapes 1.
Plus 5 non-tool requests: initialize, tools/list, and 3 resource reads (wiki index, workflows, mcp).
