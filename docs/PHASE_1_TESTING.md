# Phase 1 test guide

Branch: `fix/phase-1-correctness`. This branch contains the complete Phase 1 correctness scope. It does not include the later engine, workspace, agent API or UI redesign phases. Merge and deployment require the owner's approval.

## Run locally

From this checkout, use Node 24:

```sh
cd web
npm ci
npm run dev -- --host 127.0.0.1 --port 5187
```

Open http://127.0.0.1:5187 in a disposable browser profile for testing. Existing project data in another profile is independent.

## Browser checks

1. Load the sample plan, set its scale, and draw a rectangle. Change the scale so feet per pixel doubles. Area should quadruple and perimeter double. Revert the scale from the scale menu; the original quantities should return.
2. Import an agent takeoff with `scale_confirmed: false`. Confirm its scale without editing a shape, wait for **saved**, and reload. Confirmation should remain. Choosing the already-active scale should also confirm it.
3. Import a legacy shape with `origin: {"method":"manual","actor":"agent"}` and no review flag. It should appear as pending, with an Accept action. Explicit `reviewed: true` records should retain their prior approval.
4. Import a new dimensional shape for a locally calibrated sheet using a different source scale. The import should report a scale conflict, and no shapes or other project state should change. Match calibrations and re-export to proceed. Counts and duplicate IDs remain exempt.
5. On a network-detected room with a retained interior void, inspect the dashed preview, create it, save and reload. The void should remain visible. Area excludes the void and perimeter includes its boundary. Compare Report and DXF. The existing engine ignores voids smaller than its retention threshold; Phase 1 does not change detector policy.
6. With a reconciled cutout, recalibrate and then delete the cutout. The restored parent should use the new scale. Opening the sheet is required to recalibrate dimensional work.

## MCP checks

Using the bundled `demo/sample-plan.pdf`, set `upp: 1/36` and measure the polygon `[[0,0],[360,0],[360,360],[0,360]]`. Expect **100 SF / 40 LF**. Set `upp: 1/18`; expect **400 SF / 80 LF** in the stored shape, summary, report and DXF. `undo_last` should restore the old scale and quantities in one step, after which older geometry gestures remain undoable.

Repeat with an interior cutout. Recalibration must update the void and its restore snapshot. Counts retain their stored quantities. Reviewed dimensional measurements refuse MCP recalibration; change those in the canvas, then import into a fresh session.

## Sync checks

On two devices diverging from a common saved state, recalibrate different sheets. Both changes should survive sync. If one side recalibrates a sheet while the other edits dimensional geometry on that same sheet using the old scale, the remote sheet's measurements and scale stay together. The local alternative must be saved in **Merge backup** before adoption; recover it through Revisions if needed.

## Automated validation

```sh
cd web
npm run check
node --import tsx --test test/syncStore.test.ts
cd ../mcp
npm run typecheck
npm test
npm run check:tool-count
npm run build
npm run smoke:dist
cd ..
node scripts/check-doc-links.mjs
```

Regression coverage includes recalibration and undo, cutout restore snapshots, report/DXF agreement, atomic import refusal, legacy review status, network room/field simplification, hole transport, keyed sheet merge and sync backup before adoption. Browser persistence still requires the browser checks above; the Node suite alone does not exercise React autosave.

## Validation recorded for this branch

- Web check: typecheck, lint, **1,708 passing tests**, benchmark and production build passed; **3 optional voice-model tests skipped** because their model is not installed. Benchmark results are unchanged.
- MCP: typecheck, **197 passing tests**, tool-count check (47 tools), build and distribution smoke test passed.
- Browser on the bundled sample plan: confirmation persisted across reload; legacy agent work appeared pending; interior void geometry persisted; a conflicting import left saved work intact; recalibration quartered area when feet-per-pixel halved; revert restored the scale and quantity. No browser runtime errors were observed.
- Relative documentation links and whitespace checks passed. Live multi-device Drive testing remains a manual check; the sync backup behavior is covered by the isolated store integration test.
