"""WS auth + transcript-segment persistence tests.

The route auto-detects DB availability: when `app.state.db_session_factory`
is set, the WS requires a `Sec-WebSocket-Protocol: bearer.<jwt>` and
persists finals. These tests wire the lifespan-equivalent state up by
hand so we can drive the route under both regimes.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.websockets import WebSocketDisconnect

from meeting_intelligence.api.deps import get_auth_provider, get_session_factory
from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider, mint_dev_token
from meeting_intelligence.config import Settings
from meeting_intelligence.main import create_app


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture
def app_with_db(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
) -> FastAPI:
    app = create_app()
    app.dependency_overrides[get_session_factory] = lambda: db_session_factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    return app


@pytest.fixture
def client_with_db(
    app_with_db: FastAPI,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> Iterator[TestClient]:
    # The lifespan (entered by TestClient.__enter__) clobbers
    # app.state.db_session_factory back to None when DATABASE_URL is
    # unset. We re-attach the test factory AFTER the lifespan runs so
    # the WS route takes the auth-required branch.
    with TestClient(app_with_db) as c:
        app_with_db.state.db_session_factory = db_session_factory
        yield c


def _token(s: Settings, *, sub: str, email: str) -> str:
    return mint_dev_token(settings=s, workos_user_id=sub, email=email)


def _hello(session_id: str) -> dict:
    return {
        "type": "client_hello",
        "sessionId": session_id,
        "clientVersion": "0.0.0-test",
        "capabilities": {"audioFormat": "pcm16le-mono-16khz", "sendsBinaryAudio": False},
    }


# --- Auth-gated WS rejections ------------------------------------------------


def _expect_immediate_close(
    client: TestClient, path: str, *, subprotocols: list[str] | None = None
) -> None:
    """Connect and verify the server closes without a session_started.

    Starlette delivers a pre-accept `ws.close()` as an immediate
    `WebSocketDisconnect` raised by `websocket_connect()` itself, *or*
    by the first `receive_text()` if the close races the accept.
    Either is the rejection signal we want.
    """
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, subprotocols=subprotocols) as ws:
            ws.receive_text()


def test_ws_without_bearer_is_rejected(client_with_db: TestClient) -> None:
    _expect_immediate_close(client_with_db, "/transcript/ws/sess-no-auth")


def test_ws_with_bad_token_is_rejected(client_with_db: TestClient) -> None:
    _expect_immediate_close(
        client_with_db,
        "/transcript/ws/sess-bad-token",
        subprotocols=["bearer.this-is-not-a-jwt"],
    )


def test_ws_with_non_uuid_session_id_is_rejected(
    client_with_db: TestClient, dev_settings: Settings
) -> None:
    tok = _token(dev_settings, sub="user_ws_a", email="a@test.dev")
    _expect_immediate_close(
        client_with_db,
        "/transcript/ws/not-a-uuid",
        subprotocols=[f"bearer.{tok}"],
    )


def test_ws_with_unknown_meeting_id_is_rejected(
    client_with_db: TestClient, dev_settings: Settings
) -> None:
    tok = _token(dev_settings, sub="user_ws_b", email="b@test.dev")
    fake = "00000000-0000-0000-0000-000000000000"
    _expect_immediate_close(
        client_with_db,
        f"/transcript/ws/{fake}",
        subprotocols=[f"bearer.{tok}"],
    )


# --- Cross-user isolation: WS rejects a meeting that belongs to another user.


def test_ws_rejects_meeting_owned_by_another_user(
    client_with_db: TestClient, dev_settings: Settings
) -> None:
    tok_a = _token(dev_settings, sub="user_owner", email="owner@test.dev")
    tok_b = _token(dev_settings, sub="user_intruder", email="intruder@test.dev")

    created = client_with_db.post(
        "/meetings", json={"title": "A's"}, headers={"Authorization": f"Bearer {tok_a}"}
    ).json()

    _expect_immediate_close(
        client_with_db,
        f"/transcript/ws/{created['id']}",
        subprotocols=[f"bearer.{tok_b}"],
    )


# --- Happy path: persist finals + stamp meeting ------------------------------


def test_ws_persists_finals_and_stamps_meeting(
    client_with_db: TestClient,
    dev_settings: Settings,
) -> None:
    tok = _token(dev_settings, sub="user_persist", email="p@test.dev")
    created = client_with_db.post(
        "/meetings",
        json={"title": "live"},
        headers={"Authorization": f"Bearer {tok}"},
    ).json()
    meeting_id = UUID(created["id"])

    needles = ["one", "two", "three"]
    with client_with_db.websocket_connect(
        f"/transcript/ws/{meeting_id}",
        subprotocols=[f"bearer.{tok}"],
    ) as ws:
        ws.send_text(json.dumps(_hello(str(meeting_id))))
        first = json.loads(ws.receive_text())
        assert first["type"] == "session_started"

        for needle in needles:
            ws.send_text(
                json.dumps(
                    {
                        "type": "text_probe",
                        "sessionId": str(meeting_id),
                        "text": needle,
                    }
                )
            )

        # Wait for all three echoes (each text_probe emits one final).
        seen: set[str] = set()
        for _ in range(40):
            frame = json.loads(ws.receive_text())
            if (
                frame["type"] == "transcript_line"
                and frame["line"]["speakerId"] == "probe"
                and frame["line"]["isFinal"]
            ):
                seen.add(frame["line"]["text"])
                if seen.issuperset(needles):
                    break

        ws.send_text(json.dumps({"type": "client_bye", "sessionId": str(meeting_id)}))
        # Drain remaining frames until session_ended.
        for _ in range(40):
            frame = json.loads(ws.receive_text())
            if frame["type"] == "session_ended":
                break

    # Inspect persistence by re-issuing the GET endpoint as the same
    # user. Going through the route exercises the same RLS path the
    # rest of the suite does — no need for a separate async DB check.
    detail = client_with_db.get(
        f"/meetings/{meeting_id}", headers={"Authorization": f"Bearer {tok}"}
    ).json()

    seg_texts = {s["text"] for s in detail["segments"]}
    assert seg_texts >= set(needles), seg_texts
    assert all(s["isFinal"] for s in detail["segments"])

    assert detail["status"] == "completed"
    assert detail["endedAt"] is not None
    assert detail["durationSeconds"] is not None and detail["durationSeconds"] >= 0
    # speaker_count tracks distinct speaker ids; all probes use "probe".
    assert detail["speakerCount"] == 1
