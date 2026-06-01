"""Speech-to-text provider interface.

Implementations: Deepgram Nova-2 (MVP), Faster-Whisper (on-prem).
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


class STTProviderError(RuntimeError):
    """A non-recoverable failure inside an STT provider.

    Raised when the upstream STT service refuses or terminates the
    session in a way the caller cannot recover from automatically —
    auth failure, network teardown that the SDK doesn't retry,
    malformed audio that the upstream rejects, etc.

    The route catches this and surfaces it to the desktop as
    `error{code: "STT_PROVIDER_FAILURE", recoverable: false}` before
    closing the WS. Providers should NOT raise this for transient
    issues that can be hidden from the caller.
    """


@dataclass(frozen=True, slots=True)
class TranscriptEvent:
    """One transcript line from the STT provider."""

    session_id: str
    speaker_id: str
    text: str
    start_ms: int
    end_ms: int
    is_final: bool


class STTProvider(ABC):
    """Streaming speech-to-text with speaker diarisation."""

    @abstractmethod
    def transcribe(
        self,
        session_id: str,
        audio_stream: AsyncIterator[bytes],
    ) -> AsyncIterator[TranscriptEvent]:
        """Consume an audio byte stream, yield transcript events.

        `audio_stream` must yield 16 kHz mono PCM in ~1 s chunks. Concrete
        implementations are async generators (`async def` with `yield`); the
        abstract signature is a plain `def` returning `AsyncIterator` so mypy
        accepts the override (see PEP 525 / mypy async-iterator docs).
        """
        raise NotImplementedError
