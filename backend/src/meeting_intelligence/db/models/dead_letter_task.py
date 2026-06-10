from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import DateTime, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from meeting_intelligence.db.base import Base


class DeadLetterTask(Base):
    """Durable record of a Celery task that exhausted its retries.

    Ops table (no RLS — written by the worker, read via operator SQL;
    see migration 0008). One row per `MaxRetriesExceededError`, holding
    enough of the original payload to inspect or replay the task.
    """

    __tablename__ = "dead_letter_tasks"

    id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    task_name: Mapped[str] = mapped_column(Text, nullable=False)
    task_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    args: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    kwargs: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (Index("ix_dead_letter_tasks_created_at", "created_at"),)
