"""phase2 step 4: meetings.audio_object_key (US-11 audio archive)

Revision ID: 0004_audio_object_key
Revises: 0003_user_lookup
Create Date: 2026-06-04 00:00:00.000000

Adds a nullable `audio_object_key` column to `meetings`. When the
WS handler closes a recording, a Celery task encodes the captured
WAV to MP3, uploads it through the configured ObjectStorageProvider,
and writes the storage key here. NULL is the default — meetings
without a successfully archived audio file (still encoding,
upload failed, or audio explicitly deleted via DELETE
/meetings/:id/audio) keep this column unset.

No index needed: lookups go through `meetings.id` (PK). RLS on
`meetings` already covers reads/writes via the existing
`meetings_owner_only` policy, so this column is automatically
scoped per-user.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_audio_object_key"
down_revision: str | None = "0003_user_lookup"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meetings",
        sa.Column("audio_object_key", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("meetings", "audio_object_key")
