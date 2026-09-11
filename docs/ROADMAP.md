# Proposed roadmap

These phases describe the agreed sequence. Delivered entries record the current
foundation; deferred entries are proposals, not shipped capability. Check the
[capability status](wiki/status.md) for current behavior.

| Phase | State | Scope and evidence |
|---|---|---|
| 1. Protocol | Delivered | Bounded Takeoff Protocol draft, compatibility inventory, preflight and opt-in adapters. Existing protocol checks prove the contracts without changing runtime writers. |
| 2. Wiki | Delivered | Canonical status, architecture, protocol, workflow, routing and repository pages, with packaged-resource checks. |
| 3. MCP protocol usability | Current next | Measure tool-selection and completion behavior, maintain independent geometry evidence, and keep generated resources/counts synchronized. A proposed estimator-trace [plan set](../evals/mcp-workflow-bench/plan-set/README.md) of three public real floor plans now exists; its rings are agent-prepared and await human review, and no agent accuracy has been measured against it yet. Automatic room detection remains gated pending [#385](https://github.com/Kentucky-ai/opentakeoff/issues/385) and open accuracy discussion [#409](https://github.com/Kentucky-ai/opentakeoff/issues/409). |
| 4. Repository/package boundaries | Deferred | Clarify extraction, package ownership and release boundaries after the current source/package guards are measured. |
| 5. Identity and signatures | Deferred | Define verified identity and signature evidence for records or artifacts before advertising authentication. |
| 6. Academy interoperability | Deferred | Resolve the inventoried incompatibilities and establish an adapter or certification bridge with independent evidence. |
| 7. Optional chain anchoring | Deferred | Define an opt-in anchoring contract only after identity, signatures and interoperability are settled. |

Unprioritized candidates within these phases include easier stitching and seam
verification, preserving stitched jobs through agent handoff, shared review and
sync ([PR #388](https://github.com/Kentucky-ai/opentakeoff/pull/388), [#315](https://github.com/Kentucky-ai/opentakeoff/issues/315)),
and model-generated floor suggestions. They remain bounded by the current
stitching limits and review authority; none is advertised as shipped.
