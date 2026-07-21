# OpenTakeoff MCP server

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.Kentucky-ai/opentakeoff` and on [Glama](https://glama.ai/mcp/servers/Kentucky-ai/opentakeoff).

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
native canvas, so every tool and the text/metadata resources work everywhere,
and the sheet-image resource says exactly what's missing where rendering isn't
available.


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
| `load_plan` | Open a plan PDF from disk. Replaces the whole session (old doc, scales, conditions, shapes all cleared). Returns per-sheet dims, title-block `sheet_number`, and the detected drawn scale where present. |
| `sheet_info` | One sheet's dims, vector segment count, scale status, detected suggestion, committed shape count. |
| `set_scale` | Set a sheet's scale — exactly one of `label`, `upp`, `calibrate {p1, p2, feet}`, `use_detected`. |
| `one_click` | One-Click Area at (x, y): flood fill bounded by the plan linework, traced, vertices snapped. Pass `condition` to commit; `role: "deduct"` subtracts. |
| `detect_rooms` | Batch One-Click: reads every room-number label off the sheet's text layer and floods each — one call instead of `read_sheet_text` + reasoning + N `one_click` calls. Only cleanly-traced rooms come back; a leaked/dense-linework label is silently withheld. Pass `condition` to commit every detected room. |
| `measure_polygon` | Area + perimeter of a polygon you supply (min 3 verts). Requires scale. |
| `measure_line` | Length of an open polyline (min 2 points). Requires scale. |
| `takeoff_summary` | Per-condition totals + grand totals, computed by the Report's rules. |
| `export_takeoff` | The full `opentakeoff.takeoff_canvas.v1` payload — exactly what the app autosaves. Inline, and to disk with `path`. |
| `delete_shape` | Remove a committed shape by id. |
| `read_sheet_text` | Positioned page text (image px), optionally restricted to a region — title blocks, room labels, finish schedules. |

Every tool declares an **`outputSchema`**, and every reply carries the payload
as **`structuredContent`** — typed, machine-validated on every call — alongside
the same compact JSON in a single text item for clients that predate structured
output. Failures come back as `isError: true` with `{"error": "..."}` — never a
dropped connection.

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
Rendering uses `@napi-rs/canvas` (pdf.js's own optional dependency): on a
platform without a prebuilt binary every non-raster capability still works and
the image read explains exactly what's missing.

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

## Releasing (maintainers)

MCP releases live in the **`mcp-v*`** tag namespace — bare `v*` tags belong to
the app (v0.2.0, v0.3.0 are app releases). The npm artifact publishes manually
(hardware-key 2FA) **before** the tag is pushed; the workflow refuses to run
ahead of it.

```bash
# 1. bump the version — all three fields together:
#    package.json .version, server.json .version, server.json .packages[0].version
# 2. from mcp/, publish with the hardware key:
npm publish
# 3. tag and push — this fires .github/workflows/publish-mcp.yml:
git tag mcp-v<version> && git push origin mcp-v<version>
```

The workflow checks version consistency, requires the npm artifact to exist,
publishes to the official MCP registry via GitHub OIDC, verifies the listing,
and creates the GitHub release (titled `opentakeoff-mcp <version>`).
