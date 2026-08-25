# UI i18n and Unit-Aware Tooltip Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove reported visible translation keys, English-only UI strings, and imperial-only tooltip text from the OpenTakeoff UI in English and pt-BR.

**Architecture:** Keep the existing namespace-based i18next setup. Add keys to the matching `canvas`, `report`, `panels`, or `lib` locale dictionaries, then replace only user-facing literals at their render sites. Unit-sensitive copy uses the existing global `units` value at the display boundary; persisted IDs and user data remain unchanged.

**Tech Stack:** React/Vite, i18next/react-i18next, JSON locale bundles, Node `node:test`, TypeScript, ESLint.

---

### Task 1: Lock the missing-key and literal contract

**Files:** `web/test/user-facing-i18n.test.ts`, `web/test/i18n-lang.test.ts`

- [ ] Add failing assertions that both locale trees define non-empty values for `menu.sheets_in_set`, `menu.open_gallery`, `menu.import_takeoff`, `toolbar.scale`, `toolbar.action`, and `takeoffs.strip`.
- [ ] Add failing assertions covering the reported annotation empty state, `Optional`, total/waste/perimeter headings and hints, theme import copy, and compact tool/status labels.
- [ ] Add a source assertion that the report waste/perimeter hints are resolved through translations rather than literal English constants.
- [ ] Run from `web/`: `npm test -- test/user-facing-i18n.test.ts test/i18n-lang.test.ts` and confirm the new assertions fail for missing keys/literals.

### Task 2: Add English and pt-BR locale entries

**Files:**
- `web/public/locales/en/canvas.json`
- `web/public/locales/pt-br/canvas.json`
- `web/public/locales/en/report.json`
- `web/public/locales/pt-br/report.json`
- `web/public/locales/en/panels.json`
- `web/public/locales/pt-br/panels.json`
- `web/public/locales/en/lib.json`
- `web/public/locales/pt-br/lib.json`

- [ ] Add matching menu, toolbar, takeoff strip, annotation-empty-state, save-state, and compact-label translations while preserving existing interpolation names.
- [ ] Add translated report optional-column, total/perda, perimeter-reference, and theme import/reset/status strings.
- [ ] Add translated values for `cpt`, `talk`, `mark`, `cal`, `cut`, `meas`, `sel`, `annotate`, `shapes`, and `saved` in the namespace used by their consumers.
- [ ] Re-run the focused tests; locale assertions should pass while consuming-source assertions remain RED until Task 3.

### Task 3: Replace canvas and report hardcodes

**Files:** `web/src/pages/TakeoffCanvas.jsx`, `web/src/components/ReportPanel.jsx`, and the component identified by the compact-label test.

- [ ] Replace visible canvas menu/action/readout/status literals with the existing `t(...)` namespaces. Keep state values such as `cloud`, `text`, and `saved` unchanged when they are not display text.
- [ ] Remove the English `COL_HINTS` values in `ReportPanel.jsx`; resolve waste/perimeter hints with `t(...)` at render time.
- [ ] Replace visible `Optional`, total/perda headings, and theme import copy with translated keys while leaving imported theme JSON and user warnings untouched.
- [ ] Run the focused i18n tests and confirm all new assertions pass.

### Task 4: Make tooltip units locale- and system-aware

**Files:** `web/src/pages/TakeoffCanvas.jsx`, `web/src/components/ReportPanel.jsx`, existing unit helper if needed; tests in `web/test/units.test.ts` or `web/test/user-facing-i18n.test.ts`.

- [ ] Add failing tests for English/Imperial, English/SI, pt-BR/Imperial, and pt-BR/SI tooltip output. SI output must not contain `SF`, `LF`, `ft`, or `in`.
- [ ] Implement translated tooltip templates with named unit labels derived from the active `units` value. Convert only display text; do not mutate canonical values.
- [ ] Run the focused unit/i18n tests and confirm all four locale/unit combinations pass.

### Task 5: Full validation and browser smoke test

**Files:** no additional source files expected.

- [ ] Run from `web/`: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Search with `rg -n "menu\\.(sheets_in_set|open_gallery|import_takeoff)|toolbar\\.(scale|action)|takeoffs\\.strip|Waste SF/LF|Perim m \\(ref\\)|Optional|saved|annotate" web/src web/public/locales`; reported keys should occur only in `t(...)` calls or locale definitions.
- [ ] Inspect `localhost:5174` in English and pt-BR, checking sheet menu, gallery/import, annotation empty state, report hints, theme import, compact statuses, and Imperial/SI tooltips.
- [ ] Run `git diff --check` and `git status --short`; exclude `.repowise/` and unrelated planning artifacts, and do not commit unless explicitly requested.
