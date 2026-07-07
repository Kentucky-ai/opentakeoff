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

`main` is protected on GitHub (PRs only, green `web` check, branch up to date,
no force-pushes — admins included) and a local pre-commit hook rejects commits
made on `main`. **Merging to `main` deploys to production**
(<https://takeoff.345flooring.com>) via `.github/workflows/deploy.yml`, which
re-runs `npm run check` and publishes `web/dist` to Netlify with `--no-build`
— Netlify never builds anything itself. So:

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

- **SVG presentation attributes take literal colors** (CSS vars don't resolve there): cobalt `#1f3fc7`, danger `#b03a26`, positive `#1f6b4a`. DOM/HTML chrome may use `var(--…)` from `tokens.css`.
- Condition palettes (`COLORS`, `PALETTE` in `TakeoffCanvas.jsx`) are **user data** — don't re-theme them.
- Waste applies only in the report (order quantities), never to live measured numbers.
- Keyboard shortcuts are single letters registered on `window` (see `docs/USER_GUIDE.md` §2); toolbar menus pause them via `menuDepthRef`.
- Brand voice: paper/ink/cobalt, drafting-table language. No vendor mimicry.

## Docs to keep in sync when you change behavior

1. `README.md` (Features + "What's in the box")
2. `docs/USER_GUIDE.md` (shortcuts + the relevant section)
3. `CHANGELOG.md`
