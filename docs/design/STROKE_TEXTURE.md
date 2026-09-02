# Stroke texture and open tag frames

Two additions to the soft-ink plane that One-Click floods against, both measured on a Revit-exported finish plan (`bench/open-sheets/va-dublin-bldg9a-finish-plan-A601.pdf`, 1/8" = 1'-0", on the `agents` branch) and both regression-checked on the bundled VA plan through the same ink path the app uses.

## The failure

Every walled room on the Dublin sheet closed from one click. The corridor, CR11-10, came out as one- to two-square-foot rectangles. The corridor floor is Revit's stock LVT stipple: thousands of straight single-segment strokes one to eight inches long at every angle. Measured over the corridor (1,261 strokes, 286 SF): median 0.27 ft, p90 0.64 ft, 61% longer than `MIN_THICK_FT`. The fleck classifier caps figures at that thickness, so most of the field stayed hard, and the flood filled the cell between strokes.

Softening the field exposed a second fence. Revit draws a finish tag as four separate open strokes, not one closed path, so the closed-figure tag-box rule never saw the "LVT-1" frame. At 1/8" that frame is about 5 × 3 ft of plan, past the 6 SF cap as well. It left a 3-mask-pixel slit against each wall of the 3.4 ft corridor, under the minimum passage, and cut the corridor at the label.

## Stroke texture — `classifyStrokeTextureSegs`

What separates a stipple from real short linework is not size but two population facts, read on the same 2 ft grid the fleck classifier uses (cell plus its eight neighbours, 36 SF):

| | stipple cells | plain room cells | dense axis-aligned fields |
| --- | ---: | ---: | ---: |
| eligible strokes per 3×3 cells | 53–121 | ≤ 3 | 97–294 |
| fraction off both drawing axes (> 5°) | 0.73–0.83 | 0 | 0–0.25 |

The axis-aligned fields are wall poché printed as hairline arrays, ceiling grids and tile coursing on the two sheets, plus the densest cell of a stipple-free finish plan. Both facts must hold: density alone would soften poché, spread alone a lone fixture.

Eligible stroke: open subpath, at most two chords, no curve chord, not clip or fill ink, bounding-box extent from `MIN_THICK_FT` up to `STROKE_TEX_MAX_FT` (1 ft). A cell whose neighbourhood holds at least `STROKE_TEX_FIELD_MIN` (40) eligible strokes with at least `STROKE_TEX_OFFAXIS_MIN` (0.5) of them off-axis softens every eligible stroke in it.

It is unioned into the same soft plane as every other classifier, never subtracted. The escalation ladder still verifies by boundedness, so a misjudged field leaks or balloons and the strict result stands.

## Open tag frames — `classifyTagBoxSegs`, second pass

The closed-figure rule is unchanged, byte for byte. A second pass reads the frames Revit draws as strokes:

1. Text items on one baseline merge into a line (`TAGBOX_LINE_TOL`, `TAGBOX_LINE_GAP`, in text heights).
2. The line padded by its own height is the halo (`TAGBOX_HALO`). Sizes are text-relative, so the rule holds at any plan scale; a label is sized on paper, not on the floor.
3. Candidate sides are open, straight, axis-aligned strokes lying entirely inside the halo, at least `TAGBOX_SIDE_MIN_FRAC` (0.6) of the text extent they parallel.
4. A frame is two parallel sides bracketing the text, overlapping along their length by `TAGBOX_PAIR_OVERLAP` (0.8). Only paired sides soften.

A wall runs feet past any halo and never qualifies. A lone stroke under a label has no partner. An oblique leader is not axis-aligned. The first draft of this pass softened any axis-aligned stroke in the halo; it touched 2,026 strokes on the bundled VA plan and moved one bench probe off its golden. The paired rule touches 61 and moves none.

## What it never changes

Stored data, exports and the strict pass are untouched. Sheets with no scale, no subpaths or no text get exactly the prior mask. The bundled bench (`npm run bench`) passes no ink context, so its goldens cannot move; the ink-path regression in the verification doc is the check that matters.

## Numbers

Dublin, headless through the app's mask and flood path:

| seed | before | after |
| --- | ---: | ---: |
| corridor CR11-10, two seeds 45 ft apart | 1 SF and 2 SF cells | 420 SF, one polygon, identical from both seeds |
| alcove corridor (LVT-1) | 1 SF | 205 SF |
| IV Support 104 | 1,266 SF | 1,266 SF |
| IV Testing 106 | 1,224 SF | 1,224 SF |
| Staff Break 107 | 179 SF | 180 SF (its tag frame is no longer a hole) |

Bundled VA plan, nine bench probes through the ink path: eight unchanged; the elevator moved from 143.5 to 142.7 SF against a golden of 142.6. The stroke-texture classifier adds zero soft strokes on that sheet; its stipple is already fleck-sized.
