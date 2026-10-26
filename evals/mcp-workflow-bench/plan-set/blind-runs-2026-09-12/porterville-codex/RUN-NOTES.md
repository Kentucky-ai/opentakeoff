# Porterville A1-101 — blind takeoff run

Six committed floor-area rings on `porterville-adu-a1-101.pdf`. All six remain pending in proposal `prop-e1318ad1-3651-46a3-9d38-6a4f51ff7301`; accepted = 0. No approvals were created. Scale is exactly `upp: 0.027777777777777776` (36 image pixels per foot), as required. Human scale confirmation remains false.

Source access was limited to the requested Deliverable, How an estimator traces a room, and Porterville A1-101 task sections; the named plan through OpenTakeoff; and runtime schemas/wiki resources. No other plan, repository material, prior takeoff, reference, or notes were consulted. Geometry comes from lower-left GROUND FLOOR PLAN 1/A1-101. The finish plan and same-sheet FINISH SCHEDULE were visually read. The loader's detected sheet number was X1; the visible title block says A1-101. The exact requested filename sheet key was used throughout.

## Quantities and boundaries

All coordinates below are full-sheet image pixels at PDF render scale 2.0. Areas are the values reported by the tools, with no waste and multiplier 1. Wall boundaries use the innermost finished face, including the thin finish outline outside the heavier framing stroke. Fixtures, appliances, cabinetry, door leaves, swings, shelving lines and windows do not reduce floor area.

| Exact room label | Exact finish tag | Tool SF | Chosen boundary and reason |
|---|---|---:|---|
| LIVING | LVP | 254.56 | One connected ring includes open KITCHEN, as explicitly required and confirmed by both schedule rows. West face x=884.88, north face y=1961.76, south face y=2644.56. Follows bath/pantry exterior-to-room faces and optional bedroom west face x=1356.24. Bath opening shares centerline x=1402.32, y=2088.96–2184.72; pantry opening shares x=1323.96, y=2212.56–2284.56; bedroom opening shares x=1363.32, y=2315.52–2411.52. Exterior entry runs along jambs x=1235.28 and 1343.04 to centerline y=2655.84, midpoint of wall faces 2644.56 and 2667.12. Windows are bridged at the interior face. |
| BATH | CT | 51.30 | North y=1961.76, west x=1409.52, east x=1711.44, south y=2196.48. Wraps around the visibly walled northeast enclosure: face x=1620 down to y=2017.2, then east to x=1711.44. Includes tub and vanity footprints per task. West door notch reaches x=1402.32 between jambs y=2088.96 and 2184.72. Southern edge shares the W/D mouth split. |
| PANTRY | LVP | 4.21 | Finished faces x=1331.04 and 1395.12, y=2210.64 and 2287.92. Includes the small jamb steps: north opening y=2212.56 and south opening y=2284.56, then the centerline x=1323.96 between wall faces 1316.88 and 1331.04. Swing and leaf ignored. LVP is the task's explicit carried assignment because there is no pantry schedule row. |
| W/D | LVP | 5.68 | Three finished faces x=1409.52, x=1495.68 and back y=2281.92, with a straight open-mouth split y=2196.48 matching the bath south wall face. Includes appliance footprint; no door notch was invented. LVP is explicitly carried by the task; no schedule row. |
| CL. | CPT | 12.81 | Finished faces x=1509.84 and 1711.44, north y=2210.64 and south y=2287.92. Clear opening lies between the inner frame edges x=1537.68 and 1681.44; ring extends to wall centerline y=2295, midpoint of faces 2287.92 and 2302.08. Shared edge matches bedroom exactly. Shelving line and door panels ignored. CPT is the schedule selection with bedroom provided. |
| OPT. BEDROOM | CPT | 91.43 | Optional wall treated as built, as required. Bedroom west finished face x=1370.4, east x=1711.44, north y=2302.08 and south y=2644.56. Door notch uses x=1363.32 between jambs y=2315.52 and 2411.52. Closet opening reaches y=2295 between x=1537.68 and 1681.44. CPT follows the schedule with bedroom provided. |

Finish totals: LVP 264.45 SF; CT 51.30 SF; CPT 104.24 SF. Grand total: **419.99 SF**. `takeoff_summary` reports shared_floor_sf = 0.

## Uncertainties and carried decisions

