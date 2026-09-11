# MCP tool index

Generated from runtime `tools/list` schemas and the source stage table. Do not edit by hand.
Refresh with `npm run check:tool-count --prefix mcp -- --write`; CI fails on stale output.

For the operating workflow, read [the agent guide](AGENT_GUIDE.md) and [geometry workflow](GEOMETRY_WORKFLOW.md).
For behavior and optional arguments, use the [tool reference](../mcp/README.md#tools) and the discovered input schema.

Default build: **53 tools**. Coordinates, where present, are full-sheet image pixels at PDF render scale 2.0, top-left origin, y down.

| Tool | Stage | Availability | Required arguments |
|---|---|---|---|
| `annotate` | revise | Default | `sheet`, `type` |
| `apply_rules` | handoff | Default | None |
| `count_marks` | measure | Default | None |
| `create_rfi` | revise | Default | `title`, `question`, `sheet` |
| `cut_out` | measure | Default | `parent_shape_id`, `verts` |
| `delete_rfi` | revise | Default | `rfi_id` |
| `delete_shape` | revise | Default | `shape_id` |
| `delete_verdict` | revise | Default | `verdict_id` |
| `derive_base` | measure | Default | `source_condition`, `condition` |
| `derive_transitions` | measure | Default | `condition_a`, `condition_b`, `condition` |
| `detect_rooms` | measure | One-Click gate lifted | `sheet` |
| `duplicate_condition` | revise | Default | `condition`, `label` |
| `edit_annotation` | revise | Default | `annotation_id`, `text` |
| `edit_condition` | revise | Default | `condition` |
| `edit_materials` | revise | Default | `condition` |
| `edit_shape` | revise | Default | `shape_id` |
| `export_dxf` | handoff | Default | `path` |
| `export_marked_pdf` | handoff | Default | None |
| `export_report` | handoff | Default | None |
| `export_takeoff` | handoff | Default | None |
| `find_schedule` | setup | Default | `kind` |
| `find_text` | setup | Default | `sheet`, `q` |
| `get_sheet_vectors` | setup | Default | `sheet` |
| `import_takeoff` | handoff | Default | `path` |
| `link_annotation` | revise | Default | `annotation_id`, `condition` |
| `list_annotations` | revise | Default | None |
| `list_rfis` | revise | Default | None |
| `list_shapes` | revise | Default | None |
| `load_plan` | setup | Default | `path` |
| `mark_verdict` | revise | Default | None |
| `measure_line` | measure | Default | `sheet`, `pts` |
| `measure_polygon` | measure | Default | `sheet`, `verts` |
| `measure_surface` | measure | Default | `sheet`, `pts`, `condition` |
| `one_click` | measure | One-Click gate lifted | `sheet`, `x`, `y` |
| `place_count` | measure | Default | `sheet`, `points`, `condition` |
| `propose_condition_edit` | revise | Default | `condition`, `rationale` |
| `propose_takeoff` | measure | Default | `label`, `rationale` |
| `read_sheet_text` | setup | Default | `sheet` |
| `resolve_rfi` | revise | Default | `rfi_id`, `answer` |
| `resolve_tag` | setup | Default | `tag` |
| `revise_proposal` | revise | Default | `proposal_id`, `shapes` |
| `scope_duplicates` | revise | Default | None |
| `scope_merge` | revise | Default | `shape_a`, `shape_b` |
| `set_scale` | setup | Default | `sheet` |
| `sheet_context` | setup | Default | `sheet` |
| `sheet_graph` | setup | Default | None |
| `sheet_info` | setup | Default | `sheet` |
| `split_condition` | revise | Default | `condition` |
| `sweep_schedule_row` | measure | Default | `tag` |
| `symbol_sweep` | measure | Default | `sheet`, `seed_rect` |
| `takeoff_summary` | handoff | Default | None |
| `undo_last` | revise | Default | None |
| `view_sheet` | setup | Default | `sheet` |
| `withdraw_condition_edit` | revise | Default | `proposal_id` |
| `withdraw_proposal` | revise | Default | `proposal_id` |

`open_tool_stage {stage}` exists only when staged exposure is enabled. Setup starts open; measure, revise and handoff open on demand. This opener is not part of the default flat count.

Schema-required fields are only the first validation layer: conditional requirements (such as annotation coordinates by type or exactly one calibration method) are explained by each tool and validated by its handler.

Sources: [tool registrations](../mcp/src/tools.ts), [stage table](../mcp/src/staging.ts), [output schemas](../mcp/src/outputs.ts).
