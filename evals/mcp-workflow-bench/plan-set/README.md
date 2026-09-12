# Estimator-trace plan set

A small set of public real floor plans with **proposed** reference rings for one task:
trace each listed room's floor the way a flooring estimator does. It exists so that an
agent's drawing accuracy can be measured room by room, boundary by boundary, on the
same task and the same sheets, and so that a failure can be pointed at rather than
described.

| Plan | Typology | What it exercises | Reference |
|---|---|---|---|
| `stcloud/` | VA healthcare finish plan (bundled sample, page 1) | double-line walls, dense tile hatch, a two-finish room, patient room with two doors, a 16 SF closet the sheet prints | [`stcloud/reference.json`](stcloud/reference.json) |
| `roseburg/` | VA clinic office floor plan (extracted sheet A-03a) | thin double-line walls, outlined text (no text layer), every room prints its net SF, NTS sheet with derived scale | [`roseburg/reference.json`](roseburg/reference.json) |
| `porterville/` | City public-domain ADU plan (extracted sheet A1-101) | residential open plan, closets with narrow doors, an optional bedroom wall, a finish plan beside the floor plan | [`porterville/reference.json`](porterville/reference.json) |
| `../reference.json` | synthetic four-room control | the existing analytic conformance fixture; unchanged | — |

Provenance for every sheet is in [`SOURCE.md`](SOURCE.md). The task text an evaluated
agent receives is [`TASK.md`](TASK.md); open estimator questions and the option
carried for each are in [`QUESTIONS.md`](QUESTIONS.md); the review state of each
reference is in [`REVIEW.md`](REVIEW.md); hashes of the frozen inputs are in
[`FREEZE.json`](FREEZE.json).

## Revision

The references are at **v2** (2026-09-12): blind agent runs exposed defects in v1, which were
corrected from the linework; see [`BLIND-RUNS-2026-09-12.md`](BLIND-RUNS-2026-09-12.md).
v1 is kept beside each as `reference-v1.json`.

## What the references are, and are not

- Each ring was prepared from the PDF **vector linework** with an independent PDF
  library, not with OpenTakeoff's detector: every vertex cites the source line
  segments it sits on, and the SF is recomputed outside the product.
- The rings follow the estimator conventions in `TASK.md`: interior wall face, door
  jambs notched to the wall centerline, windows ignored, casework and hatch never a
  boundary, one ring per room and floor finish.
- They were prepared by an agent. They are a **proposed** reference until a human has
  inspected the overlays in each folder and said so in `REVIEW.md`. Nothing here is an
  independently reviewed ground truth yet.
- The scripted known-answer runs in CI feed these rings through `measure_polygon` and
  check that the product carries them (IoU 1, boundary 0 px, reported SF within
  0.75 % of the analytic SF). That proves tool and workflow conformance. It proves
  nothing about whether any agent can draw the rings from the sheet; that is the next
  increment, and its runs are scored with the same `score.mjs`.

## Scoring profile

`reference.json` carries `"profile": "estimator-trace"`, which `score.mjs` handles as:
match candidate `floor_area` shapes by **label and finish** (finish read from the
condition the shape references), require the sheet id the server reports for the
referenced page, allow **concave** reference rings, and apply the same gates as the
synthetic fixture: reported SF within `area_percent`, polygon IoU at least
`overlap_iou`, maximum vertex-to-opposite-edge distance at most `boundary_max_px`
(2.5 px; at 18 px/ft that is under 2 in, so a skipped jamb notch fails), geometry and
reported SF within 0.01 % of each other or within the server's 0.01 SF rounding quantum
(a 4 SF closet cannot meet 0.01 % after rounding), no holes, valid rings. Missing rooms, extra
shapes, wrong finishes and duplicate labels fail. The reference profile is exact-key:
a room traced with the wrong finish is a miss plus an extra, not a partial credit.

## Run

Known-answer run (tool conformance) for one plan, from the repository root with a
built server (`npm run build --prefix mcp`):

```sh
node evals/mcp-workflow-bench/run.mjs --reference evals/mcp-workflow-bench/plan-set/stcloud/reference.json --out /tmp/plan-set-stcloud-UNIQUE
```

Score any exported takeoff JSON against a plan's reference:

```sh
node evals/mcp-workflow-bench/score.mjs path/to/export_takeoff.json --reference evals/mcp-workflow-bench/plan-set/stcloud/reference.json
```

Evaluating an agent: give it `TASK.md` and the sheet, nothing from this folder; freeze
and hash its export before any feedback; score with the command above; keep the first
pass even if a corrected pass follows, and label a corrected pass as assisted.
