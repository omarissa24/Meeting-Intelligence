"""production hardening: durable dead-letter table for Celery tasks

Revision ID: 0008_dead_letter_tasks
Revises: 0007_speaker_aliases
Create Date: 2026-06-10 00:00:00.000000

Phase 2 DoD line 160 requires failed tasks to "retry up to 3 times
before dead-lettering". Retries were already enforced per-task; the
dead-letter half was only a log line. This table makes it durable: the
worker inserts a row when `MaxRetriesExceededError` fires, so failed
work is inspectable (and replayable by an operator) after log rotation.

Deliberately **no RLS**: this is an operator-facing ops table, written
only by the worker and read via ops SQL — it backs no user-scoped API
surface. (RLS here would also fight the worker, which inserts while the
`app.current_user_id` GUC may be unset mid-failure.) `args`/`kwargs` are
JSONB snapshots of the Celery payload for replay.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0008_dead_letter_tasks"
down_revision: str | None = "0007_speaker_aliases"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dead_letter_tasks",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # Fully-qualified Celery task name, e.g.
        # `meeting_intelligence.worker.tasks.audio_archive.archive_meeting_audio`.
        sa.Column("task_name", sa.Text(), nullable=False),
        # Celery task id (request id) — nullable because eager-mode test
        # runs don't always carry one.
        sa.Column("task_id", sa.Text(), nullable=True),
        sa.Column("args", JSONB(), nullable=True),
        sa.Column("kwargs", JSONB(), nullable=True),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_dead_letter_tasks_created_at",
        "dead_letter_tasks",
        ["created_at"],
    )

    # Worker connects as app_user; it only ever inserts. Reads are ops
    # SQL with whatever role the operator holds.
    op.execute("GRANT SELECT, INSERT ON dead_letter_tasks TO app_user")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT ON dead_letter_tasks FROM app_user")
    op.drop_index("ix_dead_letter_tasks_created_at", table_name="dead_letter_tasks")
    op.drop_table("dead_letter_tasks")
