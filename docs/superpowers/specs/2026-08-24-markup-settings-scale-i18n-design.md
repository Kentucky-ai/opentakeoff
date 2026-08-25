# Markup, Settings, and Unit-Aware Scale UX

## Goal

Complete the remaining visible English/i18n and unit-system issues in the canvas without changing canonical Imperial storage or measurement math.

## Scope

1. Replace missing/empty markup translation keys and remove visible raw HTML or fallback-key output.
2. Localize markup tool names, stamp names, toolbar labels, and tooltips in English and pt-BR.
3. Move the unit-system control into the Settings menu, immediately above the language control.
4. Replace the inline language selector action with an `Alterar idioma`/`Change language` button that opens a modal.
5. Render the language modal from a central `SUPPORTED_LANGUAGES` catalog, initially containing English and Portuguese (Brazil), so future locales add one catalog entry plus translation files.
6. Filter standard scale presets by the active display system: architectural/engineering Imperial labels for Imperial, ratio-based metric labels for SI.

## Design

### Language catalog and modal

Add one shared catalog with locale code and localized display label. The settings menu consumes this catalog to render the language button/modal. Selecting a language closes the modal and uses the existing language persistence/update path. The modal is keyboard- and screen-reader-friendly, with a dialog role, labelled title, close action, and one option per supported language.

### Settings ordering

Keep the existing Settings menu and its current open/close behavior. Move the unit-settings trigger into that menu, above the language trigger. The unit dialog remains the existing controlled component; only its entry point changes.

### Markup translations

Keep markup rendering behavior unchanged. Add complete keys in both locale files for markup editor placeholder, select/detach actions, tool names, preset/stamp names, and related tooltip text. Where formatted markup text contains emphasis, use the existing i18n interpolation/rendering convention rather than exposing literal `<b>` tags.

### Scale presets

Keep scale calibration math and persisted scale values unchanged. Add a display-system filter at the scale-menu presentation boundary. Imperial mode exposes labels such as `1/4" = 1'-0"`; SI exposes ratio labels such as `1:50` and `1:100`. The selected/custom scale remains available even if it is not one of the current system's standard presets, so changing units does not invalidate calibration.

## Error handling and compatibility

- Unknown locale codes continue through the existing fallback locale behavior.
- Existing saved projects, scales, markups, and stamps remain readable.
- A legacy saved stamp name may continue to display as stored user data; only built-in stamp names are localized.
- Unit changes affect display/input labels and scale-menu choices, not stored geometry or canonical scale values.

## Verification

- Add focused tests for required translation keys and absence of literal markup HTML in rendered copy.
- Test that the language catalog contains the two current locales and the modal action uses it.
- Test scale preset filtering for Imperial and SI, including preservation of a custom selected scale.
- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` in `web/`.
