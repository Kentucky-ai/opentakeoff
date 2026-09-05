# OpenTakeoff MCP server

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.Kentucky-ai/opentakeoff`, on [Glama](https://glama.ai/mcp/servers/Kentucky-ai/opentakeoff),
and on [Smithery](https://smithery.ai/servers/Kentucky-ai/opentakeoff).

**This page is the reference—every tool, every rule, every limit.** For *how to run a
takeoff well* with it—the operating model, the standard finish, what the engine withholds
and why, and the move that answers each refusal—read
[`docs/AGENT_GUIDE.md`](../docs/AGENT_GUIDE.md) first. It's short, and it's the half that
decides whether the numbers are any good.

## Run it in 60 seconds (npx)

No clone, no build—point your MCP client at the published package:

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}
```

Works with Claude Code (`claude mcp add opentakeoff -- npx -y opentakeoff-mcp`), Claude Desktop, Cursor, or any stdio MCP client. Node 20+.

## One-click install (Claude Desktop)

No Node, no npm: download **`opentakeoff-mcp.mcpb`** from the
[latest release](https://github.com/Kentucky-ai/opentakeoff/releases) and
double-click it—Claude Desktop installs the server with its dependencies
bundled. Built by `npm run mcpb` and attached automatically to every `mcp-v*`
release. The bundle is platform-neutral on purpose: it excludes the optional
native canvas, so every JSON tool and the text/metadata resources work
everywhere; the sheet-image resource and the `view_sheet` tool say exactly
what's missing where rendering isn't available.

## One-Click is temporarily gated

`one_click` and `detect_rooms` are **not registered** on a default build while the flood
engine is re-validated against a wider plan corpus: `tools/list` never names them, the
initialize `instructions` say so and point at `measure_polygon`, and no other tool's
description sends an agent to a verb that is not there. A default build registers
**52 tools**. Everything else — sweeps, counts, `derive_base`, `derive_transitions`, the
exports — is unchanged. Set `OPENTAKEOFF_ONE_CLICK=1` in the server's environment to
register both verbs (54 tools); the parity, conformance and e2e tests run that way, and
`test/gate.test.ts` pins both surfaces. The rows and examples below that use `one_click`
describe the lifted build. Design note: [`docs/design/ONE_CLICK_GATE.md`](../docs/design/ONE_CLICK_GATE.md).


The takeoff engine—One-Click Area, the scale model, conditions, totals—on
**stdio for your MCP client**. An agent can open a plan, read the title block,
set the scale, click rooms, and hand back the same takeoff payload the browser
app autosaves. Same engine, same math: the server imports
`web/src/lib/{oneclick,sheets,geometry,totals}` directly, so a shape committed
here is field-identical to one committed on the canvas.

## Run with Docker

Build from the repository root so the Dockerfile can bundle the shared web
engine:

```bash
docker build -f mcp/Dockerfile -t opentakeoff-mcp .
docker run --rm -i opentakeoff-mcp
```

Mount local plans read-only and pass that container path to `load_plan`:

```bash
docker run --rm -i -v "$PWD/demo:/plans:ro" opentakeoff-mcp
docker run --rm -i -e OPENTAKEOFF_MCP_TRACE=1 -v "$PWD/demo:/plans:ro" opentakeoff-mcp
```

For example, load `/plans/sample-plan.pdf` after mounting `demo/`.

## Quickstart

Both `web/` and `mcp/` need their dependencies (the engine's pdf.js lives in
`web/node_modules`):

```bash
cd web && npm install
cd ../mcp && npm install
node --import tsx server.ts        # speaks MCP on stdio
```

Then register it with your MCP client (any stdio MCP client works):

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/opentakeoff/mcp/server.ts"]
    }
  }
}
```

Point `command` at `node` directly, as above—**never `npm start` in a client
config**: npm prints its banner to stdout, and stdout is the MCP wire. (Same
reason the server redirects `console.log` to stderr before pdf.js loads—see
`src/hush.ts`.)

`tsx` is a runtime dependency, not a build tool: the engine is imported
straight from `web/src/lib` as TypeScript, so plain `node` can't run it.

For tool-call debugging, opt into structured stderr tracing:

```bash
OPENTAKEOFF_MCP_TRACE=1 node --import tsx server.ts
```

Each tool call writes one JSON line to stderr with the tool name, duration,
sheet, result size, and error flag. The trace never writes to stdout and never
includes document text, shape vertices, or result payload content.

### Staged tool exposure (opt-in)

By default every client gets all 52 tool schemas on `tools/list`—the flat
contract every published client already expects. Fifty-two descriptions is real
token weight for an agent session that may never touch half of them, so the
server can instead stage the surface along the workflow it already teaches:

```bash
OPENTAKEOFF_MCP_STAGED_TOOLS=1 npx -y opentakeoff-mcp
```

Staged, only the **setup** stage (load, scale, read the set—11 tools) starts
enabled, plus one opener: `open_tool_stage`. Calling it with `"measure"`,
`"revise"`, or `"handoff"` enables that stage's tools and fires
`tools/list_changed`, so any client that supports dynamic tool lists (Claude
Code, Claude Desktop, anything built against the current spec) sees the group
appear the moment the agent asks for it. Opening is idempotent and never
closes anything—the surface only grows. The initialize instructions state
the scheme, so an agent knows to open a stage before it needs one. Requires a
client that honors `tools/list_changed`; leave the flag unset for one that
reads the tool list once. ([#230](https://github.com/Kentucky-ai/opentakeoff/issues/230))

## Tools

| Tool | What it does |
|---|---|
| `load_plan` | Open a plan PDF from disk. Default replaces the whole session; **`merge: true` ADDS the document to the working set** (#152)—plans + schedule + addenda as one takeoff, sheet graph spanning the whole set, marked set covering every worked sheet. Returns per-sheet dims, title-block `sheet_number`, and the detected drawn scale where present. |
| `sheet_info` | One sheet's dims, vector segment count, scale status, detected suggestion, committed shape count. |
| `set_scale` | Set a sheet's scale—exactly one of `label`, `upp`, `calibrate {p1, p2, feet}`, `use_detected`. **Lands unconfirmed** (`confirmed: false`) until a human confirms in the canvas—see Scale rules. |
| `one_click` | **Temporarily gated — not registered unless `OPENTAKEOFF_ONE_CLICK=1`.** One-Click Area at (x, y): the sealed flood engine bounded by the plan linework, traced, vertices snapped—the SAME feet-true arguments the canvas passes at a click (gap sealing up to a door width, door-swing wedge inclusion, the half-foot minimum-passage rule), so an MCP trace and a canvas click at one seed measure the same square footage (pinned against the bench corpus goldens in `test/parity.test.ts`). Every trace carries the engine's account of itself: `confidence` 0–1 with `confidence_factors` naming each deduction (`gap_sealed_px`, `door_wedges`, `min_pass_delta`, …)—a review prioritizer, never a verification; a low score is a `view_sheet {overlay: true}` audit prompt, not a fact. On a SCANNED sheet (no usable linework) the flood falls back automatically to the rendered pixels—same engine as the canvas—with `raster_traced` disclosed on the reply and on the shape's origin (#154). Pass `condition` to commit (the full account stamps `origin` centrally at the commit); `role: "deduct"` subtracts. |
| `detect_rooms` | **Temporarily gated — not registered unless `OPENTAKEOFF_ONE_CLICK=1`.** Batch One-Click: reads every room-number label off the sheet's text layer and floods each—one call instead of `read_sheet_text` + reasoning + N `one_click` calls, through the SAME sealed engine per room (confidence + the engine account ride each room and its committed origin). Only cleanly-traced rooms come back; everything skipped is counted and reasoned in `withheld` (degenerate / duplicate / implausible / unresolved), never dropped silently. To commit: `assign_from_schedule: true` routes each room through its OWN room-finish schedule row and commits under the FLOOR finish that row states (rooms the schedule can't answer for return in `unresolved[]` with reasons and re-seedable coordinates); or pass `condition` to commit every room under one stated tag. |
| `measure_polygon` | Area + perimeter of a polygon you supply (min 3 verts). Requires scale. |
| `cut_out` | **A real hole in a committed floor shape** (#206), reconciled the way the canvas cuts one (#137)—the same `lib/cutout.js` boolean subtract, one module, so a headless session and the app can never disagree about what a hole holds. The parent keeps its outer ring + `verts_norm_holes`, its `computed` nets for real (N cuts compose, overlap never double-deducts, a hole ADDS perimeter), and the deduct carries `cuts_shape_id` so report/legend read the reconciled number. Refuses a ring not FULLY inside the parent (the canvas's edge-clip is a canvas affordance; over the wire it's refusal-over-guessing) and a cut that would erase or split the parent. One undo step restores parent and hole together; `delete_shape` on the deduct reverts the cut too (multi-cut parents rebuild from the chain's pristine snapshot minus survivors—the canvas's own delete semantics, ported as the spec). |
| `measure_line` | Length of an open polyline (min 2 points). Requires scale. |
| `derive_base` | **Base LF from committed rooms**: for every floor shape of a source condition, commits a linear base run tracing that room's boundary, quantified net of the door openings YOU state per room (`{shape_id, lf}`—your claim, recorded on `origin.derived`; the tool never guesses). All-or-nothing; one undo step. |
| `derive_transitions` | **The transition where two finishes meet**: pass two finish tags and the tag to commit under, and every committed room of each is compared against every room of the other. The catch this is built around—flood-traced rooms **do not share edges**, a partition puts 4–8″ between them—so proximity comes in two flavours and they are never conflated. A **butt joint** (rings running together inside one open space, within an inch) *is* the transition and commits as a linear shape, `origin.derived` naming both parents, the tags, and the measured gap. A **wall-separated** run means the rooms are adjacent across a partition, where the transition is a threshold in a doorway that nothing in the trace record locates (the flood engine reports how *much* boundary it sealed, never where)—those return in `withheld` with length, gap in inches, and an `at` point to `view_sheet`, as questions rather than a confident wrong number. `max_gap_in` (default 12) only ever turns more of the plan into questions, never into committed LF. All-or-nothing; one undo step. |
| `measure_surface` | **Wall SF**: an open run traced along the wall, quantified as traced LF × the condition's height (the canvas's H knob—pass `height_ft` to set it, or set it once with `edit_condition`). Wall tile, wainscot, wall systems. Refuses without a height, minting nothing. |
| `place_count` | **EA markers**: one point, one each—thresholds, stair nosings, floor boxes. No scale required (EA is scale-free). One shape per point; the whole call is one undo step. |
| `symbol_sweep` | **Every instance of a repeated plan symbol, from ONE example**: marquee a tight `seed_rect` around a single drain/threshold/fixture symbol and the vector linework is searched deterministically for every other placement—translation plus 0/90/180/270 rotation and mirroring (both on by default). Score = length-weighted fraction of the seed's segments matched within `tolerance_px`; ≥ 0.92 is a match, the 0.75–0.92 band returns in `withheld` with reasons (never committed, never dropped silently), and the work cap is disclosed when it bites. **`scope: "set"` sweeps the whole working set, counting on PLAN-role sheets only** (the sheet graph decides; every excluded sheet disclosed in `skipped` with role and reason)—and the seed rect may sit on a detail or legend sheet, which then serves as the fingerprint SOURCE while staying excluded from counting: the estimator's "click the assembly in the detail, count it on the plans" gesture. Per-sheet results carry their own match/withheld lists, per-sheet cap accounting, and wall-clock `elapsed_ms`. `commit: true` + `condition` commits every match center as an EA count marker—the whole sweep (set-wide included) is one undo step, `origin.method "symbol_sweep"` with per-marker score, transform, and seed source (`origin.symbol.seed`). No scale required. **Counter-examples** (`exclude`, #259): rects around instances you do NOT mean, marqueed like the seed—the rect's own contents decide whether it rejects by extra contained linework or by the background line running THROUGH it that a real instance would break; every rejection disclosed in `rejected[]`, reinstatable with `place_count`, dead negatives refused with instructions. **Stroke-luminance gate** (`luminance_tolerance`, #260): for flattened exports where layers and pen weights are stripped but the file still states stroke color—a stated tolerance holds candidates to the seed's own pen, opt-in both ways, with `lum_gate` naming every placement the pen pulled under the bar. **Labels** (#308): for labeled families the sweep reads the drawing's own names—a fixture token written beside a placement or connected by its drawn leader (leader-following arms only on multi-pen sheets)—as `label`/`label_via` on every row plus `seed.label`; the reply flags shape-only matches in a labeled family, withheld rows carrying the seed's own tag, and matches the drawing names differently. Disclosure, never a recount. |
| `sweep_schedule_row` | **Take off a schedule row's mark from the row itself**: pass the row's key (for example, `T1`) and the tool reads the row from the set's schedule tables (the row is the condition's cited source), anchors a fingerprint on the marker the tag is DRAWN as on a plan sheet (a deterministic pad ladder around the tag text; where the tag occurs more than once the fingerprint must recur at a second occurrence—`anchor.corroborated`—before it is trusted), and sweeps every plan-role sheet. **The count is geometry AND text agreeing**: drafting reuses one bubble shape across many marks, so a match counts only when the row's own tag sits within the marker footprint (its bbox rides the match as `tag_at` evidence); a match labeled with a sibling key is `excluded` and says whose it is, an unlabeled match is `withheld` as a question, a tag drawn with no matching marker is `text_only`. Refusal over guessing, each with the reason and the fix: no such row, an ambiguous key, a tag drawn on no plan sheet, no repeatable marker linework—a fingerprint is never guessed from text alone. `commit: true` commits the counted matches under the row's own key—one undo step, `origin.assignment {source: "schedule"}` plus the anchor and row citation on `origin.symbol.seed`. No scale required. |
| `takeoff_summary` | Per-condition totals + grand totals, computed by the Report's rules. |
| `export_takeoff` | The full `opentakeoff.takeoff_canvas.v1` payload—exactly what the app autosaves. Inline, and to disk with `path` (see **Writing to disk** below). |
| `delete_shape` | Remove a committed shape by id. |
| `propose_takeoff` | **Open a named batch** (#365). Every shape you commit from here on attaches to it (`origin.proposal_id`, stamped centrally at the commit—hand traces, sweeps, derives, `cut_out` alike), so the estimator sees ONE Accept pill for the batch instead of one per shape. `label` is what they read on the pill, `rationale` is what decided the batch; both required. Commits nothing itself. |
| `revise_proposal` | Replace **every still-pending shape** in a batch with a new set, as one journal step. All-or-nothing: validated (sheet, scale, vertex minimum, a height for `surface_area`) before the first pending shape is removed, the error naming the entry. Accepted shapes are ink and stay. One `undo_last` puts the previous batch back. |
| `withdraw_proposal` | Remove a batch's pending shapes in one step; the record stays marked withdrawn, accepted shapes stay (the reply counts them). `undo_last` restores the whole batch. |
| `propose_condition_edit` | **Propose** a condition change instead of making it: a diff—new `finish_tag` (rename), `waste_pct`, `multiplier`, `height_ft`, `roll_setup`—held pending until the estimator accepts from the panel. Nothing changes until then: `takeoff_summary` and `export_report` compute from the current values and carry the diff beside them. Only differing fields are recorded; a no-op or a rename onto a taken tag is refused; one pending diff per condition (proposing again replaces it). `rationale` required. |
| `withdraw_condition_edit` | Drop a pending condition-edit diff without touching the condition. |
| `scope_duplicates` | **Two conditions claiming the same floor, as a list** (#366): every pair of committed floor shapes on one sheet whose EXACT polygon intersection exceeds `min_fraction` of the smaller (default 0.05), with the shared SF, each side's condition, label and review state, and a `look` region for `view_sheet {overlay: true}`. Different conditions = a collision (the floor is counted twice downstream); the same condition = a double trace, returned in `duplicates`. `shared_floor_sf` is Σ areas − union over the compared set, counted once per cell — the number `takeoff_summary` always carries. Deducts and runs are not claims; unscaled sheets and degenerate rings are `unmeasured`, never zero. Read-only. |
| `scope_merge` | **Resolve one collision**: given the pair and the winner, the loser gives up the shared floor — trimmed to its remainder (exact boolean difference, quantities re-measured) or deleted when the overlap is near-total (≥ 98% of the loser). One journal step; `undo_last` restores the loser verbatim. With `winner` omitted the reviewed shape wins; refuses when neither is reviewed (it does not guess), when both are (the estimator's call in the canvas), always when the loser is ink, when the trim would split the loser, and when the loser carries reconciled cutouts. |
| `edit_shape` | **Revise** a committed shape instead of redoing it: new `verts`, a different `condition`, a different `role`, a `label` (the room it belongs to—what per-room reporting groups by; `""` clears it), or any combination—quantities recomputed from the result. Refuses shapes a human affirmed. |
| `edit_materials` | Add/remove/patch supporting-materials rows on a condition—the coverage-rate lines (adhesive at N sf/gal, grout at N lf/bag, …) that turn a measured quantity into an order quantity, matching the canvas's Supporting Materials panel. `basis` is `area` \| `linear` \| `count` \| **`seam_lf`**—the last is the *figured* roll-layout seam length a weld rod or seam tape is bought by (set `roll_setup` on the condition first; without one it reads 0, because nothing has decided how that floor gets cut). `condition` mints on first touch, like `one_click`/`measure_polygon`. No review gate (materials rows are quantity config, not traced geometry)—edits directly, reversible with `undo_last`. |
| `edit_condition` | Set a condition's **waste %**, **×N multiplier**, **height_ft** (the H knob `measure_surface` quantifies against), and **roll_setup** (the roll-goods opt-in: seams figured, cuts packed, the reply echoes the order—cuts, `order_lf`, rolls, `order_qty`—and `export_report`'s `roll_goods` block carries the same rows; `null` opts out)—the knobs that turn measured quantities into order quantities. Resolves an **existing** finish tag or errors—a typo must not mint an empty condition. No review gate; one `undo_last` step restores the knobs verbatim. |
| `duplicate_condition` | **Twin a condition**—the same finish measured somewhere else, with its own supporting materials. One finish in two areas is neither two conditions nor one: the same sheet goods over a slab and over a raised deck take the same field material and different preparation underneath. The twin arrives carrying the original's whole materials list and keeps **following** it—fix a coverage rate on the original and every twin that hasn't touched that row gets it; edit a row on the twin and only THAT row stops following. `label` is required and becomes the tag suffix (`CPT-1` + `Level 2` → `CPT-1 – Level 2`). Reversible with `undo_last`. |
| `split_condition` | **Cut a twin loose** from its family: every following material row freezes at its current values and edits to the original stop reaching it. It keeps its finish tag and still groups with its siblings—only the inheritance ends. For when two variants have diverged far enough that following each other is wrong. A condition that already owns its materials returns `split: false` rather than erroring. Reversible with `undo_last`. |
| `export_report` | The **computed Report document**—`opentakeoff.report.v1`, the same JSON the canvas Report exports: gross + waste-adjusted quantities, the computed materials **buy list** per condition plus the project-wide roll-up, per-sheet base subtotals, and scale provenance. The contract for pricing consumers—`export_takeoff` carries materials as config rows, `takeoff_summary` strips them. Inline, and to disk with `path` (see **Writing to disk** below). |
| `import_takeoff` | **The way back in**: load a `takeoff_canvas.v1` file (a prior `export_takeoff`, or the app's own save) through the SAME merge rules as the app's Sheet-menu import—finish-tag identity joins conditions (this session's knobs win), new ids append, duplicates skip (idempotent re-import), this session's calibration wins per sheet. Resume, extend, or audit. Correction rules (#88) ride the file too—`apply_rules` re-runs them. |
| `apply_rules` | **Re-run the correction rules the takeoff arrived with** (#207)—the lessons an estimator TAUGHT the canvas (#88), for example, "every room like this loses the mechanical chase". Same pure `rules.ts` engine the canvas Preview runs; committed as the ONE batch its Apply makes (`reviewed: false`, one undo step, `origin {method rule_v1, actor rule}` with the rule/seed/room citation). The reply's per-rule disclosure—produced, skipped, ids—IS the preview an agent gets. Idempotent by construction: anything an existing deduct covers is dropped by the engine, so re-running after new rooms commit is the intended workflow. Rules arrive ONLY through `import_takeoff`; minting one is an estimator's correction and stays behind the canvas's human Preview→Apply gate. |
| `export_dxf` | The takeoff as a **CAD drawing**—a DXF (R2000) that AutoCAD, BricsCAD, LibreCAD and Revit import as native geometry. One sheet per file, like a DWG: every committed shape becomes an `LWPOLYLINE` (floor rings closed, walls and linear runs open, counts a circle) on a layer named for its finish—`OT-<TAG>`, with `-DEDUCT` / `-HOLE` / `-WALL` / `-LINEAR` / `-COUNT` suffix layers and room labels on `OT-LABELS`. Real units in the sheet's frame (origin bottom-left, Y up; feet, or `units:"m"`), and a ring's CAD area equals its `export_report` area to rounding. Refuses without a scale; with several sheets carrying shapes, `sheet` picks the drawing. Names every shape left out and why. `path` required. |
| `export_marked_pdf` | The **marked-up planset**—the deliverable. Writes a distribution-ready PDF: a legend cover (per-condition totals, swatches, by-sheet breakdown) plus every sheet that carries work, vector-copied from the source with shapes, hatches, per-shape quantity chips, and annotations burned in—built by the same module as the canvas's MARKED SET button. Machine-traced shapes are disclosed as pending human review on the document itself, and the cover states where the finish tags came from (`Finish assignment: N schedule-resolved · N agent-asserted · …`, plus any rooms the last assign run withheld). Default path: `<plan> - marked set.pdf` next to the plan (see **Writing to disk** below). Works without `@napi-rs/canvas`. |
| `list_shapes` | The **mid-session inventory**: every committed shape's id, sheet, condition, role, quantities, room `label`, review state, and assignment verdict (`schedule` \| `asserted`—where its finish tag came from) in one compact read—the ids `edit_shape`/`delete_shape` assume you have, without pulling the whole `export_takeoff` payload. Filters by sheet/condition narrow; empty is a result, not an error. |
| `undo_last` | Step back over your own last `n` mutations, newest first. Exact inverses: a commit is removed, an edit restored verbatim, a delete re-inserted where it was, a materials edit's whole array restored, a condition edit's waste/multiplier pair restored. A whole `detect_rooms` sweep is **one** step. |
| `annotate` | Place a note ABOUT the work—cloud/highlight (`rect`), text (`at`), callout (`at` + `target`), **arrow** (`from` + `to`—plank/seam direction), **bubble** (`at` + optional `r`—keynote circle, centered text), **dimension** (`from` + `to`—a dimension line with end ticks, labeled with the measured length at the sheet's scale; the one annotation the scale gate applies to—an unscaled sheet refuses like the measure tools). Attach to a condition and it wears that scope's color on the canvas and in the marked set. No review gate: notes are not geometry. |
| `list_annotations` | Every annotation with its condition RESOLVED to a finish tag, coordinates back in image px; filter by sheet/condition. `unattached` counts the link_annotation candidates. `verdicts[]` is the approval family's inventory—every mark with its actor stated, a condition filter reaching a verdict through its target shape. |
| `link_annotation` | Attach an existing annotation to a condition (or detach with an empty tag)—the canvas's Attach/Detach control, reachable by an agent. |
| `mark_verdict` | The **agent's pencil-signature** on work it checked—the agent half of the approval family (#176). Mints the graphite AGENT diamond, and structurally nothing else: the tool takes no actor input, so the estimator's APPROVED ring stays behind the canvas's human-only Approve tool. Target a committed `shape_id` (anchored on the shape—a room's centroid, a run's midpoint—with the id recorded as provenance) or a `sheet` + `at` point; optional short `text` rides the record. Touches no quantity; renders on the canvas and in the marked set, whose cover tallies the split (`Approval stamps: N estimator-approved · M agent-marked`); rides the annotations payload through `export_takeoff`/`import_takeoff` and the app's own saves. One mark per shape. |
| `delete_verdict` | Lift an agent verdict mark by id. Agent marks only—the estimator's seal is human ink and is refused, the same line `edit_shape` holds on reviewed shapes. `undo_last` re-seats a lifted mark exactly where it was. |
| `create_rfi` | **Raise an RFI** (#364)—a Request For Information—when the drawing set contradicts itself: a schedule row the plan never draws, a room the schedule has no row for, a finish called out two ways. Lands in the canvas's RFI register with the **next number in the register's own sequence**, status open, dated today, on the sheet you name; `markup_ids` pins it to annotations already on the sheet (they carry the RFI number on the canvas and in the marked set). Raised **as the agent**: `origin {actor: "agent", reviewed: false}`—PENDING in the register until the estimator accepts it there, because an RFI goes to the architect and nothing sends without a human. Prints in the marked set's RFI schedule like any other RFI. Journaled; `undo_last` takes it back. |
| `list_rfis` | Every RFI with status, sheet, who raised it (`actor`) and whether an agent-raised one is still `pending`, its linked markup ids, and the finish tags those markups touch. `withdrawn[]` names the numbers `delete_rfi` tombstoned, so a gap in the sequence is explained. |
| `resolve_rfi` | Answer an **open** RFI: the answer lands as its response, status becomes `answered` (the register's own state), the response date stamps as the panel's would, plus an ISO `resolved_at`. Anything not open is refused—answered, closed, or void—rather than re-answered or revived. |
| `delete_rfi` | Withdraw an RFI. A **tombstone, never a renumber**: the number stays reserved, the register and the marked set keep printing a gap where it was, and the next RFI takes the next number. Linked markups keep their note and lose the link (the canvas's own delete rule). `undo_last` puts the record and its links back. |
| `read_sheet_text` | Positioned page text (image px), optionally restricted to a region—title blocks, room labels, finish schedules. |
| `find_text` | **Locate** a known string—the complement to `read_sheet_text` (which returns what a region *says*; this finds *where* a string sits). Case-insensitive substring match per pdf.js text run; each hit's center feeds straight into `one_click`'s seed. |
| `sheet_graph` | The plan-set INDEX (#87): every sheet's role with evidence, the schedule tables found, every room tag with its stacked name, the detail callouts, and every revision marker (text `Δ2`/`REV 2` tags AND drawn deltas—a bare digit inside a triangle of linework, proven from the sheet's vector geometry—in `revisions`)—how an agent decides WHAT to measure without a human enumerating rooms. |
| `resolve_tag` | ONE room tag → its room-finish schedule row → each code's finish/material definition, every edge cited (sheet + literal text + bbox). Refusal over guessing: `unresolved` comes back with a reason, never as silence. A delta/REV marker on the answering row rides the result as `revisions`—the codes are the post-revision answer, and you're told the ink changed. |
| `find_schedule` | Locate a schedule table by kind ("room finish", "material")—sheet, title, headers, row count, a `view_sheet`-ready region, and `revised_rows` when delta/REV-marked rows exist. |
| `sheet_context` | The region's STRUCTURE in one frame: classified vector segments (endpoints as drawn, meta byte per segment), text spans with bboxes, and hatch-family instances with content-derived ids—same pattern spec ⇒ same id anywhere on the sheet, so plan↔legend matching is `id === id`. Decimation is declared and counted on every reply: `kept + dropped === total_in_region`, cap applies longest-first so walls survive. |
| `get_sheet_vectors` | The STROKES (#367): the sheet's vector layer exactly as the engine is fed it—flat `[x1, y1, x2, y2, …]` points in image px, one meta byte per segment (curve / clip / fill-only / polyline-arc flags, pen width in the high nibble), per-segment stroke luminance, the drawn figure each segment belongs to, the placed-image area, and the PDF layer table with a per-segment layer index. Nothing classified, decimated, or merged—so a reader can run its own room finder, symbol matcher, or wall classifier against the same array and commit through the existing verbs. Paged (default 20,000 segments, ceiling 100,000) with `offset + returned + dropped === total` on every page; `next_cursor` recovers exactly what `dropped` counts. Read-only and stateless. Refuses on a scan and names `view_sheet` as the path. |
| `view_sheet` | The agent's eyes: render the sheet (or an image-px crop) to PNG. `overlay` burns committed shapes in (solid = human-affirmed, dashed = unreviewed) to verify geometry landed; `grid` burns in a calibrated 1-ft/5-ft measuring grid with foot labels (`"auto"` from the set scale, or the drawing scale like `"1/4"`) so dimensions are counted off cells, not guessed; `marks` (#297) burns disclosure layers in — `question` (withheld placements, orange ?-circle), `struck` (rejections, magenta struck ×), `ring` (the sweep's seed, violet double ring) — in colors off the common CAD pens, so what a reply names, the picture shows. |

### The agent revises its own work

`edit_shape` and `undo_last` exist because an agent that can only *append* has
one recovery move: delete and re-derive. The loop they enable instead—**commit
→ `view_sheet overlay:true` → see the ring overshot into the corridor
→ move those two vertices → look again**—is the loop a human estimator
already runs, and it is the difference between an agent that drafts and one
that works.

Two rules hold the surface honest:

- **Ink is not pencil.** A shape carrying `origin.reviewed === true` is work a
  human affirmed, and no agent verb touches it. This server has no review gate
  of its own, so the guard is inert here—it is the contract that makes the
  surface safe to port to a host that *does* have one. The approval family
  holds the same line at the mark itself: `mark_verdict` can mint only the
  AGENT diamond (there is no actor input to misuse), and `delete_verdict`
  refuses the estimator's APPROVED seal outright.
- **Self-revision is not correction.** `edit_shape` bumps `origin.agent_edits`
  and touches nothing in the human-correction vocabulary (`edited`, `edits`,
  `proposed_verts_norm`). Those fields mean *a human corrected the machine*;
  merging a machine's own fix into them would corrupt the one signal that
  measures whether the machine is getting better.

Every JSON tool declares an **`outputSchema`**, and every reply carries the
payload as **`structuredContent`**—typed, machine-validated on every call—alongside
the same compact JSON in a single text item for clients that predate
structured output. `view_sheet` is the one image tool: its reply is a PNG
content item plus a JSON meta text item (image replies aren't structured
output, so it declares no schema by design). Failures come back as
`isError: true` with `{"error": "..."}`—never a dropped connection.

## Resources — browse before you measure

Tools let an agent act; resources let it **see**. When a plan loads, the sheet
set becomes browsable natively (`resources/list` re-announces itself through
`list_changed`):

| URI | Contents |
|---|---|
| `takeoff://sheets` | The plan index—file, page count, every sheet's dims, title-block number, detected scale, scale state, shape count. Always listed; before any plan loads it says so and points at `load_plan`. |
| `takeoff://sheet/{page}` | One sheet's metadata (JSON), addressed by 1-based page number. |
| `takeoff://sheet/{page}/text` | The sheet's text, joined—title block, room labels, schedules. Positions live in the `read_sheet_text` tool. |
| `takeoff://sheet/{page}/image` | The page rendered to PNG, long edge capped at **1568 px**—the native resolution of vision-model eyes. Rendered lazily, cached until the next `load_plan`. |

