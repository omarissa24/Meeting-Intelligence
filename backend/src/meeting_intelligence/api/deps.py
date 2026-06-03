"""FastAPI dependency providers for swappable infrastructure.

Centralises the wiring between routes and the abstract interfaces in
`meeting_intelligence.interfaces`. Tests override these via
`app.dependency_overrides[...]`; later plans swap real provider impls
(e.g. S3, WorkOS) in the same place without touching routes.
"""

from __future__ import annotations

import secrets
import tempfile
from functools import lru_cache
from pathlib import Path

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider
from meeting_intelligence.config import Settings, get_settings
from meeting_intelligence.interfaces.auth import AuthProvider
from meeting_intelligence.interfaces.storage import ObjectStorageProvider
from meeting_intelligence.interfaces.stt import STTProvider
from meeting_intelligence.storage import LocalDiskObjectStorage, S3ObjectStorage
from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT


@lru_cache(maxsize=1)
def _build_provider() -> STTProvider:
    """Construct the STT provider once per process based on settings.

    Tests that need to reset between cases can clear the cache via
    `_build_provider.cache_clear()`.
    """
    settings = get_settings()
    if settings.stt_provider == "deepgram":
        if not settings.deepgram_api_key:
            raise RuntimeError(
                "STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY to be set"
            )
        return DeepgramNovaSTT(api_key=settings.deepgram_api_key)
    return InMemoryEchoSTT()


def get_stt_provider() -> STTProvider:
    return _build_provider()


# --- Auth provider --------------------------------------------------------


@lru_cache(maxsize=1)
def _build_auth_provider() -> AuthProvider:
    """One verifier per process; tests clear the cache or override the dep."""
    return WorkOSAuthProvider(get_settings())


def get_auth_provider() -> AuthProvider:
    return _build_auth_provider()


# --- Object storage -------------------------------------------------------


def _build_object_storage(settings: Settings) -> ObjectStorageProvider:
    if settings.object_storage_backend == "s3":
        if not settings.s3_bucket:
            raise RuntimeError(
                "OBJECT_STORAGE_BACKEND=s3 requires S3_BUCKET to be set"
            )
        return S3ObjectStorage(
            bucket=settings.s3_bucket,
            endpoint_url=settings.s3_endpoint_url,
            region=settings.s3_region,
            access_key_id=settings.s3_access_key_id,
            secret_access_key=settings.s3_secret_access_key,
        )
    # Local disk fallback. Settings auto-fill the signing key (process-
    # scoped random) and root (system temp dir) when unset.
    if not settings.local_storage_signing_key:
        settings.local_storage_signing_key = secrets.token_urlsafe(32)
    root = settings.local_object_storage_root or str(
        Path(tempfile.gettempdir()) / "meeting-intelligence-objects"
    )
    base_url = "http://localhost:8000/storage/local"
    return LocalDiskObjectStorage(
        root=root,
        signing_key=settings.local_storage_signing_key,
        base_url=base_url,
    )


@lru_cache(maxsize=1)
def _cached_object_storage() -> ObjectStorageProvider:
    return _build_object_storage(get_settings())


def get_object_storage() -> ObjectStorageProvider:
    return _cached_object_storage()


# --- Database wiring ---
#
# The engine lives on `app.state` so its lifetime tracks the FastAPI
# lifespan rather than process startup. Resist the temptation to
# `lru_cache` — engines hold connection pools that won't survive
# `pytest-postgresql`'s per-test database, and lifespan-scoped state
# is the unambiguous contract for shutdown.


def get_db_engine(request: Request) -> AsyncEngine:
    """Return the request's `AsyncEngine`.

    Raises if the engine is unavailable (e.g. `DATABASE_URL` not set
    in the running process). Routes that depend on this should be
    deployed only when the DB is configured.
    """
    engine: AsyncEngine | None = getattr(request.app.state, "db_engine", None)
    if engine is None:
        raise RuntimeError("DB not configured: DATABASE_URL is unset")
    return engine


def get_session_factory(
    request: Request,
) -> async_sessionmaker[AsyncSession]:
    """Return the request's session factory built off the lifespan engine."""
    factory: async_sessionmaker[AsyncSession] | None = getattr(
        request.app.state, "db_session_factory", None
    )
    if factory is None:
        raise RuntimeError("DB not configured: DATABASE_URL is unset")
    return factory
