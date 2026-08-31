# Live counter

A floating running-totals readout the estimator **parks anywhere on the
canvas** — the first piece of a workspace where your instruments sit where
you want them, not where the layout put them. The active condition leads with
a big measured number that moves as you trace; every other condition carrying
shapes lists under it; clicking a row activates that condition.

## Scope

- **In:** a fixed-position widget rendered above the canvas (hidden in focus
  mode and while no condition carries shapes). Drag the header to move it —
  the position persists per browser (`localStorage`) and clamps back into
  reach after a resize. ⌖ re-docks it to the default corner; — collapses it
  to a one-line chip (also persisted). Rows show **measured quantities**
  (`total_sf` / `lf` / `ea` — multiplier applied, waste not), the number that
  moves as you trace, matching the panel chips. Waste belongs on the Report.
- **Out (deliberately):** charts, settings, any second data source. This is a
  readout, not a dashboard — quantities come from the ONE quantity computer
  (`lib/totals.js` `conditionTotals`), shaped for display and nothing else.
- **Never changes:** stored data. Its only writes are two `localStorage`
  conveniences (position, collapsed), both read inside try/catch so a blocked
  store just means defaults.

## Placement rationale

Default dock is the lower-right corner, above the status footer — near the
panel chips it mirrors, clear of the tool rail, the tab strip, and the
right-rail buttons. It renders late in the tree (above panels, below the
manual) so it never steals events from an open dialog.

## Perf note

`counterRows(conditionTotals(...))` recomputes in a `useMemo` on committed
`shapes`/`conditions` changes only — the widget is a small DOM subtree whose
drag updates are position state, no reflow of the canvas. If profiling ever
shows totals pressure during shape drags, the freeze belongs at the totals
callsite shared with the panels, not in this widget.

## Mechanics

- `web/src/lib/liveCounter.js` — pure, node-tested: `counterRows` (only
  conditions with shapes; SF → LF → EA segments per row), `fmtQty`
  (thousands separators, ≤2 decimals), `clampPos`, guarded storage helpers.
- `web/src/components/LiveCounter.jsx` — presentation + the header drag.
  The gesture uses window-level move/up listeners for its duration rather
  than pointer capture: capture on a child retargets events away from the
  handlers, and a fast drag can outrun the widget's re-render — either way
  the gesture (and its position save) silently dies mid-drag.
- `TakeoffCanvas.jsx` — one `useMemo` and one render line; row clicks call the
  existing `activateCondition(id, { reassign: false })`.

## Tests

`web/test/livecounter.test.ts` — rows built through the real
`conditionTotals` (deducts net out, waste ignored, LF/EA land under their
units, active flag follows the id), formatting, and clamp behavior.
