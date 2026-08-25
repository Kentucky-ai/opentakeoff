# Português brasileiro natural e unidades métricas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Naturalizar todas as strings pt-BR do OpenTakeoff e fazer a experiência pt-BR usar o sistema métrico por padrão, sem quebrar o suporte imperial nem os dados armazenados.

**Architecture:** Manter a matemática interna em pés/polegadas e converter somente na camada de exibição/exportação já existente em `web/src/lib/units.ts`. O pt-BR escolherá métrico como preferência inicial, enquanto o usuário continuará podendo alternar para imperial. As traduções serão revisadas nos cinco namespaces existentes, preservando chaves, placeholders e siglas técnicas.

**Tech Stack:** React 18, Vite, i18next/react-i18next, TypeScript/JavaScript, Node test runner, JSON locale files.

---

### Task 1: Fixar o padrão de unidade para pt-BR

**Files:**
- Inspect/Modify: `web/src/lib/unitPreference.js`
- Inspect/Modify: `web/src/components/UnitSettings.jsx`
- Test: `web/test/unitSystemGlobal.test.ts`
- Test: `web/test/unit-i18n-tooltips.test.ts`

- [ ] **Step 1: Confirm the current preference contract**

  Inspect the provider and preference helpers and identify the initialization path for a browser with no stored unit preference. Do not add per-project persistence; the existing tests explicitly prohibit it.

- [ ] **Step 2: Add a regression test for the pt-BR default**

  Add a focused test for the preference initialization seam: when the active language is `pt-br` and no unit preference exists, the resolved system is `metric`; when a stored preference exists, it wins. Keep the English default unchanged.

- [ ] **Step 3: Implement the language-aware default**

  Change only the preference fallback/default path. Continue honoring the canonical localStorage key and explicit user selection. Do not alter conversion constants or stored takeoff geometry.

- [ ] **Step 4: Run the focused unit tests**

  Run from `web/`:

  ```bash
  npm test -- --test-name-pattern="unit|metric|imperial"
  ```

  Expected: all preference, unit interpolation, and unit-system tests pass.

---

### Task 2: Make metric labels and exports consistent

**Files:**
- Inspect/Modify: `web/src/lib/units.ts`
- Inspect/Modify: `web/src/lib/totals.js`
- Inspect/Modify: `web/src/lib/xlsx.js`
- Inspect/Modify: `web/src/components/ReportPanel.jsx`
- Inspect/Modify: `web/src/components/RevisionsPanel.jsx`
- Inspect/Modify: `web/src/lib/rollTakeoff.js`
- Test: `web/test/unit-i18n-tooltips.test.ts`
- Test: `web/test/reportColumns.test.ts`
- Test: `web/test/xlsx.test.ts`
- Test: `web/test/shapesExport.test.ts`

- [ ] **Step 1: Inventory every user-facing unit value**

  Use the existing unit helpers (`areaVal`, `areaUnit`, `lenVal`, `lenUnit`, `heightVal`, `heightUnit`, `thickVal`, `thickUnit`) to identify any report/export path that still formats internal feet or square feet directly.

- [ ] **Step 2: Add regression assertions for metric output**

  Assert that metric report and spreadsheet headers use `m²`, `m`, and `mm`, and that rendered metric values do not leak `SF`, `LF`, `ft`, or `in`. Keep explicit imperial-mode assertions for backward compatibility.

- [ ] **Step 3: Route remaining labels through unit interpolation**

  Replace hardcoded unit suffixes in report, revision, shape, roll, and CSV/XLSX paths with the existing unit helpers or interpolation variables. Keep internal field names such as `height_ft` and `thickness_in` unchanged because they are storage contracts.

- [ ] **Step 4: Run the focused export/report tests**

  ```bash
  npm test -- --test-name-pattern="report|xlsx|shapes|unit"
  ```

  Expected: metric and imperial output tests pass with no unit leakage.

---

### Task 3: Naturalize the pt-BR locale files

