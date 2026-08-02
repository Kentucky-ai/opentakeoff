# MCP and the API — what each one is, and why they are not the same thing

This repository exposes its takeoff capability through **three surfaces**, and
people regularly assume two of them are the same. They are not, and the
difference decides which one you should be wiring into.

| Surface | What it is | Who calls it |
|---|---|---|
| `web/` | The takeoff canvas — a browser app with no server behind it | A human, in a browser |
| `mcp/` | The engine on stdio, self-describing, for AI agents | An MCP client on your machine |
| `server/` | An **optional** HTTP API: a bring-your-own-model socket | The canvas, for suggestions |

If you want an agent to *do a takeoff* — open plans, set scales, click rooms,
export quantities — that is [`mcp/`](../mcp/README.md). If you want to plug your
own vision model in **under** the canvas's suggestion features, that is
[`server/`](../server/README.md). Neither one calls the other.

---

## API and MCP, generally

An **API** is a contract for programs. You publish routes and payload shapes,
and whoever writes the client reads your docs and hard-codes the calls.
`POST /ai/detect-rooms` with this JSON body means nothing until a developer
decides what to send, when to send it, and what to do with the response. The
intelligence lives in the client code, written ahead of time by a person.

**MCP** is a contract for *models*. Same underlying capability, but the server
ships a self-describing catalog: every tool's name, its JSON schema, and a
natural-language description of when to use it, what it refuses, and what its
reply means. A client connects, calls `tools/list`, and the model now knows the
surface without anyone having written an integration for it.

That is why the tool descriptions in [`mcp/src/tools.ts`](../mcp/src/tools.ts)
are long. **The description is the integration.** When `one_click` tells the
agent that a low confidence score is "a `view_sheet {overlay: true}` audit
prompt, not a fact to bid from," that is doing work no REST documentation has
ever done, because no REST client reads its own docs at runtime.

MCP also carries two things a plain API has no equivalent for:

- **Resources** — browsable data the client can pull into context on its own
  (`takeoff://sheets`, `takeoff://sheet/3/text`, `takeoff://sheet/3/image`).
- **Server instructions**, delivered at the `initialize` handshake. Ours sends a
  four-step doctrine before the first tool call: load, scale, commit, *look at
  what landed*, and finish with the marked-up planset. Every client gets it.

That last point is the one people miss. MCP lets you ship the **workflow**, not
just the endpoints.

---

## Why this repo's MCP server is in-process

`mcp/server.ts` imports the takeoff engine straight out of `web/src/lib/*` as
TypeScript and runs it in the same process. There is **no `fetch` anywhere in
`mcp/src/`** — no HTTP hop, no service to stand up, no second implementation to
drift. `npx -y opentakeoff-mcp` and you are driving the same code the browser
canvas runs, on your own machine.

This is the point of [#185](https://github.com/Kentucky-ai/opentakeoff/pull/185):
"the MCP floods through the sealed engine" means an agent's `one_click` and a
human's click on the canvas are literally one implementation, pinned against the
bench corpus in `mcp/test/parity.test.ts`. If they were two implementations
talking over a wire, they would eventually disagree, and the disagreement would
show up as a wrong number in somebody's bid.

The cost of in-process is that the server has to ship the runtime: `tsx` is a
**runtime** dependency here, not a build tool, because the engine is imported as
TypeScript. Rendering (`@napi-rs/canvas`) is optional — where it is missing,
`view_sheet` errors cleanly and the other thirty-five tools still work.

### What "clone it and you have your own server" actually means

Point an MCP client at `npx -y opentakeoff-mcp` and it downloads the package and
runs it as a **local stdio process**. No account, no hosted service, nothing
phones anywhere. The root [`.mcp.json`](../.mcp.json) means the repo configures
its own server, so cloning and opening an MCP-aware editor is enough.

Be precise about what it is driving, though: the MCP server drives **the
engine**, not **the canvas**. It opens PDFs off your disk, measures, and writes
files. The browser canvas is a separate local process that reads those files.
Same machine, same code, two processes, and the handoff between them is a file —
`export_marked_pdf` for the deliverable, `export_takeoff` for the payload the
canvas imports (where agent shapes arrive as dashed pencil for review).

---

## What `server/` is, and what it is not

[`server/app.py`](../server/app.py) is a small FastAPI app exposing four
takeoff-scoped endpoints — `/ai/suggest-scale`, `/ai/detect-rooms`,
`/ai/classify-finish`, `/ai/parse-schedule` — behind an adapter interface
(`adapters/base.py`, with `adapters/heuristic.py` as the transparent default).

It ships **empty of any trained model**. It is a socket: the place to plug a
local vision model in under the canvas's suggestion features. In dev the web app
proxies `/ai/*` to it (`web/vite.config.js`).

It is gated fail-closed on `OT_SANDBOX_API_KEY`
([#175](https://github.com/Kentucky-ai/opentakeoff/pull/175)): with no key set
the sandbox is off, and callers must send the same value as `X-API-Key`.

**It does not drive a takeoff, and the MCP server never touches it.** There is no
estimate, pricing, risk, or scope engine in there — it is the canvas's AI
playground, nothing more.

---

## The other pattern: wrap the API instead

In-process is right here because the capability is a **library**. When the engine
is already server-side and other clients depend on it, the shape flips: the MCP
server becomes a thin translation layer whose tools are HTTP calls, with auth
mapping and response shaping, while the business rules stay in the API where
every client hits them.

That is how most hosted-product MCP servers work, and it is the correct choice
when:

- other clients (a web frontend, a mobile app) already depend on the same API;
- the rules must hold for *every* caller, not just the agent — an agent-side
  check is one client's opinion, an API-side check is the contract;
- the engine cannot run on the user's machine (it needs a database, a GPU, or
  data that must not leave the server).

The trade is a network hop, and a ceiling: you can only expose what the API
already returns. If your agent needs a computation the API does not have, you
either add it to the API — where the frontend inherits it too — or you build it
in the MCP layer and accept that it lives in exactly one client.

**Rule of thumb.** Ask where the capability lives. A library the user can run →
embed it, and ship one process. A service other clients already share → wrap it,
and keep the rules in the service.

---

## The part worth stealing either way

Put the **discipline** in the tool schema, not just the verbs.

The cleanest example in this repo is `mark_verdict`. It mints the agent's
`AGENT` diamond, and it takes **no actor parameter at all**. The estimator's
`APPROVED` ring is human ink, minted only by a click on the canvas's Approve
tool, and an agent physically cannot claim to be the estimator — because the
schema has nowhere to put that claim.

A REST endpoint would have taken an `actor` field and a validator that could be
bypassed, misconfigured, or forgotten. The MCP tool made the wrong thing
*inexpressible*. That is a design move available to any tool author, and it
survives contact with a model that is trying to be helpful.

---

## See also

- [`mcp/README.md`](../mcp/README.md) — the tool-by-tool reference, install
  paths (npx / Docker / `.mcpb` bundle), and tracing
- [`docs/MCP.md`](MCP.md) — driving a takeoff end to end from an agent
- [`server/README.md`](../server/README.md) — the AI sandbox's contract and how
  to write an adapter
- [`mcp/server.json`](../mcp/server.json) — the registry entry
  (`io.github.Kentucky-ai/opentakeoff`)
