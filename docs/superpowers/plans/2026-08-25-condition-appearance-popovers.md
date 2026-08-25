# Condition Appearance Popovers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the row-layout `Linha` and `Preenchimento` labels with independent icon-triggered color popovers while preserving existing condition data and the docked-panel layout.

**Architecture:** Keep the feature inside `ConditionAppearanceEditor` in `web/src/components/TakeoffsPanel.jsx`. Add one local popover state, render icon controls only for `layout="row"`, and reuse `PALETTE`, `NO_FILL`, and `onUpdateCond`. The existing labeled controls remain unchanged for the stack layout.

**Tech Stack:** React, JSX, existing `Icon` component, existing condition palette constants, Vite build.

---

## Files and responsibilities

- Modify `web/src/components/TakeoffsPanel.jsx:445-521`: row-layout color triggers, independent popovers, outside-click cleanup, and accessibility labels.
- Modify `web/public/locales/en/panels.json`: English titles for the two icon controls if missing.
- Modify `web/public/locales/pt-br/panels.json`: Brazilian Portuguese titles for the two icon controls if missing.
- No persisted schema, geometry, or condition data changes.

### Task 1: Confirm and add translation keys

**Files:**
- Modify: `web/public/locales/en/panels.json` in the existing `takeoffs` group, only if keys are absent.
- Modify: `web/public/locales/pt-br/panels.json` in the existing `takeoffs` group, only if keys are absent.

- [ ] **Step 1: Inspect existing keys**

Check the `takeoffs` namespace for existing line-color, fill-color, and no-fill titles. Reuse existing keys rather than creating duplicates.

- [ ] **Step 2: Add missing keys with these exact meanings**

English:

```json
"line_color_title": "Line color",
"fill_color_title": "Fill color"
```

Brazilian Portuguese:

```json
"line_color_title": "Cor da linha",
"fill_color_title": "Cor do preenchimento"
```

Keep the existing no-fill title key unchanged.

- [ ] **Step 3: Validate translation JSON**

Run from `web/`:

```bash
node -e "JSON.parse(require('fs').readFileSync('public/locales/en/panels.json')); JSON.parse(require('fs').readFileSync('public/locales/pt-br/panels.json')); console.log('translation JSON valid')"
```

Expected: `translation JSON valid`.

### Task 2: Add independent color-popover state

**Files:**
- Modify: `web/src/components/TakeoffsPanel.jsx:445-455`.

- [ ] **Step 1: Add local state and outside-click handling**

Immediately after `const [hatchOpen, setHatchOpen] = useState(false);`, add:

```jsx
const [colorPopover, setColorPopover] = useState(null); // "line" | "fill" | null
const colorPopoverRef = useRef(null);

useEffect(() => {
  if (!colorPopover) return;
  const onPointerDown = (e) => {
    if (!colorPopoverRef.current?.contains(e.target)) setColorPopover(null);
  };
  document.addEventListener("pointerdown", onPointerDown);
  return () => document.removeEventListener("pointerdown", onPointerDown);
}, [colorPopover]);
```

The component already imports `useEffect`, `useRef`, and `useState`.

### Task 3: Replace row-layout labels with icon controls

**Files:**
- Modify: `web/src/components/TakeoffsPanel.jsx:478-486`.

- [ ] **Step 1: Preserve the existing stack-layout groups**

Keep the current labeled `Linha` and `Preenchimento` groups inside `!isRow` branches so the docked panel behavior and wording do not change.

- [ ] **Step 2: Add the row-layout trigger wrapper**

For `isRow`, render a `span` with `ref={colorPopoverRef}` and compact flex styling. Add two independent buttons:

```jsx
<button
  type="button"
  title={t('takeoffs.line_color_title')}
  aria-label={t('takeoffs.line_color_title')}
  onClick={() => setColorPopover((open) => open === "line" ? null : "line")}
  style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
    width: 28, height: 26, padding: 0,
    border: "1px solid var(--ink-faint)",
    background: "var(--paper-bright)", color: c.color || activeColor, cursor: "pointer",
  }}
>
  <Icon name="linear" size={15} />
  <span aria-hidden="true" style={{ width: 7, height: 7, background: c.color || activeColor }} />
</button>
```

Use the existing `Icon name="area"` for the fill trigger, with `color: c.fill === NO_FILL ? "var(--c-danger)" : c.fill || activeColor` and a small filled square as the visual swatch. Do not add a new icon to `web/src/brand/icons.jsx`; `linear` and `area` already exist.

- [ ] **Step 3: Render the line palette popover**

When `colorPopover === "line"`, render an absolutely positioned popover beneath the line button. It must use the existing palette and update through the existing callback:

```jsx
{colorPopover === "line" && (
  <div style={{
    position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30,
    display: "flex", gap: 4, flexWrap: "wrap", width: 150,
    padding: 8, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)",
    boxShadow: "var(--shadow-pop)",
  }}>
    {PALETTE.map((p) => (
      <button key={p} type="button" title={p} onClick={() => { onUpdateCond({ color: p }); setColorPopover(null); }}
        style={{ width: 16, height: 16, padding: 0, borderRadius: 4, background: p, border: c.color === p ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />
    ))}
  </div>
)}
```

- [ ] **Step 4: Render the fill palette popover**

When `colorPopover === "fill"`, render the same popover anchored below the fill button (use `left: 32` relative to the shared trigger wrapper). Include the no-fill button first, then `PALETTE` with the existing reduced opacity. Each selection must call `onUpdateCond({ fill: value })` and close the popover. The no-fill action must call `onUpdateCond({ fill: NO_FILL })`.

- [ ] **Step 5: Ensure independent toggling**

Both triggers must use the same `colorPopover` state, so opening one replaces the other and never leaves both popovers visible. The `colorPopoverRef` must wrap both buttons and their popovers so clicking a swatch is not interpreted as an outside click.

### Task 4: Verify the feature

**Files:**
- No additional files.

- [ ] **Step 1: Run the production build**

Run from `web/`:

```bash
npm run build
```

Expected: Vite completes successfully. Existing chunk-size warnings are acceptable if no new error appears.

- [ ] **Step 2: Manually verify toolbar behavior**

With an active condition in the toolbar:

1. Confirm the row shows two icon controls instead of `Linha` and `Preenchimento`.
2. Click the line icon; confirm only the line palette opens.
3. Select a line color; confirm the condition line color updates and the popover closes.
4. Click the fill icon; confirm only the fill palette opens.
5. Select a fill color and then `NO_FILL`; confirm both update and close.
6. Open one palette, then click the other icon; confirm the first closes.
7. Click outside; confirm the open palette closes.
8. Open the docked Takeoffs panel; confirm its original text labels remain.

- [ ] **Step 3: Confirm line endings and diff hygiene**

Verify all modified files contain LF line endings and run:

```bash
git diff --check
```

Expected: no whitespace errors and no CRLF sequences in modified files.
