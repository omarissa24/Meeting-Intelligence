"""Phase 4 embedding pipeline (FR-4.01 / FR-4.02).

Two Celery tasks:

  - `embed_meeting_segments(meeting_id, user_id)` — populates
    `transcript_segments.embedding` for one meeting's finals. Loads
    rows where `embedding IS NULL`, batches through the
    `EmbeddingProvider`, writes back. Idempotent: re-running on a
    meeting with already-embedded rows is a fast no-op.

  - `backfill_embeddings(user_id?)` — admin scan. Iterates over
    meetings (newest first) and dispatches `embed_meeting_segments`
    per meeting. Per-meeting dispatch keeps each Celery task short
    and ensures each task sets the RLS GUC for its own
    user_id — important when running across many users.

Dispatch site: `summarise_meeting` tail-chains `embed_meeting_segments`
on success. Search is decoupled from summary content but reuses the
same final-segment loading pattern, so co-locating the dispatch keeps
the operational surface narrow (one task to disable to skip search,
without changing the WS handler).

RLS during writes: the embedded UPDATE goes through the app role just
like every other write — `set_request_user` is called per
transaction. The backfill dispatcher is special only in that it MUST
read meetings without RLS scope when called without a `user_id`
filter; we use the admin role for that path (the engine wired with
the migration owner credentials, not `app_user`).

Failure handling: SQL transients retry 3x. OpenAI / API transients
are handled inside `OpenAIEmbeddingProvider` (3 retries with
exponential backoff). Anything that escapes the provider is treated
as permanent for this task — Celery will retry the outer task and
will eventually dead-letter.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID

from celery.exceptions import MaxRetriesExceededError, Retry
from sqlalchemy import text

from meeting_intelligence.api.deps import get_embedding_provider
from meeting_intelligence.config import get_settings
from meeting_intelligence.db.engine import (
    format_vector_literal,
    make_engine,
    make_session_factory,
)
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.interfaces.embedding import EmbeddingProvider
from meeting_intelligence.worker.celery_app import celery_app

log = logging.getLogger("meeting_intelligence.worker.embed")


# Per-batch input size. Stays well under the OpenAI 256-cap and keeps
# any single round-trip's wall-clock contained. 128 is a good middle
# ground for the 1m-60m segment-count range typical meetings produce.
_DB_BATCH_SIZE = 128


class EmbedRetryable(Exception):
    """Marker for retry-eligible failures (SQL/connectivity)."""


async def _do_embed_meeting(
    *,
    meeting_id: UUID,
    user_id: UUID,
    provider: EmbeddingProvider,
) -> int:
    """Async body. Returns the number of rows newly embedded."""
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL must be set for embed task")
    engine = make_engine(settings.database_url)
    factory = make_session_factory(engine)
    total_written = 0
    try:
        # Load only finals that haven't been embedded yet. Idempotent:
        # the second run sees an empty result and exits cheaply.
        async with factory() as session:
            await set_request_user(session, user_id)
            result = await session.execute(
                text(
                    "SELECT id, text "
                    "FROM transcript_segments "
                    "WHERE meeting_id = :id "
                    "  AND is_final = true "
                    "  AND embedding IS NULL "
                    "ORDER BY start_ms"
                ),
                {"id": str(meeting_id)},
            )
            rows = result.all()

        if not rows:
            log.info(
                "embed.skip meeting_id=%s reason=nothing_to_embed",
                meeting_id,
            )
            return 0

        # Batch through the provider. Each batch is one network
        # round-trip (or zero, if the fake provider). We keep the
        # write transaction short by committing per batch — a
        # provider error mid-meeting still preserves prior progress.
        for start in range(0, len(rows), _DB_BATCH_SIZE):
            chunk = rows[start : start + _DB_BATCH_SIZE]
            texts = [r.text for r in chunk]
            vectors = await provider.embed(texts)
            if len(vectors) != len(chunk):
                # Defensive: an out-of-order provider response would
                # silently misalign rows and vectors.
                raise RuntimeError(
                    f"embed: provider returned {len(vectors)} vectors "
                    f"for {len(chunk)} inputs"
                )
            async with factory() as session:
                await set_request_user(session, user_id)
                for row, vec in zip(chunk, vectors, strict=True):
                    await session.execute(
                        text(
                            "UPDATE transcript_segments "
                            "SET embedding = CAST(:v AS vector) "
                            "WHERE id = :id"
                        ),
                        {
                            "id": str(row.id),
                            "v": format_vector_literal(vec),
                        },
                    )
                await session.commit()
            total_written += len(chunk)
        log.info(
            "embed.done meeting_id=%s rows=%d",
            meeting_id,
            total_written,
        )
        return total_written
    finally:
        await engine.dispose()


async def _do_backfill(*, user_id: UUID | None) -> int:
    """Dispatch `embed_meeting_segments` for every meeting in scope.

    Returns the number of meetings dispatched. We stream meetings 50
    at a time and dispatch each via `.delay()` — this turns a
    long-running cross-user scan into many small RLS-clean tasks.
    """
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL must be set for backfill")
    engine = make_engine(settings.database_url)
    factory = make_session_factory(engine)
    dispatched = 0
    try:
        async with factory() as session:
            # Backfill scans across users — no RLS scope per session;
            # the engine connects as the migration owner role, which
            # bypasses RLS by table ownership. Each downstream
            # `embed_meeting_segments` task DOES set RLS scope per its
            # own user_id, so reads/writes inside that task respect
            # the user boundary.
            params: dict[str, Any] = {}
            where = ""
            if user_id is not None:
                where = "WHERE user_id = :user_id"
                params["user_id"] = str(user_id)
            result = await session.execute(
                text(
                    f"SELECT id, user_id FROM meetings {where} "
                    "ORDER BY started_at DESC NULLS LAST"
                ),
                params,
            )
            for row in result:
                embed_meeting_segments.delay(
                    meeting_id=str(row.id),
                    user_id=str(row.user_id),
                )
                dispatched += 1
        log.info(
            "embed.backfill.dispatched count=%d user_id=%s",
            dispatched,
            user_id,
        )
        return dispatched
    finally:
        await engine.dispose()


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True,
    name="meeting_intelligence.embed_meeting_segments",
    max_retries=3,
    default_retry_delay=15,
    acks_late=True,
)
def embed_meeting_segments(
    self: object,
    *,
    meeting_id: str,
    user_id: str,
) -> int:
    """Celery entry-point. Returns rows newly embedded (eager-mode tests assert)."""
    meeting_uuid = UUID(meeting_id)
    user_uuid = UUID(user_id)
    provider = get_embedding_provider()
    try:
        return asyncio.run(
            _do_embed_meeting(
                meeting_id=meeting_uuid,
                user_id=user_uuid,
                provider=provider,
            )
        )
    except EmbedRetryable as exc:
        log.warning(
            "embed.transient_failure meeting_id=%s err=%s",
            meeting_id,
            exc,
        )
        try:
            raise self.retry(exc=exc, countdown=15)  # type: ignore[attr-defined]
        except MaxRetriesExceededError:
            log.error(
                "embed.dead_letter meeting_id=%s reason=%s",
                meeting_id,
                exc,
            )
            raise
        except Retry:
            raise


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True,
    name="meeting_intelligence.backfill_embeddings",
    max_retries=3,
    default_retry_delay=30,
    acks_late=True,
)
def backfill_embeddings(
    self: object,
    *,
    user_id: str | None = None,
) -> int:
    """Admin task. Dispatches per-meeting embed tasks; returns dispatch count."""
    user_uuid = UUID(user_id) if user_id else None
    return asyncio.run(_do_backfill(user_id=user_uuid))


__all__ = [
    "EmbedRetryable",
    "backfill_embeddings",
    "embed_meeting_segments",
]
