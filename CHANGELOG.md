# Changelog

All notable changes to OpenTakeoff. Dates are release/merge dates on `main`.

## 2026-07-09

### Fixed
- **One-Click Area now traces hatch-lined rooms to the walls (#32).** Rooms whose
  floor is filled with a CAD hatch/finish pattern were undercounting — the fill
  stopped at the first ring of pattern linework instead of reaching the walls
  (measured ~31.5% sheet-wide undercount on a real finish plan). One-Click now
  escalates past a room's hatch when the strict fill is meaningfully bounded by
  it, but only accepts the larger result if it stays enclosed and the area grows
  within a bounded factor — so a stray line misread as hatch can never balloon or
  spill the measurement. Recovers 18 undercounting rooms on the bundled sample
  plan; wall-bounded rooms are unchanged.

### Added
- **One-Click fill sensitivity (#32).** A slider on the toolbar (shown while
  One-Click Area is active) dials how far a fill reaches past a room's hatch
  pattern, with detents at **Strict** (stop at the linework — original behavior),
  **Balanced** (recover hatch-lined rooms to the walls — default), and
  **Aggressive** (cross more pattern, tolerate more growth). It still tunes
  0–100% freely and snaps to a notch when released near one. Lower it if fills
  spill; raise it if hatched rooms come up short. Remembered per browser.
- **Stamp system — reusable annotation stamps (#40).** Define an annotation once,
  save it to a **browser-wide library** (the first cross-project asset), and drop
  it onto any sheet with a click — a reusable tool-chest for shop-drawing
  markup. In the **Stamps** tab of the left dock, **Place** arms a stamp, then each
  canvas click instantiates it as **normal, editable markups** (a number bubble
  prompts for its value on placement). A fresh library seeds three flooring
  directional marks — **plank/tile direction**, **seam direction**, and **pattern
  origin**; everything else comes from import or save-as-stamp. Save any selected
  markup as a new stamp; rename/delete from the palette; **export/import** the
  library as JSON (import merges) so a crew shares one standard set. Two new markup
  primitives ship with it — **arrows** (leader + arrowhead) and **bubbles** (circle
  + centered text) — both selectable, movable, recolorable, and burned into the
  Marked Set PDF like every other markup.
- **SVG symbol import.** The stamp palette's **Import** also accepts an `.svg`
  file, baking its vector shapes (path, rect, circle/ellipse, line, polyline,
  polygon — with group transforms flattened and colors normalized to hex) into a
  high-fidelity, still-vector `svg` stamp element that renders crisp on canvas and
  in the Marked Set PDF at any zoom. Unsafe content (scripts, external refs,
  DOCTYPE entities) is rejected; the input is size- and shape-capped. Bring real
  shop-drawing symbols — transition strips, detail bubbles, north arrows — into the
  library instead of hand-drawing them.
- **Unified left dock.** The **Markups**, **Stamps**, and **RFIs** panels — which
  previously floated at the same spot and overlapped — are now one docked panel on
  the left with a tab strip. One tab at a time; it reflows the canvas instead of
  overlapping, mirroring the docked Takeoffs panel on the right.

## 2026-07-08

### Added
- **Per-markup color.** Any revision cloud, callout, text note, or highlight can
  be recolored from a palette swatch on its markup-panel row (or reset to
  **auto** — cobalt when linked to an RFI, amber otherwise). The color drives the
  drawn mark on canvas and in the Marked Set PDF, and is lightened automatically
  on the dark view so a dark color never vanishes. RFI linkage is now shown by an
  **unconditional ⬢/number badge** independent of the note text, so a recolored,
  note-less linked cloud still reads as linked.
- **Line styles.** Conditions and markups carry a **solid / dashed / dotted /
  dash-dot** outline style (a picker beside Line/Fill/Hatch for conditions, on
  each markup row). It applies to positive **floor-area** and **linear** outlines
  and to markup borders/leaders — on canvas **and** in the Marked Set PDF.
  Surface (wall) runs keep their dash-dot identity and deducts keep their
  danger-red dashing; both are exempt.
- **Highlight box markup.** A new **Highlight** markup tool drops a translucent
  filled box over an area (two corners, like the cloud). It renders behind the
  other markups so it never dims them, takes a color and line style, an optional
  note (double-click to add), and can be linked to an RFI. A non-highlight markup
  under a highlight stays clickable.
- **Inline note editing.** Placing a cloud, callout, or text note now types the
  note directly on the plan in an inline field — no browser prompt. Double-click a
  markup (Select tool) to re-edit it in place; the markup panel's ✎ edits notes on
  markups that are off-screen or on another sheet. Enter commits, Esc cancels — and
  cancelling a cloud's optional note keeps the drawn cloud.
- **Drag to move a markup.** With the Select tool, drag a placed markup (cloud,
  highlight, callout, or text note) to reposition it; the leader on a callout moves
  with it.
- **Show/hide the markup layer.** A **Hide layer** / **Show layer** toggle in the
  markup panel header hides all markups on the canvas and suspends their
  hit-testing (you can't click-select or delete a hidden markup; flying to one
  from the RFI register reveals the layer first) — the escape hatch when a
  highlight shields the takeoff beneath it. It's independent of the Marked Set
  export toggle below — hiding the canvas layer never changes the PDF.
- **Scalloped revision clouds in the Marked Set PDF.** Clouds now export as true
  scalloped outlines (approximated as cubic beziers so the arcs survive the page
  transform) instead of the old dashed-rectangle stand-in, in the markup's color
  and line style.
- **Revision deltas (△n).** A cloud can carry a revision number, drawn as a small
  numbered triangle at a corner — on canvas and in the Marked Set PDF. Set or
  clear it from the cloud's markup-panel row; absent = no delta.
- **Markup line weight.** Each markup takes a stroke-weight multiplier
  (0.5×–3×, default 1×) from its panel row, thickening its outline/leader on
  canvas and in the PDF (the selection halo scales with it). Conditions are
  unaffected.
- **Include-markups toggle for the Marked Set.** A **Markups** checkbox in the
  report toolbar (default on) omits all markups from the Marked Set PDF when
  unticked; the RFI-only export still works. It's separate from the canvas layer
  hide.
- **RFI register.** Any markup (revision cloud, callout, or text note) can be
  promoted to a tracked **Request For Information**: **Raise RFI** on a markup
  row mints `RFI-001…`, tints the markup cobalt, and opens the register (⬢ on
  the right rail). Each RFI carries subject, question, status (Open → Answered →
  Closed / Void), ball-in-court, priority, cost/schedule impact flags, dates,
  and a response — with the response date auto-stamped on the Open→Answered
  transition. One RFI links to many markups (**Link existing** / **Unlink**);
  deleting an RFI clears the link on every markup it touched (the annotation
  stays). **Fly to** any linked markup jumps to its sheet — opening it first if
  needed — and centers it, even across sheets.
- **RFI export.** An **RFI log** (CSV / JSON) in the Report, the RFIs embedded
  in the report **JSON**, and a dedicated **RFI schedule page** in the
  **Marked Set PDF** — with each linked markup carrying its RFI number burned
  onto the sheet (drawn even when the markup has no note). A live RFI that has
  outlived its markups still exports (cover + schedule, no per-sheet pages).
- **Select & delete markups on canvas.** With the **Select** tool (`V`), click a
  placed markup to select it (a white-ringed cobalt halo, visible even on
  cobalt RFI markups) and `Backspace` / `Delete` to remove it. Shape and markup
  selection are mutually exclusive.
- **Material library (Materials tab).** Reusable materials, browser-wide, in a
  new panel tab. Copy-on-attach semantics: attaching copies the values onto the
  condition and keeps a link, so totals, exports, and old snapshots never
  depend on the library. Linked lines mark overridden fields in amber with
  per-field revert; library edits reach linked lines only via an explicit
  "update linked (N)" push; deleting a library material detaches links and
  lines keep their values; "→ lib" promotes any condition material into the
  library. New meta-store key, no DB version bump. (#47, #48)
- **Docked Takeoffs panel — the new home for conditions (#38).** The conditions
  bar and its stacked editor rows are gone; a docked, resizable, collapsible
  panel on the right now holds the condition list (running totals, shape
  counts, inline assemblies, per-row delete, reassign-selected) with the full
  property editor unfolding under the active row. Width, collapse, and view
  prefs persist per browser (localStorage, diff-only). (#41, #42)
- **Panel at scale.** Live filter, A→Z natural sort (CT-2 before CT-10), and
  tag-family grouping with collapsible headers — all strictly view-only, so
  the positional `1`–`9` hotkeys and the saved payload never change. ⌘/⇧-click
  multi-select with bulk waste / line color / delete (confirm counts affected
  takeoffs). ⌖ or double-click zooms the canvas to a condition's takeoffs.
  (#44, #45)
- **Condition template library.** A Library tab stores reusable condition
  templates browser-wide (appearance, waste, H/T, materials). Save the active
  condition, apply templates anywhere, rename/remove inline; fresh workspaces
  seed from the library and fall back to the built-in flooring defaults. No
  IndexedDB version bump — a new key in the existing meta store. (#46)
- **Optional compact strip.** The old horizontal bar survives as an opt-in
  strip (panel header toggle) rendering the same state — activate, reassign,
  hotkey badges, + condition — for small projects with the panel collapsed.
  The transient status message now floats bottom-center over the canvas. (#43)
- **Columns tab.** The custom-columns manager (define columns/values) moved
  from the toolbar strip into a Columns tab in the docked panel; per-condition
  assignment lives in the active row's properties. Same data model and report
  behavior as below. (#49)
- **Custom condition columns + report grouping.** Define project-level custom
  columns (e.g. **CSI Division**) with selectable values and assign one per
  condition — as shipped, columns are managed in the docked panel's **Columns**
  tab and assigned in the active row's properties (this landed on the
  since-retired condition bar; see the Columns tab entry above). Renaming a
  value updates every assigned condition; deleting one keeps the data, shown
  as "(removed)". The report
  gains a unified **Group** select: by **sheet** (ordered quantities — waste
  and ×N applied per sheet slice, subtotaled per group) or by any custom
  column, with the grouping named on the printed page. Custom columns join the
  report's column picker (hidden by default), append to CSV/XLSX after the
  frozen columns, and ride the JSON export additively; grouping by a custom
  column force-includes that column in CSV/XLSX. (Sheet grouping restructures
  the on-screen/printed table only — exports keep the flat conditions table
  plus the existing base-quantity by-sheet section.) Projects that never use
  the feature produce byte-identical payloads and CSVs. (#31, #33–#36)

### Changed
- Callout leaders now end in a filled **arrowhead** (on canvas and in the
  Marked Set PDF), replacing the old target star.

### Fixed
- **Report print: the "By finish" materials line wraps at the page edge.** The
  mapped nowrap spans had no whitespace between them, so a long summary was one
  unbreakable run that overflowed the printed page; entries now move to the
  next line as a unit and wrap internally when a single entry is wider than
  the line. (#27)
- **Corrupt browser-global libraries can no longer wedge or wipe every
  project.** The condition-template and material-library records are shared
  browser-wide, so one malformed or duplicate-id item used to throw inside
  hydrate — or break `matLibById` and the Materials tab's row keys — and take
  down every project at once. Both now sanitize on load (non-array records
  reset to `[]`, items need a well-formed id, duplicate ids dedupe
  first-wins), so a bad record can only lose the bad item, never the project.
  (#50 review follow-up)
- **Takeoffs panel review follow-ups.** Bulk waste/color/delete confirms now
  count and name the actual live selection instead of a stale one; the
  transient status bar auto-dismisses after ~6s instead of lingering, but a
  failure ("Couldn't save…") or the stale-tab reload notice stays put until
  you act on it or replace it; the active condition stays reachable even when
  the filter or a collapsed tag-family group would otherwise hide it; the
  library re-reads on tab focus, narrowing the multi-tab last-write-wins
  window; and dragging the panel's resize handle no longer commits width
  (and re-renders the canvas) on every pointer move, only once on release.
  The panel also moved out of `TakeoffCanvas.jsx` into its own
  `TakeoffsPanel.jsx` component along the way. (#50 review follow-up)

## 2026-07-07

### Added
- **Excel export.** An **XLSX** button in the Takeoff report downloads a
  four-tab workbook — **Conditions** (follows the same Columns picker as the
  CSV), **By sheet** (measured base quantities), **Materials** (per-condition
  lines + combined buy list), and **Shapes** (per-shape measured detail). The
  SpreadsheetML is hand-rolled in-browser and zipped with the already-bundled
  fflate (lazy-loaded on first use) — no SheetJS, no exceljs, no new
  dependency. Same numbers as the on-screen table: waste applies only to order
  quantities, never to measured values. (#16)
- **Continuous deployment.** Merges to `main` now auto-deploy to
  [takeoff.345flooring.com](https://takeoff.345flooring.com) via a GitHub
  Actions workflow that re-runs the full check (typecheck + tests + build) and
  publishes `web/dist` to Netlify with `--no-build`.
- **Local/CI parity.** Node is pinned by `web/.nvmrc` (22) and read by both nvm
  and CI; `npm run check` runs the exact CI sequence locally. `main` is
  protected: PRs only, green `web` check required, branch up to date, no
  force-pushes.

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
- **Crisp detail-view canvas** — past ~1.15× zoom the visible region re-renders straight from the PDF vectors at the current zoom (AutoCAD-style), so deep zoom never pixelates.

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
