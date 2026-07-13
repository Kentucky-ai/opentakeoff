# Changelog

All notable changes to OpenTakeoff. Dates are release/merge dates on `main`.

## 2026-07-12 — v0.3.0

### Added
- **Excel (.xlsx) export** — the Report gains a real workbook next to CSV/JSON: **Summary** (per-condition breakdown + grand total), **By sheet** (base measured quantities per sheet × condition, for reconciling against the drawing set — multiplier and waste stay condition-level concerns), **Materials** (per-condition needs + the combined buy list), and **Shapes** (the per-shape audit trail; deducts carry their sign). A hand-rolled SpreadsheetML writer zipped with fflate (already a dependency, lazy-loaded at click time) — no SheetJS, no exceljs. Strings always go out as inline strings so a formula-shaped condition name stays inert text; numbers keep full precision in the cell with display rounding done by number-format styles, so the workbook shows what the report shows while staying exact for downstream arithmetic. Bold frozen headers, content-derived column widths, autofilter over the data rows only. Validated end-to-end with an independent parser (openpyxl).
- **Revisions** — bid revisions and addenda as data. Save the takeoff (conditions, shapes, markups) as a named revision (IndexedDB schema v2, new `revisions` store), then **compare any two — or a revision against the live takeoff — as quantity deltas** per condition, per sheet, and on the supporting-materials buy list, with a compare CSV export. The diff is deliberately quantity-level, not geometric: conditions pair by id with a finish-tag fallback (ordinal-keyed so duplicate tags can't collide), "changed" is judged at display precision so sub-display re-trace wobble reads unchanged, and a waste-only edit moves exactly one column — the ordered quantity. **Restore is never a one-way door**: it auto-banks the live takeoff as a revision first. New Revisions rail toggle (clock icon).

### Security
- **CSP + security headers on the deploy** (`netlify.toml`): `script-src 'self'` + wasm, no `unsafe-eval` (pdf.js verified working under it); `connect-src` stays open on purpose for the BYO-AI and capture seams. Verified enforcing with zero app violations.
- **Zip-ingest bounds** — the plan-set unzip path gains caps (entry count, shared decompressed budget, per-entry pre-decompression size, nesting depth) so a hostile archive can't balloon the browser.

### Fixed
- **Zoom/fit/dark buttons no longer fire the armed tool** — a left press on the canvas-corner button stack stopped propagating, so clicking ⌖/☾ mid-measure doesn't drop a stray vertex (the documented One-Click-through-zoom-button bug).
- **Autosave guards** — the hydration echo no longer re-saves what was just loaded, and a failed load leaves autosave **disarmed** with a banner instead of clobbering the saved takeoff with an empty state.

### CI
- Least-privilege workflow token (`permissions: contents: read`), `.nvmrc` (Node 20), and a single `npm run check` entry point.

## 2026-07-11

### Fixed
- **A wall height override now survives copy/paste — and an explicit 0 never falls back to the condition height.** Copy and duplicate dropped the `height_override` flag, and paste spread `height_ft` on truthiness, so a wall deliberately overridden to `0 ft` pasted with no height at all and silently recomputed at the condition height. Overrides now ride with their value through copy/duplicate/paste, and `recomputeShape`/`describeShape` honor an explicit override outright — even zero — while legacy shapes keep the condition fallback. (`verticalWallSf` is untouched on purpose: it estimates wall SF from floor perimeters at the condition height, display-only.)

## 2026-07-09

### Added
- **Live-measure cursor readout** (parity with the commercial sibling). While drawing a **Rectangle**, the cursor chip reads live `12′ 6″ × 10′ 0″ · 125 SF · 13.9 SY` (m² in metric); **Linear/Area/Surface** traces read the running segment length always, not just under the 45° lock. The chip turns **amber when a run reaches 12′** — broadloom roll width, a seam falls here.
- **MCP server.** [`mcp/`](mcp/README.md) puts the takeoff engine on stdio for your MCP client: ten tools — `load_plan`, `sheet_info`, `set_scale`, `one_click`, `measure_polygon`, `measure_line`, `takeoff_summary`, `export_takeoff`, `delete_shape`, `read_sheet_text` — over the same `web/src/lib` engine the canvas runs, so an agent's committed shapes are field-identical to the browser's and `export_takeoff` emits the app's own `opentakeoff.takeoff_canvas.v1` save payload. The app's rules carry over: detected scales are suggestions an agent must adopt explicitly, measures refuse without a per-sheet scale, a bare `one_click` returns px-only numbers with a warning, and every one-click shape carries its provenance receipt. Vector+text sheets only for now (scans report themselves plainly; the raster seam is marked). Full guide with an agent transcript in [`docs/MCP.md`](docs/MCP.md); CI grows an `mcp` job (typecheck + session/tool/e2e tests against the demo plan).
- **Bring-your-own-AI (opt-in, dormant by default).** A new `AI` toolbar button opens settings for an endpoint **you** provide — OpenAI-style (the default; local runtimes speak it and need no key) or Anthropic-style — with the model id and an optional key stored in this browser only. First consumer: **read scale with AI** — when the text regex finds no scale note (scans, rotated notes, image title blocks) and AI is configured, a chip offers to send ONE snapshot of the title-block region to your endpoint; the reply maps through the same boundary-guarded scale matcher as the text path (`scaleFromLabel` in `sheets.ts`) and lands in the existing suggestion flow — `AI read 1/4″ = 1′-0″ — use` — never auto-applied, and the acceptance guide bar still shows. Unconfigured builds add zero UI beyond the button and make zero AI network calls. No telemetry. Dark-mode snapshots are un-inverted before encoding. The seam (`visionQuery` in `web/src/lib/ai.js`) is generic so future consumers (finish classification, room labels) reuse it.
- **One-Click Area on scanned plans.** Scans have no vector linework, so the flood had nothing to bound it — clicks just failed. A new raster fallback (`web/src/lib/rastermask.ts`, pure typed arrays, zero new dependencies) reads the rendered pixels instead: grayscale with a polarity check (negative/blueprint scans invert), a Bradley-style adaptive mean threshold over an integral image (shaded rooms and uneven illumination read correctly) with an absolute dark floor (solid walls stay solid), and one binary closing to bridge faded-ink dropouts. The mask feeds the SAME flood/trace/simplify machinery as the vector path. Triggering is automatic and conservative: the op-list walk now measures placed-image coverage, and pixels engage only when a sheet is mostly image — scan wrappers run raster-primary; a mixed sheet (photo underlay beneath real linework) retries on pixels only after the vector flood fails; a pure-vector sheet never touches pixels. Raster results skip corner snapping (a scan has no true endpoints), carry `raster_traced: true` provenance, and the proposal readout badges them: *traced from scan pixels — verify edges before Create*. Verified end-to-end: a rasterized copy of the demo plan traces the same room within 1.5% of the vector path.
- **Check a dimension (K).** A read-only twin of Calibrate: click both ends of a printed dimension string and the bar reads `measures 12′ 4″ at 1/4″ = 1′-0″`. Type what the drawing says and a verdict chip grades the error — green ≤1% (scale checks out), amber ≤5% (re-check), red past that (wrong scale) — with a one-tap **Recalibrate to this** that reuses the calibration math. The live cursor chip shows the running length in feet-and-inches while you pick the second end.
- **Scale-acceptance guide.** Accepting a scale — the standard dropdown, the "plan says … — use" chip (hover previews it), calibration, or the check tool's recalibrate — drops an ephemeral calibrated ruler bar on the sheet (a round length sized to the zoom, with foot/meter ticks and the caption *a door opening is about 3′*). A 2×-off scale is visually obvious before anything gets traced. Auto-dismisses in 8 s or on the next action; never saved.
- New pure display helpers in `web/src/lib/units.ts`: `ftIn` (feet → `12′ 6″`), `fmtCheckLen`, and `parseLenInput` (accepts `12.5`, `12'6`, `12' 6"`, `12-6`, meters in metric) — node-tested.

### Changed
- **Public imagery re-captured from the live app.** The old hero card and One-Click GIF pre-dated the July 5 fill fixes and showed rooms with unfilled door-swing bites — the engine has been better than its own marketing since. The new captures show what a click actually does today: the same three patient rooms on the bundled VA plan trace **wall to wall** (163 → 154.6 SF, 162 → 184.6 SF, 161 → 240.7 SF; same 579.9 SF CPT-1 total), plus a VCT clean-linen room for contrast. New `docs/img/one-click-area.gif`, `docs/img/social-card.png`, `web/public/og-card.png`; alt text updated to match.
## 2026-07-08 (night)

### Added
- **The capture layer.** [`capture/capture_server.py`](capture/README.md) — a stdlib-only local server (no pip install) that banks the app's opt-in Contribute payloads as (geometry → label) training rows in a corpus **you** own: one JSONL row per labeled shape, content-hash dedup so re-contributions never duplicate, a verbatim payload archive, and an optional `--mirror` that copies the label file whole and atomically into a synced share (OneDrive / SharePoint / Dropbox) after every capture. `serve` / `summary` / `selftest` subcommands; wire-up is one `localStorage` line. The README gains an **Own your data** section, and the Contribute modal now points here when no endpoint is configured. When the endpoint is one **you** set in the browser (the self-capture flow), the modal drops the shared-model framing and reads as what it is — **Capture this takeoff**: your endpoint, shown inline, your corpus, nothing shared.
- **PR ground rules.** CONTRIBUTING.md documents how pull requests work here — one concern per PR, issue-first for big changes, conventional commit subjects, the vendor-neutral rule, and review etiquette. A CODEOWNERS file auto-requests maintainer review, CI grows a capture-selftest job, and `main` is protected by a ruleset (PRs only, green CI, no force-pushes).

## 2026-07-08 (later)

### Added
- **Zone check.** A new toolbar tool: trace a region — an apartment, a wing — like you'd trace a deduct, close it (⏎ / double-click / Finish), and a panel lists every condition inside with quantities **and its materials scaled to the zone**, computed by the same rules as the Report. Shapes count by their center point and glow cobalt so inclusion is visible. Nothing is saved: redraw replaces the zone, Esc or leaving the tool clears it.
- **Sheet levels.** Select sheets in the gallery → **Assign level…** ("L1", "Garage"). The gallery groups by level (unassigned last, title-block order within), cards wear a level chip, and tabs + the page picker carry the label. Stored with the project.
- **Condition plays.** **⭑ Save play** stores a tuned condition — appearance, waste, full materials list — in this browser; **Plays ▾** applies it as a fresh condition on any project. No geometry or ids travel; re-saving a name replaces it.

### Fixed
- The live readout is height-capped with internal scroll so fully populated totals never cover the right-edge panel rail.

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
