# Deployment and CI

How OpenTakeoff ships: every change lands on `main` through a pull request,
and every merge to `main` is automatically deployed to production at
<https://opentakeoff.kentucky-ai.com>. There is no manual deploy step and no
"deploy later" state—**a merge is a deploy**.

(This file's mechanism description is accurate for this repo—it originally
came in from a downstream fork's own docs during the 2026-07-13 history
merge, which is why earlier revisions named that fork's own deployment,
`takeoff.345flooring.com`, instead of this repo's. See `AGENTS.md`.)

## The pipeline

```
branch → local checks → PR → CI checks → squash-merge
                                                             │
                                                             ▼
                                          Netlify git integration
                                          (netlify.toml: base web/, npm run build)
                                                             │
                                                             ▼
                                          https://opentakeoff.kentucky-ai.com
```

- **CI** (`.github/workflows/ci.yml`) runs on pull requests and pushes to `main`.
  The web job checks types, lint, tests, benchmark reproducibility, and the build.
  Other jobs check MCP on Linux and Windows, release facts and documentation,
  protocol, capture, and the optional server. A green web job alone does not
  cover all required checks.
- **Deploy** is Netlify's own git integration, watching `main`. It builds the
  merge commit from source using `netlify.toml` (`base = "web"`,
  `command = npm run build`, `publish = "dist"`) and publishes the result.
  Nothing is uploaded from Actions.
- **Netlify is the only thing that builds production.** An earlier revision of
  this file said the opposite—that Actions published `web/dist` with
  `--no-build` and "Netlify never builds". That was true until
  `.github/workflows/deploy.yml` was **deleted on 2026-07-13 in `e701f1a`**
  ("deploys here are manual CLI; it fails on every push without the fork's
  secrets"). The merge commit is then built by Netlify from the merged source;
  production deployment follows the protected-branch review and required CI
  checks.

## Local/CI parity

Use the repository's pinned runtime and lockfiles to reduce environment drift:

- **Node version** is selected by root `.nvmrc` in CI. `nvm use` inside `web/`
  reads `web/.nvmrc`; keep the two pins aligned.
- **`npm run check`** covers the web job's local type, lint, test, benchmark and
  build sequence. Other CI jobs still cover MCP, protocol, docs, capture and the
  optional server.
- **`npm ci`** in CI installs strictly from `package-lock.json`; if your
  lockfile is out of sync with `package.json`, CI fails fast rather than
  silently resolving different versions.

## Optional build-time env vars (team cloud mode)

The default build needs **no** environment at all. Turning on the optional
team-only cloud mode (Google sign-in + shared Drive) adds three build-time
variables, read by Vite and inlined into `web/dist` at build:

- `VITE_GOOGLE_CLIENT_ID`—the public OAuth 2.0 Web client id.
- `VITE_GOOGLE_HD`—your Google Workspace domain (for example, `345flooring.com`).
- `VITE_PRICING_FILE_ID`—the Drive file id of the synced `pricing.json`.

All three are **non-secret public identifiers** and are meant to ship in the
bundle—there is no client secret or API key here. They're **optional**: leave them
unset and the app builds and runs exactly as before (anonymous, local-only). Set
them as build environment variables wherever `npm run check`/`build` runs (or in
`web/.env.local` locally—see [`web/.env.example`](../web/.env.example)). Full
one-time setup is in [`GOOGLE_SETUP.md`](GOOGLE_SETUP.md).

## Rules on `main`

As verified on 2026-09-11, the active GitHub ruleset requires one approving review, resolved review threads,
and the `web` status check. Its strict up-to-date check is disabled; the
repository's normal review practice still starts from a current base. Force-push
and branch-deletion protections remain enabled for `main`. Repository administrators
have a standing bypass. These settings can change independently of the source;
check the repository rules before shipping.

Merge with `gh pr merge <n> --squash --delete-branch`, then
`git checkout main && git pull --ff-only`. Squash-merged local branches need
`git branch -D` (git can't see the squash as a merge).

## Security model

- Fork PRs run CI with **no secrets** and a **read-only** `GITHUB_TOKEN`;
  first-time contributors need maintainer approval before workflows run.
- CI uses `contents: read`; MCP publishing requests `id-token: write` for OIDC
  and `contents: write` for GitHub releases. There is no
  Netlify deploy action in the current production path.
- No token values, account identifiers, or rotation procedures appear in this
  repo. Account-level runbook details are documented privately.

## When something fails

- **CI red on a PR**: reproduce the failing job's command on the pinned runtime.
  For the web job, start with `npm run check` in `web/` after `nvm use`.
- **Deploy run red after a merge**: the site keeps serving the previous
  deploy (Netlify deploys are atomic). Fix forward with a new PR, or re-run
  the failed deploy from Netlify once the cause is external
  (for example, a secrets or config issue).
