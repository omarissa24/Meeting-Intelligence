"""Meeting CRUD routes.

All endpoints depend on `get_request_session`, which sets the
`app.current_user_id` GUC on the session before yielding it. RLS
policies on `meetings` and `transcript_segments` therefore filter
every query to the requester's rows automatically — there is **no**
app-level `WHERE user_id = …` and there must not be one. Cross-user
isolation is the database's contract.
"""

from __future__ import annotations

import base64
import logging
import time
from datetime import UTC, date, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, desc, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from meeting_intelligence.api.deps import get_object_storage
from meeting_intelligence.auth.deps import get_current_user, get_request_session
from meeting_intelligence.config import Settings, get_settings
from meeting_intelligence.db.models.action_item import ActionItem
from meeting_intelligence.db.models.meeting import Meeting
from meeting_intelligence.db.models.meeting_summary import MeetingSummary
from meeting_intelligence.db.models.transcript_segment import TranscriptSegment
from meeting_intelligence.db.models.user import User
from meeting_intelligence.interfaces.storage import ObjectStorageProvider

router = APIRouter(prefix="/meetings", tags=["meetings"])
log = logging.getLogger("meeting_intelligence.meetings")


MAX_TAGS = 10
MAX_TAG_LENGTH = 32
DEFAULT_PAGE_LIMIT = 25
MAX_PAGE_LIMIT = 100


# --- DTOs --------------------------------------------------------------------


class _CamelModel(BaseModel):
    model_config = {"populate_by_name": True}


class CreateMeetingRequest(_CamelModel):
    title: str | None = Field(default=None, max_length=200)
    tags: list[str] = Field(default_factory=list)


class PatchMeetingRequest(_CamelModel):
    title: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None


class MeetingDTO(_CamelModel):
    id: UUID
    title: str | None
    tags: list[str]
    status: str
    startedAt: datetime | None
    endedAt: datetime | None
    durationSeconds: int | None
    speakerCount: int | None
    # US-11: present when an MP3 archive has been uploaded. The desktop
    # surfaces a player when this is non-null; otherwise the audio is
    # still encoding (or the user deleted it via DELETE /audio).
    audioObjectKey: str | None = None


class TranscriptSegmentDTO(_CamelModel):
    id: UUID
    speakerId: str | None
    text: str
    startMs: int
    endMs: int
    isFinal: bool


class TopicDTO(_CamelModel):
    name: str
    durationSeconds: int


class ActionItemDTO(_CamelModel):
    id: UUID
    description: str
    owner: str | None
    deadline: date | None
    completed: bool
    completedAt: datetime | None
    orderIndex: int


class SummaryDTO(_CamelModel):
    """Phase-3 structured summary (FR-3.06).

    `decisions` is a flat list of strings. `topics` is a list of
    `{name, durationSeconds}`. `actionItems` lives in its own DTO
    list because it's editable independently via PATCH /action_items.

    `status` mirrors the SummaryStatus literal in shared-types:
    pending | processing | completed | failed | too_short.
    """

    status: str
    summary: str | None
    decisions: list[str]
    topics: list[TopicDTO]
    actionItems: list[ActionItemDTO]
    confidenceLow: bool
    modelVersion: str | None
    inputTokens: int | None
    outputTokens: int | None
    error: str | None
    generatedAt: datetime | None
    regeneratedAt: datetime | None


class MeetingDetailDTO(MeetingDTO):
    segments: list[TranscriptSegmentDTO]
    # Null while the row hasn't been written yet (mid-recording or
    # immediately post-stop before the Celery task starts). Once the
    # task upserts, the row exists with status='processing' or later.
    summary: SummaryDTO | None = None
    summaryStatus: str = "pending"


class PatchActionItemRequest(_CamelModel):
    """Partial-update body for PATCH /meetings/:id/action_items/:item_id.

    Every field is optional — clients send only what changed. None
    means "don't touch"; explicit null on owner/deadline means "clear
    it". Pydantic can't disambiguate those two for the same field, so
    the route's logic uses `model_fields_set` to detect intent.
    """

    description: str | None = None
    owner: str | None = None
    deadline: date | None = None
    completed: bool | None = None


class MeetingListResponse(_CamelModel):
    items: list[MeetingDTO]
    nextCursor: str | None = None


