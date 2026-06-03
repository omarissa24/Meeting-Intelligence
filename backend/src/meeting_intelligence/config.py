"""Application settings.

Loaded from environment / `.env`. All fields are optional at scaffold time —
each phase tightens its required subset as it wires real integrations.
"""

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Service
    # `environment` gates dev-only surfaces (e.g. POST /auth/dev-token).
    # Anything not "production" exposes them; "production" hard-404s.
    environment: Literal["development", "staging", "production"] = "development"
    cors_allow_origins: list[str] = ["http://localhost:1420"]
    # Root logger level. Set to DEBUG to enable per-chunk and per-event
    # transcript logging during E2E debugging; INFO is the right default
    # for normal use.
    log_level: str = "INFO"

    # Data
    database_url: str | None = None
    redis_url: str | None = None

    # Object storage (S3 / R2)
    # `object_storage_backend` selects the concrete provider: "s3" routes
    # through `S3ObjectStorage` (boto3, R2-compatible); "local" routes
    # through `LocalDiskObjectStorage` and serves audio via the dev-only
    # /storage/local/{token} route. Default "local" keeps dev/test runs
    # working without S3 credentials. Production deploys MUST set this
    # to "s3".
    object_storage_backend: Literal["s3", "local"] = "local"
    s3_endpoint_url: str | None = None
    s3_bucket: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_region: str | None = None
    # Override the default temp roots for tests / sandboxed environments.
    # Both fall back to `tempfile.gettempdir()` when unset.
    local_object_storage_root: str | None = None
    audio_archive_temp_root: str | None = None
    # Symmetric secret for signing local-disk presigned URL tokens. ONLY
    # used when `object_storage_backend == "local"`. Auto-generated per
    # process if unset (dev convenience); production ignores this slot
    # because it must be on the S3 path anyway.
    local_storage_signing_key: str | None = None
    # FR-2.07: pre-signed audio URLs expire in 1 hour by default.
    audio_presigned_url_ttl_seconds: int = 3600

    # External providers
    deepgram_api_key: str | None = None
    anthropic_api_key: str | None = None

    # STT selection. "echo" routes through InMemoryEchoSTT (default, no key
    # required); "deepgram" routes through DeepgramNovaSTT and requires
    # deepgram_api_key to be set.
    stt_provider: Literal["echo", "deepgram"] = "echo"

    # LLM selection (Phase 3). "fake" routes through InMemoryFakeLLM
    # (default for dev/CI, no key required); "anthropic" routes through
    # AnthropicClaudeLLM and requires anthropic_api_key.
    llm_provider: Literal["fake", "anthropic"] = "fake"
    # Pinned per FR-3.04. Override via env only if a successor model
    # genuinely improves quality on the eval set.
    anthropic_model: str = "claude-sonnet-4-20250514"
    # FR-3.07 token budget guard. Inputs above this trip the chunked
    # fallback path in the LangGraph summariser. Anthropic's actual
    # context window is larger; we pad below the limit so reduce-pass
    # reasoning has headroom.
    summary_token_budget: int = 180_000

    # Auth
    workos_api_key: str | None = None
    workos_client_id: str | None = None
    # Override only if WorkOS docs say to; otherwise we derive from client_id.
    workos_jwks_url: str | None = None
    # Where AuthKit redirects after login. For desktop builds this will be a
    # 127.0.0.1 loopback the Tauri shell intercepts; for backend-only smoke
    # tests it can stay as the FastAPI /auth/callback URL.
    workos_redirect_uri: str | None = None
    # AuthKit (User Management) access tokens carry
    # `iss = https://api.workos.com/user_management/<client_id>`. Leave unset
    # and the verifier derives it from `workos_client_id`; override via
    # `WORKOS_JWT_ISSUER` only if WorkOS publishes a new issuer convention.
    workos_jwt_issuer: str | None = None

    # Dev-token signing key — used ONLY by /auth/dev-token in non-prod
    # environments to mint test JWTs that the same JWKS-aware verifier accepts
    # under a separate kid. Production envs leave this unset.
    dev_jwt_signing_key: str | None = None


_settings: Settings | None = None


def get_settings() -> Settings:
    """Return a memoised Settings instance."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
