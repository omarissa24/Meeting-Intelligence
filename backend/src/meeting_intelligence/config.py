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
    s3_endpoint_url: str | None = None
    s3_bucket: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_region: str | None = None

    # External providers
    deepgram_api_key: str | None = None
    anthropic_api_key: str | None = None

    # STT selection. "echo" routes through InMemoryEchoSTT (default, no key
    # required); "deepgram" routes through DeepgramNovaSTT and requires
    # deepgram_api_key to be set.
    stt_provider: Literal["echo", "deepgram"] = "echo"

    # Auth
    workos_api_key: str | None = None
    workos_client_id: str | None = None
    # Override only if WorkOS docs say to; otherwise we derive from client_id.
    workos_jwks_url: str | None = None
    # Where AuthKit redirects after login. For desktop builds this will be a
    # 127.0.0.1 loopback the Tauri shell intercepts; for backend-only smoke
    # tests it can stay as the FastAPI /auth/callback URL.
    workos_redirect_uri: str | None = None
    # WorkOS access tokens carry `iss = https://api.workos.com`. Override per
    # environment if WorkOS rotates issuers.
    workos_jwt_issuer: str = "https://api.workos.com"

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
