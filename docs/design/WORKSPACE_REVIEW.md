# Work and review

## Problem and behavior

Imported agent measurements persist alongside canvas measurements, but their review controls and provenance are difficult to discover. The floating totals box can also cover panel controls. **Work** opens a shared list of stored measurements across the project, with search, review filters, quantities, and a receipt for the selected shape. Selecting a measurement opens its sheet and centers its boundary.

The **Agent** tab contains the existing browser agent. Imported MCP work is available without configuring a model. Both tabs stay mounted when the panel closes, so searches and an in-session task draft survive reopening.

## Scope and invariants

- This is a view over existing shapes, conditions, calibration, and provenance. It adds no persisted fields and changes no quantity formulas, geometry, exports, detector routing, or MCP tools.
- **Mark reviewed** dispatches the existing `review` command for one stored shape. Undo restores its prior origin receipt. Selection and filtering do not write measurements.
- `reviewed: false` means **Needs review**; `true` means **Reviewed**; absence means **Recorded**. None means independently verified accuracy.
- Missing authorship stays **Not recorded**. A self-declared author is displayed without claiming authenticated identity. Agent identity follows the stored actor or the existing agent-proposal method.
- Area, length, and count quantities remain separate. The summary counts measurements and sheets; it never adds incompatible units. Missing quantities are not presented as zero.
- The panel is opt-in through **Work**. Existing drawing controls remain available. Condition properties gain a disclosure control and start expanded. The floating counter clears the work panel and report, then returns with its saved position.

## Layout and thresholds

| Decision | Value | Reason |
|---|---|---|
| Desktop panel width | `--props-w + 3 × --sp-8` (360 px) | Room for quantity and provenance without a second permanent rail |
| Drawer breakpoint | 1100 px | Preserve the canvas width on smaller laptops and tablets |
| Phone breakpoint | 640 px | Work occupies the viewport above the status strip; selecting work returns to the plan |
| Toolbar wrapping breakpoint | 800 px | Keep scale, Work, and Report outside the scrolling tool strip; wrap pinned controls on narrow windows |
| Initial list size | 50 measurements | Bound rendered rows on large takeoffs; **Show more** adds 50 |
| Locate padding and zoom cap | 90 px; 1.5× | Match the existing condition-navigation behavior |
| Readout precision | Up to 2 decimal places | Use the existing unit formatter and stored quantities |

Spacing, typography, colors, and surfaces use the existing design tokens. Tabs support arrow keys, Home, and End. Escape from the work panel closes it and returns focus to **Work**.

## Remaining architecture

This panel is not a live connection to an external MCP session. It shows imported/stored work. Browser-agent proposals and run logs still do not survive page reloads. Durable tasks, operation IDs, shared authority, concurrency, and evidence verification remain separate work. No presence, progress, or verification state is invented for this view.

See [live verification](workspace-review-verification.md).
