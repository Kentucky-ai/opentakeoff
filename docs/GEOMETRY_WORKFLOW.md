# Geometry from source to review

An accurate total is insufficient: the geometry must follow the finish boundaries on the drawing. This workflow uses OpenTakeoff's public tools and requires no other takeoff application. Tool schemas at discovery are the parameter reference; this page explains the measurement decisions.

## Establish the coordinate frame

1. `load_plan`, then `sheet_info`, `read_sheet_text`, and `view_sheet`: identify the finish plan, schedule, enlarged details, and elevations. A schedule search is a lead; inspect the sheet when it misses a table or resolves an unrelated label.
2. `set_scale`: use the scale for the particular detail being measured. A sheet can contain several scales. An agent-set scale remains unconfirmed until a human confirms it.
3. Read the sheet pixel dimensions and each view's returned region and image dimensions. Tool geometry is in full-sheet image pixels. A crop is not a new coordinate system for measurement inputs.

For an unrotated crop, convert a displayed point `(u, v)` back to the sheet with `x = x0 + u * (x1 - x0) / image_width` and the equivalent formula for `y`. Stored `verts_norm` are normalized coordinates; never pass them directly to a measurement tool expecting pixels. Check a known dimension before committing the whole floor.

## Trace the finish boundary

Use `view_sheet` for a close view and `get_sheet_vectors` for precise candidate endpoints. PDF vectors include tile joints, equipment, door swings, wall faces, white overdraw, and unrelated details. A closed path is evidence of drawing structure, not proof of an installed floor boundary.

Inspect candidates against the rendered plan. Follow the inside finish face, step around columns, preserve chamfers, and distinguish a finish split from a wall. Prefer the enlarged plan for small rooms. If it replaces an area measured on the overall plan, exclude that area from the overall trace so it is measured once.

Start a named batch with `propose_takeoff`, then use `measure_polygon` for floor areas and explicit deductions. The proposal tool starts the group; measurements create its shapes. Commit a small batch, inspect it with `view_sheet` with overlays, and use `edit_shape` for corrections. Label each room or run consistently, and keep sheet/detail evidence in proposal rationale and annotations.

## Base, walls, and transitions need their own geometry

- **Base:** `derive_base` can calculate perimeter less stated openings. Its perimeter trace does not show which portions were deducted. When review needs actual installation locations, trace the physical runs with `measure_line`; `cut_out` can remove a located opening from such a run. Do not clip a derived perimeter already carrying numeric opening allowances: that operation refuses because their locations are unknown. Inspect door jambs, alcove entrances, columns, and open finish splits individually. Do not deduct an apparent opening based only on a low-resolution overview.
- **Wall tile:** use `measure_surface` for the actual wall run and its height. Read elevation height and termination changes. Stepped faces can require separate bands; door/window deductions need explicit geometry. `cut_out` removes the full height of the run it clips; for a partial-height opening, use separately measured vertical bands and clip only the affected band. A generic `deduct` subtracts floor SF and is not a wall-opening record. Do not multiply one elevation width by the number of room walls when the room has chamfers or different lengths.
- **Transitions:** `derive_transitions` produces candidates at shared finish edges and withholds wall-separated runs. Inspect those candidates and withheld runs at the actual doorway. Add an explicit measured threshold when source evidence supports it. Do not assume a walk-in requires a saddle.
- **Supporting materials:** use `edit_materials` on the measured finish condition for membrane or protection coverage. Separate coincident floor polygons obscure the finish overlay and generate intentional overlap reports. Material coverage uses measured quantities; condition waste does not automatically increase material-row quantities.

## Verify the geometry, then hand it off

Inspect the final overlay at both the whole-area and detail scale. Check corners, finish changes, columns, openings, and deductions. Run `scope_duplicates` for unintended overlap, and inspect its geometry rather than treating a rounded zero-area warning as an additional room. Machine-precision remnants are ignored; genuine sub-cent SF overlaps remain flagged with an explanation. Compare floor area, base length, and wall area separately; their grand total is not the building's floor area.

Use `takeoff_summary` and `export_report` to check totals and material coverage. Save with `export_takeoff`, then start a fresh session, load the same source, and `import_takeoff` to verify the handoff. In the browser, open the original PDF before importing the takeoff JSON. Inspect the pending proposals and Report without stamping human approval.

Use `list_annotations` and `edit_annotation` to shorten crowded notes; one `undo_last` restores the prior text. RFI-linked notes require review in the browser register.

Export with `export_marked_pdf` and inspect the actual PDF, including cover units and all marked sheets. It contains marked sheets and schedules, not necessarily every source page. Keep unresolved finish locations as explicit qualifications or RFIs. Agents may mark their own checks, but cannot create human approval.

## Reusable evidence from a project test

Retain source hashes, source revision, scale choices, tool inputs/replies, final geometry, overlay images, and the exported report. A comparison against prior work should report spatial overlap as well as quantities and disclose whether the reference helped correct the result. It is a reference-assisted test when that happened, not an independent accuracy benchmark.

Use private plans locally unless publication is authorized. Put generic regression fixtures and lessons in the public repository. Do not require public agents to know a private application's tools or coordinate conventions.

The [public MCP workflow benchmark](../evals/mcp-workflow-bench/README.md)
exercises the built server in flat and staged modes on a synthetic plan, checks
boundaries separately from quantities, and reopens the export in a fresh process.
Its analytic answer key tests conformance; it is not evidence of accuracy across
real plans. The [recorded agent pilot](../evals/mcp-workflow-bench/evidence/README.md)
preserves a first-pass failure and an explicitly assisted correction.

The same harness also carries an estimator-trace [plan set](../evals/mcp-workflow-bench/plan-set/README.md):
three public real floor plans (a VA healthcare finish plan, a VA clinic office
floor plan and a city public-domain accessory-dwelling plan) with reference rings
traced to the interior wall face, door jambs notched to the wall centerline, one
ring per room and floor finish. The rings were prepared from the PDF vector
linework by an agent and are a proposed reference until a human has reviewed the
overlays; the scripted known-answer runs prove the tools carry those rings, not
that any agent can draw them.