Page numbers—not file-derived sheet keys—address resources, so URIs stay
clean regardless of the PDF's name; the human-facing key (`plan.pdf#2`) and
title-block number (`A-101`) ride along as the resource name and title.
Rendering uses `@napi-rs/canvas`, declared as this package's own optional
dependency so a plain `npx opentakeoff-mcp` installs the prebuilt binary and
arrives with eyes; on a platform without a prebuilt binary every non-raster
capability still works and the image read explains exactly what's missing.

The intended agent loop: read `takeoff://sheets` → look at
`takeoff://sheet/{page}/image` → pick click targets → measure with the tools.
An image coordinate maps to the tool space (image px at render scale 2.0) by
multiplying by `width_px / <image pixel width>`.

## The coordinate contract

All coordinates are **image pixels at render scale 2.0**: PDF points × 2,
origin **top-left**, y **down**. This is the browser canvas's native space, so
coordinates round-trip 1:1 with the app. Every sheet payload carries its dims
in both px and pt; text positions from `read_sheet_text` are in the same
space, which makes them usable directly as click targets.

## Scale rules

- A detected scale is a **suggestion**—it is never applied automatically.
  Adopting it is always an explicit `set_scale { use_detected: true }`.
- **Agent proposes, human confirms.** `set_scale` is the agent surface, so a
  scale set here lands **unconfirmed** (`confirmed: false` in the reply).
  Quantities still flow—the gate is a flag, never a refusal—but
  `takeoff_summary` names the affected sheets in
  `scale_unconfirmed`, and the export/report carry `scale_confirmed` so the
  canvas can ask the estimator to confirm (its scale menu grows a
  **Confirm agent-set scale** row on import). Only a human act in the canvas
  clears the flag.
