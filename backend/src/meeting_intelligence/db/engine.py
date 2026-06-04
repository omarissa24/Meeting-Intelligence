"""Engine + session-factory builders.

Pure functions, no module-level globals. The FastAPI lifespan (in
`main.py`) is responsible for owning the lifetime of an `AsyncEngine`
and exposing it via `app.state`. Keeping these functions stateless is
what lets `pytest-postgresql`'s per-test database stand up and tear
down without leaking pool connections.

Phase 4 note on pgvector binding: we do NOT register pgvector's
psycopg type adapter here. Async psycopg makes the registration path
awkward (the adapter is a coroutine, but the SQLAlchemy `connect`
event fires synchronously). Instead, every place that sends a vector
as a bind parameter formats it as a Postgres array literal string and
uses the SQL `CAST(:q AS vector)` spelling — Postgres's `::` cast
shorthand collides with SQLAlchemy's `:name` parameter delimiter, so
we always spell it with `CAST(...)`. `format_vector_literal()` below
is the canonical formatter — search and embed-task code both call it.
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


def format_vector_literal(values: list[float]) -> str:
    """Render a float vector as a Postgres `vector` literal string.

    pgvector accepts the bracket-and-comma form, e.g. `[0.1,0.2,0.3]`.
    Bind via a parameter cast in the SQL: `:q::vector` or
    `:q::vector(1536)`. Keeping this helper in one place means the
    rendering rules (no spaces, no scientific-notation gotchas) live
    in one tested function instead of being inlined at every call
    site.
    """
    # repr() on a float yields a Python literal that round-trips
    # safely; Postgres accepts the same form. Avoid f-string %g
    # formatting — it loses precision past ~6 digits.
    return "[" + ",".join(repr(v) for v in values) + "]"


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build a session factory bound to an engine.

    `expire_on_commit=False` so route handlers can read attributes off
    a model after `commit()` without a needless reload — the FastAPI
    request lifecycle is the natural session boundary.
    """
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
