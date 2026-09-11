# OpenTakeoff — Agent Brief

Start at the [knowledge index](docs/wiki/README.md), also exposed as
`takeoff://wiki` to MCP clients. Read the page for the current task.

If you're an agent about to work *on* this repo, read
[`AGENTS.md`](AGENTS.md) next. If you're an agent about to *drive the takeoff engine*, read
[`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) instead—that's your manual, this is orientation.

For the draft persisted-record contract and known compatibility gaps, read
[`docs/TAKEOFF_PROTOCOL.md`](docs/TAKEOFF_PROTOCOL.md). The draft changes no current
tool behavior or saved-file format.

**Repo:** <https://github.com/Kentucky-ai/opentakeoff> · **Live:**
<https://opentakeoff.kentucky-ai.com> · **License:** Apache-2.0

---

## What it is

A takeoff is the act of measuring quantities off a construction drawing—how much floor, how
much wall, how many fixtures, at what scale, on which sheet. OpenTakeoff is an open-source
engine for doing that, with a browser canvas and an MCP server sharing geometry and quantity modules:

- **A stdio MCP server** (`npx -y opentakeoff-mcp`)—<!--tool-count-->53<!--/tool-count--> tools plus browsable sheet and wiki resources (One-Click's two verbs are temporarily gated and not registered; see `docs/design/ONE_CLICK_GATE.md`).
  An agent opens a plan, reads the title block, sets the scale, measures source-backed boundaries, checks its own
  work on a rendered overlay, and hands back a marked-up planset.
- **A browser canvas**—client-only React. An estimator drags in a plan set and traces it. No
  backend, no database, no account, no upload.

Neither wraps the other. `mcp/` imports shared web modules, so both surfaces use shared quantity
math and exchange takeoff records. Shared modules do not guarantee identical detector boundaries:
the browser and MCP room-detection paths currently differ, and One-Click remains gated while that
boundary is re-validated. Actor, review and transport support differ; see the [compatibility
matrix](protocol/COMPATIBILITY.md) before claiming a lossless round trip.

## Why it exists

Two reasons, and the second is the load-bearing one.

1. **There was no open-source takeoff engine at all**—web-based or otherwise—and nothing an
   autonomous agent could call. Agents are first-class users here, not an integration bolted on
   the side.
2. **Every shape records how it was made**: the scale it was measured at, the method (vector
   flood, raster trace, hand-drawn, agent-proposed), whether a human corrected it, and the
   machine's original boundary frozen beside the correction. Downstream that's an audit trail.
   Upstream it's a labeled *(geometry → finish)* pair—the training signal takeoff models have
   never had at scale. See the README's [data layer](README.md#the-data-layer--why-this-engine-exists).

## The rules that shape the code

Change anything here and you'll run into these. They are deliberate, and they hold identically on both
front ends:

- **Scale is a gate, not a default.** A detected scale note is a suggestion; adopting it is an
  explicit act. Measuring an unscaled sheet refuses.
- **Geometry needs source evidence.** Manual measurement tools accept supplied
  coordinates; they do not prove those coordinates match the drawing. Inspect
  the overlay and retain source citations before relying on quantities.
- **Machine work is pencil until a person inks it.** The green `APPROVED` seal has exactly one
  code path—the toolbar button under a human hand.
- **Withholding is an answer.** Tools that can't answer say why, with coordinates to look at,
  rather than returning a plausible number.
- **Waste applies only in the report's order quantity**, never to the live measured number.

## The stack

React 18 + Vite 6 (plain JSX) · raw HTML5 Canvas + SVG, no drawing frameworks · pure, unit-tested
TypeScript geometry (`oneclick.ts`, `sheets.ts`) · pdf.js · IndexedDB + localStorage ·
TypeScript stdio MCP server · `node --test` + `tsx` · no paid dependencies.

An optional FastAPI adapter interface lives in `server/` for plugging your own vision model under
the canvas's suggestion endpoints. The app is fully functional without it.

## Where the value is concentrated

| What | Where |
|---|---|
| Flood fill, face extraction, corner snap, raster fallback | `web/src/lib/oneclick.ts`—pure TS, tested |
| Scale detection, sheet helpers, polygon area | `web/src/lib/sheets.ts`—pure TS, tested |
| Waste, square-yard, coverage → order quantity | `web/src/lib/totals.js` |
| Roll-goods lane and seam layout | `web/src/lib/rollgoods.js`—pure, tested |
| The canvas (one large component, ~90% of the app) | `web/src/pages/TakeoffCanvas.jsx` |
| MCP server (imports the same libs) | `mcp/src/` |

The geometry libraries are React-free and DOM-free on purpose—lift them straight out.

## Run it

```bash
cd web && npm install && npm run dev     # http://localhost:5173
npm run check                            # typecheck + lint + test + build — exactly what CI runs
```

## The doc set

| Document | For |
|---|---|
| [`README.md`](README.md) | The project, all audiences |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | The estimator at the canvas |
| [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) | The agent driving the engine over MCP |
| [`mcp/README.md`](mcp/README.md) | Tool-by-tool MCP reference |
| [`AGENTS.md`](AGENTS.md) | Working *on* this repo—map, conventions, ship discipline |
| [`FEATURES.md`](FEATURES.md) | Capability → the code that implements it |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Ground rules, and the open RFCs |

---

*Kentucky AI—the measuring engine, given to anyone who needs to read a building.*
