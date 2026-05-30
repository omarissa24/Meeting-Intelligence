"""Live transcript WebSocket route.

Foundation slice: streams synthetic transcript events through the
`STTProvider` interface (currently `InMemoryEchoSTT`) so the UI feels
alive end-to-end without real audio capture. The route receives JSON
text frames typed against `ClientWsMessage` (mirrored from
`packages/shared-types/src/ws.ts`) and emits `ServerWsMessage` frames.

Phase 3 LangGraph insertion point is marked inline — that's where future
summarisation graph nodes hook into the per-event stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from meeting_intelligence.api.deps import get_stt_provider
from meeting_intelligence.interfaces.stt import STTProvider, TranscriptEvent
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT

router = APIRouter(prefix="/transcript", tags=["transcript"])


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


# --- Synthetic ticker ---


_TICKER_SENTENCES: list[str] = [
    "Okay, let's pick this up where we left off last week.",
    "I want to walk through the rollout plan before anything else.",
    "We agreed the migration window is Thursday after standup.",
    "There's one open question on the data backfill — Priya is going to confirm.",
    "Action item for me: get the staging numbers in front of the team by Friday.",
    "And then we should be ready to flip the flag on Monday morning.",
]


async def _synthetic_ticker(ws: WebSocket, session_id: str, stt: STTProvider) -> None:
    """Emit 4 interim + 1 final transcript_line per cycle, rotating speakers every 6 lines.

    Uses `stt.synth_line(...)` so even fake lines are minted through the provider
    seam. The InMemoryEchoSTT stub exposes that helper; if a swapped-in provider
    doesn't, the route fabricates events locally as a fallback.
    """
    speakers = itertools.cycle([("spk-1", "Speaker 1"), ("spk-2", "Speaker 2")])
    speaker_id, _ = next(speakers)
    lines_in_speaker = 0
    idx = 0
    cycle_pos = 0
    sentence_iter = itertools.cycle(_TICKER_SENTENCES)
    current_sentence = next(sentence_iter)

    try:
        while True:
            await asyncio.sleep(1.0)

            is_final = cycle_pos == 4
            # Build interim suffix so the panel visibly grows toward the final.
            if is_final:
                text = current_sentence
            else:
                words = current_sentence.split()
                interim_count = max(1, (cycle_pos + 1) * len(words) // 5)
                text = " ".join(words[:interim_count])

            event = _build_line(stt, session_id, text, speaker_id, idx, is_final)
            # ↓ Phase 3 LangGraph insertion point: future summarisation nodes
            # tap the per-event stream here, before it leaves the route.
            payload = {"type": "transcript_line", "line": _event_to_line_dict(event)}
            await ws.send_text(json.dumps(payload))

            idx += 1
            cycle_pos = (cycle_pos + 1) % 5
            if is_final:
                current_sentence = next(sentence_iter)
                lines_in_speaker += 1
                if lines_in_speaker >= 6:
                    speaker_id, _ = next(speakers)
                    lines_in_speaker = 0
    except asyncio.CancelledError:
        raise


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

    # 2. Drive the synthetic ticker concurrently with the receive loop.
    ticker_task = asyncio.create_task(_synthetic_ticker(ws, session_id, stt))
    final_line_count = 0
    probe_idx = 10_000  # well clear of ticker indices

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = _client_msg_adapter.validate_python(json.loads(raw))
            except (json.JSONDecodeError, ValidationError) as exc:
                await _send_error(ws, "INVALID_MESSAGE", str(exc), recoverable=True)
                continue

            if isinstance(msg, ClientTextProbePayload):
                event = _build_line(stt, session_id, msg.text, "probe", probe_idx, is_final=True)
                probe_idx += 1
                final_line_count += 1
                await ws.send_text(
                    json.dumps({"type": "transcript_line", "line": _event_to_line_dict(event)})
                )
            elif isinstance(msg, ClientByePayload):
                break
            elif isinstance(msg, ClientAudioChunkPayload):
                # Foundation slice ignores audio chunks; the audio-capture plan
                # routes these through `stt.transcribe(...)` instead.
                continue
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
        ticker_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticker_task

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
