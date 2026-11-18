# Large-set benchmark (#580)

What it costs to open a plan set of 800+ sheets and move through it: a real
browser, a production build, a public set. `run.mjs` explains each figure at
its top.

## The set

`sets.json` records each set's public URL, SHA-256, size and page count. The
file is not in the repository: download it from `url`, and `run.mjs --set
<name>` refuses a file whose hash differs from the record.

The default set is a state agency's bid reference plans: one PDF, 1,271 sheets
at 34 x 22 in, 853 MB. It is highway and bridge work, not a building, so it
exercises opening, flipping and the Sheets tree at scale, not finish takeoff.
If the agency takes the file down, pick another public set of 800+ large-format
sheets, add its record, and re-run the baseline on the commit before this
benchmark landed (`git worktree add`), so before and after are the same bytes.

## Running it

From `web/`, on a build of the commit being measured:

```sh
npm run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER_PATH=/path/to/chrome \
  node bench/largeset/run.mjs --pdf /path/to/set.pdf --set odot-cuy-105743 \
  --label after --out bench/largeset/results/after.json
```

Five runs by default, each in a fresh browser profile; the report gives the
median and every run. Nothing else should be running: the render workers use
every core they are given.

To compare with another commit, build it in a worktree and point `--dist` at
its `dist/` (run from that worktree's `web/`, so `vite preview` is its own).

## Results

`results/` holds the committed runs. A change to the open or render path is
reported against them, on the same machine, in the same PR; a change that
slows the bundled two-sheet plan by more than 5% is a regression even if it
speeds up the large set (`results/sample-*.json` are that check).
