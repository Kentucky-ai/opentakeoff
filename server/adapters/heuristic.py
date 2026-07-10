"""The default adapter — a transparent heuristic, NO machine learning.

Its job is to make the endpoints work out of the box and to document the
contract, not to be smart. `suggest_scale` does a simple regex over the page
text; `classify_finish` does keyword matching; `detect_rooms` and `parse_schedule`
return nothing and tell you where to plug in a real (vision/OCR) model. Replace
this with your own adapter to bring intelligence to the socket.
"""
from __future__ import annotations

import re

# common drawn-scale notations, longest/most-specific first
_SCALE_PATTERNS = [
    (r'\b1/16"\s*=\s*1\'', '1/16" = 1\'-0"'),
    (r'\b3/32"\s*=\s*1\'', '3/32" = 1\'-0"'),
    (r'\b1/8"\s*=\s*1\'', '1/8" = 1\'-0"'),
    (r'\b3/16"\s*=\s*1\'', '3/16" = 1\'-0"'),
    (r'\b1/4"\s*=\s*1\'', '1/4" = 1\'-0"'),
    (r'\b3/8"\s*=\s*1\'', '3/8" = 1\'-0"'),
    (r'\b1/2"\s*=\s*1\'', '1/2" = 1\'-0"'),
    (r'\b3/4"\s*=\s*1\'', '3/4" = 1\'-0"'),
    (r'\b1"\s*=\s*10\'', '1" = 10\''),
    (r'\b1"\s*=\s*20\'', '1" = 20\''),
    (r'\b1"\s*=\s*30\'', '1" = 30\''),
    (r'\b1"\s*=\s*40\'', '1" = 40\''),
    (r'\b1"\s*=\s*50\'', '1" = 50\''),
    (r'\b1"\s*=\s*60\'', '1" = 60\''),
]

_FINISH_KEYWORDS = [
    (("carpet", "broadloom", "cpt"), "CPT-1"),
    (("lvp", "lvt", "luxury vinyl", "plank"), "LVP-1"),
    (("tile", "ceramic", "porcelain"), "TILE-1"),
    (("vinyl", "sheet vinyl", "vct"), "VIN-1"),
    (("base", "cove base", "wall base"), "BASE-1"),
]


class HeuristicAdapter:
    name = "heuristic (no model)"

    def suggest_scale(self, page_text: str) -> dict:
        text = re.sub(r"\s+", " ", (page_text or "")).replace("”", '"').replace("’", "'")
        for pat, label in _SCALE_PATTERNS:
            if re.search(pat, text, re.IGNORECASE):
                return {"label": label, "confidence": 0.5, "source": "regex"}
        return {"label": None, "confidence": 0.0, "source": "none"}

    def detect_rooms(self, width: int, height: int, segments: list[float]) -> dict:
        # No model here on purpose. The client already has a strong geometric
        # One-Click room tracer; this endpoint is where you'd plug a vision model
        # to PROPOSE rooms across a whole sheet at once.
        return {
            "rooms": [],
            "note": "No model loaded. Set OPENTAKEOFF_ADAPTER to your own adapter "
                    "(e.g. an Ollama / local vision model) to populate rooms.",
        }

    def classify_finish(self, context: str) -> dict:
        ctx = (context or "").lower()
        for keywords, tag in _FINISH_KEYWORDS:
            if any(k in ctx for k in keywords):
                return {"finish": tag, "confidence": 0.4}
        return {"finish": None, "confidence": 0.0}

    def parse_schedule(self, image_b64: str, width: int, height: int) -> dict:
        # No model here on purpose. Reading a schedule off a SCANNED sheet needs
        # OCR or a vision-language model — that's exactly what you'd plug in via
        # OPENTAKEOFF_ADAPTER. Ship empty so the client's scan path is wired end
        # to end and degrades gracefully (the dialog just says "nothing found")
        # until a real model returns rows. A real adapter would decode image_b64
        # (a PNG crop, `width`×`height`), run OCR/VLM, and return ScheduleRow-
        # shaped dicts — see the response contract in adapters/base.py.
        return {
            "rows": [],
            "note": "No model loaded. Set OPENTAKEOFF_ADAPTER to your own adapter "
                    "(e.g. an OCR / local vision model) to read scanned schedules.",
        }
