# AGENTS.md — a map of this repo for coding agents (and fast-moving humans)

OpenTakeoff is a **client-only React app**: a PDF construction-takeoff canvas for flooring (useful for any trade). No backend, no database, no auth — everything runs and persists in the browser. Apache-2.0. (For the one-page project pitch and vision, see [`AGENT_BRIEF.md`](AGENT_BRIEF.md); for capability → code mapping, see [`FEATURES.md`](FEATURES.md).)

## Run / build / check

```bash
cd web
nvm use          # Node pinned by web/.nvmrc (CI reads the same file)
npm install
npm run dev      # http://localhost:5173 — hot reload
npm test         # node:test over the pure geometry + totals math (test/*.test.ts)
npm run build    # → web/dist/ (static output; this is what Netlify deploys)
npm run check    # typecheck + lint + test + build — exactly what CI runs; green here ⇒ green CI
```

## Shipping — the required steps, every change

`main` is protected on GitHub via a ruleset (PR-only, one approving review,
green `web` check, branch up to date — the repo owner has a standing bypass
as the solo maintainer). **Merging to `main` deploys to production**
(<https://opentakeoff.kentucky-ai.com>) via `.github/workflows/deploy.yml`, which
re-runs `npm run check` and publishes `web/dist` to Netlify with `--no-build`
— Netlify never builds anything itself.

> **This is the canonical `Kentucky-ai/opentakeoff` repo — production is
> <https://opentakeoff.kentucky-ai.com>, nothing else.** A downstream fork
> (`knmurphy/opentakeoff`) tracks this repo as its own upstream and deploys
> separately to `takeoff.345flooring.com` — that URL belongs to *that* fork,
> not this repo. If you're seeing `takeoff.345flooring.com` referenced
> elsewhere in this repo's docs (`docs/DEPLOYMENT.md`,
> `docs/PARENT_FORK_PORTS.md`), it's leftover content from that fork's own
> `AGENTS.md`/docs that rode along in a wholesale history merge (2026-07-13) —
> treat it as describing the *downstream* fork's deployment, not this one's.

So:

1. **Branch first** — never commit on `main`: `git checkout -b <topic>`.
2. **`npm run check` before pushing** (in `web/`). It is exactly what CI runs,
   on the same Node (`web/.nvmrc`) — green here means green CI.
3. **Open a PR** and wait for the `web` check to pass. Don't merge red or
   pending.
4. **Squash-merge with branch delete**
   (`gh pr merge <n> --squash --delete-branch`), then
   `git checkout main && git pull --ff-only` and delete the local branch
   (`git branch -D <topic>` — squash merges need `-D`).
5. **Remember a merge is a deploy.** Don't merge work you haven't verified in
   the running app.

The tests cover the pure math (`web/test/geometry.test.ts`, `web/test/totals.test.ts`); the canvas itself is verified by hand — **Vite does not flag undefined identifiers in JSX**, so grep for your new identifiers after editing and load the app once before you call it done. The bundled sample plan (`web/public/demo/`, wired to the "Load sample plan" button) is the fastest end-to-end check: load it, press `A`, trace a room, open Report.

## Where things live

| Concern | Path |
|---|---|
| **The canvas — 90% of the app** | `web/src/pages/TakeoffCanvas.jsx` (one large, deliberately monolithic component) |
| Geometry: vector extraction, One-Click flood fill, vertex snap | `web/src/lib/oneclick.ts` |
| Sheet/page helpers, scale detection | `web/src/lib/sheets.ts` |
| Totals & materials math (waste, SY, coverage → order qty) | `web/src/lib/totals.js` |
| Persistence (IndexedDB + localStorage) | `web/src/lib/store.js` |
| PDF/image/zip ingest | `web/src/lib/ingest.js` |
| Icon set | `web/src/brand/icons.jsx` |
| Design tokens (colors, spacing — the source of truth) | `web/src/styles/tokens.css` |
| Sheet gallery / report UI | `web/src/components/` |
| Pure-math tests (node:test) | `web/test/` |
| **Optional AI backend** (pluggable adapter: scale/room/finish suggestions) | `server/` — `app.py` + `adapters/base.py` (interface) + `adapters/heuristic.py` (default, no model) |

## How the canvas works (the mental model)

