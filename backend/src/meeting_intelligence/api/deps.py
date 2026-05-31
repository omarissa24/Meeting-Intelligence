"""FastAPI dependency providers for swappable infrastructure.

Centralises the wiring between routes and the abstract interfaces in
`meeting_intelligence.interfaces`. Tests override these via
`app.dependency_overrides[...]`; later plans swap real provider impls
(e.g. S3, WorkOS) in the same place without touching routes.
"""

from functools import lru_cache

from meeting_intelligence.config import get_settings
from meeting_intelligence.interfaces.stt import STTProvider
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
