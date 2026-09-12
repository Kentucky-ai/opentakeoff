# Roseburg A-03a blind takeoff — run notes

## Scope, source and calibration

Read only TASK.md sections Deliverable, How an estimator traces a room, and Roseburg A-03a; the named plan through OpenTakeoff tools; and tool schemas/wiki resources. No other plan, schedule file, repository content, reference or prior takeoff was opened. Generated tool images were inspected. Reopened only this run's exported JSON through import_takeoff.

Sheet: va-roseburg-a03a.pdf, 6048 × 4320 image pixels (PDF points × 2). The rendered title block reads A-03a, 5/18/2023, NOT TO SCALE. Set upp exactly 0.015151515151515152 ft/image px as TASK.md directs (nominal 3-foot leaf / 198 pixels). Scale remains unconfirmed. Printed NSF values were read but were not used as area targets.

Finish tag is exactly VSF for all four shapes, using the TASK.md statement that A-05 assigns VSF. A-03a's general note refers to A-05, which is outside the permitted input; I did not independently inspect that schedule. No floor finish splits were shown within these four rooms. No waste or multiplier was added (0%, 1).

## Per-room boundaries, decisions and quantities

All coordinates below are full-sheet image pixels. Each room was inspected in a tight 2000-pixel render before committing and again with overlay:true afterward. Vectors supplied the wall/jamb coordinates. Door leaves and swing arcs were ignored. Windows were traversed on the room-side wall face without notches.

### D105B STORAGE — VSF — 39.83 SF

Traced west face x=2872.8, north face y=1850.76, east face x=3250.8, south face y=2314.32. Followed the northeast column/furring recess through (3183.24,1850.76), (3183.24,1913.76), (3250.8,1913.76), then the short wall to y=1927.32. This excludes the projecting enclosure rather than following the steel I-section itself.

Door jambs are y=1927.32 and 2116.32. Wall faces x=3250.8 / 3277.8 give threshold centerline x=3264.3. The ring follows both jamb returns to that centerline. The drawn opening is 189 pixels, despite the task's nominal 198-pixel calibration example; retained the required scale and traced the actual opening, without stretching it.

Pre-commit image: call-012-0.png. Inspected committed overlay: call-018-0.png. The chosen faces, column step and door notch align visually. No unresolved local boundary ambiguity.

### D105A OFFICE — VSF — 111.71 SF

Traced north y=1841.76 from x=3277.8 to 4126.08, east offset down to y=2118.6, across to x=4303.8, then down to y=2359.32. Followed the south room face and the west partition around the storage room. At the storage door, shared exactly the x=3264.3 threshold from y=1927.32 to 2116.32 with D105B.

South door jambs x=4092.36 / 4290.36; wall faces y=2359.32 / 2381.76 give threshold y=2370.54. Retained the small return from x=4303.8 to the right jamb. The glazed panel west of that door is non-passable and does not create another notch.

Pre-commit image: call-019-0.png. Inspected committed overlay: call-024-0.png. Wall steps, both door notches and the south face align visually. No unresolved local boundary ambiguity.

### D104 OFFICE — VSF — 87.23 SF

North face y=2379.6; east face x=3876.36; south room face y=2927.52. West face is x=3120.24 down to y=2591.04, steps right to x=3228.24, then continues south. Included the sink/counter footprint to the actual wall behind it; the dark counter-front line is not the room boundary. This follows the rule that finish continues beneath casework and fixtures.

South door jambs x=3664.8 / 3862.8; wall faces y=2927.52 / 2947.8 give threshold y=2937.66. Used that exact midpoint rather than the nearby glazed-panel line y=2937.6. South glazing stays on y=2927.52.

Pre-commit image: call-022-0.png. Inspected committed overlay: call-029-0.png. The sink recess, west step, faces and door notch align visually. The sink/counter versus wall reading was resolved by vectors and render; no unresolved local boundary ambiguity.

### D105 OFFICE — VSF — 90.63 SF (visible portion only)

West face x=3903.36; north face y=2381.76; south face y=2927.52. Traced three door notches: northwest door x=4092.36 to 4290.36 at y=2370.54, northeast door x=4344.36 to 4542.36 at y=2371.68 (midway between y=2361.6 and 2381.76), and south door x=4254.36 to 4452.36 at y=2937.66. The northwest threshold shares its edge exactly with D105A. Followed the intervening partition end between the two north doors. Glazing does not break the ring.

Uncertainty: the room continues into the drawing's right-hand cutoff, beside the notes panel. North and south wall vectors terminate at x=4615.32; the nearby vertical x=4615.44 line extends through the sheet border and is not evidence of an interior wall face. Closed this ring at x=4615.32, the visible drawing extent, without inventing the unseen room continuation. Therefore 90.63 SF is the visible portion, not a verified whole-room quantity. This is the material limitation of this takeoff. A VSF callout in both exports and the marked PDF records this qualification. The printed 231.6 NSF was not used to extrapolate missing geometry.

Pre-commit image: call-027-0.png. Inspected committed overlay: call-033-0.png. Visible wall faces and all three door notches align visually; the east closure is explicitly a drawing cutoff, not a verified wall.

## Checks and handoff

Four committed floor_area shapes, exact requested labels, one VSF condition. Tool total: 329.40 SF (36.60 SY), including D105's visible portion. Shared floor overlap reported as 0 SF. Four pending, zero accepted; no approval calls and no approval marks. Every shape has origin.actor=agent and reviewed=false. Four edit_shape calls attached the exact room labels; no geometry correction was needed after the overlays inspected above. No claim of alignment relies on the full-sheet locator image.

Exports: export_takeoff.json, report.json and marked.pdf. Marked PDF tool reported 2 pages, 1 marked sheet, 4 shapes, 1 annotation and 0 approvals. export_takeoff.json carries per-shape labels and SF. The report tool returned condition totals but empty by_label and shape_labels arrays; use the takeoff JSON and this table for room quantities.

Reopened this run's export with import_takeoff against the same loaded source: 0 unknown files, 4 total shapes, duplicates skipped, no new shapes. Final overview call-040-0.png was inspected after import. This was an idempotent import check, not a fresh-session reload.

## Tool-call count

33 OpenTakeoff tool calls:
- load_plan: 1
- set_scale: 1
- view_sheet: 11 (full-sheet locator, regional pre/post views, final overview)
- get_sheet_vectors: 5 (all regional; no pages dropped)
- propose_takeoff: 1
- measure_polygon: 4
- edit_shape: 4 (labels only)
- annotate: 1
- takeoff_summary: 1
- export_takeoff: 1
- export_report: 1
- export_marked_pdf: 1
- import_takeoff: 1

Also 3 tool-schema inventory requests and 4 wiki-resource reads, making 40 relay requests total. The first full inventory and initial raw vector display exceeded the output budget; targeted schema reads and filtered regional vector reads supplied the relevant complete evidence. Counts refer to OpenTakeoff relay activity; shell execution and image-display wrappers are not OpenTakeoff calls.
