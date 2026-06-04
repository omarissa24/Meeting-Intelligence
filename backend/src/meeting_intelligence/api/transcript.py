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
import logging
import os
import tempfile
import wave
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import (
    get_auth_provider,
    get_stt_provider,
)
from meeting_intelligence.auth.deps import _resolve_user
from meeting_intelligence.auth.workos_provider import TokenVerificationError
from meeting_intelligence.config import get_settings
from meeting_intelligence.db.models.meeting import Meeting
from meeting_intelligence.db.models.meeting_summary import MeetingSummary
from meeting_intelligence.db.models.transcript_segment import TranscriptSegment
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.interfaces.auth import AuthProvider
from meeting_intelligence.interfaces.stt import (
    STTProvider,
    STTProviderError,
    TranscriptEvent,
)
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT

router = APIRouter(prefix="/transcript", tags=["transcript"])

log = logging.getLogger("meeting_intelligence.transcript")

# Max PCM chunks held in the audio queue before backpressure kicks in.
# ~64 chunks @ ~1 s each = 64 s of slack while the STT catches up.
_AUDIO_QUEUE_MAX = 64

# How long to wait for the transcribe consumer to drain trailing events
# after the client signals end-of-stream.
_DRAIN_TIMEOUT_S = 2.0

# Opt-in WAV dump of the raw PCM the route receives — exactly what the
# STT provider sees. Set AUDIO_DUMP_DIR to enable; one .wav file per
# session is written there. Used to verify byte-level audio fidelity
# when STT returns empty transcripts despite healthy desktop levels.
_AUDIO_DUMP_DIR = os.environ.get("AUDIO_DUMP_DIR")


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


