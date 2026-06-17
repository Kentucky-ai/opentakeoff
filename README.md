<div align="center">

# OpenTakeoff

**A free, open-source PDF takeoff canvas — built for flooring contractors.**

Open a plan, set the scale, trace your areas, and export your quantities.
One-click room detection. Runs entirely in your browser. No account, no upload, no cost.

[Quick start](#quick-start) · [Features](#features) · [The open flooring model](#the-open-flooring-model) · [AI sandbox](#optional-ai-sandbox) · [Contributing](CONTRIBUTING.md)

</div>

---

Commercial takeoff tools start around **$1,200–$5,500/yr**, and the flooring
options run **$600–$2,100/yr**. There has been **no
open-source, web-based takeoff canvas** — let alone one for flooring. OpenTakeoff
is that tool, given to the trade.

It started as the takeoff module of a private flooring estimating app and was
carved out, cleaned up, and released. The measuring engine is the real thing —
including **One-Click Area**, the flood-fill room tracer the $300/mo tools charge
for — not a demo.

## Quick start

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Drag **`demo/sample-plan.pdf`** onto the canvas. The scale auto-detects; pick a
condition, hit **One-Click Area**, and click inside a room. Open **Report** to see
the breakdown and export CSV/JSON.

Build a static site to host anywhere (GitHub Pages, Vercel, Netlify, S3):

```bash
npm run build      # -> web/dist/
```

## Features

- **Open anything** — drag in a plan **PDF**, an **image** (scan/screenshot), or a whole
  **`.zip` plan set** straight off a bid platform. Zips are unpacked and images wrapped to
  PDF *in your browser*; multi-page and multi-sheet (up to 4 side-by-side).
- **Scale** — auto-detects the drawn scale note off the sheet, or calibrate from a
  known dimension.
- **Measure** — Area, Rectangle, Linear, Surface-Area (walls), Count, and Deduct.
- **One-Click Area** — click inside a room; the linework bounds it, the polygon
  traces itself, vertices snap to true corners.
- **Conditions** — color + CAD hatch per finish (LVP, carpet, tile, …), a
  per-condition **waste %**, and an ×N multiplier for repeated units.
- **Report** — breakdown by finish with measured **and** waste-adjusted
  quantities; export to CSV / JSON; print.
- **Markups** — revision clouds, callouts, text notes.
- **Yours, locally** — everything persists in your browser (IndexedDB +
  localStorage). Nothing is uploaded.

## How your data is handled

The default build is **client-only**. Your PDFs and takeoffs never leave your
machine — there is no server in the loop. You can host the static build yourself
and it stays that way.

## The open flooring model

OpenTakeoff has an **opt-in** "Contribute to the open flooring model" button. The
idea: grow a shared, flooring-tuned dataset the whole trade benefits from.

- It sends **only the derived takeoff** — condition labels, shape types,
  quantities, and *normalized* room geometry.
- It **never** sends the PDF, file names, project/client names, your markups, or
  any absolute coordinates.
- It requires an explicit attestation that you have the right to share, and the
  code that builds the payload is right here in the open ([`web/src/lib/contribute.js`](web/src/lib/contribute.js)).

Contribution is off unless an endpoint is configured (`VITE_CONTRIBUTE_ENDPOINT`),
and you can self-host or disable it entirely.

## Optional AI sandbox

`server/` is an **optional** bring-your-own-model backend: a few takeoff-scoped AI
endpoints (suggest-scale, detect-rooms, classify-finish) you can wire a **local
model** (Ollama, a vision model, …) behind to experiment. It ships *empty of any
trained model* — the default adapter is a transparent heuristic. See
[`server/README.md`](server/README.md). You don't need it to use OpenTakeoff.

## Tech

React 18 + Vite, plain JSX for the canvas, **TypeScript** for the geometry libs,
[pdf.js](https://github.com/mozilla/pdf.js) for rendering, and raw HTML5 Canvas +
SVG for drawing — no paid dependencies. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## A note from the maker

I run estimating for a commercial flooring company. Every takeoff tool I've used costs
four figures a year and treats flooring as an afterthought — so I built the one I actually
wanted, and I'm giving it to the trade.

This is the real measuring engine, not a teaser. **One-Click Area** is the same flood-fill
room tracer the expensive tools gate behind a subscription. Open a plan, trace your rooms,
hand off a clean report — free, and nothing ever leaves your computer.

The one thing I'll ask: if it saves you time, consider turning on **"contribute to the open
flooring model."** It shares only the math — labels and quantities, never your plans — and
the goal is genuinely big: the first AI model tuned on real flooring takeoffs, owned by the
people who do the work instead of the software companies who sell to them. We build it
together, or nobody does.

— Michael · Summit Flooring Group

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm run typecheck && npm test &&
npm run build` before a PR, keep the geometry libs pure and tested, and never
commit real plans.

## License

[Apache License 2.0](LICENSE) — use it, fork it, ship it, sell on top of it. Given
to the flooring community. See [NOTICE](NOTICE) for attribution.
