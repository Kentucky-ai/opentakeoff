# MCP workflow benchmark

This is a scripted MCP conformance benchmark, not an agent-performance claim.
It drives a fresh stdio server through the same workflow an agent is expected
to use: source inspection, explicit scale, a proposal, four manual room-area
traces, overlay rendering, summary, report, marked PDF, editable export, and
fresh-process import preservation.

The reference is analytic geometry derived from the repository's synthetic
`demo/sample-plan.pdf` construction (`demo/make_sample_plan.py`): each room is
the wall-face rectangle inset 1.5 PDF points from its enclosing walls. It is
not independently human-reviewed real-plan ground truth. The runner uses
render scale 2.0 and 1/4 inch = 1 foot, so the sheet is 2448×1584 image pixels.
It intentionally does not use the One-Click flood engine or existing pinned
goldens to create the answer key.

Prerequisites are Node 24 (`/opt/homebrew/opt/node@24/bin/node` on the
maintainer workstation), installed web and MCP dependencies, and a current MCP
build. From the repository root, install and build when needed:

```sh
npm ci --prefix web
npm ci --prefix mcp
npm run build --prefix mcp
```

Run with Node 24 from the repository root:

```sh
node evals/mcp-workflow-bench/run.mjs --out /tmp/open-takeoff-mcp-bench
node evals/mcp-workflow-bench/score.mjs /tmp/open-takeoff-mcp-bench/flat/export_takeoff.json
node --test evals/mcp-workflow-bench/score.test.mjs
```

The output directory must be new; the runner refuses to overwrite an existing
directory. It contains separate flat and staged records, timings, source-
inspection PNGs, exported JSON/PDF artifacts, process-preservation checks, and
a reproducibility summary. The runner sets `OPENTAKEOFF_ONE_CLICK=0` in both
processes, records staged tool lists and expected refusals, scores both
exports, and requires flat/staged canonical equality. Round-trip comparison
uses an exact payload comparison; the independent flat/staged comparison uses
the semantic normalization in `run.mjs`'s `canonicalExport` function, which
ignores only minted IDs and documented timestamps.
The summary reports total explicit JSON-RPC requests (initialize plus logged
requests), non-tool requests, and tool calls; notifications are excluded.
`score.mjs` accepts a candidate editable export and the reference path can be
overridden with `--reference`; it is intentionally usable without the runner's
answer log. It reads the public export contract (`label`, `measure_role`,
`computed.area_sf`, and `verts_norm`); fixture dimensions are supplied by the
reference because editable exports do not carry `dims_px`. Matching uses exact
polygon intersection and a bounded supported-profile vertex-to-opposite-edge
distance metric, with explicit failures for
missing, duplicate, extra, invalid, or holed shapes. The tests cover exact
positive, shifted equal-area, same-range wrong-polygon, missing/duplicate, and
invalid-ring cases.

The answer geometry is an analytic synthetic fixture derived from the bytes of
`demo/sample-plan.pdf` (SHA-256 pinned in `reference.json`; the PDF was built
by `demo/make_sample_plan.py`). It is a
deterministic protocol/conformance check, not a model benchmark and not a claim
of real-plan accuracy or human review.

The standalone scorer assumes the candidate belongs to the pinned source PDF;
legacy editable exports do not contain its byte hash. Only the runner verifies
the source bytes. The reference profile requires convex answer polygons and
simple, unholed candidate rings; it is not a general construction-plan scorer.

Root Git attributes mark PDFs as binary so Windows checkout preserves their
bytes, including ASCII-only PDFs whose line endings affect offsets and hashes.
