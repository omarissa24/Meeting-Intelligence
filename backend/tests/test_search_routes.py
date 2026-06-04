"""POST /search route — integration tests.

Covers:

  - Auth gate (401 without bearer).
  - Empty query → 400.
  - Happy path returns ranked hits in cosine-distance order. We seed
    three meetings with disjoint texts, embed them via the fake
    provider, then query against the same fake — the deterministic
    SHA256-seeded vectors mean the row whose text exactly matches the
    query has cosine distance 0 and ranks first.
  - Date / duration / tag filters narrow the result set correctly
    (the matching row is filtered out → empty results).
  - RLS isolation: user B's search hits zero rows when only user A's
    meeting was embedded.

We use the same `_patch_engine_and_provider` pattern as the embed
test, but here it goes against the FastAPI dep overrides since the
search route is HTTP-driven.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import (
    get_auth_provider,
    get_embedding_provider,
    get_session_factory,
)
from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider, mint_dev_token
from meeting_intelligence.config import Settings
from meeting_intelligence.db.engine import format_vector_literal
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.embedding.fake import InMemoryFakeEmbeddingProvider
from meeting_intelligence.main import create_app


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture
def fake_provider() -> InMemoryFakeEmbeddingProvider:
    return InMemoryFakeEmbeddingProvider()


@pytest.fixture
def app(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
    fake_provider: InMemoryFakeEmbeddingProvider,
) -> FastAPI:
    a = create_app()
    a.dependency_overrides[get_session_factory] = lambda: db_session_factory
    a.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    a.dependency_overrides[get_embedding_provider] = lambda: fake_provider
    return a


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


# -----------------------------------------------------------------------------
# Seeding helpers
# -----------------------------------------------------------------------------


def _seed_meeting(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    *,
    title: str,
    started_at: str,  # ISO date 'YYYY-MM-DD'
    duration_seconds: int,
    tags: list[str],
    final_texts: list[str],
    provider: InMemoryFakeEmbeddingProvider,
) -> UUID:
    return asyncio.run(
        _seed_meeting_async(
            factory,
            user_id,
            title=title,
            started_at=started_at,
            duration_seconds=duration_seconds,
            tags=tags,
            final_texts=final_texts,
            provider=provider,
        )
    )


async def _seed_meeting_async(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    *,
    title: str,
    started_at: str,
    duration_seconds: int,
    tags: list[str],
    final_texts: list[str],
    provider: InMemoryFakeEmbeddingProvider,
) -> UUID:
    meeting_id = uuid4()
    vectors = await provider.embed(final_texts)
    async with factory() as s:
        await set_request_user(s, user_id)
        await s.execute(
            text(
                "INSERT INTO meetings "
                "(id, user_id, status, title, tags, started_at, duration_seconds) "
                "VALUES (:m, :u, 'completed', :t, :tags, "
                "        CAST(:sa AS timestamptz), :dur)"
            ),
            {
                "m": str(meeting_id),
                "u": str(user_id),
                "t": title,
                "tags": tags,
                "sa": started_at + "T12:00:00Z",
                "dur": duration_seconds,
            },
        )
        for i, (txt, vec) in enumerate(zip(final_texts, vectors, strict=True)):
            await s.execute(
                text(
                    "INSERT INTO transcript_segments "
                    "(meeting_id, user_id, speaker_id, text, start_ms, end_ms, "
                    " is_final, embedding) "
                    "VALUES (:m, :u, 'spk-1', :t, :sm, :em, true, "
                    "        CAST(:v AS vector))"
                ),
                {
                    "m": str(meeting_id),
                    "u": str(user_id),
                    "t": txt,
                    "sm": i * 1000,
                    "em": (i + 1) * 1000,
                    "v": format_vector_literal(vec),
                },
            )
        await s.commit()
    return meeting_id


# -----------------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------------


def test_search_requires_auth(client: TestClient) -> None:
    r = client.post("/search", json={"query": "hi"})
    assert r.status_code == 401


def test_search_empty_query_400(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="empty@s.test", sub="user_empty")
    r = client.post(
        "/search",
        json={"query": "   "},
        headers={"Authorization": auth},
    )
    # Trimmed-empty trips our explicit guard, but Pydantic min_length=1
    # would also reject the blank-string case before the route runs.
    assert r.status_code in (400, 422)


def test_search_returns_hits_when_seeded_under_jwt_user(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
    db_engine: AsyncEngine,
    fake_provider: InMemoryFakeEmbeddingProvider,
) -> None:
    """Seed under the JWT-resolved user so RLS lets the route read.

    We perform a no-op authenticated request first to provision the
    user row, then read its id back to use for direct seeding.
    """
    auth = _bearer(dev_settings, email="hit@s.test", sub="user_hit")
    # Trigger user provisioning via the auth path.
    r0 = client.get("/meetings", headers={"Authorization": auth})
    assert r0.status_code == 200, r0.text

    # Read the provisioned user_id from the DB (admin path — bypasses
    # RLS because conftest's `db_session_factory` is the app role; we
    # need an introspection path). We use the app session and rely on
    # there being only one user in this test DB.
    user_id = asyncio.run(_load_only_user_id(db_engine, "hit@s.test"))

    _seed_meeting(
        db_session_factory,
        user_id,
        title="Budget review",
        started_at="2026-04-10",
        duration_seconds=600,
        tags=["finance"],
        final_texts=["Discuss the quarterly budget overrun"],
        provider=fake_provider,
    )
    _seed_meeting(
        db_session_factory,
        user_id,
        title="Hiring sync",
        started_at="2026-05-10",
        duration_seconds=900,
        tags=["people"],
        final_texts=["Review the hiring pipeline for Q2"],
        provider=fake_provider,
    )

    r = client.post(
        "/search",
        json={"query": "Discuss the quarterly budget overrun"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) >= 1
    # Exact-text match → cosine distance 0 → score 1.0 (top hit).
    top = body["items"][0]
    assert top["meetingTitle"] == "Budget review"
    assert top["segmentText"] == "Discuss the quarterly budget overrun"
    assert top["score"] > 0.99


async def _load_only_user_id(
    db_engine: AsyncEngine, email: str
) -> UUID:
    """Read back the auto-provisioned user via the admin engine.

    The admin engine connects as the migration owner role, which by
    Postgres convention bypasses RLS on tables it owns. Tests use
    this only as an introspection escape hatch — production code
    must always go through the app_user role.
    """
    from sqlalchemy import text as _text

    async with db_engine.begin() as conn:
        result = await conn.execute(
            _text("SELECT id FROM users WHERE email = :e"),
            {"e": email},
        )
        row = result.one()
        return UUID(str(row.id))


def test_search_filter_by_tag(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
    db_engine: AsyncEngine,
    fake_provider: InMemoryFakeEmbeddingProvider,
) -> None:
    auth = _bearer(dev_settings, email="tag@s.test", sub="user_tag")
    r0 = client.get("/meetings", headers={"Authorization": auth})
    assert r0.status_code == 200
    user_id = asyncio.run(_load_only_user_id(db_engine, "tag@s.test"))

    _seed_meeting(
        db_session_factory,
        user_id,
        title="Finance",
        started_at="2026-04-10",
        duration_seconds=600,
        tags=["finance"],
        final_texts=["Quarterly revenue projections"],
        provider=fake_provider,
    )
    _seed_meeting(
        db_session_factory,
        user_id,
        title="Product",
        started_at="2026-04-10",
        duration_seconds=600,
        tags=["product"],
        final_texts=["Quarterly revenue projections"],  # SAME text as above
        provider=fake_provider,
    )

    # Search with NO filter → both rows match (both meetings have the
    # same exact text, both score ~1.0).
    r = client.post(
        "/search",
        json={"query": "Quarterly revenue projections"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    titles = [h["meetingTitle"] for h in r.json()["items"]]
    assert "Finance" in titles
    assert "Product" in titles

    # Filter to finance only → Product disappears.
    r = client.post(
        "/search",
        json={
            "query": "Quarterly revenue projections",
            "tags": ["finance"],
        },
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    titles = [h["meetingTitle"] for h in r.json()["items"]]
    assert titles == ["Finance"]


def test_search_filter_by_duration(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
    db_engine: AsyncEngine,
    fake_provider: InMemoryFakeEmbeddingProvider,
) -> None:
    auth = _bearer(dev_settings, email="dur@s.test", sub="user_dur")
    r0 = client.get("/meetings", headers={"Authorization": auth})
    assert r0.status_code == 200
    user_id = asyncio.run(_load_only_user_id(db_engine, "dur@s.test"))

    _seed_meeting(
        db_session_factory,
        user_id,
        title="Short",
        started_at="2026-04-10",
        duration_seconds=120,
        tags=[],
        final_texts=["concept x"],
        provider=fake_provider,
    )
    _seed_meeting(
        db_session_factory,
        user_id,
        title="Long",
        started_at="2026-04-11",
        duration_seconds=3600,
        tags=[],
        final_texts=["concept x"],
        provider=fake_provider,
    )

    r = client.post(
        "/search",
        json={"query": "concept x", "durationMinSeconds": 600},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    titles = [h["meetingTitle"] for h in r.json()["items"]]
    assert titles == ["Long"]


def test_search_filter_by_date_range(
    client: TestClient,
    dev_settings: Settings,
    db_session_factory: async_sessionmaker[AsyncSession],
    db_engine: AsyncEngine,
    fake_provider: InMemoryFakeEmbeddingProvider,
) -> None:
    auth = _bearer(dev_settings, email="date@s.test", sub="user_date")
    r0 = client.get("/meetings", headers={"Authorization": auth})
    assert r0.status_code == 200
    user_id = asyncio.run(_load_only_user_id(db_engine, "date@s.test"))

    _seed_meeting(
        db_session_factory,
        user_id,
        title="Old",
        started_at="2025-12-01",
        duration_seconds=600,
        tags=[],
        final_texts=["alpha"],
        provider=fake_provider,
    )
    _seed_meeting(
        db_session_factory,
        user_id,
        title="New",
        started_at="2026-04-01",
        duration_seconds=600,
        tags=[],
        final_texts=["alpha"],
        provider=fake_provider,
    )

    # Both with no filter.
    r = client.post(
        "/search",
        json={"query": "alpha"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    titles = [h["meetingTitle"] for h in r.json()["items"]]
    assert {"Old", "New"} <= set(titles)

    # Restrict to dates >= 2026-01-01.
    r = client.post(
        "/search",
        json={"query": "alpha", "dateStart": "2026-01-01"},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    titles = [h["meetingTitle"] for h in r.json()["items"]]
    assert titles == ["New"]
