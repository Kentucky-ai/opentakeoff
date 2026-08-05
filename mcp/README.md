# OpenTakeoff MCP server

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.Kentucky-ai/opentakeoff`, on [Glama](https://glama.ai/mcp/servers/Kentucky-ai/opentakeoff),
and on [Smithery](https://smithery.ai/servers/Kentucky-ai/opentakeoff).

## Run it in 60 seconds (npx)

No clone, no build — point your MCP client at the published package:

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
double-click it — Claude Desktop installs the server with its dependencies
bundled. Built by `npm run mcpb` and attached automatically to every `mcp-v*`
release. The bundle is platform-neutral on purpose: it excludes the optional
native canvas, so every JSON tool and the text/metadata resources work
everywhere; the sheet-image resource and the `view_sheet` tool say exactly
what's missing where rendering isn't available.


The takeoff engine — One-Click Area, the scale model, conditions, totals — on
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

Point `command` at `node` directly, as above — **never `npm start` in a client
config**: npm prints its banner to stdout, and stdout is the MCP wire. (Same
reason the server redirects `console.log` to stderr before pdf.js loads —
see `src/hush.ts`.)

`tsx` is a runtime dependency, not a build tool: the engine is imported
straight from `web/src/lib` as TypeScript, so plain `node` can't run it.

For tool-call debugging, opt into structured stderr tracing:

```bash
OPENTAKEOFF_MCP_TRACE=1 node --import tsx server.ts
```

Each tool call writes one JSON line to stderr with the tool name, duration,
sheet, result size, and error flag. The trace never writes to stdout and never
includes document text, shape vertices, or result payload content.

## Tools

| Tool | What it does |
|---|---|
| `load_plan` | Open a plan PDF from disk. Default replaces the whole session; **`merge: true` ADDS the document to the working set** (#152) — plans + schedule + addenda as one takeoff, sheet graph spanning the whole set, marked set covering every worked sheet. Returns per-sheet dims, title-block `sheet_number`, and the detected drawn scale where present. |
| `sheet_info` | One sheet's dims, vector segment count, scale status, detected suggestion, committed shape count. |
| `set_scale` | Set a sheet's scale — exactly one of `label`, `upp`, `calibrate {p1, p2, feet}`, `use_detected`. |
| `one_click` | One-Click Area at (x, y): the sealed flood engine bounded by the plan linework, traced, vertices snapped — the SAME feet-true arguments the canvas passes at a click (gap sealing up to a door width, door-swing wedge inclusion, the half-foot minimum-passage rule), so an MCP trace and a canvas click at one seed measure the same square footage (pinned against the bench corpus goldens in `test/parity.test.ts`). Every trace carries the engine's account of itself: `confidence` 0–1 with `confidence_factors` naming each deduction (`gap_sealed_px`, `door_wedges`, `min_pass_delta`, …) — a review prioritizer, never a verification; a low score is a `view_sheet {overlay: true}` audit prompt, not a fact. On a SCANNED sheet (no usable linework) the flood falls back automatically to the rendered pixels — same engine as the canvas — with `raster_traced` disclosed on the reply and on the shape's origin (#154). Pass `condition` to commit (the full account stamps `origin` centrally at the commit); `role: "deduct"` subtracts. |
| `detect_rooms` | Batch One-Click: reads every room-number label off the sheet's text layer and floods each — one call instead of `read_sheet_text` + reasoning + N `one_click` calls, through the SAME sealed engine per room (confidence + the engine account ride each room and its committed origin). Only cleanly-traced rooms come back; everything skipped is counted and reasoned in `withheld` (degenerate / duplicate / implausible / unresolved), never dropped silently. To commit: `assign_from_schedule: true` routes each room through its OWN room-finish schedule row and commits under the FLOOR finish that row states (rooms the schedule can't answer for return in `unresolved[]` with reasons and re-seedable coordinates); or pass `condition` to commit every room under one stated tag. |
| `measure_polygon` | Area + perimeter of a polygon you supply (min 3 verts). Requires scale. |
| `measure_line` | Length of an open polyline (min 2 points). Requires scale. |
| `derive_base` | **Base LF from committed rooms**: for every floor shape of a source condition, commits a linear base run tracing that room's boundary, quantified net of the door openings YOU state per room (`{shape_id, lf}` — your claim, recorded on `origin.derived`; the tool never guesses). All-or-nothing; one undo step. |
| `derive_transitions` | **The transition where two finishes meet**: pass two finish tags and the tag to commit under, and every committed room of each is compared against every room of the other. The catch this is built around — flood-traced rooms **do not share edges**, a partition puts 4–8″ between them — so proximity comes in two flavours and they are never conflated. A **butt joint** (rings running together inside one open space, within an inch) *is* the transition and commits as a linear shape, `origin.derived` naming both parents, the tags, and the measured gap. A **wall-separated** run means the rooms are adjacent across a partition, where the transition is a threshold in a doorway that nothing in the trace record locates (the flood engine reports how *much* boundary it sealed, never where) — those return in `withheld` with length, gap in inches, and an `at` point to `view_sheet`, as questions rather than a confident wrong number. `max_gap_in` (default 12) only ever turns more of the plan into questions, never into committed LF. All-or-nothing; one undo step. |
| `measure_surface` | **Wall SF**: an open run traced along the wall, quantified as traced LF × the condition's height (the canvas's H knob — pass `height_ft` to set it, or set it once with `edit_condition`). Wall tile, wainscot, wall systems. Refuses without a height, minting nothing. |
| `place_count` | **EA markers**: one point, one each — thresholds, stair nosings, floor boxes. No scale required (EA is scale-free). One shape per point; the whole call is one undo step. |
| `symbol_sweep` | **Every instance of a repeated plan symbol, from ONE example**: marquee a tight `seed_rect` around a single drain/threshold/fixture symbol and the vector linework is searched deterministically for every other placement — translation plus 0/90/180/270 rotation and mirroring (both on by default). Score = length-weighted fraction of the seed's segments matched within `tolerance_px`; ≥ 0.92 is a match, the 0.75–0.92 band returns in `withheld` with reasons (never committed, never dropped silently), and the work cap is disclosed when it bites. **`scope: "set"` sweeps the whole working set, counting on PLAN-role sheets only** (the sheet graph decides; every excluded sheet disclosed in `skipped` with role and reason) — and the seed rect may sit on a detail or legend sheet, which then serves as the fingerprint SOURCE while staying excluded from counting: the estimator's "click the assembly in the detail, count it on the plans" gesture. Per-sheet results carry their own match/withheld lists, per-sheet cap accounting, and wall-clock `elapsed_ms`. `commit: true` + `condition` commits every match center as an EA count marker — the whole sweep (set-wide included) is one undo step, `origin.method "symbol_sweep"` with per-marker score, transform, and seed source (`origin.symbol.seed`). No scale required. |
| `sweep_schedule_row` | **Take off a schedule row's mark from the row itself**: pass the row's key (e.g. `T1`) and the tool reads the row from the set's schedule tables (the row is the condition's cited source), anchors a fingerprint on the marker the tag is DRAWN as on a plan sheet (a deterministic pad ladder around the tag text; where the tag occurs more than once the fingerprint must recur at a second occurrence — `anchor.corroborated` — before it is trusted), and sweeps every plan-role sheet. **The count is geometry AND text agreeing**: drafting reuses one bubble shape across many marks, so a match counts only when the row's own tag sits within the marker footprint (its bbox rides the match as `tag_at` evidence); a match labeled with a sibling key is `excluded` and says whose it is, an unlabeled match is `withheld` as a question, a tag drawn with no matching marker is `text_only`. Refusal over guessing, each with the reason and the fix: no such row, an ambiguous key, a tag drawn on no plan sheet, no repeatable marker linework — a fingerprint is never guessed from text alone. `commit: true` commits the counted matches under the row's own key — one undo step, `origin.assignment {source: "schedule"}` plus the anchor and row citation on `origin.symbol.seed`. No scale required. |
| `takeoff_summary` | Per-condition totals + grand totals, computed by the Report's rules. |
| `export_takeoff` | The full `opentakeoff.takeoff_canvas.v1` payload — exactly what the app autosaves. Inline, and to disk with `path` (see **Writing to disk** below). |
| `delete_shape` | Remove a committed shape by id. |
| `edit_shape` | **Revise** a committed shape instead of redoing it: new `verts`, a different `condition`, a different `role`, a `label` (the room it belongs to — what per-room reporting groups by; `""` clears it), or any combination — quantities recomputed from the result. Refuses shapes a human affirmed. |
| `edit_materials` | Add/remove/patch supporting-materials rows on a condition — the coverage-rate lines (adhesive at N sf/gal, grout at N lf/bag, …) that turn a measured quantity into an order quantity, matching the canvas's Supporting Materials panel. `basis` is `area` \| `linear` \| `count` \| **`seam_lf`** — the last is the *figured* roll-layout seam length a weld rod or seam tape is bought by (set `roll_setup` on the condition first; without one it reads 0, because nothing has decided how that floor gets cut). `condition` mints on first touch, like `one_click`/`measure_polygon`. No review gate (materials rows are quantity config, not traced geometry) — edits directly, reversible with `undo_last`. |
| `edit_condition` | Set a condition's **waste %**, **×N multiplier**, **height_ft** (the H knob `measure_surface` quantifies against), and **roll_setup** (the roll-goods opt-in: seams figured, cuts packed, the reply echoes the order — cuts, `order_lf`, rolls, `order_qty` — and `export_report`'s `roll_goods` block carries the same rows; `null` opts out) — the knobs that turn measured quantities into order quantities. Resolves an **existing** finish tag or errors — a typo must not mint an empty condition. No review gate; one `undo_last` step restores the knobs verbatim. |
| `export_report` | The **computed Report document** — `opentakeoff.report.v1`, the same JSON the canvas Report exports: gross + waste-adjusted quantities, the computed materials **buy list** per condition plus the project-wide roll-up, per-sheet base subtotals, and scale provenance. The contract for pricing consumers — `export_takeoff` carries materials as config rows, `takeoff_summary` strips them. Inline, and to disk with `path` (see **Writing to disk** below). |
| `import_takeoff` | **The way back in**: load a `takeoff_canvas.v1` file (a prior `export_takeoff`, or the app's own save) through the SAME merge rules as the app's Sheet-menu import — finish-tag identity joins conditions (this session's knobs win), new ids append, duplicates skip (idempotent re-import), this session's calibration wins per sheet. Resume, extend, or audit. |
| `export_marked_pdf` | The **marked-up planset** — the deliverable. Writes a distribution-ready PDF: a legend cover (per-condition totals, swatches, by-sheet breakdown) plus every sheet that carries work, vector-copied from the source with shapes, hatches, per-shape quantity chips, and annotations burned in — built by the same module as the canvas's MARKED SET button. Machine-traced shapes are disclosed as pending human review on the document itself, and the cover states where the finish tags came from (`Finish assignment: N schedule-resolved · N agent-asserted · …`, plus any rooms the last assign run withheld). Default path: `<plan> - marked set.pdf` next to the plan (see **Writing to disk** below). Works without `@napi-rs/canvas`. |
| `list_shapes` | The **mid-session inventory**: every committed shape's id, sheet, condition, role, quantities, room `label`, review state, and assignment verdict (`schedule` \| `asserted` — where its finish tag came from) in one compact read — the ids `edit_shape`/`delete_shape` assume you have, without pulling the whole `export_takeoff` payload. Filters by sheet/condition narrow; empty is a result, not an error. |
| `undo_last` | Step back over your own last `n` mutations, newest first. Exact inverses: a commit is removed, an edit restored verbatim, a delete re-inserted where it was, a materials edit's whole array restored, a condition edit's waste/multiplier pair restored. A whole `detect_rooms` sweep is **one** step. |
| `annotate` | Place a note ABOUT the work — cloud/highlight (`rect`), text (`at`), callout (`at` + `target`), **arrow** (`from` + `to` — plank/seam direction), **bubble** (`at` + optional `r` — keynote circle, centered text), **dimension** (`from` + `to` — a dimension line with end ticks, labelled with the measured length at the sheet's scale; the one annotation the scale gate applies to — an unscaled sheet refuses like the measure tools). Attach to a condition and it wears that scope's colour on the canvas and in the marked set. No review gate: notes are not geometry. |
| `list_annotations` | Every annotation with its condition RESOLVED to a finish tag, coordinates back in image px; filter by sheet/condition. `unattached` counts the link_annotation candidates. `verdicts[]` is the approval family's inventory — every mark with its actor stated, a condition filter reaching a verdict through its target shape. |
| `link_annotation` | Attach an existing annotation to a condition (or detach with an empty tag) — the canvas's Attach/Detach control, reachable by an agent. |
| `mark_verdict` | The **agent's pencil-signature** on work it checked — the agent half of the approval family (#176). Mints the graphite AGENT diamond, and structurally nothing else: the tool takes no actor input, so the estimator's APPROVED ring stays behind the canvas's human-only Approve tool. Target a committed `shape_id` (anchored on the shape — a room's centroid, a run's midpoint — with the id recorded as provenance) or a `sheet` + `at` point; optional short `text` rides the record. Touches no quantity; renders on the canvas and in the marked set, whose cover tallies the split (`Approval stamps: N estimator-approved · M agent-marked`); rides the annotations payload through `export_takeoff`/`import_takeoff` and the app's own saves. One mark per shape. |
| `delete_verdict` | Lift an agent verdict mark by id. Agent marks only — the estimator's seal is human ink and is refused, the same line `edit_shape` holds on reviewed shapes. `undo_last` re-seats a lifted mark exactly where it was. |
| `read_sheet_text` | Positioned page text (image px), optionally restricted to a region — title blocks, room labels, finish schedules. |
| `find_text` | **Locate** a known string — the complement to `read_sheet_text` (which returns what a region *says*; this finds *where* a string sits). Case-insensitive substring match per pdf.js text run; each hit's center feeds straight into `one_click`'s seed. |
| `sheet_graph` | The plan-set INDEX (#87): every sheet's role with evidence, the schedule tables found, every room tag with its stacked name, the detail callouts — how an agent decides WHAT to measure without a human enumerating rooms. |
| `resolve_tag` | ONE room tag → its room-finish schedule row → each code's finish/material definition, every edge cited (sheet + literal text + bbox). Refusal over guessing: `unresolved` comes back with a reason, never as silence. |
| `find_schedule` | Locate a schedule table by kind ("room finish", "material") — sheet, title, headers, row count, and a `view_sheet`-ready region. |
| `sheet_context` | The region's STRUCTURE in one frame: classified vector segments (endpoints as drawn, meta byte per segment), text spans with bboxes, and hatch-family instances with content-derived ids — same pattern spec ⇒ same id anywhere on the sheet, so plan↔legend matching is `id === id`. Decimation is declared and counted on every reply: `kept + dropped === total_in_region`, cap applies longest-first so walls survive. |
| `view_sheet` | The agent's eyes: render the sheet (or an image-px crop) to PNG. `overlay` burns committed shapes in (solid = human-affirmed, dashed = unreviewed) to verify geometry landed; `grid` burns in a calibrated 1-ft/5-ft measuring grid with foot labels (`"auto"` from the set scale, or the drawing scale like `"1/4"`) so dimensions are counted off cells, not guessed. |

### The agent revises its own work

`edit_shape` and `undo_last` exist because an agent that can only *append* has
one recovery move: delete and re-derive. The loop they enable instead —
**commit → `view_sheet overlay:true` → see the ring overshot into the corridor
→ move those two vertices → look again** — is the loop a human estimator
already runs, and it is the difference between an agent that drafts and one
that works.

Two rules hold the surface honest:

- **Ink is not pencil.** A shape carrying `origin.reviewed === true` is work a
  human affirmed, and no agent verb touches it. This server has no review gate
  of its own, so the guard is inert here — it is the contract that makes the
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
payload as **`structuredContent`** — typed, machine-validated on every call —
alongside the same compact JSON in a single text item for clients that predate
structured output. `view_sheet` is the one image tool: its reply is a PNG
content item plus a JSON meta text item (image replies aren't structured
output, so it declares no schema by design). Failures come back as
`isError: true` with `{"error": "..."}` — never a dropped connection.

## Resources — browse before you measure

Tools let an agent act; resources let it **see**. When a plan loads, the sheet
set becomes browsable natively (`resources/list` re-announces itself via
`list_changed`):

| URI | Contents |
|---|---|
| `takeoff://sheets` | The plan index — file, page count, every sheet's dims, title-block number, detected scale, scale state, shape count. Always listed; before any plan loads it says so and points at `load_plan`. |
| `takeoff://sheet/{page}` | One sheet's metadata (JSON), addressed by 1-based page number. |
| `takeoff://sheet/{page}/text` | The sheet's text, joined — title block, room labels, schedules. Positions live in the `read_sheet_text` tool. |
| `takeoff://sheet/{page}/image` | The page rendered to PNG, long edge capped at **1568 px** — the native resolution of vision-model eyes. Rendered lazily, cached until the next `load_plan`. |

