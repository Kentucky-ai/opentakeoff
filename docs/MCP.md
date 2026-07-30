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

## What the agent gets

Twenty-five tools, in the order an agent tends to reach for them:

- **Open and orient** — `load_plan`, `sheet_info` (including the sheet's PDF
  layer table — Optional Content Groups with a classified role, confidence,
  and default visibility per layer), `set_scale`, `sheet_context`
- **Navigate the set** — `sheet_graph` (the plan-set index: sheet roles with
  evidence, schedule tables found, every room tag with its name, detail
  callouts — how an agent decides *what* to measure without a human
  enumerating the rooms), `resolve_tag` (one room tag → its room-finish
  schedule row → each code's finish/material definition, every edge carrying
  a citation; unresolved comes back *with a reason*, never as silence),
  `find_schedule` (kind → sheet + title + headers + a `view_sheet`-ready
  region)
- **Measure** — `one_click`, `detect_rooms` (both take `layers {include,
  exclude}` to override the sheet's stated layer roles for a call),
  `measure_polygon`, `measure_line`
- **Revise** — `edit_shape`, `edit_materials`, `edit_condition` (waste % and
  ×N multiplier — the knobs that turn measured quantities into order
  quantities; without them a takeoff always ships net === gross), `delete_shape`,
  `undo_last`
- **Read the sheet** — `read_sheet_text`, `find_text`, `view_sheet` (render a
  sheet or crop to PNG with an optional calibrated measuring grid and
  committed-shapes overlay — the agent's eyes and its self-check)
- **Annotate** — `annotate`, `list_annotations`, `link_annotation` (notes
  *about* the work, never measurements of it; attaching one to a finish tag is
  what makes it part of that scope rather than a floating remark — it then
  wears the condition's colour on the canvas and in the marked set)
- **Report** — `takeoff_summary` (quantities only — materials stripped),
  `export_takeoff` (the raw `opentakeoff.takeoff_canvas.v1` canvas payload —
  materials as config rows, importable by the app), `export_report` (the
  computed `opentakeoff.report.v1` Report document — waste-adjusted nets, the
  materials buy list as order quantities, per-sheet subtotals, scale
  provenance; the contract for pricing consumers)

The full reference — including the coordinate contract (image px at render
scale 2.0, origin top-left) and the scale-gate rules — is in
[`mcp/README.md`](../mcp/README.md), which is the list to trust: this page is
prose and `mcp/src/tools.ts` is the source of truth for what actually
registers.

Two rules carry over from the app unchanged:

- **The scale gate.** No quantity leaves the server without a scale on that
  sheet. A detected scale note is a suggestion the agent must adopt
  explicitly (`set_scale { use_detected: true }`); measuring tools refuse
  with the exact hint (`Set the scale for <sheet> first — use set_scale
  (detected: 1/4" = 1'-0").`), and a bare `one_click` returns px-only numbers
  with a warning rather than fabricating square feet.
- **Provenance.** Every shape committed by `one_click` carries the same
  `origin` receipt the canvas mints: method, normalized seed, hatch-filter
  flag.

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

▸ takeoff_summary  {}
  { "conditions": [{ "finish_tag": "CPT-1", "shape_count": 4, "floor_sf": 1751.92,
                     "total_sf": 1751.92, "sy_net": 194.66, … }],
    "totals": { "total_sf": 1751.92, … } }

▸ export_takeoff  { "path": "/plans/sample-takeoff.json" }
  { "schema": "opentakeoff.takeoff_canvas.v1", "conditions": [...], "shapes": [...], … }
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
- Scanned (raster-only) sheets aren't supported by the MCP server yet; the
  seam for a raster mask is marked in `mcp/src/session.ts`.
