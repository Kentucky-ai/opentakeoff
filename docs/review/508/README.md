# Tile-worker document cleanup (#508)

Closing a sheet now removes its entry immediately, rejects its own readiness,
cancels its tile work, and destroys its retained pdf.js loading task. Destruction
failures are caught. A pending pdf.js promise is allowed to remain pending;
our ready/render waiters are not. Identity guards suppress obsolete success and
failure callbacks. An open ID also protects the pool from a reply already queued
before close/reopen. Unclaimed transferred bitmaps are released.

## Measured browser behavior

October 3, 2026, macOS arm64, Chromium 153.0.8010.12, Classic layout, the bundled
`web/public/demo/sample-finish-plan.pdf`, five workers. Each Next/Previous flip
waits for rendering requests to settle before continuing. Baseline: main
`788e39bf`. The screenshots contain only the public bundled sample.

| Next/Previous flips | Expected fonts per worker | Baseline observed | Fixed observed |
|---:|---:|---:|---:|
| 0 | 5 | 5, 5, 5, 5, 5 | 5, 5, 5, 5, 5 |
| 10 | 5 | 55, 55, 55, 55, 55 | 5, 5, 5, 5, 5 |
| 30 | 5 | 155, 155, 155, 155, 155 | 5, 5, 5, 5, 5 |

The 6048 × 4320 sheet canvas has the same RGBA SHA-256 before/after the change,
and at 0/10/30 flips: `9d3f845f35d635d88ba6e275b5266fc208df2b1055444e63bede75411f7a8258`.
No uncaught browser errors. Both builds log the existing stale-detail `sheet not
open` warning during navigation; it is not evidence of a new rendering failure.
This measures retained fonts, not total resident or GPU memory, and covers this
browser and sample rather than every PDF/browser combination.

[Baseline JSON](baseline.json) · [Fixed JSON](fixed.json) · [Fixed screenshot](fixed.png)

## Reproduce

Use Node 24 and stage the normal OCR deployment assets for the app build:

```sh
cd web
npm ci
node scripts/stage-ocr-model.mjs
npm run check
node --import tsx --test test/tileWorkerCore.test.ts test/tilePool.test.ts
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER_PATH=/path/to/chromium \
  node scripts/verify-tile-cleanup.mjs ../docs/review/508/fixed.json
```

To compare, build main `788e39bf` in another checkout, then run the same script
with `BASELINE=1` and its absolute `web/dist` path as a second argument. The
script instruments Worker messages for settling and reads workers' FontFaceSets;
it does not replace the renderer or its results. Set browser paths to your own
Playwright installation. The script's local preview binds only to 127.0.0.1.

Nine focused Node tests exercise old-load resolve, reject and never-settle cases;
late getPage success/failure; teardown rejection; active and queued renders;
individual cancellation; idempotent opens; and queued stale pool replies. Each
same-key reopen has exactly one new ready reply, no stale sheet error, and can
render its next tile. Worker rendering still uses the same viewport, transform,
OffscreenCanvas and dark-mode inversion.