**Files:**
- Modify: `web/public/locales/pt-br/canvas.json`
- Modify: `web/public/locales/pt-br/panels.json`
- Modify: `web/public/locales/pt-br/lib.json`
- Modify: `web/public/locales/pt-br/guide.json`
- Modify: `web/public/locales/pt-br/report.json`
- Test: `web/test/i18n-lang.test.ts`
- Test: `web/test/languageSettings.test.ts`
- Test: `web/test/oracle-findings.test.ts`

- [ ] **Step 1: Preserve the locale contract before editing values**

  Compare every pt-BR namespace key and interpolation placeholder against English. No key may be removed, and placeholders such as `{{count}}`, `{{error}}`, `{{au}}`, `{{lu}}`, `{{unit}}`, `{{sheet}}`, and `{{tag}}` must remain byte-for-byte present.

- [ ] **Step 2: Apply the approved terminology glossary**

  Use these terms consistently:

  | English concept | pt-BR choice |
  |---|---|
  | sheet | planta |
  | room | ambiente |
  | deduct | dedução |
  | trace an area/room | delimitar |
  | draw lines/annotations | desenhar |
  | waste | perda or desperdício, according to whether it is a calculated quantity or explanatory prose |
  | markup/callout | anotação or indicação, according to the existing UI concept |

- [ ] **Step 3: Rewrite awkward UI prose, not technical identifiers**

  Improve instructions, tooltips, status messages, confirmations, voice prompts, report hints, and error messages for Brazilian usage. Prefer concise imperative text (`Defina a escala`, `Selecione uma planta`, `Delimite o ambiente`) and natural error wording (`Não foi possível ...`). Preserve technical acronyms, file formats, product names, and interpolation markup.

- [ ] **Step 4: Replace imperial abbreviations in Portuguese display text**

  Change Portuguese display labels that currently hardcode `SF`/`LF` to interpolation or metric-aware labels. Imperial-specific labels must remain available when the unit system is explicitly imperial.

- [ ] **Step 5: Update exact-value tests only where behavior intentionally changed**

  Change assertions for approved wording such as `Indicação`, `cinzel`, `arredondada`, and unit labels only when the new glossary supersedes them. Add a locale parity test that rejects missing keys/placeholders and bare imperial labels in metric templates.

- [ ] **Step 6: Run all i18n tests**

  ```bash
  npm test -- --test-name-pattern="i18n|language|oracle|tooltip"
  ```

  Expected: all locale parity, placeholder, and translation assertions pass.

---

### Task 4: Synchronize user-facing documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/USER_GUIDE.md`
- Modify: `CHANGELOG.md`
- Inspect: historical i18n plans/specs under `docs/2026-08-*i18n*`

- [ ] **Step 1: Update current user documentation**

  Describe pt-BR as metric-first (`m²`, `m`, `mm`) while documenting the imperial option. Use the same glossary as the UI: planta, ambiente, dedução, delimitar.

- [ ] **Step 2: Add a changelog entry**

  Record the Brazilian Portuguese naturalization and metric-first behavior without claiming that internal geometry storage changed.

- [ ] **Step 3: Leave historical planning documents intact unless they are presented as current guidance**

  Do not rewrite old plans merely to make their historical examples match the final locale. Correct only references that are currently linked or presented as authoritative.

---

### Task 5: Full verification and manual smoke test

**Files:**
- Test/Inspect: all files changed above

- [ ] **Step 1: Run the project check**

  ```bash
  cd web
  npm run check
  ```

  Expected: typecheck, lint, tests, benchmarks, and production build all pass.

- [ ] **Step 2: Search for remaining Portuguese imperial leakage**

  Search locale and documentation files for standalone `SF`, `LF`, `pés`, and `polegadas`; classify each remaining match as an intentional imperial option, storage identifier, test fixture, or text requiring correction.

- [ ] **Step 3: Smoke-test the running app**

  Start Vite, switch to Portuguese (BR), load the sample plan, confirm metric readouts, delimit an environment, open Report, inspect export labels, switch to imperial, and confirm imperial output still works.

- [ ] **Step 4: Review the final diff**

  Confirm that pre-existing user changes remain untouched, locale JSON remains valid, and no unrelated files were modified.
