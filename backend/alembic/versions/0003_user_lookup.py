"""phase2 step 3: auth.lookup_user_by_workos_id (SECURITY DEFINER)

Revision ID: 0003_user_lookup
Revises: 0002_tags_and_upsert
Create Date: 2026-06-03 00:00:00.000000

WorkOS AuthKit access tokens carry only `sub` (= workos_user_id) and
do NOT include `email`. The `users` row is provisioned via
`auth.upsert_user` at `/auth/callback` time (where the WorkOS SDK
gives us `result.user.email`); subsequent authed requests need a
SELECT-by-workos_user_id under RLS-bypass to identify the caller
before `app.current_user_id` is bound.

This migration adds a thin SECURITY DEFINER lookup. It does NOT
write — pure read — and is grant-locked to `app_user`. The query is
parameterised on the verified JWT's `sub` claim, so an attacker
without a valid signed token can't reach it.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0003_user_lookup"
down_revision: str | None = "0002_tags_and_upsert"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION auth.lookup_user_by_workos_id(
            workos_user_id_in text
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
        BEGIN
            RETURN QUERY
            SELECT u.id,
                   u.email::text,
                   u.organization_id,
                   u.workos_user_id::text
            FROM public.users u
            WHERE u.workos_user_id = workos_user_id_in;
        END;
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION auth.lookup_user_by_workos_id(text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION auth.lookup_user_by_workos_id(text) TO app_user"
    )


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS auth.lookup_user_by_workos_id(text)"
    )
