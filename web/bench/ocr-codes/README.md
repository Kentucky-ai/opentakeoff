# Public OCR code fixtures (#500)

These four invented finish schedules turn dropped-letter and punctuation mistakes
into reusable inputs for an OCR fix. The expected result is the printed code in
each of 48 cells. All text is made up; there are no construction-plan pixels,
project names, prices or bundled fonts. The frozen PNGs and their SHA-256 hashes
live beside [per-cell ground truth](../../test/fixtures/ocr-codes/truth.json).

This is a selected stress set, not an estimate of accuracy on real plans. It does
not reproduce the exact private `P1 → P` image. It reproduces the failure class
with public images, including `SS-2 → S-2`, `SS-3 → S-3` and `P-1 → P.1`.

## Measured baseline

Measured October 3, 2026 from main `788e39bf`, ppu-paddle-ocr 6.6.0,
the staged manifest/model revision and shipped engine options recorded in the
JSON files. Native: macOS arm64 / Node 24.18.0. Browser: headless Chromium 153.0.8010.12,
production OCR client and worker, ORT WASM, PNG RGBA input at zoom 1.
This bypasses PDF rasterization and schedule parsing, isolating recognition.

| Check | Expected | Native observed | Browser observed |
|---|---:|---:|---:|
| Exact cell identities | 48/48 | 38/48 | 37/48 |
| Arial 216 DPI control | 12/12 | 12/12 | 12/12 |
| Wrong single-box reads at confidence ≥0.95 | 0 | 4 | 4 |
| Wrong single-box reads at confidence ≥0.99 | 0 | 1 | 1 |
| Missing code cells | 0 | 0 | 0 |

| Image / printed code | Native read / confidence | Browser read / confidence |
|---|---|---|
| Times New Roman 100 DPI / `SS-2` | `S-2` / 0.973945 | `S-2` / 0.9755 |
| Arial Narrow 100 DPI / `SS-3` | `S-3` / 0.969499 | `S-3` / 0.9813 |
| Avenir Next Condensed 100 DPI / `P-1` | `P.1` / 0.992381 | `P.1` / 0.9917 |

Full evidence: [native](baseline-native.json), [browser worker](baseline-browser.json).
The browser has one additional low-confidence `P-1 → P.1` error in the Times
image. Backend results and confidence values need not agree exactly.

<img src="../../test/fixtures/ocr-codes/times-new-roman-400-100.png" alt="Invented 12-row schedule with printed SS-2 and P1 codes" width="406">

## Reproduce

From `web/`, with the repository's Node 24 version:

```sh
npm ci
node scripts/stage-ocr-model.mjs
node --import tsx --test test/ocrCodeFixtures.test.ts
node --import tsx scripts/measure-ocr-code-fixtures.mjs /tmp/ocr-native.json
# Exact-recognition gate: still exits 1 for known misreads.
node --import tsx scripts/measure-ocr-code-fixtures.mjs /tmp/ocr-native.json --strict
```

Run the shipped browser worker against the same bytes:

```sh
npx vite build --config bench/ocr-codes/vite.config.mjs
npx vite preview --outDir dist-ocr-codes --port 4174
```

Open `http://localhost:4174/bench/ocr-codes/index.html`, click **Read fixtures**,
then **Save evidence JSON**. Uncheck **Check short codes before import** to measure the original read alone. The button authorizes loading the staged models
from that local build. The worker uses the same models and engine options as
the application. This separate benchmark entry is not part of the app build.

Scoring assigns each recognized box by its center to the matching truth cell.
It keeps punctuation and compares to that row's identity, so `P1` read in the
`P-1` row is wrong even though `P1` is another valid row. Missing cells are
errors. Descriptions do not score as keys. Split boxes have no aggregate
confidence; the threshold counts concern single-box codes only. No threshold
is proposed as a safe acceptance rule.

The tests guard hashes, dimensions and scoring errors. They do not assert that
the OCR must keep making these mistakes. The optional strict runner requires
all expected codes; baseline JSON records known failures until a fix improves
them. The disagreement check below flags unstable readings without changing primary recognition accuracy. The original baseline files remain unchanged.

## Disagreement check

The production schedule-box reader now requests a second recognition view of
short code-shaped boxes: the same detected crop stretched horizontally by 2,
using the same recognizer and models. Detection and the primary text, geometry
and confidence are unchanged. Only a disagreement is carried to the import
reader. A code-cell disagreement starts that row unchecked, shows both readings,
and keeps **Select all** and group checkboxes from selecting it. The user can
correct its code or select that row individually. The alternate is never chosen
automatically: one fixture's `WWC` rereads as `WC`, and both are wrong.

| Check | Native | Browser worker |
|---|---:|---:|
| Primary exact cells (unchanged) | 38/48 | 37/48 |
| Wrong cells flagged / wrong cells | 10/10 | 11/11 |
| Wrong cells still unflagged in this set | 0 | 0 |
| Correct cells flagged for review | 2/38 | 3/37 |
| Clean Arial control exact / flagged | 12/12 / 0 | 12/12 / 0 |

Evidence: [native checked run](checked-native.json),
[browser checked run](checked-browser.json), [dialog assertions and timings](ui-check.json).
These are selected stress images, not a real-plan accuracy estimate. The public
images isolate recognition; the table reader does not extract a schedule from
all four tiny images. A word-level flag does not prove that its row imports.

