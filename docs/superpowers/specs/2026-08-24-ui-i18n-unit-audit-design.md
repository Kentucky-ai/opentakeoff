# UI i18n and Unit-Aware Tooltip Audit

## Goal

Remove visible translation keys, English-only UI strings, and imperial-only tooltip text from the OpenTakeoff browser UI while preserving internal identifiers and user data.

## Scope

- Add missing user-facing keys to the English and pt-BR locale files.
- Replace visible hardcoded strings in menus, annotation empty states, reports, import/theme UI, status chips, and compact tool labels with `t(...)` lookups.
- Make dimension and waste/perimeter tooltip text use the active locale and global unit system.
- Keep internal enum values, saved tags, MCP/API diagnostics, and imported user content unchanged.

## Implementation

1. Inventory reported literals and unresolved translation keys, grouping them by namespace.
2. Extend both locale dictionaries with stable keys and matching interpolation variables.
3. Update consuming components to use the active namespace and existing translation helpers.
4. Introduce or reuse a small unit-label helper for tooltips so Imperial/SI values are formatted at the display boundary only.
5. Add focused regression tests for required keys, translated empty states/report labels, and metric tooltip output.

## Validation

- Run the focused i18n/unit tests first and confirm new tests fail before implementation.
- Run the complete test suite, typecheck, lint, and production build.
- Inspect the running localhost UI in English and pt-BR, switching Imperial/SI for the affected tooltips.
- Check for remaining reported literal keys and imperial-only user-facing strings.

## Non-goals

- No translation of internal tool IDs, saved user data, MCP/API contracts, or developer comments.
- No redesign of the existing UI layout or locale architecture.
- No automatic commit unless explicitly requested.
