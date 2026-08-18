# OpenTakeoff — The Agent Manual

The counterpart to the [user manual](USER_GUIDE.md). That one is written for the estimator at
the canvas; this one is written for the agent driving the same engine over
[MCP](https://modelcontextprotocol.io), and for the person wiring one up.

Everything an estimator does with a mouse, an agent does with a tool call, against identical
geometry: the server imports `web/src/lib/{oneclick,sheets,geometry,totals}` directly, so a room
you flood over stdio measures the same square footage as the same click on the canvas. There is
no second implementation to drift.

**Contents**

1. [Connect in 60 seconds](#1-connect-in-60-seconds)
2. [The operating model—six facts before your first call](#2-the-operating-model--six-facts-before-your-first-call)
3. [The standard finish—how a takeoff ends](#3-the-standard-finish--how-a-takeoff-ends)
4. [Withheld is not a failure—it is the answer](#4-withheld-is-not-a-failure--it-is-the-answer)
5. [What has no agent verb, and why](#5-what-has-no-agent-verb-and-why)
6. [Staged tool exposure](#6-staged-tool-exposure)
7. [A worked session](#7-a-worked-session)
8. [Refusals, and the move that answers each one](#8-refusals-and-the-move-that-answers-each-one)
9. [Where to look next](#9-where-to-look-next)

---

## 1. Connect in 60 seconds

Node 20+. No clone, no build:

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

Claude Code: `claude mcp add opentakeoff -- npx -y opentakeoff-mcp`. Claude Desktop: double-click
the `opentakeoff-mcp.mcpb` bundle from the
[latest release](https://github.com/Kentucky-ai/opentakeoff/releases). Docker, a local clone, and
the debugging trace flag are in [`mcp/README.md`](../mcp/README.md).

Confirm you're live by reading the `takeoff://sheets` resource before any plan loads—it answers
with what it is and points at `load_plan`, which is a cheaper handshake than a failed tool call.

## 2. The operating model — six facts before your first call

**One coordinate frame, stated everywhere.** Image pixels at render scale 2.0—PDF points × 2,
origin top-left, y down. That is the browser canvas's native space, so a coordinate round-trips
1:1 with the app. Every sheet payload carries dims in px *and* pt. Text positions from
`read_sheet_text` come back in the same space, which makes a room label directly usable as a
`one_click` seed. No tool takes a coordinate in units it has to infer.

**Scale is a gate, not a default.** The drawn scale note is read off the sheet and handed to you
as a suggestion; adopting it is always an explicit `set_scale { use_detected: true }`. Measuring
tools refuse an unscaled sheet, and a bare `one_click` returns px-only numbers with a warning
rather than fabricating square feet. Pixels × a wrong scale² is every number on the bid wrong at
once, which is why the engine would rather stop than guess.

**The scale you set is unconfirmed until a human confirms it.** `set_scale` returns
`confirmed: false`, `takeoff_summary` names those sheets in `scale_unconfirmed`, and the exports
carry `scale_confirmed` so the canvas can ask the estimator. Quantities still flow—the flag is
disclosure, not a second refusal—but say so when you hand the work over.

**The engine traces; you don't invent.** `one_click` returns the ring the flood fill produced
from the seed point you named. There is no tool that accepts a polygon you imagined and counts
it. `measure_polygon` exists for geometry you can defend, and everything it commits is stamped
with how it was made.

**Every commit carries provenance.** Method, normalized seed, whether hatch filtering engaged,
`raster_traced` when the boundary came from scan pixels instead of vector linework, and
`confidence` 0–1 with `confidence_factors` naming each deduction (`gap_sealed_px`, `door_wedges`,
`min_pass_delta`, …). Read confidence as a review prioritizer, never a verification: 1.0 means
every signal the engine can see came back clean, not that the trace is right. A low score is a
`view_sheet { overlay: true }` prompt.

**Your work is pencil until a person inks it.** Everything you commit lands in the canvas as a
dashed proposal. `mark_verdict` lets you sign work you checked as a graphite `AGENT` diamond; the
green `APPROVED` seal has exactly one code path and it is the toolbar button under a human hand.
`edit_shape` refuses a shape a human already affirmed, and self-revision bumps
`origin.agent_edits` rather than touching the human-correction fields—merging those would
corrupt the one signal that measures whether the machine is getting better.

## 3. The standard finish — how a takeoff ends

These five steps are served to every client in the `initialize` instructions, so they are the
contract rather than a suggestion. **A takeoff's deliverable is the marked-up planset, not a
numbers report.**

1. **Open and scale.** `load_plan`, then `set_scale` on each sheet you intend to measure. Use
   `load_plan { merge: true }` to add the schedule sheet and the addenda—a bid set is plans
   *plus* schedule *plus* addenda, and merging leaves existing scales, conditions, and shapes
   alone.
2. **Commit shapes under finish-tag conditions.** `one_click` / `detect_rooms` /
   `measure_polygon` / `measure_line` with `condition`. When the set carries a room-finish
   schedule, prefer `detect_rooms { assign_from_schedule: true }` so each room commits under its
   *own* row instead of one tag you picked for all of them.
3. **Derive what follows from the rooms.** `derive_base` for base LF (each room's perimeter minus
   the door openings *you state*—the tool never guesses a door), `derive_transitions` for the
   line where two finishes meet. Both read committed floor shapes, so they come after step 2, and
   you audit their output in step 4 like anything else.
4. **Look at what landed.** `view_sheet { overlay: true }` and fix misses with `edit_shape` before
   trusting a total. Crop the work region tight—a full-sheet render downsamples too far to
   audit a ring. Solid outlines are human-affirmed, dashed are unreviewed.
5. **Write the planset.** `export_marked_pdf`, and give the user the file path. `export_report`
   alongside it for the numbers. Never end a takeoff with numbers alone: a takeoff nobody can
   check is not a takeoff.

Between steps 3 and 4, `list_shapes` is the cheap inventory—ids, sheets, conditions,
quantities, room labels, review state, and where each finish tag came from (`schedule` or
`asserted`)—without pulling a whole `export_takeoff` payload.

## 4. Withheld is not a failure — it is the answer

Four tools measure things they then decline to commit, and say why. The arrays they hand back are
the most valuable output on the call, because each one is a question an estimator would have
asked.

| Tool | What it withholds | What it means | Your move |
|---|---|---|---|
| `detect_rooms` | rooms in `withheld` (degenerate, duplicate, implausible) and `unresolved[]` | the flood failed, or the schedule can't answer for that room | re-seed the coordinates it hands back, or state the condition yourself and say you did |
| `symbol_sweep` | matches scoring 0.75–0.92 | a near-match the fingerprint can't call | `view_sheet` the coordinates; commit the real ones by hand |
| `sweep_schedule_row` | `excluded` (labeled with a sibling key), `withheld` (unlabeled), `text_only` (a tag with no marker) | drafting reuses one bubble shape across many marks, so geometry alone would over-count | look at each; the exclusions are usually right and the unlabeled ones are usually yours |
| `derive_transitions` | wall-separated runs, in `withheld` with a length, a gap in inches, and an `at` point | the two rooms are adjacent across a partition, so the real transition is a threshold in a doorway that nothing in the trace record locates | measure the threshold at the door with `measure_line`, or hand the run to the estimator |

`withheld_lf` is never folded into `total_lf`. A withheld item you ignore is a hole in the bid;
one you never mention is worse. Report them in your summary even when you can't resolve them.

The reason `derive_transitions` behaves this way is worth carrying into every judgment you make
here: **flood-traced rooms do not share edges.** A trace fills to the wall linework, so two rooms
across a partition sit four to eight inches apart. Committing 34 LF of threshold because two
rooms share 34 LF of wall would be a wrong number with a machine's confidence behind it.

## 5. What has no agent verb, and why

- **Stitching.** The canvas joins 2–4 sheets split at a match line into one composite surface. No
  MCP verb creates, aligns, or addresses a stitch, and this is not staged for later exposure.
  Aligning a match line means clicking the same drawn wall junction on both halves—judgment
  whose failure mode is a subtly sloppy join that silently skews every quantity crossing the seam.
  On a split floor: measure each member sheet as its own surface, and tell the user a
  seam-crossing room needs their stitch in the app. Never approximate one by combining sheets
  yourself. (A stitched takeoff round-tripped through `import_takeoff` → `export_takeoff` comes
  back without its stitches; when a stitch is in play, the app's own save is the one to keep.)
- **The estimator's `APPROVED` seal.** `mark_verdict` takes no actor argument, so there is no
  input to misuse; `delete_verdict` refuses a human seal outright.
- **Confirming a scale.** Only a human act in the canvas clears `confirmed: false`.
- **Minting a correction rule.** `apply_rules` re-runs the rules an estimator taught the canvas,
  and rules arrive only through `import_takeoff`. A rule *is* an estimator's correction, so minting
  one stays behind the canvas's human Preview→Apply gate.
- **Touching human-affirmed work.** `edit_shape` refuses a shape carrying
  `origin.reviewed === true`.

## 6. Staged tool exposure

By default every client gets all 40 tool schemas on `tools/list`—the flat contract every
published client already expects.

Forty descriptions is real token weight for a session that may never touch half of them, so the
server can stage the surface along the workflow it already teaches:

```bash
OPENTAKEOFF_MCP_STAGED_TOOLS=1 npx -y opentakeoff-mcp
```

Staged, only the **setup** stage starts enabled—10 tools that orient you: `load_plan`,
`sheet_info`, `set_scale`, `sheet_graph`, `resolve_tag`, `find_schedule`, `read_sheet_text`,
`find_text`, `sheet_context`, `view_sheet`—plus one opener, `open_tool_stage`. Call it with
`"measure"`, `"revise"`, or `"handoff"` and that group's tools enable and fire
`tools/list_changed`. Opening is instant, idempotent, and never closes anything: the surface only
grows, and the reply names exactly which tools just appeared.

The stages are the same phase structure the instructions already describe in prose:

| Stage | Tools | Opened when |
|---|---|---|
| `setup` (always on) | load, scale, read the set, look at it | — |
| `measure` | `one_click`, `detect_rooms`, `measure_*`, `cut_out`, `place_count`, the sweeps, the derives | you're about to commit a shape |
| `revise` | `list_shapes`, `edit_*`, `duplicate_condition`, `split_condition`, `delete_shape`, `undo_last`, the annotation and verdict family | you're auditing or correcting |
| `handoff` | `takeoff_summary`, `export_*`, `import_takeoff`, `apply_rules` | you're finishing |

**When to turn it on:** your client honors `tools/list_changed` (Claude Code, Claude Desktop,
anything built against the current spec) *and* you care about the context cost of the tool list.
**When to leave it off:** a client that reads the tool list once at startup—there, a staged
server looks like a server with 11 tools that refuses everything else.

Staging is context economy, not a permission boundary. Nothing is safer when a stage is closed;
the safety lives in the refusals, the scale gate, and the pencil-vs-ink split, all of which hold
identically in both modes.

## 7. A worked session

*"Take off the carpet on this floor plan"*—tool calls verbatim, replies abridged.

```
▸ load_plan  { "path": "/plans/sample-plan.pdf" }
  { "sheets": [{ "sheet": "sample-plan.pdf", "width_px": 2448, "height_px": 1584,
                 "sheet_number": "A-101", "detected_scale": "1/4\" = 1'-0\"" }] }

▸ read_sheet_text  { "sheet": "sample-plan.pdf",
                     "region": { "x0": 1468, "y0": 871, "x1": 2448, "y1": 1584 } }
  { "text": "A-101 SCALE: 1/4\" = 1'-0\"" }

    The title block confirms the detected note. Adopt it explicitly — never silently.

▸ set_scale  { "sheet": "sample-plan.pdf", "use_detected": true }
  { "upp": 0.02778, "label": "1/4\" = 1'-0\"", "source": "detected", "confirmed": false }

▸ one_click  { "sheet": "sample-plan.pdf", "x": 600, "y": 1084, "condition": "CPT-1" }
  { "status": "ok", "area_sf": 437.98, "perimeter_lf": 86.61, "confidence": 1, "shape_id": "shp-…" }
  … three more rooms …

    Two of those are actually tile. Reassign, then derive instead of re-measuring:

▸ edit_shape  { "shape_id": "shp-…", "condition": "PT-1" }

▸ derive_transitions  { "condition_a": "CPT-1", "condition_b": "PT-1", "condition": "T-1" }
  { "committed": 2, "total_lf": 53.88, "withheld": [], "withheld_lf": 0 }

    Both runs came back butt joints — gap under an inch, one open space. Across a
    partition they would have landed in `withheld` instead, as questions.

▸ view_sheet  { "sheet": "sample-plan.pdf", "overlay": true,
                "region": { "x0": 500, "y0": 600, "x1": 1900, "y1": 1000 } }
  … PNG: committed shapes burned in, unreviewed machine work dashed …

▸ export_marked_pdf  {}
  { "path": "/plans/sample-plan - marked set.pdf", "sheets": 1 }

▸ export_report  { "path": "/plans/sample-report.json" }
  { "schema": "opentakeoff.report.v1", … }
```

Hand back both paths, the totals, anything `withheld`, and the fact that the scale is
agent-set and awaiting the estimator's confirmation.

## 8. Refusals, and the move that answers each one

Refusals are actionable strings by design—*"a silent zero doesn't tell a model what to do
next."*

| What you get | What it means | Next move |
|---|---|---|
| `Set the scale for <sheet> first — use set_scale (detected: 1/4" = 1'-0").` | the scale gate | adopt the detected note, or calibrate from a known dimension |
| *That space isn't enclosed on the plan linework — the fill spilled.* | a real gap: an open doorway, a break in the wall | seed a more enclosed spot, or `measure_polygon` it |
| *Landed in dense linework (hatching or text).* | the seed landed on a text block or heavy hatch | `view_sheet` a crop, pick open floor, re-seed |
| a ring not fully inside the parent (`cut_out`) | an edge-crossing cut is a boundary correction, not a hole | fix the parent with `edit_shape` instead |
| `measure_surface` refuses with no height | wall SF = traced LF × the condition's height | `edit_condition { height_ft }`, then retrace |
| an export refuses a path | OpenTakeoff didn't write that file, and overwriting it would destroy someone's work | pass `overwrite: true`, or pick another path |
| a `sweep_schedule_row` key that won't anchor | a fingerprint is never guessed from text alone | anchor it yourself: `find_text` the tag, `view_sheet` the marker, count by hand |

## 9. Where to look next

- [`mcp/README.md`](../mcp/README.md)—the tool-by-tool reference, the resource URIs, the
  coordinate contract, the write-to-disk rules, and the v1 limits. This is the list to trust.
- [`docs/MCP.md`](MCP.md)—the same surface in prose, ordered the way an agent reaches for it,
  with the sheet-graph and sweep behavior in depth.
- [`docs/USER_GUIDE.md`](USER_GUIDE.md)—the human half. Worth reading the parts you hand work
  to: proposals, the Accept pill, and how an estimator confirms your scale.
- [`docs/SHEET-GRAPH-EVAL.md`](SHEET-GRAPH-EVAL.md)—what the plan-set reader scores on real
  bid sets, and what it still cannot read.
- [**OpenTakeoff Academy**](https://aec.kentucky-ai.com)—an open benchmark for agents that do
  takeoff. Bring any model and your own harness; you're scored on operating a real tool against
  geometry you don't control.
