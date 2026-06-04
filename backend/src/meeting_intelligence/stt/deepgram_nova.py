"""Deepgram Nova-2 streaming implementation of `STTProvider`.

Sits behind the architectural seam established in slice 1: feature code
never imports the Deepgram SDK directly — it goes through `STTProvider`,
and `api/deps.py` chooses which concrete implementation to inject.

Uses deepgram-sdk's listen.v1 streaming WebSocket (the classic real-time
STT endpoint with diarisation + interim results). The newer listen.v2
endpoint is a different product — "conversational" with turn detection
but no diarize/interim flags — so we deliberately target v1 here.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import AsyncIterator

from deepgram import AsyncDeepgramClient
from deepgram.listen.v1.types.listen_v1results import ListenV1Results

from meeting_intelligence.interfaces.stt import (
    STTProvider,
    STTProviderError,
    TranscriptEvent,
)

log = logging.getLogger("meeting_intelligence.stt.deepgram_nova")


class DeepgramNovaSTT(STTProvider):
    """Streaming STT backed by Deepgram Nova-2.

    Connection options are fixed: 16 kHz mono PCM (linear16), diarisation
    on, interim results on, smart_format + punctuate on for legible
    transcripts. If a deployment needs different settings later, expose
    them via constructor args — not via globals.
    """

    provider_id: str = "deepgram-nova-2"

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ValueError("DeepgramNovaSTT requires a non-empty api_key")
        self._client = AsyncDeepgramClient(api_key=api_key)

    async def transcribe(
        self,
        session_id: str,
        audio_stream: AsyncIterator[bytes],
        *,
        language: str | None = None,
    ) -> AsyncIterator[TranscriptEvent]:
        # `None` and the literal "auto" both mean "let Deepgram auto-detect".
        # Anything else (e.g. "en", "es") is forwarded as the `language` kwarg
        # so the model picks an explicit language and skips detection.
        connect_kwargs: dict[str, object] = {
            "model": "nova-2",
            "encoding": "linear16",
            "sample_rate": 16000,
            "channels": 1,
            "diarize": True,
            "interim_results": True,
            "punctuate": True,
            "smart_format": True,
        }
        if language is not None and language != "auto":
            connect_kwargs["language"] = language
        producer_error: list[BaseException] = []
        try:
            async with self._client.listen.v1.connect(**connect_kwargs) as conn:
                log.info(
                    "deepgram.connect session_id=%s language=%s",
                    session_id,
                    language or "auto",
                )
                producer = asyncio.create_task(
                    _pump_audio(conn, audio_stream, session_id, producer_error)
                )
                try:
                    async for msg in conn:
                        if not isinstance(msg, ListenV1Results):
                            continue
                        event = _results_to_event(msg, session_id)
                        if event is not None:
                            yield event
                except STTProviderError:
                    raise
                except Exception as exc:
                    log.error(
                        "deepgram.recv_failed session_id=%s err=%s", session_id, exc
                    )
                    raise STTProviderError(f"deepgram receive failed: {exc}") from exc
                finally:
                    # Audio stream ended (or downstream cancelled). Producer may
                    # already have called send_close_stream; either way, cancel
                    # any in-flight send so the connection unwinds cleanly.
                    producer.cancel()
                    try:
                        await producer
                    except (asyncio.CancelledError, Exception):
                        pass
                    log.info("deepgram.disconnect session_id=%s", session_id)
        except STTProviderError:
            raise
        except Exception as exc:
            # Connection establishment failure (auth, network, etc.).
            log.error("deepgram.connect_failed session_id=%s err=%s", session_id, exc)
            raise STTProviderError(f"deepgram connect failed: {exc}") from exc

        # If the producer task captured an exception, surface it now —
        # the consumer loop exited cleanly because Deepgram closed the
        # connection, but the real cause was on the send side.
        if producer_error:
            raise STTProviderError(
                f"deepgram send failed: {producer_error[0]}"
            ) from producer_error[0]


async def _pump_audio(
    conn: object,
    audio_stream: AsyncIterator[bytes],
    session_id: str,
    error_sink: list[BaseException],
) -> None:
    """Forward every PCM chunk from `audio_stream` to Deepgram.

    Captures any non-cancellation exception into `error_sink` so the
    consumer side can re-raise it as `STTProviderError`.
    """
    try:
        async for chunk in audio_stream:
            await conn.send_media(chunk)  # type: ignore[attr-defined]
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.error("deepgram.send_failed session_id=%s err=%s", session_id, exc)
        error_sink.append(exc)
    finally:
        # CloseStream tells Deepgram the audio is finished; the connection
        # then emits trailing finals before EOF.
        try:
            await conn.send_close_stream()  # type: ignore[attr-defined]
        except Exception:
            # The connection may already be torn down — best-effort close.
            pass


def _results_to_event(msg: ListenV1Results, session_id: str) -> TranscriptEvent | None:
    """Map one Deepgram Results message to a `TranscriptEvent`, or None to skip."""
    if not msg.channel.alternatives:
        return None
    alt = msg.channel.alternatives[0]
    text = alt.transcript.strip()
    if not text:
        return None

    speaker_int = _dominant_speaker(alt.words)
    start_ms = int(msg.start * 1000)
    end_ms = int((msg.start + msg.duration) * 1000)

    return TranscriptEvent(
        session_id=session_id,
        speaker_id=f"spk-{speaker_int}",
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        is_final=bool(msg.is_final),
    )


def _dominant_speaker(words: list) -> int:  # type: ignore[type-arg]
    """Return the most common speaker int among `words`, or 0 if none labelled.

    Deepgram emits per-word speaker integers when `diarize=true`. For a single
    utterance most words share a speaker; if diarisation hasn't kicked in
    (early in the session, or short utterances) all speakers are None and we
    fall back to speaker 0 so the UI still gets a stable label.
    """
    counts: Counter[int] = Counter()
    for word in words:
        spk = getattr(word, "speaker", None)
        if spk is not None:
            counts[int(spk)] += 1
    if not counts:
        return 0
    return counts.most_common(1)[0][0]
