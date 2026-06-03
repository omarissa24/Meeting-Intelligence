"""Phase-3 action-item PATCH route + summary surfaces in /meetings/:id.

Wired the same way as test_meetings_routes.py: dev settings + dev JWT,
TestClient against a real ephemeral Postgres. Helpers seed
meeting_summaries + action_items directly via the session factory so
the route under test only has to read.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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


def _bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


def _seed_summary_with_items(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    *,
    items: list[tuple[str, str | None]],
) -> list[UUID]:
    """Insert a completed summary + a few action_items.

    Returns the inserted item IDs in order so tests can PATCH them.
    Each tuple is `(description, owner_or_None)`.
    """

    async def _do() -> list[UUID]:
        ids: list[UUID] = []
        async with factory() as s:
            await set_request_user(s, user_id)
            await s.execute(
                text(
                    "INSERT INTO meeting_summaries "
                    "(meeting_id, user_id, status, summary, decisions, topics, "
                    " confidence_low, model_version, generated_at) "
                    "VALUES (:m, :u, 'completed', :sum, "
                    " '[\"Approve plan.\"]'::jsonb, "
                    " '[{\"name\": \"Topic A\", \"duration_seconds\": 600}]'::jsonb, "
                    " false, 'test-model', now())"
                ),
                {"m": str(meeting_id), "u": str(user_id), "sum": "All good."},
            )
            for idx, (desc, owner) in enumerate(items):
                item_id = uuid4()
                ids.append(item_id)
                await s.execute(
                    text(
                        "INSERT INTO action_items "
                        "(id, meeting_id, user_id, description, owner, order_index) "
                        "VALUES (:id, :m, :u, :desc, :own, :idx)"
                    ),
                    {
                        "id": str(item_id),
                        "m": str(meeting_id),
                        "u": str(user_id),
                        "desc": desc,
                        "own": owner,
                        "idx": idx,
                    },
                )
            await s.commit()
        return ids

    return asyncio.run(_do())


def _create_meeting(
    client: TestClient, dev_settings: Settings, *, sub: str, email: str
) -> tuple[str, dict[str, Any]]:
    """Create a meeting via the API and return (auth_header, body)."""
    auth = _bearer(dev_settings, email=email, sub=sub)
    r = client.post(
        "/meetings",
        json={"title": "M"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 201, r.text
    return auth, r.json()


# -------------------------------------------------------------------------
# GET /meetings/:id surfaces summary + action items
# -------------------------------------------------------------------------


def test_get_meeting_includes_summary_and_action_items(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_aiitems_a", email="ai_a@test.dev"
    )
    meeting_id = UUID(created["id"])

    # Look up the user's row id by walking back from the meeting's
    # owner. Both the summary insert and the action_items insert need
    # the user_id so RLS WITH CHECK accepts them.
    async def _resolve_owner() -> UUID:
        async with db_session_factory() as s:
            # Use the same SECURITY DEFINER helper the auth path uses.
            row = (
                await s.execute(
                    text(
                        "SELECT * FROM auth.lookup_user_by_workos_id("
                        ":wid)"
                    ),
                    {"wid": "user_aiitems_a"},
                )
            ).first()
            assert row is not None, "user row should be provisioned"
            return UUID(str(row.id))

    user_id = asyncio.run(_resolve_owner())

    items = _seed_summary_with_items(
        db_session_factory,
        user_id,
        meeting_id,
        items=[("Send the memo", "Omar"), ("Schedule follow-up", None)],
    )
    assert len(items) == 2

    r = client.get(f"/meetings/{meeting_id}", headers={"Authorization": auth})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summaryStatus"] == "completed"
    assert body["summary"]["status"] == "completed"
    assert body["summary"]["summary"] == "All good."
    assert body["summary"]["decisions"] == ["Approve plan."]
    assert len(body["summary"]["topics"]) == 1
    assert body["summary"]["topics"][0]["name"] == "Topic A"
    assert body["summary"]["topics"][0]["durationSeconds"] == 600
    assert len(body["summary"]["actionItems"]) == 2
    assert body["summary"]["actionItems"][0]["description"] == "Send the memo"
    assert body["summary"]["actionItems"][0]["owner"] == "Omar"
    assert body["summary"]["actionItems"][1]["owner"] is None


def test_get_meeting_without_summary_has_pending_status(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_aiitems_b", email="ai_b@test.dev"
    )
    r = client.get(f"/meetings/{created['id']}", headers={"Authorization": auth})
    assert r.status_code == 200
    body = r.json()
    assert body["summaryStatus"] == "pending"
    assert body["summary"] is None


# -------------------------------------------------------------------------
# PATCH /meetings/:id/action_items/:item_id
# -------------------------------------------------------------------------


def test_patch_action_item_marks_complete(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_pai_a", email="pai_a@test.dev"
    )
    meeting_id = UUID(created["id"])

    async def _resolve_owner() -> UUID:
        async with db_session_factory() as s:
            row = (
                await s.execute(
                    text("SELECT * FROM auth.lookup_user_by_workos_id(:wid)"),
                    {"wid": "user_pai_a"},
                )
            ).first()
            assert row is not None
            return UUID(str(row.id))

    user_id = asyncio.run(_resolve_owner())

    item_ids = _seed_summary_with_items(
        db_session_factory,
        user_id,
        meeting_id,
        items=[("Do the thing", None)],
    )

    r = client.patch(
        f"/meetings/{meeting_id}/action_items/{item_ids[0]}",
        json={"completed": True},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completed"] is True
    assert body["completedAt"] is not None

    # Toggle back: completedAt should clear.
    r = client.patch(
        f"/meetings/{meeting_id}/action_items/{item_ids[0]}",
        json={"completed": False},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["completed"] is False
    assert r.json()["completedAt"] is None


def test_patch_action_item_updates_owner_and_deadline(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_pai_b", email="pai_b@test.dev"
    )
    meeting_id = UUID(created["id"])

    async def _resolve_owner() -> UUID:
        async with db_session_factory() as s:
            row = (
                await s.execute(
                    text("SELECT * FROM auth.lookup_user_by_workos_id(:wid)"),
                    {"wid": "user_pai_b"},
                )
            ).first()
            assert row is not None
            return UUID(str(row.id))

    user_id = asyncio.run(_resolve_owner())

    item_ids = _seed_summary_with_items(
        db_session_factory,
        user_id,
        meeting_id,
        items=[("Old desc", None)],
    )

    r = client.patch(
        f"/meetings/{meeting_id}/action_items/{item_ids[0]}",
        json={
            "description": "New desc",
            "owner": "Omar",
            "deadline": "2026-06-15",
        },
        headers={"Authorization": auth},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["description"] == "New desc"
    assert body["owner"] == "Omar"
    assert body["deadline"] == "2026-06-15"

    # Clearing owner via explicit null.
    r = client.patch(
        f"/meetings/{meeting_id}/action_items/{item_ids[0]}",
        json={"owner": None},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["owner"] is None


def test_patch_action_item_rejects_empty_description(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_pai_c", email="pai_c@test.dev"
    )
    meeting_id = UUID(created["id"])

    async def _resolve_owner() -> UUID:
        async with db_session_factory() as s:
            row = (
                await s.execute(
                    text("SELECT * FROM auth.lookup_user_by_workos_id(:wid)"),
                    {"wid": "user_pai_c"},
                )
            ).first()
            assert row is not None
            return UUID(str(row.id))

    user_id = asyncio.run(_resolve_owner())

    item_ids = _seed_summary_with_items(
        db_session_factory,
        user_id,
        meeting_id,
        items=[("Keep me", None)],
    )

    r = client.patch(
        f"/meetings/{meeting_id}/action_items/{item_ids[0]}",
        json={"description": "  "},
        headers={"Authorization": auth},
    )
    assert r.status_code == 422


def test_patch_action_item_404_when_unknown(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    auth, created = _create_meeting(
        client, dev_settings, sub="user_pai_d", email="pai_d@test.dev"
    )
    r = client.patch(
        f"/meetings/{created['id']}/action_items/{uuid4()}",
        json={"completed": True},
        headers={"Authorization": auth},
    )
    assert r.status_code == 404


def test_patch_action_item_requires_auth(
    client: TestClient,
) -> None:
    r = client.patch(
        f"/meetings/{uuid4()}/action_items/{uuid4()}",
        json={"completed": True},
    )
    assert r.status_code == 401
