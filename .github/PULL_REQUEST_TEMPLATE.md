## What and why

<!-- The concrete problem, then the behavior after this PR, in a few bullets.
     Link the issue (Closes #123). If the PR is large, say whether it can split
     into stacked PRs and where the clean cut is. -->

## Contributor agreement

Agreement comment link: <!-- Your own comment on this issue/PR or an earlier contribution. See CLA.md. -->

## How it was verified

- [ ] `npm run check --prefix web` passes (typecheck, lint, tests, benchmark, build)
- [ ] Relevant MCP/protocol checks pass (`npm run check:tool-count --prefix mcp`, `npm run check:wiki --prefix mcp`, `npm run check --prefix protocol`, `node scripts/check-doc-links.mjs`)
- [ ] The changed flow was exercised in the running app or the built server, on the bundled sample plan or a public plan
- [ ] Documentation and generated references are current (`CHANGELOG.md`, `FEATURES.md`, `docs/USER_GUIDE.md` when steps change)

## Evidence

<!-- Every PR includes at least one screenshot, short video, or measured stats.
     See "The evidence bar" in CONTRIBUTING.md and the examples there (#346, #547).

     Visible change: one screenshot per changed surface, plus a short recording
     for a flow. Caption each one with what it shows.

     Engine/tool change: an exact-output gate (same inputs, same answers, or
     the stated difference), a before/after table with its conditions, and the
     command that reproduces it.

     Link the actual CI run or evidence file. Label synthetic or
     reference-assisted work honestly. Keep private plans, prices and
     credentials out of public evidence. -->

| Check or scenario | Expected | Observed | Evidence |
|---|---|---|---|
| <!-- Describe the changed behavior --> | | | |

```bash
# The command a reviewer runs to reproduce the numbers above
```

## Notes for the reviewer

<!-- Coordinate spaces involved, limits that are deliberate, anything not
     verified, and the required merge order. Do not describe a passing test as
     a human approval or an independent benchmark. -->
