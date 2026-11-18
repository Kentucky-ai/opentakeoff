# OCR seam patch height (#488, part 1)

#488 asked whether packing seam patches into one taller raster loses text, and
at what height. On the engine as it ships today, height did not lose text on
any sheet here. Packing also gave no reliable speed gain, so **the planner is
unchanged**. Measured November 2, 2026, at `c49de42`.

## Sheets

All six are public, with a vector text layer that serves as the answer key.
Each is rendered from its vector content and read as an image, at 216 DPI and
6 tiles.

| Sheet | Note |
|---|---|
| `public/demo/sample-finish-plan.pdf` pages 1 and 2 | Demo plan |
| `evals/four-asks-2026-09-02/sheets/va-dublin-bldg9a-finish-plan-A601.pdf` | |
| `evals/four-asks-2026-09-02/sheets/va-shreveport-fisher-house-site-utility-C300.pdf` | |
| `evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf` | |
| `evals/mcp-workflow-bench/plan-set/roseburg/va-roseburg-a03a.pdf` | No text layer, so no key. It gives patch counts only. |

## Results

### The raster #488 lost a line on

In Chromium on the wasm engine, using the committed fixture's tile reads:

| Plan | Patches | Height, render px | Lines | Clipped | Vector runs read | Patch time |
|---|---:|---:|---:|---:|---:|---:|
| `main` | 2 | 229, 96 | 630 | 0 | 38/41 | 2.4 s |
| Packed | 1 | 612 | 635 | 0 | 39/41 | 3.2 s |

612 render px is the 408 image px raster in #488. `PATCH FINISHES THIS AREA TO
MATCH EXISTING AS NECESSARY` now reads whole in it. The packed plan also picks
up `CONFERENCE/BREAK ROOM`. `VCT-1` and `ACT-1` are missed either way.

The loss in #488 predates the per-box engine (#496), which is the likely
reason it no longer shows. That is an inference: I didn't re-read the raster
on the older engine.

### Height sweep

Native ORT. Each line a seam cut is read again, centred in a raster of the
given height. Each run read by the line's own patch is checked again at that
height.

| Height, render px | Own length: runs kept | Full 4,094 px length: runs kept, centred | Same, a quarter of the way down | Mean read at full length |
|---:|---:|---:|---:|---:|
| 256 | 16/16 | 39/39 | 39/39 | 0.4 s |
| 408 | 16/16 | 39/39 | 39/39 | 0.6 s |
| 800 | 16/16 | 39/39 | 39/39 | 1.0 s |
| 1,600 | 16/16 | 39/39 | 39/39 | 1.6 s |
| 2,400 | 16/16 | 39/39 | 39/39 | 2.2 s |
| 4,000 | 16/16 | not run | not run | not run |

The own-length sweep has no Porterville lines, because that run went over the
16 GB memory guard. The full-length sweep covers all 39 straddling lines on
the four sheets that have any, one line per process. The 16 own-length lines
are on three of those sheets.

### Packing end to end

Chromium, fresh tile reads, with no height cap (the 4,000 px arm):

| Sheet | `main` patches | Packed patches | `main` runs read | Packed runs read | `main` time | Packed time |
|---|---:|---:|---:|---:|---:|---:|
| Demo page 1 | 1 | 1 | 7/7 | 7/7 | 0.4 s | 0.4 s |
| Demo page 2 | 1 | 1 | 37/41 | 37/41 | 0.8 s | 0.8 s |
| A601 | 3 | 3 | 13/13 | 13/13 | 0.6 s | 0.6 s |
| C300 | 1 | 1 | 27/27 | 27/27 | 2.1 s | 2.1 s |
| Porterville | 4 | 3 | 88/90 | 88/90 | 24.8 s | 23.9 s |

No arm lost a run. Porterville's 2,400 px arm also packs to 3 patches, and it
took 30.1 s against 24.8 s, so a cap can make a read slower. Time follows the
pixels read, not the raster count: the full-length sweep's 0.4 to 2.2 s
rises with height. Porterville's packed plan also returned 599 lines against
601, with the same runs read. That difference isn't explained here.

On native ORT, Porterville's tile reads plan differently: 6 patches on `main`,
3 packed, with recall 75/78 to 78/78 and patch time 1.9 s to 4.6 s. The sheets
get different plans on the two engines, so the fixture row and the Chromium
table are the ones to trust for the shipped app.

## Decision

- **Height doesn't need a cap for recall.** Nothing here was lost up to 2,400
  px at full length or 4,000 px at own length, and `main` already reads a
  3,008 px patch on Porterville.
- **The planner stays as it is.** A packing change bumps
  `SEAM_RULES_VERSION`, so every saved page read becomes a miss and is read
  again, and these sheets show no reliable time saved in exchange. In Chromium
  that's at most one patch fewer, with patch time from 4% faster to 32% slower.
- **The 27-patch case is still unmeasured.** It's the only reason to pack, and
  its sheet (finish key D in the #486 review) isn't in the repo. It was also
  read before the per-box engine. No sheet here came close: the most patches on
  any plan was 6. Only 2 of the 13 native patches on the five keyed sheets were
  stretched to the cap, each the only stretched patch on its sheet.

## Limits

- Six sheets and one engine build. This doesn't show that no sheet can lose
  text at height.
- A run counts as read if the joined text on its row holds it, allowing one
  edit per ten characters. Runs under 3 letters or digits are left out.
- These sheets are clean renders, not scans. The 27-patch sheet was a scan.
- Chromium times are single runs. The fixture table was repeated once, and its
  `main` time went 2.6 s to 2.4 s and its packed time 3.6 s to 3.2 s.
- Native ORT is not the shipped backend, and the native run has no split ink
  read, which only changes colored text.
- `packed` in `pack.ts` is a measuring stand-in, not a proposed planner. It
  doesn't apply the two refusal rules in #488, and it stretches only when the
  members' lengths don't fit the cap.

## Reproduce

From `web/`, on the pinned Node, after `node scripts/stage-ocr-model.mjs`.
Playwright is optional review tooling, installed outside the project. A native
tile read peaks around 7 GB of RSS, so run these under a memory guard.

```sh
# Chromium, fixture tiles: browser-pack.json, fixture_tiles
PLAYWRIGHT_MODULE=/abs/path/playwright/index.mjs BROWSER_PATH=/abs/path/chrome \
  node scripts/verify-ocr-patch-height.mjs out.json public/demo/sample-finish-plan.pdf:2 \
  --fixture=test/fixtures/ocr-seams/demo-sheet2-real.json

# Chromium, fresh tiles: browser-pack.json, fresh_tiles (list the sheets above)
node scripts/verify-ocr-patch-height.mjs out.json public/demo/sample-finish-plan.pdf:1 ...

# Native packing: native-pack.json
node --expose-gc --import tsx scripts/measure-ocr-patch-height.mts out.json SHEET.pdf:1 \
  --pack --heights=408,800,1600,2400,4000 --tile-cache=DIR

# Native sweep, own length: native-sweep.json, own_length
node --expose-gc --import tsx scripts/measure-ocr-patch-height.mts out.json SHEET.pdf:1 --groups=30

# Native sweep, full length, per line k: native-sweep.json, full_cap_length
node --expose-gc --import tsx scripts/measure-ocr-patch-height.mts out.json SHEET.pdf:1 \
  --groups=30 --long --offset --only=k --tile-cache=DIR --heights=256,408,800,1600,2400
```
