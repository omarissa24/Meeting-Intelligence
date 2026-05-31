"""Stream a WAV file into /transcript/ws/{session_id} and print transcripts.

Useful for verifying the Deepgram path (or any STTProvider) end-to-end
without native audio capture wired up yet. Expects 16 kHz, mono, 16-bit
PCM input — convert other files with ffmpeg:

    ffmpeg -i input.mp3 -ar 16000 -ac 1 -acodec pcm_s16le output.wav

Usage:

    uv run python scripts/replay_audio.py path/to/speech.wav
    uv run python scripts/replay_audio.py speech.wav --url ws://localhost:8000
    uv run python scripts/replay_audio.py speech.wav --chunk-ms 500 --no-rate-limit
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import uuid
import wave
from pathlib import Path

import websockets

_SUPPORTED_SAMPLE_RATE = 16_000
_SUPPORTED_CHANNELS = 1
_SUPPORTED_SAMPLE_WIDTH = 2  # 16-bit PCM


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="replay_audio.py",
        description="Stream a 16 kHz mono 16-bit PCM WAV into /transcript/ws.",
    )
    p.add_argument("wav_path", type=Path, help="Path to the source WAV file")
    p.add_argument(
        "--url",
        default="ws://localhost:8000",
        help="Backend base URL (default: ws://localhost:8000)",
    )
    p.add_argument(
        "--chunk-ms",
        type=int,
        default=1000,
        help="Audio chunk size in milliseconds (default: 1000)",
    )
    p.add_argument(
        "--rate-limit",
        dest="rate_limit",
        action="store_true",
        default=True,
        help="Pace chunks at real-time (default: on)",
    )
    p.add_argument(
        "--no-rate-limit",
        dest="rate_limit",
        action="store_false",
        help="Dump chunks as fast as the WS accepts (useful for throughput tests)",
    )
    return p.parse_args()


def _validate_wav(wav: wave.Wave_read, path: Path) -> None:
    rate = wav.getframerate()
    channels = wav.getnchannels()
    width = wav.getsampwidth()
    if (rate, channels, width) != (
        _SUPPORTED_SAMPLE_RATE,
        _SUPPORTED_CHANNELS,
        _SUPPORTED_SAMPLE_WIDTH,
    ):
        print(
            f"error: {path} is {rate} Hz, {channels} ch, {width * 8}-bit; "
            f"expected {_SUPPORTED_SAMPLE_RATE} Hz, mono, 16-bit PCM.\n"
            f"  ffmpeg -i {path} -ar 16000 -ac 1 -acodec pcm_s16le out.wav",
            file=sys.stderr,
        )
        sys.exit(2)


async def _receive_loop(ws: websockets.WebSocketClientProtocol, done: asyncio.Event) -> None:
    """Print every server frame; signal `done` when session_ended arrives."""
    async for raw in ws:
        if not isinstance(raw, str):
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            print(f"<unparseable> {raw!r}")
            continue
        kind = msg.get("type")
        if kind == "transcript_line":
            line = msg["line"]
            tag = "final" if line.get("isFinal") else "interim"
            print(f"[{tag:>7}] {line['speakerId']}: {line['text']}")
        elif kind == "session_started":
            print(f"session_started  stt={msg.get('sttProvider')}  id={msg['sessionId']}")
        elif kind == "session_ended":
            stats = msg.get("stats", {})
            print(
                f"session_ended    duration={stats.get('durationMs')}ms  "
                f"finals={stats.get('finalLineCount')}"
            )
            done.set()
            return
        elif kind == "error":
            print(f"!! error code={msg.get('code')} recoverable={msg.get('recoverable')} "
                  f"msg={msg.get('message')}")
        else:
            print(f"<{kind}> {msg}")


async def _send_audio(
    ws: websockets.WebSocketClientProtocol,
    session_id: str,
    wav: wave.Wave_read,
    chunk_ms: int,
    rate_limit: bool,
) -> None:
    """Read the WAV in chunk_ms slices, base64-encode, send as audio_chunk."""
    frames_per_chunk = (_SUPPORTED_SAMPLE_RATE * chunk_ms) // 1000
    seq = 0
    while True:
        frames = wav.readframes(frames_per_chunk)
        if not frames:
            break
        seq += 1
        payload = {
            "type": "audio_chunk",
            "sessionId": session_id,
            "seq": seq,
            "pcmBase64": base64.b64encode(frames).decode("ascii"),
        }
        await ws.send(json.dumps(payload))
        if rate_limit:
            await asyncio.sleep(chunk_ms / 1000)


async def _run(args: argparse.Namespace) -> int:
    if not args.wav_path.is_file():
        print(f"error: {args.wav_path} not found", file=sys.stderr)
        return 2

    session_id = str(uuid.uuid4())
    ws_url = f"{args.url.rstrip('/')}/transcript/ws/{session_id}"
    print(f"connecting to {ws_url}")

    with wave.open(str(args.wav_path), "rb") as wav:
        _validate_wav(wav, args.wav_path)
        duration_s = wav.getnframes() / _SUPPORTED_SAMPLE_RATE
        print(f"streaming {args.wav_path.name} ({duration_s:.1f}s, "
              f"chunk={args.chunk_ms}ms, rate_limit={args.rate_limit})")

        async with websockets.connect(ws_url) as ws:
            hello = {
                "type": "client_hello",
                "sessionId": session_id,
                "clientVersion": "replay-audio/0.1",
                "capabilities": {
                    "audioFormat": "pcm16le-mono-16khz",
                    "sendsBinaryAudio": False,
                },
            }
            await ws.send(json.dumps(hello))

            done = asyncio.Event()
            recv_task = asyncio.create_task(_receive_loop(ws, done))

            try:
                await _send_audio(ws, session_id, wav, args.chunk_ms, args.rate_limit)
                # Wait briefly for trailing finals before saying bye so we
                # don't truncate the last utterance.
                await asyncio.sleep(2.0)
                await ws.send(json.dumps({"type": "client_bye", "sessionId": session_id}))
                try:
                    await asyncio.wait_for(done.wait(), timeout=5.0)
                except TimeoutError:
                    print("warning: never received session_ended within 5s")
            finally:
                recv_task.cancel()
                try:
                    await recv_task
                except (asyncio.CancelledError, Exception):
                    pass
    return 0


def main() -> int:
    args = _parse_args()
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