Page numbers — not file-derived sheet keys — address resources, so URIs stay
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

- A detected scale is a **suggestion** — it is never applied automatically.
  Adopting it is always an explicit `set_scale { use_detected: true }`.
- `measure_polygon` and `measure_line` refuse without a scale:
  `Set the scale for <sheet> first — use set_scale (detected: <label>).`
- `one_click` without a scale returns a **px-only preview**
  (`area_px2`, `perimeter_px`) with a warning, and commits nothing.
- `upp` is real feet per image px at render scale 2.0, per sheet — the same
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

`path` is not confined to a working directory, and deliberately so — the marked
set belongs in the job folder, wherever that is. What the export tools will not
do is destroy a file they didn't write:

- **Nothing at the path** → written.
- **A previous export of ours at the path** → overwritten silently. Fix a
  condition and export again to the same path as often as you like; that's the
  normal loop, and it needs no flag.
- **Any other existing file** → refused, with the path named. Pass
  `overwrite: true` to replace it anyway.
- **Corrupt, encrypted, or unreadable** → treated as *not* ours, so refused. An
  unrecognizable file is exactly the kind worth not overwriting.

A marked set is recognized by its PDF `Producer`; the JSON exports by the
`schema` key they stamp. This is data-loss protection, not a sandbox — the
server runs as you, with your privileges. See [`SECURITY.md`](../SECURITY.md)
for the threat model.

