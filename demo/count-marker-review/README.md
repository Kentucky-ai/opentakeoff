# Count marker review fixtures

Use [the review instructions](../../docs/evidence/count-marker-locator/README.md) to compare the published app with the local branch.

- `Landscape-Review-Demo.pdf` is an original fictional two-sheet landscape drawing. It contains no customer data and is not for construction or estimating.
- `Landscape-Review-Demo.otk` contains that PDF and 18 pending count measurements: TA 6, TB 2, sa 10. Its source payload and coordinate manifest are adjacent files. The printed pa callouts and mulch dimensions are context only.
- `Bundled-Sample-Marker-QA.takeoff.json` stores three selected CG anchors for UI QA on the repository's existing real sample plan. Run `node scripts/count-marker-review.mjs --build-sample /path/to/output` from the repository root to build its portable archive without duplicating the real PDF in this directory.

Open test archives only in a separate empty workspace. They restore their takeoff payload; tabs on the same browser origin share saved data.
