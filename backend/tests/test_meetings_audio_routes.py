"""GET /meetings/:id/audio + DELETE /audio — route-level tests.

Uses the same in-memory FastAPI app pattern as `test_meetings_routes.py`
so the routes are exercised through real auth + RLS — only the storage
provider is overridden to a `LocalDiskObjectStorage` rooted in `tmp_path`.

The conftest's per-session `db_session_factory` connects to an
ephemeral test DB; we override `get_session_factory` to return that
factory and provide an in-memory storage so audio uploads / fetches
don't touch a real S3.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import (
    get_auth_provider,
    get_object_storage,
    get_session_factory,
)
from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider, mint_dev_token
from meeting_intelligence.config import Settings
from meeting_intelligence.interfaces.storage import ObjectStorageProvider
from meeting_intelligence.main import create_app
from meeting_intelligence.storage.local_disk import LocalDiskObjectStorage


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture
def storage(tmp_path: Path) -> ObjectStorageProvider:
    return LocalDiskObjectStorage(
        root=tmp_path,
        signing_key="x" * 48,
        base_url="http://test.invalid/storage/local",
    )


@pytest.fixture
def app(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
    storage: ObjectStorageProvider,
) -> FastAPI:
    app = create_app()
    app.dependency_overrides[get_session_factory] = lambda: db_session_factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    app.dependency_overrides[get_object_storage] = lambda: storage
    return app


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


def _create_meeting(
    client: TestClient, settings: Settings, *, email: str, sub: str
) -> str:
    auth = _bearer(settings, email=email, sub=sub)
    r = client.post(
        "/meetings",
        json={"title": "audio-test"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 201
    return str(r.json()["id"])


def test_get_audio_404_when_no_archive(
    client: TestClient, dev_settings: Settings
) -> None:
    mid = _create_meeting(client, dev_settings, email="a@test.dev", sub="user_a")
    auth = _bearer(dev_settings, email="a@test.dev", sub="user_a")
    r = client.get(f"/meetings/{mid}/audio", headers={"Authorization": auth})
    assert r.status_code == 404
    assert "no audio archive" in r.json()["detail"]


def test_get_audio_returns_presigned_url(
    client: TestClient,
    dev_settings: Settings,
    storage: ObjectStorageProvider,
) -> None:
    mid = _create_meeting(client, dev_settings, email="b@test.dev", sub="user_b")
    auth = _bearer(dev_settings, email="b@test.dev", sub="user_b")

    # Stamp the column directly via PATCH-equivalent: the route reads
    # `audio_object_key` and only mints a URL when it's set. Easiest way
    # to flip it in the test is via the storage put + a direct UPDATE.
    # The audio archive task does this end-to-end in its own test.
    import asyncio

    async def _stamp() -> None:
        await storage.put(f"meetings/u/{mid}.mp3", b"audio", "audio/mpeg")

    asyncio.run(_stamp())

    # UPDATE meetings.audio_object_key under RLS for the user we're acting as.
    from sqlalchemy import text

    from meeting_intelligence.db.rls import set_request_user

    factory = client.app.dependency_overrides[get_session_factory]()

    async def _update() -> None:
        async with factory() as s:
            user_row = (
                await s.execute(
                    text("SELECT id FROM auth.lookup_user_by_workos_id('user_b')")
                )
            ).one()
            await set_request_user(s, user_row.id)
            await s.execute(
                text(
                    "UPDATE meetings SET audio_object_key = :k WHERE id = :mid"
                ),
                {"k": f"meetings/u/{mid}.mp3", "mid": mid},
            )
            await s.commit()

    asyncio.run(_update())

    r = client.get(f"/meetings/{mid}/audio", headers={"Authorization": auth})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["audioUrl"].startswith("http://test.invalid/storage/local/")
    assert "expiresAt" in body


def test_get_audio_isolates_users(
    client: TestClient,
    dev_settings: Settings,
) -> None:
    mid = _create_meeting(client, dev_settings, email="c@test.dev", sub="user_c")

    # User D tries to read C's meeting — RLS hides the row → 404.
    auth_d = _bearer(dev_settings, email="d@test.dev", sub="user_d")
    r = client.get(f"/meetings/{mid}/audio", headers={"Authorization": auth_d})
    assert r.status_code == 404


def test_delete_audio_idempotent_and_nulls_column(
    client: TestClient,
    dev_settings: Settings,
    storage: ObjectStorageProvider,
) -> None:
    mid = _create_meeting(client, dev_settings, email="e@test.dev", sub="user_e")
    auth = _bearer(dev_settings, email="e@test.dev", sub="user_e")

    # First delete with no audio set: 204 (idempotent no-op).
    r = client.delete(f"/meetings/{mid}/audio", headers={"Authorization": auth})
    assert r.status_code == 204

    # Stamp + delete: 204, column now NULL, file gone.
    import asyncio

    async def _put() -> None:
        await storage.put(f"meetings/u/{mid}.mp3", b"x", "audio/mpeg")

    asyncio.run(_put())

    from sqlalchemy import text

    from meeting_intelligence.db.rls import set_request_user

    factory = client.app.dependency_overrides[get_session_factory]()

    async def _stamp_and_check() -> str | None:
        async with factory() as s:
            user_row = (
                await s.execute(
                    text("SELECT id FROM auth.lookup_user_by_workos_id('user_e')")
                )
            ).one()
            await set_request_user(s, user_row.id)
            await s.execute(
                text(
                    "UPDATE meetings SET audio_object_key = :k WHERE id = :mid"
                ),
                {"k": f"meetings/u/{mid}.mp3", "mid": mid},
            )
            await s.commit()
        # Fresh session for the post-commit read; the GUC is per-tx so
        # we have to re-bind after commit.
        async with factory() as s2:
            user_row = (
                await s2.execute(
                    text("SELECT id FROM auth.lookup_user_by_workos_id('user_e')")
                )
            ).one()
            await set_request_user(s2, user_row.id)
            return (
                await s2.execute(
                    text("SELECT audio_object_key FROM meetings WHERE id = :mid"),
                    {"mid": mid},
                )
            ).scalar_one()

    assert asyncio.run(_stamp_and_check()) == f"meetings/u/{mid}.mp3"

    r = client.delete(f"/meetings/{mid}/audio", headers={"Authorization": auth})
    assert r.status_code == 204

    async def _read_back() -> str | None:
        async with factory() as s:
            user_row = (
                await s.execute(
                    text("SELECT id FROM auth.lookup_user_by_workos_id('user_e')")
                )
            ).one()
            await set_request_user(s, user_row.id)
            return (
                await s.execute(
                    text("SELECT audio_object_key FROM meetings WHERE id = :mid"),
                    {"mid": mid},
                )
            ).scalar_one()

    assert asyncio.run(_read_back()) is None
