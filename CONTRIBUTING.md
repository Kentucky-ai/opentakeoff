# Contributing to OpenTakeoff

Thanks for helping build a free takeoff tool for flooring contractors. PRs,
issues, and ideas are all welcome.

## Dev setup

```bash
cd web
npm install
npm run dev        # http://localhost:5173 — drag in demo/sample-plan.pdf
```

Before opening a PR:

```bash
npm run typecheck  # tsc --noEmit (the geometry libs are typed)
npm test           # node test runner over the One-Click geometry
npm run build      # vite build -> dist/
```

The optional AI sandbox lives in [`server/`](server/README.md) and the optional
capture layer in [`capture/`](capture/README.md) — neither is needed for canvas
work. If you touch `capture/`, run `python3 capture/capture_server.py selftest`
(stdlib only, no setup).

## Pull requests — how we work

- **One concern per PR.** A feature, a fix, or a refactor — not all three. Small
  PRs get reviewed fast; grab-bags stall.
- **Open an issue first for anything big.** Typo fixes and small bugs can go
  straight to a PR. New tools, new panels, or anything that changes the canvas
  feel should start as an issue so we agree on the shape before you build it.
- **`main` is protected.** Changes land by pull request with green CI
  (typecheck, tests, build — plus the capture selftest); force-pushes and branch
  deletion are blocked. Write commit subjects the way the history does —
  `feat(canvas): …`, `fix(oneclick): …`, `docs: …` — they become the changelog.
- **Show your work.** Canvas-visible changes want a screenshot or GIF in the PR;
  quantity-affecting changes want a measured-vs-expected check against the
  bundled sample plan (the PR template asks for both).
- **Stay vendor-neutral.** Generic, industry-typical rates and terms only — no
  manufacturer or product brand names in code, docs, or sample data.
- **Update the paper trail.** A `CHANGELOG.md` entry and a `FEATURES.md` row
  when behavior changes; `docs/USER_GUIDE.md` when the flow a user follows
  changes.
- **Review etiquette.** Comments are about the code, never the author; every
  conversation gets resolved before merge. Expect a review within a few days.
  Maintainers may push small fixups onto your branch to land a PR faster — say
  so in the PR if you'd rather make the changes yourself.

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
  totaling, the Report, and CSV/JSON export.
- **`web/src/lib/contribute.js`** — the opt-in "contribute to the open flooring
  model" payload builder (derived data only).
- **`capture/capture_server.py`** — the optional local capture server: banks
  Contribute payloads as (geometry → label) training rows in a corpus you own.

## Scope

In scope: the takeoff canvas, measuring, One-Click, conditions, reports/export,
and the bring-your-own-model AI socket. Out of scope: estimating/pricing/bidding
engines — OpenTakeoff is a takeoff tool, not an ERP.

## Ground rules

- Don't break the canvas feel: pan/zoom and One-Click are the heart of the tool.
- Keep the geometry libs pure and typed; add a test when you touch them.
- Never commit real plan PDFs or any private/customer data.

By contributing you agree your contributions are licensed under the Apache License 2.0.
