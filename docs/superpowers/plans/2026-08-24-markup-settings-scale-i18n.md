# Markup, Settings, and Unit-Aware Scale UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task.

**Goal:** Remove remaining visible i18n/markup leaks, move unit and language controls into a usable settings flow, and show only unit-appropriate standard scale presets.

**Architecture:** Keep the existing React/i18next architecture and canonical Imperial storage. Add a small shared language catalog in the i18n module, make the canvas settings menu open controlled dialogs, and expose scale filtering as a pure helper in `sheets.ts` so it is directly testable.

**Tech Stack:** React, react-i18next, TypeScript helpers, node:test, Vite.

---

### Task 1: Add the language catalog and language dialog

**Files:**
- Modify: `web/src/i18n/index.js`
- Create: `web/src/components/LanguageSettings.jsx`
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/public/locales/en/canvas.json`
- Modify: `web/public/locales/pt-br/canvas.json`
- Test: `web/test/languageSettings.test.ts`

- [ ] Add `SUPPORTED_LANGUAGES` to `src/i18n/index.js` with `en` and `pt-br`, each with stable code and English/Portuguese display labels.
- [ ] Create a controlled dialog using `i18next.changeLanguage`, `role="dialog"`, `aria-modal`, Escape close, focus restoration, and one radio/button option for each catalog entry.
- [ ] Add `showLanguageSettings` state and a trigger ref in `TakeoffCanvas.jsx`; replace the existing one-click language toggle with a `menu.language` item whose label is translated as “Change language”/“Alterar idioma”.
- [ ] Render `LanguageSettings` beside the existing `UnitSettings` modal and close it after selection.
- [ ] Add locale keys for the menu label, dialog title, close action, and current-language marker in both locales.
- [ ] Test catalog shape and source-level dialog accessibility/selection behavior using the existing node:test style.

### Task 2: Move units into Settings and filter standard scales

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/src/lib/sheets.ts`
- Test: `web/test/sheets.test.ts` or the existing scale test file

- [ ] Remove the unit button from the scale cluster while preserving its `UnitSettings` trigger ref.
- [ ] Add the unit-settings action to the overflow/settings menu immediately before the language action, with the translated label and current-unit summary.
- [ ] Export a pure `standardScalesForUnits(units)` helper from `sheets.ts` that returns Imperial labels for `imperial` and ratio labels for `metric`.
- [ ] Use that helper to build the standard scale menu. Keep detected, calibrated, and custom selected values available even when not in the filtered standard list.
- [ ] Add tests asserting Imperial excludes ratio scales, SI excludes architectural/engineering labels, and the helper does not mutate `STANDARD_SCALES`.

### Task 3: Complete markup translations and safe formatted copy

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/src/lib/stamps.js`
- Modify: `web/public/locales/en/canvas.json`
- Modify: `web/public/locales/pt-br/canvas.json`
- Modify: `web/public/locales/en/panels.json`
- Modify: `web/public/locales/pt-br/panels.json`
- Test: `web/test/user-facing-i18n.test.ts` and a focused markup test if needed

- [ ] Replace missing `takeoffs.strip`, `markup.editor_placeholder`, `markup.select`, and `markup.detach` fallbacks with complete non-empty keys in the correct namespaces.
- [ ] Locate all markup toolbar labels, compact tool abbreviations, stamp/preset names, and tooltip text that currently surface English literals; route user-facing text through `canvas`/`panels` translations.
- [ ] Replace the annotation help string that displays literal `<b>` tags with the established interpolation/rendering approach so users see formatted text, not source HTML.
- [ ] Localize built-in stamp names at render time by stable stamp ID while preserving user-created/imported names as user data.
- [ ] Extend the existing i18n audit tests to assert the reported keys are non-empty and no user-facing markup placeholder/help string contains literal HTML tags.

### Task 4: Verify and review

**Files:**
- Review: all files changed above

- [ ] Run `cd web; npm test`.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Inspect the final diff for unrelated files and ensure `.repowise/` remains untracked/excluded.
- [ ] If implementation changes behavior beyond the spec, update the spec/plan before reporting completion.
