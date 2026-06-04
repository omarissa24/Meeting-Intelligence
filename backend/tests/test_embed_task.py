"""embed_meeting_segments Celery task — integration tier.

Pattern matches `test_summarise_task.py`'s integration tier:

  - Spin up the ephemeral test DB (conftest does that).
  - Patch `make_engine`/`make_session_factory` inside the task module
    so the embedded UPDATE writes to the per-test DB.
  - Patch `get_embedding_provider` so the task uses the deterministic
    fake provider.
  - Seed a meeting + final transcript segments.
  - Run the task in eager mode.
  - Assert: rows have `embedding IS NOT NULL`, count matches inputs,
    a second invocation does nothing (idempotency).

Crucial assertion: the task respects RLS — the embedded UPDATE is
issued through `set_request_user(session, user_id)`. We verify by
reading back as `app_user` (RLS in force).
"""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.embedding.fake import InMemoryFakeEmbeddingProvider
from meeting_intelligence.worker.celery_app import celery_app
from meeting_intelligence.worker.tasks import embed as embed_module
from meeting_intelligence.worker.tasks.embed import embed_meeting_segments


@pytest.fixture
def eager_celery() -> Any:
    prev_eager = celery_app.conf.task_always_eager
    prev_propagate = celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    try:
        yield celery_app
    finally:
        celery_app.conf.task_always_eager = prev_eager
        celery_app.conf.task_eager_propagates = prev_propagate


def _patch_engine_and_provider(
    monkeypatch: pytest.MonkeyPatch,
    factory: async_sessionmaker[AsyncSession],
    provider: InMemoryFakeEmbeddingProvider,
) -> None:
    class _NoOpEngine:
        async def dispose(self) -> None:
            return None

    monkeypatch.setattr(embed_module, "make_engine", lambda _url: _NoOpEngine())
    monkeypatch.setattr(
        embed_module, "make_session_factory", lambda _engine: factory
    )
    monkeypatch.setattr(
        embed_module, "get_embedding_provider", lambda: provider
    )
    # The task module reads DATABASE_URL through get_settings(); we
    # don't actually use the URL when make_engine is patched, but
    # _do_embed_meeting raises if it's empty. Set something parseable.
    from meeting_intelligence.config import Settings, get_settings

    s = get_settings()
    monkeypatch.setattr(
        s, "database_url", "postgresql+psycopg://x:y@localhost/z", raising=False
    )
    # Type guard for unused import (pyright)
    _ = Settings


def _seed_user(factory: async_sessionmaker[AsyncSession], email: str) -> UUID:
    return asyncio.run(_seed_user_async(factory, email))


async def _seed_user_async(
    factory: async_sessionmaker[AsyncSession], email: str
) -> UUID:
    user_id = uuid4()
    async with factory() as s:
        await set_request_user(s, user_id)
        await s.execute(
            text("INSERT INTO users (id, email) VALUES (:i, :e)"),
            {"i": str(user_id), "e": email},
        )
        await s.commit()
    return user_id


def _seed_meeting_with_finals(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    finals: list[str],
) -> None:
    asyncio.run(_seed_meeting_with_finals_async(factory, user_id, meeting_id, finals))


async def _seed_meeting_with_finals_async(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    finals: list[str],
) -> None:
    async with factory() as s:
        await set_request_user(s, user_id)
        await s.execute(
            text(
                "INSERT INTO meetings (id, user_id, status, title) "
                "VALUES (:m, :u, 'completed', 't')"
            ),
            {"m": str(meeting_id), "u": str(user_id)},
        )
        for i, t in enumerate(finals):
            await s.execute(
                text(
                    "INSERT INTO transcript_segments "
                    "(meeting_id, user_id, speaker_id, text, start_ms, end_ms, is_final) "
                    "VALUES (:m, :u, 'spk-1', :t, :sm, :em, true)"
                ),
                {
                    "m": str(meeting_id),
                    "u": str(user_id),
                    "t": t,
                    "sm": i * 1000,
                    "em": (i + 1) * 1000,
                },
            )
        # Add an interim segment that should NOT be embedded.
        await s.execute(
            text(
                "INSERT INTO transcript_segments "
                "(meeting_id, user_id, speaker_id, text, start_ms, end_ms, is_final) "
                "VALUES (:m, :u, 'spk-1', :t, 0, 100, false)"
            ),
            {"m": str(meeting_id), "u": str(user_id), "t": "interim, ignore"},
        )
        await s.commit()


def _count_embedded(
    factory: async_sessionmaker[AsyncSession], user_id: UUID, meeting_id: UUID
) -> tuple[int, int]:
    """Return (with_embedding, total_finals)."""
    return asyncio.run(_count_embedded_async(factory, user_id, meeting_id))


async def _count_embedded_async(
    factory: async_sessionmaker[AsyncSession], user_id: UUID, meeting_id: UUID
) -> tuple[int, int]:
    async with factory() as s:
        await set_request_user(s, user_id)
        result = await s.execute(
            text(
                "SELECT "
                "  COUNT(*) FILTER (WHERE embedding IS NOT NULL AND is_final) AS with_emb, "
                "  COUNT(*) FILTER (WHERE is_final) AS total_finals "
                "FROM transcript_segments WHERE meeting_id = :m"
            ),
            {"m": str(meeting_id)},
        )
        row = result.one()
        return int(row.with_emb), int(row.total_finals)


def test_embed_task_writes_vectors_to_finals_only(
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    provider = InMemoryFakeEmbeddingProvider()
    _patch_engine_and_provider(monkeypatch, db_session_factory, provider)

    user_id = _seed_user(db_session_factory, "u1@embed.test")
    meeting_id = uuid4()
    _seed_meeting_with_finals(
        db_session_factory,
        user_id,
        meeting_id,
        ["alpha line", "beta line", "gamma line"],
    )

    result = embed_meeting_segments.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    )
    rows_written = result.get(timeout=10)
    assert rows_written == 3

    with_emb, total_finals = _count_embedded(db_session_factory, user_id, meeting_id)
    assert total_finals == 3
    assert with_emb == 3  # All three finals embedded; interim untouched.

    # Provider was called once with all 3 inputs (single batch).
    assert len(provider.calls) == 1
    assert provider.calls[0].inputs == ["alpha line", "beta line", "gamma line"]


def test_embed_task_is_idempotent(
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    provider = InMemoryFakeEmbeddingProvider()
    _patch_engine_and_provider(monkeypatch, db_session_factory, provider)

    user_id = _seed_user(db_session_factory, "u2@embed.test")
    meeting_id = uuid4()
    _seed_meeting_with_finals(
        db_session_factory, user_id, meeting_id, ["a", "b"]
    )

    first = embed_meeting_segments.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    ).get(timeout=10)
    second = embed_meeting_segments.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    ).get(timeout=10)
    assert first == 2
    assert second == 0  # Nothing left to embed.
    # Provider was called only on the first run.
    assert len(provider.calls) == 1


def test_embed_task_no_finals_is_noop(
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    provider = InMemoryFakeEmbeddingProvider()
    _patch_engine_and_provider(monkeypatch, db_session_factory, provider)

    user_id = _seed_user(db_session_factory, "u3@embed.test")
    meeting_id = uuid4()
    # Insert ONLY an interim — no finals.
    asyncio.run(
        _seed_meeting_with_finals_async(
            db_session_factory, user_id, meeting_id, []
        )
    )

    rows_written = embed_meeting_segments.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    ).get(timeout=10)
    assert rows_written == 0
    # Provider not called at all.
    assert provider.calls == []
