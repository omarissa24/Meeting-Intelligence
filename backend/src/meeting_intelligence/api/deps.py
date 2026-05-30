"""FastAPI dependency providers for swappable infrastructure.

Centralises the wiring between routes and the abstract interfaces in
`meeting_intelligence.interfaces`. Tests override these via
`app.dependency_overrides[...]`; later plans swap real provider impls
(e.g. Deepgram, S3, WorkOS) in the same place without touching routes.
"""

from meeting_intelligence.interfaces.stt import STTProvider
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT

_stt_singleton: STTProvider = InMemoryEchoSTT()


def get_stt_provider() -> STTProvider:
    """Return the active STT provider instance.

    Foundation slice always returns the in-memory echo stub. The Deepgram
    slice replaces this with a config-driven factory.
    """
    return _stt_singleton
