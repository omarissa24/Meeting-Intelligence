"""phase3 step 1: meeting_summaries + action_items + RLS

Revision ID: 0005_phase3_summaries
Revises: 0004_audio_object_key
Create Date: 2026-06-03 00:00:00.000000

Two new tables drive the FR-3.10 / FR-3.11 LLM summarisation phase:

1. `meeting_summaries` — one row per meeting, keyed by `meeting_id`
   (PK + FK to meetings ON DELETE CASCADE). Holds the LangGraph output
   (prose summary, decisions, topics) plus pipeline-observability columns
   (model_version, input/output token counts, generated_at, regenerated_at).
   `confidence_low` flags meetings where diarisation produced fewer than
   2 distinct speakers (FR-3.09 / US-20 footnote).

2. `action_items` — independent rows, FK to meetings (CASCADE) and users
   (CASCADE for RLS scoping). Each item has description / owner /
   deadline / completed / completed_at / order_index. Order_index
   preserves the LLM's emission order across regenerates.

Both tables get RLS policies keyed off `app.current_user_id`, mirroring
the Phase 2 `meetings_owner_only` shape. We don't add an RLS bypass
function — the meeting summariser writes through `set_request_user`
just like the audio archive task does.

Down: drops indexes, policies, and tables in reverse order.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0005_phase3_summaries"
down_revision: str | None = "0004_audio_object_key"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. meeting_summaries -----------------------------------------------------
    op.create_table(
        "meeting_summaries",
        sa.Column(
            "meeting_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meetings.id",
                ondelete="CASCADE",
                name="fk_meeting_summaries_meeting_id_meetings",
            ),
            primary_key=True,
        ),
        # Denormalised so RLS can scope without a join.
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_meeting_summaries_user_id_users",
            ),
            nullable=False,
        ),
        # Status drives the desktop polling state machine and matches the
        # SummaryStatus literal in shared-types.
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default="pending",
        ),
        # Prose summary; nullable so we can park a `processing` row before
        # the LLM returns.
        sa.Column("summary", sa.Text(), nullable=True),
        # JSONB for decisions (array of strings) and topics (array of
        # `{name: str, duration_seconds: int}`). Default to empty array
        # so reads on an in-flight row never hit a NULL list.
        sa.Column(
            "decisions",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "topics",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # FR-3.09 diarisation hint: <2 distinct speaker_ids in the
        # transcript. Surfaced as a footnote in the desktop summary.
        sa.Column(
            "confidence_low",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        # Pipeline observability (DoD: log per-node tokens + duration).
        sa.Column("model_version", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        # Captures the model error / validation failure for UX surfacing
        # when status='failed'. Keep size unconstrained — Pydantic
        # validation errors can be verbose and we want the full message.
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("regenerated_at", sa.DateTime(timezone=True), nullable=True),
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
    )
    op.create_index(
        "ix_meeting_summaries_user_id",
        "meeting_summaries",
        ["user_id"],
    )

    # 2. action_items ----------------------------------------------------------
    op.create_table(
        "action_items",
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
                name="fk_action_items_meeting_id_meetings",
            ),
            nullable=False,
        ),
        # Denormalised for RLS, same pattern as transcript_segments.
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_action_items_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("owner", sa.Text(), nullable=True),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column(
            "completed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        # Preserves the LLM's emission order across regenerates so the
        # desktop list stays stable. Re-numbered on each regenerate.
        sa.Column(
            "order_index",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
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
    )
    op.create_index(
        "ix_action_items_meeting_id_order_index",
        "action_items",
        ["meeting_id", "order_index"],
    )

    # 3. RLS -------------------------------------------------------------------
    for tbl in ("meeting_summaries", "action_items"):
        op.execute(f"ALTER TABLE {tbl} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {tbl} FORCE ROW LEVEL SECURITY")

    op.execute(
        """
        CREATE POLICY meeting_summaries_owner_only ON meeting_summaries
            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )
    op.execute(
        """
        CREATE POLICY action_items_owner_only ON action_items
            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )

    # 4. App role grants -------------------------------------------------------
    op.execute(
        """
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON meeting_summaries, action_items
            TO app_user
        """
    )


def downgrade() -> None:
    op.execute(
        """
        REVOKE SELECT, INSERT, UPDATE, DELETE
            ON meeting_summaries, action_items
            FROM app_user
        """
    )
    op.execute("DROP POLICY IF EXISTS action_items_owner_only ON action_items")
    op.execute("DROP POLICY IF EXISTS meeting_summaries_owner_only ON meeting_summaries")

    op.drop_index("ix_action_items_meeting_id_order_index", table_name="action_items")
    op.drop_table("action_items")

    op.drop_index("ix_meeting_summaries_user_id", table_name="meeting_summaries")
    op.drop_table("meeting_summaries")
