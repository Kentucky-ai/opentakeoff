# Trade suites

The core tools are trade-neutral: load, scale, read the set, measure area,
line and count, revise, export. A trade suite is what one trade adds on top:
a short method, the condition tags its tools default to, and a tool of its own
only where the core cannot already do the job.

## How an agent uses them

1. Read the catalog: `open_suite` with no arguments, or its tool description.
2. Open only the trade being taken off: `open_suite {suite: "roofing"}`, or a
   whole CSI division with `open_suite {division: "07"}`.
3. Follow the method the reply returns. It names the core tools to measure with
   and the suite tool to call last.

A suite's tools are hidden until it is opened, so they cost no context before
that. A client that reads its tool list only once can pre-open suites with
`OPENTAKEOFF_MCP_SUITES=roofing,siding` (or `all`).

## Suites

| Suite | Divisions | Tool | What it figures |
|---|---|---|---|
| finishes | 09 | none | Rooms with `measure_polygon`, base with `derive_base`, transitions with `derive_transitions`, wall finishes with `measure_surface`. |
| roofing | 07 | `roof_takeoff` | Sloped SF and squares, true rake, hip and valley LF, drip edge, starter, ridge cap, underlayment, ice and water. |
| siding | 07 | `siding_takeoff` | Net wall SF and squares, opening trim, starter, corners, lap pieces. |
| soffit_fascia | 07 | `soffit_takeoff` | Soffit SF, fascia LF, wall receiver LF, attic intake vent area. |
| glazing | 08 | `glazing_takeoff` | Lites, daylight opening size, glass SF, mullion LF, perimeter sealant. |
| doors | 08 | none | Door counts by type with `find_schedule`, `sweep_schedule_row` and `count_marks`. |
| plumbing | 22 | `plumbing_rollup` | Fixture counts against the schedule QTY, pipe LF, hangers, fittings, insulation. |
| electrical | 26, 27, 28 | `electrical_rollup` | Wire LF by conductors, couplings, straps, boxes and plates, fixture whips. |

## In the canvas

The status bar's **Trade** picker shows one trade at a time, with each trade's
condition count. Other trades' conditions leave the Condition list and the
Takeoffs panel and their shapes hide; the Report, estimate and exports keep
everything. A condition made while a trade is showing is booked to it
(`trade` on the condition). Otherwise a condition's trade is read from its tag
prefix (`RF-`, `SD-`, `SF-`, `GL-`, `DR-`/`HW-`, `P-`, `E-`/`FA-`/`LV-`), else
Finishes, so the suite tools' default tags land in the right trade. Set it by
hand in the condition's properties. The picker is per user and saved in the
browser, not in the project.

## What the suite tools do and do not do

- They are derives. Each reads shapes already committed under its tags and
  commits what follows: unreviewed shapes (drip edge, trim, starter, soffit,
  mullions) or material rows (wire, hangers). The reply's `undo_steps` is the
  `undo_last {n}` that takes the whole call back.
- Re-running is safe. A derive skips any run it already made from the same
  source shape, and a rollup updates the rows it wrote instead of adding more.
- They never measure the drawing and never invent a document value. Pitch,
  soffit depth, the storefront grid, sightline and hanger spacing are
  arguments. When the drawings do not give one, raise it with `create_rfi`.
- Allowances are labelled. When no waste is stated, the reply says it carried
  the suite allowance (roofing 10 %, or 15 % with hips or valleys; siding and
  soffit 10 %) so the estimator can override it with their own standard.
- No prices, manufacturers or products ship in any suite.

## The math

Plan view is what gets traced. For a pitch of `r` in 12:

- slope factor `sqrt(1 + (r/12)^2)` turns plan area and rake length true
- hip and valley factor `sqrt(1 + (r/12)^2 / 2)` turns a 45° plan hip or valley
  between two planes of the same pitch true
- eaves and ridges are level: plan length is true length

`roof_takeoff` writes these factors as the conditions' multipliers, so the
report, the estimate and the marked set all read true quantities. Use separate
tags and a second call for a second pitch.

Source: [web/src/lib/suiteMath.ts](../../web/src/lib/suiteMath.ts) and
[web/src/lib/tradeSuites.ts](../../web/src/lib/tradeSuites.ts), both pure and
covered by tests, so the canvas can use the same code.