- `measure_polygon` and `measure_line` refuse without a scale:
  `Set the scale for <sheet> first — use set_scale (detected: <label>).`
- `one_click` without a scale returns a **px-only preview**
  (`area_px2`, `perimeter_px`) with a warning, and commits nothing.
- `upp` is real feet per image px at render scale 2.0, per sheet—the same
  number the app stores as `units_per_px`.

## A whole takeoff, end to end

The bundled demo plan, as a copy-pasteable session (this is also the shape of
`test/e2e.test.ts`):

```
load_plan       { "path": "/absolute/path/to/opentakeoff/demo/sample-plan.pdf" }
                → sheet "sample-plan.pdf", 2448×1584 px, sheet_number "A-101",
                  detected_scale "1/4\" = 1'-0\""
read_sheet_text { "sheet": "sample-plan.pdf", "region": { "x0": 1468, "y0": 871, "x1": 2448, "y1": 1584 } }
                → the title block: A-101, SCALE: 1/4" = 1'-0"
set_scale       { "sheet": "sample-plan.pdf", "use_detected": true }
one_click       { "sheet": "sample-plan.pdf", "x": 600,  "y": 1084, "condition": "CPT-1" }   → ~438 SF
one_click       { "sheet": "sample-plan.pdf", "x": 1640, "y": 1084, "condition": "CPT-1" }   → ~438 SF
one_click       { "sheet": "sample-plan.pdf", "x": 600,  "y": 464,  "condition": "CPT-1" }   → ~438 SF
one_click       { "sheet": "sample-plan.pdf", "x": 1600, "y": 464,  "condition": "CPT-1" }   → ~438 SF
takeoff_summary {}                                        → CPT-1, 4 shapes, ~1752 SF
export_takeoff  { "path": "/tmp/takeoff.json" }           → the app's save payload
export_marked_pdf {}                                      → the marked-up planset PDF,
                                                            written next to the plan
```

