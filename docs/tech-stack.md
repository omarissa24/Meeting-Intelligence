## Desktop

**Tauri** (Rust + WebView) — the shell. **React 18 + TypeScript + Vite** for the UI. **shadcn/ui + Tailwind CSS** for components. **Zustand** for local state, **React Query** for server state.

---

## Audio Capture (Rust, native)

**ScreenCaptureKit** on macOS, **WASAPI** on Windows. **webrtc-vad** for silence filtering. Raw PCM mixed to 16kHz mono before transmission.

---

## Backend

**Python 3.12 + FastAPI** with native WebSocket support. **Celery** for background jobs. **WorkOS** for auth (email/password, Google OAuth, enterprise SSO/SAML). **Pydantic** for schema validation throughout.

---

## Speech-to-Text

**Deepgram Nova-3** for MVP (streaming WebSocket, speaker diarisation built in, multilingual code-switching via `language=multi`). **Faster-Whisper** (self-hosted) for the enterprise on-prem tier. Both sit behind a `STTProvider` interface.

---

## LLM & Orchestration

**Claude claude-sonnet-4-20250514** (Anthropic) for summarisation. **LangGraph** for orchestrating the map-reduce pipeline and all future agents. **Anthropic Python SDK** for API calls.

---

## Data

**PostgreSQL 16** with the **pgvector** extension for semantic search. **Redis 7** as the Celery broker and streaming buffer. **AWS S3** (or Cloudflare R2) for audio files and transcript archives. **Alembic** for database migrations.

---

## Infrastructure

**Docker + Docker Compose** for local dev. **Fly.io** for MVP hosting (WebSocket-native). **AWS ECS/Fargate + ALB + RDS + ElastiCache** for production. **GitHub Actions** for CI/CD — builds the backend deploy and the signed desktop binaries (macOS .dmg + Windows .msi) on every release tag.

---

## Observability

**Sentry** for error tracking (frontend + backend). **OpenTelemetry** for distributed tracing → **Grafana/Tempo**. **Prometheus** metrics → **Grafana** dashboards. **Flower** for Celery worker monitoring.

---

## Phase 5 additions

**MCP connectors** for Gmail, Outlook, Google Calendar, Salesforce, HubSpot, Jira, Asana. OAuth tokens stored in the OS credential store (Keychain / Windows Credential Manager).

---

The two guiding constraints behind every choice: everything external (STT, LLM, storage) is behind an interface so enterprise swaps are config changes, and LangGraph sits at the orchestration center from day one so the MCP agents in Phase 5 are new nodes, not a rewrite.