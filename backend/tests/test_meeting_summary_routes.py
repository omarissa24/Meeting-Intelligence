"""POST /meetings/:id/summarise + GET /meetings/:id/export tests."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api import meetings as meetings_module
from meeting_intelligence.api.deps import get_auth_provider, get_session_factory
from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider, mint_dev_token
from meeting_intelligence.config import Settings
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.main import create_app


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture
def app(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
) -> FastAPI:
    app = create_app()
    app.dependency_overrides[get_session_factory] = lambda: db_session_factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    return app


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _stub_summarise_dispatch(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Intercept Celery dispatch so tests don't need a real broker.

    The summarise route imports `summarise_meeting` lazily inside the
    handler, so we patch the module-level reference. We also clear the
    in-memory rate-limit cache between tests so per-meeting tests can
    fire fresh requests without throttling each other.
    """
    captured: list[dict[str, str]] = []

    class _StubAsyncResult:
        id = "stub-task-id"

    def _delay(**kwargs: str) -> _StubAsyncResult:
        captured.append(kwargs)
        return _StubAsyncResult()

    from meeting_intelligence.worker.tasks import summarise as summarise_module

    monkeypatch.setattr(
        summarise_module.summarise_meeting, "delay", _delay
    )
    meetings_module._summarise_last_call.clear()
    return captured


def _bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


def _create_meeting(
    client: TestClient, dev_settings: Settings, *, sub: str, email: str
) -> tuple[str, UUID]:
    auth = _bearer(dev_settings, email=email, sub=sub)
    r = client.post("/meetings", json={"title": "M"}, headers={"Authorization": auth})
    assert r.status_code == 201, r.text
    return auth, UUID(r.json()["id"])


def _resolve_owner(
    factory: async_sessionmaker[AsyncSession], sub: str
) -> UUID:
    async def _do() -> UUID:
        async with factory() as s:
            row = (
                await s.execute(
                    text("SELECT * FROM auth.lookup_user_by_workos_id(:wid)"),
                    {"wid": sub},
                )
            ).first()
            assert row is not None
            return UUID(str(row.id))

    return asyncio.run(_do())


def _seed_completed_summary(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    *,
    decisions: list[str] | None = None,
    items: list[tuple[str, str | None, str | None]] | None = None,
    topics_json: str | None = None,
    summary_text: str = "Standup ran short.",
) -> None:
    """Seed a completed summary + optional action_items for export tests."""
    import json

    decisions_json = json.dumps(decisions or ["Approve plan."])
    if topics_json is None:
        topics_json = (
            '[{"name": "Topic A", "duration_seconds": 600},'
            ' {"name": "Topic B", "duration_seconds": 90}]'
        )

    async def _do() -> None:
        async with factory() as s:
            await set_request_user(s, user_id)
            await s.execute(
                text(
                    """
                    INSERT INTO meeting_summaries
                      (meeting_id, user_id, status, summary, decisions, topics,
                       confidence_low, model_version, generated_at)
                    VALUES
                      (:m, :u, 'completed', :sum,
                       CAST(:decs AS jsonb), CAST(:tops AS jsonb),
                       false, 'test-model', now())
                    """
                ),
                {
                    "m": str(meeting_id),
                    "u": str(user_id),
                    "sum": summary_text,
                    "decs": decisions_json,
                    "tops": topics_json,
                },
            )
            for idx, (desc, owner, deadline) in enumerate(items or []):
                await s.execute(
                    text(
                        """
                        INSERT INTO action_items
                          (meeting_id, user_id, description, owner, deadline, order_index)
                        VALUES (:m, :u, :d, :o, :dl, :idx)
                        """
                    ),
                    {
                        "m": str(meeting_id),
                        "u": str(user_id),
                        "d": desc,
                        "o": owner,
                        "dl": deadline,
                        "idx": idx,
                    },
                )
            await s.commit()

    asyncio.run(_do())


# -----------------------------------------------------------------------------
# POST /meetings/:id/summarise
# -----------------------------------------------------------------------------


