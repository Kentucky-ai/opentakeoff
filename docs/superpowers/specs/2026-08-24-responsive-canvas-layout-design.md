# Responsive Canvas Layout Design

## Goal

Improve the OpenTakeoff canvas layout at 1920×1080 so the primary controls remain visible, the right panel remains usable, and the application has no page-level horizontal scrollbar.

## Scope

This is a presentation-only change. It covers the canvas shell, top toolbar, conditions band, left tool rail, right panel chrome, and responsive overflow behavior. It does not change measurement math, normalized coordinates, zoom semantics, persistence, keyboard shortcuts, or panel content behavior.

## Design

The canvas shell will use a constrained three-zone layout: a stable narrow tool rail, a flexible central workspace, and an adaptive right panel. The central workspace receives all remaining width instead of competing with fixed minimum widths.

The top toolbar will use flexible groups with controlled wrapping. High-priority actions remain visible; secondary controls may compact or move to a second row rather than force document overflow. The conditions band will similarly wrap into a second row when the available width is insufficient.

The right-panel tab strip will be allowed to scroll within the panel rather than pushing the panel or the document wider. Panel internals will clamp long labels and controls to their available width.

Page-level overflow will be hidden only on the application shell; intentional scrolling remains available inside panels and tool collections. Canvas drawing coordinates and stage transforms remain unchanged.

## Responsive rules

- At 1920×1080, the full shell must fit without `document.documentElement.scrollWidth > document.documentElement.clientWidth`.
- The central canvas must remain the flex-growing region.
- Toolbar and conditions controls may wrap, but individual controls must not be clipped.
- Right-panel tabs may scroll horizontally inside their tab strip.
- At narrower widths, the same layout should degrade through wrapping/compaction rather than introducing page-level overflow.

## Validation

- Run the repository's `web/npm run check` command.
- Load the app at 1920×1080 and confirm no page-level horizontal scrollbar.
- Confirm toolbar actions, condition controls, right-panel tabs, left tool rail, and bottom status bar remain reachable.
- Confirm the canvas still accepts pointer interaction and the existing sample-plan workflow is unaffected.
