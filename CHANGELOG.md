# Changelog

All notable changes to OpenTakeoff. Dates are release/merge dates on `main`.

## 2026-07-21 — opentakeoff-mcp 0.5.0

### Added
- **`detect_rooms` — the eleventh tool: batch room detection from the sheet's own labels.** One call reads every room-number label off the sheet's text layer and runs the One-Click flood at each; only cleanly-traced rooms return (a leaking or dense-linework label is silently withheld, matching `one_click`'s precision stance). Same contract as `one_click`: px-only preview without a scale, per-room `area_sf`/`perimeter_lf` with one, `condition` commits every detected room with the standard agent/unreviewed provenance stamp, and a declared `outputSchema` like the other ten.
- **A per-tool conformance suite backs the whole surface** (`mcp/test/conformance.test.ts`, closes #27): every tool's valid replies are schema-validated, every misuse path is a clean `isError` + JSON `{error}`, schema-invalid arguments pin the SDK's `-32602` surface, and the session is proven to survive every failure. Runs in CI on Ubuntu and Windows.

## 2026-07-20

### Fixed
- **Jagged, blocky linework on very large ingested images.** An ingested image becomes a 1 px = 1 pt PDF page, so a 7920×5280 scan minted a 7920-point-wide page — and the base raster's fixed ×2 scale then built a 15840×10560 canvas (669 MB backing store). The pixels in it were actually crisp, but a canvas that size blows past Chrome's GPU budget, so the compositor silently displays a degraded low-res proxy: giant nearest-neighbor blocks at any zoom, on that sheet only. `autoRenderScale`'s floor no longer overrides the physical caps — oversized pages now render below the ×2 baseline, inside the 28 MP panel budget (the existing `factorFor` scale plumbing already handles non-baseline rasters), and deep zoom stays sharp through the detail-view re-render as usual. Regression-tested in `web/test/renderBudget.test.ts`.

### Tests
- **MCP tool-conformance suite — every tool, both directions** (`mcp/test/conformance.test.ts`, closes #27). Each of the eleven tools now has: a canonical valid call whose `structuredContent` is validated against the tool's declared output schema and byte-checked against the back-compat text item; semantic-misuse cases proving a clean `isError` + JSON `{error}` reply (no-plan gates, unknown sheets, degenerate calibrations, unenclosed one-click seeds, non-PDF documents, unwritable export paths); and schema-invalid-argument cases pinning the SDK's `-32602` input-validation surface — with follow-up calls proving the session survives every failure. Also covers title-block sheet addressing, exact scale math on the demo plan, deduct-role subtraction, provenance receipts on export, and `read_sheet_text` region windows.

### Added
- **Curved Line tool (`Q`)** — like Linear, but the line bends smoothly through your clicks: radius walls, curved transitions, winding corridors. A centripetal Catmull-Rom spline (`web/src/lib/curve.js`) passes through every clicked point; LF is priced at the **true curved length**, not the chords, and a condition thickness yields border SF exactly like Linear. The shape stores only the clicked control points — drag one later and the curve re-smooths — while rendering, hit-testing, thickness re-flow, and re-scale re-flow all measure the flattened spline (vertex-capped, render-invariant). Curved shapes ride the normal linear schema plus a `curved: true` flag (declared in `docs/CONTRIBUTION_SPEC.md`); older readers degrade to the straight polyline through the points.
- **`detect_rooms` — the MCP server's 11th tool: batch room detection from the sheet's own labels.** Reads every room-number label off a sheet's text layer (`134`, `139A`, `OFFICE 101`) and runs the existing One-Click flood at each one in a single call — one round-trip instead of `read_sheet_text` + reasoning + N `one_click` calls. Only cleanly-traced rooms come back; a label that leaks or lands in dense linework is silently withheld, matching `one_click`'s own precision stance. Same contract: no scale set returns px-only quantities per room; pass `condition` to commit every detected room under that finish tag with the standard agent/unreviewed provenance stamp. Pure core lives in `web/src/lib/detectRooms.ts`.
- **Local-first sync, continued (Slices 5b–7).** A conflict defer-gate (`web/src/lib/canvasBusy.ts`) holds a remote sync adopt until the canvas is genuinely idle — covering trace/calibrate/check in progress, One-Click review, an active drag, the open text editor, an in-flight OCR scan, and (extended in review) the in-canvas agent mid-run or its staged proposals, so a background sync can never wipe unsaved or unreviewed work. The sync layer itself is gated behind a build-time flag (`VITE_CLOUD_SYNC=1`), never a per-user toggle. `docs/SYNC_ARCHITECTURE.md` documents the design: IndexedDB canonical, revision-precondition conflict handling (remote wins on real divergence, local is snapshotted first — nothing lost silently), and a provider seam so Drive can be swapped for OneDrive/SharePoint later.
- **A no-waste "Labor view" for the Report's Columns picker.** One click hides the waste-baked columns (Waste %, SF w/Waste, SY w/Waste) and surfaces the raw **Total SF** column (previously opt-in only) — a standalone quantity view tied directly to conditions, for anyone attaching their own labor rates externally. **Reset** returns to the default view.
- **Flip Horizontal / Flip Vertical**, in the Edit menu. Mirrors the selected shape about its own bbox center — an isometry, so SF/LF never change. Routes through the existing shape-command layer, so undo/redo and provenance stamping come for free. No keyboard shortcut (the single-letter tool hotkeys don't guard Shift). The Edit menu also gained a **Redo** label — `⇧⌘Z` already worked, it just wasn't listed.

### Changed
- **Report quantities that carry waste now read "w/Waste," not "SF ordered."** On-screen table, CSV, and Excel: `SF w/Waste` / `SY w/Waste` / `Total SF w/Waste` / `LF w/Waste`. Only display strings moved — the underlying `total_sf_net`/`sy_net`/`lf_net` keys and the versioned JSON export are unchanged.

### Fixed
- **Zoomed-out pan flicker + laggy toolbars.** Panning while zoomed out was re-rendering the entire canvas component (including the full unmemoized shape/markup SVG overlay) on every ~90ms sync tick, even though nothing visible depended on the pan position — only scale-dependent stroke widths did. The tick now skips the state write when scale hasn't changed and the high-zoom detail view isn't engaged, so a pure pan at overview zoom is a true no-op on the React side.
- **Two conflicting `Content-Security-Policy` headers were shipping to production.** `netlify.toml` and `web/public/_headers` both set a CSP on `/*`; multiple CSP headers are each enforced by the browser as a per-directive intersection, and `netlify.toml`'s block predated the Google-sign-in work, so it would have silently stripped `accounts.google.com`/the webfonts origins back out — breaking sign-in and fonts with no visible error — the moment team cloud mode's env vars are set in production. `_headers` is now the single source of truth; its `connect-src` stays deliberately open (`* data: blob:`, not narrowed to Google-only) so the BYO-AI agent endpoint and the optional `/ai/*` contribute path — both user-configured to arbitrary origins by design — keep working. That trade-off (an XSS could exfiltrate the Google token to any origin) is documented explicitly in `_headers`.
- **`.nvmrc` had drifted to `20`** while `web/package.json`'s `engines` already required `>=24`, and CI hardcoded `node-version: 20` in two places rather than reading the pin. Both now read `24` / `node-version-file: .nvmrc`.
- **`mcp/server.json` still read `0.3.0`** while `mcp/package.json` was already at `0.4.0`. Version numbers now match.
- **`AGENTS.md` / `docs/DEPLOYMENT.md` misattributed this repo's production URL** as `takeoff.345flooring.com` — that's real, but it's a downstream fork's (`knmurphy/opentakeoff`) own deployment; its fork-specific docs rode along into this repo during the 2026-07-13 wholesale history merge and were never re-scoped. Both now correctly point at `opentakeoff.netlify.app`.

## 2026-07-19

### Added
- **Labor type & subfloor type on every condition.** Two free-text fields — Labor and Subfloor — live in the Supporting Materials panel, right above the material list; fill in whatever the bid needs (glue-down, float, nail-down… / ply, concrete slab, OSB…). Both round-trip through saved condition templates and surface as their own Report/CSV/XLSX columns once a project has a value typed in.

### Changed
- **"Assemblies" renamed to "Supporting Materials" throughout the app and docs** — the per-condition materials button/panel, `FEATURES.md`, `README.md`, and the user guide now consistently say Supporting Materials. No data-shape change: `condition.materials` was already the underlying field. The unbuilt Phase 3b roadmap item (a reusable named bundle of material lines) is renamed **Material Kits** to avoid colliding with this panel's name — see `docs/ESTIMATING_ROADMAP.md`.

## 2026-07-18

### Added
- **In-canvas takeoff agent — proposals with evidence, reviewed at an accept gate.** A docked Agent panel (right rail) takes a goal ("take off the carpet per the finish schedule on this sheet") and runs a client-side tool-use loop on the **bring-your-own-AI seam** (`lib/agentLoop.js` over `ai.js`'s new `chatWithTools`; Anthropic-style and OpenAI-style function calling, the user's own endpoint and key, zero hosting, zero telemetry; unconfigured builds show the honest empty state). The model never invents geometry — it aims a registry of the app's own deterministic tools (`lib/agentTools.js`): `list_sheets`, `read_sheet_text`, `read_schedule` (the schedule parser), `view_region` (rendered crop for scans/ambiguity), `one_click` (the flood engine, probe-only), `get_conditions` / `create_condition`, and `propose_shapes`. Results land as **dashed pencil proposals** citing whitelisted evidence (the matched schedule/room token and/or seed); the estimator accepts (per-proposal click, panel buttons, or ⏎ accept-all-visible — committing through the command layer with an `agent_v1` origin: `actor: "agent"`, `reviewed: true`, the frozen proposed ring), corrects (post-accept edits grade via `stampEdit` exactly like one-click), or rejects (**local only** — dismissed geometry never rides the contribution wire). The scale gate holds: tools refuse uncalibrated sheets with the MCP gate's refusal; the agent proposes, never assumes scale. `scripts/mock-agent-server.mjs` scripts a deterministic run against the real engines for keyless end-to-end testing.
- **`origin.evidence` joins the contribution vocabulary** (spec §5): `agent_v1` shapes may carry a **deep-whitelisted** `{schedule_row_tag?, matched_text?, seed_norm?}` — matched tokens only, 80-char cap, never sheet transcriptions; accept-gate timestamps stay local (the no-edit-timing rule). `pickOrigin` whitelists the sub-object key-by-key; `"agent_v1"` joins `origin.method` in the spec and the MCP `ShapeOrigin` type.
- **`opentakeoff.contribution.v2` — contributions carry provenance** (contribution.v2 PR-2, on the PR-1 provenance primitives). The Contribute payload now sends each shape's `id` (opaque durable UUID), `created_at`, and a **whitelisted** `origin` object (`pickOrigin` — registered keys only, never a spread): method, actor, reviewed/edited/edited-before-create/copied flags, one-click seed + trace parameters, per-kind correction tallies, and — for corrected machine shapes — the frozen `proposed_verts_norm`, so the machine's trace and the expert's fix ride side by side. New envelope fields: `generator_version` (inlined from `package.json` at build), per-sheet `scale_source` (provenance only — scale *values* never leave, and v1's `units_per_px`-free discipline tightens into an explicit MUST NOT), and aggregate `counters` (e.g. shapes deleted by origin method). The never-sent list is unchanged and now normative: no PDF, file names, project/client names, markup or label text, absolute coordinates, scale values, or edit timing beyond `created_at`.
- **`docs/CONTRIBUTION_SPEC.md`** — the normative wire + row contract: privacy invariants (including explicit disclosure of the durable-id linkage), field tables for `contribution.v2` and the `capture.v2` row, the provenance vocabulary registry with an IoU correction-magnitude recipe, dedup semantics, and the versioning policy (additive within a version; servers accept N and N−1).
- **Capture server banks `opentakeoff.capture.v2` rows** and accepts both `contribution.v2` and `contribution.v1` (anything else still 400s). Rows gain `shape_id`, `created_at`, verbatim `origin`, `scale_source` (joined from the payload's sheets), `generator_version`, and `contribution_schema` — all key-omitted when the wire didn't carry them; the row fingerprint is unchanged, so existing corpora can't double-bank. `summary`/`/health` gain an `origin_methods` count map, and the selftest grows a v2 triad (manual / clean one-click / corrected one-click must stay distinguishable), a v1-still-ingests check, and an unknown-schema rejection check.

### Changed
- **Capture rows default `origin_method` to `"unknown"`, not `"human"`.** A shape that recorded no provenance is a shape whose provenance we don't know — defaulting it to human would corrupt any human-vs-machine split trained on the corpus. Treat `"unknown"` as unlabeled.

### Docs
- **`docs/USER_GUIDE.md` rewritten as the full user manual** — zero-to-exported-takeoff coverage of every shipped feature (scale, conditions, every tool, One-Click review, command-layer undo/redo, markups/stamps/RFIs, report, revisions, Contribute, the in-canvas agent, MCP), with a code-verified keyboard reference.

## 2026-07-18 — opentakeoff-mcp 0.4.0

### Changed
- **MCP: shapes the server commits now tell the truth about who made them.** Previously, agent work banked as human work: one-click commits stamped `origin.reviewed: true` even though no human ever reviewed them, and `measure_polygon` / `measure_line` commits carried no `origin` at all — so downstream consumers (the capture/contribution pipeline included) defaulted them to human demonstrations. Now every shape the MCP server commits carries `actor: "agent"`; one-click commits stamp `reviewed: false` (an agent's un-reviewed trace is machine-proposed, exactly like a pending binder shape), and measure commits carry `origin: { method: "manual", actor: "agent" }` — agent-supplied coordinates are a hand trace by a machine hand. `Shape.origin` in `mcp/src/session.ts` is widened to the full contribution.v2 vocabulary (`method`, `actor`, `reviewed`, correction fields). **Behavioral change for anyone trusting `reviewed` or the human-by-default origin convention**: MCP-produced shapes no longer masquerade as human-reviewed work in exports or contributed corpora.

## 2026-07-17 — opentakeoff-mcp 0.3.0

### Added
- **MCP: dist smoke harness in CI, on Ubuntu and Windows** (@pollychen-lab, closes #30 and #38). `npm run smoke:dist` drives the compiled `dist/server.js` over stdio — initialize, tools/list, all ten tools by name, and a clean-JSON-RPC-stdout-wire assertion — and the mcp CI job now builds and smokes on both platforms.
- **MCP: one-click Claude Desktop install — the `.mcpb` bundle.** `npm run mcpb` stages the published-package surface with its production dependencies and an MCPB manifest, validates, and packs `opentakeoff-mcp.mcpb` (~9 MB); the release workflow builds and attaches it to every `mcp-v*` GitHub release. Platform-neutral by design: native optionals are excluded, so all ten tools and the text/metadata resources work everywhere and the sheet-image resource degrades gracefully.
- **MCP: typed tool results — `outputSchema` on all ten tools.** Every tool now declares its result schema (`mcp/src/outputs.ts`, mirrored from the session layer), and every reply carries the payload as `structuredContent` alongside the back-compat JSON text item. The SDK validates each reply against its schema on every call, so a reply that drifts from its contract fails loudly in the server's own test suite instead of silently in a client. Conformance test added: all ten schemas present, structured/text parity, error replies stay plain `isError`.

## 2026-07-17 — opentakeoff-mcp 0.2.0

### Added
- **MCP resources — browse a plan set before measuring** (flagship issue #29, reference implementation). A loaded plan exposes `takeoff://sheets` (index, sensible when empty), `takeoff://sheet/{page}` (metadata), `takeoff://sheet/{page}/text` (joined text), and `takeoff://sheet/{page}/image` (rendered PNG, long edge capped at 1568 px, lazily rendered and cached). `load_plan` announces the new surface via `resources/list_changed`. Rendering rides pdf.js's own optional `@napi-rs/canvas` — zero new dependencies, graceful degradation where the native binary is absent. Conformance suite in `mcp/test/resources.test.ts`.
- `.github/FUNDING.yml` — GitHub Sponsors manifest (button renders once Sponsors is enabled on the account).

### Changed
- **MCP releases move to the `mcp-v*` tag namespace** (`mcp-v0.2.0`). Bare `v*` tags are app releases — v0.2.0 and v0.3.0 already exist — so the registry-publish workflow now fires on `mcp-v*`, and the auto-created GitHub release is titled `opentakeoff-mcp <version>` to stay distinguishable in the shared release list.

## 2026-07-17

### Fixed
- **MCP: `mcpName` casing corrected to `io.github.Kentucky-ai/opentakeoff`** (0.1.3). The official MCP registry grants org namespaces with the org's exact GitHub casing and validates the npm `mcpName` with a case-sensitive match, so the lowercase form shipped in 0.1.2 could never pass both checks.

### Added
- **MCP: `mcp/server.json`** — the registry manifest (npm package `opentakeoff-mcp`, stdio transport) used by `mcp-publisher publish`.

## 2026-07-16

### Fixed
- **MCP: `serverInfo` reports the real package version on the wire.** Published `opentakeoff-mcp` 0.1.1 still announced `0.1.0` in the `initialize` response (the fix landed on `main` after the 0.1.1 publish); shipped as **0.1.2**.

### Added
- **MCP: `mcpName` identifier** in `mcp/package.json` — the ownership-verification field the official MCP registry validates for npm-hosted servers.

## 2026-07-15

### Added
- **`mcp/Dockerfile`** — a multi-stage container build for the MCP server (Node 20, non-root, repo root as the build context so the `../../web/src/lib` engine imports resolve). Self-host with `docker build -f mcp/Dockerfile -t opentakeoff-mcp .` then `docker run --rm -i opentakeoff-mcp`. Verified end to end: builds clean and `tools/list` returns all 10 tools over stdio.
- **`glama.json`** — Glama registry manifest naming the maintainer, so the server is claimable and listed at https://glama.ai/mcp/servers/Kentucky-ai/opentakeoff (claimed, quality-scored, installable, release `0.1.0`).

## 2026-07-13

### Changed
- **Snapshots modal retired — Revisions is the single surface over saved takeoffs.** The toolbar Snapshots modal and the Revisions rail panel (clock icon) listed the exact same records — both ride the store's `saveSnapshot`/`listSnapshots`/`getSnapshot`/`deleteSnapshot` primitives, so the Drive snapshot-sync layer is untouched. Revisions is a strict superset (compare any two, per-sheet and buy-list deltas, compare CSV, auto-banked restore), so the modal's toolbar button and component are removed; save / compare / restore / delete all live in the Revisions panel.

### Fixed
- **MCP package builds on Windows.** The build now uses a small Node script to copy the executable wrapper instead of Unix-only `cp` and `chmod` commands.
- **Capture server: a wedged synced share can't stall contributions.** A stalled sync client can leave a mirror-folder syscall hanging at the kernel — which no `try/except` catches. The `--mirror` copy now runs on an expendable thread with a wall-clock cap (`OPENTAKEOFF_MIRROR_TIMEOUT_S`, default 15s) and a 3-slot strand budget: a hung share strands at most 3 threads, then further mirror attempts skip outright until it recovers; the corpus write and the `/contribute` response are never held hostage. Selftest gains wedged-share checks.

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
