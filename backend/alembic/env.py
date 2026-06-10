"""Alembic environment — async-aware, reads DATABASE_URL from settings.

Imports `db.models` for its side effect (registering tables on
`Base.metadata`) so autogen and migrations see the full schema.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from meeting_intelligence.config import get_settings
from meeting_intelligence.db import Base
from meeting_intelligence.db import models as _models  # noqa: F401  (registers tables)

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
# Prefer MIGRATION_DATABASE_URL when set: migrations need the owner role
# (DDL, CREATE EXTENSION, GRANT), while the running app connects as the
# least-privilege app_user via DATABASE_URL. Falls back to DATABASE_URL
# in dev/compose where one role does both.
db_url = settings.migration_database_url or settings.database_url
if not db_url:
    raise RuntimeError(
        "DATABASE_URL (or MIGRATION_DATABASE_URL) must be set to run alembic"
    )
config.set_main_option("sqlalchemy.url", db_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Configure context for an offline run (no live connection)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
