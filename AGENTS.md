# AGENTS.md — start here

OpenTakeoff has two audiences: people working on the repository and agents
performing takeoffs. Start with the [wiki index](docs/wiki/README.md); read only
the page needed for the current task.

## Quick start

**To run a takeoff**, you don't need a clone. Connect the published server
(`npx -y opentakeoff-mcp`, Node 20+). In this repository, `.mcp.json`,
`.cursor/mcp.json` and `.vscode/mcp.json` already register it. Read the
`takeoff://wiki` resource first, then follow the standard finish in the
[agent manual](docs/AGENT_GUIDE.md): `load_plan`, `set_scale`, rooms on the wall
faces, `view_sheet` with an overlay, and `export_marked_pdf`. The bundled plan
`demo/sample-finish-plan.pdf` has a finish schedule to resolve tags against.

**To change the code**, read the [repository guide](docs/wiki/repo-guide.md),
branch, run `npm ci && npm run check` in `web/`, and open a PR that meets the
[evidence bar](CONTRIBUTING.md#the-evidence-bar). A PR from an agent merges under
the same bar as anyone else's. The person running the agent signs the
[CLA](CLA.md).

| Task | Read next |
|---|---|
| Change code, test, ship or open a PR | [Repository guide](docs/wiki/repo-guide.md) — required before editing |
| Understand browser/MCP/package boundaries | [Architecture](docs/wiki/architecture.md) |
| Change persisted fields or design an adapter | [Protocol](docs/wiki/protocol.md), then its inventory and Academy compatibility report |
| Perform a takeoff or help a human stitch sheets | [Workflows](docs/wiki/workflows.md) |
| Select MCP tools, stages or coordinate frames | [MCP](docs/wiki/mcp.md), then the generated tool index |
| Interpret quantities, deductions or review authority | [Domain knowledge](docs/wiki/domain.md) |
| Check current support and known limits | [Capability status](docs/wiki/status.md) |

The repository guide preserves the full build, performance, style and release
conventions. Key requirements:

- Branch first. Run `npm run check --prefix web` before pushing, plus the relevant
  MCP/protocol checks. A merge to `main` deploys production; verify the changed
  app behavior and wait for required checks before merging.
- Every PR includes screenshots/video or measured expected-versus-observed
  stats, reproducible commands and linked evidence. Protect private project data.
- Geometry edits must preserve existing machine originals. MCP cannot create
  human approval. A schema-valid record does not authenticate its author.
- Read the field inventory before changing persistence. No engine rewrite or
  default format migration is implied by the draft protocol.
- Update source-backed docs in the same change. Run
  `npm run check:tool-count --prefix mcp`, `npm run check:wiki --prefix mcp`,
  `npm run check --prefix protocol`, and `node scripts/check-doc-links.mjs`.
  Their `--write` modes regenerate references; CI rejects stale output.

Production: <https://opentakeoff.kentucky-ai.com>.
