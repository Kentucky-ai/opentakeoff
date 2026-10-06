# Idle PDF documents are capped (#302 follow-up)

Each PDF opened in a session got its own pdf.js document, and with it its own
pdf.js worker, until the file was removed or the project closed. Now the files
in open tabs stay loaded, at most four other documents stay idle (two on a
phone or tablet, or a browser that reports 4 GB of memory or less), and the
least recently used idle one is destroyed first. A tab just closed becomes the most recently used idle document, so it
reopens without loading its PDF again, unless four other PDFs (two on those
devices) are used in between. A destroyed document opens again from the stored
file when it is next needed.

## Measured browser behavior

October 6, 2026, macOS arm64, Chrome 154.0.8037.98 headless, Premium layout
(the default), `deviceMemory` 8 and `hardwareConcurrency` 8 (desktop class, so
the idle cap is 4). Fixed: this branch's app code and script as committed in
`29d84e16` (the gallery ceiling was later loosened from 16 to 18 starts; the
recorded run started 14). Baseline: upstream main
`4d6cfd0e`, its merge base.

The script makes 12 PDFs from the bundled `web/public/demo/sample-finish-plan.pdf`
(pages 1, 2, 1; 36 sheets in all), stamping one marker word on every page of
each file so each is its own document. It adds all 12 at once, opens
`set-10.pdf`, `set-11.pdf` and `set-12.pdf` as tabs, closes `set-10` then
`set-11`, reopens `set-11`, scrolls the whole gallery and searches one file's
marker. It then clears the search, previews the first sheet of `set-01` to
`set-05` (more files than the idle cap), closes the gallery and switches to
each open tab, `set-12` then `set-11`. "Live" is the number of pdf.js
document workers once workers, worker starts and drawn thumbnails have been
unchanged for 2 seconds; "started" is the
running total of pdf.js workers created since the page loaded.

| Step | Expected live (fixed) | Baseline live / started | Fixed live / started |
|---|---:|---:|---:|
| Gallery after adding 12 PDFs | ≤ 4 | 12 / 12 | 4 / 14 |
| Three tabs open | ≤ 3 + 4 | 12 / 12 | 6 / 16 |
| Two of those tabs closed | ≤ 1 + 4 | 12 / 12 | 5 / 16 |
| Reopen the last-closed tab | 0 new started | 12 / 12 | 5 / 16 |
| Whole gallery scrolled (two tabs open) | ≤ 2 + 4 | 12 / 12 | 6 / 23 |
| Search `GANNET` (`set-07.pdf`) | ≤ 2 + 4; ≤ 2 more started | 12 / 12 | 6 / 23 |
| Five previews (`set-01` to `set-05`) | ≤ 2 + 4 | 12 / 12 | 6 / 28 |
| Gallery closed, then each tab opened | 0 new started | 12 / 12 | 6 / 28 |

The gallery after adding the 12 PDFs must also start at most 18 workers in
all (fixed: 14).

Both builds drew all 36 thumbnails and the search read **3 of 36 sheets
match**, the three sheets of `set-07.pdf`.

The fixed build starts more workers over the run (28 against 12), by design: a
destroyed document is opened again from the stored file when the gallery or a
tab needs it, instead of staying resident. Reopening the closed tab started no
worker on either build; on the baseline that is because nothing is ever
closed, so it is a non-regression check there, not a before/after difference.
On the fixed build the cap trimmed one idle document when the two tabs closed
(1 tab + 5 idle down to 1 + 4), and `set-11` was still loaded when reopened.
Whether `set-10` also stayed is not tested. The five previews started five
workers and the two open tabs' files stayed loaded through them: switching to
each started none. One run of each build is recorded.

The tab-switch check catches broken pinning. A build of the same code with the
canvas's pinned files emptied (`pinned: () => []`) passed every other check
but started one worker on each tab switch (`set-12` 1, `set-11` 1), so the
run failed ([its JSON](no-pins.json); its `build` field reads `fixed` because
it ran without `BASELINE`). The worker-start ceilings were not run against a
build made to churn.

**Console.** The script asserts that the console has no errors or warnings
other than the two blocked external requests (a font stylesheet and an
analytics beacon) and one known warning: both builds log `[tiles] detail crop
failed — keeping the previous crop: Error: sheet not open` while the closed tab
is reopened, and again on the tab switches. It comes from the tile workers,
not the pdf.js document cache, and is the same stale-detail warning noted in [the #508 review](../508/README.md);
the JSON records it. No uncaught page errors.

The counts are pdf.js workers, not resident or GPU memory; renderer memory is
not recorded by this script. This
covers one browser and one synthetic plan set. The sample's pages are 3024 ×
2160 pt.

[Baseline JSON](baseline.json) · [Fixed JSON](fixed.json) · [No-pins JSON](no-pins.json) · [Fixed screenshot](fixed.png) · [Baseline screenshot](baseline.png)

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

To check that the tab switches catch broken pinning, in
`src/pages/TakeoffCanvas.jsx` make the document cache's `pinned` return `[]`,
build with `node node_modules/vite/bin/vite.js build --outDir /tmp/no-pins`,
restore the file, and run the script (without `BASELINE`) with
`/tmp/no-pins` as the second argument. It fails the tab-switch check.

The baseline run records the same numbers and checks only that the scenario
ran (the tab lists it opened and closed). The script serves the built app with
`vite preview` on 127.0.0.1:5261 and aborts every other request. It writes its
JSON before it reports failed checks, so a failing run still
leaves its record. The first tab is opened by clicking `set-10`'s **View**
button in place; scrolling down to it would draw, and so load, that row's
thumbnails first. The screenshot is the gallery right after the search,
before the previews. Set browser paths to your own Playwright installation.

## Not covered here

- Local (IndexedDB) projects only. A cloud project keeps the PDF bytes it
  downloads for the session (up to 256 MB; 64 MB on a phone or tablet, or a
  browser that reports 4 GB of memory or less), so a destroyed document opens
  again without a second download. That needs a Google account, so the cloud byte
  cache is unit-tested only (`web/test/cloudStore.test.ts`,
  `web/test/pdfBytes.test.ts`).
- How long a destroyed document takes to open again is not measured.
- Live counts are sampled after 2 s of quiet, so a transient peak while
  documents are leased can exceed the cap.

The idle cap, leases and recency order are unit tested in
`web/test/ocrSheetSource.test.ts`, and the files kept for open tabs and
stitches in `web/test/pinnedFiles.test.ts`.
