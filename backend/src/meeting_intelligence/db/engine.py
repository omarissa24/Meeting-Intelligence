"""Engine + session-factory builders.

Pure functions, no module-level globals. The FastAPI lifespan (in
`main.py`) is responsible for owning the lifetime of an `AsyncEngine`
and exposing it via `app.state`. Keeping these functions stateless is
what lets `pytest-postgresql`'s per-test database stand up and tear
down without leaking pool connections.
"""

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def make_engine(url: str) -> AsyncEngine:
    """Build an async SQLAlchemy engine bound to the given URL.

    The URL must use the `postgresql+psycopg` driver to match the rest
    of the stack (compose, Fly.io). `pool_pre_ping` keeps stale
    connections from blowing up the first request after a Postgres
    failover.
    """
    return create_async_engine(url, pool_pre_ping=True, future=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build a session factory bound to an engine.

    `expire_on_commit=False` so route handlers can read attributes off
    a model after `commit()` without a needless reload — the FastAPI
    request lifecycle is the natural session boundary.
    """
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
