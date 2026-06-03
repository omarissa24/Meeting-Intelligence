"""summarise_meeting Celery task tests.

The task wraps an async body that:
  1. Reads transcript_segments under RLS,
  2. Upserts a `processing` row,
  3. Invokes the LangGraph runner,
  4. Persists the result + action_items.

We have two tiers of coverage:

- Unit tier (no DB): patches `_do_summarise` directly to confirm the
  task plumbing — eager-mode delay, return value, exception → retry.
- Integration tier (real Postgres via `db_session_factory`): patches
  the worker's engine factory to point at the test DB, seeds segments,
  runs the eager task, asserts the resulting rows in
  `meeting_summaries` + `action_items`.

The integration tier mirrors `test_audio_archive_task.py`'s pattern of
substituting the storage/persist functions, but for summarise we
substitute `make_engine`/`make_session_factory` so the inner SQL
goes against the ephemeral DB.
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Any
from uuid import UUID, uuid4

import pytest
from celery.exceptions import Retry
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.llm.in_memory_fake import InMemoryFakeLLM
from meeting_intelligence.worker.celery_app import celery_app
from meeting_intelligence.worker.tasks import summarise as summarise_module
from meeting_intelligence.worker.tasks.summarise import (
    SummariseRetryable,
    _assemble_transcript,
    summarise_meeting,
)


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


# -----------------------------------------------------------------------------
# Pure helpers — no DB, no LLM
# -----------------------------------------------------------------------------


class _FakeRow:
    def __init__(self, speaker_id: str | None, text_value: str) -> None:
        self.speaker_id = speaker_id
        self.text = text_value


def test_assemble_transcript_groups_speakers_with_consistent_labels() -> None:
    rows = [
        _FakeRow("spk-1", "Hello team."),
        _FakeRow("spk-2", "Morning."),
        _FakeRow("spk-1", "Let's start."),
        _FakeRow(None, "(unintelligible)"),
    ]
    text_value, count = _assemble_transcript(rows)
    assert text_value == (
        "S0: Hello team.\nS1: Morning.\nS0: Let's start.\nS?: (unintelligible)"
    )
    # NULL speaker_id doesn't count toward distinct speaker_count.
    assert count == 2


def test_assemble_transcript_handles_empty() -> None:
    assert _assemble_transcript([]) == ("", 0)


# -----------------------------------------------------------------------------
# Task plumbing — patches _do_summarise to avoid a real DB
# -----------------------------------------------------------------------------


def test_task_returns_status_from_inner_body(
    eager_celery: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    async def _stub(*, meeting_id, user_id, llm) -> str:  # type: ignore[no-untyped-def]
        captured["meeting_id"] = meeting_id
        captured["user_id"] = user_id
        captured["llm_calls"] = len(getattr(llm, "calls", []))
        return "completed"

    monkeypatch.setattr(summarise_module, "_do_summarise", _stub)

    meeting_id = uuid4()
    user_id = uuid4()
    result = summarise_meeting.delay(
        meeting_id=str(meeting_id),
        user_id=str(user_id),
    )
    assert result.get(timeout=5) == "completed"
    assert captured["meeting_id"] == meeting_id
    assert captured["user_id"] == user_id


def test_task_retries_on_summarise_retryable(
    eager_celery: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_kwargs: Any) -> str:
        raise SummariseRetryable("transient sql failure")

    monkeypatch.setattr(summarise_module, "_do_summarise", _boom)

    with pytest.raises((Retry, SummariseRetryable)):
        result = summarise_meeting.delay(
            meeting_id=str(uuid4()),
            user_id=str(uuid4()),
        )
        result.get(timeout=5)


# -----------------------------------------------------------------------------
# Integration tier — real Postgres via db_session_factory fixture
# -----------------------------------------------------------------------------


def _valid_payload() -> dict[str, Any]:
    return {
        "summary": "Quick standup ran short.",
        "decisions": ["Approve the budget revision."],
        "action_items": [
            {
                "description": "Email the team the budget memo",
                "owner": "Omar",
                "deadline": "2026-06-15",
            },
            {
                "description": "Schedule follow-up",
                "owner": None,
                "deadline": None,
            },
        ],
        "topics": [
            {"name": "Budget", "duration_seconds": 600},
            {"name": "Schedule", "duration_seconds": 180},
        ],
    }


def _patch_engine_factory(
    monkeypatch: pytest.MonkeyPatch,
    factory: async_sessionmaker[AsyncSession],
) -> None:
    """Force the task to use the per-test engine.

    The task builds its own `make_engine + make_session_factory` from
    `Settings.database_url`. Tests can't easily set that to the
    ephemeral DB URL the conftest produces, so we monkeypatch both
    factory functions to return the fixture's session factory and a
    no-op engine wrapper.
    """

    class _NoOpEngine:
        async def dispose(self) -> None:
            return None

    monkeypatch.setattr(summarise_module, "make_engine", lambda _url: _NoOpEngine())
    monkeypatch.setattr(
        summarise_module, "make_session_factory", lambda _engine: factory
    )


def _seed_meeting_with_transcript(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    transcript_lines: list[tuple[str | None, str, int, int]],
) -> None:
    """Synchronous wrapper around the async seed.

    The integration tests must run as sync `def` because the Celery
    task body itself calls `asyncio.run(_do_summarise(...))` and a
    nested loop would raise. We isolate seeding into its own loop.
    """
    asyncio.run(_seed_meeting_with_transcript_async(factory, user_id, meeting_id, transcript_lines))


async def _seed_meeting_with_transcript_async(
    factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
    meeting_id: UUID,
    transcript_lines: list[tuple[str | None, str, int, int]],
) -> None:
    async with factory() as s:
        await set_request_user(s, user_id)
        await s.execute(
            text(
                "INSERT INTO meetings (id, user_id, status, title) "
                "VALUES (:id, :u, 'completed', :t)"
            ),
            {"id": str(meeting_id), "u": str(user_id), "t": "Test meeting"},
        )
        for spk, txt, start, end in transcript_lines:
            await s.execute(
                text(
                    "INSERT INTO transcript_segments "
                    "(meeting_id, user_id, speaker_id, text, start_ms, end_ms, is_final) "
                    "VALUES (:m, :u, :s, :t, :sm, :em, true)"
                ),
                {
                    "m": str(meeting_id),
                    "u": str(user_id),
                    "s": spk,
                    "t": txt,
                    "sm": start,
                    "em": end,
                },
            )
        await s.commit()


def _seed_user(
    factory: async_sessionmaker[AsyncSession], email: str
) -> UUID:
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


def _read_summary_row(
    factory: async_sessionmaker[AsyncSession], user_id: UUID, meeting_id: UUID
) -> Any:
    async def _do() -> Any:
        async with factory() as s:
            await set_request_user(s, user_id)
            row = (
                await s.execute(
                    text(
                        "SELECT status, summary, decisions, input_tokens, "
                        "output_tokens, model_version, confidence_low, "
                        "generated_at, regenerated_at "
                        "FROM meeting_summaries WHERE meeting_id = :m"
                    ),
                    {"m": str(meeting_id)},
                )
            ).first()
            return row

    return asyncio.run(_do())


def _read_action_items(
    factory: async_sessionmaker[AsyncSession], user_id: UUID, meeting_id: UUID
) -> list[Any]:
    async def _do() -> list[Any]:
        async with factory() as s:
            await set_request_user(s, user_id)
            rows = (
                await s.execute(
                    text(
                        "SELECT description, owner, deadline, order_index "
                        "FROM action_items WHERE meeting_id = :m "
                        "ORDER BY order_index"
                    ),
                    {"m": str(meeting_id)},
                )
            ).all()
            return list(rows)

    return asyncio.run(_do())


def test_summarise_writes_completed_row_with_action_items(
    db_session_factory: async_sessionmaker[AsyncSession],
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end with real Postgres: completed row + action_items rows."""
    user_id = _seed_user(db_session_factory, f"u-{uuid4()}@example.com")
    meeting_id = uuid4()

    long_line = " ".join(["alpha"] * 200)
    _seed_meeting_with_transcript(
        db_session_factory,
        user_id,
        meeting_id,
        [
            ("spk-1", "Welcome everyone.", 0, 1000),
            ("spk-2", long_line, 1000, 60_000),
        ],
    )

    monkeypatch.setattr(
        summarise_module,
        "get_settings",
        lambda: type(
            "S", (), {"database_url": "ignored", "anthropic_model": "test-model"}
        )(),
    )
    _patch_engine_factory(monkeypatch, db_session_factory)

    fake = InMemoryFakeLLM(responses=[(_valid_payload(), 1234, 567)])
    monkeypatch.setattr(summarise_module, "get_llm_provider", lambda: fake)

    result = summarise_meeting.delay(
        meeting_id=str(meeting_id),
        user_id=str(user_id),
    )
    status = result.get(timeout=10)
    assert status == "completed"

    row = _read_summary_row(db_session_factory, user_id, meeting_id)
    assert row.status == "completed"
    assert row.summary == "Quick standup ran short."
    assert row.decisions == ["Approve the budget revision."]
    assert row.input_tokens == 1234
    assert row.output_tokens == 567
    assert row.model_version == "test-model"
    assert row.confidence_low is False  # 2 distinct speakers

    rows = _read_action_items(db_session_factory, user_id, meeting_id)
    assert len(rows) == 2
    assert rows[0].description == "Email the team the budget memo"
    assert rows[0].owner == "Omar"
    assert rows[0].deadline == date(2026, 6, 15)
    assert rows[0].order_index == 0
    assert rows[1].description == "Schedule follow-up"
    assert rows[1].owner is None
    assert rows[1].deadline is None
    assert rows[1].order_index == 1


