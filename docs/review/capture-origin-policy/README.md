# Capture origin policy (#538)

Measured on 2026-10-18 with Python 3 and synthetic contributions in disposable
corpus folders. The reproduction script starts an actual HTTP listener and sends
requests carrying `Origin: https://example.com`; it does not simulate a browser's
own network-permission prompts.

| Measurement | Before (`0074c37`) | Expected after | Observed after |
|---|---:|---:|---:|
| Unapproved GET `/health` status | 200 | 403 | 403 |
| Unapproved OPTIONS `/contribute` status | 204 | 403 | 403 |
| Unapproved POST `/contribute` status | 200 | 403 | 403 |
| Corpus rows after unapproved POST | 1 | 0 | 0 |
| Unapproved CORS origin header | `*` | absent | absent |
| Unapproved private-network permission | `true` | absent | absent |

Reproduce from the repository root:

```bash
python3 docs/review/capture-origin-policy/reproduce.py --revision 0074c37
python3 docs/review/capture-origin-policy/reproduce.py
python3 -m unittest discover -s capture -p 'test_*.py' -v
python3 capture/capture_server.py selftest
```

All 9 origin regression tests pass. They cover 24 unapproved-origin requests,
allowed production/development origins, custom origins replacing defaults,
opaque and duplicate origins, native clients, cross-site requests without an
Origin, simple form content types, and endpoint restrictions. The existing
capture selftest passes, including deduplication, v1/v2 provenance and mirroring.

Repository validation on Node 24:

```bash
npm run check --prefix web
npm run check:tool-count --prefix mcp
npm run check:wiki --prefix mcp
npm run check --prefix protocol
node scripts/check-doc-links.mjs
```

Web: 3,453 tests passed, 4 skipped, zero failures; typecheck, lint, ORT check,
benchmark, build and distribution check passed. Protocol: 61 passed. Tool-count,
wiki and documentation-link checks passed. Build reports the existing large-chunk
warning; OCR models are not staged. No canvas code changed.

The policy protects browser-origin access, not access by another local program:
non-browser clients can supply their own headers. The server stays on loopback.
