"""Phase 4 DoD: 50 search queries against 500 meetings, all <2 s.

Seeds 500 meetings x 6 embedded segments (3,000 real 1536-dim pgvector
rows — the cosine distances and HNSW traversal are real work; only the
embedding semantics are fake/deterministic). Every one of the 50
distinct queries must individually come in under 2 s, matching the DoD
wording. A representative query also runs under pytest-benchmark for
the stats table, and EXPLAIN confirms the HNSW index is used at this
scale (the rehearsal flagged in the Phase 4 HNSW DoD note).

Run: TEST_DATABASE_URL=... uv run pytest -m perf tests/benchmarks/test_search_latency.py
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from meeting_intelligence.config import Settings
from meeting_intelligence.db.engine import format_vector_literal
from meeting_intelligence.embedding.fake import InMemoryFakeEmbeddingProvider
from tests.benchmarks.conftest import provision_user, seed_meetings

pytestmark = pytest.mark.perf

MEETING_COUNT = 500
SEGMENTS_PER_MEETING = 6
QUERY_COUNT = 50
MAX_QUERY_SECONDS = 2.0


@pytest.fixture(scope="module")
def seeded_user(
    bench_client: TestClient,
    bench_settings: Settings,
    bench_provider: InMemoryFakeEmbeddingProvider,
    db_urls: tuple[str, str],
) -> Iterator[tuple[str, UUID]]:
    auth, user_id = provision_user(
        bench_client,
        bench_settings,
        db_urls,
        email="bench-search@perf.test",
        sub="bench_search_user",
    )
    _, app_url = db_urls
    asyncio.run(
        seed_meetings(
            app_url,
            user_id,
            count=MEETING_COUNT,
            segments_per_meeting=SEGMENTS_PER_MEETING,
            embed=bench_provider,
        )
    )
    yield auth, user_id


def _queries() -> list[str]:
    return [
        f"synthetic transcript line about topic {n}" for n in range(QUERY_COUNT)
    ]


def test_50_queries_against_500_meetings_all_under_2s(
    bench_client: TestClient,
    seeded_user: tuple[str, UUID],
) -> None:
    auth, _ = seeded_user
    timings: list[tuple[str, float]] = []
    for query in _queries():
        start = time.perf_counter()
        r = bench_client.post(
            "/search", json={"query": query}, headers={"Authorization": auth}
        )
        elapsed = time.perf_counter() - start
        assert r.status_code == 200, r.text
        assert r.json()["items"], f"no hits for {query!r} — seeding broken?"
        timings.append((query, elapsed))

    slowest = max(timings, key=lambda t: t[1])
    breaches = [(q, t) for q, t in timings if t >= MAX_QUERY_SECONDS]
    assert not breaches, (
        f"{len(breaches)}/{QUERY_COUNT} queries breached {MAX_QUERY_SECONDS}s; "
        f"slowest: {slowest[1]:.3f}s ({slowest[0]!r})"
    )


def test_representative_query_benchmark(
    bench_client: TestClient,
    seeded_user: tuple[str, UUID],
    benchmark: Any,
) -> None:
    auth, _ = seeded_user

    def _search() -> None:
        r = bench_client.post(
            "/search",
            json={"query": "synthetic transcript line about topic 13"},
            headers={"Authorization": auth},
        )
        assert r.status_code == 200

    benchmark.pedantic(_search, rounds=10, warmup_rounds=2)
    assert benchmark.stats.stats.max < MAX_QUERY_SECONDS


def test_vector_query_uses_hnsw_index(
    seeded_user: tuple[str, UUID],
    bench_provider: InMemoryFakeEmbeddingProvider,
    db_urls: tuple[str, str],
) -> None:
    """EXPLAIN at 500-meeting scale must traverse the HNSW index.

    Runs as the admin role (planner output only — no RLS concerns) with
    the same ORDER BY <=> LIMIT shape the search route issues.
    """
    admin_url, _ = db_urls

    async def _plan() -> str:
        vec = (await bench_provider.embed(["index check query"]))[0]
        engine = create_async_engine(admin_url, future=True)
        try:
            async with engine.connect() as conn:
                rows = await conn.execute(
                    text(
                        "EXPLAIN SELECT id FROM transcript_segments "
                        "WHERE embedding IS NOT NULL "
                        "ORDER BY embedding <=> CAST(:v AS vector) LIMIT 10"
                    ),
                    {"v": format_vector_literal(vec)},
                )
                return "\n".join(str(r[0]) for r in rows)
        finally:
            await engine.dispose()

    plan = asyncio.run(_plan())
    assert "ix_transcript_segments_embedding_hnsw" in plan, plan
