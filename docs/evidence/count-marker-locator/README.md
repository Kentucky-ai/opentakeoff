# Count marker and locator review evidence

Count rings can follow the printed symbol as the view zooms, while **Show on plan** makes the selected occurrence identifiable. This is a display and navigation change. Count centers, quantities, calibration and review decisions remain unchanged.

## Tested builds and scope

- Date: November 18, 2026, Windows, Codex in-app browser (Chromium). Node 24.22.3 for local checks.
- Published build: commit `3add1846a974aebc8820fa53af9933f75251690a`, deploy `6afdb970d3fc9f8a3d67b0e7`, published at 14:43:33 UTC. The canonical site and the Netlify `main` alias served the same `index-Du82pXM0.js` bundle. Testing used <https://main--opentakeoff.netlify.app/> in a separate, initially empty browser origin. The canonical site's existing project was not changed.
- Local build: `codex/count-markers-locator`, based on that same commit, Vite development server at <http://127.0.0.1:5181/>. These changes are not deployed to the public app.
- Screenshots use the actual browser viewport. The first comparisons are 1280 × 720; the bundled-sample comparisons are 878 × 885. The hidden-condition captures have different viewport sizes; they demonstrate visibility, not a pixel-for-pixel layout comparison. [Screenshot dimensions and hashes](screenshots.json).
- No private plans, pricing or catalog data are included. The landscape example is original fictional geometry. The real-plan example uses the repository's bundled `demo/sample-finish-plan.pdf`.

## Expected and observed

| Scenario | Published build | Local build | Evidence |
|---|---|---|---|
| Landscape overview and working zoom | Small screen-size pins | Hollow rings stay aligned with paper-space symbols | [Hosted overview](hosted-overview.jpg), [local overview](local-overview.jpg), [selected tree](local-selected-TA.jpg) |
| Locate an existing count | View centers; selected pin remains small | Persistent halo and code/EA label identify the selected occurrence; a short pulse draws attention | [Hosted tree](hosted-selected-TA.jpg), [local tree and receipt](local-selected-TA.jpg) |
| Locate a hidden condition | View centers but the count stays hidden | Condition becomes visible and selected | [Hosted hidden TB](hosted-hidden-TB-locator.jpg), [local revealed TB](local-hidden-TB-locator.jpg) |
| Locate on another sheet | Existing navigation retained | TB opens on the second sheet with the same measurement ID | [Cross-sheet TB](local-selected-TB-cross-sheet.jpg) |
| Smaller plant symbol | Legacy pin | Shrub uses an 18-point ring centered on the existing count | [Selected shrub](local-selected-sa.jpg) |
| Optional diameter | Field unavailable; unknown persisted field retained | 60 points works; blank restores the legacy pin | [Appearance setting](local-ring-settings.jpg), [blank setting](local-standard-pin.jpg) |
| Save and reopen | All 18 measurement records preserved | All 18 records preserved; ring settings remain after reload | [Reproducible comparison](../../../scripts/count-marker-review.mjs), [results](verification.json) |
| Marked PDF | Existing legacy count-dot behavior | Exported rings use the specified paper diameter; original callouts remain visible; selection halo/label is absent | [Marked PDF](Landscape-Review-Demo.local-marked.pdf), [sheet 1](local-marked-page-2.png), [sheet 2](local-marked-page-3.png) |
| Bundled real-plan flow | Small selected pin on AF101 | Existing CG anchor is identifiable; selecting a second occurrence moves the cue | [Hosted CG](sample-hosted-selected-CG.jpg), [local CG](sample-local-selected-CG.jpg), [screen recording](sample-local-review-flow.gif) |

The 13-second recording is an actual local browser capture, 49 frames, showing the measurement receipt, **Show on plan**, a zoom change and selection of another CG occurrence. It is not an animation generated from the source drawing.

## Reproduce the examples

From the repository root with Node 24:

```bash
npm ci --prefix web
node scripts/count-marker-review.mjs --build-sample /path/to/qa-output
npm run dev --prefix web -- --host 127.0.0.1 --port 5181 --strictPort
```

Use a separate browser profile or an empty workspace. Another tab on the same origin shares saved project data. An `.otk` import restores the takeoff payload and adds its PDFs; do not import the test archive into a live estimating project.

