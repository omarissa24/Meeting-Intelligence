# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Meeting Intelligence — a cross-platform desktop app that captures meeting audio, transcribes it, and produces LLM-summarised intelligence. Reference docs:

- `docs/tech-stack.md` — chosen stack and the two guiding constraints (every external dependency hides behind an interface; LangGraph orchestrates from day one).
- `docs/Meeting_Intelligence_Architecture.docx` — system architecture.
- `docs/Meeting_Intelligence_Development_Phases.docx` — phased build plan.

The repo is in the pre-implementation phase: there is no `src/` or `src-tauri/` yet. When scaffolding either, follow the tech-stack doc exactly — do not substitute libraries.

## Stack at a glance

- **Desktop shell**: Tauri v2 (Rust) + React 18 + TypeScript + Vite, shadcn/ui + Tailwind, Zustand (local), React Query (server).
- **Native audio**: ScreenCaptureKit (macOS) / WASAPI (Windows), webrtc-vad, 16kHz mono PCM.
- **Backend**: Python 3.12 + FastAPI (native WS), Celery, WorkOS auth, Pydantic everywhere.
- **STT**: Deepgram Nova-3 (MVP, multilingual code-switching) and Faster-Whisper (on-prem), both behind a `STTProvider` interface.
- **LLM/orchestration**: Claude Sonnet via Anthropic Python SDK, LangGraph for the map-reduce pipeline and all future agents.
- **Data**: Postgres 16 + pgvector, Redis 7 (Celery broker + stream buffer), S3/R2 for audio, Alembic for migrations.
- **Infra**: Docker Compose locally, Fly.io for MVP, AWS ECS/Fargate + RDS + ElastiCache for prod, GitHub Actions builds backend + signed desktop binaries on release tags.

## Required skills and when to invoke them

This repo bundles three pinned skills under `.agents/skills/` (manifest at `skills-lock.json`). Treat their `SKILL.md` files as authoritative — read the relevant one before doing matching work.

| Work matches…                                          | Use skill           |
| ------------------------------------------------------ | ------------------- |
| New UI surface, page, or distinctive visual treatment  | `frontend-design`   |
| Any shadcn component, registry add, theming, forms     | `shadcn`            |
| `src-tauri/`, Rust commands, IPC, capabilities, bundle | `tauri-v2`          |

The `shadcn` skill is `user-invocable: false` — don't try to `/shadcn` it. Read `.agents/skills/shadcn/SKILL.md` and follow the CLI workflow it prescribes (always start with `npx shadcn@latest info`, check `components.json` before adding, use `--dry-run`/`--diff` for updates, never guess a registry).

When `frontend-design` and `shadcn` overlap: use the `shadcn` rules for **composition and structure** (FieldGroup over div+space-y, semantic colors over raw, `gap-*` over `space-*`, etc.) and let `frontend-design` drive **typography, motion, atmosphere, and conceptual direction**. They do not conflict — one governs primitives, the other governs taste.

## Design system continuity

Once a typography pair, color palette, and motion vocabulary are chosen for this app, **reuse them**. Do not re-roll the aesthetic for each new screen. Concretely:

- The first frontend phase establishes the design system in the Tailwind CSS file pointed to by `npx shadcn@latest info` (`tailwindCssFile`). Edit that file — never create a parallel CSS file.
- Subsequent screens must consume those CSS variables via shadcn's semantic tokens (`bg-background`, `text-muted-foreground`, `bg-primary`, etc.). No hardcoded hex, no per-screen palette riffs.
- If a new screen genuinely needs a new token (e.g. `--color-transcript-speaker-2`), add it to the same CSS file and use it semantically — don't inline the value.
- The `frontend-design` skill's "don't converge on AI defaults" guidance applies to the **initial** aesthetic choice. After that choice exists, consistency beats novelty.

## MCP servers

Two MCP servers are registered at the user scope and should be used for the work each is designed for. Run `claude mcp list` if you need to confirm which servers are currently connected.

### Context7 — documentation lookups

Use Context7 MCP for any library, framework, SDK, API, CLI, or cloud-service question — including the ones in this stack (Tauri, React, shadcn, FastAPI, Celery, LangGraph, Anthropic SDK, Deepgram, pgvector, WorkOS, etc.). Two-step flow:

1. `resolve-library-id` with the library name + the user's question (skip only if the user gave an exact `/org/project` ID).
2. `query-docs` with the chosen ID and the user's full question.

Prefer this over web search for library docs. Don't use it for refactoring, debugging business logic, or general programming concepts.

### Magic (21st.dev) — UI component inspiration & generation

Use the `magic` MCP (`@21st-dev/magic`) when you need a starting point for a **new** UI surface — component variants to react to, layout inspiration, or a generated scaffold to refine. Useful tools:

