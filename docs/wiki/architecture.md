# Architecture

The core app runs in the browser. PDFs, calibrated sheets, conditions, geometry
and review state persist locally. The stdio MCP server imports shared geometry,
calibration and quantity modules and keeps its own working session. It does not
drive the browser UI or share the browser's live undo history.

| Boundary | Responsibility | Source |
|---|---|---|
| Browser canvas | Human interaction, overlays, local persistence and project archives | [TakeoffCanvas](../../web/src/pages/TakeoffCanvas.jsx), [store](../../web/src/lib/store.js) |
| Shared engine | Geometry, calibration, quantities, cutouts and collision review | [Geometry](../../web/src/lib/geometry.js), [totals](../../web/src/lib/totals.js), [cutouts](../../web/src/lib/cutout.js) |
| MCP | Validated tool calls, session state, resources and explicit file exports | [Server](../../mcp/server.ts), [Session](../../mcp/src/session.ts), [tools](../../mcp/src/tools.ts) |
| Protocol checks | Draft schemas, record inventory and compatibility evidence; no runtime format switch | [Protocol package](../../protocol/README.md) |
| Optional AI service | Separate suggestion adapter; not the stdio MCP server | [Service guide](../../server/README.md) |

Browser geometry is a normalized SVG overlay on a rendered plan. Tool inputs
use full-sheet image pixels; storage uses per-sheet normalized vertices. Scale
converts pixels to stored SF/LF; changing display units does not rewrite shapes.
See [MCP coordinates](mcp.md).

Shared modules do not imply every record or detector path is identical. Browser
stitches are not preserved by the MCP import/export path. Browser and MCP
origins also have different actors and review authority. Consult the
[compatibility matrix](../../protocol/COMPATIBILITY.md) before promising a
lossless interchange.

Package extraction, signatures, Academy credentials and optional chain anchoring
are later work. They are not required to open a plan or measure it. The current
protocol first makes existing records explicit; it does not replace the engine.
