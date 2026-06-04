"""Phase 4 semantic search route (US-22 / FR-4.03).

`POST /search` embeds the query, joins `transcript_segments` to
`meetings`, applies date / duration / tag pre-filters, then orders by
cosine distance against the HNSW index built in migration 0006.

Why POST and not GET: the request body is a structured filter object
(arrays, optional dates, full-text query). GET with these as query
params would force the desktop to URL-encode arrays — POST is cleaner
and React Query handles it identically.

RLS scoping: like every other route, the request session has
`app.current_user_id` set per request. The SQL never names `user_id`
in `WHERE`; the policy filters cross-user rows out at the database
layer.

The vector parameter is bound as a `vector` literal string and cast
inline via `CAST(:q AS vector)` — see `db/engine.py` for the
formatter — which keeps the engine wiring free of pgvector psycopg
adapter ceremony and works the same in tests and prod. (Postgres's
`::` cast syntax conflicts with SQLAlchemy's `:name` parameter
delimiter, so we always use the `CAST(...)` spelling.)
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from meeting_intelligence.api.deps import get_embedding_provider
from meeting_intelligence.auth.deps import get_request_session
from meeting_intelligence.db.engine import format_vector_literal
from meeting_intelligence.interfaces.embedding import EmbeddingProvider

router = APIRouter(prefix="/search", tags=["search"])
log = logging.getLogger("meeting_intelligence.search")


_MAX_QUERY_LENGTH = 500
_DEFAULT_LIMIT = 10
_MAX_LIMIT = 50


class _CamelModel(BaseModel):
    model_config = {"populate_by_name": True}


class SearchRequest(_CamelModel):
    query: str = Field(min_length=1, max_length=_MAX_QUERY_LENGTH)
    dateStart: date | None = None
    dateEnd: date | None = None
    durationMinSeconds: int | None = Field(default=None, ge=0)
    durationMaxSeconds: int | None = Field(default=None, ge=0)
    tags: list[str] = Field(default_factory=list)
    limit: int = Field(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT)


class SearchHit(_CamelModel):
    meetingId: UUID
    meetingTitle: str | None
    meetingStartedAt: datetime | None
    segmentId: UUID
    segmentText: str
    segmentStartMs: int
    segmentEndMs: int
    speakerId: str | None
    score: float


class SearchResponse(_CamelModel):
    items: list[SearchHit]


@router.post("", response_model=SearchResponse)
async def search(
    body: SearchRequest,
    session: Annotated[AsyncSession, Depends(get_request_session)],
    provider: Annotated[EmbeddingProvider, Depends(get_embedding_provider)],
) -> SearchResponse:
    query = body.query.strip()
    if not query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="query must be non-empty",
        )

    # Embed the query first — if the provider is unhealthy, fail
    # fast before touching the DB.
    vectors = await provider.embed([query])
    if not vectors or len(vectors[0]) != provider.dimensions:
        # A misbehaving provider that returned the wrong shape would
        # cause a silent ranking failure downstream.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="embedding provider returned an unexpected shape",
        )
    q_literal = format_vector_literal(vectors[0])

    # End-of-day inclusive: clients send `dateEnd` as a calendar
    # date; we treat it as "up to and including that day" by
    # comparing `< dateEnd + 1 day`. Keeps the semantics intuitive.
    date_end_exclusive: date | None = None
    if body.dateEnd is not None:
        date_end_exclusive = body.dateEnd + timedelta(days=1)

    params: dict[str, Any] = {
        "q": q_literal,
        "date_start": body.dateStart,
        "date_end_exclusive": date_end_exclusive,
        "dur_min": body.durationMinSeconds,
        "dur_max": body.durationMaxSeconds,
        "tags": list(body.tags),
        "limit": body.limit,
    }

    # The `cardinality(:tags) = 0` branch keeps the empty-tags case
    # from filtering everything out (an empty array && any array is
    # always false). Vector parameter is cast via `:q::vector` —
    # avoids any pgvector type-adapter wiring on the engine.
    sql = """
        SELECT
            s.id          AS segment_id,
            s.text        AS segment_text,
            s.start_ms    AS segment_start_ms,
            s.end_ms      AS segment_end_ms,
            s.speaker_id  AS speaker_id,
            m.id          AS meeting_id,
            m.title       AS meeting_title,
            m.started_at  AS meeting_started_at,
            (s.embedding <=> CAST(:q AS vector)) AS distance
          FROM transcript_segments s
          JOIN meetings m ON m.id = s.meeting_id
         WHERE s.embedding IS NOT NULL
           AND s.is_final = true
           AND (
             CAST(:date_start AS date) IS NULL
             OR m.started_at >= CAST(:date_start AS date)
           )
           AND (
             CAST(:date_end_exclusive AS date) IS NULL
             OR m.started_at < CAST(:date_end_exclusive AS date)
           )
           AND (
             CAST(:dur_min AS integer) IS NULL
             OR m.duration_seconds >= CAST(:dur_min AS integer)
           )
           AND (
             CAST(:dur_max AS integer) IS NULL
             OR m.duration_seconds <= CAST(:dur_max AS integer)
           )
           AND (
             cardinality(CAST(:tags AS text[])) = 0
             OR m.tags && CAST(:tags AS text[])
           )
         ORDER BY s.embedding <=> CAST(:q AS vector)
         LIMIT :limit
    """

    result = await session.execute(text(sql), params)
    items: list[SearchHit] = []
    for row in result:
        # Cosine distance is in [0, 2]. Convert to a similarity score
        # in [-1, 1] via `1 - distance`. Most retrieval scores will be
        # in [0, 1] for L2-normalised vectors.
        distance = float(row.distance) if row.distance is not None else 1.0
        items.append(
            SearchHit(
                meetingId=row.meeting_id,
                meetingTitle=row.meeting_title,
                meetingStartedAt=row.meeting_started_at,
                segmentId=row.segment_id,
                segmentText=row.segment_text,
                segmentStartMs=int(row.segment_start_ms),
                segmentEndMs=int(row.segment_end_ms),
                speakerId=row.speaker_id,
                score=1.0 - distance,
            )
        )
    log.info(
        "search.done query_len=%d hits=%d",
        len(query),
        len(items),
    )
    return SearchResponse(items=items)
