#!/usr/bin/env python3
"""OpenTakeoff capture server — turn your own takeoffs into a training corpus.

**You do not need this to use OpenTakeoff.** The canvas runs entirely in your
browser and never uploads anything. This is the optional data layer: a single
stdlib-only Python file (no pip install) that receives the app's opt-in
Contribute payload and banks it as labeled training rows — on YOUR machine,
in a folder YOU choose. Point the app at it and every takeoff you decide to
capture becomes one more (geometry → label) pair in a corpus you own.

Wire-up (one line, in the browser console of any OpenTakeoff build):

    localStorage.opentakeoff_contribute_endpoint = "http://localhost:8787/contribute"

Then hit **Contribute** in the Report. Self-hosted builds can bake it in with
`VITE_CONTRIBUTE_ENDPOINT` instead. The payload is the same audited, derived-only
contribution the app builds for any endpoint — `opentakeoff.contribution.v2`
from current builds, `opentakeoff.contribution.v1` from older ones (both
accepted; anything else is rejected): condition labels, shape roles,
quantities, normalized (0..1) geometry, and per-shape provenance — never the
PDF, file names, project/client names, markups, absolute coordinates, or scale
values. Rows bank as `opentakeoff.capture.v2` either way; see
docs/CONTRIBUTION_SPEC.md for the normative wire and row contracts.

What lands on disk (all human-readable):

    corpus/
      takeoff_labels.jsonl   one row per labeled shape — the training set
      raw/<hash>.json        each contribution payload, verbatim (re-derive later)
      state.json             row fingerprints already banked (dedup)

Rows are hash-gated: re-contributing an unchanged takeoff appends nothing; a
retagged or redrawn shape re-captures. Set `--mirror` at a synced folder
(OneDrive/SharePoint/Dropbox/network share) and the label file is copied there
whole and atomically after every write — never live-appended, because append
churn inside a sync folder breeds conflict copies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 32 * 1024 * 1024  # a contribution is text; anything near this is not one
CAPTURE_SCHEMA = "opentakeoff.capture.v2"
# Wire schemas this server ingests: current and previous (N and N−1 — the
# versioning policy in docs/CONTRIBUTION_SPEC.md). Anything else 400s.
ACCEPTED = {"opentakeoff.contribution.v1", "opentakeoff.contribution.v2"}

# A synced share can wedge at the KERNEL level — a stalled sync client can leave
# open()/stat() on a placeholder file hanging indefinitely, which no try/except
# catches. So the mirror never runs on the request thread: it runs on an
# expendable daemon thread with a wall-clock cap, and the semaphore is the
# strand budget — once this many threads sit wedged, further mirror attempts
# skip outright (the corpus write itself already succeeded). A stranded thread
# frees its slot on its own if the share recovers.
_MIRROR_STRANDS = threading.Semaphore(3)


def _mirror_timeout() -> float:
    try:
        return float(os.environ.get("OPENTAKEOFF_MIRROR_TIMEOUT_S", "") or 15.0)
    except ValueError:
        return 15.0


# --- corpus ------------------------------------------------------------------

def _bbox(verts):
    if not verts:
        return [0.0, 0.0, 0.0, 0.0]
    xs = [p[0] for p in verts]
    ys = [p[1] for p in verts]
    return [min(xs), min(ys), max(xs), max(ys)]


def _fingerprint(row: dict) -> str:
    """Content hash of everything label-relevant — geometry, role, label,
    accepted quantities. Deliberately excludes ts/contributor, so the same
    takeoff contributed twice is one set of rows, not two."""
    key = (row.get("verts_norm"), row.get("measure_role"), row.get("finish_tag"),
           row.get("computed"), row.get("hatch"), row.get("waste_pct"),
           row.get("multiplier"), row.get("height_ft"))
    return hashlib.sha1(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()


def payload_rows(payload: dict) -> list[dict]:
    """Flatten one contribution into (geometry → label) rows, one per labeled
    shape. The condition IS the label: finish tag plus the hatch/waste/multiplier
    the estimator tuned. Shapes without a resolvable condition carry no label
    and are skipped.

    Version-aware over one code path: v2 shapes carry a whitelisted `origin`
    object (banked verbatim) plus `id`/`created_at`, and v2 payloads carry
    per-sheet `scale_source`; v1 shapes carry a flat `origin_method` string.
    `origin_method` derives from whichever is present — and defaults to
    "unknown" (NOT the old "human"): a shape that recorded nothing is a shape
    whose provenance we don't know, and pretending otherwise would poison any
    human-vs-machine split trained on the corpus. v2-only fields are simply
    omitted from rows a v1 payload produces."""
    conds = {c.get("finish"): c for c in (payload.get("conditions") or []) if c.get("finish")}
    scale_by_sheet = {sh.get("sheet"): sh.get("scale_source")
                      for sh in (payload.get("sheets") or []) if sh.get("sheet")}
    ts = datetime.now(timezone.utc).isoformat()
    rows = []
    for s in (payload.get("shapes") or []):
        cond = conds.get(s.get("finish"))
        if not cond:
            continue
        verts = s.get("verts_norm") or []
        row = {
            "ts": ts,
            "schema": CAPTURE_SCHEMA,
            "sheet": s.get("sheet"),
            "measure_role": s.get("role", "floor_area"),
            "verts_norm": verts,                 # WHERE — normalized polygon (scale-free)
            "bbox_norm": _bbox(verts),
            "finish_tag": s.get("finish"),       # WHAT — the condition is the label
            "hatch": cond.get("hatch", "solid"),
            "waste_pct": cond.get("waste_pct", 0),
            "multiplier": cond.get("multiplier", 1),
            "height_ft": s.get("height_ft"),
            "computed": s.get("computed") or {}, # the SF / LF / EA the estimator accepted
            "origin_method": (s.get("origin") or {}).get("method") or s.get("origin_method") or "unknown",
            "contributor": payload.get("contributor") or "",
        }
        extras = {                               # v2 signal — key-omitted when absent
            "shape_id": s.get("id"),             # opaque durable id — links re-contributions
            "created_at": s.get("created_at"),
            "origin": s.get("origin"),           # verbatim — the client already whitelists
            "scale_source": scale_by_sheet.get(s.get("sheet")),
            "generator_version": payload.get("generator_version"),
            "contribution_schema": payload.get("schema"),  # the wire schema this row came from
        }
        row.update({k: v for k, v in extras.items() if v is not None})
        rows.append(row)
    return rows


class Corpus:
    """The on-disk corpus. Append-only label file + verbatim payload archive +
    a fingerprint state so ingest is idempotent."""

    def __init__(self, root: str, mirror: str = ""):
        self.root = root
        self.mirror = mirror
        self.labels = os.path.join(root, "takeoff_labels.jsonl")
        self.state_path = os.path.join(root, "state.json")

    def _state(self) -> set:
        try:
            with open(self.state_path) as fh:
                return set(json.load(fh).get("seen", []))
        except (OSError, ValueError):
            return set()

    def _write_state(self, seen: set) -> None:
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"seen": sorted(seen)}, fh)
        os.replace(tmp, self.state_path)  # atomic, like every write here

    def ingest(self, payload: dict) -> tuple[int, int]:
        """Bank one contribution. Returns (rows appended, duplicates skipped)."""
        os.makedirs(os.path.join(self.root, "raw"), exist_ok=True)
        blob = json.dumps(payload, sort_keys=True)
        phash = hashlib.sha1(blob.encode()).hexdigest()[:12]
        raw = os.path.join(self.root, "raw", f"{phash}.json")
        if not os.path.exists(raw):
            tmp = raw + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(payload, fh, indent=1)
            os.replace(tmp, raw)
        seen = self._state()
        fresh, dup = [], 0
        for row in payload_rows(payload):
            fp = _fingerprint(row)
            if fp in seen:
                dup += 1
                continue
            seen.add(fp)
            row["contribution"] = phash
            fresh.append(row)
        if fresh:
            with open(self.labels, "a") as fh:
                for r in fresh:
                    fh.write(json.dumps(r) + "\n")
            self._write_state(seen)
            self._mirror()
        return len(fresh), dup

    def _mirror_now(self) -> None:
        try:
            os.makedirs(self.mirror, exist_ok=True)
            dst = os.path.join(self.mirror, "takeoff_labels.jsonl")
            tmp = dst + ".tmp"
            with open(self.labels, "rb") as fin, open(tmp, "wb") as fout:
                fout.write(fin.read())
            os.replace(tmp, dst)  # the sync client sees one consistent file
            meta = os.path.join(self.mirror, "corpus.json")
            mtmp = meta + ".tmp"
            with open(mtmp, "w") as fh:
                json.dump(self.summary(), fh)
            os.replace(mtmp, meta)
        except OSError as e:
            print(f"  mirror skipped: {e}", flush=True)

    def _mirror(self) -> None:
        """Whole-file atomic copy into the synced share — never live appends
        into a sync folder. Best-effort: the mirror must never fail a capture,
        nor stall it — a share that hangs at the kernel strands an expendable
        thread (capped at OPENTAKEOFF_MIRROR_TIMEOUT_S), never the request."""
        if not self.mirror:
            return
        if not _MIRROR_STRANDS.acquire(blocking=False):
            print("  mirror skipped: share unresponsive (strand budget exhausted)", flush=True)
            return

        def work():
            try:
                self._mirror_now()
            finally:
                _MIRROR_STRANDS.release()

        t = threading.Thread(target=work, daemon=True, name="capture-mirror")
        t.start()
        t.join(_mirror_timeout())
        if t.is_alive():
            print(f"  mirror abandoned: share unresponsive after {_mirror_timeout():.1f}s", flush=True)

    def summary(self) -> dict:
        rows = contributions = 0
        finishes: dict[str, int] = {}
        origin_methods: dict[str, int] = {}
        last_ts = None
        seen_contrib = set()
        try:
            with open(self.labels) as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    rows += 1
                    finishes[r.get("finish_tag", "?")] = finishes.get(r.get("finish_tag", "?"), 0) + 1
                    om = r.get("origin_method") or "unknown"
                    origin_methods[om] = origin_methods.get(om, 0) + 1
                    seen_contrib.add(r.get("contribution"))
                    last_ts = r.get("ts") or last_ts
        except OSError:
            pass
        contributions = len(seen_contrib - {None})
        return {"rows": rows, "contributions": contributions,
                "finishes": finishes, "origin_methods": origin_methods, "last_ts": last_ts}


# --- server ------------------------------------------------------------------

def make_handler(corpus: Corpus):
    class Handler(BaseHTTPRequestHandler):
        server_version = "opentakeoff-capture"

        def _respond(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _cors(self):
            # The canvas may be served from anywhere (localhost:5173, your own
            # host, the public demo) while this runs on localhost — so allow it,
            # including Chrome's private-network preflight.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path.rstrip("/") in ("", "/health"):
                self._respond(200, {"ok": True, **corpus.summary()})
            else:
                self._respond(404, {"ok": False, "error": "GET /health or POST /contribute"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > MAX_BODY:
                    return self._respond(413 if length > MAX_BODY else 400,
                                         {"ok": False, "error": "bad content length"})
                payload = json.loads(self.rfile.read(length))
                if payload.get("schema") not in ACCEPTED:
                    return self._respond(400, {"ok": False, "error": "unknown schema"})
            except (ValueError, OSError):
                return self._respond(400, {"ok": False, "error": "invalid JSON"})
            added, dup = corpus.ingest(payload)
            who = payload.get("contributor") or "anonymous"
            print(f"+{added} rows ({dup} already banked) from {who} → {corpus.labels}", flush=True)
            self._respond(200, {"ok": True, "rows_added": added, "duplicates": dup})

        def log_message(self, *args):  # one purposeful line per capture instead
            pass

    return Handler


def serve(corpus: Corpus, port: int):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(corpus))
    os.makedirs(corpus.root, exist_ok=True)
    print(f"OpenTakeoff capture server — corpus: {os.path.abspath(corpus.root)}"
          + (f", mirror: {os.path.abspath(corpus.mirror)}" if corpus.mirror else ""), flush=True)
    print(f"Point the app at it:  localStorage.opentakeoff_contribute_endpoint = "
          f"\"http://localhost:{httpd.server_address[1]}/contribute\"", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return httpd


# --- selftest ----------------------------------------------------------------

def selftest() -> int:
    """End-to-end over the wire: start the server on an ephemeral port, POST a
    v1 sample twice (second must dedup), retag a shape (must re-capture), check
    the mirror copy, reject an unknown schema, then POST a v2 sample carrying
    the manual / clean one-click / corrected one-click triad and assert the
    banked rows keep them distinguishable. Exits non-zero on any failure."""
    import shutil
    import tempfile
    import threading

    tmp = tempfile.mkdtemp(prefix="ot-capture-")
    corpus = Corpus(os.path.join(tmp, "corpus"), mirror=os.path.join(tmp, "share"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(corpus))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    sample = {
        "schema": "opentakeoff.contribution.v1", "generator": "opentakeoff",
        "sheet_count": 1, "contributor": "selftest",
        "conditions": [{"finish": "LVP-1", "hatch": "plank", "multiplier": 1, "waste_pct": 8},
                       {"finish": "CPT-1", "hatch": "speckle", "multiplier": 1, "waste_pct": 5}],
        "shapes": [
            {"role": "floor_area", "finish": "LVP-1", "sheet": "sheet_1",
             "verts_norm": [[.1, .1], [.4, .1], [.4, .3], [.1, .3]],
             "computed": {"sf": 154.6}, "origin_method": "oneclick"},
            {"role": "floor_area", "finish": "CPT-1", "sheet": "sheet_1",
             "verts_norm": [[.5, .5], [.8, .5], [.8, .9], [.5, .9]],
             "computed": {"sf": 402.0}, "origin_method": "human"},
        ],
        "totals": [],
    }

    def post(payload):
        req = urllib.request.Request(f"{base}/contribute", json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as res:
            return json.load(res)

    failures = []

    def check(name, got, want):
        ok = got == want
        print(f"  {'ok' if ok else 'FAIL'}  {name}: {got}" + ("" if ok else f" (wanted {want})"))
        if not ok:
            failures.append(name)

    check("first contribution rows", post(sample)["rows_added"], 2)
    check("re-contribution dedups", post(sample)["rows_added"], 0)
    retagged = json.loads(json.dumps(sample))
    retagged["shapes"][0]["finish"] = retagged["conditions"][0]["finish"] = "SDT-1"
    check("retagged shape re-captures", post(retagged)["rows_added"], 1)
    with urllib.request.urlopen(f"{base}/health") as res:
        health = json.load(res)
    check("health row count", health["rows"], 3)
    mirrored = os.path.join(corpus.mirror, "takeoff_labels.jsonl")
    with open(mirrored) as fh:
        check("mirror is a whole consistent copy", sum(1 for l in fh if l.strip()), 3)

    # unknown schemas still 400 — accepting v1 AND v2 is not accepting anything
    def post_status(payload):
        req = urllib.request.Request(f"{base}/contribute", json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status
        except urllib.error.HTTPError as e:
            return e.code

    check("unknown schema rejected", post_status({**sample, "schema": "opentakeoff.contribution.v99"}), 400)

    # contribution.v2 — the provenance triad: a hand-traced shape, a one-click
    # accepted verbatim, and a one-click the estimator corrected. The corpus
    # must keep all three distinguishable, or the "what did the machine get
    # right vs. what did a human fix" signal is lost at the door.
    proposed = [[.61, .60], [.79, .60], [.79, .83], [.60, .84]]
    v2 = {
        "schema": "opentakeoff.contribution.v2", "generator": "opentakeoff",
        "generator_version": "0.1.0", "contributor": "selftest-v2",
        "sheets": [{"sheet": "sheet_1", "scale_source": "detected"}],
        "conditions": [{"finish": "LVT-9", "hatch": "plank", "multiplier": 1, "waste_pct": 10}],
        "shapes": [
            {"role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
             "id": "0f7b8f9e-0000-4000-8000-000000000001", "created_at": "2026-07-18T12:00:00.000Z",
             "verts_norm": [[.05, .05], [.20, .05], [.20, .20], [.05, .20]],
             "computed": {"sf": 88.0}, "origin": {"method": "manual"}},
            {"role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
             "id": "0f7b8f9e-0000-4000-8000-000000000002", "created_at": "2026-07-18T12:01:00.000Z",
             "verts_norm": [[.30, .30], [.45, .30], [.45, .50], [.30, .50]],
             "computed": {"sf": 120.0},
             "origin": {"method": "one_click_v1", "seed_norm": [.37, .40], "reviewed": True}},
            {"role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
             "id": "0f7b8f9e-0000-4000-8000-000000000003", "created_at": "2026-07-18T12:02:00.000Z",
             "verts_norm": [[.60, .60], [.80, .60], [.80, .85], [.60, .85]],
             "computed": {"sf": 260.0},
             "origin": {"method": "one_click_v1", "seed_norm": [.70, .70], "reviewed": True,
                        "edited": True, "edits": {"vertex": 2, "move": 1},
                        "proposed_verts_norm": proposed}},
        ],
        "totals": [],
        "counters": {"shapes_deleted": {"one_click_v1": 1}},
    }
    check("v2 triad banks three rows", post(v2)["rows_added"], 3)
    check("v2 re-contribution dedups", post(v2)["rows_added"], 0)

    with open(corpus.labels) as fh:
        v2rows = [r for line in fh if line.strip()
                  for r in [json.loads(line)] if r.get("contributor") == "selftest-v2"]
    by_id = {r["shape_id"]: r for r in v2rows}
    manual = by_id["0f7b8f9e-0000-4000-8000-000000000001"]
    clean = by_id["0f7b8f9e-0000-4000-8000-000000000002"]
    fixed = by_id["0f7b8f9e-0000-4000-8000-000000000003"]
    check("v2 rows carry shape_id + created_at + scale_source",
          all(r.get("shape_id") and r.get("created_at") and r.get("scale_source") == "detected"
              for r in v2rows), True)
    check("v2 rows bank as capture.v2 tagged with their wire schema",
          all(r.get("schema") == CAPTURE_SCHEMA
              and r.get("contribution_schema") == "opentakeoff.contribution.v2"
              and r.get("generator_version") == "0.1.0" for r in v2rows), True)
    check("manual row: hand-traced, uncorrected",
          (manual["origin_method"], manual["origin"].get("edited")), ("manual", None))
    check("clean one-click row: machine trace accepted verbatim",
          (clean["origin_method"], clean["origin"].get("edited"),
           clean["origin"].get("proposed_verts_norm")), ("one_click_v1", None, None))
    check("corrected row: machine trace preserved, differs from final",
          (fixed["origin_method"], fixed["origin"]["edited"],
           fixed["origin"]["proposed_verts_norm"] != fixed["verts_norm"],
           fixed["origin"]["edits"]), ("one_click_v1", True, True, {"vertex": 2, "move": 1}))
    with urllib.request.urlopen(f"{base}/health") as res:
        health = json.load(res)
    check("summary counts origin methods",
          (health["origin_methods"].get("manual"), health["origin_methods"].get("one_click_v1")),
          (1, 2))

    # a wedged share (sync client stalled mid-syscall) may cost a contribution
    # at most the mirror timeout — the corpus row still banks, the POST returns
    import time
    gate = threading.Event()
    corpus._mirror_now = gate.wait  # stands in for a share that never answers
    os.environ["OPENTAKEOFF_MIRROR_TIMEOUT_S"] = "0.2"
    try:
        wedged = json.loads(json.dumps(sample))
        wedged["shapes"][1]["finish"] = wedged["conditions"][1]["finish"] = "VCT-1"
        t0 = time.monotonic()
        check("wedged share still banks the row", post(wedged)["rows_added"], 1)
        check("wedged share can't hang the POST", time.monotonic() - t0 < 5, True)
    finally:
        del os.environ["OPENTAKEOFF_MIRROR_TIMEOUT_S"]
        gate.set()  # unwedge; the stranded thread frees its strand slot

    httpd.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print("selftest:", "PASS" if not failures else f"FAIL ({', '.join(failures)})")
    return 1 if failures else 0


# --- cli ---------------------------------------------------------------------

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("command", choices=["serve", "summary", "selftest"], nargs="?", default="serve")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--corpus", default=os.environ.get("OPENTAKEOFF_CORPUS_DIR", "corpus"),
                   help="corpus folder (default ./corpus, or $OPENTAKEOFF_CORPUS_DIR)")
    p.add_argument("--mirror", default=os.environ.get("OPENTAKEOFF_MIRROR_DIR", ""),
                   help="optional synced share to atomically copy the label file into "
                        "(OneDrive / SharePoint / Dropbox / network share)")
    a = p.parse_args(argv)
    corpus = Corpus(a.corpus, a.mirror)
    if a.command == "selftest":
        return selftest()
    if a.command == "summary":
        print(json.dumps(corpus.summary(), indent=2))
        return 0
    serve(corpus, a.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
