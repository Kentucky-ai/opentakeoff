# Design: complete user-facing i18n coverage

## Goal

Complete the existing English/pt-BR i18n implementation by converting the
remaining user-visible text in `web/src` into translation keys, while keeping
internal technical text hardcoded.

## Scope

Translate user-visible:

- component text, menus, titles, labels, placeholders, tooltips, and accessible
  labels;
- canvas status messages, prompts, validation messages, and measurement text;
- report and export labels shown to users;
- user-facing messages emitted by library modules.

Keep hardcoded:

- logs and diagnostic output;
- identifiers, condition codes, and filenames;
- technical protocol values;
- user-provided names, labels, notes, and material data;
- documentation and developer-facing text.

## Translation architecture

Use the existing i18next setup and reorganize keys by domain:

- `canvas.json`: canvas, tools, navigation, and measurement messages;
- `panels.json`: panels, settings, forms, and menus;
- `report.json`: reports, exports, and columns;
- `lib.json`: user-facing output from library modules;
- `guide.json`: user guide and shortcuts.

English and pt-BR resources must retain matching key structure. English remains
the fallback language. User-supplied values are passed through interpolation
without translating their contents.

## Testing policy

Do not add exhaustive tests for every component, prompt, tooltip, plural, or
interpolation. Existing component/function tests should be reviewed and
redundant i18n-specific tests may be removed.

Keep only focused infrastructure tests that verify:

1. i18next initializes successfully;
2. English and pt-BR resources load;
3. switching to pt-BR resolves a known Portuguese value;
4. a missing pt-BR key falls back to English;
5. the resource files have the expected basic shape.

Existing non-i18n behavior tests remain untouched unless they fail because a
user-visible string was correctly externalized.

## Validation

Run typecheck, lint, the test suite, and production build. Run the benchmark
separately; its Windows ESM path issue is pre-existing and unrelated to this
change.
