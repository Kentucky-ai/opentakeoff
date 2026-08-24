# i18n — Multi-language Support (pt-br First)

## Goal

Add internationalization to OpenTakeoff using `react-i18next`, starting with pt-br translation while keeping English as the default fallback. The system must be extensible for future languages.

## Decisions

| Decision | Choice |
|---|---|
| Library | `react-i18next` + `i18next-browser-languagedetector` + `i18next-http-backend` |
| Default language | English (`en`) |
| First translation | Brazilian Portuguese (`pt-br`) |
| Language selection | Auto-detect browser language + manual selector in project menu |
| Technical terms | Translated (materials, units, labels all go through `t()`) |
| User data (finish tags) | NOT translated — `"CPT-1"`, `"LVT-1"` stay as-is |
| Keyboard shortcuts | NOT translated — `"⌘C"`, `"⇧D"` stay as-is |

## Architecture

```
src/i18n/
  index.js                    ← i18n.init() — config, detection, lazy loading
  locales/
    en/
      canvas.json             ← TakeoffCanvas (~350 strings)
      report.json             ← ReportPanel (~120 strings)
      panels.json             ← Takeoffs, PlanNavigator, Revisions, Rfi, Stamp, Agent, etc. (~280 strings)
      guide.json              ← UserGuide (~50 strings)
      lib.json                ← canvasConstants, reportColumns, totals, rfi, lineStyles, coverage, rollgoods, markedset (~130 strings)
    pt-br/
      canvas.json
      report.json
      panels.json
      guide.json
      lib.json
```

### Config (`src/i18n/index.js`)

```js
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    ns: ['canvas', 'report', 'panels', 'guide', 'lib'],
    defaultNS: 'canvas',
    interpolation: { escapeValue: false },
    backend: {
      loadPath: `${import.meta.env.BASE_URL}locales/{{lng}}/{{ns}}.json`,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'i18nextLng',
      caches: ['localStorage'],
    },
  });

export default i18n;
```

### Language Selector

Added as a menu item in the existing project menu (TakeoffCanvas hamburger):

```
┌─ Project menu ─────────────┐
│  ...existing items...       │
│  ─────────────────          │
│  Language ▸                  │
│     ● English               │
│     ○ Português (BR)        │
└────────────────────────────┘
```

- Calls `i18next.changeLanguage('pt-br')` — all components re-render via `useTranslation()` hook
- Persisted in `localStorage` (`i18nextLng`)
- First visit: detects `navigator.language`, loads matching locale if available

## String Extraction Pattern

### Naming convention

```
namespace.category.key
```

Examples:
- `canvas.tool.area` — tool label
- `canvas.tooltip.finish_shape` — tooltip
- `canvas.status.created` — status/commit message
- `canvas.confirm.delete_condition` — confirmation dialog
- `canvas.menu.light_chrome` — menu item
- `report.header.title` — report header
- `report.column.floor_sf` — column header
- `panel.takeoffs.search` — panel placeholder
- `panel.revisions.status.current` — status label
- `guide.section.tools` — guide section
- `lib.rfi.status.open` — library constant

### Interpolation

Uses ICU MessageFormat via `{{variable}}`:

```json
{
  "canvas.status.created": "Created {{count}} takeoff(s) — {{area}} {{tag}}. Click the next room.",
  "canvas.confirm.delete": "Delete {{name}} and its {{count}} takeoff(s)? This can't be undone.",
  "canvas.toast.palette_full": "Palette is full ({{max}}) — unpin one first."
}
```

### Plurals

ICU MessageFormat for pluralization:

```json
{
  "canvas.toast.waste_set": "Waste set to {{v}}% on {{count}} condition(s)."
}
```

### Strings NOT extracted

- User data: finish tags (`CPT-1`, `LVT-1`), project names, file names
- Keyboard shortcuts: `⌘C`, `⇧D`, `↵`
- Industry abbreviations used as values: `SF`, `LF`, `SY`, `EA` (but surrounding text IS translated)
- CSS class names, data attributes, technical identifiers

## Phases

### Phase 1: Infrastructure + Main Components (~550 strings, ~12 files)

**Install:**
- `i18next`, `react-i18next`, `i18next-browser-languagedetector`, `i18next-http-backend`

**Create:**
- `src/i18n/index.js` — i18n config
- `src/i18n/locales/en/canvas.json` — extract from TakeoffCanvas.jsx
- `src/i18n/locales/en/report.json` — extract from ReportPanel.jsx
- `src/i18n/locales/pt-br/canvas.json` — translate
- `src/i18n/locales/pt-br/report.json` — translate

**Modify:**
- `src/main.jsx` — import `./i18n` before app mount
- `src/pages/TakeoffCanvas.jsx` — replace hardcoded strings with `t()` calls
- `src/components/ReportPanel.jsx` — replace hardcoded strings with `t()` calls
- Add language selector to project menu in TakeoffCanvas

### Phase 2: Secondary Panels (~300 strings, ~9 files)

**Extract + translate from:**
- `src/components/PlanNavigator.jsx` (~60 strings)
- `src/components/RevisionsPanel.jsx` (~40 strings)
- `src/components/RfiPanel.jsx` (~30 strings)
- `src/components/StampPanel.jsx` (~25 strings)
- `src/components/AgentPanel.jsx` (~30 strings)
- `src/components/ImportSchedulePanel.jsx` (~25 strings)
- `src/components/AiSettings.jsx` (~20 strings)
- `src/components/LayerPanel.jsx` (~15 strings)
- `src/components/UserGuide.jsx` (~50 strings)

**Create:**
- `src/i18n/locales/en/panels.json`
- `src/i18n/locales/en/guide.json`
- `src/i18n/locales/pt-br/panels.json`
- `src/i18n/locales/pt-br/guide.json`

### Phase 3: Libraries + Export (~150 strings, ~10 files)

**Extract + translate from:**
- `src/lib/canvasConstants.js` (~25 strings)
- `src/lib/reportColumns.js` (~35 strings)
- `src/lib/totals.js` (~15 strings)
- `src/lib/rfi.js` (~10 strings)
- `src/lib/lineStyles.js` (~4 strings)
- `src/lib/coverage.js` (~12 strings)
- `src/lib/rollgoods.js` (~4 strings)
- `src/lib/markedset.js` (~20 strings)
- `src/lib/shapesExport.js` (~5 strings)
- `src/lib/xlsx.js` (~3 strings)

**Create:**
- `src/i18n/locales/en/lib.json`
- `src/i18n/locales/pt-br/lib.json`

**Note:** Library files are NOT React components — they use `i18n.t()` directly (importing the i18n instance). PDF export strings in `markedset.js` also use `i18n.t()`.

## Bundle Impact

- `i18next` core: ~6KB gzipped
- `react-i18next`: ~3KB gzipped
- `i18next-http-backend`: ~2KB gzipped
- `i18next-browser-languagedetector`: ~1.5KB gzipped
- **Total: ~12.5KB gzipped** (lazy-loaded namespaces keep initial load minimal)
- Translation JSON files: loaded on demand, ~5-10KB per namespace per language

## Testing

- Existing tests in `web/test/` cover pure math (geometry, totals) — no UI strings, unaffected
- Manual verification: load app in en, switch to pt-br, verify all visible text changes
- Vite dev server for hot-reload testing
- No new test framework needed — i18n is a UI-layer change verified visually
