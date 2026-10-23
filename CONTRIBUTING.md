# Contributing to OpenTakeoff

Thanks for helping build a free takeoff tool for contractors. PRs,
issues, and ideas are all welcome.

## Where to start

- [`good first issue`](https://github.com/Kentucky-ai/opentakeoff/labels/good%20first%20issue)—small,
  fully specified, exact files named. Follow the contributor agreement steps below
  before claiming one in a comment.
- [The flagship challenge](https://github.com/Kentucky-ai/opentakeoff/issues/29)—an open
  design-and-build bake-off. Post a design comment first; multiple entries
  welcome; the best one merges with credit.

## Contributor agreement and issue assignments

Before starting contribution work or asking to be assigned an issue, read
[CLA.md](CLA.md) and post this comment yourself on the issue:

> I have read CLA.md and agree to it for this and my future contributions to OpenTakeoff.

If you have already agreed, link your earlier agreement comment instead. Include
that link in your pull request. For a small change without an issue, post the
agreement on the pull request before review. Maintainers verify that the linked
comment belongs to the contributor before assigning work or merging a first PR.
A checked box or a comment posted by someone else does not replace the agreement.
Reporting a bug, suggesting a feature, and discussing an issue do not require it.

### When an agreement is missing

Maintainers ask for the agreement and record that request in an issue or PR
comment. Count calendar days from that request, not from the issue's creation:

- After 7 days without an agreement, post one friendly reminder with the CLA link
  and the exact agreement text above.
- After 14 days without an agreement, close an unsigned PR with: "Closing while
  the contributor agreement is pending. Happy to reopen once the CLA is signed."
  Keep the underlying bug or feature issue open if it is still needed. Release
  any assignment held for the unsigned contribution so someone else can work on it.
- An agreement posted later allows the PR to reopen, subject to the usual review
  and checks. Silence never counts as agreement, and elapsed time never permits
  merging an unsigned contribution.

For existing unsigned contributions, use the dated agreement request already on
the thread. If it is already more than 7 days old and no reminder was sent, send
one and allow at least 7 more days before closure. This is a manual maintainer
workflow; no bot currently posts reminders, closes PRs, or verifies signatures.

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
capture layer in [`capture/`](capture/README.md)—neither is needed for canvas
work. If you touch `capture/`, run `python3 capture/capture_server.py selftest`
(stdlib only, no setup).

## Pull requests — how we work

- **One concern per PR.** A feature, a fix, or a refactor—not all three. Small
  PRs get reviewed fast; grab-bags stall.
- **Open an issue first for anything big.** Typo fixes and small bugs can go
  straight to a PR. New tools, new panels, or anything that changes the canvas
  feel should start as an issue so we agree on the shape before you build it.
- **`main` is protected.** Changes land by pull request with green CI
  (typecheck, tests, build—plus the capture selftest); force-pushes and branch
  deletion are blocked. Write commit subjects the way the history does—`feat(canvas):
  …`, `fix(oneclick): …`, `docs: …`—they become the changelog.
- **Show your work.** Canvas-visible changes want a screenshot or GIF in the PR;
  quantity-affecting changes want a measured-vs-expected check against the
  bundled sample plan (the PR template asks for both).
- **Stay vendor-neutral.** Generic, industry-typical rates and terms only—no
  manufacturer or product brand names in code, docs, or sample data.
- **Update the paper trail.** A `CHANGELOG.md` entry and a `FEATURES.md` row
  when behavior changes; `docs/USER_GUIDE.md` when the flow a user follows
  changes. Docs follow the house style below.
- **Review etiquette.** Comments are about the code, never the author; every
  conversation gets resolved before merge. Expect a review within a few days.
  Maintainers may push small fixups onto your branch to land a PR faster—say
  so in the PR if you'd rather make the changes yourself.

## Docs house style

The READMEs and the manuals follow the [Apple Style Guide](https://support.apple.com/guide/applestyleguide/welcome/web).
The rules that come up:

- **Write to the reader, in the present tense, in the active voice.** "You" is
  the estimator or the agent's operator; the app is "OpenTakeoff", never "we".
- **Sentence-style capitalization in headings**, and "and" rather than "&".
  Heading text is a public anchor—renaming one means fixing every link to it
  (`node scripts/check-doc-links.mjs` catches what you miss).
- **Name the real gesture**: *click* a button, *choose* a menu item, *select* a
  shape or a checkbox, *press* a key, *enter* text, *drag* a grip. Not "hit".
- **Quote the interface verbatim.** A message, a menu item, or a button label
  is copied from the code, punctuation and all—so a reader can search for it.
- **No Latin abbreviations.** "For example" instead of "e.g.", "and so on"
  instead of "etc.", "versus" instead of "vs." Drop "via" as well—"through",
  "using", or "with" says which one you meant.
- **No filler**: "just", "simply", "please", "easy", "obviously".
- **Em dashes close up**—no spaces around them—except inside quoted interface
  text, which stays exactly as the app writes it.
- **US spelling**: color, labeled, centered, neighboring.
- **Say what a thing does before you say how it's built.** Refusals and limits
  are features here; state them plainly rather than burying them.

## Architecture in one minute

- **`web/src/pages/TakeoffCanvas.jsx`**—the canvas: pdf.js render, pan/zoom
  (written straight to the DOM transform), drawing tools, conditions. Stays JSX.
- **`web/src/lib/oneclick.ts`**—pure One-Click flood-fill geometry (typed,
  node-tested). No DOM, no pdf.js import.
- **`web/src/lib/sheets.ts`**—scale table, scale-note detection, sheet-number
  extraction.
- **`web/src/lib/store.js`**—the storage seam (IndexedDB + localStorage). The
  canvas only ever talks to `store`, so a backend can be added by implementing
  the same four methods.
- **`web/src/lib/totals.js`** + **`components/ReportPanel.jsx`**—role-aware
  totaling, the Report, and CSV/JSON export.
- **`web/src/lib/contribute.js`**—the opt-in "contribute to the open flooring
  model" payload builder (derived data only).
- **`capture/capture_server.py`**—the optional local capture server: banks
  Contribute payloads as (geometry → label) training rows in a corpus you own.

## Scope

In scope: the takeoff canvas, measuring, One-Click, conditions, reports/export,
and the bring-your-own-model AI socket. Out of scope: estimating/pricing/bidding
engines—OpenTakeoff is a takeoff tool, not an ERP.

## Ground rules

- Don't break the canvas feel: pan/zoom and One-Click are the heart of the tool.
- Keep the geometry libs pure and typed; add a test when you touch them.
- Never commit real plan PDFs or any private/customer data.

OpenTakeoff is licensed under AGPL-3.0-only. Before your first pull request is merged, read
[CLA.md](CLA.md) and post the agreement comment on the issue or pull request as described above. Contributions made
before the relicensing stay under Apache-2.0 (see [NOTICE](NOTICE)).
