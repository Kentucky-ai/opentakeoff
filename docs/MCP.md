# Driving OpenTakeoff from an AI agent (MCP)

OpenTakeoff ships an [MCP](https://modelcontextprotocol.io) server —
[`mcp/`](../mcp/README.md) — that puts the real takeoff engine on stdio for
your MCP client. Not a wrapper around the UI: the server imports the same
`web/src/lib` modules the canvas runs, so One-Click Area, scale detection,
vertex snapping, and the totals math behave identically, and everything it
commits round-trips into the app as a normal saved takeoff.

## Setup

```bash
cd web && npm install        # the engine's pdf.js lives here
cd ../mcp && npm install
```

Register the server with your MCP client (any stdio client):

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

Never point a client config at `npm start` — npm's banner goes to stdout,
which is the MCP wire. `node --import tsx` is the whole invocation.

By default the server hands every client all forty tool schemas at once. Set
`OPENTAKEOFF_MCP_STAGED_TOOLS=1` in the server's environment to stage the
surface instead: only the setup tools start enabled, and the agent opens the
`measure` / `revise` / `handoff` groups on demand with `open_tool_stage` as
the takeoff reaches them — details in
[`mcp/README.md`](../mcp/README.md#staged-tool-exposure-opt-in). Needs a
client that honors `tools/list_changed`; leave it unset otherwise.

## What the agent gets

Forty tools, in the order an agent tends to reach for them:

- **Open and orient** — `load_plan`, `sheet_info` (including the sheet's PDF
  layer table — Optional Content Groups with a classified role, confidence,
  and default visibility per layer), `set_scale`, `sheet_context`
- **Load the set** — `load_plan` (default replaces; `merge: true` adds — plans +
  schedule + addenda as one working set, #152)
- **Navigate the set** — `sheet_graph` (the plan-set index: sheet roles with
  evidence, schedule tables found, every room tag with its name, detail
  callouts — how an agent decides *what* to measure without a human
  enumerating the rooms), `resolve_tag` (one room tag → its room-finish
  schedule row → each code's finish/material definition, every edge carrying
  a citation; unresolved comes back *with a reason*, never as silence),
  `find_schedule` (kind → sheet + title + headers + a `view_sheet`-ready
  region). Real-set shapes are handled natively (#87 phases 2–3): a
  schedule **continued across sheets** ("… SCHEDULE — CONT'D") reads as ONE
  table — rows resolve regardless of which sheet carries them, each citing
  the sheet the ink is on, and `find_schedule` returns one match whose
  `parts` list every fragment; **rotated column headers** (a quarter-turn
  header band) anchor the table and are flagged `rotated_headers`; and on a
  **multi-building set** the room key is (building, number), not the number
  alone — rooms and tables carry their building, an unqualified reused
  number refuses *listing the candidate rows per building* instead of
  first-matching, and a qualified tag (`"A-134"`) picks the building the
  set names; and **revision markers** — a delta triangle (`Δ2`) or `REV 2`
  tag beside a schedule row or a room bubble attaches there and rides
  `resolve_tag` as `revisions` (the codes returned are the post-revision
  answer, but the ink changed under that delta — view the marker and check
  the addendum before pricing), the set-wide list is `sheet_graph.revisions`,
  `find_schedule` counts `revised_rows` per table, and a marker never bands
  into a cell or mints a room key. A revision **cloud** with no text marker
  is linework — invisible to this text-layer pass, and stated as such rather
  than guessed at
- **Measure** — `one_click`, `detect_rooms` (both take `layers {include,
  exclude}` to override the sheet's stated layer roles for a call),
  `measure_polygon`, `measure_line`, `measure_surface` (wall SF: an open run
  × the condition's height — the H knob), `place_count` (EA markers, no scale
  required) — all five of the engine's measure roles — plus `symbol_sweep`
  (marquee ONE example of a repeated plan symbol — a drain, a threshold
  marker — and every placement is found deterministically from the vector
  linework, under rotation and mirroring, scored against a commit bar with
  near-misses *withheld with reasons*; `commit: true` places the matches as
  EA count markers in one undo step; `scope: "set"` sweeps the whole working
  set counting on plan-role sheets only, so the seed can be the assembly on a
  detail or legend sheet — the fingerprint source, itself never counted, its
  exclusion disclosed) and `sweep_schedule_row` (take a mark off from its
  schedule row: the row is read as the condition's cited source, the marker
  the tag is drawn as is fingerprinted at a drawn occurrence — corroborated
  at a second one where the set allows — and every plan sheet is swept, a
  match counting only where geometry AND the row's own tag text agree;
  markers labeled with a sibling key are excluded and say whose they are,
  unlabeled ones are withheld as questions, and a row whose tag cannot be
  geometrically anchored is *refused with the reason* — a fingerprint is
  never guessed from text alone). Scanned sheets work
  (#154): where vectors can't bound the room — an image-only scan, or a scan
  wrapper whose only linework is the title block — `one_click` and
  `detect_rooms` fall back automatically to flooding the sheet's rendered
  pixels with the same raster engine the canvas uses, disclosed as
  `raster_traced` on the reply and on the shape's origin; vector always wins
  where it works, and a raster ring's corners are unsnapped (a scan has no
  true endpoints)
- **Derive** — the quantities that follow from rooms already committed, instead
  of measuring them a second time. `derive_base` mints base LF per room
  (perimeter *minus the door openings you state* — your claim, recorded on
  `origin.derived`; the tool never guesses a door). `derive_transitions` mints
  the line where two finishes meet, and is built around a fact worth knowing
  before you call it: **flood-traced rooms do not share edges.** A trace fills
  to the wall linework, so two rooms across a partition sit four to eight inches
  apart and a shared-edge test finds nothing. What is there is proximity, in two
  kinds that are never conflated — a **butt joint** (rings running together
  inside one open space, within an inch) *is* the transition and commits; a
  **wall-separated** run means adjacent rooms whose transition is a threshold in
  a doorway, and nothing in the trace record locates a doorway (the flood engine
  reports how *much* boundary it sealed, never where). Those come back in
  `withheld` with their length, their gap in inches, and an `at` point to
  `view_sheet` — questions to answer by looking, and `withheld_lf` is never
  folded into `total_lf`. Both refuse all-or-nothing and land as one undo step.
  `apply_rules` re-runs the **correction rules** an estimator taught the canvas
  (#88) — "every room like this loses the mechanical chase" — which arrive with
  `import_takeoff` and are never minted over the wire (a rule *is* an
  estimator's correction; minting stays behind the canvas's human
  Preview→Apply gate). Evaluation is the same pure `rules.ts` engine the
  canvas Preview runs, the commit is the one batch its Apply makes
  (`reviewed: false`, one undo step), the per-rule disclosure in the reply is
  the preview an agent gets, and re-running is idempotent by construction —
  anything an existing deduct covers is dropped by the engine
- **Cut** — `cut_out` puts a real hole in a committed floor shape, the way the
  canvas's Eraser does (#137): the same `cutout.js` boolean subtract, so the
  parent's net is set subtraction (overlapping cuts never double-deduct) and a
  hole *adds* perimeter. The ring must sit fully inside the parent — an
  edge-crossing cut is a boundary correction and refuses (the canvas clips it;
  over the wire the rule is refusal-over-guessing). One undo step restores
  parent and hole together, and deleting the deduct later reverts the cut
  (multi-cut parents rebuild from the pristine snapshot minus survivors —
  the canvas's own delete semantics, ported as the spec)
- **Revise** — `edit_shape` (all five roles), `edit_materials`,
  `edit_condition` (waste %, ×N multiplier, `height_ft`, and the roll-goods
  `roll_setup` opt-in — the reply echoes the figured order), `delete_shape`,
  `undo_last`, with `list_shapes` as the mid-session inventory the mutating
  verbs assume you have
- **Condition twins** — `duplicate_condition` (the same finish measured
  somewhere else with its own preparation underneath: the twin arrives carrying
  the original's materials and keeps *following* them, so a coverage-rate fix on
  the original reaches every twin that hasn't touched that row) and
  `split_condition` (cut a twin loose — following rows freeze at their current
  values and the original stops reaching it). One finish in two areas is neither
  one condition nor two; both are reversible with `undo_last`
- **Read the sheet** — `read_sheet_text`, `find_text`, `view_sheet` (render a
  sheet or crop to PNG with an optional calibrated measuring grid and
  committed-shapes overlay — the agent's eyes and its self-check)
- **Annotate** — `annotate` (cloud, highlight, text, callout, arrow —
  plank/seam direction — keynote bubble, and dimension: two endpoints, drawn
  as a dimension line labelled with the measured length at the sheet's scale,
  refused on an unscaled sheet), `list_annotations`,
  `link_annotation` (notes *about* the work, never measurements of it;
  attaching one to a finish tag is what makes it part of that scope rather
  than a floating remark — it then wears the condition's colour on the canvas
  and in the marked set)
- **Sign** — `mark_verdict`, `delete_verdict` (the agent half of the approval
  family: the graphite AGENT diamond, the agent's pencil-signature on work it
  checked — anchored on a committed shape or dropped at a sheet point, listed
  in `list_annotations`' `verdicts[]`. The estimator's APPROVED ring is the
  other half and stays human-only: these tools take no actor input, so no
  agent path can mint or lift the human's ink. A verdict touches no quantity)
- **Report** — `takeoff_summary` (quantities only — materials stripped),
  `export_takeoff` (the raw `opentakeoff.takeoff_canvas.v1` canvas payload —
  materials as config rows, importable by the app), `export_report` (the
  computed `opentakeoff.report.v1` Report document — waste-adjusted nets, the
  materials buy list as order quantities, per-sheet subtotals, scale
  provenance; the contract for pricing consumers), `export_marked_pdf` (**the
  marked-up planset** — the plan sheets vector-copied with shapes, hatches,
  quantity chips, and annotations burned in, plus a legend cover; the
  deliverable a human reviews, with machine-traced work disclosed as pending
  review on the document itself)

  All three write wherever you point them — `path` is not confined to a working
  directory, because the marked set belongs in the job folder. They will not
  overwrite a file they didn't write, though: a previous export of ours is
  replaced silently (the ordinary re-export loop), and anything else is refused
  until you pass `overwrite: true`. Data-loss protection, not a sandbox — see
  [`SECURITY.md`](../SECURITY.md).

The full reference — including the coordinate contract (image px at render
scale 2.0, origin top-left) and the scale-gate rules — is in
[`mcp/README.md`](../mcp/README.md), which is the list to trust: this page is
prose and `mcp/src/tools.ts` is the source of truth for what actually
registers.

Two rules carry over from the app unchanged:

- **The scale gate.** No quantity leaves the server without a scale on that
  sheet — and a scale the agent sets is **unconfirmed until a human confirms
  it in the canvas** (`confirmed: false` on the reply,
  `scale_unconfirmed` on the summary, `scale_confirmed` on the
  export/report). A detected scale note is a suggestion the agent must adopt
  explicitly (`set_scale { use_detected: true }`); measuring tools refuse
  with the exact hint (`Set the scale for <sheet> first — use set_scale
  (detected: 1/4" = 1'-0").`), and a bare `one_click` returns px-only numbers
  with a warning rather than fabricating square feet.
- **Provenance.** Every shape committed by `one_click`/`detect_rooms` carries
  the same `origin` receipt the canvas mints: method, normalized seed,
  hatch-filter flag — and `raster_traced` when the boundary came from scan
  pixels rather than vector linework, so a pixel-bounded trace is
  distinguishable from a vector-snapped one in the record. The sealed engine's
  own account of each trace rides too, stamped centrally at the commit so no
  flood path can ship without it: `confidence` (0–1, with
  `confidence_factors` naming every deduction) scores the trace from the
  engine's internal signals — `gap_sealed_px` when part of the boundary is a
  synthetic seal across a real opening, `door_wedges`/`ring_interiors` for
  annexed door swings and closed-ring interiors, `min_pass_px`/
  `min_pass_delta` when the feet-true minimum-passage rule changed the
  answer, `gap_bridged_px` for the pinhole rescue. Read the score as a review
  prioritizer, never a verification: 1.0 means every signal the engine can
  see came back clean, not that the trace is right, and a low-confidence
  trace is a `view_sheet {overlay: true}` audit prompt, not a fact. The same
  fields appear on the tool replies, so an agent can triage before it
  commits.

And one capability deliberately does **not** carry over: **stitching**. The
canvas can join sheets split at a match line into one composite surface, but
there is no agent verb for it — aligning the match line means clicking the
same drawn wall junction on both halves, a human-judgment act whose failure
mode (a subtly sloppy join) silently skews every quantity that crosses the
seam. Same doctrine as the scale gate, taken one step further: here the agent
doesn't even propose. A human stitches and aligns in the canvas; an agent
works the member sheets individually and leaves seam-crossing rooms to the
person at the screen. See the Limits section of
[`mcp/README.md`](../mcp/README.md) for the round-trip caveat that follows.

## An example session

An agent asked to *"take off the carpet on this floor plan"* — tool calls
verbatim, replies abridged:

```
▸ load_plan  { "path": "/plans/sample-plan.pdf" }
  { "file": "sample-plan.pdf", "page_count": 1,
    "sheets": [{ "sheet": "sample-plan.pdf", "width_px": 2448, "height_px": 1584,
                 "width_pt": 1224, "height_pt": 792,
                 "sheet_number": "A-101", "detected_scale": "1/4\" = 1'-0\"" }] }

▸ read_sheet_text  { "sheet": "sample-plan.pdf",
                     "region": { "x0": 1468, "y0": 871, "x1": 2448, "y1": 1584 } }
  { "items": [ { "str": "A-101", "x": 1970, "y": 1284 },
               { "str": "SCALE: 1/4\" = 1'-0\"", "x": 1730, "y": 1348 } ],
    "text": "A-101 SCALE: 1/4\" = 1'-0\"" }

    The title block confirms the detected scale — adopt it explicitly:

▸ set_scale  { "sheet": "sample-plan.pdf", "use_detected": true }
  { "sheet": "sample-plan.pdf", "upp": 0.02778, "label": "1/4\" = 1'-0\"", "source": "detected" }

    Room labels from the page text double as click targets (same px space):

▸ one_click  { "sheet": "sample-plan.pdf", "x": 600, "y": 1084, "condition": "CPT-1" }
  { "status": "ok", "area_sf": 437.98, "perimeter_lf": 86.61, "nverts": 4, "shape_id": "shp-…" }

▸ one_click  { "sheet": "sample-plan.pdf", "x": 1640, "y": 1084, "condition": "CPT-1" }
▸ one_click  { "sheet": "sample-plan.pdf", "x": 600,  "y": 464,  "condition": "CPT-1" }
▸ one_click  { "sheet": "sample-plan.pdf", "x": 1600, "y": 464,  "condition": "CPT-1" }
  … three more rooms, ~438 SF each …

    Two of those rooms are actually tile — reassign, then let the derivations
    do the work that follows from the rooms instead of measuring it again:

▸ edit_shape  { "shape_id": "shp-…", "condition": "PT-1" }     … and one more

▸ derive_transitions  { "condition_a": "CPT-1", "condition_b": "PT-1", "condition": "T-1" }
  { "between": ["CPT-1", "PT-1"], "committed": 2, "total_lf": 53.88,
    "runs": [{ "length_lf": 26.94, "gap_in": 0.3, "at": [725, 784], … },
             { "length_lf": 26.94, "gap_in": 0.3, "at": [1715, 784], … }],
    "withheld": [], "withheld_lf": 0 }

    Both runs are butt joints (gap under an inch — one open space). Had the
    rooms been a partition apart, they would have come back in `withheld`
    instead: adjacency across a wall is a threshold in a doorway this cannot
    locate, so it is handed back as a question with a point to look at.

▸ takeoff_summary  {}
  { "conditions": [{ "finish_tag": "CPT-1", "shape_count": 2, … },
                   { "finish_tag": "PT-1",  "shape_count": 2, … },
                   { "finish_tag": "T-1",   "shape_count": 2, "lf": 53.88, … }],
    "totals": { … } }

    Look before trusting any of it, then finish with the deliverable:

▸ view_sheet  { "sheet": "sample-plan.pdf", "overlay": true,
                "region": { "x0": 500, "y0": 600, "x1": 1900, "y1": 1000 } }
  … PNG: committed shapes burned in, unreviewed machine work dashed …

▸ export_marked_pdf  {}
  { "path": "/plans/sample-plan - marked set.pdf", "sheets": 1, … }

▸ export_report  { "path": "/plans/sample-report.json" }
  { "schema": "opentakeoff.report.v1", "conditions": [...], … }
```

A click that misses is a readable answer, not a stack trace — outside the
building: `That space isn't enclosed on the plan linework — the fill spilled
through a gap or opening.`; in dense hatching or a text block: `Landed in
dense linework (hatching or text).`

## Where this sits

- The **MCP server** is the agent-integration surface: real tools, real
  quantities, stdio.
- The **[AI sandbox](../server/README.md)** (`server/`) is the other socket —
  a FastAPI adapter interface for plugging your own local *vision model* under
  the canvas's suggestion endpoints.
- Scanned (raster-only) sheets **are** supported (#154): where vectors cannot
  bound a room, `one_click` and `detect_rooms` fall back automatically to
  flooding the sheet's rendered pixels with the same raster engine the canvas
  uses, disclosed as `raster_traced` on the reply and on the shape's origin.
  Vector wins wherever it works — a raster ring's corners are unsnapped,
  because a scan has no true endpoints to snap to.
