# Command box and voice gate — live verification

Companion to [`COMMAND_VOICE_GATE.md`](COMMAND_VOICE_GATE.md). Captured from the real app on
`localhost:5199` (Vite, Node 24) on this branch, with an existing workspace loaded.

## Topbar (gate up — a plain build, no `VITE_COMMAND_BOX`)

Open · Sheets · sheet chip · Edit · Zone · Snap · 45° · then the Scale cluster. No **Command**
input, no **Voice** button:

<img src="../img/command-voice-gate/topbar-gated.png" alt="The topbar with the gate up: Open, Sheets, sheet chip, Edit, Zone, Snap, 45°, Scale — no Command box, no Voice button" width="900"/>

Holding `M` over the canvas starts no capture: no chip, no message, nothing in the console.
The existing workspace (twelve sheets, nine conditions, 1,431.04 SF of LVT-1) loaded unchanged.

## Gates run on this branch (Node v24.18.0)

| Gate | Result |
|---|---|
| `web`: `npm run check` (typecheck · lint · test · bench · build) | green |
| `web/test/gate.test.ts` | the new `commandBoxEnabled` case passes: off by default, runtime global lifts it |
| `web/test/guideParity.test.ts` | the hold-`M` row left USER_GUIDE §15 and the `?` overlay together |
| voice grammar / dispatcher / capture tests | unchanged, still run |

No MCP surface is involved: the server never had a voice or command-box tool, and none of the
MCP docs mention them.

## Reproduce

```
cd web && npm run check
npm run dev -- --port 5199     # look at the topbar; hold M
VITE_COMMAND_BOX=1 npm run dev -- --port 5199   # both controls return
```
