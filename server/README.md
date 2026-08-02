# OpenTakeoff AI sandbox (optional)

**You do not need this to use OpenTakeoff.** The takeoff canvas runs entirely in
your browser. This is an *optional* backend that adds a **bring-your-own-model
socket** — a few takeoff-scoped AI endpoints you can wire a local model behind
to experiment and build.

This sandbox is the **server-side adapter socket**: the place to plug your own
local *vision model* under the canvas's suggestion endpoints. If you want an
**AI agent to drive the takeoff itself** — open plans, set scales, click rooms,
export quantities — that's the MCP server, [`mcp/`](../mcp/README.md), not this.

It ships **empty of any trained model**. The default adapter is a transparent
heuristic so the endpoints work immediately and show you the contract. There is
**no estimate, pricing, risk, or scope engine here** — just the canvas's AI
playground.

## Run it

```bash
cd server
pip install -r requirements.txt
OT_SANDBOX_API_KEY=<any-secret> uvicorn app:app --reload --port 8000
# or: docker build -t opentakeoff-ai . && docker run -p 8000:8000 -e OT_SANDBOX_API_KEY=<any-secret> opentakeoff-ai
```

Then `GET http://localhost:8000/health` → `{"ok": true, "adapter": "heuristic (no model)"}`.

In dev, the web app proxies `/ai/*` to `localhost:8000` (see `web/vite.config.js`),
so browser calls to `/ai/suggest-scale` reach this server. Export the same
`OT_SANDBOX_API_KEY` in the shell that runs `npm run dev` and the proxy attaches
the header for you.

## The lock

The `/ai/*` endpoints require an `X-API-Key` header matching the server's
`OT_SANDBOX_API_KEY` — any secret you choose. **With the env var unset the
endpoints answer 401**: an unconfigured sandbox is locked, never open by
accident, so a dev instance that ends up reachable beyond localhost (a tunnel,
a `--host 0.0.0.0`) exposes nothing. `/health` stays open as a liveness probe.

```bash
curl -s -X POST localhost:8000/ai/classify-finish \
  -H "Content-Type: application/json" -H "X-API-Key: <your-secret>" \
  -d '{"context": "LVT-1 luxury vinyl tile"}'
```

## Endpoints

| Endpoint | In | Out |
|---|---|---|
| `POST /ai/suggest-scale` | `{ page_text }` | `{ label, confidence, source }` |
| `POST /ai/detect-rooms` | `{ width, height, segments? }` | `{ rooms: [{verts, area_px}], note }` |
| `POST /ai/classify-finish` | `{ context }` | `{ finish, confidence }` |

## Bring your own model

Implement the three methods in [`adapters/base.py`](adapters/base.py) and point
`OPENTAKEOFF_ADAPTER` at your class:

```bash
export OPENTAKEOFF_ADAPTER="my_adapters.ollama:OllamaAdapter"
uvicorn app:app --port 8000
```

A minimal Ollama-backed finish classifier:

```python
# my_adapters/ollama.py
import json, urllib.request

class OllamaAdapter:
    name = "ollama"

    def _ask(self, prompt: str) -> str:
        req = urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=json.dumps({"model": "llama3.2", "prompt": prompt, "stream": False}).encode(),
            headers={"Content-Type": "application/json"},
        )
        return json.loads(urllib.request.urlopen(req).read())["response"]

    def suggest_scale(self, page_text):     # fall back to the heuristic / your own logic
        return {"label": None, "confidence": 0.0, "source": "ollama"}

    def detect_rooms(self, width, height, segments):
        return {"rooms": [], "note": "wire a vision model here"}

    def classify_finish(self, context):
        tag = self._ask(f"Reply with ONE flooring tag (LVP-1/CPT-1/TILE-1/VIN-1/BASE-1) for: {context}").strip()
        return {"finish": tag or None, "confidence": 0.5}
```

That's the whole idea: the canvas and the socket are open; the *intelligence* is
yours to plug in.
