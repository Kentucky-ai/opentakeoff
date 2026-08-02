"""OpenTakeoff AI sandbox — an OPTIONAL, bring-your-own-model backend.

This server is not required to use OpenTakeoff. The takeoff canvas runs entirely
in the browser. What this adds is a *socket*: a small set of takeoff-scoped AI
endpoints you can wire your own local model behind (Ollama, a local vision model,
whatever) to experiment — auto-suggest a scale, detect rooms, classify a finish.

It ships EMPTY of any trained model: the default adapter is a transparent
heuristic so every endpoint works out of the box and shows you the contract.
Swap in your own by setting OPENTAKEOFF_ADAPTER to an import path that resolves
to a `TakeoffAI` implementation (see adapters/base.py and adapters/heuristic.py).

It deliberately does NOT include any estimate, pricing, risk, or scope engine —
this is just the takeoff canvas's optional AI playground.

The AI endpoints are LOCKED until you set an API key — pick any secret you like:

Run:  OT_SANDBOX_API_KEY=<any-secret> uvicorn app:app --reload --port 8000

Callers must send the same value in an `X-API-Key` header. With the env var
unset, /ai/* answers 401 — never "open because unconfigured": a server this
socket may one day front (your GPU box, your API budget) should refuse
strangers even when someone forgets to configure it, or exposes a dev
instance beyond localhost. /health stays open as a liveness probe.
"""
from __future__ import annotations

import importlib
import os
import secrets

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator, model_validator

from adapters.base import TakeoffAI
from adapters.heuristic import HeuristicAdapter

app = FastAPI(title="OpenTakeoff AI sandbox", version="0.1.0")

# Wide-open CORS — fine because every /ai route also demands the API key; a
# browser page can only call this with a key its user configured.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Gate every /ai route on `X-API-Key` matching OT_SANDBOX_API_KEY.

    The env var is read at CALL time (not import) so it's rotatable and
    testable, and the compare is constant-time. Fail-closed in both
    directions: no key configured ⇒ 401 regardless of what's presented
    (never open-because-unconfigured); key configured ⇒ anything but an
    exact match is 401. The secret rides a header, never a URL path or
    query string, so it stays out of access logs and proxy caches.
    """
    expected = os.environ.get("OT_SANDBOX_API_KEY", "").strip()
    if not expected:
        raise HTTPException(
            status_code=401,
            detail="sandbox locked: start the server with OT_SANDBOX_API_KEY set, "
            "then send that value in the X-API-Key header",
        )
    if not (x_api_key and secrets.compare_digest(x_api_key, expected)):
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


ai = APIRouter(prefix="/ai", dependencies=[Depends(require_api_key)])


def _load_adapter() -> TakeoffAI:
    """Resolve OPENTAKEOFF_ADAPTER ("package.module:Factory") or fall back to the
    built-in heuristic. The factory may be a class or a zero-arg callable."""
    spec = os.environ.get("OPENTAKEOFF_ADAPTER", "").strip()
    if not spec:
        return HeuristicAdapter()
    mod_name, _, attr = spec.partition(":")
    mod = importlib.import_module(mod_name)
    factory = getattr(mod, attr or "Adapter")
    return factory()


adapter: TakeoffAI = _load_adapter()


# ── request/response models ──────────────────────────────────────────────────
class SuggestScaleIn(BaseModel):
    page_text: str = ""


class SuggestScaleOut(BaseModel):
    label: str | None = None
    confidence: float = 0.0
    source: str = "none"


class DetectRoomsIn(BaseModel):
    width: int
    height: int
    # optional flat boundary segments [x1,y1,x2,y2,...] in image px, if the
    # caller already extracted vector linework client-side
    segments: list[float] = []


class Room(BaseModel):
    verts: list[list[float]]
    area_px: float = 0.0


class DetectRoomsOut(BaseModel):
    rooms: list[Room] = []
    note: str = ""


class ClassifyFinishIn(BaseModel):
    context: str = ""


class ClassifyFinishOut(BaseModel):
    finish: str | None = None
    confidence: float = 0.0


class ParseScheduleIn(BaseModel):
    # base64-encoded PNG crop of the marqueed schedule region (no "data:" prefix),
    # plus its pixel dims — what the client sends for a SCANNED sheet with no text
    # layer to read.
    image_b64: str = ""
    width: int = 0
    height: int = 0


# The finish categories the client understands, and which ones the approval
# dialog pre-checks. Mirrors web/src/lib/scheduleParse.ts (ceilings/millwork are
# parsed but start UNCHECKED so the estimator drops them for free).
_CATEGORIES = {"floor", "base", "wall", "transition", "ceiling", "other"}
_SUGGESTED_DEFAULT = {
    "floor": True, "base": True, "wall": True,
    "transition": True, "ceiling": False, "other": False,
}


class ScheduleRow(BaseModel):
    """One parsed schedule row — the SAME shape as the client's ScheduleRow
    (web/src/lib/scheduleParse.ts), so an adapter's output feeds the one approval
    dialog. Off-contract values are coerced (unknown category → "other",
    missing `suggested` → the category default) so a rough model output still
    lands cleanly."""
    finish_tag: str = ""
    section: str = ""
    category: str = "other"
    description: str = ""
    manufacturer: str = ""
    style: str = ""
    spec_color: str = ""
    size: str = ""
    suggested: bool | None = None

    @field_validator("category")
    @classmethod
    def _known_category(cls, v: str) -> str:
        v = (v or "").strip().lower()
        return v if v in _CATEGORIES else "other"

    @model_validator(mode="after")
    def _default_suggested(self) -> "ScheduleRow":
        if self.suggested is None:
            self.suggested = _SUGGESTED_DEFAULT[self.category]
        return self


class ParseScheduleOut(BaseModel):
    rows: list[ScheduleRow] = []
    note: str = ""


# ── routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {"ok": True, "adapter": adapter.name}


@ai.post("/suggest-scale", response_model=SuggestScaleOut)
def suggest_scale(body: SuggestScaleIn) -> SuggestScaleOut:
    return SuggestScaleOut(**adapter.suggest_scale(body.page_text))


@ai.post("/detect-rooms", response_model=DetectRoomsOut)
def detect_rooms(body: DetectRoomsIn) -> DetectRoomsOut:
    out = adapter.detect_rooms(body.width, body.height, body.segments)
    return DetectRoomsOut(**out)


@ai.post("/classify-finish", response_model=ClassifyFinishOut)
def classify_finish(body: ClassifyFinishIn) -> ClassifyFinishOut:
    return ClassifyFinishOut(**adapter.classify_finish(body.context))


@ai.post("/parse-schedule", response_model=ParseScheduleOut)
def parse_schedule(body: ParseScheduleIn) -> ParseScheduleOut:
    out = adapter.parse_schedule(body.image_b64, body.width, body.height)
    # Validate/coerce each row through ScheduleRow and drop untagged ones (a row
    # with no finish_tag can't become a condition). The default heuristic returns
    # no rows — this path is plumbing-complete but needs a real OCR/VLM adapter.
    rows = [ScheduleRow(**r) for r in out.get("rows", []) if isinstance(r, dict)]
    rows = [r for r in rows if r.finish_tag.strip()]
    return ParseScheduleOut(rows=rows, note=out.get("note", ""))


app.include_router(ai)
