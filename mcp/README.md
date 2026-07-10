# OpenTakeoff MCP server

The takeoff engine — One-Click Area, the scale model, conditions, totals — on
**stdio for your MCP client**. An agent can open a plan, read the title block,
set the scale, click rooms, and hand back the same takeoff payload the browser
app autosaves. Same engine, same math: the server imports
`web/src/lib/{oneclick,sheets,geometry,totals}` directly, so a shape committed
here is field-identical to one committed on the canvas.

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

## Tools

| Tool | What it does |
|---|---|
| `load_plan` | Open a plan PDF from disk. Replaces the whole session (old doc, scales, conditions, shapes all cleared). Returns per-sheet dims, title-block `sheet_number`, and the detected drawn scale where present. |
| `sheet_info` | One sheet's dims, vector segment count, scale status, detected suggestion, committed shape count. |
| `set_scale` | Set a sheet's scale — exactly one of `label`, `upp`, `calibrate {p1, p2, feet}`, `use_detected`. |
| `one_click` | One-Click Area at (x, y): flood fill bounded by the plan linework, traced, vertices snapped. Pass `condition` to commit; `role: "deduct"` subtracts. |
| `measure_polygon` | Area + perimeter of a polygon you supply (min 3 verts). Requires scale. |
| `measure_line` | Length of an open polyline (min 2 points). Requires scale. |
| `takeoff_summary` | Per-condition totals + grand totals, computed by the Report's rules. |
| `export_takeoff` | The full `opentakeoff.takeoff_canvas.v1` payload — exactly what the app autosaves. Inline, and to disk with `path`. |
| `delete_shape` | Remove a committed shape by id. |
| `read_sheet_text` | Positioned page text (image px), optionally restricted to a region — title blocks, room labels, finish schedules. |

Every reply is one compact JSON text item. Failures come back as
`isError: true` with `{"error": "..."}` — never a dropped connection.

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
```

Sheet keys follow the app's codec: page 1 is the bare file name
(`plan.pdf`), pages 2+ are `plan.pdf#2`. Tools also accept the title-block
sheet number (`A-101`) wherever a sheet is named.

## Limits (v1)

- **Vector + text sheets only.** A scanned sheet has no vector linework, so
  `one_click` reports it plainly; a raster fallback is a planned seam
  (`src/session.ts`, `ensureMask`), not yet built.
- One document per session; `load_plan` replaces it.
- The takeoff lives in memory. `export_takeoff` is the way out — and its
  payload is exactly what the app persists, so nothing is lost in translation.

## Tests

```bash
npm run typecheck
npm test        # session + tool-layer + e2e, against demo/sample-plan.pdf
```
