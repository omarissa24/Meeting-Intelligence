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