- **BATH / W/D mouth:** The geometry has an open U-shaped alcove, without a door or transverse wall. It does not provide a separate dimensioned transition line on the ground floor geometry. I carried a straight split at y=2196.48, aligned with the bath's south finished wall face and the right alcove return. BATH and W/D share precisely that edge. I did not use the open bath door leaf at y=2180.64–2184.72 or appliance front at y=2195.28 as a boundary. This interpretation is disclosed in the exported LVP annotation and here.
- **PANTRY / W/D finishes:** Neither has a schedule row. LVP was explicitly required by the public task, so both are carried LVP; no unsupported finish selection was substituted.
- **BATH enclosure vs fixture:** The northeast rectangular enclosure has actual wall thickness, unlike the tub/vanity. I excluded the enclosure by following its finished faces and retained the fixtures' floor footprints under task rules. High-zoom source and overlay confirm that distinction.
- **CL. door:** The public task calls it a bifold. The ground-floor symbol shows two overlapping rectangular panels and separate frame/jamb rectangles. Regardless of panel operation, I used the clear inner jamb edges and wall midpoint, ignoring panels. No geometry was taken from a door leaf, and the frame footprints were excluded.
- **Optional bedroom:** The wall is drawn pale because it is optional, but the task explicitly chooses it built. Both adjacent rings follow their respective finished faces; the centerline is used only within the doorway.
- **LIVING exterior entry:** I used the midpoint of the two drawn wall faces, y=2655.84, rather than the threshold line y=2663.04 or a dimension string. This applies the stated door rule.
- No other unresolved boundary or finish choice was identified. No ring is claimed to follow a finished face based solely on a full-sheet render.

## Visual checks and revisions

Read nine tight-region vector responses, including detailed pantry jamb linework and the pale optional wall. Every response's pagination ledger had dropped=0. Small-region source renders were viewed before each commit. Every committed ring was then viewed with overlay=true at px=2000.

Viewed source/overlay evidence (paths relative to run root):

| Room | Source renders viewed | Committed overlay renders viewed |
|---|---|---|
| LIVING | call-010-0.png, call-039-0.png, call-041-0.png, call-042-0.png | call-048-0.png, call-049-0.png, call-059-0.png |
| BATH | call-010-0.png, call-016-0.png | call-025-0.png, call-059-0.png |
| PANTRY | call-010-0.png, call-026-0.png | call-031-0.png, call-048-0.png, call-059-0.png |
| W/D | call-016-0.png, call-026-0.png | call-034-0.png, call-059-0.png |
| CL. | call-016-0.png, call-027-0.png | call-037-0.png |
| OPT. BEDROOM | call-010-0.png, call-038-0.png | call-044-0.png, call-049-0.png, call-059-0.png |

Finish schedule was viewed in call-011-0.png and finish plan in call-012-0.png. Each ring received one edit_shape call to attach the exact room label. The inspected overlays did not reveal a geometric miss requiring replacement vertices, so there were no geometry revisions. The annotation-only view call-054-0.png returned a blank crop: view_sheet did not show the annotation. Its presence is verified in export_takeoff/export_report and export_marked_pdf reported annotations_drawn=1; I do not claim a visual check of that annotation's exported typography.

## Export and handoff checks

- `out/export_takeoff.json`: editable takeoff_canvas.v1; all six exact labels and finish tags present; each origin.reviewed=false; correct scale and source sheet.
- `out/report.json`: tool-generated report.v1; condition totals match takeoff_summary. The tool returned empty shape_labels/by_label arrays despite labels existing on all six exported shapes; per-room quantities are therefore recorded above and in export_takeoff.json.
- `out/marked.pdf`: tool reported two pages, one marked source sheet, six shapes, one annotation and zero approvals. The PDF was generated through export_marked_pdf; source geometry was visually checked via the listed overlays. No separate PDF-render inspection was performed.
- Re-imported the exported JSON into the same loaded source session. Import succeeded, unknown_files=[], shapes_total=6, and duplicate IDs were skipped. This was an idempotent re-import check, not a clean-session reconstruction. Subsequent tight overlay was viewed and takeoff_summary remained 419.99 SF, shared_floor_sf=0, pending=6, accepted=0.

## Tool-call count

**51 OpenTakeoff tool calls** via `node request.mjs call`:

| Tool | Calls |
|---|---:|
| load_plan | 1 |
| set_scale | 1 |
| get_sheet_vectors | 9 |
| view_sheet | 20 |
| propose_takeoff | 1 |
| measure_polygon | 6 |
| edit_shape | 6 |
| annotate | 1 |
| takeoff_summary | 2 |
| export_takeoff | 1 |
| export_report | 1 |
| export_marked_pdf | 1 |
| import_takeoff | 1 |

There were also four wiki resource reads and five schema/tool-list queries: **60 total relay requests**. Counts exclude shell orchestration, local viewing of returned PNGs, reading the allowed task sections, and writing this notes file. No approval tool was called.
