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
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, desc, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from meeting_intelligence.api.deps import get_object_storage
from meeting_intelligence.auth.deps import get_current_user, get_request_session
from meeting_intelligence.config import Settings, get_settings
from meeting_intelligence.db.models.meeting import Meeting
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


class MeetingDetailDTO(MeetingDTO):
    segments: list[TranscriptSegmentDTO]


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

    base = _meeting_to_dto(meeting)
    return MeetingDetailDTO(
        **base.model_dump(),
        segments=[_segment_to_dto(s) for s in segments],
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


__all__ = ["router"]
