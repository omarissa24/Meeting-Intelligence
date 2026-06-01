# Real macOS End-to-End with Deepgram — Runbook

This is the first time the full chain (mac mic + system audio → Tauri →
backend WS → Deepgram Nova-2 → live transcript) is meant to actually
run with a real API key. Use this runbook to bring it up, watch the
telltale log lines, and read the latency numbers honestly.

## Prereqs

- A real `DEEPGRAM_API_KEY` (free tier is fine for smoke tests).
- macOS 13+ with Microphone and Screen Recording permission already granted to the dev build.
- `pnpm install` at repo root, `cd backend && uv sync`, Rust stable.

## Env setup

```bash
cp backend/.env.example backend/.env
cp apps/desktop/.env.example apps/desktop/.env
```

Edit `backend/.env`:
- `STT_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY=<your real key>`
- `LOG_LEVEL=DEBUG` (optional — turns on per-chunk + per-event lines)

`apps/desktop/.env` defaults to `localhost:8000`; nothing to change unless your backend lives elsewhere.

## Three-terminal flow

**Terminal 1 — backend**
```bash
cd backend
uv run uvicorn meeting_intelligence.main:app --reload --port 8000
```

**Terminal 2 — desktop**
```bash
pnpm tauri:dev
```

**Terminal 3 — replay driver (no-mic feedback loop)**

`scripts/replay_audio.py` drives the WS with a WAV file. Useful for testing without speaking. The WAV must be 16 kHz mono 16-bit PCM — generate one if needed:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=60" -ac 1 -ar 16000 -sample_fmt s16 /tmp/test.wav
# better: download a real speech sample, then convert it the same way.
pnpm replay /tmp/test.wav
```

## Success path — what the logs say

Backend (chronological):
```
INFO meeting_intelligence.transcript transcript.ws_open session_id=… provider=deepgram-nova-2
INFO meeting_intelligence.transcript transcript.session_started session_id=…
INFO meeting_intelligence.stt.deepgram_nova deepgram.connect session_id=…
DEBUG meeting_intelligence.transcript transcript.chunk_recv session_id=… seq=0 bytes=32000
DEBUG meeting_intelligence.transcript transcript.event_emit session_id=… is_final=False speaker=spk-0 latency_ms=412
DEBUG meeting_intelligence.transcript transcript.event_emit session_id=… is_final=True  speaker=spk-0 latency_ms=687
…
INFO meeting_intelligence.stt.deepgram_nova deepgram.disconnect session_id=…
INFO meeting_intelligence.transcript transcript.latency_summary session_id=… p50_ms=620 p95_ms=1180 n=42
INFO meeting_intelligence.transcript transcript.ws_close session_id=… final_lines=42 duration_ms=63012
```

Desktop devtools console:
```
[latency] e2e_ms=712 text=Okay let's pick this up where we left off
[latency] e2e_ms=655 text=I want to walk through the rollout plan…
```

## Failure modes

### Bad Deepgram API key

Backend:
```
ERROR meeting_intelligence.stt.deepgram_nova deepgram.recv_failed session_id=… err=… 401
ERROR meeting_intelligence.transcript transcript.stt_failure session_id=… code=STT_PROVIDER_FAILURE msg=…
```

Desktop:
- A non-recoverable `error` frame arrives via the transcript WS.
- A system note appears in the transcript: `Speech-to-text service unavailable. Session stopped.`
- The session auto-stops and the Record button returns to its idle state.
- The reconnecting WS client does **not** retry — the WS is closed with code 1011 (Internal Error) and `STTProviderError` is non-recoverable by definition. (Network-side WS bounces are still handled by the Phase-1 reconnect slice.)

### Network blip during a session

Same path as above — Deepgram SDK raises mid-stream, route catches `STTProviderError`, emits the same error frame, closes 1011. The desktop reaction is identical.

### Audio drops on the desktop side

Surfaced via the existing `audio://error` event with `code=AUDIO_DROP`, `recoverable=true`. The session keeps running; a sonner warning toast appears (rate-limited to once per 10 s in Rust). Two paths:
- **Tauri emit failure** — frontend can't keep up with chunks; rare in practice.
- **Pipeline output channel full** — DSP thread can't push fast enough; usually means VAD is wrongly detecting voice in everything or chunk_rx isn't being drained.

