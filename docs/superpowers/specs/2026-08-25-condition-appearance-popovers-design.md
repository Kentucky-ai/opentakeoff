# Condition Appearance Popovers

## Goal

Replace the `Linha` and `Preenchimento` text labels in the top-bar condition appearance editor with two compact icon controls that open independent color palettes.

## Scope

- Applies only to `ConditionAppearanceEditor` when rendered with `layout="row"` in the toolbar.
- The docked panel's existing labeled layout remains unchanged.
- Persisted condition data remains unchanged: line color uses `c.color`, fill color uses `c.fill`.

## Interaction design

- A line icon button opens the line-color palette.
- A fill icon button opens the fill-color palette.
- The current color is represented by the button's visual accent and selected palette swatch.
- The fill palette retains the existing no-fill action (`NO_FILL`).
- Selecting a swatch updates the condition immediately through the existing callbacks.
- Opening one palette closes the other; clicking outside closes the open palette.
- Palettes use the existing compact popover styling and the existing `PALETTE` colors.
- Controls include translated `title`/accessible labels.

## Implementation boundary

The changes stay inside `ConditionAppearanceEditor` in `web/src/components/TakeoffsPanel.jsx`. No new persisted fields, global state, or shared menu API are required. Existing hatch and condition appearance behavior remains intact.

## Verification

- Run `npm run build` from `web/`.
- Manually verify both controls in the toolbar: open, select, no-fill, switch palettes, and click outside to close.
- Confirm the docked panel still displays the original labeled controls.
- Keep modified files encoded with LF line endings.
