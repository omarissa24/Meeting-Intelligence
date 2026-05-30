# Meeting Intelligence

Cross-platform desktop app that captures meeting audio, transcribes it, and produces LLM-summarised intelligence.

See `docs/` for the architecture, phased build plan, and tech-stack rationale.
Conventions and invariants for contributors (human or AI) live in `CLAUDE.md`.

## Monorepo layout

```
meeting-intelligence/
├── apps/
│   └── desktop/          # Tauri v2 + React 18 + TS + Vite
├── packages/
│   └── shared-types/     # TS types mirrored from Pydantic models (manual until codegen lands)
├── backend/              # FastAPI (Python 3.12, uv-managed)
├── infra/                # Docker Compose, future Terraform
└── .github/workflows/    # CI/CD
```

## Prerequisites

- **Node** 22+ (LTS) and **pnpm** 9+
- **Rust** stable (`rustup`)
- **Python** 3.12 and **uv** (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- **Docker** (for Postgres + Redis locally)
- macOS 13+ or Windows 10+ for native audio capture (Phase 1+)

## Quick start

```bash
# 1. Install JS workspace deps
pnpm install

# 2. Run the desktop app (opens a Tauri window)
pnpm tauri:dev

# 3. In another terminal — start backend services
docker compose -f infra/docker-compose.yml up -d postgres redis

# 4. In another terminal — run the FastAPI backend
cd backend
uv sync
uv run uvicorn meeting_intelligence.main:app --reload
# → http://localhost:8000/health
```

## Per-package scripts

| Surface       | Command                                                      |
| ------------- | ------------------------------------------------------------ |
| Desktop dev   | `pnpm --filter @meeting-intelligence/desktop tauri:dev`      |
| Desktop build | `pnpm --filter @meeting-intelligence/desktop tauri:build`    |
| Typecheck all | `pnpm typecheck`                                             |
| Backend tests | `cd backend && uv run pytest`                                |
| Backend lint  | `cd backend && uv run ruff check && uv run mypy src`         |

## Where to read next

- `CLAUDE.md` — conventions, invariants, when to use the bundled skills.
- `docs/tech-stack.md` — chosen stack and the two guiding constraints.
- `docs/Meeting_Intelligence_Architecture.docx` — system architecture.
- `docs/Meeting_Intelligence_Development_Phases.docx` — phased build plan.
- `TODO.md` — authoritative checklist of every user story, FR, and DoD across all 5 phases.
