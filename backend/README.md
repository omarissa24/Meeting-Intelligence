# Meeting Intelligence — Backend

FastAPI gateway + (eventually) LangGraph orchestration + Celery worker. uv-managed.

## Prerequisites

- Python 3.12
- [uv](https://github.com/astral-sh/uv) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

## Quick start

```bash
cp .env.example .env

# Install deps + create .venv
uv sync

# Run the dev server
uv run uvicorn meeting_intelligence.main:app --reload

# In another terminal — sanity check
curl http://localhost:8000/health
# → {"status":"ok"}
```

## Tests / lint / typecheck

```bash
uv run pytest
uv run ruff check
uv run mypy src
```

## STT provider selection

`STT_PROVIDER` picks the implementation injected by `api/deps.py`:

- `echo` (default) — `InMemoryEchoSTT`. No key required; the route emits a
  synthetic ticker and echoes any `audio_chunk` as a fake transcript line.
- `deepgram` — `DeepgramNovaSTT` streaming against Nova-2. Requires
  `DEEPGRAM_API_KEY` in `.env`; the route streams real audio_chunks through.

```dotenv
# backend/.env
STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
```

To verify end-to-end without native capture, use the bundled WAV replay tool.
Source audio must be 16 kHz mono 16-bit PCM (convert with
`ffmpeg -i in.mp3 -ar 16000 -ac 1 -acodec pcm_s16le out.wav`):

```bash
uv run python scripts/replay_audio.py /tmp/sample.wav
```

The script connects as a real WS client, streams the WAV at real-time
cadence, and prints each `transcript_line` as it arrives.

## Layout

```
backend/
├── src/meeting_intelligence/
│   ├── main.py            # FastAPI app factory
│   ├── config.py          # Pydantic Settings
│   ├── api/               # HTTP/WS routers
│   └── interfaces/        # STT, LLM, ObjectStorage, Auth — invariant #1
└── tests/
```

Per CLAUDE.md invariant #1, every external service sits behind an interface
in `interfaces/`. Do not call Deepgram / Anthropic / S3 / WorkOS SDKs directly
from feature code — go through the interface.
