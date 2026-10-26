# Command box and voice — gated off the toolbar

**Status:** in force (2026-09-05). **Lift:** `VITE_COMMAND_BOX=1` (build) · `globalThis.__OT_COMMAND_BOX = true` (runtime).

## Why

Nobody used them on the toolbar. The typed command line and push-to-talk dictation were built as
the accessibility and hands-busy path for setting takeoff metadata (RFC #59); in practice the
condition rail, the label picker and the keyboard shortcuts carry that work. So the two controls
leave the topbar and `M` stops arming a capture. Nothing behind them is removed: the grammar
(`voiceIntent.ts`), the dispatcher (`voiceActions.ts`), the capture and recognizer clients, and
every state-equivalence test stay exactly as they are, so the surface can return with one flag.

## What the gate does

| Surface | Gate up (default) | Lifted |
|---|---|---|
| Topbar **Command** cluster (`cpt 1 · waste 7 · this room`) | not rendered | rendered |
| Topbar **Voice** button (`talk · M`) | not rendered | rendered where capture is supported |
| Hold `M` | arms nothing | starts dictation |
| `?` quick reference | no hold-`M` row | row present |
| USER_GUIDE §15 / §17, README, FEATURES, docs/VOICE.md | note | n/a |

## What it never changes

The Netlify build still stages the on-device voice model (harmless, gitignored, not fetched at
runtime). Stored data, exports, sync, the report and the marked set are untouched. The One-Click
gate (`ONE_CLICK_GATE.md`) is independent; the voice deixis trace ("this room") was already refused
by that gate at `oneClickAt`.

## Where the switch lives

`web/src/lib/gate.js` `commandBoxEnabled()`; `TakeoffCanvas.jsx` (the two `cluster(...)` calls and
the `M` keydown handler); `components/UserGuide.jsx`. Test: `web/test/gate.test.ts`.

## Removing the gate

Delete `commandBoxEnabled` and its three call sites, restore the `M` row in USER_GUIDE §15 and the
overlay together (guideParity holds them in step), revert the doc notes.