def _percentile(values: list[int], q: float) -> int:
    """Nearest-rank percentile. Returns 0 on an empty list."""
    if not values:
        return 0
    s = sorted(values)
    rank = max(0, min(len(s) - 1, round(q * (len(s) - 1))))
    return s[rank]


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
    auth: AuthProvider = Depends(get_auth_provider),
) -> None:
    """Live transcript WS.

    Authentication: when the backend has a DB session factory attached
    (i.e. `DATABASE_URL` is set in the running process), the client
    MUST present a valid bearer token via the `Sec-WebSocket-Protocol`
    subprotocol header (`bearer.<jwt>`). Tokens are verified against
    WorkOS's JWKS (or the dev signing key in non-prod). The path
    `session_id` is interpreted as `meetings.id` and is checked for
    ownership via RLS — non-owners get a 1008 close, indistinguishable
    from "no such meeting".

    When the DB factory is absent (legacy demo / Phase-1 smoke runs),
    the route falls back to its pre-Phase-2 behaviour: anonymous
    accept, no persistence. This keeps Phase-1 fixtures green until
    they migrate to the auth contract.
    """
    session_factory: async_sessionmaker[AsyncSession] | None = getattr(
        ws.app.state, "db_session_factory", None
    )

    user_id: UUID | None = None
    meeting_uuid: UUID | None = None

    if session_factory is not None:
        # Auth + meeting binding required.
        token = _extract_bearer_subprotocol(ws)
        if token is None:
            await ws.close(code=1008)
            log.info("transcript.ws_reject session_id=%s reason=missing_bearer", session_id)
            return
        try:
            claims = await auth.verify_token(token)
        except TokenVerificationError as exc:
            log.info("transcript.ws_reject session_id=%s reason=%s", session_id, exc)
            await ws.close(code=1008)
            return

        try:
            meeting_uuid = UUID(session_id)
        except ValueError:
            log.info(
                "transcript.ws_reject session_id=%s reason=session_id_not_uuid",
                session_id,
            )
            await ws.close(code=1008)
            return

        async with session_factory() as boot_session:
            try:
                user = await _resolve_user(boot_session, claims)
                user_id = user.id
                await boot_session.commit()
            except Exception:
                await boot_session.rollback()
                raise

        # Verify the meeting exists AND belongs to this user. RLS makes
        # the SELECT return zero rows for other-user meetings.
        async with session_factory() as check_session:
            await set_request_user(check_session, user_id)
            row = (
                await check_session.execute(
                    select(Meeting.id).where(Meeting.id == meeting_uuid)
                )
            ).scalar_one_or_none()
        if row is None:
            log.info(
                "transcript.ws_reject session_id=%s reason=meeting_not_found_or_not_owned",
                session_id,
            )
            await ws.close(code=1008)
            return

        # Echo the subprotocol back; the client wedge needs it for the
        # WS upgrade to complete.
        await ws.accept(subprotocol=f"bearer.{token}")
    else:
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

    provider_id = _provider_id(stt)
    log.info("transcript.ws_open session_id=%s provider=%s", session_id, provider_id)

    started_at = _utc_iso()
    started_at_monotonic = asyncio.get_event_loop().time()
    await ws.send_text(
        json.dumps(
            {
                "type": "session_started",
                "sessionId": session_id,
                "startedAt": started_at,
                "sttProvider": provider_id,
            }
        )
    )
    log.info("transcript.session_started session_id=%s", session_id)

    # Per-connection mutable state captured by the closures below.
    final_line_count = 0
    probe_idx = 10_000  # well clear of ticker indices
    last_chunk_recv_at: float | None = None
    final_latencies_ms: list[int] = []
    stt_failed = False
    stt_failure_msg = ""

    # WAV capture tap. Two cases:
    #   1. AUDIO_DUMP_DIR set — diagnostic dump (Phase-1 instrumentation),
    #      writes alongside the canonical capture.
    #   2. Authenticated session (meeting_uuid set) — required so the
    #      `archive_meeting_audio` Celery task can encode the file to
    #      MP3 and upload after the WS closes (US-11).
    # When neither applies (legacy demo path, no DB factory attached),
    # we don't write a WAV at all.
    wav_writer: wave.Wave_write | None = None
    archive_wav_path: Path | None = None
    if _AUDIO_DUMP_DIR or meeting_uuid is not None:
        try:
            settings_for_temp = get_settings()
            archive_root = (
                Path(_AUDIO_DUMP_DIR)
                if _AUDIO_DUMP_DIR
                else Path(
                    settings_for_temp.audio_archive_temp_root
                    or tempfile.gettempdir()
                )
                / "meeting-intelligence-archive"
            )
            archive_root.mkdir(parents=True, exist_ok=True)
            archive_wav_path = archive_root / f"{session_id}.wav"
            wav_writer = wave.open(str(archive_wav_path), "wb")
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)  # 16-bit PCM
            wav_writer.setframerate(16_000)
            log.info(
                "transcript.audio_dump_open session_id=%s path=%s", session_id, archive_wav_path
            )
        except OSError as exc:
            log.warning(
                "transcript.audio_dump_failed session_id=%s err=%s", session_id, exc
            )
            wav_writer = None
            archive_wav_path = None

    distinct_speakers: set[str] = set()

    async def send_transcript_event(event: TranscriptEvent) -> None:
        # ↓ Phase 3 LangGraph insertion point: every event flows through here,
        # whether minted by the synthetic ticker, by a text_probe, or by real
        # STT.transcribe() output. Summarisation graph nodes tap this stream.
        nonlocal final_line_count
        if event.is_final:
            final_line_count += 1
            if event.speaker_id:
                distinct_speakers.add(event.speaker_id)
            # Persist finals only. Interims would 10x write volume for
            # no read benefit; the live UI already gets them via the WS.
            if session_factory is not None and user_id is not None and meeting_uuid is not None:
                await _persist_final_segment(
                    session_factory,
                    user_id=user_id,
                    meeting_id=meeting_uuid,
                    event=event,
                )
        # Wire-to-wire latency: chunk-recv → event-emit. Recorded for finals
        # only so a flood of interims doesn't skew the summary.
        if last_chunk_recv_at is not None:
            latency_ms = int(
                (asyncio.get_event_loop().time() - last_chunk_recv_at) * 1000
            )
            if event.is_final:
                final_latencies_ms.append(latency_ms)
            log.debug(
                "transcript.event_emit session_id=%s is_final=%s speaker=%s latency_ms=%d",
                session_id,
                event.is_final,
                event.speaker_id,
                latency_ms,
            )
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
        nonlocal stt_failed, stt_failure_msg
        try:
            async for event in stt.transcribe(session_id, audio_iter()):
                await send_transcript_event(event)
        except STTProviderError as exc:
            stt_failed = True
            stt_failure_msg = str(exc)
            log.error(
                "transcript.stt_failure session_id=%s code=STT_PROVIDER_FAILURE msg=%s",
                session_id,
                exc,
            )
            await _send_error(
                ws,
                "STT_PROVIDER_FAILURE",
                stt_failure_msg or "stt provider failed",
                recoverable=False,
            )

    consumer_task = asyncio.create_task(transcribe_consumer())

    # 3. Synthetic ticker, only for the echo provider (preserves slice-1 demo).
    ticker_task: asyncio.Task[None] | None = None
    if provider_id == "in-memory-echo":
        ticker_task = asyncio.create_task(
            _synthetic_ticker(session_id, stt, send_transcript_event)
        )

    try:
        while True:
            if stt_failed:
                # Consumer surfaced a non-recoverable provider failure.
                # Stop accepting frames and let `finally` close the WS.
                break
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
                last_chunk_recv_at = asyncio.get_event_loop().time()
                log.debug(
                    "transcript.chunk_recv session_id=%s seq=%d bytes=%d",
                    session_id,
                    msg.seq,
                    len(pcm),
                )
                if wav_writer is not None:
                    try:
                        wav_writer.writeframes(pcm)
                    except OSError as exc:
                        log.warning(
                            "transcript.audio_dump_write_failed session_id=%s err=%s",
                            session_id,
                            exc,
                        )
                        wav_writer = None
                try:
                    audio_queue.put_nowait(pcm)
                except asyncio.QueueFull:
                    log.warning(
                        "transcript.audio_backpressure session_id=%s seq=%d",
                        session_id,
                        msg.seq,
                    )
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

        if wav_writer is not None:
            with contextlib.suppress(Exception):
                wav_writer.close()
            log.info("transcript.audio_dump_close session_id=%s", session_id)

    ended_at_monotonic = asyncio.get_event_loop().time()
    duration_ms = max(0, int((ended_at_monotonic - started_at_monotonic) * 1000))

    if session_factory is not None and user_id is not None and meeting_uuid is not None:
        await _stamp_meeting_completed(
            session_factory,
            user_id=user_id,
            meeting_id=meeting_uuid,
            duration_seconds=duration_ms // 1000,
            speaker_count=len(distinct_speakers),
            final_status="failed" if stt_failed else "completed",
        )
        # US-11: dispatch the audio archive Celery task. Best-effort —
        # if the broker is unreachable (worker down in dev), log and
        # leave the temp WAV behind for the next worker run to pick up
        # via a future janitor task. We don't 500 the WS over this.
        if archive_wav_path is not None and archive_wav_path.exists():
            try:
                from meeting_intelligence.worker.tasks.audio_archive import (
                    archive_meeting_audio,
                )

                archive_meeting_audio.delay(
                    meeting_id=str(meeting_uuid),
                    user_id=str(user_id),
                    wav_path=str(archive_wav_path),
                )
                log.info(
                    "transcript.audio_archive_dispatched session_id=%s wav_path=%s",
                    session_id,
                    archive_wav_path,
                )
            except Exception as exc:  # broker errors are varied
                log.warning(
                    "transcript.audio_archive_dispatch_failed session_id=%s err=%s",
                    session_id,
                    exc,
                )

        # FR-3.01: dispatch the summarise Celery task OR park a
        # terminal failed-summary row directly.
        #
        # Rule: park a terminal `failed` row only when STT errored AND
        # zero finals landed — the bug we hit (Deepgram crashed before
        # any transcript was captured, and the desktop poll-spun
        # forever waiting for a summary that would never come).
        # Everything else dispatches summarise:
        #
        #   - clean close, finals present → normal completed summary
        #   - clean close, no finals (e.g. bye-on-empty)  → too_short
        #   - stt_failed BUT finals were persisted (Deepgram errored on
        #     the trailing close handshake; we have 15 lines on disk)
        #     → real summary, NOT silently skipped (was the pre-fix bug)
        if stt_failed and final_line_count == 0:
            failure_message = (
                stt_failure_msg
                or "Recording failed before any transcript was captured."
            )
            await _park_failed_summary(
                session_factory,
                user_id=user_id,
                meeting_id=meeting_uuid,
                error=failure_message,
            )
            log.info(
                "transcript.summarise_skipped_failed_row_parked session_id=%s",
                session_id,
            )
        else:
            try:
                from meeting_intelligence.worker.tasks.summarise import (
                    summarise_meeting,
                )

                summarise_meeting.delay(
                    meeting_id=str(meeting_uuid),
                    user_id=str(user_id),
                )
                log.info(
                    "transcript.summarise_dispatched session_id=%s stt_failed=%s finals=%d",
                    session_id,
                    stt_failed,
                    final_line_count,
                )
            except Exception as exc:
                log.warning(
                    "transcript.summarise_dispatch_failed session_id=%s err=%s",
                    session_id,
                    exc,
                )

    if final_latencies_ms:
        log.info(
            "transcript.latency_summary session_id=%s p50_ms=%d p95_ms=%d n=%d",
            session_id,
            _percentile(final_latencies_ms, 0.50),
            _percentile(final_latencies_ms, 0.95),
            len(final_latencies_ms),
        )

    if stt_failed:
        # Hard failure path: skip session_ended and close with Internal Error.
        log.info(
            "transcript.ws_close session_id=%s final_lines=%d duration_ms=%d reason=stt_failure",
            session_id,
            final_line_count,
            duration_ms,
        )
        with contextlib.suppress(Exception):
            await ws.close(code=1011)
        return

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
    log.info(
        "transcript.ws_close session_id=%s final_lines=%d duration_ms=%d",
        session_id,
        final_line_count,
        duration_ms,
    )


