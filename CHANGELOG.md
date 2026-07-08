# Changelog

All notable changes to OpenTakeoff. Dates are release/merge dates on `main`.

## 2026-07-07

### Added
- **Per-material coverage presets.** The adhesive-only trowel picker grew into per-material-type presets (new pure lib `web/src/lib/coverage.js`): adhesives get real trowel-notch and roller options (PSA through coarse wood notches, SF/gal), and mortar/thinset lines get their own trowel presets (SF per 50-lb bag). All values are generic industry-typical spread rates — always verify against the product data sheet.
- **Grout calculator.** A grout line now derives its coverage from tile geometry instead of an opaque number: enter tile length × width × thickness, joint width (1/32″–1/2″), and bag size inline on the material row, and the SF/bag rate plus a show-your-work note (e.g. `12×24×3/8″ @ 1/8″ · 25 lb`) fill in automatically. The CT-1 starter condition ships with the derived rate.

### Changed
- The old `fine` / `medium` / `standard` / `coarse` trowel preset labels retire in favor of explicit notch sizes. Materials that saved one of those labels keep their note and coverage rate — the picker just no longer pre-selects it.
## 2026-07-08

### Added
- **Metric units for EU plans.** A `ft`/`m` toggle beside the scale picker switches the whole display layer: readouts, shape chips, the takeoffs panel, the Report, CSV, and the Marked Set legend read in m² / m (the SY column retires in metric). Calibrate by typing **meters**, and the scale list gains the ratio presets — 1:20, 1:25, 1:50, 1:75, 1:100, 1:125, 1:200, 1:250, 1:500 — which auto-detect from title blocks too. All stored data stays in feet internally, so toggling units never rewrites a takeoff. Supporting-material coverage rates stay as entered (SF/LF-based) for now.
- **Fleur-de-lis hatch.** A new pattern takes the Sand/dots slot in the picker (16 stays 16); anything already painted with dots keeps rendering.
- **Highlighter strokes are pickable.** With Select, click a stroke (cobalt glow), drag to move it, Backspace/Delete to remove it.

## 2026-07-07

### Added
- **Highlighter.** A freehand marker under Markup (`H`): press and drag to paint — real ink feel, stroke after stroke, no dialog between strokes. A style popover under the Markup menu offers five inks (yellow default), **F/M/B** tip sizes, and a **chisel or round** nib (remembered per browser). Strokes capture with distance thinning, preview imperatively (no React render per move), stick to their sheet, scale with the plan like drawn ink, and **export into the Marked Set PDF** in their own color (chisel = ribbon fill, round = round-cap stroke). Because press-drag paints, press-drag panning is unavailable while the highlighter is armed — Space/middle/right-drag still pan. The pure stroke geometry (`thinStroke`, `strokePathD`, `chiselRibbon`) lives in `web/src/lib/geometry.js` with tests.

### Changed
- **Hatch patterns redesigned.** The 16 condition hatches retuned as a set: two stroke weights (dense/dual-family patterns draw lighter so nothing shouts), per-pattern tile sizes, even pitches, and ~8–16% ink coverage across the board — brick now staggers like running bond, plank reads as long boards, checker/dots/speckle calmed. Dark view gets brighter stroke alphas baked into the pattern. The Marked Set PDF's hatch approximations follow the new pitches. A hidden `?hatchqa` QA wall renders every pattern at three scales in two colors for future retunes.
- **Hatch picker reorganized.** A 4×4 grid of larger swatches with a caption line that names the pattern under the cursor (or the current selection) — no more squinting at a 26px tile.
- **"Cut Out" is now "Eraser".** The toolbar menu and its tools read Erase shape / Erase rectangle (`D` / `⇧D`). Labels only — the takeoff math is unchanged, and existing deduct shapes are untouched.

## 2026-07-05 (evening)

### Fixed
- **No more flashing when zoomed in.** Past ~115% zoom, every pan or zoom settle used to wipe the sharp detail overlay and let pdf.js paint its white page background straight onto the screen while it re-rendered — a white blink on every touch, blinding in dark view, and the sync loop could fire it several times per gesture. The detail region now renders into an offscreen buffer and swaps in atomically: the previous crisp crop stays up until its replacement is fully painted, and identical re-requests are dropped.
- **Dark view sticks at high zoom.** Toggling ☾ while a detail re-render was in flight skipped the visible layer (its inverted-state record was cleared at render start), so the screen stayed light and the toggle looked dead. The record now lives with the pixels — the toggle always flips what you see.
- **One-Click Area now traces rooms with solid (poché) walls under a tile grid.** Plans that draw walls as filled shapes — like the bundled VA sample's tiled toilet rooms — used to come back as "dense linework" guards: the wall's short outline edges sat exactly on the tile pitch, classified as hatch, and the escalated fill leaked through what is actually solid ink. Filled-not-stroked outlines are now never hatch-transparent, and a row spanning far beyond the pattern's median row stays a hard boundary. The failing click (tiled toilet, one click) now returns the room — verified end-to-end on the sample plan and locked in with a regression test.

## 2026-07-05

### Fixed
- **One-Click Area works on hatched rooms.** Hatch/poché linework used to be burned into the flood-fill's boundary mask exactly like walls, so a click inside a hatched room got trapped between hatch lines — and a wall-to-wall tile grid silently returned one tile as if it were the room. The extractor now emits per-segment metadata (paint op, curve chords, device line width), a classifier marks families of regularly-pitched overlapping parallel rows as hatch, and the fill escalates: strict pass first (identical to the old behavior), hatch-transparent retry only when the strict pass comes back trapped or predominantly hatch-bounded. A failed escalation returns the strict result — a misclassified wall can never make the tool worse. Also fixed: geometry inside form XObjects now lands where it draws (their matrix was ignored).

