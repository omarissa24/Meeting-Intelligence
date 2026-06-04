from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from meeting_intelligence.db.base import Base


class SpeakerAlias(Base):
    """Per-meeting speaker rename (US-26 / FR-4.10).

    A render-time overlay: the desktop applies the alias when chipping
    a transcript segment, but `transcript_segments.speaker_id` is left
    untouched so the original Deepgram label is auditable. Scoped per
    meeting — no global learning in MVP. One row per
    `(meeting_id, original_label)` pair; PUT
    /meetings/:id/speaker_aliases is replace-all.
    """

    __tablename__ = "speaker_aliases"

    id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Denormalised so the RLS policy can match without a join.
    user_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    original_label: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "meeting_id",
            "original_label",
            name="uq_speaker_aliases_meeting_id_original_label",
        ),
        Index("ix_speaker_aliases_meeting_id", "meeting_id"),
    )
