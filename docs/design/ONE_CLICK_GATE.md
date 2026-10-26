# One-Click gate — temporary

**Status:** in force. **Lift:** `VITE_ONE_CLICK=1` (canvas build) · `OPENTAKEOFF_ONE_CLICK=1` (MCP server process) · `globalThis.__OT_ONE_CLICK = true` (runtime, tests and lab drivers) · `buildServer(session, { oneClick: true })` (in-process).

## Why

The flood engine behind One-Click Area (`web/src/lib/oneclick.ts`, and the batch form in
`detectRooms.ts`) is being re-validated against a wider plan corpus. Until that finishes, a
person or an agent reaching for it gets an answer that may be wrong in ways that read as right,
and a quantity that reads as right is the worst failure an estimating tool has. So the reach is
closed, not the engine: the code, the bench and its goldens stay exactly as they are, and
`npm run check` still rules them.

## What the gate does — every surface

| Surface | Gate up (default) | Gate lifted |
|---|---|---|
| MCP `tools/list` | 45 tools; `one_click`, `detect_rooms` **not registered** | 47 tools |
| MCP initialize `instructions` | step 2 names `measure_polygon`; `GATE_NOTE` appended; WITHHELD line drops `detect_rooms` | original text |
| Other tool descriptions (`sheet_info`, `measure_surface`, `place_count`, `get_sheet_vectors`, `edit_shape`, `edit_materials`, `undo_last`, `sheet_graph`, `find_text`, `view_sheet`, `annotate`) | never name the gated verbs | original text |
| Staged exposure (`open_tool_stage`) | `measure` opens without the gated verbs | full `measure` stage |
| Canvas rail (MEAS) | no One-Click tile | tile present |
| `O` shortcut | message bar: the gate sentence; arms nothing | arms One-Click |
| Voice deixis trace, double-click, any caller of `oneClickAt` | refuses with the gate sentence | traces |
| In-app agent tool list (`agentToolDefs()`) | no `one_click`; `propose_shapes` describes hand-traced rings | full `AGENT_TOOL_DEFS` |
| In-app agent system prompt | "One-Click is temporarily gated…" rule; method says trace from `view_region` | engine rule |
| In-app quick reference (`?`) | Measure row says Area; no `O` row; no One-Click `⏎`/`⌥` hints | original rows |
| README / USER_GUIDE / MCP docs / AGENT_GUIDE / FEATURES / AGENT_BRIEF | banner + notes; tool count 45 | n/a |

## What it never changes

- Stored data. A shape traced by One-Click before the gate keeps its `origin.method`
  (`one_click_v1`, `net_v1`, `agent_v1`) and every provenance field. Nothing is rewritten on
  load; nothing is stripped on export.
- Exports, reports, the marked set, sync, imports, revisions: byte-identical for the same data.
- The engine and the bench. `web/bench/corpus` goldens are untouched and the bench still gates
  `npm run check`. `mcp/test/parity.test.ts`, `conformance`, `e2e`, `overlap`, `raster`,
  `context` and the flood tests in `tools.test.ts` run with the gate lifted in-process.
- The staging table (`TOOL_STAGES`) keeps both verbs; `stagesFor(false)` is the default view.

## Where the switch lives

- `mcp/src/gate.ts` — `GATED_TOOLS`, `ONE_CLICK_ENV`, `oneClickEnabled(explicit?)`, `GATE_NOTE`,
  `GATE_HINT`. No imports, so nothing can cycle through it.
- `mcp/src/staging.ts` — `ALL_TOOL_NAMES` (the table), `TOOL_NAMES` (the default surface; this
  is what the README count, the dist smoke and `tools.test` read), `toolNamesFor`, `stagesFor`.
- `mcp/src/tools.ts` — `registerTools(server, session, { oneClick })`; the two registrations sit
  inside `if (oneClick)`; every description that pointed at them is a template on `oneClick`.
- `mcp/server.ts` — `buildServer(session, { oneClick })`, instructions.
- `web/src/lib/gate.js` — `oneClickEnabled()` (read at call time, never frozen at import),
  `ONE_CLICK_GATE_MESSAGE`.
- `web/src/pages/TakeoffCanvas.jsx` — rail filter, key map, the guard at the top of
  `oneClickAt` (every caller funnels through it), `agentToolDefs()` for the agent panel.
- `web/src/lib/agentTools.js`, `agentLoop.js`, `components/UserGuide.jsx`.

## Tests

- `mcp/test/gate.test.ts` — default build lists exactly `TOOL_NAMES`, neither gated verb, no
  surviving description names one, instructions carry `GATE_NOTE`, a call is an unknown-tool
  refusal; lifted build lists `ALL_TOOL_NAMES` and drops the note; staged+gated opens `measure`
  without the verbs; env flag and explicit option precedence.
- `web/test/gate.test.ts` — agent surface without `one_click`, `propose_shapes` description,
  `executeAgentTool("one_click")` refusal, system prompt, runtime lift.
- `web/test/guideParity.test.ts` — the in-app quick reference and USER_GUIDE §15 agree with the
  `O` row gone.
- `mcp/scripts/check-tool-count.mjs` — README and USER_GUIDE markers say 45.

## Removing the gate

Delete `mcp/src/gate.ts` and `web/src/lib/gate.js`, drop the `oneClick` branches (every one is
a template expression or an `if (oneClick)`), restore `TOOL_NAMES = ALL_TOOL_NAMES`, delete the
two gate tests, run `check:tool-count -- --write`, and revert the doc banners. The engine needs
nothing.
