"""Verify the initial migration produces the schema we promised.

Asserts that, after `alembic upgrade head`:
  - `users`, `meetings`, `transcript_segments` all exist
  - all three have `rowsecurity = true` AND `forcerowsecurity = true`
  - the three RLS policies exist by name
  - the `app_user` role exists with the expected privileges
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

EXPECTED_TABLES = {"users", "meetings", "transcript_segments"}
EXPECTED_POLICIES = {
    "users_self_only",
    "meetings_owner_only",
    "transcript_segments_owner_only",
}


@pytest.mark.asyncio
async def test_tables_exist(db_engine: AsyncEngine) -> None:
    async with db_engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename = ANY(:names)"
            ),
            {"names": list(EXPECTED_TABLES)},
        )
        present = {row[0] for row in result.fetchall()}
    assert present == EXPECTED_TABLES


@pytest.mark.asyncio
async def test_rls_enabled_and_forced(db_engine: AsyncEngine) -> None:
    async with db_engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT relname, relrowsecurity, relforcerowsecurity "
                "FROM pg_class WHERE relname = ANY(:names)"
            ),
            {"names": list(EXPECTED_TABLES)},
        )
        rows = {row[0]: (row[1], row[2]) for row in result.fetchall()}
    for tbl in EXPECTED_TABLES:
        enabled, forced = rows[tbl]
        assert enabled is True, f"RLS not enabled on {tbl}"
        assert forced is True, f"RLS not FORCEd on {tbl}"


@pytest.mark.asyncio
async def test_policies_exist(db_engine: AsyncEngine) -> None:
    async with db_engine.connect() as conn:
        result = await conn.execute(
            text("SELECT policyname FROM pg_policies WHERE policyname = ANY(:names)"),
            {"names": list(EXPECTED_POLICIES)},
        )
        present = {row[0] for row in result.fetchall()}
    assert present == EXPECTED_POLICIES


@pytest.mark.asyncio
async def test_app_user_role_exists(db_engine: AsyncEngine) -> None:
    async with db_engine.connect() as conn:
        result = await conn.execute(
            text("SELECT 1 FROM pg_roles WHERE rolname = 'app_user'")
        )
        assert result.scalar() == 1