def test_summarise_too_short_status_no_llm_call(
    db_session_factory: async_sessionmaker[AsyncSession],
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Below 50-word floor: status='too_short', LLM never called."""
    user_id = _seed_user(db_session_factory, f"u-{uuid4()}@example.com")
    meeting_id = uuid4()

    _seed_meeting_with_transcript(
        db_session_factory,
        user_id,
        meeting_id,
        [("spk-1", "Hello world.", 0, 1000)],
    )

    monkeypatch.setattr(
        summarise_module,
        "get_settings",
        lambda: type(
            "S", (), {"database_url": "ignored", "anthropic_model": "test-model"}
        )(),
    )
    _patch_engine_factory(monkeypatch, db_session_factory)

    fake = InMemoryFakeLLM(responses=[])  # empty queue — would crash if used
    monkeypatch.setattr(summarise_module, "get_llm_provider", lambda: fake)

    result = summarise_meeting.delay(
        meeting_id=str(meeting_id),
        user_id=str(user_id),
    )
    assert result.get(timeout=5) == "too_short"

    # The fake's tool_use was never called.
    assert all(c.method != "tool_use" for c in fake.calls)

    row = _read_summary_row(db_session_factory, user_id, meeting_id)
    assert row.status == "too_short"
    assert row.summary is None


def test_summarise_regenerate_overwrites_action_items(
    db_session_factory: async_sessionmaker[AsyncSession],
    eager_celery: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Second run wipes prior action_items and inserts the new set."""
    user_id = _seed_user(db_session_factory, f"u-{uuid4()}@example.com")
    meeting_id = uuid4()

    long_line = " ".join(["alpha"] * 200)
    _seed_meeting_with_transcript(
        db_session_factory,
        user_id,
        meeting_id,
        [("spk-1", long_line, 0, 30_000)],
    )

    monkeypatch.setattr(
        summarise_module,
        "get_settings",
        lambda: type(
            "S", (), {"database_url": "ignored", "anthropic_model": "test-model"}
        )(),
    )
    _patch_engine_factory(monkeypatch, db_session_factory)

    first_payload = {
        "summary": "First pass.",
        "decisions": [],
        "action_items": [
            {"description": "OLD task A", "owner": None, "deadline": None},
            {"description": "OLD task B", "owner": None, "deadline": None},
        ],
        "topics": [{"name": "Stuff", "duration_seconds": 60}],
    }
    second_payload = {
        "summary": "Second pass.",
        "decisions": [],
        "action_items": [
            {"description": "NEW task only", "owner": None, "deadline": None},
        ],
        "topics": [{"name": "Stuff", "duration_seconds": 60}],
    }
    fake = InMemoryFakeLLM(
        responses=[
            (first_payload, 100, 200),
            (second_payload, 110, 210),
        ],
    )
    monkeypatch.setattr(summarise_module, "get_llm_provider", lambda: fake)

    summarise_meeting.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    ).get(timeout=5)
    summarise_meeting.delay(
        meeting_id=str(meeting_id), user_id=str(user_id)
    ).get(timeout=5)

    rows = _read_action_items(db_session_factory, user_id, meeting_id)
    assert [r.description for r in rows] == ["NEW task only"]

    summary_row = _read_summary_row(db_session_factory, user_id, meeting_id)
    assert summary_row.summary == "Second pass."
    assert summary_row.generated_at is not None
    assert summary_row.regenerated_at is not None