The candidate check accepts short letter/digit code shapes (including a single
surviving letter and numeric misreads), at most 16 non-space characters, up to
1024 × 256 pixels. Prose, merged code-and-description boxes and missing detections
are not recovered. A consistently wrong second reading remains unflagged.
Agreement is not verification. Page OCR, cached text, Copy text, native text-layer
imports and the agent's text-layer reader do not request this pass.

Warm browser runs over all four images took a median **3.66 → 4.39 seconds**
with the check off/on (**19.9%** more, three paired runs on macOS arm64,
Chromium 153.0.8010.12). Model loading is excluded. This is the small fixture
set, not a full-sheet latency claim.

### Reproduce the check and dialog

```sh
# From web/, after npm ci and staging models as above:
node --import tsx --test test/ocrCodeCheck.test.ts test/ocrWorkerCore.test.ts test/ocrSeams.test.ts
node --import tsx scripts/measure-ocr-code-fixtures.mjs /tmp/ocr-checked.json --check-codes --require-flagged
npx vite build --config bench/ocr-codes/vite.config.mjs
# Optional browser automation, installed outside the repository:
npm install --prefix /tmp/ot-browser-review playwright
/tmp/ot-browser-review/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/ot-browser-review/node_modules/playwright/index.mjs node scripts/verify-ocr-code-dialog.mjs /tmp/ocr-code-review
```

`--require-flagged` fails if any wrong cell is unflagged or any correct control
cell is flagged. `--strict` still fails because the primary reads remain wrong.
The browser script checks all wrong cells are flagged, the control stays clean,
and every primary cell remains unchanged with checks on versus off. It warms
the models, records three paired runs, then checks bulk, group and individual
selection, editing `S-3` to `SS-3`, creation, and mobile overflow. `BROWSER_PATH`
can select an installed browser; record its version when comparing. The script
blocks external requests, including the app's Google Fonts request, so these
screenshots use system fallback fonts.

**Dialog evidence uses a constructed table.** Actual OCR code readings from
Arial Narrow 100 DPI are placed under invented CODE / MATERIAL / MANUFACTURER /
COLOR spans. Code readings and disagreement metadata are unchanged; headings,
descriptions and layout are constructed. This exercises parser-to-dialog
behavior separately from recognition, not table extraction from the PNG.
The 12 displayed rows include four review flags (three wrong codes and one
correct code). Bulk selection leaves those four unchecked.

<img src="dialog-desktop.png" alt="Twelve invented rows with four Check code warnings left unchecked after bulk selection" width="562">
<img src="dialog-mobile.png" alt="The same code-review dialog at a 390-pixel viewport with no horizontal overflow" width="358">

### Combined import safeguards (#499 + #500)

PR #511 now follows #510, which follows the public fixtures in #509. The import
dialog conflict is resolved with both notices and both selection guards present.
The browser reproduction command above also runs a separate constructed
three-row case. An existing `G-01C` keeps incoming `G-01(C)` locked even though
that row also has an OCR disagreement. **Select all** picks only clean `PT-1`.
Individually accepting uncertain `S-2` creates `S-2` and `PT-1`, with no duplicate
`G-01(C)`. Both notices fit at 390 px with no horizontal overflow. This interaction
case uses invented spans and disagreement metadata; it is not an OCR measurement.

[Combined assertions](combined-ui-check.json). The full combined web check
passes with 3,171 passed / 3 skipped. Render tests also check that skipped-code,
OCR and historical-identity notices each keep their own accessible description.

<img src="combined-guards.png" alt="A historical spelling stays locked while a separate uncertain OCR row is individually accepted" width="560">
<img src="combined-guards-mobile.png" alt="Both import safeguard notices and three invented rows fit at a 390-pixel viewport" width="358">

### Real-schedule spot check and remaining work

Two earlier private schedule crops were read locally through the production
216-DPI tiled box path. All 232 primary words (after the existing border cleanup),
their boxes/confidences, and the eight imported code identities stayed unchanged.
One crop still returned no table because of its existing header/layout limit.
The other returned eight rows; the known `WWC` misread now carries a review flag.
The known `88-2` misread rereads as `SS-2` and is flagged at word level, but the
numeric-only primary code is still omitted by the table reader. That omission
is not fixed here. These are local spot checks, not a public reproducible corpus;
no private pixels, document text, project names or file paths are included.

The next work for #500 is recovering unread rows without inventing identities,
and finding signals for wrong reads that remain stable across views. This change
addresses unflagged disagreement; it does not close every failure in #500.

## Image provenance

[The generator](../../scripts/make-ocr-code-fixtures.mjs) draws 7 pt type in
20 pt rows, a 65 pt key column and 195 pt description column, with the code
2 pt from the left rule. Three images use 100 DPI; the Arial control uses
216 DPI. Font families, weights, dimensions and row rectangles are recorded
in the truth JSON. Only raster output is distributed. Tests read these frozen
images and need no OS fonts.

```sh
# Requires the listed fonts, macOS canvas rendering used for the baseline.
# Writes separately and prints matches/DIFFERS; never silently replaces truth.
node scripts/make-ocr-code-fixtures.mjs /tmp/ocr-regenerated
```

All four hashes matched when regenerated on the capture machine. Another OS
or font version can draw different pixels; retain the frozen fixtures for
comparisons, or review a deliberate fixture revision with new hashes.
