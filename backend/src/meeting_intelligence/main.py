from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from meeting_intelligence.api.health import router as health_router
from meeting_intelligence.api.transcript import router as transcript_router
from meeting_intelligence.config import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Meeting Intelligence",
        version="0.0.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    app.include_router(transcript_router)
    return app


app = create_app()
