"""Speech-to-text provider interface.

Implementations: Deepgram Nova-2 (MVP), Faster-Whisper (on-prem).
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


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
    async def transcribe(
        self,
        session_id: str,
        audio_stream: AsyncIterator[bytes],
    ) -> AsyncIterator[TranscriptEvent]:
        """Consume an audio byte stream, yield transcript events.

        `audio_stream` must yield 16 kHz mono PCM in ~1 s chunks.
        """
        raise NotImplementedError
