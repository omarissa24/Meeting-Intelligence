"""phase2 foundation: users, meetings, transcript_segments + RLS

Revision ID: 0001_phase2_foundation
Revises:
Create Date: 2026-06-02 00:00:00.000000

Birth certificate for the Phase 2 schema. Three tables + RLS policies
keyed off the `app.current_user_id` GUC. Both ENABLE and FORCE row
security so the migration role can't bypass policies in tests.

The `app_user` non-superuser role is created here but not granted
LOGIN — the deployment is responsible for `ALTER ROLE app_user LOGIN`
and setting a password (see infra/README.md). PR A keeps the migration
self-contained: it can be run by any privileged role with no further
setup, and the role exists for PR C to switch the runtime URL onto.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_phase2_foundation"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Extensions ---------------------------------------------------------------
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    # Tables -------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("workos_user_id", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column(
            "organization_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            nullable=True,
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
        sa.UniqueConstraint("workos_user_id", name="uq_users_workos_user_id"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "meetings",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE", name="fk_meetings_user_id_users"),
            nullable=False,
        ),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("speaker_count", sa.Integer(), nullable=True),
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
    op.create_index("ix_meetings_user_id", "meetings", ["user_id"])

    op.create_table(
        "transcript_segments",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "meeting_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "meetings.id",
                ondelete="CASCADE",
                name="fk_transcript_segments_meeting_id_meetings",
            ),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_transcript_segments_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column("speaker_id", sa.String(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("is_final", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_transcript_segments_meeting_id_start_ms",
        "transcript_segments",
        ["meeting_id", "start_ms"],
    )
    op.create_index(
        "ix_transcript_segments_user_id_created_at",
        "transcript_segments",
        ["user_id", "created_at"],
    )

    # Row-level security -------------------------------------------------------
    # ENABLE turns RLS on; FORCE makes it apply to the table owner too — the
    # migration role would otherwise bypass policies and tests would falsely
    # pass. Default-deny: when the GUC is unset, the cast to ::uuid fails on
    # null and PostgreSQL evaluates the policy as false.
    for tbl in ("users", "meetings", "transcript_segments"):
        op.execute(f"ALTER TABLE {tbl} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {tbl} FORCE ROW LEVEL SECURITY")

    op.execute(
        """
        CREATE POLICY users_self_only ON users
            USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )
    op.execute(
        """
        CREATE POLICY meetings_owner_only ON meetings
            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )
    op.execute(
        """
        CREATE POLICY transcript_segments_owner_only ON transcript_segments
            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        """
    )

    # Application role ---------------------------------------------------------
    # Created NOLOGIN: deployment grants LOGIN + sets the password out-of-band
    # so the migration is safe to re-run in any environment.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
                CREATE ROLE app_user NOLOGIN;
            END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON users, meetings, transcript_segments
            TO app_user
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS transcript_segments_owner_only ON transcript_segments")
    op.execute("DROP POLICY IF EXISTS meetings_owner_only ON meetings")
    op.execute("DROP POLICY IF EXISTS users_self_only ON users")
    op.execute(
        """
        REVOKE SELECT, INSERT, UPDATE, DELETE
            ON users, meetings, transcript_segments
            FROM app_user
        """
    )
    # Leave the role behind on downgrade — dropping a role that owns objects
    # in any other DB on the cluster fails noisily.

    op.drop_index("ix_transcript_segments_user_id_created_at", table_name="transcript_segments")
    op.drop_index("ix_transcript_segments_meeting_id_start_ms", table_name="transcript_segments")
    op.drop_table("transcript_segments")

    op.drop_index("ix_meetings_user_id", table_name="meetings")
    op.drop_table("meetings")

    op.drop_table("users")
