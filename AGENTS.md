# AGENTS.md — a map of this repo for coding agents (and fast-moving humans)

OpenTakeoff is a **client-only React app**: a PDF construction-takeoff canvas for flooring (useful for any trade). No backend, no database, no auth — everything runs and persists in the browser. Apache-2.0.

## Run / build / check

```bash
cd web
npm install
npm run dev      # http://localhost:5173 — hot reload
npm run build    # → web/dist/ (static output; this is what Netlify deploys)
```

There is no test suite yet; the build is the gate. **Vite does not flag undefined identifiers in JSX** — grep for your new identifiers after editing and load the app once before you call it done. The bundled sample plan (`web/public/demo/`, wired to the "Load sample plan" button) is the fastest end-to-end check: load it, press `A`, trace a room, open Report.

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

## How the canvas works (the mental model)

- Each open sheet renders into a `<canvas>` bitmap; **all takeoff geometry is an SVG overlay** on top; pan/zoom is a single CSS transform on the stage div, written imperatively (`tfRef` → `style.transform`) to avoid React re-renders per frame.
- Coordinates: pointer events (client px) → `toImage()` → **stage px**; committed shapes store **normalized [0..1] vertices per sheet** (`verts_norm`), so quantities survive re-renders and zoom.
- Cursor-following UI (crosshair hairlines, the magnifier loupe, rubber band, angle guide) updates via **direct DOM writes in `moveCrosshair`** — never React state per mousemove. Keep it that way.
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
