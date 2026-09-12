# Workflows

## Human: open, stitch and measure

Open the plans and check their revision. Press **G** (or choose **Sheets → Open
gallery…**) to open the sheet gallery, then select the
2–4 split sheets in left-to-right order and click **Stitch N into one surface**.
On the composite, choose **Align**, click a recognizable point near the joint,
then click the same drawn point on the other sheet. Check a second recognizable
point and the scale before tracing. Align translates a member; it does not
rotate or resize it. Once shapes exist on a stitch, alignment is locked.

If the controls seem missing, **Stitch N into one surface** is in the gallery
footer and requires 2–4 selected sheets; **Align** appears only on an open
stitched surface. Create a fresh stitch if Align refuses because takeoffs
already exist; deleting a stitch also refuses while takeoffs or markups exist.

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

### Trace a room the way an estimator does

Blind agent runs against reviewed references showed that the ring, not the
total, is what fails. These rules are what the references are drawn to:

1. The boundary is the **innermost interior wall face**. Never the wall
   centerline, never the far face, never under a wall. Casework, counters,
   fixtures, equipment, hatch patterns, dimension strings, text and leaders
   never define the boundary; the finish runs under casework and fixtures.
2. Corners sit where two adjacent wall-face strokes meet. Read the strokes with
   `get_sheet_vectors` over a tight region and put each vertex on a stroke; do
   not trace a hatch edge or a raster guess.
3. At every **door or cased opening** the ring follows the face to the jamb,
   turns into the opening, runs across it on the **wall centerline** (midway
   between that wall's two faces, the full wall on a composite wall), and
   returns along the far jamb. Both rooms sharing the door share that segment.
   A door leaf and its swing arc are never part of the boundary; a leaf drawn
   standing open looks like a wall line and is not one.
4. **Windows** and other non-passable openings do not break the ring.
5. Columns, chases, pilasters and wall stubs that project into the room are
   traced around; an enclosed cell drawn with wall-weight lines is not floor.
6. A **finish split** inside one room is two rings sharing the drawn
   transition line exactly, no overlap and no gap. Where two rooms meet with no
   wall, split on the drawn transition line or the partition's centerline.
7. Take the finish from the schedule row; a plan tag alone is a cross-check.
8. After each ring, `view_sheet` a tight crop with `overlay: true` at a high
   `px` and look at every corner and notch before the next room; `edit_shape`
   fixes what the crop shows. A full-sheet render cannot audit a ring.

When something is genuinely ambiguous, follow the rule most literally, carry it,
and say so in the shape's label or an annotation. Do not stop.
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
