# Idle PDF documents are capped (#302 follow-up)

Each PDF opened in a session got its own pdf.js document, and with it its own
pdf.js worker, until the file was removed or the project closed. Now the files
in open tabs stay loaded, at most four other documents stay idle (two on a
phone-class device), and the least recently used idle one is destroyed first.
A tab just closed becomes the most recently used idle document, so reopening
it is usually instant. A destroyed document opens again from the stored file
when it is next needed.

## Measured browser behavior

October 6, 2026, macOS arm64, Chrome 154.0.8037.98 headless, Premium layout
(the default), `deviceMemory` 8 and `hardwareConcurrency` 8 (desktop class, so
the idle cap is 4). Fixed: this branch at `ea910304`. Baseline: upstream main
`4d6cfd0e`, its merge base.

The script makes 12 PDFs from the bundled `web/public/demo/sample-finish-plan.pdf`
(pages 1, 2, 1; 36 sheets in all), stamping one marker word on every page of
each file so each is its own document. It adds all 12 at once, opens
`set-10.pdf`, `set-11.pdf` and `set-12.pdf` as tabs, closes `set-10` then
`set-11`, reopens `set-11`, scrolls the whole gallery and searches one file's
marker. "Live" is the number of pdf.js document workers once workers, worker
starts and drawn thumbnails have been unchanged for 2 seconds; "started" is the
running total of pdf.js workers created since the page loaded.

| Step | Expected live (fixed) | Baseline live / started | Fixed live / started |
|---|---:|---:|---:|
| Gallery after adding 12 PDFs | ≤ 4 | 12 / 12 | 4 / 14 |
| Three tabs open | ≤ 3 + 4 | 12 / 12 | 6 / 16 |
| Two of those tabs closed | ≤ 1 + 4 | 12 / 12 | 5 / 16 |
| Reopen the last-closed tab | 0 new started | 12 / 12 | 5 / 16 |
| Whole gallery scrolled (two tabs open) | ≤ 2 + 4 | 12 / 12 | 6 / 23 |
| Search `GANNET` (`set-07.pdf`) | ≤ 2 + 4 | 12 / 12 | 6 / 23 |

Both builds drew all 36 thumbnails and the search read **3 of 36 sheets
match**, the three sheets of `set-07.pdf`.

The fixed build starts more workers over the run (23 against 12), by design: a
destroyed document is opened again from the stored file when the gallery or a
tab needs it, instead of staying resident. Reopening the closed tab started no
worker on either build; on the baseline that is because nothing is ever
closed, so it is a non-regression check there, not a before/after difference.
On the fixed build the cap trimmed one idle document when the two tabs closed
(1 tab + 5 idle down to 1 + 4), and `set-11` was still loaded when reopened.
Whether `set-10` also stayed is not tested. Three runs of the fixed build gave
the same counts.

**Console.** The script asserts that the console has no errors or warnings
other than the two blocked external requests (a font stylesheet and an
analytics beacon) and one known warning: both builds log `[tiles] detail crop
failed — keeping the previous crop: Error: sheet not open` while the closed tab
is reopened. It comes from the tile workers, not the pdf.js document cache, and
is the same stale-detail warning noted in [the #508 review](../508/README.md);
the JSON records it. No uncaught page errors.

The counts are pdf.js workers, not resident or GPU memory; renderer memory is
not recorded by this script. This
covers one browser and one synthetic plan set. The sample's pages are 3024 ×
2160 pt.

[Baseline JSON](baseline.json) · [Fixed JSON](fixed.json) · [Fixed screenshot](fixed.png) · [Baseline screenshot](baseline.png)

## Reproduce

Use Node 24 and stage the normal OCR deployment assets for the app build:

```sh
cd web
npm ci
node scripts/stage-ocr-model.mjs
npm run check
node --import tsx --test test/ocrSheetSource.test.ts test/pinnedFiles.test.ts test/pdfBytes.test.ts test/cloudStore.test.ts
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER_PATH=/path/to/chromium \
  node scripts/verify-doc-lru.mjs ../docs/review/302-doc-lru/fixed.json
```

To compare, build main `4d6cfd0e` without touching a checkout, then run the same
script with `BASELINE=1` and that build's absolute `dist` path as a second
argument. From `web/`:

```sh
mkdir -p /tmp/base
git -C .. archive 4d6cfd0e web | tar -x -C /tmp/base
ln -s "$PWD/node_modules" /tmp/base/web/node_modules
cp -R public/models /tmp/base/web/public/
(cd /tmp/base/web && npm run build)
BASELINE=1 PLAYWRIGHT_MODULE=... BROWSER_PATH=... \
  node scripts/verify-doc-lru.mjs ../docs/review/302-doc-lru/baseline.json /tmp/base/web/dist
```

The baseline run records the same numbers and checks only that the scenario
ran (the tab lists it opened and closed). The script serves the built app with
`vite preview` on 127.0.0.1:5261 and aborts every other request. It writes its
JSON and screenshot before it reports failed checks, so a failing run still
leaves its record. The first tab is opened by clicking `set-10`'s **View**
button in place; scrolling down to it would draw, and so load, that row's
thumbnails first. Set browser paths to your own Playwright installation.

## Not covered here

A cloud project keeps the PDF bytes it downloads for the session (up to 256 MB,
none on a phone-class device), so a destroyed document opens again without a
second download. That needs a Google account, so this browser run does not
exercise it; it is covered by unit tests in `web/test/cloudStore.test.ts` and
`web/test/pdfBytes.test.ts`. The idle cap, leases and recency order are unit
tested in `web/test/ocrSheetSource.test.ts`, and the files kept for open tabs and
stitches in `web/test/pinnedFiles.test.ts`.
