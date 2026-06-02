"""Test fixtures for DB-touching tests.

The DB fixtures require a real, running Postgres (RLS is a Postgres
feature; SQLite cannot fake it). Set `TEST_DATABASE_URL` to point at
an admin URL — typically the compose service:

    TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/postgres

If it's unset, the fixtures `pytest.skip` cleanly so the rest of the
suite continues to run on machines without Postgres available.

Each test session creates an ephemeral database and exposes two engines:

  - `db_engine` (admin) — connects as the admin role; RLS is bypassed
    here because the admin is also the table owner. Use it for schema
    introspection (pg_class, pg_policies) only.
  - `db_session_factory` (app) — connects as `app_user`, the
    non-superuser role created by the migration. RLS policies apply.
    Use this for cross-user isolation tests.

`app_user` is created NOLOGIN by the migration; the fixture grants LOGIN
+ a per-session password and revokes it on teardown so the migration
itself stays deployment-clean.
"""

from __future__ import annotations

import os
import secrets
import subprocess
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def _admin_url() -> str | None:
    """The admin URL — used to CREATE/DROP per-session test databases.

    Must point at an existing database the role can connect to. The
    test suite then carves out a fresh DB whose name we pick.
    """
    return os.environ.get("TEST_DATABASE_URL")


def _split_url(url: str) -> tuple[str, str]:
    """Return `(prefix, dbname)` so we can swap the trailing DB name."""
    head, _, dbname = url.rpartition("/")
    return head, dbname


@pytest.fixture(scope="session")
def db_urls() -> tuple[str, str]:
    """Yield `(admin_url, app_url)` for the ephemeral test database.

    `admin_url` connects as the migration owner. `app_url` connects
    as `app_user`, the non-superuser role RLS policies actually
    apply to.
    """
    admin = _admin_url()
    if not admin:
        pytest.skip("TEST_DATABASE_URL not set; skipping DB-backed tests")

    head, _ = _split_url(admin)
    test_db = f"mi_test_{secrets.token_hex(8)}"

    sync_admin_default_db = admin.replace("postgresql+psycopg://", "postgresql://", 1)

    import psycopg

    # Create the per-session DB.
    with psycopg.connect(sync_admin_default_db, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{test_db}"')

    admin_url = f"{head}/{test_db}"

    # Apply the schema by running alembic against the fresh DB.
    repo_backend = Path(__file__).resolve().parent.parent
    env = os.environ.copy()
    env["DATABASE_URL"] = admin_url
    subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        cwd=str(repo_backend),
        env=env,
        check=True,
    )

    # Promote `app_user` to a login role for the test session. This is
    # test-only — production grants LOGIN out-of-band so the migration
    # itself stays deployment-environment-agnostic.
    app_password = secrets.token_hex(16)
    sync_admin_test_db = admin_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(sync_admin_test_db, autocommit=True) as conn:
        conn.execute(f"ALTER ROLE app_user LOGIN PASSWORD '{app_password}'")
        conn.execute(f"GRANT CONNECT ON DATABASE \"{test_db}\" TO app_user")
        conn.execute("GRANT USAGE ON SCHEMA public TO app_user")
        conn.execute("GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user")
        conn.execute(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
            "GRANT USAGE, SELECT ON SEQUENCES TO app_user"
        )

    host_and_port = head.split("@", 1)[1]
    app_url = f"postgresql+psycopg://app_user:{app_password}@{host_and_port}/{test_db}"

    try:
        yield admin_url, app_url
    finally:
        # Tear down: revoke LOGIN, kill connections, drop the DB.
        with psycopg.connect(sync_admin_default_db, autocommit=True) as conn:
            conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (test_db,),
            )
            conn.execute(f'DROP DATABASE IF EXISTS "{test_db}"')
            # ALTER ROLE NOLOGIN keeps the role around for any next session
            # while disabling auth — safer than DROP ROLE, which could fail
            # if other test runs are racing.
            conn.execute("ALTER ROLE app_user NOLOGIN")


@pytest_asyncio.fixture
async def db_engine(db_urls: tuple[str, str]) -> AsyncIterator[AsyncEngine]:
    """Admin engine — bypasses RLS; for schema introspection only."""
    admin_url, _ = db_urls
    engine = create_async_engine(admin_url, future=True)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def db_session_factory(
    db_urls: tuple[str, str],
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """App-user session factory — RLS policies apply."""
    _, app_url = db_urls
    engine = create_async_engine(app_url, future=True)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        await engine.dispose()