Sheet keys follow the app's codec: page 1 is the bare file name
(`plan.pdf`), pages 2+ are `plan.pdf#2`. Tools also accept the title-block
sheet number (`A-101`) wherever a sheet is named.

## Limits (v1)

- **Scanned sheets flood, but don't index.** `one_click` and `detect_rooms`
  fall back to the sheet's rendered pixels where vectors can't bound the room
  (#154) — disclosed as `raster_traced` — but a scan with no text layer still
  has nothing for `detect_rooms`/`sheet_graph`/`resolve_tag` to read: seeds
  come from you (`view_sheet`, then `one_click`). The raster path needs the
  same optional `@napi-rs/canvas` as `view_sheet`.
- `load_plan` replaces the session by default; `merge: true` builds a multi-document working set (#152). Reloading a merged file is refused — reload = replace, deliberately.
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
the app (v0.2.0, v0.3.0 are app releases). Releases publish via **npm trusted
publishing**: the tag push fires `.github/workflows/publish-mcp.yml`, which
runs straight through — no approval click — and publishes the npm artifact
over OIDC with a **provenance attestation** (no npm token exists anywhere —
the npm package designates that exact repo + workflow as its trusted
publisher), followed by the MCP registry entry, the GitHub release, and the
MCPB bundle. The `release` environment's required-reviewer gate existed
briefly and was deliberately removed (2026-07-22) — the tag push is the one
human decision, and it's already admin-gated, so a second click added
friction without adding safety.

```bash
# 1. bump the version — all three fields together:
#    package.json .version, server.json .version, server.json .packages[0].version
# 2. tag and push — this fires the whole release, fully unattended:
git tag mcp-v<version> && git push origin mcp-v<version>
```

⚠️ Because there's no approval step, an accidental or mistyped `mcp-v*` tag
publishes to npm immediately, and npm unpublish is heavily restricted —
double-check the version before tagging.

The workflow checks version consistency, runs the full publish gate
(`prepublishOnly` = typecheck + tests + build), publishes to npm and the
official MCP registry, verifies the registry listing, and creates the GitHub
release (titled `opentakeoff-mcp <version>`). A re-run skips the npm publish
if that version already shipped, so a transient failure downstream is safe to
retry.

### Refreshing the Smithery listing

Smithery isn't part of the automated release above — it needs a **separate,
manual** publish after any tool signature change, because of a genuine spec
conflict between two validators: the official MCPB validator (what
`npm run mcpb` gates on) rejects a `tools[].inputSchema` key outright, while
Smithery's registry rejects a bundle *without* real `inputSchema` per tool
(smithery-ai/cli#770, #797, #787 — no manifest satisfies both). The canonical
`dist-mcpb/opentakeoff-mcp.mcpb` stays spec-compliant for Claude Desktop / the
official registry / Glama; `scripts/build-smithery-mcpb.mjs` builds a
Smithery-only bundle instead, with live-introspected tools + inputSchema baked
in, packed with a plain zip (bypassing `mcpb validate`, which would reject it):

```bash
npm run build
node scripts/build-smithery-mcpb.mjs
smithery mcp publish dist-smithery/opentakeoff-mcp.mcpb -n Kentucky-ai/opentakeoff
```
