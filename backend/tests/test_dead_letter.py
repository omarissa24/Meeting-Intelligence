"""Durable dead-lettering (Phase 2 DoD line 160).

Three tiers:

  - `record_dead_letter` writes a real `dead_letter_tasks` row through
    the app-user role (grants from migration 0008 apply via the
    per-session impersonator role).
  - A dead-letter insert failure (here: no DATABASE_URL) logs and
    swallows — it must never mask the original task failure.
  - Task wiring: driving a task into `MaxRetriesExceededError` (eager
    apply with `retries=max_retries`) calls `record_dead_letter` with
    the task's identifying kwargs.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import psycopg
import pytest
from celery.exceptions import MaxRetriesExceededError

from meeting_intelligence.config import get_settings
from meeting_intelligence.worker.celery_app import celery_app
from meeting_intelligence.worker.dead_letter import record_dead_letter
from meeting_intelligence.worker.tasks import summarise as summarise_module
from meeting_intelligence.worker.tasks.summarise import (
    SummariseRetryable,
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


def test_record_dead_letter_inserts_row(
    db_urls: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    admin_url, app_url = db_urls
    settings = get_settings()
    monkeypatch.setattr(settings, "database_url", app_url)

    record_dead_letter(
        task_name="meeting_intelligence.archive_meeting_audio",
        task_id="task-123",
        args=None,
        kwargs={"meeting_id": "m-1", "user_id": "u-1"},
        error="ffmpeg failed (rc=1): boom",
    )

    sync_admin = admin_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(sync_admin) as conn:
        row = conn.execute(
            "SELECT task_name, task_id, kwargs->>'meeting_id', error, created_at "
            "FROM dead_letter_tasks"
        ).fetchone()
    assert row is not None
    assert row[0] == "meeting_intelligence.archive_meeting_audio"
    assert row[1] == "task-123"
    assert row[2] == "m-1"
    assert "ffmpeg failed" in row[3]
    assert row[4] is not None


def test_record_dead_letter_failure_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "database_url", None)
    # Must not raise — the original task failure is the one that matters.
    record_dead_letter(
        task_name="meeting_intelligence.summarise_meeting",
        task_id=None,
        args=None,
        kwargs={},
        error="boom",
    )


def test_exhausted_retries_invoke_record_dead_letter(
    eager_celery: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_kwargs: Any) -> str:
        raise SummariseRetryable("transient sql failure")

    monkeypatch.setattr(summarise_module, "_do_summarise", _boom)

    captured: list[dict[str, Any]] = []

    def _capture(**kwargs: Any) -> None:
        captured.append(kwargs)

    monkeypatch.setattr(summarise_module, "record_dead_letter", _capture)

    meeting_id = str(uuid4())
    user_id = str(uuid4())
    # `retries=max_retries` makes the eager `self.retry` hit the
    # exhausted path immediately — the same state a worker reaches after
    # the third real retry. Because the task passes `exc=` to retry,
    # Celery re-raises the original exception (NOT
    # MaxRetriesExceededError) — the handler catches both.
    with pytest.raises((MaxRetriesExceededError, SummariseRetryable)):
        summarise_meeting.apply(
            kwargs={"meeting_id": meeting_id, "user_id": user_id},
            retries=3,
        )

    assert len(captured) == 1
    assert captured[0]["task_name"] == "meeting_intelligence.summarise_meeting"
    assert captured[0]["kwargs"] == {"meeting_id": meeting_id, "user_id": user_id}
    assert "transient sql failure" in captured[0]["error"]
