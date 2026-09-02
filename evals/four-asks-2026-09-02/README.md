# Four asks, two public VA sheets, one scripted MCP session each

An estimator's post this week (2026-09-02) laid out a four-ask script for an
MCP-connected takeoff tool: count typed rooms on a page, set the scale, build a
tile assembly, then go at a civil sheet. This directory is that script run
against **OpenTakeoff's published MCP server** — `opentakeoff-mcp@0.9.68` from
npm, launched over stdio exactly as an MCP client launches it, driven by a JSON
step list, no app UI, no human edits mid-run — on two publicly posted VA plan
sheets. Every number below comes from a log in `runs/`, every shape is burned
into a marked set in `out/`, and both sheets are in `sheets/` so anyone can
re-run it.

The asks, as posted, and where each landed:

| # | Ask | Sheet | Result |
|---|---|---|---|
| 1 | "Count the kings, queens and suites on this page" | A-601 (restrooms / mechanical / IV testing stand in for the room types) | 4 / 2 / 2, matches the hand count; one schedule row with no plan label and one unlabeled room flagged for a human |
| 2 | "Scale every point I dropped" | both | C-300: drawn scale detected and adopted. A-601: not detected, set from the title block |
| 3 | "Build me a tile assembly with labor, material and equipment" | A-601 restrooms | Floor SF, base LF, wainscot LF and a supporting-materials buy list, waste applied. No labor, equipment, cost or production: OpenTakeoff carries no pricing by design, the report JSON is the handoff |
| 4 | Civil sheet: count hydrants, panels, valves; linear "not yet" | C-300 | 1 hydrant, 5 valve glyphs (4 called out), 9 manholes (1 new), 2 cleanouts, 1 catch basin; **linear works**: 400.00 LF against a printed 400', 98.26 LF against a printed 100' |

## What was run

```sh
cd evals/four-asks-2026-09-02
npm install            # pins opentakeoff-mcp 0.9.68 (package.json)
node runs/drive.mjs runs/a601.json out/    # 32 steps, ~6 s of tool time
node runs/drive.mjs runs/c300.json out/    # 18 steps, ~8 s of tool time
```

`runs/drive.mjs` opens one stdio session, sends `initialize`, then each step as a
`tools/call`, printing the structured reply and its wall-clock milliseconds.
`runs/a601.log` and `runs/c300.log` are the logs of the runs the numbers below
are read from. The earlier passes that missed are kept too (`*-pass1.log`,
`*-pass2.log`), because the misses are the point of publishing.

Passes to reach the final scripts: three on A-601, two on C-300. Wall-clock for
the whole exercise including reading every render: about ninety minutes. Tool
time inside the final sessions: under fifteen seconds combined.

## Ask 1: count rooms by type (A-601)

The sheet is a finish plan with a room finish schedule on the same page. The
posted ask was king / queen / suite on a hotel plan; no publishable hotel plan
was at hand, so the typed rooms here are RESTROOM, MECHANICAL and IV TESTING.
Same capability: read the labels, count by type, say what is unlabeled.

| Room type | On the plan (hand count) | `find_text` hits | Read |
|---|---|---|---|
| RESTROOM | 4 (110, 111, 112, 113) | 8 | 4 plan labels + 4 schedule rows. The schedule rows are the cross-check for free |
| MECHANICAL | 2 (101, 109) | 4 | 2 plan + 2 schedule |
| IV TESTING | 2 (103, 106) | 4 (TESTING) | 2 plan + 2 schedule; the bare `IV` query also substring-matched the title block |

Flagged for a human, the way the post described:

- Schedule row **103A STG** has no label anywhere on the plan.
- One room between 103 and 102 carries no label at all; `one_click` at its
  center measures **83.76 SF** (`runs/a601.log`, step "unlabeled room"). It is
  probably 103A. The tool does not say so; the estimator does.

What did not work, as shipped:

- **`detect_rooms`** (the batch verb) returned 43 "rooms". Every room-number box
  on the plan is a closed rectangle, the seed lands inside it, and the flood
  returns a **12 SF room at confidence 1.0** for 108, 104, 109, 114, 106, 103,
  100, 107, 111, 112, 113, 115. The grid bubbles along the top flood too. On this
  sheet the batch verb is not usable without a per-seed nudge; the per-room
  `one_click` beside the label is what the run uses.