A takeoff finishes with **both** exports: `export_marked_pdf` is what a human
reviews (construction takeoffs are no good without markup), `export_report` is
what pricing consumes.

### Writing to disk

`path` is not confined to a working directory, and deliberately so—the marked
set belongs in the job folder, wherever that is. What the export tools will not
do is destroy a file they didn't write:

- **Nothing at the path** → written.
- **A previous export of OpenTakeoff's own at the path** → overwritten silently. Fix a
  condition and export again to the same path as often as you like; that's the
  normal loop, and it needs no flag.
- **Any other existing file** → refused, with the path named. Pass
  `overwrite: true` to replace it anyway.
- **Corrupt, encrypted, or unreadable** → treated as *not* OpenTakeoff's, so refused. An
  unrecognizable file is exactly the kind worth not overwriting.

A marked set is recognized by its PDF `Producer`; the JSON exports by the
`schema` key they stamp. This is data-loss protection, not a sandbox—the
server runs as you, with your privileges. See [`SECURITY.md`](../SECURITY.md)
for the threat model.

Sheet keys follow the app's codec: page 1 is the bare file name
(`plan.pdf`), pages 2+ are `plan.pdf#2`. Tools also accept the title-block
sheet number (`A-101`) wherever a sheet is named.

## Limits (v1)

