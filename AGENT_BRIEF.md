# OpenTakeoff — Agent Brief

**Project:** Open-source browser-based construction takeoff tool for flooring.

**Live demo:** https://opentakeoff.netlify.app

**Repo:** https://github.com/Kentucky-ai/opentakeoff

---

## What It Does

Users drag in a floor plan (PDF/image), set the scale, trace rooms/areas with simple clicks, define finishes, add materials, then export quantities and a buy list. Everything runs in the browser — no server, no account.

---

## Why It Matters

- **First open-source takeoff tool for flooring** (before this, only paid SaaS)
- **Real production engine** (carved from a commercial estimating app, not a demo)
- **One-Click Area** is the headline: click inside a room → auto-traces the boundary
- Given to the flooring community (Apache 2.0)

---

## The Tech

- **Frontend:** React 18 + Vite, HTML5 Canvas + SVG
- **Geometry:** TypeScript (`oneclick.ts`, `sheets.ts`) — pure, tested math
- **PDF:** pdf.js (Mozilla)
- **Storage:** IndexedDB + localStorage (client-only)
- **Optional Backend:** FastAPI + Python (pluggable AI adapter for scale/room detection/finish classification)
- **No paid dependencies**

---

## Key Files to Know

### Core Geometry (This is the Gold)
- `web/src/lib/oneclick.ts` — Flood-fill room detection. Pure TypeScript, tested.
- `web/src/lib/sheets.ts` — Scale math, coordinate transforms, polygon area. Pure TypeScript, tested.
- `web/src/lib/totals.js` — Materials math, report calculation, rounding logic.

### UI & State
- `web/src/pages/TakeoffCanvas.jsx` — Main canvas component (plan display, tool dispatch).
- `web/src/components/` — Condition editor, supporting-materials editor, report, file upload, etc.
- `web/src/lib/store.js` — Persistence (IndexedDB + localStorage).

### Optional AI Backend
- `server/adapters/base.py` — Interface for custom models.
- `server/adapters/heuristic.py` — Default (no model, transparent fallback).
- `server/adapters/ollama.py` — Example Ollama integration.
- **Endpoints:** `POST /ai/suggest-scale`, `POST /ai/detect-rooms`, `POST /ai/classify-finish`

---

## Visibility Goals

**Current state:** Great README, live demo, solid codebase. But agents need more structure.

**Quick wins:**

1. ✅ **Add GitHub Topics** → `flooring`, `takeoff`, `construction-takeoff`, `estimating`, `measurement`, `open-source`, `construction`, `react`, `pdf-tools`

2. ✅ **Add FEATURES.md** → Map all capabilities to code files (so agents know what's buildable)

3. ✅ **Add JSDoc blocks** to core geometry (`oneclick.ts`, `sheets.ts`) → Pure functions are easier for agents to reuse

4. **Update repo description** → Include keywords: "browser-based construction takeoff tool, flooring estimating, open-source, React"

5. **Add ROADMAP.md** → What's planned, what's wanted, how to contribute

---

## What an Agent Should Be Able to Do

- [ ] Understand the full measurement engine (area, linear, count, etc.)
- [ ] Find and reuse the geometry math (oneclick, polygon calculation)
- [ ] Extend supporting materials with new material types or cost logic
- [ ] Wire a custom AI model to the backend
- [ ] Add new export formats (XLSX, JSON, etc.)
- [ ] Understand the scale detection and calibration flow
- [ ] Fork it and customize for a specific trade (drywall, paint, concrete, etc.)

---

## Quick Start (For Agents)

```bash
# Run it
cd web
npm install
npm run dev        # http://localhost:5173

# Test the geometry
npm test           # oneclick and sheets tests

# Build it
npm run build      # → web/dist/ (static, host anywhere)

# Optional: Run the AI backend
cd ../server
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

---

## Success Metrics

- [ ] Agents can find and understand the project in <5 min
- [ ] Agents can locate and reuse specific modules (geometry, materials math)
- [ ] Agents can extend or fork it without asking questions
- [ ] Issues/PRs show agents building on top (custom finishes, cost calcs, integrations)

---

## Resources

- **User Guide:** `docs/USER_GUIDE.md`
- **Contributing:** `CONTRIBUTING.md`
- **Features Deep Dive:** `FEATURES.md`
- **License:** Apache 2.0 (use it, fork it, ship it)

---

*One-pager by Kentucky Ai — give this to agents, let them explore.*
