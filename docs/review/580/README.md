# Large plan sets: byte-range loading, shared worker documents, a text scan that finishes (#580, part 1)

Issue #580 asks for an 800-page set to open and move as if it were small, and
to measure first. This is the measurement and the first step.

## What changed

- **A stored PDF is a Blob, read by byte range.** `addPdf` stores the file as a
  Blob; `loadPdfSource` hands pdf.js a range reader over it, so opening a sheet
  reads the cross-reference table and that page. Before, every sheet open read
  the whole file out of IndexedDB and copied it into each of the five render
  workers.
- **One document per file in each render worker.** A flip to another page of
  the same file is a `getPage`, not another parse. The document is released 20 s
  after its last sheet closes and replaced every 24 sheets.
- **Visited pages are released.** The main-thread document kept every visited
  page's operator list and decoded images until its file closed.
- **A large new file is stored first and hashed after**, and the render workers
  load the file while the main thread finds the page.
- **The whole-file text scan** (Sheets tree numbers, noted scales, plan search)
  runs in its own short-lived workers and survives sheet flips. On `main` it
  stops at the first flip and never starts again, so the tree stays partly
  numbered.

## Measured

macOS arm64, Apple M5 (10 cores, 24 GB), Chrome 157 headless, 1500 × 1000,
production builds of `main` 2bf1f48 and this branch, each run a fresh profile.
Median of 5 runs (3 where noted). Command and metric definitions:
[`web/bench/largeset/`](../../../web/bench/largeset/README.md); every run is in
[`results/`](../../../web/bench/largeset/results/).

**Ohio DOT set: 1,271 sheets, 853 MB**

| | main | this change | #580 finish line |
|---|---:|---:|---:|
| First sheet after the drop | 2,224 ms | 933 ms | ≤ 1,000 ms |
| Reopen after a page reload (includes app boot) | 1,575 ms | 684 ms | ≤ 300 ms |
| Sheet flip, first pixel | 665 ms | 166 ms | ≤ 150 ms |
| Sheet flip, base layer complete | 833 ms | 378 ms | |
| Whole-file text scan | never completes after a flip | 34.7 s | tree ≤ 5 s |
| Gallery scroll | 57 fps | 59 fps | |
| Peak memory, all browser processes | 11.8 GB | 4.3 GB | |
| Memory after the run and a forced collection | 7.0 GB | 3.3 GB | |

**Same set, the page told it has 4 cores (3 render workers), 3 runs**

| | main | this change |
|---|---:|---:|
| First sheet | 2,191 ms | 887 ms |
| Sheet flip, first pixel | 532 ms | 167 ms |
| Peak memory | 10.2 GB | 3.0 GB |

**TxDOT pump station: 734 sheets, 668 MB, 3 runs**

| | main | this change |
|---|---:|---:|
| First sheet | 1,858 ms | 486 ms |
| Reopen | 1,537 ms | 572 ms |
| Sheet flip, first pixel | 665 ms | 223 ms |
| Peak memory | 11.4 GB | 5.7 GB |

**Bundled two-sheet sample (the 5% rule)**

| | main | this change |
|---|---:|---:|
| First sheet | 590 ms | 530 ms |
| Sheet flip, first pixel | 398 ms | 413 ms (+3.8%) |
| Sheet flip, complete | 1,560 ms | 1,514 ms |

## Exact-output gate

`web/scripts/verify-tile-cleanup.mjs` on the bundled sample, 30 Next/Previous
flips: the 6048 × 4320 sheet canvas has the same RGBA SHA-256 on `main` and on
this change, at 0, 10 and 30 flips
(`215aaee30789dd85cef274359bb73e9fe0f028775da9196525782ee6f10fc92a`).
[main](tile-cleanup-main.json) · [this change](tile-cleanup.json) ·
[screenshot](tile-cleanup.png)

Fonts held per worker: 5 on `main` at every count. Here 5, then 10 after the
first flip (the kept document has shown both pages), and still 10 at 10 and 30
flips. The script now asserts that ceiling instead of equality with flip 0.

## Limits, and what was not verified

- **The text scan does not meet the 5 s line.** pdf.js spends 70 to 110 ms of
  CPU per sheet extracting text; more workers do not change that. A saved
  per-page index, or a faster text engine, is the next step.
- **Sheet numbers were not measured on a public set.** The reader finds none in
  either public set's title blocks. On a private 469-sheet building set the tree
  finished numbering in about 7 s, from 23 s (single runs).
- **Reopen and flip are short of their lines** (684 ms against 300, 166 ms
  against 150).
- **"4 cores" changes the worker count, not the CPU.** No mid-range laptop or
  phone was measured.
- **A tab still running an older build** cannot open a file this build stored (it
  reads the Blob as an empty buffer) until it reloads. Records stored before
  this change still open; they load whole, as before, until the file is added
  again.
- **Cloud mode is unchanged:** its store hands over bytes, and the canvas falls
  back to them.
- `web/scripts/verify-doc-lru.mjs` fails at "one tab left" on `main` and here
  alike; it was not repaired in this change.
- Chrome only. Safari and Firefox were not run.
