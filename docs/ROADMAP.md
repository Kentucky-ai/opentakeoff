# Proposed roadmap

These phases describe the agreed sequence. Delivered entries record the current
foundation; deferred entries are proposals, not shipped capability. Check the
[capability status](wiki/status.md) for current behavior.

| Phase | State | Scope and evidence |
|---|---|---|
| 1. Protocol | Delivered | Bounded Takeoff Protocol draft, compatibility inventory, preflight and opt-in adapters. Existing protocol checks prove the contracts without changing runtime writers. |
| 2. Wiki | Delivered | Canonical status, architecture, protocol, workflow, routing and repository pages, with packaged-resource checks. |
| 3. MCP protocol usability | Gate reached (see below) | Measure tool-selection and completion behavior, maintain independent geometry evidence, and keep generated resources/counts synchronized. A proposed estimator-trace [plan set](../evals/mcp-workflow-bench/plan-set/README.md) of three public real floor plans now exists; its rings are agent-prepared and await human review, and no agent accuracy has been measured against it yet. Automatic room detection remains gated pending [#385](https://github.com/Kentucky-ai/opentakeoff/issues/385) and open accuracy discussion [#409](https://github.com/Kentucky-ai/opentakeoff/issues/409). |
| 4. Repository/package boundaries | In progress: [dependency map](design/PACKAGE_BOUNDARIES.md); first extraction (shared takeoff constants, three parity tests) shipped in 0.9.85 | Clarify extraction, package ownership and release boundaries after the current source/package guards are measured. |
| 5. Identity and signatures | Deferred | Define verified identity and signature evidence for records or artifacts before advertising authentication. |
| 6. Academy interoperability | Deferred | Resolve the inventoried incompatibilities and establish an adapter or certification bridge with independent evidence. |
| 7. Optional chain anchoring | Deferred | Define an opt-in anchoring contract only after identity, signatures and interoperability are settled. |

## Phase 3 completion gate (2026-09-12)

One table of what is measured, what is preserved, what is supported, and what is still open.
Every number links to the evidence that produced it; nothing here is a claim about real-plan
accuracy in general. #385 and #409 stay open: their acceptance criteria are not met.

| Question | Measured answer | Evidence |
|---|---|---|
| Which workflows are complete end to end? | Scripted known-answer workflow (load → scale refusal → scale → propose → measure → label → overlay → duplicates → export → fresh-process reopen) passes on the synthetic fixture and on all three real-plan references, flat and staged, both CI platforms. Human review loop (import → correct → accept → export → archive → report → marked set → reopen on a clean profile) exercised once with screenshots. | [workflow bench](../evals/mcp-workflow-bench/README.md), [plan set known-answer summaries](../evals/mcp-workflow-bench/plan-set/README.md), [human review](../evals/mcp-workflow-bench/plan-set/human-review-2026-09-12/README.md) |
| What does discovery and decision cost an agent? | Scripted conformance: 23–28 tool calls flat, 26–31 staged per plan. Blind agent runs: 29 (Roseburg, 4 rings), 44 (Porterville, 6), 54 (St. Cloud, 6) tool calls, of which 11–23 were `view_sheet` inspections; 0 geometry edits after commit. Recorded synthetic pilot (another model): 21 calls plus 12 in an assisted correction. Counts describe these runs, not a population. | [blind runs](../evals/mcp-workflow-bench/plan-set/BLIND-RUNS-2026-09-12.md), [pilot](../evals/mcp-workflow-bench/evidence/README.md) |
| How accurately does an unprompted agent draw, by room? | Against the v2 references (agent-prepared, not human-reviewed), one blind run each: St. Cloud 6 rings all within 0.05–0.39 % SF and IoU ≥ 0.992 (1 of 6 passes the 2.5 px gate; the rest sit 3–6 px off at door jambs); Roseburg 3 of 4 exact, D104 open on Q13; Porterville four of six within 0.4–2 % SF, W/D alcove and pantry open on Q11/Q14. With no conventions in the task, the packaged guidance alone moved door notches from 0 of 6 rooms to 6 of 6 and median SF error from 1.45 % to 0.05 % (one run per condition). | [blind runs](../evals/mcp-workflow-bench/plan-set/BLIND-RUNS-2026-09-12.md), [guidance trial](../evals/mcp-workflow-bench/plan-set/guidance-trial-2026-09-12/README.md) |
| By role? | Floor area only. Base, transitions, wall surfaces and counts have no reference in the plan set; their tool behavior is covered by unit and protocol tests, not by a drawing benchmark. | [plan set](../evals/mcp-workflow-bench/plan-set/README.md) |
| What is preserved? | A human correction freezes the agent's ring (`origin.proposed_verts_norm`); Accept sets `origin.reviewed` without creating an approval record; the project archive round-trips geometry, review flags, frozen originals and SF byte-for-byte on a clean profile. Transport matrix: 10 scoped conforms, 1 needs-adapter, 5 unsupported. | [human review](../evals/mcp-workflow-bench/plan-set/human-review-2026-09-12/README.md), [compatibility](../protocol/COMPATIBILITY.md) |
| Which handoffs are unsupported? | Stitched browser documents through MCP; conflicting destination calibration; whole-workspace rules and extensions through MCP; unloaded source sheets; archive revision history; cross-machine sync (#315). None was fixed in Phase 3. | [capability status](wiki/status.md) |
| What is still open? | #385 (canvas One-Click annexes a corridor the MCP flood seals; One-Click stays gated). #409: publishable references now exist, but none is human-reviewed, so its first criterion is not met; the 16 → 14.44 SF mask case is untouched. Estimator questions Q1–Q17. The strict 2.5 px gate is not met on most real rooms. Repeat runs and a second model on the plan set are owed before any repeatability claim. | [#385](https://github.com/Kentucky-ai/opentakeoff/issues/385), [#409](https://github.com/Kentucky-ai/opentakeoff/issues/409), [questions](../evals/mcp-workflow-bench/plan-set/QUESTIONS.md) |
| Release versions | Published: `opentakeoff-mcp` 0.9.83 (npm, Registry, hosted manifest, desktop bundle). Source: 0.9.84 on `main` with the packaged tracing rules, not yet tagged or published. Web package 0.1.0, independent. | [changelog](../CHANGELOG.md), [deployment](DEPLOYMENT.md) |

Reading the gate: the protocol, wiki and MCP workflow contracts exist and are exercised; the
drawing evidence is real but thin (one run per plan, one model, references unreviewed).
Phase 4 package work may start on that basis. It does not close Phase 3's accuracy questions,
which continue as evaluation increments alongside it.

Unprioritized candidates within these phases include easier stitching and seam
verification, preserving stitched jobs through agent handoff, shared review and
sync ([PR #388](https://github.com/Kentucky-ai/opentakeoff/pull/388), [#315](https://github.com/Kentucky-ai/opentakeoff/issues/315)),
and model-generated floor suggestions. They remain bounded by the current
stitching limits and review authority; none is advertised as shipped.
