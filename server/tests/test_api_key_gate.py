"""The X-API-Key gate on /ai/* — fail-closed in both directions.

Contract pinned here (see require_api_key in app.py):
- OT_SANDBOX_API_KEY unset ⇒ every /ai route is 401, with or without a header —
  an unconfigured sandbox is LOCKED, never open-because-unconfigured;
- key set ⇒ missing or wrong X-API-Key is 401, the exact key is 200 with the
  real adapter payload;
- /health stays open in both modes (liveness probe, no capability);
- the env var is read at call time, so setting it after import takes effect
  (rotation without a restart-order dance).
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import app  # noqa: E402

KEY = "test-sandbox-key"
HDR = {"X-API-Key": KEY}

AI_ROUTES = [
    ("/ai/suggest-scale", {"page_text": 'SCALE: 1/8" = 1\'-0"'}),
    ("/ai/detect-rooms", {"width": 100, "height": 100}),
    ("/ai/classify-finish", {"context": "LVT-1 luxury vinyl tile"}),
    ("/ai/parse-schedule", {"image_b64": "", "width": 0, "height": 0}),
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("OT_SANDBOX_API_KEY", raising=False)
    return TestClient(app)


@pytest.mark.parametrize("path,body", AI_ROUTES)
def test_unset_key_is_locked_with_and_without_header(client, path, body):
    assert client.post(path, json=body).status_code == 401
    # presenting a key against an unconfigured server must not fall through
    assert client.post(path, json=body, headers=HDR).status_code == 401


@pytest.mark.parametrize("path,body", AI_ROUTES)
def test_set_key_rejects_missing_and_wrong(client, monkeypatch, path, body):
    monkeypatch.setenv("OT_SANDBOX_API_KEY", KEY)
    assert client.post(path, json=body).status_code == 401
    assert client.post(path, json=body, headers={"X-API-Key": "nope"}).status_code == 401


def test_right_key_serves_real_payloads(client, monkeypatch):
    monkeypatch.setenv("OT_SANDBOX_API_KEY", KEY)
    r = client.post("/ai/suggest-scale", json=AI_ROUTES[0][1], headers=HDR)
    assert r.status_code == 200
    assert set(r.json()) == {"label", "confidence", "source"}
    r = client.post("/ai/parse-schedule", json=AI_ROUTES[3][1], headers=HDR)
    assert r.status_code == 200
    assert r.json()["rows"] == []


def test_health_is_open_in_both_modes(client, monkeypatch):
    assert client.get("/health").status_code == 200
    monkeypatch.setenv("OT_SANDBOX_API_KEY", KEY)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_env_is_read_at_call_time(client, monkeypatch):
    # locked before, serving after — same app object, no reimport
    path, body = AI_ROUTES[0]
    assert client.post(path, json=body, headers=HDR).status_code == 401
    monkeypatch.setenv("OT_SANDBOX_API_KEY", KEY)
    assert client.post(path, json=body, headers=HDR).status_code == 200