### Added
- **Dark view (negative print).** ☾ in the zoom cluster — sheet pixels inverted in place (one difference-with-white pass; no CSS filter layers, so dark composites exactly like light), hatches and fills get dark-tuned alphas, and the setting persists per browser.
- **Marked Set PDF export.** One click in the Takeoff report downloads a distribution-ready PDF, built entirely in the browser: every sheet carrying takeoffs or markups with the work burned in as drawn — condition colors, clipped hatch linework, per-shape quantity chips, count markers, cobalt markups — plus a legend cover with per-condition net totals, waste-adjusted order quantities, and a by-sheet breakdown. Exports in your current view: dark canvas → dark PDF (inverted raster base, true-color overlays).

### Changed
- Quantity math now has one home: the HUD and Takeoffs panel read the same `conditionTotals()` rules the Report uses (still scoped to the visible sheets), and the vertical-wall metric moved to `totals.js` with tests.
- Pure canvas geometry (angle lock, hit-testing, snap grid, star/cloud paths, metrics) extracted to `web/src/lib/geometry.js` with its own test file; 12 unused icons pruned; `MAX_GROUP` now lives once in `lib/sheets.ts`.

## 2026-07-02

### Fixed
- **Conditions are always visible at every zoom.** The canvas zooms via a CSS transform on the stage div, which never enters the SVG's coordinate system — so `vector-effect="non-scaling-stroke"` (used on every shape) was a silent no-op: outlines went sub-pixel-invisible at overview zoom and fat at deep zoom. Every screen-relative stroke/dash/handle size now divides by the stage scale, and below 35% zoom a shape's hatch fill (which aliases into invisible sub-pixel mush) swaps for a clear solid tint of its condition color — the marked-up set reads like a map from fit-to-sheet.
- **The overlay tracks your gestures live.** Labels, outlines, and the low-zoom tint now update ~11×/s *during* a pan or pinch instead of snapping into place 80 ms after you stop; drag-pan coalesces to one transform write per frame; the detail view waits out active gestures so its crop is never wiped mid-pinch.

### Changed
- **Hi-Res is now an auto quality budget — and works in side-by-side groups.** The fixed 1.75× raster multiplier is gone; a hi-res sheet re-rasters to a ~28-megapixel budget (~112 MB), which bounds memory well enough that the old single-sheet-only restriction is lifted. Crispness past 1:1 still comes from the vector detail view, which now engages devicePixelRatio-aware (no upscaled-soft band on Retina displays) — and the deep-zoom ceiling more than doubles (`MAX_SCALE` 14 → 32). Quantities are unaffected: geometry is stored normalized and the raster scale cancels in the math.
- **Panel toggles moved to a right-edge rail.** The markup and takeoffs buttons left the toolbar for a slim vertical rail on the canvas edge (zoom-cluster style), so the toolbar never wraps onto an extra row on narrow windows; the takeoffs panel docks beside the rail and its lit toggle closes it.

## 2026-07-01

### Added
- **45°/90° angle lock (polar tracking).** While tracing Area / Linear / Surface / Deduct (and the calibration line), the segment locks to the 45° family (0°, 45°, 90°, 135° across the sheet) whenever the cursor comes within ~4° of an axis — and **the click commits the exactly-on-axis point**, so walls come out dead square. Hold **⇧** to force the lock at any cursor angle. New **45°** toolbar toggle (on by default) next to Snap; endpoint Snap takes priority over the angle lock.
- **The crosshair is the cursor.** The OS pointer hides in draw modes; full-page **luminous cobalt aim hairlines** (1.5px core, fine white edge, soft bloom) meet at the house **star mark**, and in-progress work draws in the instrument's own cobalt (committed shapes keep their condition color). Lock feedback is quiet: the star swells and glows, the hairlines deepen, the **solid** (dash-free) preview line thickens, and a chip by the cursor reads the locked angle plus the live segment length — or `snap` when an endpoint snap wins. Design intentionally avoids viewer-style chrome: three heavier drafts (frosted reticle, magnifying loupe, glass pickets) were cut the same night in favor of this instrument feel.

### Docs
- New `CHANGELOG.md`, `AGENTS.md` (map of the repo for coding agents), `FEATURES.md` (capability → code), `web/public/llms.txt`, and GitHub issue/PR templates.
- User guide: new "Angle lock (45°/90°)" section + ⇧ shortcut row.

## 2026-06-28
- **Crisp detail-view canvas** — past ~1.15× zoom the visible region re-renders straight from the PDF vectors at the current zoom (Bluebeam/AutoCAD-style), so deep zoom never pixelates.

## 2026-06-23
- **Bundled sample plan** — a real (public, architect-sealed) medical-center floor finish plan with one-click **Load sample plan**; social card + README hero.

## 2026-06-19 → 06-22
- **WD-1 hardwood condition + assemblies** — trowel-aware adhesive, sealer/poly finish assemblies with real coverage rates (vendor-neutral).
- **Takeoffs panel** — edit assemblies and delete conditions inline.
- README rewrite, user guide + screenshots, one-click Netlify deploy button, SEO/OG pass.

## 2026-06-18
- **Relicensed MIT → Apache-2.0** (PRs #1–#2).
- **Supporting materials (assemblies) per condition** — coverage rate + basis → rounded order quantities; full condition edit/delete.
- **Ingest** — PDFs, images, and `.zip` plan sets through one in-browser path.

## 2026-06-15
- **Initial release** — open-source PDF takeoff canvas for flooring: One-Click Area, manual measure kit, per-sheet scale (auto-detect + calibrate), conditions with CAD hatches, waste %, reports with SF/SY/LF/EA and CSV/JSON export, client-only storage.
