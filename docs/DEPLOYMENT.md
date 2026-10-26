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

## MCP releases and recovery

MCP publication is separate from the browser deploy. Pushing an `mcp-v*` tag
runs [publish-mcp.yml](../.github/workflows/publish-mcp.yml): npm publication,
its availability wait, MCP Registry publication/verification, GitHub release,
and desktop bundle. `workflow_dispatch` only exercises Registry authentication.

The [Registry release helper](../scripts/publish-mcp-registry.mjs) uses the
[official exact-version endpoint](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml),
so an older release can be verified even after a newer release becomes latest.
An existing record skips publication only when its complete `server` manifest
matches the tagged `server.json`; Registry response metadata is excluded from
that comparison. A different package, transport, argument, or other manifest
field fails the release instead of accepting a matching version string alone.

If the version is absent, the helper publishes once and waits for visibility.
A recognized duplicate-version race also requires a matching record before
continuing. Transient reads retry within a 15-minute total deadline, at most
60 attempts and a 10-second per-request timeout, with 15 seconds between
attempts. Other publishing failures and conflicting metadata stop immediately.

Read-only verification from the repository root (Node 24):

```sh
node scripts/publish-mcp-registry.mjs mcp/server.json --verify-only
node --test scripts/publish-mcp-registry.test.mjs
```

`--verify-only` never runs the publisher. The tests simulate publication and
network failures; they do not create real releases. Environment overrides use
`REGISTRY_AVAILABILITY_DEADLINE_MS`, `REGISTRY_AVAILABILITY_INTERVAL_MS`,
`REGISTRY_AVAILABILITY_MAX_ATTEMPTS`, and
`REGISTRY_AVAILABILITY_REQUEST_TIMEOUT_MS`; each must be a positive integer.

MCP 0.9.83 exposed this recovery gap: publication succeeded, the immediate
Registry read returned stale data, and rerunning failed on duplicate publication.
Its [release notes](https://github.com/Kentucky-ai/opentakeoff/releases/tag/mcp-v0.9.83)
record the manual completion. Keep existing release tags fixed. Changes to this
helper apply to subsequent tags; rerunning an old tag uses that tag's old
workflow and does not acquire the fix.

## Local/CI parity

Use the repository's pinned runtime and lockfiles to reduce environment drift:

- **Node version** is selected by root `.nvmrc` in CI. `nvm use` inside `web/`
  reads `web/.nvmrc`; keep the two pins aligned.
- **`npm run check`** covers the web job's local type, lint, test, benchmark and
  build sequence, plus the two on-device OCR checks: one `onnxruntime-web`
  before the tests and the `dist/` rules after the build. Other CI jobs still
  cover MCP, protocol, docs, capture and the optional server.
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

## On-device OCR models

The on-device text reader (#469) needs two models and a character list, served
from the site itself. They're gitignored, so every deployment stages them:

```sh
cd web
node scripts/stage-ocr-model.mjs   # or: npm run stage:ocr
```

- **What it does.** Downloads PaddlePaddle's official PP-OCRv5 mobile
  detection and English recognition models from pinned Hugging Face commits
  into `web/public/models/ocr/`, checks each file's SHA-256 (including files
  already on disk; a corrupt one is downloaded again), copies the committed
  character list after checking it, and writes `manifest.json` last. A
  download that runs past its pinned size stops at once, and one that takes
  longer than two minutes fails the run. An interrupted run leaves no
  manifest, and the site then reports OCR as not installed rather than
  half-installed.
- **Where it runs.** CI runs it after the voice model, restoring
  `web/public/models/ocr` from its own cache entry keyed on the script.
  `netlify.toml` runs it before the build and deploys without OCR if it fails,
  the same way voice degrades.
- **Turning it off.** Set `VITE_OCR=off` in the build environment (or in
  `web/.env.local`). The stage script then stages nothing and removes an
  earlier staging, the build ships no models, and the app reports OCR as
  disabled without making any request. `check-ocr-dist` fails an off build
  that still carries `models/ocr`.
- **What's checked.** `node scripts/check-one-ort.mjs` fails unless voice and
  OCR resolve one `onnxruntime-web`, the version `@huggingface/transformers`
  pins, and `npm ls` reports no problem in that tree. After the build, `node scripts/check-ocr-dist.mjs` fails unless
  `dist/assets` has exactly one ORT wasm (the asyncify build), no chunk carries
  OpenCV or `@napi-rs/canvas` code, a staged manifest matches the wasm
  actually shipped, and every other file the manifest lists is a
  `/models/ocr/` path in `dist` at the listed byte length. With OCR on, it
  also fails unless the OCR worker chunk is there and loads that same wasm,
  so the checks can't pass on a build with no OCR code in it; the app's
  import of `src/lib/ocr/client.ts` is what builds the worker.
- **Headers.** The reader needs no new origin in the CSP; the comment in
  `web/public/_headers` says why.

Browsers download the files only after the person agrees, the first time they
use the reader: 36,243,408 bytes raw, which the notice shows as “up to
36.3 MB”. See
[the user guide](USER_GUIDE.md#on-device-text-recognitionwhat-downloads-and-when).

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