- **`find_schedule`** found the PHASE I ROOM FINISH SCHEDULE by title but read
  **2 of its 21 rows**, so `resolve_tag 110` came back *unresolved* ("no
  schedule row") for a room that has one. The schedule-driven commit path
  (`detect_rooms assign_from_schedule`) was therefore off the table; finish tags
  in this run are stated by the operator from the schedule as printed.

## Ask 2: scale

- **C-300**: `load_plan` reported `detected_scale: 1" = 20'`; `set_scale
  use_detected` adopted it (`upp` 0.1389 ft/px). Confirmed by the printed 400'
  sewer run measuring 400.00 LF.
- **A-601**: no detected scale, although `1/8" = 1'-0"` sits in the text layer
  under the view title. Set with `set_scale label`. The sheet is 42×30 at 1/8",
  so 18 image px per foot, which the `view_sheet grid:"auto"` render confirms
  against the restroom walls.
- The posted "five by five" is a count-marker display size in the other tool.
  OpenTakeoff has no marker-size knob; count markers draw at a fixed size in the
  marked set. Not a quantity, not scored.

## Ask 3: tile assembly (A-601 restrooms 110–113)

Schedule as printed: floor CFT-1 (ceramic floor tile), base CTB-1 4", wainscot
CWT-1 to 4'-0".

| Room | Floor SF | How |
|---|---|---|
| 110 | 69.95 | `one_click` above the name, first try |
| 111 | 77.22 | `one_click`, first try |
| 112 | **76.90** | third pass: `measure_polygon` on the wall faces read from `sheet_context`. Two `one_click` seeds returned 16.25 SF and 36.04 SF, each self-flagged (`min-passage-rule 67.9% / 39.9% removed`) — the label box, the sink and the toilet fragment the flood |
| 113 | 102.71 | second pass: the first seed landed in the door swing and returned 10.55 SF at confidence 0.79 (`curve-bounded 42%`) |

Totals from `takeoff_summary` (`runs/a601.log`):

| Condition | Quantity | Note |
|---|---|---|
| CFT-1 floor | 326.78 SF gross, **352.92 SF net at 8% waste** (39.21 SY) | `edit_condition waste_pct 8` |
| CTB-1 base | **170.97 LF** | `derive_base`: perimeter − one 3 ft door per room, stated per shape and recorded on origin |
| CWT-1 wainscot | 170.97 LF run; **683.9 SF** at 4'-0" | `height_ft 4` was set on the condition but the derived run reports LF only; the SF is LF × 4 by hand |

Supporting materials (`edit_materials`, coverage rates are round placeholders,
not any product's data sheet): thinset **5 bags** at 80 SF/bag, grout **3
bags** at 120 SF/bag, crack-isolation membrane **4 rolls** at 100 SF/roll —
computed by `export_report` from the gross floor SF and rounded up
(`out/a601-report.json`).

Labor, equipment, cost, production: **not produced.** OpenTakeoff has no rate
tables and does not guess. The report document is the pricing handoff; the
marked set (`out/a601-marked-set.pdf`) is the review document.

Audit: `out/a601-restrooms-overlay.png` is the committed rings over the plan;
`out/a601-pass1-restrooms-overlay.png` is the first pass with the two misses
visible, kept on purpose.

## Ask 4: civil (C-300 site utility plan)

| Item | Verb | Found | Hand count | Read |
|---|---|---|---|---|
| Fire hydrant assembly | `symbol_sweep` on the hydrant glyph, `variant_guard` | **1** (seed, 0 others; 75,620 placements scored, complete) | 1 | exact |
| Valves | `symbol_sweep` on one bowtie glyph | **5** (4 + seed) | 4 named by callouts (2" gas, 2" water, 6" fire water, 6" tapping-sleeve valve & box) | the fifth is a bowtie on the gas service above the tee with no callout; the reply named it as tag-disagreeing. A human's call |
| Sewer manholes | `symbol_sweep` on the hatched-circle glyph | **9** (8 + seed) | 1 new (the S.S. M.H. by E. Stoner Ave) + 8 existing along the existing lines, 9 glyphs on the sheet | geometry exact; new vs. existing is the estimator's read |
| Sewer cleanouts | `symbol_sweep` on the 8-px CO glyph | pass 1: **105** (104 false placements: tree canopies, text, line ticks). pass 2 with `variant_guard`, orientation pinned, `tolerance_px 1`: **2** (1 + seed), 43 near-misses withheld with coordinates and reasons, `complete: true` | 2 new | exact on the second pass |
| Catch basin | `symbol_sweep`, `variant_guard` | **1** | 1 | exact |
| `count_marks` | schedule-driven census | refused: "No mark-shaped schedule row keys in the set" | — | correct refusal, no schedule on a civil sheet |
| 8" sewer line | `measure_line` MH to MH | **400.00 LF** | printed 400' | 0.0% |
| 6" sewer service | `measure_line`, 3 points cleanout → cleanout → MH | **98.26 LF** | printed 100' | −1.7% |

The posted script stopped at "can't do linear yet" on civil. Here the linear
work is the most exact thing on the sheet, because the sheet prints the answer.

`out/c300-full-overlay.png` shows every committed marker on the sheet;
`out/c300-pass1-north-overlay.png` shows what the first cleanout sweep did to
the tree canopies. `out/c300-marked-set.pdf` is the deliverable.

## Open, with a number that has to move

1. **Room-number boxes flood as rooms.** `detect_rooms` on A-601 returns twelve
   12 SF "rooms" at confidence 1.0. Finish line: the same call returns the 17
   labeled rooms with the label boxes withheld as bubbles and zero boxes
   committed.
2. **Schedule reader: 2 of 21 rows** on a Revit-exported room finish schedule.
   Finish line: 21/21, and `resolve_tag 110` answers CFT-1 / CTB-1 / CWT-1 with
   bboxes.
3. **Scale note under the view title is not detected** on A-601. Finish line:
   `set_scale use_detected` adopts `1/8" = 1'-0"` on this sheet.
4. **Fixture-dense rooms fragment the flood.** Restroom 112 took three attempts
   and a polygon. Finish line: one click inside 112 returns 76.9 ± 3 SF.
5. **An 8-px seed commits 104 false placements** when `commit: true` is passed
   without `variant_guard`. Finish line: the sweep refuses to commit, or demands
   the guard, when the seed's segment count is below a floor and matches exceed
   ten times the labeled family.
6. **`height_ft` on a derived run reports no wall SF.** Finish line: CWT-1 shows
   683.9 SF in `takeoff_summary`, not 170.97 LF alone.

Not open, a boundary: cost, labor and production rates. They live in the
estimator's pricing system; `export_report` is written to feed it.