class MeetingAudioResponse(_CamelModel):
    """Pre-signed URL for an archived meeting's audio.

    The desktop fetches this once and feeds the URL into an `<audio>`
    element. URL TTL is bounded by `audio_presigned_url_ttl_seconds`
    (FR-2.07: 1 hour max) — `expiresAt` is the wall-clock UTC moment
    when the URL stops working.
    """

    audioUrl: str
    expiresAt: datetime


# --- helpers -----------------------------------------------------------------


def _validate_tags(tags: list[str]) -> list[str]:
    if len(tags) > MAX_TAGS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"max {MAX_TAGS} tags",
        )
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in tags:
        if not isinstance(raw, str):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="tags must be strings"
            )
        t = raw.strip()
        if not t:
            continue
        if len(t) > MAX_TAG_LENGTH:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"tag exceeds {MAX_TAG_LENGTH} chars",
            )
        if t in seen:
            continue
        seen.add(t)
        cleaned.append(t)
    return cleaned


def _action_item_to_dto(item: ActionItem) -> ActionItemDTO:
    return ActionItemDTO(
        id=item.id,
        description=item.description,
        owner=item.owner,
        deadline=item.deadline,
        completed=item.completed,
        completedAt=item.completed_at,
        orderIndex=item.order_index,
    )


def _topic_to_dto(raw: dict[str, object]) -> TopicDTO:
    """Map a JSONB topic blob into TopicDTO.

    Forgiving on field names: the Celery task writes `duration_seconds`
    but defensive readers also accept `durationSeconds` so this DTO
    survives a future producer change.
    """
    name = str(raw.get("name", ""))
    dur = raw.get("duration_seconds")
    if dur is None:
        dur = raw.get("durationSeconds", 0)
    try:
        dur_int = int(dur)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        dur_int = 0
    return TopicDTO(name=name, durationSeconds=dur_int)


def _summary_to_dto(
    summary: MeetingSummary | None, items: list[ActionItem]
) -> SummaryDTO | None:
    if summary is None:
        return None
    decisions: list[str] = list(summary.decisions or [])
    topics_raw: list[dict[str, object]] = list(summary.topics or [])
    return SummaryDTO(
        status=summary.status,
        summary=summary.summary,
        decisions=decisions,
        topics=[_topic_to_dto(t) for t in topics_raw],
        actionItems=[_action_item_to_dto(i) for i in items],
        confidenceLow=summary.confidence_low,
        modelVersion=summary.model_version,
        inputTokens=summary.input_tokens,
        outputTokens=summary.output_tokens,
        error=summary.error,
        generatedAt=summary.generated_at,
        regeneratedAt=summary.regenerated_at,
    )


def _meeting_to_dto(m: Meeting) -> MeetingDTO:
    return MeetingDTO(
        id=m.id,
        title=m.title,
        tags=list(m.tags or []),
        status=m.status,
        startedAt=m.started_at,
        endedAt=m.ended_at,
        durationSeconds=m.duration_seconds,
        speakerCount=m.speaker_count,
        audioObjectKey=m.audio_object_key,
    )


def _segment_to_dto(s: TranscriptSegment) -> TranscriptSegmentDTO:
    return TranscriptSegmentDTO(
        id=s.id,
        speakerId=s.speaker_id,
        text=s.text,
        startMs=s.start_ms,
        endMs=s.end_ms,
        isFinal=s.is_final,
    )


def _encode_cursor(started_at: datetime, meeting_id: UUID) -> str:
    raw = f"{started_at.isoformat()}|{meeting_id}".encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        padding = "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(cursor + padding).decode()
        ts_part, id_part = raw.split("|", 1)
        return datetime.fromisoformat(ts_part), UUID(id_part)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"invalid cursor: {exc}"
        ) from exc


# --- Routes ------------------------------------------------------------------