- `21st_magic_component_inspiration` — browse curated references before committing to a direction.
- `21st_magic_component_builder` — generate a component scaffold from a brief.
- `21st_magic_component_refiner` — iterate on an existing component.
- `logo_search` — fetch brand logos when wiring up connector / integration screens.

**Workflow — Magic is the inspiration layer, not the implementation layer:**

1. Use Magic to explore options and surface a direction.
2. Translate the chosen direction into the project's actual primitives via the `shadcn` skill (FieldGroup/Field, semantic tokens, the established palette — see [Design system continuity](#design-system-continuity)).
3. Apply taste and polish via the `frontend-design` skill.

Do **not** paste Magic output verbatim into the codebase: it will use generic colors, raw Tailwind classes, and components the project hasn't installed. Rewrite imports to the project's aliases, swap raw colors for semantic tokens, and replace styled divs with the equivalent shadcn primitives before committing.

## Progress tracking — keep `TODO.md` in sync

`TODO.md` is the authoritative checklist of every user story, functional requirement, and Definition of Done item across all 5 phases (sourced from `docs/Meeting_Intelligence_Development_Phases.docx`).

- **When a piece of work is finished, cross it out in `TODO.md` in the same commit.** Flip `- [ ]` to `- [x]` for the user story, every acceptance criterion under it, the matching functional requirement IDs (`FR-X.YY`), and any DoD items it just satisfied. If a single change closes out items at multiple levels, tick all of them.
- A phase is only complete when **every** box in its `Definition of Done — Phase N Exit Criteria` section is ticked. Do not start a later phase while an earlier phase still has unticked DoD items.
- If an AC, FR, or DoD item becomes obsolete or is intentionally descoped, do **not** silently tick it — strike through with `~~text~~` and add a one-line note (e.g. `~~- [ ] FR-2.11~~ — descoped, see ADR-003`) so the trail is auditable.
- Do not add new tasks to `TODO.md` ad hoc. The list mirrors the phases doc; if scope genuinely changes, update the docx (or its replacement) first, then reflect the change here.

## Architectural invariants

Both come from `docs/tech-stack.md` — preserve them in every PR:

1. **External services live behind interfaces.** STT (`STTProvider`), LLM, object storage, and auth must each be swappable via config. Do not call Deepgram/Anthropic/S3/WorkOS SDKs directly from feature code — go through the interface.
2. **LangGraph is the orchestrator from day one.** The MVP summarisation pipeline is a LangGraph map-reduce. Phase-5 MCP connectors (Gmail, Outlook, Calendar, Salesforce, HubSpot, Jira, Asana) are new graph nodes — not a parallel system. Don't introduce a second orchestration layer.

## Tauri specifics (when `src-tauri/` exists)

These are the failure modes the `tauri-v2` skill is designed to prevent — keep them top-of-mind:

- All app logic lives in `src-tauri/src/lib.rs`. `main.rs` is a thin passthrough so mobile builds (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`) work.
- Every command must be in `tauri::generate_handler![...]` or it silently fails from the frontend.
- Every plugin needs its permission string in `src-tauri/capabilities/default.json` — Tauri v2 denies by default.
- Async commands take owned types (`String`), never `&str`.
- Frontend imports from `@tauri-apps/api/core` (v2), not `@tauri-apps/api/tauri` (v1).

## Commands

The monorepo standardises on **pnpm 9** (JS workspaces) and **uv** (Python). Node 22 LTS, Python 3.12, Rust stable.

### Desktop (`apps/desktop`)

```bash
pnpm install                                              # at repo root, installs JS workspace deps
pnpm tauri:dev                                            # opens the Tauri window (needs Rust toolchain + bundle icons)
pnpm --filter @meeting-intelligence/desktop tauri:build   # signed/unsigned bundle (run via desktop-release.yml in CI)
pnpm --filter @meeting-intelligence/desktop typecheck
pnpm --filter @meeting-intelligence/desktop build         # Vite-only web build
```

First-time Tauri dev needs platform icons in `apps/desktop/src-tauri/icons/`. Generate them from any 1024×1024 source PNG:

```bash
pnpm --filter @meeting-intelligence/desktop tauri icon path/to/source.png
```

### shared-types (`packages/shared-types`)

```bash
pnpm --filter @meeting-intelligence/shared-types typecheck
```

### Backend (`backend/`)

```bash
cd backend
uv sync                                                   # creates .venv + uv.lock
uv run uvicorn meeting_intelligence.main:app --reload     # http://localhost:8000/health
uv run pytest
uv run ruff check
uv run mypy src
```

### Local infra (`infra/`)

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis   # data plane only
docker compose -f infra/docker-compose.yml up                     # full stack incl. backend container
docker compose -f infra/docker-compose.yml down -v                # tear down + wipe volumes
```

### Repo-wide

```bash
pnpm typecheck       # all JS workspaces
pnpm build           # all JS workspaces (no Tauri bundle)
pnpm format          # prettier write
pnpm format:check    # prettier check
```
