"""Live transcript WebSocket route.

Receives JSON text frames typed against `ClientWsMessage` (mirrored from
`packages/shared-types/src/ws.ts`) and emits `ServerWsMessage` frames.

Slice 2 wires the `audio_chunk` path: incoming base64 PCM is queued and
fed into `stt.transcribe(...)`. Whichever STT provider is active sees
the audio and yields `TranscriptEvent`s back, which the route forwards
as `transcript_line` frames. The synthetic ticker stays for the echo
provider so the slice-1 demo UX doesn't regress when no audio is sent.

Phase 3 LangGraph insertion point is marked on the single
`_send_transcript_event` helper — every event (whether from the ticker,
a text_probe, or the real STT transcribe loop) flows through it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import itertools
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from meeting_intelligence.api.deps import get_stt_provider
from meeting_intelligence.interfaces.stt import STTProvider, TranscriptEvent
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT

router = APIRouter(prefix="/transcript", tags=["transcript"])

# Max PCM chunks held in the audio queue before backpressure kicks in.
# ~64 chunks @ ~1 s each = 64 s of slack while the STT catches up.
_AUDIO_QUEUE_MAX = 64

# How long to wait for the transcribe consumer to drain trailing events
# after the client signals end-of-stream.
_DRAIN_TIMEOUT_S = 2.0


# --- Client → server payloads (mirror packages/shared-types/src/ws.ts) ---


class _CamelModel(BaseModel):
    """Pydantic base that emits and accepts camelCase keys to match the TS contract."""

    model_config = {"populate_by_name": True}


class ClientCapabilitiesPayload(_CamelModel):
    audioFormat: Literal["pcm16le-mono-16khz"]
    sendsBinaryAudio: bool


class ClientHelloPayload(_CamelModel):
    type: Literal["client_hello"]
    sessionId: str
    clientVersion: str
    capabilities: ClientCapabilitiesPayload


class ClientByePayload(_CamelModel):
    type: Literal["client_bye"]
    sessionId: str


class ClientAudioChunkPayload(_CamelModel):
    type: Literal["audio_chunk"]
    sessionId: str
    seq: int
    pcmBase64: str


class ClientTextProbePayload(_CamelModel):
    type: Literal["text_probe"]
    sessionId: str
    text: str


ClientWsMessage = Annotated[
    ClientHelloPayload | ClientByePayload | ClientAudioChunkPayload | ClientTextProbePayload,
    Field(discriminator="type"),
]
_client_msg_adapter: TypeAdapter[Any] = TypeAdapter(ClientWsMessage)


# --- Server → client payload builders ---


def _utc_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _event_to_line_dict(event: TranscriptEvent) -> dict[str, Any]:
    return {
        "sessionId": event.session_id,
        "speakerId": event.speaker_id,
        "text": event.text,
        "startMs": event.start_ms,
        "endMs": event.end_ms,
        "isFinal": event.is_final,
    }


def _provider_id(stt: STTProvider) -> str:
    return cast(str, getattr(stt, "provider_id", stt.__class__.__name__))


# --- Synthetic ticker (echo-provider only) ---


_TICKER_SENTENCES: list[str] = [
    "Okay, let's pick this up where we left off last week.",
    "I want to walk through the rollout plan before anything else.",
    "We agreed the migration window is Thursday after standup.",
    "There's one open question on the data backfill — Priya is going to confirm.",
    "Action item for me: get the staging numbers in front of the team by Friday.",
    "And then we should be ready to flip the flag on Monday morning.",
]


async def _synthetic_ticker(
    session_id: str,
    stt: STTProvider,
    send_event: Callable[[TranscriptEvent], Awaitable[None]],
) -> None:
    """Emit 4 interim + 1 final transcript event per cycle, rotating speakers.

    Provider-agnostic: builds events via `_build_line(...)` and hands them to
    the shared `send_event` callback so they count toward `finalLineCount` and
    pass through the same Phase-3 hook as real STT output.
    """
    speakers = itertools.cycle([("spk-1", "Speaker 1"), ("spk-2", "Speaker 2")])
    speaker_id, _ = next(speakers)
    lines_in_speaker = 0
    idx = 0
    cycle_pos = 0
    sentence_iter = itertools.cycle(_TICKER_SENTENCES)
    current_sentence = next(sentence_iter)

    while True:
        await asyncio.sleep(1.0)

        is_final = cycle_pos == 4
        if is_final:
            text = current_sentence
        else:
            words = current_sentence.split()
            interim_count = max(1, (cycle_pos + 1) * len(words) // 5)
            text = " ".join(words[:interim_count])

        event = _build_line(stt, session_id, text, speaker_id, idx, is_final)
        await send_event(event)

        idx += 1
        cycle_pos = (cycle_pos + 1) % 5
        if is_final:
            current_sentence = next(sentence_iter)
            lines_in_speaker += 1
            if lines_in_speaker >= 6:
                speaker_id, _ = next(speakers)
                lines_in_speaker = 0


def _build_line(
    stt: STTProvider,
    session_id: str,
    text: str,
    speaker_id: str,
    idx: int,
    is_final: bool,
) -> TranscriptEvent:
    if isinstance(stt, InMemoryEchoSTT):
        return stt.synth_line(
            session_id=session_id,
            text=text,
            speaker_id=speaker_id,
            idx=idx,
            is_final=is_final,
        )
    return TranscriptEvent(
        session_id=session_id,
        speaker_id=speaker_id,
        text=text,
        start_ms=idx * 1000,
        end_ms=(idx + 1) * 1000,
        is_final=is_final,
    )


# --- WS route ---


@router.websocket("/ws/{session_id}")
async def transcript_ws(
    ws: WebSocket,
    session_id: str,
    stt: STTProvider = Depends(get_stt_provider),
) -> None:
    await ws.accept()

    # 1. First frame must be a valid client_hello whose sessionId matches the path.
    try:
        raw_hello = await ws.receive_text()
        hello_msg = _client_msg_adapter.validate_python(json.loads(raw_hello))
    except (WebSocketDisconnect, json.JSONDecodeError, ValidationError) as exc:
        await _send_error(
            ws,
            "INVALID_HELLO",
            f"first frame must be client_hello: {exc}",
            recoverable=False,
        )
        await ws.close(code=1008)
        return

    if not isinstance(hello_msg, ClientHelloPayload) or hello_msg.sessionId != session_id:
        await _send_error(
            ws,
            "INVALID_HELLO",
            "first frame must be client_hello matching the path session_id",
            recoverable=False,
        )
        await ws.close(code=1008)
        return

    started_at = _utc_iso()
    started_at_monotonic = asyncio.get_event_loop().time()
    await ws.send_text(
        json.dumps(
            {
                "type": "session_started",
                "sessionId": session_id,
                "startedAt": started_at,
                "sttProvider": _provider_id(stt),
            }
        )
    )

    # Per-connection mutable state captured by the closures below.
    final_line_count = 0
    probe_idx = 10_000  # well clear of ticker indices

    async def send_transcript_event(event: TranscriptEvent) -> None:
        # ↓ Phase 3 LangGraph insertion point: every event flows through here,
        # whether minted by the synthetic ticker, by a text_probe, or by real
        # STT.transcribe() output. Summarisation graph nodes tap this stream.
        nonlocal final_line_count
        if event.is_final:
            final_line_count += 1
        payload = {"type": "transcript_line", "line": _event_to_line_dict(event)}
        await ws.send_text(json.dumps(payload))

    # 2. Audio pipeline: queue + transcribe consumer task.
    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=_AUDIO_QUEUE_MAX)

    async def audio_iter() -> AsyncIterator[bytes]:
        while True:
            chunk = await audio_queue.get()
            if chunk is None:
                return
            yield chunk

    async def transcribe_consumer() -> None:
        async for event in stt.transcribe(session_id, audio_iter()):
            await send_transcript_event(event)

    consumer_task = asyncio.create_task(transcribe_consumer())

    # 3. Synthetic ticker, only for the echo provider (preserves slice-1 demo).
    ticker_task: asyncio.Task[None] | None = None
    if _provider_id(stt) == "in-memory-echo":
        ticker_task = asyncio.create_task(
            _synthetic_ticker(session_id, stt, send_transcript_event)
        )

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = _client_msg_adapter.validate_python(json.loads(raw))
            except (json.JSONDecodeError, ValidationError) as exc:
                await _send_error(ws, "INVALID_MESSAGE", str(exc), recoverable=True)
                continue

            if isinstance(msg, ClientAudioChunkPayload):
                try:
                    pcm = base64.b64decode(msg.pcmBase64)
                except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
                    await _send_error(
                        ws,
                        "INVALID_AUDIO",
                        f"audio_chunk pcmBase64 is not valid base64: {exc}",
                        recoverable=True,
                    )
                    continue
                try:
                    audio_queue.put_nowait(pcm)
                except asyncio.QueueFull:
                    await _send_error(
                        ws,
                        "AUDIO_BACKPRESSURE",
                        "audio queue full; dropping chunk",
                        recoverable=True,
                    )
            elif isinstance(msg, ClientTextProbePayload):
                event = _build_line(stt, session_id, msg.text, "probe", probe_idx, is_final=True)
                probe_idx += 1
                await send_transcript_event(event)
            elif isinstance(msg, ClientByePayload):
                break
            elif isinstance(msg, ClientHelloPayload):
                await _send_error(
                    ws,
                    "DUPLICATE_HELLO",
                    "client_hello already received",
                    recoverable=True,
                )
    except WebSocketDisconnect:
        pass
    finally:
        # Stop the ticker first — it's the only thing that holds the loop open
        # indefinitely; cancelling it is cheap.
        if ticker_task is not None:
            ticker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticker_task

        # Tell the audio pipeline no more chunks are coming, then give the
        # transcribe consumer up to _DRAIN_TIMEOUT_S to flush trailing events
        # (Deepgram emits a final after the close-stream).
        with contextlib.suppress(asyncio.QueueFull):
            audio_queue.put_nowait(None)
        try:
            await asyncio.wait_for(consumer_task, timeout=_DRAIN_TIMEOUT_S)
        except (TimeoutError, Exception):
            consumer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await consumer_task

    ended_at_monotonic = asyncio.get_event_loop().time()
    duration_ms = max(0, int((ended_at_monotonic - started_at_monotonic) * 1000))

    with contextlib.suppress(Exception):
        await ws.send_text(
            json.dumps(
                {
                    "type": "session_ended",
                    "sessionId": session_id,
                    "endedAt": _utc_iso(),
                    "stats": {
                        "durationMs": duration_ms,
                        "finalLineCount": final_line_count,
                    },
                }
            )
        )
        await ws.close()


async def _send_error(ws: WebSocket, code: str, message: str, recoverable: bool) -> None:
    payload = {
        "type": "error",
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(payload))