@router.post("", response_model=MeetingDTO, status_code=status.HTTP_201_CREATED)
async def create_meeting(
    body: CreateMeetingRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> MeetingDTO:
    tags = _validate_tags(body.tags)
    meeting = Meeting(
        user_id=user.id,
        title=body.title,
        tags=tags,
        status="recording",
        started_at=datetime.now(UTC),
    )
    session.add(meeting)
    await session.flush()
    await session.refresh(meeting)
    log.info("meetings.created id=%s user_id=%s", meeting.id, user.id)
    return _meeting_to_dto(meeting)


@router.get("", response_model=MeetingListResponse)
async def list_meetings(
    session: Annotated[AsyncSession, Depends(get_request_session)],
    cursor: str | None = None,
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
) -> MeetingListResponse:
    """List meetings newest-first, paginated by `(started_at, id)` cursor.

    Meetings without `started_at` (theoretically only mid-create rows)
    fall to the end. The cursor is `(started_at, id)` of the last item
    of the previous page. We fetch `limit + 1` to detect "more pages
    exist" without a separate count query.
    """
    stmt = select(Meeting)

    if cursor is not None:
        cur_started, cur_id = _decode_cursor(cursor)
        # Composite cursor: rows strictly less than (started_at, id)
        # ordered DESC, DESC. tuple_(...) keeps it index-friendly when
        # we add the supporting index in a later milestone. The RHS uses
        # bindparam so the cursor values are real query parameters
        # rather than embedded SQL literals (and so mypy stops
        # complaining about datetime/UUID being non-ColumnElements).
        stmt = stmt.where(
            tuple_(Meeting.started_at, Meeting.id)
            < tuple_(
                bindparam("cur_started", cur_started),
                bindparam("cur_id", cur_id),
            )
        )

    stmt = stmt.order_by(desc(Meeting.started_at), desc(Meeting.id)).limit(limit + 1)

    rows = (await session.execute(stmt)).scalars().all()
    has_more = len(rows) > limit
    page = list(rows[:limit])

    next_cursor: str | None = None
    if has_more and page:
        last = page[-1]
        if last.started_at is not None:
            next_cursor = _encode_cursor(last.started_at, last.id)

    return MeetingListResponse(
        items=[_meeting_to_dto(m) for m in page],
        nextCursor=next_cursor,
    )


@router.get("/{meeting_id}", response_model=MeetingDetailDTO)
async def get_meeting(
    meeting_id: UUID,
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> MeetingDetailDTO:
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        # 404 (not 403) — cross-user reads return zero rows under RLS,
        # which is indistinguishable from "doesn't exist". Don't leak
        # which case it is.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")

    segments = (
        (
            await session.execute(
                select(TranscriptSegment)
                .where(TranscriptSegment.meeting_id == meeting_id)
                .where(TranscriptSegment.is_final.is_(True))
                .order_by(TranscriptSegment.start_ms.asc())
            )
        )
        .scalars()
        .all()
    )

    summary = (
        await session.execute(
            select(MeetingSummary).where(MeetingSummary.meeting_id == meeting_id)
        )
    ).scalar_one_or_none()

    action_items: list[ActionItem] = []
    if summary is not None:
        action_items = list(
            (
                await session.execute(
                    select(ActionItem)
                    .where(ActionItem.meeting_id == meeting_id)
                    .order_by(ActionItem.order_index.asc())
                )
            )
            .scalars()
            .all()
        )

    base = _meeting_to_dto(meeting)
    return MeetingDetailDTO(
        **base.model_dump(),
        segments=[_segment_to_dto(s) for s in segments],
        summary=_summary_to_dto(summary, action_items),
        summaryStatus=(summary.status if summary is not None else "pending"),
    )


@router.patch("/{meeting_id}", response_model=MeetingDTO)
async def patch_meeting(
    meeting_id: UUID,
    body: PatchMeetingRequest,
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> MeetingDTO:
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")

    changed = False
    if body.title is not None:
        meeting.title = body.title
        changed = True
    if body.tags is not None:
        meeting.tags = _validate_tags(body.tags)
        changed = True

    if changed:
        await session.flush()
        await session.refresh(meeting)
        log.info("meetings.patched id=%s", meeting.id)

    return _meeting_to_dto(meeting)


@router.get("/{meeting_id}/audio", response_model=MeetingAudioResponse)
async def get_meeting_audio(
    meeting_id: UUID,
    session: Annotated[AsyncSession, Depends(get_request_session)],
    storage: Annotated[ObjectStorageProvider, Depends(get_object_storage)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MeetingAudioResponse:
    """Return a pre-signed URL for the meeting's archived MP3.

    404 when the meeting doesn't exist *or* the audio hasn't been
    archived yet (encode in flight, or audio explicitly deleted via
    DELETE). The desktop distinguishes "still encoding" from "no
    audio" via `meetings.audioObjectKey` on the detail payload.
    """
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
    if not meeting.audio_object_key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no audio archive")

    ttl = settings.audio_presigned_url_ttl_seconds
    url = await storage.presigned_url(meeting.audio_object_key, expires_in=ttl)
    expires_at = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=ttl)
    return MeetingAudioResponse(audioUrl=url, expiresAt=expires_at)


@router.delete("/{meeting_id}/audio", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meeting_audio(
    meeting_id: UUID,
    session: Annotated[AsyncSession, Depends(get_request_session)],
    storage: Annotated[ObjectStorageProvider, Depends(get_object_storage)],
) -> None:
    """Delete the meeting's archived audio without touching the transcript.

    Idempotent: 204 even when there's no audio to delete (RLS-scoped
    so a cross-user attempt 404s cleanly via the `meeting is None`
    branch). Storage delete is best-effort — if the object is already
    gone the provider treats it as a no-op (S3 contract); if storage
    is genuinely down we surface 502.
    """
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
    if not meeting.audio_object_key:
        return None

    key = meeting.audio_object_key
    try:
        await storage.delete(key)
    except Exception as exc:  # storage provider failures are varied
        log.warning(
            "meetings.audio_delete_storage_failed id=%s key=%s err=%s",
            meeting_id,
            key,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="storage delete failed"
        ) from exc

    meeting.audio_object_key = None
    await session.flush()
    log.info("meetings.audio_deleted id=%s key=%s", meeting_id, key)
    return None


# --- Phase 3: summarisation endpoints ----------------------------------------


# Tiny in-memory rate limiter for POST /summarise (FR-3.13). Keyed on
# `meeting_id` because the cost is per-meeting (re-running summarisation
# spends Anthropic tokens). 60s window is generous enough that a user
# clicking Regenerate and then noticing they want to retry won't get
# blocked, but tight enough that a click-frenzy doesn't burn through
# tokens. Process-local: behind a load balancer this becomes per-pod
# rather than global, which is acceptable for FR-3.13 — we're guarding
# against accidents, not abuse.
_SUMMARISE_RATE_WINDOW_SECONDS = 60.0
_summarise_last_call: dict[UUID, float] = {}


def _check_summarise_rate_limit(meeting_id: UUID) -> None:
    now = time.monotonic()
    last = _summarise_last_call.get(meeting_id)
    if last is not None and now - last < _SUMMARISE_RATE_WINDOW_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="summarise rate-limited; try again shortly",
        )
    _summarise_last_call[meeting_id] = now


@router.post(
    "/{meeting_id}/summarise",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MeetingDetailDTO,
)
async def summarise_meeting_route(
    meeting_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> MeetingDetailDTO:
    """Trigger (re-)summarisation for a meeting.

    Sets the meeting_summaries row to status='processing' synchronously
    so the desktop poller sees the transition immediately, then
    dispatches the Celery task. Best-effort dispatch — if the broker is
    unreachable the row stays at 'processing' and the task will be
    re-attempted on next worker startup. We DON'T 500 the API call over
    a broker hiccup; the row state is the source of truth.

    Rate-limited per meeting (FR-3.13 implicit guard against
    over-spending Anthropic tokens).
    """
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
        )

    _check_summarise_rate_limit(meeting_id)

    # Park 'processing' status so the desktop sees it now, not after
    # the Celery task starts.
    existing = (
        await session.execute(
            select(MeetingSummary).where(MeetingSummary.meeting_id == meeting_id)
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = MeetingSummary(
            meeting_id=meeting_id,
            user_id=user.id,
            status="processing",
        )
        session.add(existing)
    else:
        existing.status = "processing"
        existing.error = None
    await session.flush()

    try:
        from meeting_intelligence.worker.tasks.summarise import (
            summarise_meeting as summarise_task,
        )

        summarise_task.delay(
            meeting_id=str(meeting_id),
            user_id=str(user.id),
        )
    except Exception as exc:
        log.warning(
            "meetings.summarise_dispatch_failed id=%s err=%s", meeting_id, exc
        )

    # Return the same shape as GET /meetings/:id so the client can
    # update its cache atomically.
    return await get_meeting(meeting_id=meeting_id, session=session)


@router.patch(
    "/{meeting_id}/action_items/{item_id}",
    response_model=ActionItemDTO,
)
async def patch_action_item(
    meeting_id: UUID,
    item_id: UUID,
    body: PatchActionItemRequest,
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> ActionItemDTO:
    """Update one action item.

    Body is partial: only `model_fields_set` keys are written. The
    `completed_at` derived column is set on transition to True and
    cleared on transition to False. Cross-user attempts 404 via RLS.
    """
    item = (
        await session.execute(
            select(ActionItem)
            .where(ActionItem.id == item_id)
            .where(ActionItem.meeting_id == meeting_id)
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="action item not found"
        )

    fields = body.model_fields_set
    if "description" in fields:
        if not body.description or not body.description.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="description must not be empty",
            )
        item.description = body.description.strip()
    if "owner" in fields:
        # explicit None clears the owner; explicit string sets it.
        item.owner = body.owner.strip() if isinstance(body.owner, str) else None
        if item.owner == "":
            item.owner = None
    if "deadline" in fields:
        item.deadline = body.deadline
    if "completed" in fields and body.completed is not None:
        previous = item.completed
        item.completed = body.completed
        if body.completed and not previous:
            item.completed_at = datetime.now(UTC)
        elif not body.completed and previous:
            item.completed_at = None

    await session.flush()
    await session.refresh(item)
    log.info("meetings.action_item_patched id=%s meeting_id=%s", item.id, meeting_id)
    return _action_item_to_dto(item)


@router.get("/{meeting_id}/export")
async def export_meeting(
    meeting_id: UUID,
    session: Annotated[AsyncSession, Depends(get_request_session)],
) -> Response:
    """Plain-text export of a meeting summary (US-19 / FR-3.14).

    Returns 404 when the meeting doesn't exist OR the summary hasn't
    completed yet — exporting a 'processing' row would surface garbage
    to whatever the user pastes the result into.
    """
    meeting = (
        await session.execute(select(Meeting).where(Meeting.id == meeting_id))
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
        )

    summary = (
        await session.execute(
            select(MeetingSummary).where(MeetingSummary.meeting_id == meeting_id)
        )
    ).scalar_one_or_none()
    if summary is None or summary.status not in ("completed", "too_short"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no summary available to export",
        )

    items: list[ActionItem] = list(
        (
            await session.execute(
                select(ActionItem)
                .where(ActionItem.meeting_id == meeting_id)
                .order_by(ActionItem.order_index.asc())
            )
        )
        .scalars()
        .all()
    )

    body = _format_export(meeting, summary, items)
    return Response(content=body, media_type="text/plain; charset=utf-8")


def _format_export(
    meeting: Meeting, summary: MeetingSummary, items: list[ActionItem]
) -> str:
    """Render the plain-text export body.

    Section ordering matches the desktop UI so users get a consistent
    layout whether they read the summary in-app or paste the export
    into another tool.
    """
    title = meeting.title or "Untitled meeting"
    started = meeting.started_at
    date_line = (
        started.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
        if started is not None
        else "(no date)"
    )

    lines: list[str] = [title, date_line, ""]

    if summary.status == "too_short":
        lines.append("Recording too short to summarise.")
        return "\n".join(lines) + "\n"

    lines.append("SUMMARY")
    lines.append(summary.summary or "(no summary)")
    lines.append("")

    lines.append("DECISIONS")
    decisions: list[str] = list(summary.decisions or [])
    if not decisions:
        lines.append("No decisions recorded.")
    else:
        for d in decisions:
            lines.append(f"- {d}")
    lines.append("")

    lines.append("ACTION ITEMS")
    if not items:
        lines.append("No action items recorded.")
    else:
        for item in items:
            check = "[x]" if item.completed else "[ ]"
            owner = item.owner or "Unassigned"
            deadline = (
                item.deadline.isoformat() if item.deadline is not None else "No deadline"
            )
            lines.append(f"{check} {item.description} - {owner} - {deadline}")
    lines.append("")

    lines.append("TOPICS")
    topics: list[dict[str, object]] = list(summary.topics or [])
    if not topics:
        lines.append("No topics recorded.")
    else:
        for t in topics:
            name = str(t.get("name", ""))
            raw_dur = t.get("duration_seconds")
            if raw_dur is None:
                raw_dur = t.get("durationSeconds")
            if raw_dur is None:
                raw_dur = 0
            try:
                dur_int = int(raw_dur)  # type: ignore[call-overload]
            except (TypeError, ValueError):
                dur_int = 0
            mins = max(dur_int // 60, 0)
            secs = dur_int % 60
            duration_label = f"{mins}m {secs:02d}s" if mins else f"{secs}s"
            lines.append(f"- {name} ({duration_label})")

    return "\n".join(lines) + "\n"


__all__ = ["router"]
