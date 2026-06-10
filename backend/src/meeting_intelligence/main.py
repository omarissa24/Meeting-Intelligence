import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from meeting_intelligence.api.auth import router as auth_router
from meeting_intelligence.api.health import router as health_router
from meeting_intelligence.api.meetings import router as meetings_router
from meeting_intelligence.api.search import router as search_router
from meeting_intelligence.api.storage import router as storage_router
from meeting_intelligence.api.transcript import router as transcript_router
from meeting_intelligence.api.updates import router as updates_router
from meeting_intelligence.config import get_settings
from meeting_intelligence.db.engine import make_engine, make_session_factory
from meeting_intelligence.db.rls_check import assert_not_bypassing_rls

log = logging.getLogger("meeting_intelligence.main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Build the DB engine when configured, dispose on shutdown.

    With `DATABASE_URL` unset, `app.state.db_engine` and
    `db_session_factory` stay `None`. This is what keeps the existing
    test suite (none of which sets `DATABASE_URL`) green: routes that
    don't pull a DB session never trip over a missing engine.
    """
    settings = get_settings()
    app.state.db_engine = None
    app.state.db_session_factory = None

    if settings.database_url:
        engine = make_engine(settings.database_url)
        # Hard-block before publishing the engine: if the connection role
        # would bypass RLS, every subsequent request would silently serve
        # cross-user data. Disposing the engine on failure keeps the pool
        # from leaking.
        try:
            await assert_not_bypassing_rls(engine)
        except Exception:
            await engine.dispose()
            raise
        app.state.db_engine = engine
        app.state.db_session_factory = make_session_factory(engine)
        log.info("db.engine_attached url_scheme=%s", settings.database_url.split(":", 1)[0])
    else:
        log.info("db.engine_skipped reason=database_url_unset")

    try:
        yield
    finally:
        engine = app.state.db_engine
        if engine is not None:
            await engine.dispose()
            log.info("db.engine_disposed")


def create_app() -> FastAPI:
    settings = get_settings()
    # Configure logging once at app construction. uvicorn installs its own
    # handlers on its loggers (uvicorn, uvicorn.access, uvicorn.error), so
    # this only governs application loggers under `meeting_intelligence.*`.
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    app = FastAPI(
        title="Meeting Intelligence",
        version="0.0.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(meetings_router)
    app.include_router(search_router)
    app.include_router(transcript_router)
    app.include_router(storage_router)
    app.include_router(updates_router)
    return app


app = create_app()
