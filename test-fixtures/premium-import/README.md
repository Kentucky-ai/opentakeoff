# Premium import fixtures

Real files written by the open-source OpenTakeoff code, for testing an
importer against what the app actually produces. Nothing here is
hand-written: `generate.mts` runs the app's own modules and writes them.

| File | What it is | Written by |
|---|---|---|
| `browser-backup.otkx` | Export everything: both projects, the plans, a PDF revision, snapshots, libraries, settings, profile | `web/src/lib/browserExport.js` over `store.js` on fake-indexeddb |
| `northside-office.otk`, `va-bldg-28.otk` | Export project archive, one per project | `web/src/lib/projectArchive.js` |
| `northside-office.takeoff.json`, `va-bldg-28.takeoff.json` | Export takeoff (`opentakeoff.takeoff_canvas.v1`) | `buildTakeoffDocument` via the MCP `Session.exportPayload` |
| `estimator.otprofile` | Export profile | `web/src/lib/profile.js` |
| `drive-project-folder.zip` | A Drive project folder: `<project>/sample-finish-plan.pdf`, `.opentakeoff/annotations.json`, `.opentakeoff/sheets.json`, `.opentakeoff/snapshots/<id>.json` | `cloudStore.js` + `google/snapshotSync.js` on an in-memory Drive |
| `expected.json` | The app's own numbers per condition and the priced estimate | `totals.js` `conditionTotals`, `estimate.js` `priceEstimate`, `Session.exportReport` |

Each file is under 1.2 MB.

## The two projects

**Northside Office Fit-out** (`demo/sample-plan.pdf`, sheet A-101, 1/4" = 1'-0").
This is the browser's default workspace, so it is the `annotations` record in the `.otkx`.

- **Measure roles:**
  - area: four rooms by one-click flood;
  - deduct: a drawn 2'x2' column, plus a `cut_out` reconciled into Office 102;
  - linear: base from `derive_base` with stated door openings, a transition, vinyl base;
  - count: floor boxes;
  - surface: FRP wainscot at 4 ft.
- **Conditions:** waste % set, materials attached, prices set (SY / SF / LF / EA).
- **Review state:** the corridor (LVT-1) is an agent proposal still pending review (`origin.reviewed === false`, `proposals[]`). Every other shape was accepted through the canvas's Accept gate (`shapeCommands` "review"). It carries an agent verdict and an estimator APPROVED seal.
- **Markups:** cloud, text, callout, arrow, dimension and an image markup (a PNG `data:` URL). One RFI is linked to the cloud.
- **Estimate:** `estimate_settings` (markup mode) with `bid_proposal` text and `client_info`.
- **Plan revision:** the plan was re-dropped with changed bytes, so `pdfs` holds rev 2 and `pdf_revs` holds rev 1.
- **Snapshot:** one, taken after the rooms were traced and before deducts and base.

**St. Cloud VA Bldg 28 RRTP** (`demo/sample-finish-plan.pdf`: AF101 plan, AF600 schedule).
This is a Drive-backed project: `annotations:1AbCdEfGhIjKlMnOpQrStUvWxYz-va28` in the `.otkx`, and the folder in the zip.

- **Rooms:** from room detection with tags resolved against the finish schedule (CPT-1, WSF-1, EXIST).
- **Other measures:** base derived from CPT-1, a deduct, counts, and a wall-tile surface at 7 ft.
- **Pending edit:** a condition-edit proposal (agent asks RB-1 waste 5 → 10) waits for the estimator.
- **Estimate:** margin mode.
- **Markups and RFI:** cloud, bubble and image markups, plus one RFI.
- **Snapshot:** one.

The library in both the `.otkx` and the `.otprofile` holds:

- 4 condition templates;
- 5 library materials;
- 4 stamps (the default set plus one saved stamp);
- 2 assemblies;
- estimating defaults;
- one company profile.

The `.otkx` leaves out a fake AI key (`opentakeoff_ai_key`), as it should.

## Reading notes for an importer

- **Where plans live.** In the browser, plans live in one store keyed by file name (`pdfs`, revisions in `pdf_revs`). A project reaches them through `sheets[].sheet_id` and `shapes[].sheet_id`. Page 2 of a file is `<file>#2`.
- **Geometry.** Shapes store `verts_norm` in 0..1 per sheet, plus the engine's own `computed` quantities. `sheets[].units_per_px` is feet per pixel at the app's render scale (2 px per PDF point).
- **The `_net` suffix.** In `expected.json`, `floor_sf`, `lf`, `ea` and `total_sf` are measured quantities. `*_net` and `sy_net` are order quantities with waste applied: the suffix is the app's documented naming debt and does not mean net of deducts.
- **Pending shapes.** Shapes pending review count in the totals, as the app counts them.
- **Totals cross-check.** `estimate.total` was asserted equal to the MCP Session's own `estimate_summary` total when the files were generated.
- **Read-back check.** At the end of each run, `generate.mts` reads every file back with the app's own readers, and fails if any differs:
  - `parseProjectArchive` on both `.otk` files;
  - `parseTakeoffImport` on both `.takeoff.json` files;
  - `parseProfile` on the `.otprofile`;
  - `.otkx` restore into an empty IndexedDB, with both projects deep-equal and the revision trail `[2, 1]`;
  - the Drive `annotations.json` compared with the project document.

## Regenerate

```bash
cd web && npm ci && cd ../mcp && npm ci
node --import tsx ../test-fixtures/premium-import/generate.mts   # from mcp/
```

Ids and timestamps are minted at run time, so a re-run is equivalent, not
byte-identical. The VA plan is a public federal bid document (see
`demo/README.md`); the office plan is synthetic.
