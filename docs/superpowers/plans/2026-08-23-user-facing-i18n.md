# User-Facing i18n Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove remaining user-visible hardcoded English messages from OpenTakeoff and provide equivalent English and Brazilian Portuguese translations through the existing i18next namespaces.

**Architecture:** Keep the existing `react-i18next` setup and namespace ownership. Runtime UI messages use the component's `t()` hook; library/export messages use the existing `i18n.t(..., { ns: "lib" })` helper. Internal protocol, MCP, logging, and non-user-facing diagnostic strings remain unchanged.

**Tech Stack:** React, Vite, JavaScript/JSX, i18next, react-i18next, Node test runner.

---

### Task 1: Add a source-level user-facing hardcoded-message audit

**Files:**
- Create: `web/test/user-facing-i18n.test.mjs`
- Modify: `web/test/i18n-setup.mjs` only if the existing locale loader needs a shared helper

- [ ] **Step 1: Write the failing audit test**

Create a test that reads the tracked UI source files and fails when a known user-facing sink contains a direct string literal. The initial allowlist must include only technical/internal cases: comments, import URLs, CSS values, protocol strings, MCP tool descriptions, and the benchmark-only voice skip text. The test should report `file:line:snippet` for every remaining violation.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "src/pages/TakeoffCanvas.jsx",
  "src/components/ReportPanel.jsx",
  "src/components/RollPanel.jsx",
  "src/components/TakeoffsPanel.jsx",
  "src/main.jsx",
  "src/lib/markedset.js",
  "src/lib/revisions.js",
  "src/lib/rfi.js",
  "src/lib/totals.js",
  "src/lib/xlsx.js",
];

test("user-facing message sinks do not contain direct English literals", () => {
  const violations = [];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const [index, line] of source.split("\\n").entries()) {
      if (/setCommitMsg\\((?:[\"'`])|window\\.prompt\\((?:[\"'`])/.test(line)) {
        violations.push(`${relative}:${index + 1}:${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `hardcoded user-facing messages:\n${violations.join("\\n")}`);
});
```

- [ ] **Step 2: Run the audit to verify it fails for the current inventory**

Run: `npm test -- test/user-facing-i18n.test.mjs`

Expected: FAIL listing the remaining `setCommitMsg(...)` and `window.prompt(...)` literals in `TakeoffCanvas.jsx`, plus any additional sinks discovered while tightening the test.

### Task 2: Convert remaining TakeoffCanvas messages

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/public/locales/en/canvas.json`
- Modify: `web/public/locales/pt-br/canvas.json`

- [ ] **Step 1: Add locale keys before replacing call sites**

Add keys under `commit` for match-line guidance, tracing, copy/duplicate/flip/tidy, scan import, voice errors, schedule import, condition/library prompts, and material-library messages. English values must preserve the current wording; Portuguese values must be natural Brazilian Portuguese. Use interpolation for condition names, counts, error text, and plural branches.

- [ ] **Step 2: Convert commit-message sinks**

Replace direct strings in `setCommitMsg(...)`, `say(...)`, returned `{ error: ... }` values that are surfaced by the commit bar, and `window.prompt(...)` prompt text with `t("commit.<key>", values)`. Use `count` interpolation or i18next plural keys instead of manually assembling singular/plural English.

- [ ] **Step 3: Convert title/tooltip literals in the canvas**

Replace user-visible `title`, `aria-label`, empty-state, toolbar, and status strings in the same file with the `canvas` namespace. Leave comments, keyboard identifiers, CSS values, and internal storage/protocol literals unchanged.

- [ ] **Step 4: Run the focused test and lint**

Run: `npm test -- test/user-facing-i18n.test.mjs`

Expected: the TakeoffCanvas sinks are no longer reported.

Run: `npm run lint`

Expected: no unused translation variables, undefined keys, or JSX syntax errors.

### Task 3: Convert remaining panel and application messages

**Files:**
- Modify: `web/src/components/ReportPanel.jsx`
- Modify: `web/src/components/RollPanel.jsx`
- Modify: `web/src/components/TakeoffsPanel.jsx`
- Modify: `web/src/main.jsx`
- Modify: `web/public/locales/en/report.json`
- Modify: `web/public/locales/pt-br/report.json`
- Modify: `web/public/locales/en/panels.json`
- Modify: `web/public/locales/pt-br/panels.json`
- Modify: `web/public/locales/en/canvas.json`
- Modify: `web/public/locales/pt-br/canvas.json`

- [ ] **Step 1: Add `useTranslation` to panel components and add matching keys**

Translate template prompts, synchronization messages, report template buttons/titles, roll-goods tooltips, no-fill/remove-setup titles, and the centered project-open error. Preserve dynamic counts and names with interpolation.

- [ ] **Step 2: Run the audit test**

Run: `npm test -- test/user-facing-i18n.test.mjs`

Expected: no direct literals remain in panel/application sinks.

- [ ] **Step 3: Verify both locale JSON files parse and retain equal key sets**

Run: `npm test -- test/i18n-parity.test.mjs`

Expected: English and pt-BR key counts match for every namespace.

### Task 4: Convert user-facing export and library messages

**Files:**
- Modify: `web/src/lib/markedset.js`
- Modify: `web/src/lib/revisions.js`
- Modify: `web/src/lib/rfi.js`
- Modify: `web/src/lib/totals.js`
- Modify: `web/src/lib/xlsx.js`
- Modify: `web/public/locales/en/lib.json`
- Modify: `web/public/locales/pt-br/lib.json`

- [ ] **Step 1: Identify only strings emitted into user-visible exports**

Translate PDF headings, PDF schedule labels, CSV/XLSX headings, revision export labels, and RFI export headers. Do not translate internal status IDs, JSON schema names, persisted keys, comments, or protocol values.

- [ ] **Step 2: Replace literals with the existing library translation helper**

Use `i18n.t(key, { ns: "lib" })` at serialization time so switching language before export changes the generated document without requiring a page reload.

- [ ] **Step 3: Add regression assertions for English output and localized output**

Extend the existing totals/XLSX/marked-set tests to assert the English golden strings remain unchanged and add one pt-BR assertion for each export family.

### Task 5: Finish the audit and run the project checks

**Files:**
- Modify: `web/test/user-facing-i18n.test.mjs` if new legitimate allowlist entries are discovered
- Modify: locale files only for missing parity keys

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all existing tests pass; only the pre-existing voice-model tests may remain skipped when the model is not staged.

- [ ] **Step 2: Run static checks**

Run: `npm run typecheck`

Run: `npm run lint`

Expected: both pass without warnings treated as errors.

- [ ] **Step 3: Build the production bundle**

Run: `npm run build`

Expected: Vite completes successfully. Existing chunk-size warnings are informational only.

- [ ] **Step 4: Run the audit one final time**

Run: `npm test -- test/user-facing-i18n.test.mjs`

Expected: no user-facing hardcoded-message violations and equal locale key coverage.
