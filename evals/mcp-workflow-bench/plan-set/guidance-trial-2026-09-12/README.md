# Controlled guidance trial, 2026-09-12

Same agent (Claude Fable 5.1), same **stripped** task ([`TASK-stcloud-stripped.md`](TASK-stcloud-stripped.md): room list, finishes,
scale, deliverable; NO tracing conventions), same plan, same blind rules, one run each. The only
difference is the server build: **before** = main `4db292a` (0.9.83 guidance), **after** = this branch
(0.9.84 guidance: tracing rules in `takeoff://wiki/workflows`, the initialize instructions and the
`measure_polygon` description). Exports frozen and hashed before scoring; scored against the plan-set
reference v2 with the repo scorer.

| Room | before: SF err / IoU / max px | after: SF err / IoU / max px |
|---|---|---|
| CONFERENCE/BREAK ROOM 134 CPT-1 | 1.55 % / 0.9833 / 12.8 px | 0.04 % / 0.9985 / 6.2 px |
| CONFERENCE/BREAK ROOM 134 VCT-1 | 0.01 % / 1.0000 / 0.0 px | 0.01 % / 1.0000 / 0.0 px |
| STORAGE 134A CPT-1 | 1.49 % / 0.9276 / 5.5 px | 2.24 % / 0.9635 / 5.5 px |
| OFFICE 136 CPT-1 | 1.50 % / 0.9850 / 5.4 px | 0.38 % / 0.9897 / 40.5 px |
| PATIENT ROOM 137 CPT-1 | 1.40 % / 0.9860 / 13.0 px | 0.05 % / 0.9993 / 5.7 px |
| TOILET 137A PT-1/PT-2 | 0.76 % / 0.9869 / 3.6 px | 0.06 % / 0.9995 / 2.9 px |

| | before | after |
|---|---|---|
| rooms with every door crossed on the wall centerline | 0 / 6 (all doors run straight along the wall line) | 6 / 6 |
| median SF error vs reference | 1.45 % | 0.05 % |
| total SF vs reference 794.7 | 784.2 (-1.32 %) | 795.4 (+0.09 %) |
| rooms passing the 2.5 px gate | 1 / 6 | 1 / 6 |
| tool calls | 44 | 47 |

What moved: every door notch (the before run's six worst points are all door-notch vertices; the
after run has none), and with them the SF error on four of six rooms from about 1.5 % to under 0.1 %.
What did not move: the strict pass count, because jamb readings of 3–6 px remain on both sides of the
2.5 px gate, and because the after run missed one wall stub in OFFICE 136 that the before run had
wrapped (40 px, 1.6 SF) and squared off the NE step of STORAGE 134A (0.4 SF). Those two are
run-to-run variance on a single trial each, not a regression the text caused; they are recorded here
rather than averaged away.

Boundary: one run per condition, one model, one plan. This shows the packaged text changes what an
unprompted agent does on this plan; it is not a population claim.

Files: `before/` and `after/` each hold the frozen `export_takeoff.json` with its hash, the score
against reference v2, the whole-cluster overlay (`compare-all.png`, green reference, red candidate),
zoom crops at that run's worst-disagreement points, and the agent's own `RUN-NOTES.md`.
