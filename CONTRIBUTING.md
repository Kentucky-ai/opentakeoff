# Contributing to OpenTakeoff

Thanks for helping build a free takeoff tool for flooring contractors. PRs,
issues, and ideas are all welcome.

## Dev setup

```bash
cd web
nvm use            # Node version comes from web/.nvmrc — CI uses the same file
npm install
npm run dev        # http://localhost:5173 — drag in demo/sample-plan.pdf
```

Before opening a PR:

```bash
npm run check      # typecheck + lint + test + build — the exact sequence CI runs
```

If `npm run check` is green locally, CI will be green: CI reads the Node
version from `web/.nvmrc` and runs this same script, nothing more.

## How changes ship

Full pipeline details (CI, deploys, security model, troubleshooting) live in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The short version:

- `main` is protected: all changes land via PR, the `web` CI check must pass,
  and the branch must be up to date with `main` before merging. No force-pushes.
- Merging to `main` triggers the Deploy workflow, which re-runs `npm run check`
  and publishes `web/dist` to Netlify (production:
  [takeoff.345flooring.com](https://takeoff.345flooring.com)). Netlify never
  builds on its own — the only build environments are your machine and Actions,
  both pinned by `.nvmrc`.

The optional AI sandbox lives in [`server/`](server/README.md) and is not needed
for canvas work.

## Architecture in one minute

- **`web/src/pages/TakeoffCanvas.jsx`** — the canvas: pdf.js render, pan/zoom
  (written straight to the DOM transform), drawing tools, conditions. Stays JSX.
- **`web/src/lib/oneclick.ts`** — pure One-Click flood-fill geometry (typed,
  node-tested). No DOM, no pdf.js import.
- **`web/src/lib/sheets.ts`** — scale table, scale-note detection, sheet-number
  extraction.
- **`web/src/lib/store.js`** — the storage seam (IndexedDB + localStorage). The
  canvas only ever talks to `store`, so a backend can be added by implementing
  the same four methods.
- **`web/src/lib/totals.js`** + **`components/ReportPanel.jsx`** — role-aware
  totaling, the Report, and CSV/XLSX/JSON export (the hand-rolled .xlsx writer
  lives in `web/src/lib/xlsx.js`).
- **`web/src/lib/contribute.js`** — the opt-in "contribute to the open flooring
  model" payload builder (derived data only).

## Scope

In scope: the takeoff canvas, measuring, One-Click, conditions, reports/export,
and the bring-your-own-model AI socket. Out of scope: estimating/pricing/bidding
engines — OpenTakeoff is a takeoff tool, not an ERP.

## Ground rules

- Don't break the canvas feel: pan/zoom and One-Click are the heart of the tool.
- Keep the geometry libs pure and typed; add a test when you touch them.
- Never commit real plan PDFs or any private/customer data.

By contributing you agree your contributions are licensed under the Apache License 2.0.
