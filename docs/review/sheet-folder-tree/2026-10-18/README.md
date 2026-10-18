# Sheet tree integration — October 18, 2026

Updated PR #523 (`980f996`) against main `0074c37`. The only conflict was in
`CHANGELOG.md`; both the sheet-tree entries and the reconciled-cutout entry
are retained. No additional runtime behavior was introduced in the resolution.

| Check | Expected | Observed |
|---|---|---|
| Full web check | Pass | 3,503 passed, 4 skipped, zero failures; typecheck, lint, benchmark and build passed |
| Browser walkthrough | All checks pass | 21/21 passed |
| Sheet numbers after gallery / reload | 30 / 30 | 30 / 30 |
| PDF workers after reload | At most 1 | 1 |
| Reader maximum | Below 50 ms | 2.3 ms (p95 1.2 ms) |
| Narrow viewport | No horizontal page scroll | 900 px content at 900 px viewport |
| Tree Delete/Backspace keys | Preserve selected shape and unfinished trace | Preserved; canvas Delete control removes the shape |

MCP tool-count/wiki, 61 protocol tests and documentation links passed.
OCR models were not staged. The build emits its existing chunk-size warning.
The browser script blocks external fonts and analytics; no other console errors
were recorded. The narrow screenshot was visually inspected.

## Reproduce

Use Node 24 and install web, MCP and protocol dependencies. From the repository root:

```sh
npm run check --prefix web
npm run check:tool-count --prefix mcp
npm run check:wiki --prefix mcp
npm run check --prefix protocol
node scripts/check-doc-links.mjs
cd web
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER_PATH=/path/to/chrome node scripts/verify-sheet-tree.mjs ../docs/review/sheet-folder-tree/2026-10-18/results.json
```

[Full browser results](results.json), [narrow layout](07-tree-900px-wide.png),
[light theme](05-tree-light-theme.png), [graphite theme](06-tree-graphite-theme.png),
and [trace protection](10-trace-in-progress-after-keys.png).

![Sheet tree at 900 px](07-tree-900px-wide.png)
