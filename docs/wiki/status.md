# Capability status

This page describes implementation support, not a promise that every plan can
be measured automatically. Follow its source links before changing behavior.

| Capability | Current boundary | Evidence |
|---|---|---|
| Human and agent measurements | Shared geometry/quantity modules; source interpretation still requires inspection | [Geometry workflow](../GEOMETRY_WORKFLOW.md) |
| Original machine geometry after human correction | Outer vertices preserved, including manual agent traces; missing historical originals cannot be recovered | [Compatibility](../../protocol/COMPATIBILITY.md) |
| Human stitching | Browser gallery and alignment; editable browser archive preserves composites | [Workflow](workflows.md) |
| MCP stitched documents | No stitch tool; current import/export omits stitch records | [Field inventory](../../protocol/INVENTORY.md) |
| One-Click | Temporarily gated in the default browser/MCP builds | [Gate](../design/ONE_CLICK_GATE.md) |
| TakeoffDocument v1 | Draft schemas, preflight and opt-in repository adapters for a bounded profile; legacy writer format remains | [Protocol](protocol.md) |
| Annotation cleanup | Text-only MCP edit with undo; RFI-linked notes refuse | [MCP routing](mcp.md) |
| Agent knowledge | Packaged wiki resources and source-generated tool/schema references | [Index](README.md) |
| Academy interoperability | Incompatibilities inventoried; no adapter or certification bridge claimed | [Academy report](../../protocol/ACADEMY_COMPATIBILITY.md) |
| Independent geometry benchmark | Reference-assisted and synthetic checks are not independently reviewed ground truth | [Geometry evidence](../GEOMETRY_WORKFLOW.md#reusable-evidence-from-a-project-test) |

Next protocol work connects the tested contracts to focused MCP workflows and
measures tool-selection/completion results. Broader adapter profiles remain
bounded by preservation tests. Package extraction, verified identity/signatures, Academy credentials
and optional anchoring come later. Rendering optimization is separate from
this protocol and knowledge work.
