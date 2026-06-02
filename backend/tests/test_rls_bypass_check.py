"""Startup guard: backend must refuse to run as a role that bypasses RLS.

Two cases:
  - Negative: connecting as the migration owner (postgres / superuser)
    raises RLSBypassError. This is what would have caught the smoke
    failure that prompted this work.
  - Positive: connecting as `app_user` (the conftest's app role)
    returns cleanly.

Skips without `TEST_DATABASE_URL`, same pattern as the rest of the
DB-backed suite.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from meeting_intelligence.db.rls_check import (
    RLSBypassError,
    assert_not_bypassing_rls,
)


@pytest.mark.asyncio
async def test_admin_role_is_rejected(db_engine: AsyncEngine) -> None:
    """The admin engine connects as the migration owner — a superuser.

    Postgres bypasses RLS for any role with rolsuper or rolbypassrls
    set, regardless of FORCE ROW LEVEL SECURITY. The check has to fire.
    """
    with pytest.raises(RLSBypassError) as excinfo:
        await assert_not_bypassing_rls(db_engine)

    msg = str(excinfo.value)
    # Message should name the role and at least one offending flag,
    # plus point at the docs so the dev knows where to read next.
    assert "rolsuper" in msg or "rolbypassrls" in msg
    assert "infra/README.md" in msg


@pytest.mark.asyncio
async def test_app_user_passes(db_urls: tuple[str, str]) -> None:
    """`app_user` is the non-privileged role the migration creates.

    It has neither rolsuper nor rolbypassrls; the guard must let it
    through silently.
    """
    _, app_url = db_urls
    engine = create_async_engine(app_url, future=True)
    try:
        await assert_not_bypassing_rls(engine)  # must not raise
    finally:
        await engine.dispose()
