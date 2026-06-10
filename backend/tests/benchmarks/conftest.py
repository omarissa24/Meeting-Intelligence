"""Shared plumbing for the seeded-DB latency benchmarks (`-m perf`).

Builds an app + TestClient against the session-scoped ephemeral test DB
(`db_urls` from the top-level conftest), provisions a user through the
real auth path, and exposes bulk seeding helpers. Module-scoped where
possible — seeding hundreds of meetings per test would defeat the
point of a latency measurement.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

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

pytestmark = pytest.mark.perf


@pytest.fixture(scope="module")
def bench_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture(scope="module")
def bench_provider() -> InMemoryFakeEmbeddingProvider:
    return InMemoryFakeEmbeddingProvider()


@pytest.fixture(scope="module")
def bench_app(
    db_urls: tuple[str, str],
    bench_settings: Settings,
    bench_provider: InMemoryFakeEmbeddingProvider,
) -> Iterator[FastAPI]:
    """App wired to a module-lifetime engine on the ephemeral test DB."""
    _, app_url = db_urls
    engine = create_async_engine(app_url, future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    app = create_app()
    app.dependency_overrides[get_session_factory] = lambda: factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(
        bench_settings
    )
    app.dependency_overrides[get_embedding_provider] = lambda: bench_provider
    try:
        yield app
    finally:
        asyncio.run(engine.dispose())


@pytest.fixture(scope="module")
def bench_client(bench_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(bench_app) as client:
        yield client


def bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


def provision_user(
    client: TestClient, settings: Settings, db_urls: tuple[str, str], *, email: str, sub: str
) -> tuple[str, UUID]:
    """Authed no-op request provisions the users row; return (auth, user_id)."""
    auth = bearer(settings, email=email, sub=sub)
    r = client.get("/meetings", headers={"Authorization": auth})
    assert r.status_code == 200, r.text

    admin_url, _ = db_urls

    async def _lookup() -> UUID:
        engine = create_async_engine(admin_url, future=True)
        try:
            async with engine.connect() as conn:
                row = await conn.execute(
                    text("SELECT id FROM users WHERE email = :e"), {"e": email}
                )
                return UUID(str(row.scalar_one()))
        finally:
            await engine.dispose()

    return auth, asyncio.run(_lookup())


async def seed_meetings(
    app_url: str,
    user_id: UUID,
    *,
    count: int,
    segments_per_meeting: int,
    embed: InMemoryFakeEmbeddingProvider | None = None,
) -> None:
    """Bulk-insert `count` meetings (+ segments) for `user_id`.

    Segments get real 1536-dim vectors from the fake provider when
    `embed` is given (deterministic SHA256-seeded — the pgvector cosine
    work and HNSW traversal are real; only the semantics are fake).
    One transaction, executemany-style batches per meeting.
    """
    engine = create_async_engine(app_url, future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with factory() as s:
            await set_request_user(s, user_id)
            for i in range(count):
                meeting_id = uuid4()
                await s.execute(
                    text(
                        "INSERT INTO meetings "
                        "(id, user_id, status, title, tags, started_at, duration_seconds) "
                        "VALUES (:m, :u, 'completed', :t, :tags, "
                        "        now() - make_interval(hours => :age_h), :dur)"
                    ),
                    {
                        "m": str(meeting_id),
                        "u": str(user_id),
                        "t": f"Benchmark meeting {i:04d}",
                        "tags": ["perf", f"batch-{i % 10}"],
                        "age_h": i,
                        "dur": 600 + (i % 240) * 10,
                    },
                )
                texts = [
                    f"meeting {i:04d} segment {j}: synthetic transcript line "
                    f"about topic {(i * 7 + j) % 97}"
                    for j in range(segments_per_meeting)
                ]
                vectors = (await embed.embed(texts)) if embed else None
                params = [
                    {
                        "m": str(meeting_id),
                        "u": str(user_id),
                        "t": txt,
                        "sm": j * 4000,
                        "em": (j + 1) * 4000,
                        "v": format_vector_literal(vectors[j]) if vectors else None,
                    }
                    for j, txt in enumerate(texts)
                ]
                await s.execute(
                    text(
                        "INSERT INTO transcript_segments "
                        "(meeting_id, user_id, speaker_id, text, start_ms, end_ms, "
                        " is_final, embedding) "
                        "VALUES (:m, :u, 'spk-1', :t, :sm, :em, true, "
                        "        CAST(:v AS vector))"
                    ),
                    params,
                )
            await s.commit()
    finally:
        await engine.dispose()
