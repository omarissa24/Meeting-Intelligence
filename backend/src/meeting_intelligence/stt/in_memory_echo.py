"""In-memory STT stub used by the foundation slice.

Implements `STTProvider` so the WS route stays behind the architectural
seam from day one (see CLAUDE.md "Architectural invariants" #1). Future
plans swap this for `DeepgramNovaSTT` via the dependency in `api/deps.py`
without touching the route.
"""

from collections.abc import AsyncIterator

from meeting_intelligence.interfaces.stt import STTProvider, TranscriptEvent


class InMemoryEchoSTT(STTProvider):
    """Streaming-shaped STT that echoes audio chunks as fake transcript events.

    The foundation slice does not pump real audio; instead the WS route calls
    `synth_line` directly to fabricate a steady stream of events. The
    `transcribe` path is still defined so a future audio-capable client can
    exercise the provider contract end-to-end against the same stub.
    """

    provider_id: str = "in-memory-echo"

    async def transcribe(
        self,
        session_id: str,
        audio_stream: AsyncIterator[bytes],
        *,
        language: str | None = None,
    ) -> AsyncIterator[TranscriptEvent]:
        del language  # echo provider has nothing to detect; accept and ignore
        seq = 0
        async for _chunk in audio_stream:
            seq += 1
            yield TranscriptEvent(
                session_id=session_id,
                speaker_id="echo",
                text=f"[echo chunk {seq}]",
                start_ms=(seq - 1) * 1000,
                end_ms=seq * 1000,
                is_final=True,
            )

    def synth_line(
        self,
        session_id: str,
        text: str,
        speaker_id: str,
        idx: int,
        is_final: bool,
    ) -> TranscriptEvent:
        """Mint a synthetic transcript event without going through audio."""
        return TranscriptEvent(
            session_id=session_id,
            speaker_id=speaker_id,
            text=text,
            start_ms=idx * 1000,
            end_ms=(idx + 1) * 1000,
            is_final=is_final,
        )
