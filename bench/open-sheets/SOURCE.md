# Open sheets — real drawings for driving engine work

Two real, publishable plan sets for anyone building against One-Click, the hatch
classifier, the wall network, or the sheet graph. Both are attachments to U.S.
Department of Veterans Affairs construction solicitations posted publicly on
SAM.gov, the same source class as the bundled `demo/sample-finish-plan.pdf`.
Document metadata has been stripped; the drawings are otherwise as posted.

These are NOT part of the scored benchmark. `web/bench/corpus/` holds pinned
golden cases and the runner treats every JSON there as one; nothing here has a
golden. Use these to show what a change does on a drawing, in the PR body, with
captured output.

| File | Sheets | Source |
|---|---|---|
| `va-dublin-bldg9a-finish-plan-A601.pdf` | 1 — A-601 Finish Schedule / Floor Plan – Phase I – Finish Plan | VA solicitation 36C77626R0031, "Renovate Building 9A for EHRM Administration", project 557-21-703, Carl Vinson VA Medical Center, Dublin GA. SAM.gov notice `85e50629af6f4e62885e766bc9e6f009`, RFP Attachment 13 (Drawings Part 4), issued 6/14/2024. A/E of record: Spees Design Build, Seattle. |
| `va-roseburg-b1ac-dwing-replace-finishes.pdf` | 14 — A-00 cover, A-01a/b/c demo floor plans, A-02a/b/c RCP demo plans, A-03a/b/c floor plans, A-04a/b/c RCPs, A-05 details + finish schedule | VA solicitation 36C26024R0006, "Refresh Finishes Building 1AC D-Wing", project 653-24-103, VA Roseburg Health Care System, Roseburg OR. SAM.gov notice `c71cd5d50c0b488daf648b2f744a3d62`, Attachment 6 (Combined Drawings), dated 5/18/2022–6/2023. Drawn in-house by VA Office of Facilities (VISN 20). |

## What each one is good for

**Dublin A-601** — a Revit-exported finish plan at 1/8" = 1'-0" on a 42×30 sheet
(3024×2160 pt, so 9 pt per foot; at render scale 2 that is 18 image px per foot,
the same `ptPerFt` as the bundled sample). Two finish hatches sit side by side in
the corridors: **LVT-1** (a fleck/dot pattern) and **LVT-2** (diagonal lines), with
plain unhatched rooms on both sides, four tiled restrooms, a mechanical room, and
a room finish schedule keyed by room number. Text is real text: `read_sheet_text`
and `find_schedule` work on it. Questions it answers: does a hatch family stop a
flood, does the corridor come back as one room or a chain of hatch cells, does
LVT-1 / LVT-2 read as two families or one, and does the schedule join rooms to
finishes.

**Roseburg D-Wing** — a CAD-plotted set (PostScript → Distiller) where **every room
in scope is filled with hatch** and the out-of-scope rooms are labelled NO WORK.
Two different flooring hatches on the demo plans (A-01a/b/c), a third on the new
floor plans (A-03a/b/c), and **ceiling grids** on the RCP sheets (A-02, A-04) —
a repeated-line family that is a building element, not a finish. Sheets are NTS.
Every room prints its **net square footage** (e.g. D105 231.6 NSF, E124 corridor
1251.0 NSF), which is a printed answer key for any room finder: calibrate on one
room, measure the rest. Text on this set is drawn as outlines — `get_text` returns
nothing, so a sheet-text reader has to OCR or the room numbers have to come from
the operator. That is a real condition estimators hit, not a defect to fix here.

## Provenance and use

Both are public federal procurement records, posted for bidders without access
restriction (`accessLevel: public` on the SAM.gov attachment record). They are
redistributed here for engineering test purposes only. The A/E named on the
Dublin sheet retains whatever rights it holds in the drawing; nothing here is a
licence to build from these documents. If you are the rights holder and want a
sheet removed, open an issue.

Do not add client or private plansets to this folder. The bar for a new file is
the same as these two: a public government posting, cited by notice id.
