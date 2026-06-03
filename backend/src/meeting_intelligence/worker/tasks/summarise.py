"""On-stop meeting summarisation task.

Triggered from the WS handler's `finally` block alongside
`archive_meeting_audio` (FR-3.01 dispatch path), and also by
POST /meetings/:id/summarise for explicit regenerate (FR-3.13).

The task:

  1. Loads `transcript_segments` for the meeting under RLS, ordered
     by `start_ms`. Only `is_final=True` rows feed the LLM —
     interims live in memory only.
  2. Assembles a speaker-tagged transcript (`S0: ...\nS1: ...`).
     Speaker count = distinct non-null `speaker_id`s.
  3. Upserts a `meeting_summaries` row to status='processing' so the
     desktop poller sees the transition immediately.
  4. Runs the LangGraph pipeline via `summarise_transcript`.
  5. On success: upserts the row to status='completed' with the
     payload columns and (atomically) wipes-and-reinserts
     `action_items`. Regenerate is therefore overwrite, not append.
  6. On too_short: status='too_short', empty payload.
  7. On error: status='failed' with the error message in `error`.

Failure handling: SQL failures retry up to 3 times (transient
connection issues). LLM unrecoverable errors do NOT retry — the
model already declined twice; a third try wastes tokens.
Validation-fail-then-retry happens inside the runner, transparent
to this task.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from celery.exceptions import MaxRetriesExceededError, Retry
from sqlalchemy import text

from meeting_intelligence.api.deps import get_llm_provider
from meeting_intelligence.config import get_settings
from meeting_intelligence.db.engine import make_engine, make_session_factory
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.summary import SummaryResult, summarise_transcript
from meeting_intelligence.summary.graph import SummariserLLM
from meeting_intelligence.worker.celery_app import celery_app

log = logging.getLogger("meeting_intelligence.worker.summarise")


class SummariseRetryable(Exception):
    """Raised by the task body to mark a retry-eligible failure.

    Pure SQL/connectivity errors hit this branch. LLM-content
    failures (validation twice, tool-use refusal) come back as
    `SummaryResult(error=...)` and are persisted as status='failed'
    without retry — the model already gave up.
    """


def _assemble_transcript(rows: Iterable[Any]) -> tuple[str, int]:
    """Return `(speaker_tagged_text, distinct_speaker_count)`.

    The runner wants `S0: ...\\nS1: ...` so the LLM can attribute
    statements to consistent labels even when the underlying
    speaker_id is something like `spk-3`. Speakers without a
    diarisation label (NULL speaker_id) get `S?` so we don't lose
    their content; they don't count toward speaker_count.
    """
    speaker_index: dict[str, int] = {}
    next_index = 0
    lines: list[str] = []
    for row in rows:
        spk = row.speaker_id
        if spk is None:
            label = "S?"
        else:
            if spk not in speaker_index:
                speaker_index[spk] = next_index
                next_index += 1
            label = f"S{speaker_index[spk]}"
        lines.append(f"{label}: {row.text}")
    return "\n".join(lines), len(speaker_index)


async def _do_summarise(
    *,
    meeting_id: UUID,
    user_id: UUID,
    llm: SummariserLLM,
) -> str:
    """Async body of the task. Returns the resulting status string."""
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL must be set for summarise task")
    engine = make_engine(settings.database_url)
    factory = make_session_factory(engine)
    try:
        # Load transcript + assemble.
        async with factory() as session:
            await set_request_user(session, user_id)
            result = await session.execute(
                text(
                    "SELECT speaker_id, text "
                    "FROM transcript_segments "
                    "WHERE meeting_id = :id AND is_final = true "
                    "ORDER BY start_ms"
                ),
                {"id": str(meeting_id)},
            )
            rows = result.all()
        transcript, speaker_count = _assemble_transcript(rows)

        # Park a `processing` row so the desktop poller sees the
        # transition the instant the WS handler dispatches us.
        async with factory() as session:
            await set_request_user(session, user_id)
            await _upsert_summary_row(
                session,
                meeting_id=meeting_id,
                user_id=user_id,
                status="processing",
            )
            await session.commit()

        # Invoke the pipeline. validation-retry happens inside.
        summary_result = await summarise_transcript(
            transcript=transcript,
            speaker_count=speaker_count,
            llm=llm,
        )

        async with factory() as session:
            await set_request_user(session, user_id)
            status = await _persist_result(
                session,
                meeting_id=meeting_id,
                user_id=user_id,
                summary_result=summary_result,
                model_version=get_settings().anthropic_model,
            )
            await session.commit()
        return status
    finally:
        await engine.dispose()


async def _upsert_summary_row(
    session: Any,
    *,
    meeting_id: UUID,
    user_id: UUID,
    status: str,
) -> None:
    """Initial-state upsert: status only.

    Updating without overwriting prior summary content keeps the
    desktop showing the previous summary while regenerate is in
    flight, then `_persist_result` overwrites everything atomically
    on completion.
    """
    await session.execute(
        text(
            """
            INSERT INTO meeting_summaries (meeting_id, user_id, status)
            VALUES (:meeting_id, :user_id, :status)
            ON CONFLICT (meeting_id) DO UPDATE
              SET status = EXCLUDED.status,
                  updated_at = now(),
                  -- Clear any prior error when re-attempting.
                  error = NULL
            """
        ),
        {
            "meeting_id": str(meeting_id),
            "user_id": str(user_id),
            "status": status,
        },
    )


async def _persist_result(
    session: Any,
    *,
    meeting_id: UUID,
    user_id: UUID,
    summary_result: SummaryResult,
    model_version: str,
) -> str:
    """Apply the SummaryResult to meeting_summaries + action_items.

    Status mapping:
      - too_short → 'too_short' with empty arrays
      - error     → 'failed' with `error` populated
      - success   → 'completed' with payload + action_items inserted
    """
    if summary_result.too_short:
        await session.execute(
            text(
                """
                INSERT INTO meeting_summaries
                  (meeting_id, user_id, status, summary, decisions, topics,
                   confidence_low, model_version, generated_at)
                VALUES
                  (:meeting_id, :user_id, 'too_short', NULL,
                   '[]'::jsonb, '[]'::jsonb,
                   :confidence_low, :model_version, now())
                ON CONFLICT (meeting_id) DO UPDATE
                  SET status = 'too_short',
                      summary = NULL,
                      decisions = '[]'::jsonb,
                      topics = '[]'::jsonb,
                      confidence_low = EXCLUDED.confidence_low,
                      model_version = EXCLUDED.model_version,
                      regenerated_at = CASE
                        WHEN meeting_summaries.generated_at IS NOT NULL
                          THEN now()
                        ELSE NULL
                      END,
                      generated_at = COALESCE(meeting_summaries.generated_at, now()),
                      input_tokens = NULL,
                      output_tokens = NULL,
                      error = NULL,
                      updated_at = now()
                """
            ),
            {
                "meeting_id": str(meeting_id),
                "user_id": str(user_id),
                "confidence_low": summary_result.confidence_low,
                "model_version": model_version,
            },
        )
        await _wipe_action_items(session, meeting_id)
        return "too_short"

    if summary_result.error is not None or summary_result.payload is None:
        err = summary_result.error or "unknown error"
        await session.execute(
            text(
                """
                INSERT INTO meeting_summaries
                  (meeting_id, user_id, status, summary, decisions, topics,
                   confidence_low, model_version, error, updated_at)
                VALUES
                  (:meeting_id, :user_id, 'failed', NULL,
                   '[]'::jsonb, '[]'::jsonb,
                   :confidence_low, :model_version, :error, now())
                ON CONFLICT (meeting_id) DO UPDATE
                  SET status = 'failed',
                      error = EXCLUDED.error,
                      confidence_low = EXCLUDED.confidence_low,
                      model_version = EXCLUDED.model_version,
                      updated_at = now()
                """
            ),
            {
                "meeting_id": str(meeting_id),
                "user_id": str(user_id),
                "confidence_low": summary_result.confidence_low,
                "model_version": model_version,
                "error": err[:2000],
            },
        )
        return "failed"

    payload = summary_result.payload
    decisions_json = _decisions_to_json(payload.decisions)
    topics_json = _topics_to_json(payload.topics)
    now = datetime.now(UTC)

    # Atomic upsert: same row on regenerate (overwrite). The CASE
    # expression sets generated_at on first write and regenerated_at
    # on subsequent writes, mirroring the spec.
    await session.execute(
        text(
            """
            INSERT INTO meeting_summaries
              (meeting_id, user_id, status, summary, decisions, topics,
               confidence_low, model_version, input_tokens, output_tokens,
               error, generated_at)
            VALUES
              (:meeting_id, :user_id, 'completed', :summary,
               CAST(:decisions AS jsonb), CAST(:topics AS jsonb),
               :confidence_low, :model_version, :input_tokens, :output_tokens,
               NULL, :now)
            ON CONFLICT (meeting_id) DO UPDATE
              SET status = 'completed',
                  summary = EXCLUDED.summary,
                  decisions = EXCLUDED.decisions,
                  topics = EXCLUDED.topics,
                  confidence_low = EXCLUDED.confidence_low,
                  model_version = EXCLUDED.model_version,
                  input_tokens = EXCLUDED.input_tokens,
                  output_tokens = EXCLUDED.output_tokens,
                  error = NULL,
                  generated_at = COALESCE(meeting_summaries.generated_at, EXCLUDED.generated_at),
                  regenerated_at = CASE
                    WHEN meeting_summaries.generated_at IS NOT NULL
                      THEN EXCLUDED.generated_at
                    ELSE NULL
                  END,
                  updated_at = now()
            """
        ),
        {
            "meeting_id": str(meeting_id),
            "user_id": str(user_id),
            "summary": payload.summary,
            "decisions": decisions_json,
            "topics": topics_json,
            "confidence_low": summary_result.confidence_low,
            "model_version": model_version,
            "input_tokens": summary_result.input_tokens,
            "output_tokens": summary_result.output_tokens,
            "now": now,
        },
    )

    await _wipe_action_items(session, meeting_id)
    for idx, item in enumerate(payload.action_items):
        await session.execute(
            text(
                """
                INSERT INTO action_items
                  (meeting_id, user_id, description, owner, deadline, order_index)
                VALUES
                  (:meeting_id, :user_id, :description, :owner, :deadline, :order_index)
                """
            ),
            {
                "meeting_id": str(meeting_id),
                "user_id": str(user_id),
                "description": item.description,
                "owner": item.owner,
                "deadline": item.deadline,
                "order_index": idx,
            },
        )
    return "completed"


async def _wipe_action_items(session: Any, meeting_id: UUID) -> None:
    """Delete every action_item for the meeting (regenerate semantics)."""
    await session.execute(
        text("DELETE FROM action_items WHERE meeting_id = :id"),
        {"id": str(meeting_id)},
    )


def _decisions_to_json(decisions: list[str]) -> str:
    import json
    return json.dumps(decisions)


def _topics_to_json(topics: list[Any]) -> str:
    import json
    serialised = [
        {"name": t.name, "duration_seconds": t.duration_seconds} for t in topics
    ]
    return json.dumps(serialised)


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True,
    name="meeting_intelligence.summarise_meeting",
    max_retries=3,
    default_retry_delay=30,
    acks_late=True,
)
def summarise_meeting(
    self: object,
    *,
    meeting_id: str,
    user_id: str,
) -> str:
    """Celery task entry-point. See module docstring for semantics.

    Returns the final status string ('completed', 'failed',
    'too_short') so eager-mode tests can assert on the outcome.
    """
    meeting_uuid = UUID(meeting_id)
    user_uuid = UUID(user_id)
    llm = get_llm_provider()
    try:
        return asyncio.run(
            _do_summarise(
                meeting_id=meeting_uuid,
                user_id=user_uuid,
                llm=llm,  # type: ignore[arg-type]
            )
        )
    except SummariseRetryable as exc:
        log.warning(
            "summarise.transient_failure meeting_id=%s err=%s",
            meeting_id,
            exc,
        )
        try:
            raise self.retry(exc=exc, countdown=30)  # type: ignore[attr-defined]
        except MaxRetriesExceededError:
            log.error(
                "summarise.dead_letter meeting_id=%s reason=%s",
                meeting_id,
                exc,
            )
            raise
        except Retry:
            raise


__all__ = ["SummariseRetryable", "summarise_meeting"]
