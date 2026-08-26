# Top bar — scrolling controls, pinned actions

**Date:** 2026-08-26 · **Status:** shipped

## The problem
The top bar is ~1,375px of fixed-width controls and, by the #61 contract, never wraps (a control that moves mid-trace is a mis-click). Under ~1,400px of window the row scrolled itself with a thin scrollbar; the canvas claims wheel/trackpad gestures for zoom/pan, so that scroll rarely arrived. On a 1366×768 laptop **Report** sat at x=1472 and **⋯** at 1533 — past the edge. Measured, not guessed: an iframe harness at 1366 / 1280 / 1024 listed every element whose right edge exceeded the frame.

## The fix
Two flex children inside the bar:

```
<div data-topbar>                       flex row, no wrap, padding 0 14px 6px
  <div data-topbar-scroll>              flex 1 1 0, minWidth 0, overflowX auto, paddingTop 16
    logo · Open · Sheets · sheet chip · Edit · Aids · Command · Voice · Scale · Action · spacer
  </div>
  <span data-topbar-pinned>             flexShrink 0, paddingTop 16
    Report · ⋯ · presence · account
  </span>
</div>
```

- The scroll region keeps `paddingTop: 16` so the cluster captions (`position:absolute; top:-13`) stay inside its scroll box; `overflowY: hidden` because `overflowX: auto` would otherwise force a vertical scrollbar for them.
- Menus already open `position: fixed` off their trigger rect (ToolMenu), so the scroll region cannot clip them.
- At full width the scroll region has slack and the spacer pushes the pinned group to the same place it was: pixel-identical.

## Verified
Iframe harness, same page three ways. Report right edge: 1366 → 1291, 1280 → 1205, 1024 → 949 (all inside). Scroll region `scrollWidth` 1375 at every width — the controls are unchanged; only what is pinned changed. Full-width (1728) screenshot matches before.

## Not done, on purpose
No wrapping, no compacting of the Command box or the sheet chip, no responsive breakpoints. The bar's controls are set once and read many times; keeping them at fixed positions is worth more than fitting them all on a 1280 screen. Scroll the region if you need Voice on a small laptop; Report never needs it.
