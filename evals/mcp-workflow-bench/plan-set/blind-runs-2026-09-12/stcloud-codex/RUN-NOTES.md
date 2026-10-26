# St. Cloud AF101 run notes

## Scope, scale and status

Read only the permitted TASK.md sections, OpenTakeoff schemas/wiki resources, and the supplied PDF through OpenTakeoff. No other project, reference, prior takeoff or repository files were consulted. Source: sample-finish-plan.pdf, AF101 page 1; finish schedule AF600 page 2.

Scale set exactly as instructed: upp = 0.05555555555555555 feet/image pixel, or 18 image pixels/foot. All coordinates below are full-sheet image pixels (6048 × 4320), origin top left. Scale remains unconfirmed by a human.

Six floor-area rings committed with measure_polygon in one proposal. Exact requested room labels attached with edit_shape. All six remain reviewed:false; proposal pending = 6, accepted = 0; no approvals created. No waste or multiplier added.

## Room results and boundary decisions

| Exact room label | Exact finish tag | Tool-reported SF | Boundary chosen and reason |
|---|---|---:|---|
| CONFERENCE/BREAK ROOM 134 | CPT-1 | 278.43 | Interior wall faces, north windows bridged on the interior face, west doorway and both south doorways notched to wall centerlines. South-west finish edge is the drawn transition at y=933.84, x=2135.76–2341.68, shared exactly with VCT. |
| CONFERENCE/BREAK ROOM 134 | VCT-1 | 57.41 | Same transition edge; flooring extends beneath the sink casework to the south wall at y=1034.88. Ring follows the room-facing sides of the heavy L-shaped furred enclosure at the south-east end: y=990.24 and x=2292.72. |
| STORAGE 134A | CPT-1 | 16.21 | Interior faces x=2451.36 and x=2554.8, south y=992.88, north-east chase step through (2526,958.32). North doorway shares y=934.8 with Room 134. |
| OFFICE 136 | CPT-1 | 128.27 | Interior faces, north-west column return, and both sides and end of the projecting storage partition. South wall projection traced at y=1171.2 between x=2458.8 and 2530.8. North doorway shares y=934.8 with Room 134; south doorway threshold is y=1180.2. |
| PATIENT ROOM 137 | CPT-1 | 252.07 | Interior faces, north and east shallow projections, west chase step, and outside faces of the toilet enclosure. North window does not interrupt the face. Corridor doorway threshold is x=2785.2; toilet doorway shares x=2686.32 with 137A. |
| TOILET 137A | PT-1/PT-2 | 58.19 | Interior wall faces including shower partition and the deeper north face behind the sink. Includes shower floor and flooring beneath plumbing/vanity; excludes the wall partition and enclosed slot behind it. Doorway shares x=2686.32, y=1102.08–1156.08, with Room 137. |

Totals reported by OpenTakeoff: CPT-1 = 674.98 SF; VCT-1 = 57.41 SF; PT-1/PT-2 = 58.19 SF; total = 790.58 SF. shared_floor_sf = 0. Individual rounded room figures sum to 790.58 SF.

## Uncertainties and readings carried

- Room 134 west doorway: adjacent wall faces/jambs have asymmetric offsets. Carried a continuous threshold at x=2123.04, the midpoint of representative faces x=2110.32 and 2135.76. The upper neighboring face is x=2114.64 and the room face there is x=2136. This threshold placement is an explicit interpretation, not an assertion that the staggered faces establish a unique centerline. Used clear opening limits y=847.68 and 919.68 and followed the jamb returns.
- Room 134 north linework contains nearly coincident strokes at y=704.64 and 704.88. Carried the innermost continuous plotted face at y=704.88 across the windows.
- Room 134 VCT: hatch continues inside the small south-east enclosure. Its heavy double wall lines fully separate that pocket from the room; carried the room-facing L-shaped boundary and excluded the enclosed pocket, rather than treating hatch alone as accessible room floor. The thin sink/counter outline is casework and was not deducted.
- Storage 134A: the printed 16 SF is a rounded cross-check. Kept the vector-traced 16.21 SF including half of the doorway; did not resize the ring to force 16.00 SF. No additional unresolved boundary interpretation.
- Office 136: treated the rectangular south-wall thickening as a projecting wall face because it interrupts both wall faces in the linework. Followed its north face rather than running through it. The north hanging partition is wall, not the nearby door leaf; traced around its end at y=1040.64.
- Patient Room 137: several grey structural faces and thin paint leaders appear beside the interior wall lines. Carried the innermost finished faces and small drawn bumps. The corridor swing and revision cloud were ignored as boundaries. No additional unresolved opening interpretation after the tight jamb inspection.
- Toilet 137A: distinguished the heavy shower/vanity partition and north wall recess from fixtures and tile hatch. Included the shower floor and floor beneath the sink/toilet. The narrow hatched slot enclosed by the north partition was treated as outside the room floor boundary. PT-1/PT-2 is retained as the single combined finish tag required by the task and the typical patient-toilet schedule; no invented subdivision between tile colors.

## Schedule evidence

AF600 room schedule row 134 at y=724.1 specifies CPT-1/VCT-1 and refers to the finish plan. Row 136 at y=986.2 specifies CPT-1. Row 134A at y=1274.4 specifies CPT-1. Typical PATIENT ROOMS row y=1591.7 specifies CPT-1; PATIENT TOILET ROOMS row y=1565.5 specifies PT-1/PT-2. These were read from positioned schedule text, with plan tags as cross-checks.

## Visual checks and exports

Every ring was inspected on a small-region, 2000-pixel render before commitment and on a zoomed overlay afterward. Wall-face claims above refer to those inspected overlays, with the west doorway qualification retained. Reviewed overlay images in the run directory:

- Room 134 CPT: call-027-0.png.
- Room 134 VCT: call-030-0.png.
- Storage 134A: call-035-0.png.
- Office 136: call-040-0.png.
- Patient Room 137: call-046-0.png, plus tight corridor doorway call-051-0.png.
- Toilet 137A: call-050-0.png.

No additional geometric miss was observed in those overlays, so the six edit_shape calls attached labels only; no geometry corrections were made.

Exports: export_takeoff.json, report.json, marked.pdf. Marked PDF tool reported 2 pages, 1 marked sheet, 6 shapes and 0 approvals. Exported JSON contains all six exact labels and reviewed:false origins. The report tool returned aggregate finish quantities but empty by_label/shape_labels arrays; use the takeoff JSON and this table for the room breakdown. No manual alteration of tool exports.

Re-imported the exported JSON against the loaded source: duplicate IDs skipped, 0 new shapes, 3 conditions merged, 6 total shapes and no unknown files. This was an idempotent re-import check, not a fresh-session reload. The subsequent summary retained the same totals and all 6 pending shapes.

## Tool-call count

49 OpenTakeoff tool invocations, plus 7 schema/wiki requests = 56 relay requests initiated during this run. Counts are from the commands issued, not the image filename sequence. Shell transport calls and local viewing of returned PNGs are excluded.

| Tool | Calls |
|---|---:|
| load_plan | 1 |
| set_scale | 1 |
| read_sheet_text | 3 |
| get_sheet_vectors | 10 |
| view_sheet | 15 |
| propose_takeoff | 1 |
| measure_polygon | 6 |
| edit_shape | 6 |
| takeoff_summary | 2 |
| export_takeoff | 1 |
| export_report | 1 |
| export_marked_pdf | 1 |
| import_takeoff | 1 |
| tools schema requests | 3 |
| wiki resource requests | 4 |
