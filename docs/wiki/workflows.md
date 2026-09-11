# Workflows

## Human: open, stitch and measure

Open the plans and check their revision. In the sheet gallery, select the
2–4 split sheets in left-to-right order and click **Stitch N into one surface**.
On the composite, choose **Align**, click a recognizable point near the joint,
then click the same drawn point on the other sheet. Check the joint and scale
before tracing. Once shapes exist on a stitch, alignment is locked.

Use the composite as one measuring surface. Its marked-set page is labeled as
a composite, not an architect-issued sheet. Save the editable project archive
when preserving the composite is required. MCP has no stitch/alignment tool and
its current import/export path omits stitches: it cannot be used as a lossless
handoff for that document. Have an MCP agent measure source sheets individually
with explicit scope boundaries instead.

Source: [Human stitching instructions](../USER_GUIDE.md#stitching-a-floor-split-at-a-match-line),
[stitch records](../../web/src/lib/stitches.ts),
[compatibility evidence](../../protocol/COMPATIBILITY.md).

## Agent: source to reviewed handoff

1. `load_plan` → inspect sheets/revisions → `set_scale` on each measured sheet.
   Confirm the relevant detail's scale, which may differ from the overall plan.
2. Read source text and vectors; inspect the matching region with `view_sheet`.
   Use each room's schedule evidence for its finish. Missing/ambiguous evidence
   is a qualification or RFI, not an inferred assignment.
3. `propose_takeoff` names a batch; it creates no geometry. Measure small batches
   with the appropriate area, run, surface or count tool.
4. Inspect overlays and actual boundaries, openings, jambs and deductions.
   `edit_shape` corrects pending shapes. Physical base gaps use explicit runs;
   stepped wall faces use separate height bands. See the [geometry workflow](../GEOMETRY_WORKFLOW.md).
5. `takeoff_summary` and `export_report` check quantities and material coverage.
   Shorten notes through `list_annotations` → `edit_annotation` where permitted.
6. Export editable takeoff JSON and a marked-set PDF, reopen the JSON against
   the same source, and check the handoff. Leave agent work pending for the
   human's review; exported files and agent verdicts do not create approval.

The [MCP route map](mcp.md) gives the next tool at each step. The
[agent guide](../AGENT_GUIDE.md) covers staging and refusal recovery.

## Evidence that another person can review

Keep source/revision identifiers, calibration choices, measured geometry,
expected-versus-observed checks and an overlay or marked-set view. Compare
spatial agreement as well as quantities. Disclose reference-assisted work;
it is not a blind accuracy benchmark. Public PRs include screenshots, video or
reproducible stats, using publishable fixtures. Private drawings and pricing stay
outside the public repository. See the [repository guide](repo-guide.md).