async def _send_error(ws: WebSocket, code: str, message: str, recoverable: bool) -> None:
    payload = {
        "type": "error",
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(payload))


def _extract_bearer_subprotocol(ws: WebSocket) -> str | None:
    """Return the JWT from a `Sec-WebSocket-Protocol: bearer.<jwt>` offer.

    Browsers and the Tauri/tungstenite WS client both ship the header
    as a comma-separated list when multiple subprotocols are offered.
    Anything not matching the `bearer.` prefix is ignored.
    """
    raw = ws.headers.get("sec-websocket-protocol")
    if not raw:
        return None
    for piece in raw.split(","):
        token = piece.strip()
        if token.startswith("bearer."):
            value = token[len("bearer."):]
            return value or None
    return None


async def _persist_final_segment(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: UUID,
    meeting_id: UUID,
    event: TranscriptEvent,
) -> None:
    """Insert one final transcript segment under RLS.

    Each insert lives in its own short transaction so a single failure
    doesn't poison the rest of the session. Errors are logged and
    swallowed — losing one segment is better than tearing down the WS.
    """
    try:
        async with session_factory() as session:
            await set_request_user(session, user_id)
            await session.execute(
                insert(TranscriptSegment).values(
                    meeting_id=meeting_id,
                    user_id=user_id,
                    speaker_id=event.speaker_id,
                    text=event.text,
                    start_ms=event.start_ms,
                    end_ms=event.end_ms,
                    is_final=True,
                )
            )
            await session.commit()
    except Exception as exc:
        log.error(
            "transcript.persist_failed meeting_id=%s err=%s",
            meeting_id,
            exc,
        )


