"""phase4 step 2: speaker_aliases for per-meeting speaker rename

Revision ID: 0007_speaker_aliases
Revises: 0006_phase4_search
Create Date: 2026-06-04 00:00:00.000000

US-26 (FR-4.10 / FR-4.11): users rename `Speaker 1` → `Omar` in the
meeting detail view. Aliases are scoped per meeting (no global learning
in MVP) and applied as a render-time overlay — the original
`transcript_segments.speaker_id` (the raw Deepgram `spk-N`) is left
untouched so audit / re-derivation stays possible.

One row per `(meeting_id, original_label)` pair; the UNIQUE constraint
makes a PUT replace-all body deterministic. Display name is bounded at
32 chars (mirrored in the API validator).

RLS keyed off `app.current_user_id` via the `user_id` column,
denormalised the same way `transcript_segments` and `action_items` do
it. ON DELETE CASCADE for the `meetings` FK so deleting a meeting
takes its aliases with it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0007_speaker_aliases"
down_revision: str | None = "0006_phase4_search"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "speaker_aliases",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "meeting_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meetings.id",
                ondelete="CASCADE",
                name="fk_speaker_aliases_meeting_id_meetings",
            ),
            nullable=False,
        ),
        # Denormalised so RLS can scope without a join.
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_speaker_aliases_user_id_users",
            ),
            nullable=False,
        ),
        # The raw STT label, e.g. `spk-0`. Whatever shape the provider
        # emits — we don't validate it here; the API layer accepts any
        # string the segments table can hold.
        sa.Column("original_label", sa.String(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "meeting_id",
            "original_label",
            name="uq_speaker_aliases_meeting_id_original_label",
        ),
    )
    op.create_index(
        "ix_speaker_aliases_meeting_id",
        "speaker_aliases",
        ["meeting_id"],
    )

    op.execute("ALTER TABLE speaker_aliases ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE speaker_aliases FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY speaker_aliases_owner_only ON speaker_aliases
            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON speaker_aliases TO app_user"
    )


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT, UPDATE, DELETE ON speaker_aliases FROM app_user")
    op.execute("DROP POLICY IF EXISTS speaker_aliases_owner_only ON speaker_aliases")
    op.drop_index("ix_speaker_aliases_meeting_id", table_name="speaker_aliases")
    op.drop_table("speaker_aliases")
