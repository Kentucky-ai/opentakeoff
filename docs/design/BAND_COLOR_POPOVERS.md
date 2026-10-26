# Band color popovers — Line / Fill as two swatch buttons

**Date:** 2026-08-26 · **Status:** shipped

## Why
The top-bar condition band carried twenty 16px swatches (10 line + 10 fill + ⦸) on every render. They are set once per condition and then read, not clicked; the band is the working strip and every pixel of it competes with the canvas. Two swatch buttons say the current state at a glance and open the palette only when asked.

## What
`ConditionAppearanceEditor` with `layout="row"` (the band) renders:

- **Line** — a 16px tile with a diagonal stroke in `cond.color`, label "Line".
- **Fill** — a 16px tile in `cond.fill` at 0.55 opacity, or ⦸ in danger red when `NO_FILL`; label "Fill".

Click toggles that control's popover (`role="dialog"`, 6-column grid of `PALETTE`, fill's grid leads with ⦸). One popover at a time — opening Line closes Fill. Esc, a click outside, or choosing a swatch closes it. `aria-expanded` mirrors the state.

`layout="stack"` (the docked Takeoffs panel) is unchanged: inline palettes.

## Where
- `web/src/components/TakeoffsPanel.jsx` — `paletteOpen` state (`null | "line" | "fill"`), a ref for the outside-click test, a document `mousedown` + `keydown` listener mounted only while a popover is open. The popover idiom (absolute, `top: 26`, `zIndex 30`, `--shadow-pop`) matches the hatch picker beside it.
- `web/test/appearancePopovers.test.ts` — `renderToStaticMarkup` both layouts: row has the two buttons and no inline swatches; stack has 2 × PALETTE inline swatches.

## Verified live
Sample plan, CPT-1: Line → pick blue → committed shapes and the hatch swatch re-color immediately, popover closes; Fill popover opens with ⦸ first; Esc closes; opening one closes the other.

## Provenance
Spec from replicant026/fork-opentakeoff (`condition-appearance-popovers-design.md`, seen in #341). Implemented independently.
