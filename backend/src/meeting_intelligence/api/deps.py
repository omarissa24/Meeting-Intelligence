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
from meeting_intelligence.embedding import (
    InMemoryFakeEmbeddingProvider,
    OpenAIEmbeddingProvider,
)
from meeting_intelligence.interfaces.auth import AuthProvider
from meeting_intelligence.interfaces.embedding import EmbeddingProvider
from meeting_intelligence.interfaces.llm import LLMProvider
from meeting_intelligence.interfaces.storage import ObjectStorageProvider
from meeting_intelligence.interfaces.stt import STTProvider
from meeting_intelligence.llm import AnthropicClaudeLLM, InMemoryFakeLLM
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


# --- LLM provider ---------------------------------------------------------


@lru_cache(maxsize=1)
def _build_llm_provider() -> LLMProvider:
    """Construct the LLM provider once per process based on settings.

    Default is `fake` so dev/CI work without an API key. Production
    flips `LLM_PROVIDER=anthropic` and supplies `ANTHROPIC_API_KEY`.
    Tests that need to reset between cases can clear the cache via
    `_build_llm_provider.cache_clear()`.
    """
    settings = get_settings()
    if settings.llm_provider == "anthropic":
        if not settings.anthropic_api_key:
            raise RuntimeError(
                "LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set"
            )
        return AnthropicClaudeLLM(
            api_key=settings.anthropic_api_key,
            model=settings.anthropic_model,
        )
    return InMemoryFakeLLM()


def get_llm_provider() -> LLMProvider:
    return _build_llm_provider()


# --- Embedding provider (Phase 4 semantic search) -------------------------


@lru_cache(maxsize=1)
def _build_embedding_provider() -> EmbeddingProvider:
    """Construct the embedding provider once per process based on settings.

    Default is `fake` so dev/CI work without an API key. Production
    flips `EMBEDDING_PROVIDER=openai` and supplies `OPENAI_API_KEY`.
    Tests that need to reset between cases can clear the cache via
    `_build_embedding_provider.cache_clear()`.
    """
    settings = get_settings()
    if settings.embedding_provider == "openai":
        if not settings.openai_api_key:
            raise RuntimeError(
                "EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY to be set"
            )
        return OpenAIEmbeddingProvider(
            api_key=settings.openai_api_key,
            model=settings.embedding_model,
        )
    return InMemoryFakeEmbeddingProvider()


def get_embedding_provider() -> EmbeddingProvider:
    return _build_embedding_provider()


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
    # Local disk fallback. Settings auto-fill the signing key and root
    # when unset. The key is persisted to a sibling file under the
    # storage root so URLs minted in one process still verify after a
    # restart (otherwise React Query's cached audioUrl 403s on the
    # very next launch).
    root = Path(_resolve_local_root(settings))
    signing_key = ensure_local_signing_key(settings, root)
    base_url = "http://localhost:8000/storage/local"
    return LocalDiskObjectStorage(
        root=str(root),
        signing_key=signing_key,
        base_url=base_url,
    )


def _resolve_local_root(settings: Settings) -> str:
    return settings.local_object_storage_root or str(
        Path(tempfile.gettempdir()) / "meeting-intelligence-objects"
    )


def ensure_local_signing_key(settings: Settings, root: Path) -> str:
    """Populate `settings.local_storage_signing_key` if empty.

    Reuses a previously persisted dev key under `<root>/.signing-key`
    when present; otherwise generates one and writes it. Production
    deployments configure the key via env and never hit this helper
    (they also use `OBJECT_STORAGE_BACKEND=s3`).

    Safe to call from any callsite that needs the key — both the
    storage factory and the dev download route call into this so
    request order doesn't matter.
    """
    if settings.local_storage_signing_key:
        return settings.local_storage_signing_key

    root.mkdir(parents=True, exist_ok=True)
    key_path = root / ".signing-key"
    if key_path.exists():
        existing = key_path.read_text().strip()
        if existing:
            settings.local_storage_signing_key = existing
            return existing

    fresh = secrets.token_urlsafe(32)
    # Best-effort persistence; if the disk is read-only we still set
    # the in-memory key so the current process works (URLs just won't
    # survive a restart in that pathological case).
    try:
        tmp = key_path.with_suffix(".signing-key.tmp")
        tmp.write_text(fresh)
        tmp.replace(key_path)
        try:
            key_path.chmod(0o600)
        except OSError:
            pass
    except OSError:
        pass
    settings.local_storage_signing_key = fresh
    return fresh


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
