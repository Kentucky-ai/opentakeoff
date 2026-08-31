# OpenTakeoff on AEC-Geometric-Bench

[Kamai](https://kamai.io) published
[AEC-Geometric-Bench](https://github.com/KamaiEnterprises/aec-geometric-bench) on
2026-08-31: 312 construction sheets scored on object detection (doors, windows,
sanitary and kitchen fixtures) and wall/area segmentation, with 15 sheets
released in full — source PDFs, human ground truth, and the exact scorer that
produced the paper's numbers. That release is the part worth copying: anyone
can clone it and check any claim below. We think publishing open benchmarks
like this should be standard practice for anyone selling takeoff software.

This directory holds OpenTakeoff's runs against the released 15 sheets. Nothing
from the benchmark is vendored here — their data (CC BY-NC 4.0) and scorer
(Apache-2.0) stay in their repo, which you clone alongside.

## The question this run asks

The paper scores five frontier vision-language models at object F1 0.015–0.062
and area-instance F1 0.078–0.227, against 0.930 / 0.924 for Kamai's production
pipeline. The model arms received a 2000px raster and answered in one shot; the
pipeline reads the PDF's vector layer — a difference the paper's own
limitations section is upfront about. The natural follow-up: what does the same
model family score when it drives real takeoff tooling over that same vector
layer? OpenTakeoff is that harness — `read_sheet_text` for room labels,
`one_click` sealed floods for room boundaries, `symbol_sweep` for repeated
symbols — so we ran it.

## First result — sheet_02, areas, first pass

Claude driving OpenTakeoff's MCP tools: read the room labels off the text
layer, click one seed per space, let the flood engine trace the vector
boundaries. No audit loop, no cleanup.

| Arm | Area instance F1 | Area pixel F1 |
|---|---|---|
| Paper's model arms, screenshot only (corpus range) | 0.078–0.227 | 0.61–0.80 |
| Claude + OpenTakeoff, first pass | **0.667** | **0.887** |
| Kamai's pipeline (their published score, this sheet) | 0.83 | 0.99 |

The misses were mechanical, not conceptual: dashed closet shelving stopping a
flood, bathroom fixture curves poisoning one trace, a few unseeded hall
spaces. The read: most of the gap between the paper's model scores and its
pipeline score follows the tooling, not the model.

Scored with **their scorer, unmodified**. Before running anything of ours we
verified the scorer reproduces the paper's published Table 3 exactly from the
example predictions shipped in their repo.

## Reproduce it

From this directory, with their repo cloned anywhere (`$BENCH` below):

```sh
git clone https://github.com/KamaiEnterprises/aec-geometric-bench "$BENCH"
python3 -m venv .venv && .venv/bin/pip install numpy pillow shapely
# their scorer, their ground truth, our predictions:
.venv/bin/python "$BENCH"/scoring/score.py --gt "$BENCH"/dataset \
    --pred predictions/claude-ot-harness --name claude-ot-harness
# or one sheet with per-task detail:
.venv/bin/python score_one.py predictions/claude-ot-harness/sheet_02.json \
    --gt "$BENCH"/dataset
```

`predictions/` holds one JSON per worked sheet in the benchmark's own format.
`convert_frame.py` documents the only glue involved: OpenTakeoff tools speak
image px at render scale 2.0 (PDF pt × 2); the benchmark frame is the
`width`/`height` in their `manifest.json` (PDF pt × 2.7778 on all 15 sheets),
so predictions convert by a single per-sheet factor.

## Protocol for the remaining sheets

sheet_02 above was the pipe-validation run: after freezing predictions we
diffed against ground truth to find the failure modes, so treat its number as
a lower bound with known causes, not a campaign result. The remaining sheets
run blind — the agent sees only what the harness shows (renders, overlays,
withheld lists), predictions freeze before scoring, and per-sheet wall-clock
and tool-call counts get logged alongside the F1s. Runs land here as they
finish.

The finish line: area-instance F1 ≥ 0.85 across all 15 released sheets with
the audit loop, and an honest per-sheet cost figure next to it.
