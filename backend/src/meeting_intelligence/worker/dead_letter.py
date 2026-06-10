"""Durable dead-lettering for Celery tasks (Phase 2 DoD line 160).

`record_dead_letter` inserts a `dead_letter_tasks` row when a task
exhausts its retries, so the failure survives log rotation and can be
inspected/replayed with ops SQL. Callers invoke it from the
`MaxRetriesExceededError` handler *before* re-raising.

Failure-safe by contract: a dead-letter insert that itself fails must
never mask the original task failure — it logs and swallows. The insert
uses its own short-lived engine (same per-task pattern as the tasks'
other DB writes) and no RLS GUC: `dead_letter_tasks` is an ops table.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from sqlalchemy import text

from meeting_intelligence.config import get_settings
from meeting_intelligence.db.engine import make_engine, make_session_factory

log = logging.getLogger("meeting_intelligence.worker.dead_letter")


async def _insert(
    task_name: str,
    task_id: str | None,
    args: Any,
    kwargs: Any,
    error: str,
) -> None:
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL must be set to record dead letters")
    engine = make_engine(settings.database_url)
    factory = make_session_factory(engine)
    try:
        async with factory() as session:
            await session.execute(
                text(
                    "INSERT INTO dead_letter_tasks"
                    " (task_name, task_id, args, kwargs, error)"
                    " VALUES (:task_name, :task_id,"
                    " CAST(:args AS jsonb), CAST(:kwargs AS jsonb), :error)"
                ),
                {
                    "task_name": task_name,
                    "task_id": task_id,
                    "args": _as_json(args),
                    "kwargs": _as_json(kwargs),
                    "error": error,
                },
            )
            await session.commit()
    finally:
        await engine.dispose()


def _as_json(value: Any) -> str:
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):
        return json.dumps(str(value))


def record_dead_letter(
    task_name: str,
    task_id: str | None,
    args: Any,
    kwargs: Any,
    error: str,
) -> None:
    """Insert a dead-letter row; never raises (logs on its own failure)."""
    try:
        asyncio.run(_insert(task_name, task_id, args, kwargs, error))
        log.error(
            "dead_letter.recorded task_name=%s task_id=%s", task_name, task_id
        )
    except Exception:
        log.exception(
            "dead_letter.record_failed task_name=%s task_id=%s — original "
            "failure is NOT masked; see the preceding dead_letter log line",
            task_name,
            task_id,
        )
