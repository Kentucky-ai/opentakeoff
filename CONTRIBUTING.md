# Contributing to OpenTakeoff

OpenTakeoff is the open-source foundation for construction takeoff, and it gets better every
time someone who measures plans for a living, or builds the agents that do, sends a change
back. Bug reports, ideas, docs fixes, engine work and new tools are all welcome, from people
and from agents.

**The one rule that matters:** a pull request shows that it works. The software is used on
real bids, so every PR carries evidence a reviewer can check without taking your word for it.
[The evidence bar](#the-evidence-bar) shows what that looks like.

## Your first PR in five steps

1. **Pick something.** Choose an [open issue](https://github.com/Kentucky-ai/opentakeoff/issues),
   an [RFC](https://github.com/Kentucky-ai/opentakeoff/labels/rfc), a
   [`good first issue`](https://github.com/Kentucky-ai/opentakeoff/labels/good%20first%20issue),
   or a bug you hit on your own plans. For anything big, start a thread in
   [Discussions](https://github.com/Kentucky-ai/opentakeoff/discussions) or an issue first so
   the shape is agreed before you build it.
2. **Agree to the CLA once.** Post the one-line agreement from [CLA.md](CLA.md) as a comment on
   the issue or PR. See [Contributor agreement and issue assignments](#contributor-agreement-and-issue-assignments).
3. **Fork, branch and run it.** `cd web && npm ci && npm run dev` opens the canvas at
   `http://localhost:5173`. Click **Load sample plan** to open `demo/sample-finish-plan.pdf`.
4. **Make the change, then run the gate.** `npm run check` in `web/` is the exact CI gate
   (typecheck, lint, test, benchmark and build). If you touched `mcp/` or `protocol/`, run the
   checks listed in [AGENTS.md](AGENTS.md) as well.
5. **Open the PR with evidence.** The [PR template](.github/PULL_REQUEST_TEMPLATE.md) asks for
   what changed and why, how you verified it, the evidence, and notes for the reviewer.

## The evidence bar

Evidence depends on what the change touches. Two merged PRs show the bar.

**A visible change** (a panel, a tool, a dialog or an export) needs:

- A screenshot of **each** surface you changed, not just the main one, and a short recording
  when the change is a flow.
- The changed flow exercised on the bundled sample plan, not a synthetic drawing.
- Docs updated in the same PR: `CHANGELOG.md`, the `FEATURES.md` row and `docs/USER_GUIDE.md`
  when the steps a user follows change.

Example: [#346, image captures](https://github.com/Kentucky-ai/opentakeoff/pull/346). It has
one recording of the whole flow, seven stills (one per surface, including the exported
marked-set PDF), and an offer to split the PR into two stacked PRs for review.

**An engine or tool change** (geometry, totals, the MCP server or a reader) needs:

- An **exact-output gate**: the same inputs produce the same answers before and after,
  or a stated difference with the reason for it.
- A **before/after table** for anything you claim got faster or more accurate, with the
  conditions (sheets, runs, median of N).
- **The command that reproduces it**, and a test for anything that touches the pure geometry
  libraries.
- Mutants or negative cases where it's cheap to show that the test would catch a regression.

Example: [#547, room-engine scan pruning](https://github.com/Kentucky-ai/opentakeoff/pull/547).
It reports 24/24 sheets with zero difference on the exact-output gate, 548/548 identical room
probes, mutants that fail as expected, and a retime table per stage.

**Every PR ends with notes for the reviewer**: the coordinate spaces involved, the limits you
chose on purpose, and anything you did not verify. Say "unverified" when you mean it. A
passing test is not a human approval, and a synthetic fixture is not a real plan.

Keep private plans, prices and credentials out of public evidence. Brand names printed on the
bundled sample plan are fine in screenshots.

## Agents as contributors

Coding agents can open PRs under the same rules. Point yours at [AGENTS.md](AGENTS.md), which
routes it to the repository guide before it edits anything. PRs from forks run the full CI
with no secrets and a read-only token, so a green check on your fork is a green check here. An
agent's PR still needs the evidence above. The human who runs the agent posts the CLA
agreement.

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
npm ci
npm run dev        # http://localhost:5173, then click Load sample plan
```

Before opening a PR, run the exact CI gate:

```bash
npm run check      # typecheck, lint, test, benchmark and build
node ../scripts/check-doc-links.mjs   # every relative doc link and anchor resolves
```

Use the Node version pinned in [`.nvmrc`](.nvmrc). A different major version can fail tests
that pass in CI.

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
- **Show your work.** Every PR meets [the evidence bar](#the-evidence-bar):
  a screenshot of each changed surface for visible changes, and an exact-output
  gate, a before/after table and a reproducible command for engine changes.
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