- Each open sheet renders into a `<canvas>` bitmap; **all takeoff geometry is an SVG overlay** on top; pan/zoom is a single CSS transform on the stage div, written imperatively (`tfRef` → `style.transform`) to avoid React re-renders per frame.
- Coordinates: pointer events (client px) → `toImage()` → **stage px**; committed shapes store **normalized [0..1] vertices per sheet** (`verts_norm`), so quantities survive re-renders and zoom.
- Cursor-following UI (crosshair hairlines, readout chip, rubber band) updates via **direct DOM writes in `moveCrosshair`** — never React state per mousemove. Keep it that way.
- Angle snapping: `angleSnap()` locks in-progress segments to the 45° family; endpoint snap (`nearestSnap` over a spatial hash of PDF vector endpoints) takes priority. The committed click reuses the same locked point (`angleRef`).
- Past ~1.15× zoom, a **detail-view canvas** re-renders the visible region from PDF vectors at the current zoom (crispness); the base bitmap stays as first paint.
- pdf.js rendering schedules work on `requestAnimationFrame` — a fully hidden/occluded window will pause mid-render by design; it resumes when visible.

## Conventions

- **SVG presentation attributes take literal colors** (CSS vars don't resolve there): cobalt `#1f3fc7`, danger `#b03a26`, positive `#1f6b4a` — centralized in `web/src/lib/ui.js` (`SVG`, with HUD-dark counterparts via `svgAccent(isDark)`). DOM/HTML chrome may use `var(--…)` from `tokens.css`.
- Condition palettes (`PALETTE` in `web/src/components/hatches.jsx`, the seeded condition colors in `FLOORING_DEFAULTS` in `web/src/lib/canvasConstants.js`, and the mirrored copies in `mcp/src/session.ts`) are **user data** — don't re-theme them.
- Waste applies only in the report (order quantities), never to live measured numbers.
- Keyboard shortcuts are single letters registered on `window` (see `docs/USER_GUIDE.md` §15); toolbar menus pause them via `menuDepthRef`.
- Brand voice: **precision instrument** (2026-08 overhaul). Light theme = "ice": bright white surfaces on a cool field, cool-slate neutrals, cobalt the one saturated thing. Dark theme = "HUD": true-black cockpit, electric blue `#3f8cff`, phosphor `--glow` on exactly five elements (active tool face, status verb, hero quantity, primary CTA, calibration dot). Square corners; the single sanctioned radius is `--r-1` on floating chrome. Mono tabular numerals on every readout. Drafting-table language stays. No vendor mimicry.
- Layout/spacing/type come from the token scales in `tokens.css` (`--sp-*`, `--fs-*`, `--ctl-*`); zIndex comes from the `Z` ladder in `web/src/lib/ui.js`. No new magic numbers.

## Docs to keep in sync when you change behavior

1. `README.md` (Features + "What's in the box")
2. `docs/USER_GUIDE.md` (shortcuts + the relevant section)
3. `CHANGELOG.md`

Touching the **MCP server** adds four more, and they drift independently — the
tool count alone lives in five places, so grep the old number before you assume
you got them all:

4. `mcp/src/tools.ts` — the tool's own `description` **is** its integration.
   An MCP client reads it at runtime; nothing else you write reaches the model.
5. `mcp/server.ts` — the `instructions` block sent at `initialize`. This is the
   decision tree every client receives before its first call. A new *verb* does
   not belong here; a new *step in the standard finish* does.
6. `mcp/README.md` (the tool table) and `docs/MCP.md` (the reach-for-it ordering,
   the example session, and the tool count in its opening line).
7. **Version, on three surfaces that must agree**: `mcp/package.json`,
   `mcp/server.json`, `web/public/.well-known/mcp.json`. They have drifted
   before (#171, and again at 0.9.28). Check `git show HEAD:mcp/package.json`
   before bumping — a concurrent branch may already have claimed the number.

Architecture rather than behavior — what MCP is versus what the `/ai` sandbox
is, and why the server is in-process — lives in `docs/MCP_AND_API.md`.

<!-- REPOWISE_AGENTS:START — Do not edit below this line. Auto-generated by Repowise. -->
## Codebase Intelligence for fork-opentakeoff (Repowise)

Indexed by [Repowise](https://repowise.dev). Last indexed: 2026-08-26 (commit 810c3a8)
### How to work in this repo

- **Trust the index.** `verified: true` means the bytes were checked against the live tree, so never re-read those lines. Re-read only on `bounds: "approximate"`, `_meta.stale_warning`, `search_method: "bm25"` or `confidence: "low"`; `index_behind: true` alone is informational.
- **Pre-edit, not instead-of-edit.** These tools decide *which* files to read and edit. Reading a file before you edit it is correct and expected.
- **Noisy commands** (tests, builds, `git log`/`diff`, searches, listings): prefer `repowise distill <cmd>`, the same command with its exit code preserved and errors-first output. A `[repowise#<ref>: N lines omitted]` marker is recoverable via `repowise expand <ref>` (add `-q <regex>` to filter); never re-run the command to see omitted output.
- **Recording a decision** you had to reason out: `repowise decision add --title T --decision D` records it without prompting and prints the id (`--format json` to parse it back). It lands `proposed`, for a person to confirm.

### Tools

| Tool | When and why |
|------|--------------|
| `get_answer(question)` | First call for any how/where/why question. Cite `confidence: "high"` or `grounding: "extracted"` directly; `degraded` means judge by `retrieval_quality`. `symbol_bodies` has live bodies. |
| `get_context(targets=[...])` | Triage card for files/modules/symbols: docs, signatures, hotspot, fix history. No source bytes — `include=["skeleton"]` for the whole file verified, `["callers"|"decisions"]` for depth. Batch targets. |
| `get_symbol(id)` | **Follow-up, not an entry point** — one verified body for an id a prior response named (`path.py::Name`, `path.py:140-180`, `repowise#<hex>`). Never walk a file symbol by symbol; Read it. |
| `search_codebase(query)` | Hybrid search, auto-routed by query shape; force with `mode=symbol|path|concept|hybrid`. A hit whose `sources` are `[fts]` only has no semantic agreement, so verify it. |
| `get_why(query, targets?)` | Why the code is shaped this way: decision records, git archaeology, rationale comments. Call before a refactor or a pattern divergence. |
| `get_risk(targets, changed_files?)` | What history says about touching these files. PR mode (`changed_files`) leads with a `directive`: read `will_break` / `missing_cochanges` / `missing_tests` / `tests_to_run` first. |
| `get_change_risk(revspec, extensions?, exclude_patterns?)` | Defect score for a whole commit or `base..head` range, from its diff on the live checkout. Lead with `risk_percentile`. Scores a range; `get_risk` scores paths. |
| `get_health(targets?, include?)` | Defect / maintainability / performance scores and findings. Self-check the files you touched before finishing. |
| `get_dead_code()` | Confidence-tiered unreachable files / unused exports / zombie packages. For cleanup sweeps, not targeted fixes. |
| `get_overview()` | Architecture map. Call once, first, in an unfamiliar repo; skip it after that. |

### Entry points
- `mcp/server.ts`
- `server/app.py`
- `web/src/main.jsx`

### Files that need care (bug-fix history first, then churn — check `get_risk` before editing)
- `web/src/pages/TakeoffCanvas.jsx` — 39 bug fixes, last fix today (bug magnet); 169 commits/90d
- `web/src/components/ReportPanel.jsx` — 13 bug fixes, last fix yesterday (bug magnet); 54 commits/90d
- `web/src/components/TakeoffsPanel.jsx` — 9 bug fixes, last fix yesterday (bug magnet); 29 commits/90d
- `web/test/unitSystemGlobal.test.ts` — 7 bug fixes, last fix yesterday (bug magnet); 9 commits/90d
- `mcp/src/session.ts` — 8 bug fixes, last fix 4 weeks ago (bug magnet); 53 commits/90d

### Code health
Three co-equal signals: defect risk 7.51/10 avg, hotspot health 6.16/10 (stable), worst `web/src/lib/oneclick.ts` at 3.01/10 · maintainability 8.24/10 · performance risk 43 open static I/O-in-loop / N+1 findings. Detail: `get_health()`.

Critical files:
- `web/src/pages/TakeoffCanvas.jsx` — prior defect — impact −2.0
- `CHANGELOG.md` — prior defect — impact −2.0
- `web/test/unitSystemGlobal.test.ts` — prior defect — impact −2.0
- `web/src/lib/totals.js` — prior defect — impact −2.0
- `web/src/components/TakeoffsPanel.jsx` — prior defect — impact −2.0

<!-- REPOWISE_AGENTS:END -->
