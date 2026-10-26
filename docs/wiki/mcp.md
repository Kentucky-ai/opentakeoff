# MCP routing and coordinate contract

Start at `takeoff://wiki`; read the relevant page, then use the discovered
schemas for precise arguments. The [generated tool index](../MCP_TOOL_INDEX.md)
comes from the runtime, including stage ownership and required inputs.

| Current job | First tool or resource | Next check |
|---|---|---|
| See supported workflows without a plan | `takeoff://wiki/status` | Read only the needed workflow page |
| Open and orient | `load_plan`, `sheet_info` | Source revision, dimensions and the intended sheet |
| Establish scale | `set_scale` | Correct detail scale; agent-set calibration stays unconfirmed |
| Find finish evidence | `find_schedule`, `resolve_tag`, `read_sheet_text` | Verify the cited sheet/region; do not infer missing rows |
| Locate boundaries | `get_sheet_vectors` or `sheet_context` | `view_sheet` for visual confirmation |
| Group a pass | `propose_takeoff` | A batch heading exists; no geometry has been committed |
| Floor, base/trim, wall face | `measure_polygon`, `measure_line`, `measure_surface` respectively | Overlay inspection and per-role quantities |
| Device/count census | `count_marks` | Inspect withheld entries; use more specific sweeps where needed |
| Located opening | `cut_out` | Surviving geometry; numeric derived-base allowances cannot be clipped |
| Pending shape or crowded note | `edit_shape` or `edit_annotation` | Reinspect; `undo_last` restores the edit |
| Check and hand off | `takeoff_summary`, `export_report`, `export_takeoff`, `export_marked_pdf` | Reopen and inspect; leave human review pending |

By default tools are flat. With `OPENTAKEOFF_MCP_STAGED_TOOLS=1`, setup starts
open; `open_tool_stage` opens measure, revise or handoff when needed. Opening is
idempotent and never closes another stage. Wiki resources remain readable in
both modes; adding knowledge does not add a measurement tool.

## Coordinates: carry the frame with every point

- Tool coordinates are **full-sheet image pixels at PDF render scale 2.0**:
  PDF points × 2, top-left origin, y down.
- A rendered preview can be resized or cropped. Convert a displayed point back
  using the returned view dimensions and region offset before calling a tool.
  Do not pass raw screenshot pixels as full-sheet coordinates.
- Persisted `verts_norm` use the sheet's normalized frame. Tool calls accept
  pixels, so convert normalized coordinates with the original sheet dimensions.
- Scale is feet per image pixel; areas square that factor. Metric display is a
  conversion of stored quantities, not a change to geometry.

The [full MCP guide](../MCP.md) and [tool reference](../../mcp/README.md)
contain optional arguments and examples. Runtime descriptions remain the
argument authority. A refusal should lead to its stated next step rather than
retrying the same call with guessed coordinates or authority fields.