## Microphone gain

macOS defaults the input-volume slider to ~50%, which lands typical speech around -24 dBFS peak — quiet enough that Nova-2 starts dropping words. The pipeline applies a static **+6 dB** boost on the mic path between the downmix and the mixer, which lifts speech to ~-18 dBFS (Deepgram's sweet spot). The boost is logged at session start:

```
audio/pipeline: mic gain = +6.0 dB (linear ~1.995)
```

**Override with `MIC_GAIN_DB`.** Set this env var before launching `pnpm tauri:dev` to use a different value:

```bash
MIC_GAIN_DB=12 pnpm tauri:dev   # +12 dB ~4x; for very quiet mics
MIC_GAIN_DB=0  pnpm tauri:dev   # disable boost; for already-loud mics
MIC_GAIN_DB=-3 pnpm tauri:dev   # negative = attenuate; clip-safe for hot mics
```

Invalid values (`garbage`, `NaN`, empty) log a warning and fall back to +6 dB.

**Verifying it's working.** Compare the two level-meter rows in the dev-console output:
- `audio/level mic_raw` — what the mic device emits before any gain.
- `audio/level mic_resampled` — post-gain, what's sent to the mixer/encoder/STT.

The gap between `mic_raw peak` and `mic_resampled peak` should match the configured gain (~6 dB by default). A larger or smaller gap signals a regression.

**Known limitation: clipping on loud mics.** The encoder hard-clamps at ±1.0 (`encoder.rs::f32_to_i16`). Users with high macOS input volume + +6 dB will hear mild clipping on loud syllables. Accepted trade for Phase 1 — the polished real-time level meter (US-25a) and AGC-style dynamic gain are deferred. If a user reports clipping, set `MIC_GAIN_DB=0` for them as a workaround.

## Reading the latency numbers honestly

Two complementary metrics:

| Metric | Where measured | What it includes |
|---|---|---|
| `[latency] e2e_ms` (desktop console) | between `client.send(audio_chunk)` and the `transcript_line isFinal=true` arrival | network desktop→backend, Deepgram processing, network back, desktop receive |
| `transcript.event_emit ... latency_ms=…` and `latency_summary p50/p95` (backend) | between the most recent `audio_chunk` receipt and the `send_transcript_event` call | only Deepgram processing + our serialization |

Expect the backend p95 to be 100–200 ms lower than the desktop e2e p95 — that's the round-trip the desktop sees.

**Caveats**:
- We do **not** use Deepgram's `start`/`duration` fields for latency. Those are session-relative — useful for word timing, not for "how long did the user wait?".
- The latest-`audio_chunk` heuristic is not strictly correct: an interim event may correspond to audio sent several seconds ago. We log per-final only in the rolling p50/p95 because finals end at a known utterance boundary; this gives a clean number that approximates user-perceived latency without per-seq accounting.

## What counts as a pass for FR-1.08

The plan says ≤1.5 s display latency. Operational target for this slice:
- **Backend `latency_summary p95_ms ≤ 1500`** over a ≥60 s sample of real speech.
- **Desktop `[latency] e2e_ms`** observable median around the backend p50 + 100 ms.

If either fails, **leave FR-1.08 unticked**. Paste the measured numbers into a one-line note above the FR-1.08 entry in `TODO.md` so the next slice has a starting point (e.g. `observed p95=1820ms; investigate utterance_end_ms tuning`).

## Troubleshooting

- **No `transcript.chunk_recv` lines despite talking** — Check the desktop's connection status (footer dot) is green. Check `LOG_LEVEL=DEBUG`. If the WS is open but no chunks arrive, the Rust pipeline may be filtered to silence (VAD too aggressive). Speak louder; check `vad_drop_ratio` in the stop reply.
- **`session_started` then nothing** — Deepgram connect succeeded but emits nothing; usually means the audio is silence (VAD dropped everything) or the stream is malformed. Try `pnpm replay` with a known-good speech WAV.
- **Frequent `STT_PROVIDER_FAILURE`** — Inspect the included error message; common causes are rate limits, expired keys, region routing.
- **`AUDIO_BACKPRESSURE` error frames** — Backend can't keep up. Check that Deepgram is actually yielding events (look for `deepgram.recv_failed` upstream). Otherwise the chunks queue up to 64-deep before the route emits backpressure.
