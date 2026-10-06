# Sheets folder tree: browser evidence

Everything here comes from a generated plan set and the app's own build. No
private plans, names or numbers are involved.

## What was run

```bash
cd web && npm run build
PLAYWRIGHT_MODULE=<playwright/index.mjs> BROWSER_PATH=<chrome> \
  node scripts/verify-sheet-tree.mjs ../docs/review/sheet-folder-tree/results.json
```

The script (`web/scripts/verify-sheet-tree.mjs`) generates the set with
`node scripts/make-sheet-set.mjs <tmp> --files 6 --pages 5 --filler 2000`
(nothing generated is committed), serves `web/dist` with `vite preview`, blocks
every request that is not local, and drives Chrome 154 on the Premium layout
(`/?workspace=premium`, `deviceMemory` 8).

The set: 6 PDFs of 5 pages each (30 sheets), 36 x 24 in pages with 2,000 words
of filler and a title block reading `SHEET NUMBER` over the number
(`A-101`..`A-105`, `C-101`.., `E-101`.., and so on, from `expected.json`).

## Flow

1. Add the six files, open the first sheet from the gallery card, open **Sheets**, expand every folder, read every row.
2. Open the gallery, scroll all 30 cards into view, wait for the thumbnails, close it, read the rows again.
3. Collect `performance.getEntriesByName("sheet-number")`, then clear them.
4. Reload and read the rows before touching anything else; count pdf.js worker spawns since the reload.
5. Studio light and Backlit graphite from the Layout dialog, a 900 px wide window, and a keyboard walkthrough.

## Results (`results.json`)

| Measure | Expected | Observed |
|---|---|---|
| Numbers shown after the gallery | 30 | 30, identical to `expected` |
| Numbers shown after the reload | 30 | 30, identical to `expected` |
| Numbers shown right after opening the first sheet | not asserted (the tree fills in as pages are read) | 9 (one run showed 8) |
| Reader calls (`sheet-number` measures) | n/a | 30 |
| Reader duration | max under 50 ms | p95 1.9 ms, max 3.3 ms |
| Gallery thumbnails drawn | 30 | 30 of 30 cards |
| pdf.js worker spawns since the reload | the canvas's active file only | 1, and still 1 after 1.5 s |
| 900 px window | no horizontal page scroll | none (document width 900) |
| Delete / Backspace on a focused row | removes nothing | 36 rows before and after |
| Console errors | none | only the blocked external requests (analytics beacon, Google Fonts) the script aborts on purpose |

Every check in `results.json` is `ok: true`.

Reading the table: right after opening, only the open file's pages and part of
the next file's are numbered, because a number is read when its page's text is
read; unread rows show today's label (`set-3 · 2`) and are replaced in place.
After the gallery has drawn every card all 30 are numbered, and after a reload
all 30 are present at once from the saved per-file records, with a single
worker (the canvas's file) started.

## Screenshots

Each was opened and looked at after the run.

- `01-tree-after-open.png`: Sheets panel right after the first sheet opens. set-1 (the open file) shows `A-101`..`A-105`, set-2 shows `C-101`..`C-104` with its fifth row still reading `set-2 · 5`, set-3 still shows file labels (`set-3`, `set-3 · 2`, ...). Current row highlighted, its folder open.
- `02-gallery-all-thumbnails.png`: the plan-set gallery scrolled to its last row (cards `S-102` to `S-105`), thumbnails drawn.
- `03-tree-after-gallery.png`: the panel after closing the gallery; set-1 `A-`, set-2 `C-`, set-3 `E-` rows all numbered (the rest of the 30 are below the fold; the script reads them all).
- `04-tree-after-reload.png`: after a reload, the same rows numbered with nothing opened in between; the canvas shows set-1 `A-101`.
- `05-tree-light-theme.png`: Studio light surface; numbers in mono type, current row tinted, readable text throughout.
- `06-tree-graphite-theme.png`: Backlit graphite surface, same tree.
- `07-tree-900px-wide.png`: a 900 px window; the toolbar wraps to two rows, the panel keeps its width and rows are not clipped.
- `08-keyboard-focus-row.png`: a keyboard walkthrough position, focus ring on the `A-101` row (the search box outline comes from the navigator's `:focus-within` rule, an existing style).

Observation, not a result of this change: in Backlit graphite the panel's
"Sheets" title and the "open" half of the logo are very low contrast (dark on
dark) in `01`..`04`, `06`..`08`; the light theme shows them clearly (`05`).

## Keyboard walkthrough (recorded in `results.json`)

Tab from the search box lands on the tree's one tab stop, here the `set-6`
folder row (the last folder the script clicked open; with no earlier click it
is the current sheet's row); ArrowDown/ArrowUp move between
rows; End goes to the last row, Home to the first; ArrowLeft on an open folder
collapses it, ArrowRight expands it and then moves into it; Delete and
Backspace do nothing; Tab leaves the tree for the next control.

## Reader on public files

The reader's results on the bundled demo and public fixtures are pinned by
`web/test/sheetName.test.ts`: "public plan sheets read their labelled number",
"where today's picker reads a door tag, the label reads the sheet", and "any
viewport scale reads the same", plus the table-driven "built pages: one per
rule" cases (cover-index column, body-note mention, rotated label, vertical
strip, no label, label not larger than its number).
