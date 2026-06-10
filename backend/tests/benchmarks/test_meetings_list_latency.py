"""Phase 2 DoD: `GET /meetings` <500 ms for a user with 100 meetings.

Also closes the US-09 AC "list loads within 2 s for up to 100 meetings"
(the 500 ms bound is strictly tighter). Full HTTP round-trip through
the ASGI stack against the seeded ephemeral Postgres; assertion is on
the *max* observed latency — the DoD says "response time", not "mean".

Run: TEST_DATABASE_URL=... uv run pytest -m perf tests/benchmarks/test_meetings_list_latency.py
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from meeting_intelligence.config import Settings
from tests.benchmarks.conftest import provision_user, seed_meetings

pytestmark = pytest.mark.perf

MEETING_COUNT = 100
SEGMENTS_PER_MEETING = 20
MAX_LATENCY_SECONDS = 0.5


@pytest.fixture(scope="module")
def seeded_user(
    bench_client: TestClient,
    bench_settings: Settings,
    db_urls: tuple[str, str],
) -> Iterator[tuple[str, UUID]]:
    auth, user_id = provision_user(
        bench_client,
        bench_settings,
        db_urls,
        email="bench-meetings@perf.test",
        sub="bench_meetings_user",
    )
    _, app_url = db_urls
    asyncio.run(
        seed_meetings(
            app_url,
            user_id,
            count=MEETING_COUNT,
            segments_per_meeting=SEGMENTS_PER_MEETING,
        )
    )
    yield auth, user_id


def test_meetings_list_under_500ms_with_100_meetings(
    bench_client: TestClient,
    seeded_user: tuple[str, UUID],
    benchmark: Any,
) -> None:
    auth, _ = seeded_user
    # The route paginates with MAX_PAGE_LIMIT=100 — "a user with 100
    # meetings" maps to the full first page.
    url = f"/meetings?limit={MEETING_COUNT}"

    def _list() -> None:
        r = bench_client.get(url, headers={"Authorization": auth})
        assert r.status_code == 200

    # Sanity-check the dataset once before timing.
    first = bench_client.get(url, headers={"Authorization": auth})
    assert first.status_code == 200
    assert len(first.json()["items"]) == MEETING_COUNT

    benchmark.pedantic(_list, rounds=20, warmup_rounds=2)

    stats = benchmark.stats.stats
    assert stats.max < MAX_LATENCY_SECONDS, (
        f"GET /meetings max latency {stats.max * 1000:.1f} ms "
        f"breaches the {MAX_LATENCY_SECONDS * 1000:.0f} ms DoD "
        f"(mean {stats.mean * 1000:.1f} ms)"
    )
