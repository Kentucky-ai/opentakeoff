# The capture layer (optional)

**You do not need this to use OpenTakeoff.** The canvas runs entirely in your
browser and uploads nothing. This folder is for when you want more than a
takeoff out of a takeoff: **your own training data.**

Every takeoff you finish is a set of expert decisions — *this* region, *this*
finish, *this* waste %, *these* quantities. Done once, that's a bid. Banked
every time, it's a labeled dataset nobody else has: your regions, your
conditions, your judgment, on your plans. That's exactly the raw material for
training a takeoff model on **your** trade and **your** market — and today it
evaporates when the bid goes out. The capture layer is how you keep it.

## What it is

One stdlib-only Python file — no pip install, ~500 lines, audit it in a
sitting. It listens on localhost for the app's opt-in **Contribute** payload
and banks each labeled shape as one training row:

```
corpus/
  takeoff_labels.jsonl   one row per labeled shape — (geometry → label) pairs
  raw/<hash>.json        every contribution verbatim, so you can re-derive later
  state.json             fingerprints already banked (ingest is idempotent)
```

A row is the WHERE, the WHAT, and the HOW: normalized polygon + bbox, sheet,
measure role, then the label — finish tag, hatch, waste %, multiplier, height —
the quantities you accepted, and the shape's provenance. Current builds send
`opentakeoff.contribution.v2`, and those rows carry the full origin record:
hand-traced (`manual`) vs. machine-proposed (`one_click_v1`), whether a human
corrected it, and — for corrected shapes — the machine's original trace
(`proposed_verts_norm`) alongside the final geometry, so what the machine got
right and what an expert had to fix stay distinguishable. Rows also carry the
shape's durable id, `created_at`, and the sheet's `scale_source` (provenance
only — never a scale value). Older v1 payloads still ingest; their rows just
lack the v2 columns, and a shape that recorded no provenance banks as
`origin_method: "unknown"` — not `"human"`, because absence of evidence isn't
a hand trace. Re-contributing an unchanged takeoff appends nothing; retag or
redraw a shape and it re-captures. Rows are hash-gated by content, so the
corpus only ever grows by real signal. The full row format and field tables
live in [`docs/CONTRIBUTION_SPEC.md`](../docs/CONTRIBUTION_SPEC.md).

What it receives is the same audited, derived-only payload the app builds for
any Contribute endpoint (`web/src/lib/contribute.js`): **never** the PDF, file
names, project or client names, markups, absolute coordinates, or scale
values.

## Run it

```bash
python3 capture/capture_server.py            # serves on http://localhost:8787
```

Point any OpenTakeoff build at it — one line in the browser console:

```js
localStorage.opentakeoff_contribute_endpoint = "http://localhost:8787/contribute"
```

That's it. Finish a takeoff, open **Report → Contribute**, and watch the rows
land. Self-hosting for a whole team? Bake the endpoint into the build with
`VITE_CONTRIBUTE_ENDPOINT` and put the server somewhere everyone can reach.

```bash
python3 capture/capture_server.py summary    # corpus counts by finish
python3 capture/capture_server.py selftest   # end-to-end check, no setup needed
```

## Feed a shared drive

The trick that makes this a *company* asset instead of a laptop file: mirror
the corpus into a synced folder — OneDrive, SharePoint, Dropbox, a network
share — and it rides your existing sync into company storage, backed up and
ready to train on.

```bash
python3 capture/capture_server.py --mirror "/path/to/OneDrive/Estimating/Takeoff-Corpus"
```

The mirror is a **whole-file atomic copy** after each capture, never a live
append into the sync folder — append churn inside a syncing directory is how
you end up with `takeoff_labels (conflicted copy).jsonl`. The primary corpus
stays local; the share always sees one consistent file plus a `corpus.json`
with the current counts.

The mirror also can't take the server down with it. A stalled sync client can
leave a filesystem syscall in the share hanging **at the kernel** — no
exception raised, no return — so every mirror copy runs on an expendable
thread with a wall-clock cap (`OPENTAKEOFF_MIRROR_TIMEOUT_S`, default 15s)
behind a 3-slot strand budget: a wedged share strands at most three threads,
then further mirror attempts skip with a log line until it recovers. Your
corpus row has already banked locally by then, and the `/contribute` response
is never held hostage. One macOS gotcha worth knowing: if the capture server
runs as a background service (launchd, not a terminal), the OS may silently
park its first access to a cloud-synced folder waiting on a privacy-consent
prompt that never renders — grant the Python binary Full Disk Access, or just
run the server from a terminal.

## Where this design comes from

This is the open edition of the capture layer inside
[Spline](https://spline.quisutdeus.io), the commercial Division-9 estimating
system OpenTakeoff was carved from. Spline's version goes much deeper —
capture is *ambient*, riding autosave and commit with no Contribute click:
provisional rows bank while you draw, certified rows land on commit with the
exploded supporting-materials assembly, deletions leave records, edits carry a
decision trail, and each job's corpus files itself into that GC's project
folder on the company share. Same schema philosophy, same mirror discipline —
this file gives you the data-ownership half, on the honest terms of a
client-only app: you choose what to capture, and it goes only where you point
it.

## Train on it

`takeoff_labels.jsonl` is deliberately model-agnostic — newline-delimited
JSON, normalized geometry, string labels. Fine-tune a small local model to
propose conditions for traced regions, cluster your finishes by geometry,
benchmark One-Click against your human traces, or just keep it until the
tooling catches up to your dataset. It's your data; the point is that now it
exists.