1. Choose **Open plans** and open `demo/count-marker-review/Landscape-Review-Demo.otk`. Open the first sheet.
2. Fit the sheet, then zoom into TA. The hollow ring should stay aligned with the printed symbol. In the condition's **More: trade, heights, line style, columns**, clear **Count ring diameter (pt)** to restore the pin; enter `60` to restore the tree ring.
3. Open **Work and review**, search `TA`, select an occurrence and click **Show on plan**. Repeat for `sa` and a `TB` occurrence on the other sheet. On a narrow viewport the existing behavior closes the work panel when locating; reopen it to see the receipt.
4. Hide TB in Conditions, then locate its existing measurement from Work and review. The local build should reveal it. Do not accept or recreate measurements.
5. Reload the page and confirm the ring remains. Use **Everything else → Export takeoff…** to inspect saved records. For an annotated PDF use **Report → Print → Download marked set**.
6. Open the generated `Bundled-Sample-Marker-QA.otk` in the QA workspace. Open AF101, search `CG` in Work and review and locate the three existing anchors. Compare the result with the bundled-sample stills and recording.

The scripts compare saved exports, not a live browser. The live interactions were exercised separately and are documented by the captures.

## Exact saved-record check

```bash
node scripts/count-marker-review.mjs
```

The original landscape archive round-trips exactly. Both browser exports preserve all 18 measurement records, including IDs, geometry, quantities, provenance and pending review state, plus both sheet scale records. Condition IDs, specifications and diameters are unchanged. The local TA condition has a changed edit timestamp because its diameter was cleared and restored during the UI check; no other condition content differs.

| Code | Baseline EA | Hosted export EA | Local export EA | Pending records |
|---|---:|---:|---:|---:|
| TA | 6 | 6 | 6 | 6 |
| TB | 2 | 2 | 2 | 2 |
| sa | 10 | 10 | 10 | 10 |

The fictional `pa` callouts total 20 EA (12 + 8). They are printed context only, not count measurements in this fixture. The printed mulch dimensions are also context, not measured areas. They are not added to the 18 individually located counts.

The bundled real-plan fixture has three CG anchors at verified printed callouts, not a complete corner-guard takeoff. Their 22-point display rings identify callouts; they do not represent a physical guard footprint. The fixture was constructed with the repository's `Session.loadPlan`, `setScale` and `placeCount` APIs, and packaged with its archive API. It was not an independent AI counting benchmark or a remote MCP tool run. The landscape coordinates came from the fictional drawing generator.

## Validation

All checks below passed locally. GitHub CI remains pending until the branch is pushed and a PR is opened.

| Command | Result | Log |
|---|---|---|
| `npm run check --prefix web` | Typecheck, lint, tests, benchmark and build pass; 3,816 tests pass, 4 skip, 0 fail. Two pre-existing View3D lint warnings. | [Web gate](web-check.log) |
| `npm run check --prefix protocol` | Pass | [Protocol](protocol.log) |
| `npm run typecheck --prefix mcp` | Pass | [MCP types](mcp-typecheck.log) |
| `npm test --prefix mcp` | 322 pass, 1 skip, 0 fail | [MCP tests](mcp-test.log) |
| `npm run check:tool-count --prefix mcp` | Pass, including version agreement | [Tool count](tool-count.log) |
| `npm run check:wiki --prefix mcp` | Pass | [Wiki](wiki.log) |
| `node scripts/check-doc-links.mjs` | Pass | [Links](doc-links.log) |
| `npm run build --prefix mcp` | Pass | [MCP build](mcp-build.log) |
| `npm run smoke:dist --prefix mcp` | Pass | [Packaged server](mcp-smoke.log) |

## Reviewer notes

- `count_diameter_pt` is an optional positive finite number in PDF points (72 points = 1 inch). The canvas uses the existing `RENDER_SCALE` to obtain stage pixels. Stored normalized vertices and measured quantities do not change. The marked PDF uses the same paper diameter directly.
- Existing conditions retain screen-size pins until a diameter is specified. Rings are hollow; pending counts stay dashed. A selected count gets a screen-size halo/label around its paper-size ring. Selection graphics are temporary and are not exported as annotations.
- Sizing is manual and per condition. It does not automatically fit an irregular plant outline or support different symbol sizes within one condition. Count hit-testing remains centered on the existing point; the ring edge is not a new drag/selection boundary.
- The locator changes concern count measurements. This is not a general replacement for the text-annotation locator, bulk review, callout-quantity review, landscape trades, catalog matching or pricing.
- A locator can reveal a hidden condition and reset a conflicting trade view to All trades. Hidden-condition behavior was exercised. The split-screen reference pane, trade-filter-only path, light theme, and OS-level reduced-motion preference were not separately exercised in the browser. Reduced-motion handling is present in both the pulse trigger and CSS; the persistent selection cue remains.
- English dark-theme desktop behavior was exercised at the viewports listed above. Mobile/touch behavior and translated new labels are unverified.
- Review status indicates recorded decisions; these checks do not approve quantities or authenticate provenance.