- **Scanned sheets flood, but don't index.** `one_click` and `detect_rooms`
  fall back to the sheet's rendered pixels where vectors can't bound the room
  (#154)—disclosed as `raster_traced`—but a scan with no text layer still
  has nothing for `detect_rooms`/`sheet_graph`/`resolve_tag` to read: seeds
  come from you (`view_sheet`, then `one_click`). The raster path needs the
  same optional `@napi-rs/canvas` as `view_sheet`.
- **Stitching is human-only—deliberately, not a gap.** The canvas can join
  2–4 sheets split at a match line into one composite surface (#200), but no
  MCP verb creates, aligns, or addresses a stitch. Joining the match line
  means clicking the same drawn wall junction on both halves—a judgment
  call with a worse blast radius than a bad scale, because a sloppy align
  silently skews every quantity that crosses the seam. That stays behind
  human eyes; it is not staged for later exposure. For a split floor: a
  human stitches and aligns in the canvas, and over MCP you work each member
  sheet as its own surface—a seam-crossing room belongs to the canvas.
  This server also doesn't read the app's additive `stitches` payload field,
  so a stitched takeoff round-tripped through `import_takeoff` →
  `export_takeoff` comes back without its stitches—when a stitch is in
  play, the app's own save is the one to keep.
- `load_plan` replaces the session by default; `merge: true` builds a multi-document working set (#152). Reloading a merged file is refused—reload = replace, deliberately.
- The takeoff lives in memory. `export_takeoff` (the app's exact save payload,
  nothing lost in translation) and `export_marked_pdf` (the reviewable marked
  planset) are the ways out.

## Tests

```bash
npm run typecheck
npm test        # session + tool-layer + e2e, against demo/sample-plan.pdf
```

## Releasing (maintainers)

MCP releases live in the **`mcp-v*`** tag namespace — bare `v*` tags belong to
the app (v0.2.0, v0.3.0 are app releases). Releases publish through **npm trusted
publishing**: the tag push fires `.github/workflows/publish-mcp.yml`, which
runs straight through—no approval click—and publishes the npm artifact
over OIDC with a **provenance attestation** (no npm token exists anywhere—the
npm package designates that exact repo + workflow as its trusted
publisher), followed by the MCP registry entry, the GitHub release, and the
MCPB bundle. The `release` environment's required-reviewer gate existed
briefly and was deliberately removed (2026-07-22)—the tag push is the one
human decision, and it's already admin-gated, so a second click added
friction without adding safety.

```bash
# 1. bump the version — all three fields together:
#    package.json .version, server.json .version, server.json .packages[0].version
# 2. tag and push — this fires the whole release, fully unattended:
git tag mcp-v<version> && git push origin mcp-v<version>
```

⚠️ Because there's no approval step, an accidental or mistyped `mcp-v*` tag
publishes to npm immediately, and npm unpublish is heavily restricted—double-check
the version before tagging.

The workflow checks version consistency, runs the full publish gate
(`prepublishOnly` = typecheck + tests + build), publishes to npm and the
official MCP registry, verifies the registry listing, and creates the GitHub
release (titled `opentakeoff-mcp <version>`). A re-run skips the npm publish
if that version already shipped, so a transient failure downstream is safe to
retry.

### Refreshing the Smithery listing

Smithery isn't part of the automated release above—it needs a **separate,
manual** publish after any tool signature change, because of a genuine spec
conflict between two validators: the official MCPB validator (what
`npm run mcpb` gates on) rejects a `tools[].inputSchema` key outright, while
Smithery's registry rejects a bundle *without* real `inputSchema` per tool
(smithery-ai/cli#770, #797, #787—no manifest satisfies both). The canonical
`dist-mcpb/opentakeoff-mcp.mcpb` stays spec-compliant for Claude Desktop / the
official registry / Glama; `scripts/build-smithery-mcpb.mjs` builds a
Smithery-only bundle instead, with live-introspected tools + inputSchema baked
in, packed with a plain zip (bypassing `mcpb validate`, which would reject it):

```bash
npm run build
node scripts/build-smithery-mcpb.mjs
smithery mcp publish dist-smithery/opentakeoff-mcp.mcpb -n Kentucky-ai/opentakeoff
```

## Calibration and review correctness (0.9.72)

`set_scale` recomputes existing dimensional quantities from geometry, including holes and cutout restore snapshots. Changing an existing calibration records one `undo_last` step that restores the scale, its confirmation/source, and the prior quantities together. Initial calibration of an unmeasured sheet adds no undo step. Counts retain their stored values. A sheet containing human-reviewed dimensional measurements refuses recalibration over MCP, consistent with the existing reviewed-shape edit rules; recalibrate it in the canvas and import the updated takeoff into a fresh session.

`import_takeoff` refuses new dimensional shapes when their source calibration differs from the session's calibration, or is missing while the session has one. The error names the sheet and scales; no session state changes. Align calibrations and re-export, or load a fresh session to adopt the export's calibration. Counts and duplicate IDs are exempt. An existing calibration is preserved even in an untraced session.

New agent measurements, including `measure_polygon` and `measure_line`, explicitly carry `origin.reviewed: false`. Legacy agent records without the flag are normalized on import and browser reload. Explicit prior human approval is preserved. No new review gate is introduced.
