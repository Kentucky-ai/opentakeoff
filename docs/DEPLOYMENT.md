# Deployment & CI

How OpenTakeoff ships: every change lands on `main` through a pull request,
and every merge to `main` is automatically deployed to production at
<https://opentakeoff.netlify.app>. There is no manual deploy step and no
"deploy later" state — **a merge is a deploy**.

(This file's mechanism description is accurate for this repo — it originally
came in from a downstream fork's own docs during the 2026-07-13 history
merge, which is why earlier revisions named that fork's own deployment,
`takeoff.345flooring.com`, instead of this repo's. See `AGENTS.md`.)

## The pipeline

```
branch → npm run check (local) → PR → CI (`web` check) → squash-merge
                                                             │
                                                             ▼
                                          .github/workflows/deploy.yml
                                          npm ci → npm run check → netlify deploy
                                                             │
                                                             ▼
                                          https://opentakeoff.netlify.app
```

- **CI** (`.github/workflows/ci.yml`) runs on every PR: `npm ci` then
  `npm run check` (typecheck → lint → tests → build) inside `web/`.
- **Deploy** (`.github/workflows/deploy.yml`) runs on every push to `main`
  (which, given branch protection, means every merged PR). It re-runs the same
  check, then publishes `web/dist` to Netlify with `--no-build`.
- **Netlify never builds.** It only hosts what Actions uploads. The
  `netlify.toml` build section exists for one-click deploys of forks; the
  production site is upload-only.

## Local/CI parity

CI failures that don't reproduce locally are almost always environment drift.
This repo pins the environment so drift can't happen:

- **Node version** lives in `web/.nvmrc` (one source of truth). `nvm use`
  reads it locally; both workflows read it via `node-version-file`.
- **`npm run check`** is the exact command CI runs — same order, same steps.
  Green locally ⇒ green in CI.
- **`npm ci`** in CI installs strictly from `package-lock.json`; if your
  lockfile is out of sync with `package.json`, CI fails fast rather than
  silently resolving different versions.

## Optional build-time env vars (team cloud mode)

The default build needs **no** environment at all. Turning on the optional
team-only cloud mode (Google sign-in + shared Drive) adds three build-time
variables, read by Vite and inlined into `web/dist` at build:

- `VITE_GOOGLE_CLIENT_ID` — the public OAuth 2.0 Web client id.
- `VITE_GOOGLE_HD` — your Google Workspace domain (e.g. `345flooring.com`).
- `VITE_PRICING_FILE_ID` — the Drive file id of the synced `pricing.json`.

All three are **non-secret public identifiers** and are meant to ship in the
bundle — there is no client secret or API key here, so unlike the Netlify token
they are not repository/environment secrets. They're **optional**: leave them
unset and the app builds and runs exactly as before (anonymous, local-only). Set
them as build environment variables wherever `npm run check`/`build` runs (or in
`web/.env.local` locally — see [`web/.env.example`](../web/.env.example)). Full
one-time setup is in [`GOOGLE_SETUP.md`](GOOGLE_SETUP.md).

## Rules on `main`

Enforced by GitHub branch protection (admins included):

- Changes land via PR only; direct pushes are rejected.
- The `web` CI check must be green.
- The branch must be up to date with `main` before merging.
- No force-pushes, no branch deletion.

Merge with `gh pr merge <n> --squash --delete-branch`, then
`git checkout main && git pull --ff-only`. Squash-merged local branches need
`git branch -D` (git can't see the squash as a merge).

## Security model

- The Netlify deploy token is an **environment secret** on the `production`
  environment, which is restricted to protected branches — only a workflow
  that declares `environment: production` *and* runs from `main` can read it.
  It is never available to pull requests, forks, or other workflows.
- Fork PRs run CI with **no secrets** and a **read-only** `GITHUB_TOKEN`;
  first-time contributors need maintainer approval before workflows run.
- Both workflows declare `permissions: contents: read` (least privilege).
- Only GitHub-owned and verified-creator actions are allowed, and
  `netlify-cli` is pinned to an exact version in the deploy step — bump it
  deliberately, never float it.
- No token values, account identifiers, or rotation procedures appear in this
  repo. Account-level runbook details are documented privately.

## When something fails

- **CI red on a PR**: run `npm run check` in `web/` on Node from `.nvmrc`
  (`nvm use`). It reproduces the failure locally — fix, push, CI re-runs.
- **Deploy run red after a merge**: the site keeps serving the previous
  deploy (Netlify deploys are atomic). Fix forward with a new PR, or re-run
  the failed run from the Actions tab once the cause is external
  (e.g. a secrets/config issue).
