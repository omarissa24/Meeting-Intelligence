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
    environment: str = "development"
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


_settings: Settings | None = None


def get_settings() -> Settings:
    """Return a memoised Settings instance."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
