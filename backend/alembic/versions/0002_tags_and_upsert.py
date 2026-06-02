"""phase2 step 2: meetings.tags + auth.upsert_user (SECURITY DEFINER)

Revision ID: 0002_tags_and_upsert
Revises: 0001_phase2_foundation
Create Date: 2026-06-02 00:00:00.000000

Two changes:

1. `meetings.tags` — `text[] not null default '{}'`. Phase 2 / FR-2.10
   stores meeting tags inline; tag *search* lives in Phase 4.

2. `auth.upsert_user` — a `SECURITY DEFINER` function that finds-or-
   creates a `users` row by `workos_user_id` and returns the id +
   email + organization_id. Owned by the migration role (which is
   the `users` table owner), it runs with the owner's privileges and
   bypasses RLS — solving the chicken-and-egg problem at first login
   (RLS keys off `app.current_user_id`, but the requester doesn't
   know its own users.id until after the upsert).

   The function is exposed only to `app_user` and is the single place
   the application can short-circuit RLS on `users`. All other
   accesses still go through the RLS-bound request session.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_tags_and_upsert"
down_revision: str | None = "0001_phase2_foundation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. meetings.tags ---------------------------------------------------------
    op.add_column(
        "meetings",
        sa.Column(
            "tags",
            sa.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
    )

    # 2. auth.upsert_user ------------------------------------------------------
    # SECURITY DEFINER means this function runs with the privileges of the
    # role that owns it — i.e. the migration role (the table owner). FORCE
    # ROW LEVEL SECURITY otherwise applies even to owners, but functions
    # marked SECURITY DEFINER bypass it for INSERT/SELECT inside the body.
    #
    # The function returns the canonical row whether it was inserted or
    # already existed. Callers don't need to inspect a "created" flag.
    op.execute("CREATE SCHEMA IF NOT EXISTS auth")
    # The function parameters use a `_in` suffix to avoid colliding with
    # `users` column names — plpgsql resolves bare names against both
    # variables and target-table columns inside ON CONFLICT, and any
    # match raises "ambiguous column reference" at runtime.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION auth.upsert_user(
            workos_user_id_in text,
            email_in text,
            organization_id_in uuid
        )
        RETURNS TABLE (
            id uuid,
            email text,
            organization_id uuid,
            workos_user_id text
        )
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        #variable_conflict use_column
        DECLARE
            v_id uuid;
        BEGIN
            -- Resolution order: workos_user_id is the canonical identity
            -- claim. We try by it first; if it exists, return that row
            -- and ignore the supplied email. If it doesn't, fall back to
            -- email — covers the case where the email already has a row
            -- under a different (older) workos_user_id, e.g. an auth
            -- provider migration. In that case we update the
            -- workos_user_id to the current claim. Only when neither
            -- exists do we INSERT a fresh row.
            SELECT public.users.id INTO v_id
            FROM public.users
            WHERE public.users.workos_user_id = workos_user_id_in;

            IF v_id IS NULL THEN
                UPDATE public.users
                SET workos_user_id = workos_user_id_in
                WHERE public.users.email = email_in
                RETURNING public.users.id INTO v_id;
            END IF;

            IF v_id IS NULL THEN
                INSERT INTO public.users (workos_user_id, email, organization_id)
                VALUES (workos_user_id_in, email_in, organization_id_in)
                RETURNING public.users.id INTO v_id;
            END IF;

            -- Explicit casts: the users.email/workos_user_id columns are
            -- declared as varchar by SQLAlchemy's String(), and the
            -- RETURNS TABLE here uses `text`. Postgres does not coerce
            -- automatically across the function boundary.
            RETURN QUERY
            SELECT u.id,
                   u.email::text,
                   u.organization_id,
                   u.workos_user_id::text
            FROM public.users u
            WHERE u.id = v_id;
        END;
        $$;
        """
    )
    # Lock down: only `app_user` can call this. PUBLIC default would
    # otherwise let any role bypass users-RLS.
    op.execute("REVOKE ALL ON FUNCTION auth.upsert_user(text, text, uuid) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION auth.upsert_user(text, text, uuid) TO app_user")
    op.execute("GRANT USAGE ON SCHEMA auth TO app_user")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS auth.upsert_user(text, text, uuid)")
    op.execute("DROP SCHEMA IF EXISTS auth")
    op.drop_column("meetings", "tags")