async def _stamp_meeting_completed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: UUID,
    meeting_id: UUID,
    duration_seconds: int,
    speaker_count: int,
    final_status: str,
) -> None:
    try:
        async with session_factory() as session:
            await set_request_user(session, user_id)
            await session.execute(
                update(Meeting)
                .where(Meeting.id == meeting_id)
                .values(
                    ended_at=datetime.now(UTC),
                    duration_seconds=duration_seconds,
                    speaker_count=speaker_count,
                    status=final_status,
                )
            )
            await session.commit()
    except Exception as exc:
        log.error(
            "transcript.stamp_failed meeting_id=%s err=%s",
            meeting_id,
            exc,
        )


async def _park_failed_summary(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: UUID,
    meeting_id: UUID,
    error: str,
) -> None:
    """Write a terminal `meeting_summaries` row when STT failed before
    any transcript landed. Without this, the desktop reads
    `summaryStatus="pending"` forever and the "Generating summary…"
    spinner never resolves.

    Idempotent against re-entry — if a row already exists (e.g. a
    previous Regenerate attempt), update its status/error rather than
    inserting a duplicate.
    """
    try:
        async with session_factory() as session:
            await set_request_user(session, user_id)
            existing = (
                await session.execute(
                    select(MeetingSummary).where(MeetingSummary.meeting_id == meeting_id)
                )
            ).scalar_one_or_none()
            now = datetime.now(UTC)
            if existing is None:
                session.add(
                    MeetingSummary(
                        meeting_id=meeting_id,
                        user_id=user_id,
                        status="failed",
                        error=error,
                        generated_at=now,
                    )
                )
            else:
                existing.status = "failed"
                existing.error = error
                existing.regenerated_at = now
            await session.commit()
    except Exception as exc:
        log.error(
            "transcript.park_failed_summary_failed meeting_id=%s err=%s",
            meeting_id,
            exc,
        )
