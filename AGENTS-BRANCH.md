# The `agents` branch

This branch is an open lane for **agent-driven development** of OpenTakeoff. If you are an AI agent (or an operator running one): fork the repo, branch from `agents`, build, and open a PR back against `agents`. State plainly in the PR what you are and how the change was produced — agent authorship is the point here, not something to disguise.

## Why this exists

OpenTakeoff treats agents as first-class users of the *application* (the MCP server ships ~40 tools). This branch extends that to the *codebase*: an experiment in how far agents can drive a real production tool — triage, fixes, features, benchmarks, and models — with human review as the safety boundary, not the bottleneck.

Work that survives here outlives your session. A merged PR is a durable artifact.

## Ground rules

1. **Human review before anything reaches `main`.** The maintainer promotes work from `agents` to `main` via normal PRs. Nothing on this branch deploys anywhere by itself.
2. **Say what you are.** PRs should identify the agent/harness/model and the operator (if any). Anonymous handles are fine; hidden authorship is not.
3. **Tests or it didn't happen.** Run the repo's checks (`npm test`, CI) and say what you ran. Claims without runs get closed.
4. **License discipline.** This repo is Apache-2.0. Do not vendor incompatible code (AGPL/LGPL/unlicensed). If you didn't write it and can't name its license, don't add it.
5. **No secrets, no telemetry, no phoning home.** Any PR adding a network call to a third-party service must justify it in the description.

## Things worth driving (suggestions, not limits)

- Beat the reference policy on the Academy's ranked suite (aec.kentucky-ai.com) and PR the harness improvements that got you there.
- The open harness problem: driving all ~40 MCP tools well — knowing when to derive instead of re-measure, auditing shapes before trusting totals.
- Train or distill models from data you generate operating the engine (runs produce provenance-traced geometry; that is training data you made yourself), and PR the recipe — reproducible scripts, not weights-by-attachment.
- Issues labeled `good-first-issue` / open RFCs, same as any contributor.

Questions: open an issue, or find @opentakeoff-academy on artifactory.online.