def test_post_summarise_returns_processing_and_dispatches(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
    _stub_summarise_dispatch: list[dict[str, str]],
) -> None:
    auth, meeting_id = _create_meeting(
        client, dev_settings, sub="user_summ_a", email="summ_a@test.dev"
    )

    r = client.post(
        f"/meetings/{meeting_id}/summarise",
        headers={"Authorization": auth},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["summaryStatus"] == "processing"
    assert body["summary"]["status"] == "processing"

    assert len(_stub_summarise_dispatch) == 1
    assert _stub_summarise_dispatch[0]["meeting_id"] == str(meeting_id)
    assert _stub_summarise_dispatch[0]["user_id"]


def test_post_summarise_rate_limited(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    auth, meeting_id = _create_meeting(
        client, dev_settings, sub="user_summ_b", email="summ_b@test.dev"
    )

    r1 = client.post(f"/meetings/{meeting_id}/summarise", headers={"Authorization": auth})
    assert r1.status_code == 202
    r2 = client.post(f"/meetings/{meeting_id}/summarise", headers={"Authorization": auth})
    assert r2.status_code == 429


def test_post_summarise_404_for_unknown_meeting(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    auth = _bearer(dev_settings, email="x@test.dev", sub="user_summ_c")
    from uuid import uuid4
    r = client.post(
        f"/meetings/{uuid4()}/summarise",
        headers={"Authorization": auth},
    )
    assert r.status_code == 404


def test_post_summarise_requires_auth(client: TestClient) -> None:
    from uuid import uuid4
    r = client.post(f"/meetings/{uuid4()}/summarise")
    assert r.status_code == 401


# -----------------------------------------------------------------------------
# GET /meetings/:id/export
# -----------------------------------------------------------------------------


def test_export_renders_full_text_layout(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, meeting_id = _create_meeting(
        client, dev_settings, sub="user_exp_a", email="exp_a@test.dev"
    )
    user_id = _resolve_owner(db_session_factory, "user_exp_a")
    _seed_completed_summary(
        db_session_factory,
        user_id,
        meeting_id,
        decisions=["Decision one.", "Decision two."],
        items=[
            ("Send memo", "Omar", "2026-06-15"),
            ("Schedule", None, None),
        ],
    )

    r = client.get(
        f"/meetings/{meeting_id}/export", headers={"Authorization": auth}
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    body = r.text

    assert "SUMMARY" in body
    assert "Standup ran short." in body
    assert "DECISIONS" in body
    assert "- Decision one." in body
    assert "- Decision two." in body
    assert "ACTION ITEMS" in body
    assert "[ ] Send memo - Omar - 2026-06-15" in body
    assert "[ ] Schedule - Unassigned - No deadline" in body
    assert "TOPICS" in body
    assert "- Topic A (10m 00s)" in body
    assert "- Topic B (1m 30s)" in body


def test_export_says_no_decisions_when_empty(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, meeting_id = _create_meeting(
        client, dev_settings, sub="user_exp_b", email="exp_b@test.dev"
    )
    user_id = _resolve_owner(db_session_factory, "user_exp_b")
    _seed_completed_summary(
        db_session_factory,
        user_id,
        meeting_id,
        decisions=[],
        items=[],
    )

    r = client.get(
        f"/meetings/{meeting_id}/export", headers={"Authorization": auth}
    )
    assert r.status_code == 200
    body = r.text
    assert "No decisions recorded." in body
    assert "No action items recorded." in body


def test_export_404_when_no_summary(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    auth, meeting_id = _create_meeting(
        client, dev_settings, sub="user_exp_c", email="exp_c@test.dev"
    )
    r = client.get(
        f"/meetings/{meeting_id}/export", headers={"Authorization": auth}
    )
    assert r.status_code == 404


def test_export_requires_auth(client: TestClient) -> None:
    from uuid import uuid4
    r = client.get(f"/meetings/{uuid4()}/export")
    assert r.status_code == 401
