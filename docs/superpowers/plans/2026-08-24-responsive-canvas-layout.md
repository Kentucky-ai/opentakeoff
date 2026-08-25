# Responsive Canvas Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenTakeoff canvas shell fit 1920×1080 without page-level horizontal overflow while keeping toolbar, condition controls, panels, and canvas interactions usable.

**Architecture:** Keep the existing monolithic `TakeoffCanvas` behavior and inline control styling, but add semantic shell classes to the existing flex regions. Use CSS for the responsive geometry: a flexible toolbar/condition band, a shrinkable canvas column, and an internally scrollable panel-tab strip. No drawing or state logic changes.

**Tech Stack:** React JSX, CSS, Vite, node:test, Playwright/browser validation.

---

### Task 1: Add shell structure hooks without changing behavior

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx:6177-6388`
- Modify: `web/src/pages/TakeoffCanvas.jsx:6404-6452`
- Modify: `web/src/pages/TakeoffCanvas.jsx:6559-6567`
- Modify: `web/src/pages/TakeoffCanvas.jsx:7635-7648`
- Modify: `web/src/pages/TakeoffCanvas.jsx:7717-7740`

- [ ] **Step 1: Add classes to the existing layout regions**

Add classes while preserving each region's existing inline styles and event handlers:

```jsx
<div className="takeoff-toolbar" style={{ ... }}>
<div className="condition-palette-band" style={{ ... }}>
<div className="takeoff-workspace" style={{ ... }}>
<nav className="tool-rail" ...>
<div className="canvas-stage-column" ...>
<div className="panel-rail" ...>
<TakeoffsPanel ... />
```

Use `className="takeoff-panel"` on the `TakeoffsPanel` component if its public component root already accepts a class; otherwise wrap it in a `div` with that class and preserve its current props unchanged. Do not change `panelW`, `isNarrow`, `takeoffsOpen`, or the panel handlers.

- [ ] **Step 2: Add a class to the toolbar cluster groups**

Update the local `cluster` helper only if needed so its returned wrapper has `toolbar-cluster` in addition to any existing class. Keep its label and child rendering unchanged. The toolbar's `div style={{ flex: 1 }}` spacers may keep their current behavior; CSS will override only at responsive breakpoints.

- [ ] **Step 3: Run the type/build check for the structural-only change**

Run from `web/`:

```bash
npm run build
```

Expected: Vite completes successfully with no JSX or undefined-identifier errors.

### Task 2: Implement responsive shell CSS

**Files:**
- Modify: `web/src/styles/app.css` after the base app rules

- [ ] **Step 1: Add base flex constraints**

Add rules that prevent flex children from imposing their intrinsic width on the document:

```css
html,
body,
#root,
.app-shell {
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.takeoff-toolbar,
.condition-palette-band,
.takeoff-workspace,
.canvas-stage-column,
.takeoff-panel {
  min-width: 0;
}

.takeoff-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  row-gap: 6px;
}

.takeoff-workspace {
  min-height: 0;
  min-width: 0;
}

.canvas-stage-column {
  flex: 1 1 auto;
  min-width: 0;
}

.panel-rail {
  max-width: 100%;
}
```

- [ ] **Step 2: Make toolbar and condition controls wrap safely**

Add rules that allow clusters and direct children to shrink without clipping their controls:

```css
.takeoff-toolbar > *,
.toolbar-cluster,
.condition-palette-band > *,
.condition-palette-band button,
.condition-palette-band input,
.condition-palette-band select {
  min-width: 0;
}

.condition-palette-band > div {
  row-gap: 6px;
}

.condition-palette-band .condition-appearance-editor {
  max-width: 100%;
}
```

If the appearance editor does not currently have a class, add `condition-appearance-editor` to the `ConditionAppearanceEditor` root in `web/src/components/TakeoffsPanel.jsx`, without changing its `layout` prop or rendering logic.

- [ ] **Step 3: Add a desktop breakpoint tuned for the captured layout**

At widths where the toolbar would otherwise collide, allow its trailing action group to move to the next line while keeping the report and overflow controls together:

```css
@media (max-width: 1560px) {
  .takeoff-toolbar {
    padding-top: 10px !important;
  }

  .takeoff-toolbar > :last-child,
  .takeoff-toolbar > .account-chip {
    margin-left: auto;
  }
}
```

Use the actual class or wrapper added for the account chip; do not rely on a selector that cannot match. Prefer a toolbar action wrapper when the last-child selector would be ambiguous.

- [ ] **Step 4: Add narrow-width degradation without touching canvas math**

At narrower desktop/tablet widths, reduce only chrome dimensions and make panel tabs scroll internally:

```css
@media (max-width: 1100px) {
  .takeoff-toolbar { gap: 5px; padding-inline: 10px !important; }
  .takeoff-toolbar .toolbar-cluster > span:first-child { display: none; }
  .condition-palette-band { padding-inline: 10px !important; }
  .takeoff-panel { max-width: min(380px, 42vw); }
  .takeoff-panel [role="tablist"] { overflow-x: auto; }
}
```

Only retain selectors that match the actual component markup. If tab markup is not marked with `role="tablist"`, add a dedicated `takeoff-panel-tabs` class at the tab-strip root in `web/src/components/TakeoffsPanel.jsx` and target that class instead.

- [ ] **Step 5: Run lint/build after the CSS change**

Run from `web/`:

```bash
npm run check
```

Expected: typecheck, lint, tests, and production build all pass.

### Task 3: Validate the actual 1920×1080 composition

**Files:**
- Modify: none unless validation finds a concrete layout defect
- Test evidence: browser viewport at `1920x1080`

- [ ] **Step 1: Start the development server with the repository command**

Use the documented command from `web/`:

```bash
npm run dev
```

Open the displayed local URL in the browser at exactly 1920×1080.

- [ ] **Step 2: Check document-level overflow**

Evaluate:

```js
({
  width: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
})
```

Expected: `horizontalOverflow` is `false`.

- [ ] **Step 3: Check reachability of the required chrome**

Confirm visually and by DOM inspection that the toolbar's Report action, overflow menu, condition add button, right-panel tabs, left tool rail, and bottom status bar are inside the viewport or their intended internal scroll container. Capture a screenshot for comparison with the supplied image.

- [ ] **Step 4: Check the canvas interaction boundary**

Load the bundled sample plan, click `A`, trace a small room, and open Report. Confirm the canvas still receives pointer events and the report opens; do not alter stored geometry or zoom code.

- [ ] **Step 5: Re-run the full check after any validation-only adjustment**

Run:

```bash
cd web
npm run check
```

Expected: PASS.
