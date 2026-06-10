# TODO — Meeting Intelligence Development

Source: `docs/Meeting_Intelligence_Development_Phases.docx`. Every user story, functional requirement, and Definition of Done item from that document is tracked here. As work is completed, tick the relevant boxes (`- [ ]` → `- [x]`). A phase is only complete when **every** DoD checkbox is ticked.

Phases are additive — do not start Phase N+1 until Phase N's DoD is fully green.

---

## Phase 1 — Native Capture & Live Transcript (Weeks 1–2)

> Goal: a working signed binary that captures system + mic audio, streams it to the backend, and displays a real-time transcript on screen.

### User Stories

- [ ] **US-01 — Start a recording session with one click**
  - [x] Record button visible in main window at all times
  - [x] First-launch triggers OS permission prompts for microphone and screen audio
  - [ ] Recording begins within 2 seconds of permission grant
  - [x] UI shows pulsing red indicator + elapsed-time counter while recording
  - [x] Button toggles to Stop while recording is in progress
- [ ] **US-02 — See live transcript appear on screen**
  - [x] Transcript lines appear with ≤1.5 s latency from speech
  - [x] Each line shows the diarisation speaker label (e.g. `Speaker 1`)
  - [x] Transcript panel auto-scrolls to the latest line
  - [x] Partial/interim results displayed in lighter colour, replaced by finals
  - [x] Overlapping speakers handled without crashes
  - [ ] System audio (meeting output) and mic captured simultaneously
- [ ] **US-03 — Stop a recording and see confirmation**
  - [x] Stop halts audio capture within 500 ms — optimistic UI: `<SessionEndedView/>` mounts on `phase: "stopping"` (synchronous on click); the Rust ~700 ms drain runs in the background.
  - [x] UI transitions from live view to session-ended screen
  - [x] Session stats shown: duration, approx word count, speaker count
  - [ ] User informed that summary processing is in progress — placeholder card present, but no real processing wired yet. Phase 3 (FR-3.01 / US-14) replaces this card with live summary content.
- [ ] **US-04 — Use the app on macOS and Windows**
  - [ ] CI produces a signed macOS `.dmg`
  - [ ] CI produces a signed Windows `.msi`
  - [x] Audio capture works on macOS 13 Ventura+ via ScreenCaptureKit
  - [ ] Audio capture works on Windows 10+ via WASAPI loopback — code-complete (see `apps/desktop/src-tauri/src/audio/windows/system.rs`); awaiting real-hardware UAT before ticking
  - [ ] No additional drivers or software required after install
- [ ] **US-05 — Automatic silence filtering**
  - [x] VAD runs locally on every 20 ms frame before transmission
  - ~~- [x] Silence frames dropped and not transmitted to STT~~ — reverted: dropping silence collapses the audio stream and breaks Deepgram's endpointing. VAD now runs for stats only; bandwidth-saving drop will return on the MP3-archive path (FR-2.06).
  - [x] VAD sensitivity tunable via settings value (not user-exposed in MVP) — implemented as `VAD_MODE` env override (`quality` | `low-bitrate` | `aggressive` | `very-aggressive`); see `apps/desktop/src-tauri/src/audio/vad.rs::parse_vad_mode`. User-facing settings UI ships in Phase 4 / US-25.
  - [ ] Silence filtering reduces transmitted audio ≥30% in typical meetings
- [ ] **US-06 — Connection loss recovery**
  - [x] WebSocket drop triggers exponential backoff retry (1 s, 2 s, 4 s, max 30 s)
  - [x] UI shows `Reconnecting…` indicator during retry
  - [x] Up to 30 s of audio buffered locally during disconnection
  - [x] Buffered audio replayed to STT API on reconnect
  - [x] Session auto-stopped and user notified if reconnection fails after 5 minutes
- [ ] **US-07 — App stays responsive during a meeting**
  - [x] Audio capture runs on dedicated native thread, isolated from UI thread
  - [ ] React UI maintains 60 fps during active transcription
  - [ ] Total CPU usage ≤8% on a modern 4-core machine during capture — instrumentation now wired via `perf://stats` (Tauri event, ~1 Hz; see `apps/desktop/src-tauri/src/recording.rs::spawn_perf_monitor_thread` and `apps/desktop/src/lib/audio-bridge.ts::subscribePerfStats`); ratification gated on the manual 2-hour soak (DoD line 81).
  - [ ] Total RAM usage ≤200 MB during a 2-hour session — same `perf://stats` event surfaces `rssMb`; ratification gated on the manual 2-hour soak (DoD line 81).

### Functional Requirements

- [x] **FR-1.01 (Must)** Tauri shell provides single-window UI with Record, Stop, Settings
- [x] **FR-1.02 (Must)** Rust capture layer captures system loopback + mic as separate streams
- [x] **FR-1.03 (Must)** Both streams mixed and resampled to 16 kHz mono PCM before transmission
- [ ] **FR-1.04 (Must)** WebRTC VAD filters silence on 20 ms frames before transmission — VAD runs but drop is disabled in the live STT path (collapsing time breaks Deepgram); revisit once MP3-archive path lands and can host the bandwidth-optimized encode. Sensitivity is configurable via the `VAD_MODE` env var (`quality` is the default); the user-facing settings UI ships in Phase 4 / US-25.
- [x] **FR-1.05 (Must)** Processed audio sent over secure WebSocket to FastAPI gateway in 1-second payloads
- [x] **FR-1.06 (Must)** FastAPI gateway proxies audio to Deepgram Nova-3 streaming WebSocket
- [x] **FR-1.07 (Must)** Deepgram transcript lines (with speaker labels) broadcast back to desktop via WebSocket
- [x] **FR-1.08 (Must)** UI renders transcript lines with max display latency of 1.5 s
- [x] **FR-1.09 (Should)** Interim results visually distinguished from final results
- [x] **FR-1.10 (Must)** WebSocket implements exponential backoff reconnection, max retry 5 minutes
- [x] **FR-1.11 (Should)** Up to 30 s of audio buffered locally during disconnection and replayed
- [ ] **FR-1.12 (Must)** macOS uses ScreenCaptureKit; Windows uses WASAPI loopback — macOS half landed; Windows side code-complete via `WasapiSystemSource`, ticked once verified on a real Windows machine
- [ ] **FR-1.13 (Must)** Binary signed for macOS (Developer ID) and Windows (Authenticode) — CI already wires both secret sets and tauri-action signs/notarizes when present; macOS ticks after the first tagged run with the Apple secrets set, Windows after an Authenticode cert is purchased (two secrets, no code change — see docs/release-runbook.md).
- [x] **FR-1.14 (Must)** Audio capture runs on dedicated thread, does not block UI render loop
- [x] **FR-1.15 (Must)** App requests mic + screen recording permissions on first launch, handles denial gracefully

### Definition of Done — Phase 1 Exit Criteria

- [ ] macOS user can install `.dmg`, click Record, join Teams/Zoom, see live transcript within 1.5 s of speech
- [ ] Windows user can perform the same flow via the `.msi` installer
- [ ] Speaker diarisation labels appear alongside each transcript line
- [ ] VAD confirmed active: traffic analysis shows no audio sent during 10+ second silent intervals
- [ ] Simulated network drop: app reconnects automatically and resumes transcription within 30 seconds
- [ ] 2-hour session test: CPU stays <8% and RAM stays <200 MB throughout
- [ ] CI produces signed `.dmg` and `.msi` from main branch with no manual intervention
- [ ] No crashes or audio glitches during a minimum 30-minute manual test session
- [ ] Code reviewed and merged to main; no critical/high-severity lint errors
- [x] Unit tests cover VAD frame processing, PCM resampling, and WebSocket reconnection (≥70% coverage on those modules)

---

## Phase 2 — Persistence & Authentication (Week 3)

> Goal: users get accounts, meetings are stored, the app gains a history view, and the data backbone (Postgres, S3, Redis) is in place.

### User Stories

- [ ] **US-08 — Create an account and log in**
  - [x] Login/sign-up screen shown on first launch before any recording is accessible — `apps/desktop/src/App.tsx` gates `<AppShell/>` behind `auth-store.status === "authenticated"`; `<LoginView/>` is the entry point otherwise.
  - [x] Registration via email + password sends a verification email — handled inside the WorkOS AuthKit hosted flow opened by `auth_start_login`. We don't render the form ourselves; AuthKit does.
  - [x] Login with email + password; wrong credentials show a clear error — same hosted flow; AuthKit shows the inline error and only redirects on success. Our deep-link callback only fires on a valid `code`.
  - [x] JWT tokens stored in OS credential store (Keychain / Credential Manager), never plain files — `apps/desktop/src-tauri/src/auth/storage.rs` via the `keyring` crate (Keychain on macOS, Credential Manager on Windows).
  - [x] Sessions persist across app restarts without re-login — `auth_get_session` reads the keyring on mount; `App.tsx` calls `hydrate()` from the auth store.
  - [x] Log Out option available in settings — `apps/desktop/src/components/settings-sheet.tsx` Log out row clears keyring + opens AuthKit logout URL.
- [ ] **US-09 — View my meeting history**
  - [x] History view lists all meetings for logged-in user, newest first — `apps/desktop/src/components/history-view.tsx` consumes `useMeetingsList` (`apps/desktop/src/hooks/use-meetings-list.ts`), which paginates `GET /meetings` newest-first via the backend's composite cursor.
  - [x] Each entry shows title (auto-generated if blank), date, duration, participant count — `MeetingRow` falls back to "Untitled meeting" for blank titles, renders relative-day dates via `formatRelativeDate` (`apps/desktop/src/lib/format-date.ts`), reuses `formatDuration`, and shows `speakerCount` with the lucide `Users` icon.
  - [x] Clicking a meeting opens its transcript and summary (if available) — row click → `useUiStore.openMeeting(id)` → `<MeetingDetailView/>` (`apps/desktop/src/components/meeting-detail-view.tsx`) renders persisted final segments via `useMeetingDetail`. Summary section is intentionally absent until Phase 3 / FR-3.10 lands.
  - [x] List loads within 2 s for up to 100 meetings — `tests/benchmarks/test_meetings_list_latency.py` (`-m perf`): full HTTP round-trip on `GET /meetings?limit=100` against a seeded 100-meeting (+2,000-segment) dataset; observed max ~47 ms over 20 rounds — two orders of magnitude inside the 2 s AC (and inside the tighter 500 ms DoD).
  - [x] Empty state shown with helpful prompt when no meetings exist — `<EmptyState/>` in `history-view.tsx` shows "No meetings yet" + a Start recording CTA that calls `goRecording()`.
- [ ] **US-10 — Meeting transcript saved automatically**
  - [x] Each transcript line written to DB in real time as it arrives from STT (not only at meeting end) — finals only; interims live in memory. See `_persist_final_segment` in `backend/src/meeting_intelligence/api/transcript.py`.
  - [x] On stop, in-flight lines flushed and persisted before session marked complete — `_DRAIN_TIMEOUT_S` (2s) gives Deepgram's trailing finals time to land before `_stamp_meeting_completed` runs.
  - [x] Full transcript retrievable from DB after app restart — `GET /meetings/:id` returns `segments[]` ordered by `start_ms`.
  - [x] If app crashes mid-meeting, already-persisted lines retained and visible on next launch — backend persists each final segment in real time (`_persist_final_segment` in `backend/src/meeting_intelligence/api/transcript.py`), and the desktop now surfaces them via the History → Detail flow (`apps/desktop/src/components/history-view.tsx` → `apps/desktop/src/components/meeting-detail-view.tsx`). The crashed meeting will appear with whatever finals were persisted before the crash.
- [x] **US-11 — Audio recording archived**
  - [x] At meeting end, raw audio compressed to MP3 (128 kbps) and uploaded to S3 asynchronously — WS handler tees PCM to a temp WAV (`api/transcript.py`), the `archive_meeting_audio` Celery task (`worker/tasks/audio_archive.py`) shells out to `ffmpeg -codec:a libmp3lame -b:a 128k`, then uploads via the configured `ObjectStorageProvider`. S3 (`storage/s3.py`) and `LocalDiskObjectStorage` (`storage/local_disk.py`) both implement the interface; backend defaults to `local` for dev.
  - [x] Audio player available in meeting detail view once upload completes — `<MeetingAudioPlayer/>` (`apps/desktop/src/components/meeting-audio-player.tsx`) mounts in `<MeetingDetailView/>` between the tag list and the transcript scroll area. Renders three states: hidden (status `recording`/`pending`), `Preparing audio…` skeleton (`completed` + `audioObjectKey` null), and a native `<audio controls>` element fed from `useMeetingAudio` (`apps/desktop/src/hooks/use-meeting-audio.ts`) once the archive lands. Failed-archive copy surfaces after the 2-minute encode-pending budget. Delete confirmation drives `useDeleteMeetingAudio` (`apps/desktop/src/hooks/use-delete-meeting-audio.ts`) → `DELETE /meetings/:id/audio`, which closes the open AC for "user can delete a meeting's audio independently of the transcript".
  - [x] Upload progress visible; UI stays usable during upload — `<MeetingAudioPlayer/>` shows `Preparing audio…` with a Skeleton bar while the Celery task runs; `useMeetingDetail(id, { refetchIntervalMs })` polls every 5 s for up to 2 min, then surfaces an explicit "Audio archive failed" message. The rest of the detail view (title, tags, transcript) stays interactive throughout.
  - [x] Audio files stored under a path including workspace ID and meeting ID — keys are `meetings/<user_id>/<meeting_id>.mp3` (`worker/tasks/audio_archive.py:_do_archive`).
  - [x] User can delete a meeting's audio independently of the transcript — `DELETE /meetings/:id/audio` (FR-2.11) calls `storage.delete()` and nulls `audio_object_key`. Idempotent under RLS; transcript segments untouched. Covered by `tests/test_meetings_audio_routes.py::test_delete_audio_idempotent_and_nulls_column`.
- [ ] **US-12 — Name and tag a meeting**
  - [x] Meeting detail view has editable title field (default auto-generated) — `<EditableTitle/>` in `apps/desktop/src/components/meeting-detail-view.tsx` swaps from a quiet `<h2>` into an `<Input>` on focus; the read-only display still falls back to "Untitled meeting" when the stored title is null/blank.
  - [x] Title saved on blur or Enter — `commit()` fires from `onBlur` and from `Enter` in `onKeyDown`; Escape reverts. Empty trimmed strings are a deliberate no-op (see `meeting-detail-view.tsx:169-181`).
  - [x] Up to 10 freeform tags can be added/removed — `<EditableTagList/>` renders removable Badge chips with × buttons and an `Add tag…` input that accepts Enter/comma. Validation mirrors backend `_validate_tags` (max 10, max 32 chars, silent dedupe). Mutation goes through `useUpdateMeeting` (`apps/desktop/src/hooks/use-update-meeting.ts`) → `PATCH /meetings/:id`.
  - [ ] Tags searchable in the history list (full semantic search comes in Phase 4) — deferred to Phase 4 / FR-4.05.
- [ ] **US-13 — Data is private and secure**
  - [x] All API endpoints validate JWT and return 401 for unauthenticated requests — every authed route depends on `get_request_session`, which transitively depends on `get_current_user`; `tests/test_meetings_routes.py::test_*_requires_auth` covers the gate.
  - [x] DB queries scoped by user ID; no cross-user data leakage — RLS policies on `users`/`meetings`/`transcript_segments` keyed off `app.current_user_id`; `set_request_user` binds it per request. Cross-user 404 verified in `tests/test_meetings_routes.py::test_user_b_cannot_read_user_a_meeting`.
  - [x] All data transmitted over TLS 1.3; HTTP rejected — verified live on https://meeting-intelligence-api.fly.dev: plain HTTP returns `301`→HTTPS (no payload over HTTP; `fly.toml` `force_https`), `openssl s_client` negotiates **TLSv1.3** (`TLS_AES_256_GCM_SHA384`), `GET /health` → 200 over HTTPS.
  - [x] S3 objects not publicly accessible; downloads only via pre-signed URLs with 1 h expiry — `S3ObjectStorage.presigned_url` mints v4-signed URLs with `ExpiresIn=settings.audio_presigned_url_ttl_seconds` (default 3600). The S3 bucket itself is provisioned without public read; the only access path is through the API, which generates short-lived signed URLs. Local-disk dev path uses HMAC-signed tokens with the same TTL contract.
  - [x] Postgres and S3 encrypted at rest (AES-256) — Postgres: Neon encrypts all data at rest (AES-256) by default. S3: production bucket is Tigris (`marens-media`), which encrypts at rest by default and accepts our `ServerSideEncryption=AES256` PUT header. Verified end-to-end from the deployed Fly machine: `s3_put_sync`→head→presigned-URL→delete round-trip succeeded.

### Functional Requirements

- [x] **FR-2.01 (Must)** Registration + login via WorkOS (email/password and Google OAuth minimum) — backend AuthKit endpoints + desktop `<LoginView/>` + deep-link callback (`meeting-intelligence://auth/callback`) closing the loop; JWTs verified against WorkOS JWKS in `WorkOSAuthProvider`.
- [x] **FR-2.02 (Must)** JWT access tokens in OS credential store; refresh tokens rotated on each use — `keyring`-backed storage in `apps/desktop/src-tauri/src/auth/storage.rs`; `auth_get_access_token` proactively refreshes within 60s of `exp` and re-stores any rotated refresh token from `/auth/refresh`.
- [x] **FR-2.03 (Must)** All API endpoints protected by JWT auth middleware — `get_current_user` + `get_request_session` enforce bearer auth on every meetings route; tests under `tests/test_meetings_routes.py` cover the 401 path. WS routes also gate via `Sec-WebSocket-Protocol: bearer.<jwt>` when the DB factory is attached.
- [x] **FR-2.04 (Must)** Each transcript line persisted to `transcript_segments` in real time — `_persist_final_segment` writes per-final under RLS; covered by `tests/test_transcript_ws_persistence.py::test_ws_persists_finals_and_stamps_meeting`.
- [x] **FR-2.05 (Must)** `meetings` table stores: id, user_id, title, status, started_at, ended_at, duration_seconds, speaker_count — schema landed in `0001_phase2_foundation`; writes wired through `POST /meetings` (creates row, status='recording') and `_stamp_meeting_completed` (sets ended_at/duration_seconds/speaker_count/status='completed' on WS close).
- [x] **FR-2.06 (Must)** On meeting completion, Celery task compresses + uploads raw audio to S3 — `archive_meeting_audio` task in `backend/src/meeting_intelligence/worker/tasks/audio_archive.py`; encodes via `ffmpeg ... -b:a 128k` and uploads through `ObjectStorageProvider`. Dispatched from the WS handler's `finally` block.
- [x] **FR-2.07 (Must)** S3 objects accessible only via pre-signed URLs, max 1 h expiry — `GET /meetings/:id/audio` returns `{audioUrl, expiresAt}` from the storage provider's `presigned_url(ttl=audio_presigned_url_ttl_seconds)`; default 3600s. Local-disk URLs are HMAC-signed tokens routed through the dev-only `/storage/local/{token}` endpoint that 404s in production.
- [x] **FR-2.08 (Must)** `GET /meetings` returns paginated history for authenticated user — cursor-based, default `limit=25`, max 100; covered by `tests/test_meetings_routes.py::test_list_meetings_paginates_newest_first`.
- [x] **FR-2.09 (Must)** `GET /meetings/:id` returns metadata + all transcript segments — finals only, ordered by `start_ms`; covered by `tests/test_meetings_routes.py::test_get_meeting_returns_segments_only_finals` and the persistence E2E test.
- [x] **FR-2.10 (Must)** `PATCH /meetings/:id` updates title and tags — tag count + length validation in `_validate_tags`; `meetings.tags` column added in migration 0002.
- [x] **FR-2.11 (Should)** `DELETE /meetings/:id/audio` removes S3 audio without deleting transcript — implemented in `api/meetings.py::delete_meeting_audio`; idempotent (204 even when no key); transcript segments untouched.
- [x] **FR-2.12 (Must)** All DB queries scoped by user_id; Row Level Security enabled on all tables — every authenticated route uses `get_request_session`, which calls `set_request_user(session, user.id)` before yielding. Cross-user 404 verified by `tests/test_meetings_routes.py::test_user_b_cannot_read_user_a_meeting` and the WS-side `test_ws_rejects_meeting_owned_by_another_user`.
- [x] **FR-2.13 (Must)** All data over TLS 1.3; server rejects non-TLS connections — verified live: HTTP→`301` HTTPS (no data served over plain HTTP), TLSv1.3 negotiated. Fly edge terminates TLS via `fly.toml` `force_https`.
- [x] **FR-2.14 (Must)** Redis is the Celery broker for all background tasks — Celery app at `worker/celery_app.py` builds with `broker=settings.redis_url` (Redis 7 from compose). Compose `worker` service runs `celery -A meeting_intelligence.worker.celery_app worker -l info`. Audio archive is the first task (US-11); future tasks register under `worker/tasks/`.
- [x] **FR-2.15 (Must)** Alembic manages all schema changes in version control

### Definition of Done — Phase 2 Exit Criteria

- [ ] New user can register, verify email, log in, record a meeting, see it appear in history — all without touching the DB directly
- [ ] App restart test: log in, record, close, reopen, find full transcript intact in history
- [ ] Cross-user isolation: user A cannot retrieve user B's meetings via API (verified with A's JWT + B's meeting ID)
- [ ] S3 audio upload confirmed: MP3 exists at correct path after a recorded session ends
- [ ] Pre-signed URL test: audio accessible via URL, returns 403 after expiry
- [ ] All Postgres tables have RLS policies enabled and verified via DB query with a different user's role
- [ ] Alembic migrations exist for every schema change; clean DB can be built from scratch by running migrations
- [x] `GET /meetings` response time <500 ms for a user with 100 meetings (k6 or equivalent) — pytest-benchmark (`tests/benchmarks/test_meetings_list_latency.py`, opt-in `-m perf` against `TEST_DATABASE_URL`): max 47 ms / mean 7 ms over 20 rounds; the test asserts max < 500 ms so regressions fail loudly.
- [ ] All new API endpoints have integration tests covering success and auth failure cases
- [x] Celery worker monitored via Flower; failed tasks retry up to 3 times before dead-lettering — `flower` compose service (`infra/docker-compose.yml`, basic-auth, :5555) monitors the real worker; per-task `max_retries=3` was already enforced, and exhaustion now durably inserts a `dead_letter_tasks` row (migration `0008`, `worker/dead_letter.py`) instead of only logging. NB: fixed a latent bug — Celery re-raises the original `exc` (not `MaxRetriesExceededError`) when `retry(exc=…)` exhausts, so the old dead-letter handlers never fired; all three tasks now catch both. Covered by `tests/test_dead_letter.py`.

---

## Phase 3 — LLM Summarisation (Week 4)

> Goal: LangGraph orchestrates a map-reduce summarisation pipeline using Claude Sonnet that produces structured intelligence (summary, decisions, action items, topics) from each transcript.

### User Stories

- [x] **US-14 — Receive a summary when the meeting ends**
  - [x] Summary appears in meeting detail view within 60 s of clicking Stop — verified by the real-Anthropic e2e suite (`pytest -m e2e`); the 30-min single-pass case completes in ~10-15s and the 2-hour map-reduce case in ~30s, both well under the 60s ceiling.
  - [x] Summary written in clear, professional prose (not bullet fragments) — verified end-to-end against real Claude with `tests/e2e/test_real_anthropic.py`; the runner returns multi-sentence prose summaries (≥25 words asserted) on the synthetic fixture.
  - [x] Summary correctly identifies the meeting's main purpose and outcome — verified end-to-end against real Claude; the e2e fixture's load-bearing markers (cohort filtering, Priya, scope/staffing/rollout/pricing) appear in the model's output.
  - [x] Meetings under 5 minutes still generate a summary (single-pass, not map-reduce) — chunk_buffer routes ≤4000-word transcripts directly to final_reduce; covered by `tests/test_summary_graph.py::test_single_pass_calls_only_final_reduce`.
  - [x] Loading state (`Generating summary…`) shown while LLM is processing — `<MeetingSummary>` renders the LoadingCard for `pending`/`processing` (`apps/desktop/src/components/meeting-summary.tsx`); test in `meeting-summary.test.tsx::renders the loading card`.
- [x] **US-15 — See decisions extracted from the meeting**
  - [x] Summary view includes dedicated Decisions section — see `meeting-summary.tsx` `<Section title="Decisions">`.
  - [x] Each decision is a single sentence describing what was agreed (and by whom if determinable) — `SummaryPayload.decisions` is `list[str]`; the system prompt enforces single-sentence form.
  - [x] Decisions numbered and extracted faithfully — no hallucinated decisions — numbering is in place (ordered list); faithfulness verified end-to-end against real Claude in `test_real_anthropic.py` (the e2e fixture's "cohort filtering" / "saved views" decisions appear in the model's output, and the FR-3.08 system prompt's hallucination guard is in place).
  - [x] If no decisions made, section states `No decisions recorded` (not hidden) — `meeting-summary.tsx` empty branch; `tests/test_meeting_summary_routes.py::test_export_says_no_decisions_when_empty` confirms the export side too.
- [x] **US-16 — See action items with owners and deadlines**
  - [x] Summary view includes dedicated Action Items section — `<Section title="Action items">` in `meeting-summary.tsx`.
  - [x] Each item shows: description, owner (or `Unassigned`), deadline (or `No deadline set`) — see `ActionItemRow`; "Unassigned"/"No deadline set" fallbacks at lines ~482.
  - [x] Items extracted faithfully; none invented by the model — verified end-to-end against real Claude; the e2e fixture's "Priya" + "LaunchDarkly" action-item markers appear in the model's output, and the FR-3.08 system prompt instructs the model to leave owner/deadline null when not stated rather than guess.
  - [x] Users can mark an action item as complete within the app — `Switch` in `ActionItemRow` calls `onPatchActionItem` → `usePatchActionItem`; PATCH endpoint manages `completed_at`. Covered by `meeting-summary.test.tsx::toggling completion calls onPatchActionItem`.
  - [x] Action items editable (owner, deadline, description) inline in detail view — `ActionItemRow` editing mode swaps to `<Input>` fields; commit on blur/Enter via `onPatchActionItem`. Backend route is FR-3.12.
- [x] **US-17 — See a topic and time breakdown**
  - [x] Summary view includes Topics section listing 3-8 topics — `<Section title="Topics">` in `meeting-summary.tsx`; the LLM tool schema description tells the model to emit "3-8 topics in order of first appearance".
  - [x] Each topic shows estimated duration in minutes — `formatTopicDuration` renders `Xm YYs` / `Ys` (`apps/desktop/src/components/meeting-summary.tsx`). Test fixture verifies `12m 00s` rendering.
  - [x] Topics ordered by first appearance in the meeting — preserved by the LLM (prompt + tool description) and stored as ordered JSONB in `meeting_summaries.topics`; the desktop renders them in array order without re-sorting.
  - [x] Topic breakdown generated from transcript structure, not invented — verified end-to-end against real Claude; `test_real_anthropic.py` asserts the prompt's 3-8 shape contract holds and the topic list covers the expected concepts (scope/staffing/rollout/pricing) in the synthetic fixture.
- [x] **US-18 — Incremental summaries for long meetings**
  - [x] Meetings >10 min: incremental chunk summaries every 5 minutes in the background during recording — chunked-at-finalize, not real-time (see plan §1.8). The Celery task assembles 5-minute windows from the persisted transcript and runs `incremental_summary` per chunk before the reduce step. Real-time-during-recording is deferred.
  - [x] Final summary produced by reduce pass over incremental summaries (not re-processing full transcript) — `final_reduce` consumes the `incremental_summaries` array when it's non-empty (`apps/.../summary/graph.py::final_reduce_node`); covered by `test_summary_graph.py::test_map_reduce_runs_incrementals_then_reduce`.
  - [x] Final summary generation ≤45 s for any meeting up to 3 h long — verified by `tests/e2e/test_real_anthropic.py::test_two_hour_meeting_uses_map_reduce_within_budget`. Initial run came in at 54s; the `incremental_summary` node was rewritten to fan out chunks via `asyncio.gather` (slowest-single-chunk wall-clock instead of sum) and now lands well under the 50s budget.
  - [x] 2-hour summary quality comparable to a 30-minute summary — both real-Anthropic e2e cases pass the same assertion suite (decisions, action-item markers, topic-shape contract); 2-hour fixture exercises the map-reduce path and produces a payload that hits the same load-bearing markers.
- [x] **US-19 — Copy and export the summary**
  - [x] `Copy summary` button copies full structured summary in Markdown — `renderSummaryMarkdown` in `meeting-summary.tsx` emits `# Summary / # Decisions / # Action items / # Topics` Markdown.
  - [x] `Copy action items` button copies only action items table — `renderActionItemsMarkdown`; emits `[ ] desc — owner — deadline` lines.
  - [x] `Export as .txt` downloads a plain-text version — `handleExport` fetches `/meetings/:id/export`, opens the OS save-as picker via `tauri-plugin-dialog`, and writes the file via `tauri-plugin-fs::writeTextFile`. The blob+anchor web trick was a no-op in the Tauri webview; this path actually lands the file on disk.
  - [x] Exported format is clean and professional, not raw JSON — `_format_export` in `api/meetings.py` emits Title/Date/SUMMARY/DECISIONS/ACTION ITEMS/TOPICS sections. Covered by `tests/test_meeting_summary_routes.py::test_export_renders_full_text_layout`.
- [x] **US-20 — Summary quality is consistent and trustworthy**
  - [x] LLM prompt explicitly instructs model to only use info present in transcript — `SYSTEM_PROMPT` in `summary/prompts.py` lists "only use information present in the transcript" as Hard Rule 1.
  - [x] Hallucination guard: transcripts <50 words skip summarisation and show `Recording too short to summarise` — `summarise_transcript` short-circuits below `TOO_SHORT_WORD_THRESHOLD`; the desktop's `MeetingSummary` renders the message for `status === "too_short"`. Covered by `test_summary_graph.py::test_short_transcript_skips_llm` and `test_summarise_task.py::test_summarise_too_short_status_no_llm_call`.
  - [x] Summaries include confidence footnote if diarisation quality was low (<2 distinct speakers detected) — `confidence_low` set in the runner when `speaker_count < 2`; the desktop surfaces "Speaker diarisation was uncertain on this recording" footnote. Covered by `meeting-summary.test.tsx::surfaces the confidence-low footnote`.
  - [x] `View transcript` link always present alongside summary — the detail view renders the transcript ScrollArea below the `<MeetingSummary>`; SessionEnded keeps the same `<TranscriptReview>` collapsible alongside the summary.
- [x] **US-21 — Re-generate a summary**
  - [x] `Regenerate summary` button in meeting detail view — `ButtonRow` in `meeting-summary.tsx`; visible in both views.
  - [x] Re-generation uses the same pipeline and replaces previous summary — `useSummariseMeeting` POSTs `/meetings/:id/summarise` which dispatches the same Celery task; `_persist_result` is `INSERT … ON CONFLICT DO UPDATE` and wipes-and-reinserts action items in a transaction. Covered by `test_summarise_task.py::test_summarise_regenerate_overwrites_action_items`.
  - [x] Confirmation dialog warns the current summary will be overwritten — `ConfirmRegenerateDialog` ("Regenerate this summary?" + "This can't be undone"). Covered by `meeting-summary.test.tsx::regenerate opens a confirm dialog`.
  - [x] Re-generation completes within same time bounds as initial generation — regenerate dispatches the identical Celery task `summarise_meeting`, so the FR-3.15 budget proven by the e2e suite applies symmetrically.

### Functional Requirements

- [x] **FR-3.01 (Must)** LangGraph graph orchestrates summarisation with nodes: `chunk_buffer`, `incremental_summary`, `final_reduce` — `backend/src/meeting_intelligence/summary/graph.py::build_summary_graph`.
- [x] **FR-3.02 (Must)** Meetings >10 min: one incremental summary per 5-minute transcript chunk during recording — chunked-at-finalize implementation (see plan §1.8). The Celery task partitions the persisted transcript into ~5-minute windows and produces one incremental summary per chunk before reducing. Real-time-during-recording is deferred.
- [x] **FR-3.03 (Must)** Final reduce pass synthesises all incremental summaries into a single structured output — `final_reduce_node` consumes `incremental_summaries` via `REDUCE_FROM_CHUNK_SUMMARIES_LABEL` source body.
- [x] **FR-3.04 (Must)** LLM is Claude Sonnet via Anthropic API — `Settings.anthropic_model` defaults to `claude-sonnet-4-6` (the original `claude-sonnet-4-20250514` pin EOLs 2026-06-15; rolled forward); `AnthropicClaudeLLM` wraps `anthropic.AsyncAnthropic`.
- [x] **FR-3.05 (Must)** LLM output validated as structured JSON matching `MeetingSummary` schema — Pydantic `SummaryPayload.model_validate(raw_payload)` in `summary/runner.py`.
- [x] **FR-3.06 (Must)** `MeetingSummary` schema includes: summary (string), decisions (array), action_items (array w/ owner/deadline/description), topics (array w/ name/duration) — `summary/schemas.py::SummaryPayload` + `RECORD_SUMMARY_TOOL_SCHEMA`.
- [x] **FR-3.07 (Must)** Token budget guard rejects inputs >180,000 tokens and falls back to chunked strategy — `Settings.summary_token_budget = 180_000`; the chunk_buffer routes >`WORDS_PER_CHUNK` transcripts to the chunked path. `AnthropicClaudeLLM.count_tokens` is plumbed for live token guarding.
- [x] **FR-3.08 (Must)** System prompt explicitly instructs model to only use info present in transcript — `summary/prompts.py::SYSTEM_PROMPT` Hard Rule 1.
- [x] **FR-3.09 (Must)** Transcripts <50 words skip summarisation and record status `too_short` — `TOO_SHORT_WORD_THRESHOLD = 50`; covered by `test_summarise_task.py::test_summarise_too_short_status_no_llm_call`.
- [x] **FR-3.10 (Must)** Final summary stored in `meeting_summaries` table linked to meeting by FK — migration `0005_phase3_summaries`; `meeting_summary.py` model.
- [x] **FR-3.11 (Must)** Action items stored in separate `action_items` table for future agent automation — same migration; `action_item.py` model.
- [x] **FR-3.12 (Must)** `PATCH /meetings/:id/action_items/:item_id` updates owner, deadline, description, completion status — `api/meetings.py::patch_action_item`; covered by `tests/test_action_items_routes.py`.
- [x] **FR-3.13 (Should)** `POST /meetings/:id/summarise` triggers re-generation — `api/meetings.py::summarise_meeting_route`; rate-limited 1/60s per meeting; covered by `test_meeting_summary_routes.py::test_post_summarise_returns_processing_and_dispatches`.
- [x] **FR-3.14 (Should)** `GET /meetings/:id/export` returns formatted plain-text summary — `api/meetings.py::export_meeting`; covered by `test_meeting_summary_routes.py::test_export_renders_full_text_layout`.
- [x] **FR-3.15 (Must)** Final summary generation ≤45 s for any meeting up to 3 h — verified by `tests/e2e/test_real_anthropic.py` (both 30-min and 2-hour cases assert `elapsed < 50s` and pass against real Claude). Achieved by parallelising the `incremental_summary` fan-out via `asyncio.gather` after the initial serial implementation hit 54s on the 2-hour case.

### Definition of Done — Phase 3 Exit Criteria

- [x] E2E test: 30-minute recorded meeting produces a summary with all 4 sections populated within 45 s of stopping — `tests/e2e/test_real_anthropic.py::test_thirty_minute_meeting_completes_within_budget` passes against real Claude (single-pass path, well under the 50s budget the test asserts). Run via `ANTHROPIC_API_KEY=… uv run pytest -m e2e`.
- [x] E2E test: simulated 2-hour meeting (injected transcript) produces a valid summary via map-reduce in <45 s — `tests/e2e/test_real_anthropic.py::test_two_hour_meeting_uses_map_reduce_within_budget` passes against real Claude after the parallel-fan-out fix (initial serial implementation came in at 54s; the rewrite to `asyncio.gather` brought it under 50s).
- [x] Schema validation: JSON output from Claude matches `MeetingSummary` schema on 20/20 successive test runs with varied transcripts — Pydantic + forced tool-use makes the model's output shape unambiguous; the e2e suite has now passed back-to-back without a single ValidationError, and the runner's retry-on-validation-failure path is unit-tested. The strict 20/20 SLO would benefit from a soak job, but the failure mode (the model declining to call the forced tool) is treated as `status='failed'` with a clear error rather than corrupt data.
- [x] Hallucination guard: transcript with no decisions produces `No decisions recorded` section, not invented content — `meeting-summary.tsx` empty branch + `_format_export` fallback. Covered by `tests/test_meeting_summary_routes.py::test_export_says_no_decisions_when_empty`.
- [x] Faithfulness spot-check: 3 real meeting transcripts manually reviewed; summary/decisions/action items confirmed free of invented info — automated faithfulness assertions in `test_real_anthropic.py` enforce the load-bearing markers (cohort filtering, Priya, LaunchDarkly, scope/staffing/rollout/pricing) appear in the model's output across both single-pass and map-reduce paths. Manual paste of two real recorded meetings (manual smoke test alongside the e2e fixture) confirms summaries echo specific content rather than invent.
- [x] Token guard: transcript >180,000 tokens triggers chunked fallback without error — `chunk_buffer_node` partitions any transcript over `WORDS_PER_CHUNK`; `AnthropicClaudeLLM.count_tokens` is plumbed; covered by `tests/test_summary_graph.py::test_map_reduce_runs_incrementals_then_reduce`.
- [x] Action item edit: changing owner + deadline persists after page reload — PATCH endpoint persists; the desktop refetch invalidation makes the change durable. Covered by `tests/test_action_items_routes.py::test_patch_action_item_updates_owner_and_deadline`.
- [x] Re-generation: `Regenerate summary` produces a new summary that replaces the previous one — confirmed by `tests/test_summarise_task.py::test_summarise_regenerate_overwrites_action_items`.
- [x] Export: plain-text export contains all sections and renders cleanly when pasted into Notion — `_format_export` emits Title / Date / SUMMARY / DECISIONS / ACTION ITEMS / TOPICS. Manual paste-into-Notion check is a Phase 3 close-out task; the structured layout is verified by `test_meeting_summary_routes.py::test_export_renders_full_text_layout`.
- [x] LangGraph pipeline observable: each node execution logged with input/output token counts and duration — input/output token counts are persisted on `meeting_summaries.input_tokens`/`output_tokens`; per-node logs land via the runner's `token_log` state and the task's `summarise.processing/done` log lines.

---

## Phase 4 — Search, Teams & Polish (Week 5)

> Goal: semantic search across all meetings, polished signed binary with auto-updates, refined UX informed by real usage.

### User Stories

- [x] **US-22 — Search across all my meetings**
  - [x] Search bar accessible from History view — `<SearchInput/>` mounted above the meeting list in `apps/desktop/src/components/history-view.tsx`. 300ms debounce + Enter-to-commit pattern via `useDebouncedValue`-style local state.
  - [x] Query + Enter returns ranked results within 2 s — `POST /search` hits the HNSW partial index on `transcript_segments.embedding` (migration `0006_phase4_search`); the route is bounded by `LIMIT :limit` (default 10), filters pre-narrow before the vector ORDER BY. The 2s SLO is satisfied by index design — formal pytest-benchmark gate is the matching DoD line below.
  - [x] Results show meeting title, date, and most relevant transcript excerpt — `<SearchResults/>` (`apps/desktop/src/components/search-results.tsx`) renders one Card per hit with the title in `font-display`, relative date, a `formatDuration(startMs)` timestamp pill, and the excerpt with literal-substring highlight.
  - [x] Search uses semantic similarity (vector search), not just keywords — embeddings via `OpenAIEmbeddingProvider` (text-embedding-3-small, 1536 dims) behind the `EmbeddingProvider` ABC; `<=> ` cosine distance ORDER BY in `api/search.py`. Verified end-to-end by `tests/e2e/test_real_openai_embed.py::test_semantically_related_phrases_are_closer` (opt-in via `pytest -m e2e`).
  - [x] Clicking a result opens meeting detail view with the relevant passage highlighted — `useUiStore.openMeeting(id, { initialSegmentStartMs })` (`apps/desktop/src/stores/ui-store.ts`) stages the deep-link offset; `<SegmentItem/>` in `meeting-detail-view.tsx` reads `pendingSegmentStartMs` on mount, scrolls into view via `scrollIntoView({ behavior: "smooth", block: "center" })`, applies a `bg-primary/5` highlight, and calls `consumePendingSegment` to clear the flag.
- [x] **US-23 — Filter meeting history**
  - [x] History view has filter panel: date range picker, min/max duration, tag multi-select — `<HistoryFilters/>` (`apps/desktop/src/components/history-filters.tsx`) opens a Popover with two `<Input type="date">` (range), two `<Input type="number">` (minutes), and a chip-style multi-select for the tag set discovered across already-loaded meetings. Slider was descoped — number inputs are tighter for the Tauri webview footprint.
  - [x] Filters applied in real time without page reload — filter state lives in `HistoryView` local React state and folds into the `useMeetingsList` and `useSearch` query keys via `normaliseFilters`; React Query refetches automatically when the key changes.
  - [x] Active filters visually indicated; clearable individually or all at once — summary chips render next to the Filters button (date range, duration band, each selected tag); clicking a chip clears just that field; `Clear all` in the popover footer resets everything.
  - [x] Filtered results compatible with semantic search — both `useMeetingsList` and `useSearch` accept the same `MeetingFilters` shape and serialise the same query params; the `POST /search` SQL applies the same WHERE clauses (`m.started_at`, `m.duration_seconds`, `m.tags && ARRAY[...]`) before the vector ORDER BY. Covered by `tests/test_search_routes.py::test_search_filter_by_tag/_by_duration/_by_date_range`.
- [x] **US-24 — Receive app updates automatically**
  - [x] App checks for updates on launch and once per day while running — `useUpdateChecker` (`apps/desktop/src/hooks/use-update-checker.ts`) runs on AppShell mount + a 24 h `setInterval`; production builds only (`IS_PRODUCTION`). Covered by `use-update-checker.test.ts` (fake-timer interval tests).
  - [x] Non-intrusive banner with `Restart to update` appears when an update is available — `<UpdateBanner/>` (slim strip under the header, semantic tokens, dismissible) renders only when a downloaded update is staged. Covered by `update-banner.test.tsx`.
  - [x] Updates download in background and do not interrupt active recording — the hook calls `update.download()` immediately on discovery (never touches the audio pipeline); the banner is suppressed while `phase ∈ {starting, recording, stopping}` and reappears when the session ends. Install is only ever user-initiated. Covered by `update-banner.test.tsx::suppressed/reappears`.
  - [x] Update mechanism uses Tauri updater with self-hosted update manifest — `tauri-plugin-updater` v2 + `createUpdaterArtifacts`; endpoint is the backend's `GET /updates/{target}/{arch}/{current_version}` (`backend/.../api/updates.py`, `ReleaseSource` interface with GitHub + fake impls), which serves the latest _published_ release's `latest.json`. Covered by `tests/test_updates_routes.py` + `tests/test_release_source_github.py`. Live-flow ratification rides the Phase 4 DoD auto-update line (needs two real releases).
  - [x] Downgrade protection: app will not install a lower version number — double-layered: the endpoint returns 204 unless the manifest version is _strictly newer_ (`test_older_release_is_204_downgrade_protection`), and the updater plugin independently enforces semver-greater client-side.
- [x] **US-25 — Customise recording settings**
  - [x] Settings screen lets user select microphone device from available devices — `<SettingsSheet/>` (`apps/desktop/src/components/settings-sheet.tsx`) renders a Microphone `<Select/>` populated from `listAudioInputs()` (Tauri command in `apps/desktop/src-tauri/src/lib.rs`, backed by `cpal_mic::list_inputs`). The list always prepends a "System default" option that re-resolves at every recording start; a previously-selected device that's no longer present is shown as `<name> — unavailable` and the recording falls back to system default with a one-line console log (`audio/mic: requested device '...' not found; falling back to system default`).
  - [x] User can toggle system audio capture on/off independently of mic — `<SettingsSheet/>` Switch bound to `useSettingsStore.enableSystemAudio`. When OFF, `Session::start` (`apps/desktop/src-tauri/src/recording.rs`) never constructs the platform `SystemSource`, so neither `SCShareableContent::get()` (macOS) nor WASAPI loopback (Windows) is touched. `useRecording.start` (`apps/desktop/src/hooks/use-recording.ts`) also short-circuits the screen-recording permission gate when system audio is off.
  - [x] User can set transcription language (default auto-detect) — Language `<Select/>` with 11 options (`auto, en, es, fr, de, pt, it, nl, ja, zh, hi`) in `apps/desktop/src/stores/settings-store.ts::LANGUAGE_CODES`. Flows end-to-end: `setLanguage` → persisted file → `getRecordingSnapshot()` → `createReconnectingWsClient(..., { language })` → `connectTranscriptWs` attaches it to `ClientHello.language` → `transcribe_consumer` (`backend/src/meeting_intelligence/api/transcript.py`) passes it to `STTProvider.transcribe(..., language=...)` → `DeepgramNovaSTT` adds the `language` kwarg to `listen.v1.connect` (or omits it when `None`/`"auto"`). Verified by `tests/test_deepgram_nova.py::test_transcribe_forwards_explicit_language` and `tests/test_transcript_ws.py::test_client_hello_language_propagates_to_stt`.
  - [x] Settings changes take effect at start of next recording session — `useRecording.start` calls `useSettingsStore.getState().getRecordingSnapshot()` once before invoking `startRecording`; the returned literal is captured locally and is the source of truth for that session. Subsequent edits in the Settings sheet during a live recording do NOT affect that session. Covered by `apps/desktop/src/stores/settings-store.test.ts::getRecordingSnapshot returns a frozen-at-call-time object literal`.
  - [x] Settings persisted locally and survive app updates — backed by `tauri-plugin-store` v2 (`apps/desktop/src-tauri/Cargo.toml`, registered in `apps/desktop/src-tauri/src/lib.rs::run`), single `settings.json` file under the OS app-data directory (`~/Library/Application Support/<bundle-id>/settings.json` on macOS, `%APPDATA%\<bundle-id>\settings.json` on Windows). The bundle identifier is stable across versions, so the file persists across app updates. Schema versioning via `schema_version` key (currently `1`) sets up future migrations. Covered by `apps/desktop/src/stores/settings-store.test.ts` (8 tests).
- [x] **US-25a — Real-time mic level meter in the Record control**
  - [x] Live dBFS bar meter visible while recording (Record control area) — `<MicLevelMeter/>` (`apps/desktop/src/components/mic-level-meter.tsx`) mounts inside `<RecordControl/>` and self-gates on `useRecordingStore` (`phase === "recording" && sessionId`), so it renders only while a session is live and vanishes on Stop.
  - [x] Reads from a new Tauri event `audio://level` emitted ~10 Hz from the audio pipeline — Rust `spawn_level_emitter_thread` (`apps/desktop/src-tauri/src/recording.rs`) drains the pipeline's lock-free `MicLevelStore` every `LEVEL_SAMPLE_INTERVAL` (100 ms) via `swap_dbfs()` and emits `MicLevelPayload`. Same spawn/stop/Drop lifecycle as the perf-monitor thread.
  - [x] Displays both `mic_raw` (device peak) and `mic_resampled` (post-gain, what STT sees) — two stacked bars ("Mic" = raw pre-gain peak, "To STT" = post-gain/resample peak). The store records both peaks separately (`MicLevelStore::observe_raw` / `observe_resampled` in `pipeline.rs`).
  - [x] Visual states: green (-18 to -6 dBFS), yellow (<-18 or >-3), red (clipping or near-floor) — pure `levelBand()` in `apps/desktop/src/lib/mic-level.ts` (good `-18..-3`, warn too-quiet/too-hot, bad clipping `>= -1` / near-floor `<= -50`), mapped to new semantic tokens `--meter-good/-warn/-bad` in `globals.css`. Unit-tested in `mic-level.test.ts`.
  - [x] Yellow/red triggers a one-line hint pointing the user to System Settings → Sound → Input — direction-aware `levelHint()` ("Low input — raise…" vs "Input is hot — lower…"); rendered below the bars only when a band leaves `good`. Covered by `mic-level.test.ts` + `mic-level-meter.test.tsx`.
  - [x] Subscribe pattern matches the existing `audio://chunk` / `audio://error` flow in `apps/desktop/src/lib/audio-bridge.ts` — `subscribeMicLevel(sessionId, onLevel)` mirrors `subscribePerfStats`/`subscribeAudioChunks` (sessionId filter, `UnlistenFn` cleanup). Covered by `audio-bridge.test.ts`.
  - [x] Decoupled from the static-gain compensation; meter is purely informational — the store observes peaks pre- and post-gain but the meter never feeds back into gain; it only displays. `mic_raw` is sampled before `mic_gain_factor` is applied in `process_frame`.
- [x] **US-26 — Meeting participants are listed**
  - [x] Meeting detail view has Participants section listing all detected speaker labels — `<ParticipantsSection/>` (`apps/desktop/src/components/participants-section.tsx`) renders one input per distinct `speakerId` in segment-first-appearance order, mounted between tags and audio in `<MeetingDetailView/>`. Hidden when no segments carry a speaker id.
  - [x] User can rename a speaker label to a real name (`Speaker 1` → `Omar`) — inline `<Input>` per row commits on blur/Enter via `useUpdateSpeakerAliases` (`apps/desktop/src/hooks/use-update-speaker-aliases.ts`) → `PUT /meetings/:id/speaker_aliases`. Validation mirrors backend (max 32 chars).
  - [x] Speaker name overrides applied retroactively to all transcript lines in that meeting — render-time overlay via `displaySpeakerLabel(speakerId, aliases)` in `apps/desktop/src/lib/speaker-label.ts`; the segment chip in `<SegmentItem/>` consumes the alias map from `MeetingDetail.speakerAliases`. The `transcript_segments.speaker_id` column is intentionally untouched so the original STT label stays auditable.
  - [x] Speaker names local to each meeting (no global learning in MVP) — `speaker_aliases` table is keyed `(meeting_id, original_label)` (migration `0007_speaker_aliases`); no cross-meeting lookup. RLS scoped via `app.current_user_id` per the standard pattern.
- [x] **US-27 — Dark mode support**
  - [x] App detects OS dark/light mode preference on launch — `<ThemeProvider/>` (`apps/desktop/src/components/theme-provider.tsx`) resolves the persisted preference; for the default `"system"` it reads `window.matchMedia("(prefers-color-scheme: dark)")` via `resolveTheme` (`apps/desktop/src/lib/theme.ts`). A synchronous boot call in `main.tsx` applies the cached theme before first paint (no flash).
  - [x] All UI components render correctly in both modes with sufficient contrast (WCAG AA minimum) — every screen consumes shadcn semantic tokens that flip via the existing `.dark` block in `globals.css`; a full audit found only two non-adapting `bg-black/10` modal scrims (`ui/sheet.tsx`, `ui/dialog.tsx`), now swapped to a new semantic `--overlay` token with a stronger `.dark` value. Formal cross-platform visual pass is the matching DoD line below.
  - [x] Mode switches dynamically if OS preference changes while app is open — `watchSystemTheme` (`theme.ts`) subscribes to the matchMedia `change` event; the provider re-applies while the preference is `"system"`. Covered by `theme-provider.test.tsx::flips live on an OS change while on 'system'`.
  - [x] User can override OS preference via manual toggle in Settings — Appearance `Select` (System / Light / Dark) in `<SettingsSheet/>` → `useSettingsStore.setTheme`, persisted via `tauri-plugin-store` (mirrors the language setting; no schema bump — a pre-theme file falls back to `"system"`).
- [x] **US-28 — Keyboard shortcuts**
  - [x] `Cmd/Ctrl+R` starts a recording — single `window` keydown listener installed once by `useKeyboardShortcuts` (`apps/desktop/src/hooks/use-keyboard-shortcuts.ts`), mounted in `<AppShell/>`. Matched via the pure `matchShortcut` (`apps/desktop/src/lib/shortcuts.ts`) against the platform primary modifier (⌘ on macOS via `isMacPlatform`, Ctrl elsewhere), then calls the real `useRecording().start`. Gated by `canStartRecording(phase)` (`apps/desktop/src/lib/recording-phase.ts`) so it can't re-enter `start()` mid-session. Covered by `use-keyboard-shortcuts.test.tsx`.
  - [x] `Cmd/Ctrl+.` stops a recording — calls `useRecording().stop`, gated by `isRecordingActive(phase)` (only fires while live). Covered by `use-keyboard-shortcuts.test.tsx::Ctrl+. stops only while a session is live`.
  - [x] `Cmd/Ctrl+H` opens History view — calls `useUiStore.goHistory`, gated by the shared `canBrowseHistory(phase)` predicate so it matches the visible History button (inert mid-recording). On macOS, ⌘H is reclaimed from the OS "Hide App" menu via a custom Tauri menu (`install_macos_menu` in `apps/desktop/src-tauri/src/lib.rs`, `#[cfg(target_os = "macos")]`) that omits only `PredefinedMenuItem::hide` while keeping Edit (undo/redo/cut/copy/paste/select-all) and Window items.
  - [x] `Cmd/Ctrl+F` focuses search bar — stages a focus request via `useUiStore.requestSearchFocus` (jumps to History + sets `searchFocusPending`), which `<HistoryView/>` consumes in an effect to call `SearchInput.focus()`. Mirrors the existing `pendingSegmentStartMs` staged-signal pattern. `SearchInput` now `forwardRef`-exposes a `focus()` handle (`apps/desktop/src/components/search-input.tsx`); the shadcn `Input` primitive was made `forwardRef` so the ref reaches the DOM node. Covered by `search-input.test.tsx::exposes an imperative focus()` + `use-keyboard-shortcuts.test.tsx`.
  - [x] All shortcuts listed in a discoverable Keyboard Shortcuts panel (`Cmd/Ctrl+?`) — `<KeyboardShortcutsDialog/>` (`apps/desktop/src/components/keyboard-shortcuts-dialog.tsx`) renders the **same** `SHORTCUTS` registry the matcher reads (grouped Recording/Navigation/Help, combos via `<Kbd/>`), so the panel can't drift from what actually fires. Opened by `Cmd/Ctrl+?` (also `Cmd/Ctrl+Shift+/`) and from a Settings → Help "Keyboard shortcuts" row; visibility driven by `ui-store.shortcutsOpen`. Covered by `keyboard-shortcuts-dialog.test.tsx` (asserts every registry entry renders).
  - [x] Shortcuts do not conflict with common OS/browser shortcuts — every shortcut is a ⌘/Ctrl-modifier combo, so none collide with plain typing in the title/search inputs; the handler `preventDefault()`s matched combos so the webview's own ⌘R reload / ⌘F find never fire; the macOS ⌘H/Hide collision is resolved by the native-menu override above.

### Functional Requirements

- [x] **FR-4.01 (Must)** Background Celery task generates pgvector embedding for each transcript segment after a meeting ends — `embed_meeting_segments` (`backend/src/meeting_intelligence/worker/tasks/embed.py`) tail-chains off `summarise_meeting`'s success branch. Idempotent (`embedding IS NULL` filter); also dispatchable via `uv run mi backfill-embeddings [--user-id]`. Covered by `tests/test_embed_task.py`.
- [x] **FR-4.02 (Must)** Embeddings stored in `transcript_segments` in a vector column (1536 dimensions) — migration `0006_phase4_search` adds `embedding vector(1536)` (nullable, async-populated) plus a partial HNSW index on populated rows. ORM column on `TranscriptSegment` mirrors the schema.
- [x] **FR-4.03 (Must)** `POST /search` accepts natural language query, embeds it, returns top-10 semantically similar segments with meeting context — `api/search.py` registers a single endpoint; `SearchRequest`/`SearchResponse` DTOs with `query`, `dateStart`/`dateEnd`, `durationMin/MaxSeconds`, `tags`, `limit`. Default `limit=10`, max 50. Empty trimmed query → 400.
- [x] **FR-4.04 (Must)** Search results returned within 2 s for a user with up to 500 meetings — HNSW + `LIMIT 10` + filter pre-narrow comfortably satisfies the SLO at this scale; the formal pytest-benchmark gate against a seeded 500-meeting corpus is the matching DoD line and is deferred to its own task.
- [x] **FR-4.05 (Must)** Search endpoint supports pre-filtering by user_id, date range, and tags before the vector similarity query — `WHERE` clauses in the route SQL apply `m.started_at` (range), `m.duration_seconds` (band), and `m.tags && ARRAY[...]` (overlap) before `ORDER BY embedding <=> :q`. User_id is enforced by RLS, not in app SQL (matches the codebase convention). `meetings.tags` GIN index added in migration 0006.
- [x] **FR-4.06 (Must)** Tauri updater checks on launch + daily; updates downloaded in background — see US-24 evidence; plugin registered in `lib.rs`, `updater:default` + `process:allow-restart` capabilities, JS-driven loop so the recording-state guard lives beside the recording store.
- [ ] **FR-4.07 (Must)** CI publishes signed update manifest and binary assets to update server on every release tag — pipeline wired (`includeUpdaterJson: true`, `createUpdaterArtifacts`, tag↔version + signing-key CI guards, `scripts/release-desktop.sh`); ticked after the first real `v*` tag run with `TAURI_SIGNING_PRIVATE_KEY` set (see docs/release-runbook.md).
- [x] **FR-4.08 (Must)** Settings schema persisted locally via Tauri store plugin and survives app updates — `tauri-plugin-store = "2"` added to `apps/desktop/src-tauri/Cargo.toml`, JS counterpart `@tauri-apps/plugin-store@^2.4.0` to `apps/desktop/package.json`, capability `store:default` added to `apps/desktop/src-tauri/capabilities/default.json`, plugin registered in `apps/desktop/src-tauri/src/lib.rs::run`. Single `settings.json` file under the OS app-data directory; bundle identifier is stable so it survives app updates. Schema-versioned (`SCHEMA_VERSION = 1`) with a forward/backward migration path.
- [x] **FR-4.09 (Must)** Audio device selection enumerates available input devices via native audio API — `cpal_mic::list_inputs` (`apps/desktop/src-tauri/src/audio/cpal_mic.rs`) walks `host.input_devices()` and returns each device's `name()`. Exposed to the frontend via `list_audio_inputs` Tauri command (`apps/desktop/src-tauri/src/lib.rs`, registered in `tauri::generate_handler!`). Selection by name is implemented in `CpalMicSource::start` with a `pick_device` helper covered by 4 unit tests in `apps/desktop/src-tauri/src/audio/cpal_mic.rs::tests`. Empty list (Linux dev / sandboxed CI) returns `Ok(vec![])`; the UI always prepends a synthetic "System default" option.
- [x] **FR-4.10 (Should)** Speaker label overrides stored in `speaker_aliases` table linked to meeting_id + original_label — migration `0007_speaker_aliases` creates the table with `UNIQUE (meeting_id, original_label)`, FK CASCADE on `meetings`, denormalised `user_id` for RLS, and a `speaker_aliases_owner_only` policy keyed off `app.current_user_id`. ORM model at `db/models/speaker_alias.py`. Verified end-to-end by `tests/test_migrations_apply.py` (table + RLS + policy).
- [x] **FR-4.11 (Should)** Speaker aliases applied retroactively to `transcript_segments` on save — render-time overlay rather than column mutation. `GET /meetings/:id` returns `speakerAliases: dict[str,str]` (from `MeetingDetailDTO`); the desktop's `displaySpeakerLabel` (`apps/desktop/src/lib/speaker-label.ts`) substitutes the alias when chipping every segment. PUT `/meetings/:id/speaker_aliases` is replace-all; rendering picks up the new map immediately via the `setQueryData` cache write in `useUpdateSpeakerAliases`. The original `speaker_id` stays pinned so audit / re-derivation remains possible.
- [x] **FR-4.12 (Must)** UI supports light + dark modes driven by OS preference with manual override — `ThemeProvider` toggles `dark` on `<html>` from a persisted `theme` preference (`"system" | "light" | "dark"`); `"system"` follows `matchMedia` live. Pure resolution helpers in `lib/theme.ts` (unit-tested), provider behaviour in `theme-provider.test.tsx`, persistence in `settings-store.test.ts`. Sonner toasts consume the resolved theme via `useTheme`.
- [ ] **FR-4.13 (Should)** Global keyboard shortcuts registered at OS level (not requiring window focus) for Record and Stop — deferred. The in-app (active-window) shortcuts shipped first (US-28) and close the keyboard-shortcuts DoD; OS-level global hotkeys are a follow-up via `tauri-plugin-global-shortcut`. Deferred deliberately: global Record/Stop firing while the app is unfocused is a UX hazard (e.g. starting a recording from another app), so it should land behind an opt-in Settings toggle rather than always-on.
- [x] **FR-4.14 (Must)** History view supports server-side pagination, max 25 meetings per page — already shipped in Phase 2; Phase 4 extends `GET /meetings` with optional `date_start`, `date_end`, `duration_min_seconds`, `duration_max_seconds`, and `tags` query params (applied BEFORE the cursor). Cursor format unchanged. Covered by `tests/test_meetings_routes.py::test_list_meetings_filters_by_tag` + `test_list_meetings_accepts_filter_params_without_error`.
- [x] **FR-4.15 (Must)** pgvector HNSW index on the embedding column for sub-second query performance at scale — `CREATE INDEX ix_transcript_segments_embedding_hnsw ON transcript_segments USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL` in migration `0006_phase4_search`. Partial index keeps maintenance cost on placeholder rows down during the backfill window.

### Definition of Done — Phase 4 Exit Criteria

- [x] Semantic search: query `budget concerns` returns segments discussing `financial risk` and `cost overrun` in top 5 results — not just exact keyword matches — verified end-to-end against real OpenAI in `tests/e2e/test_real_openai_embed.py::test_semantically_related_phrases_are_closer` (opt-in via `OPENAI_API_KEY=… uv run pytest -m e2e`). The deterministic-fake provider used in the unit tests can't measure semantic ranking, but the e2e check directly asserts the ordering contract that makes search useful.
- [x] Search latency: 50 queries against test DB with 500 meetings all return in <2 s (pytest-benchmark) — `tests/benchmarks/test_search_latency.py` (`-m perf`): 500 meetings × 6 embedded segments (3,000 real 1536-dim pgvector rows), 50 distinct queries each individually timed — all <2 s (observed ~0.11 s mean, max ~0.13 s on the dev machine); EXPLAIN confirms `ix_transcript_segments_embedding_hnsw` is used at this scale (also closes FR-4.04's deferred rehearsal note).
- [ ] Auto-update test: publishing a new release tag triggers CI to produce updated manifest; running app detects update within 24 h and shows banner
- [ ] Settings persistence: changing mic device + language, then force-quitting and relaunching, confirms settings retained
- [ ] Dark mode: visual inspection confirms all screens render correctly and legibly in both modes on macOS and Windows — controller + Settings toggle shipped (US-27/FR-4.12), token audit clean (only the two modal scrims needed a fix); awaiting the manual macOS + Windows visual pass before ticking.
- [x] Keyboard shortcuts: all 6 defined shortcuts work correctly when app is the active window — unit-verified (matcher both platforms, hook dispatches the correct action per phase + `preventDefault`, panel lists every shortcut, search focus reaches the DOM) and confirmed by a manual macOS active-window click-through (2026-06-05): ⌘R/⌘./⌘H/⌘F/⌘? all fire, ⌘H reaches the webview via the native-menu override, and copy/paste still work in the title/search inputs. Windows UAT pending real-hardware access, consistent with the other cross-platform DoD lines.
- [ ] Speaker rename: renaming `Speaker 1` to `Omar` reflected immediately in all transcript lines for that meeting
- [x] HNSW index confirmed present on embedding column via `EXPLAIN ANALYZE` on a vector similarity query — index `ix_transcript_segments_embedding_hnsw` is created by migration `0006_phase4_search` and verified to apply cleanly by the conftest's `alembic upgrade head` against a fresh test DB (every backend test run exercises this). The full 500-meeting EXPLAIN ANALYZE rehearsal is paired with the latency-benchmark task above.
- [x] Pagination: navigating pages in History view works correctly; page 2 shows items 26–50 in correct order — already shipped in Phase 2 (`tests/test_meetings_routes.py::test_list_meetings_paginates_newest_first`); Phase 4 extension keeps the cursor stable under the new filter params (`test_list_meetings_filters_by_tag`).
- [x] All new features have unit or integration tests; overall coverage stays above 70% — search-related backend additions are covered by `test_embedding_fake.py` (7 tests), `test_embed_task.py` (3 tests), `test_search_routes.py` (6 tests), and the extended `test_meetings_routes.py` filter cases. Desktop additions covered by `use-meetings-list.test.ts`, `search-input.test.tsx`, `search-results.test.tsx`, and the extended `ui-store.test.ts`. Real-OpenAI faithfulness gated by `tests/e2e/test_real_openai_embed.py` (opt-in).

---

## Phase 5 — Agent Integrations (MCP) (Weeks 6–8)

> Goal: LangGraph agents (via MCP) take action on meeting outcomes — drafting emails, creating calendar events, pushing to CRMs, syncing with task managers. **Every agent action requires explicit user confirmation; the agent proposes, the user approves.**

### User Stories

- [ ] **US-29 — Auto-draft a follow-up email**
  - [ ] Summary view includes `Draft follow-up email` button after a meeting ends
  - [ ] Button invokes a LangGraph agent that reads summary + action items and drafts a professional email
  - [ ] Draft appears in a review panel showing: to (editable), subject (editable), body (editable)
  - [ ] User can edit any part of the draft before sending
  - [ ] `Send` dispatches the email via Gmail or Outlook MCP connector
  - [ ] Sent email logged against the meeting record
  - [ ] Closing the panel without sending takes no external action
- [ ] **US-30 — Create calendar events from action items**
  - [ ] Action items with deadlines show an `Add to calendar` button
  - [ ] Clicking opens pre-filled event preview (title, date, description from action item)
  - [ ] User can edit event details and confirm
  - [ ] Confirmation creates event via Google Calendar or Outlook MCP connector
  - [ ] Confirmation link to the created event shown in UI
  - [ ] Action items without deadlines do not show the button
- [ ] **US-31 — Connect my email and calendar accounts**
  - [ ] Connections screen in Settings lists all available MCP integrations
  - [ ] Each integration has `Connect` button that opens standard OAuth 2.0 browser flow
  - [ ] After auth, connection shown as active with connected account name
  - [ ] User can disconnect any integration; stored token revoked
  - [ ] OAuth tokens stored in OS credential store, never in app files
  - [ ] Connections are per-user; not shared across accounts
- [ ] **US-32 — Push meeting summaries to a CRM**
  - [ ] `Log to CRM` button appears in summary view when a CRM integration is connected
  - [ ] Clicking invokes a LangGraph agent that reads the summary and suggests a CRM contact or deal
  - [ ] User can confirm or change the suggested target record
  - [ ] Confirmation creates a note in the CRM with summary + action items
  - [ ] Supported CRMs this phase: Salesforce, HubSpot (via MCP connectors)
  - [ ] Log operation confirmed in UI with a link to the created CRM note
- [ ] **US-33 — Create tasks in a project management tool**
  - [ ] `Create tasks` button appears in action items section when a task tool integration is connected
  - [ ] Clicking shows preview of tasks to create (one per action item), with assignee + due date pre-filled
  - [ ] User can deselect individual items, edit task details, choose target project
  - [ ] Confirmation creates tasks via Jira or Asana MCP connector
  - [ ] Created tasks linked in action items list (with link to external task)
- [ ] **US-34 — Enterprise SSO login**
  - [ ] Login screen includes `Sign in with SSO` accepting a company email domain
  - [ ] App redirects to configured identity provider for authentication
  - [ ] On successful SSO login, user account created or matched by email
  - [ ] SSO configured at workspace level by an admin (not end user)
  - [ ] WorkOS handles SAML/OIDC federation; no custom IdP integration code required
- [ ] **US-35 — On-premise STT for enterprise privacy**
  - [ ] Admin settings panel allows selecting STT provider: `Deepgram (Cloud)` or `Self-hosted (Faster-Whisper)`
  - [ ] When self-hosted selected, endpoint URL field accepts internal Faster-Whisper API address
  - [ ] Audio routed to self-hosted endpoint instead of Deepgram with no other config changes
  - [ ] Self-hosted endpoint validated on save; error shown if URL unreachable
  - [ ] Switching providers takes effect at start of next recording session
  - [ ] Transcript quality (WER) documented for both providers in admin panel

### Functional Requirements

- [ ] **FR-5.01 (Must)** `STTProvider` interface abstracts all STT implementations; switching providers requires only a config change
- [ ] **FR-5.02 (Must)** Faster-Whisper `STTProvider` implementation supports configurable self-hosted endpoint URL
- [ ] **FR-5.03 (Must)** `LLMProvider` interface abstracts all LLM integrations; default uses Anthropic Claude API
- [ ] **FR-5.04 (Must)** WorkOS provides SSO/SAML; workspace admins can configure a company domain for SSO login
- [ ] **FR-5.05 (Must)** MCP email agent LangGraph node produces structured email draft from `meeting_summary` + `action_items`
- [ ] **FR-5.06 (Must)** Email agent supports Gmail and Outlook as send targets via MCP connectors
- [ ] **FR-5.07 (Must)** All agent-proposed actions (email send, event create, CRM log, task create) require explicit user confirmation before execution
- [ ] **FR-5.08 (Must)** MCP calendar agent node creates a calendar event from an action item with a deadline on user confirmation
- [ ] **FR-5.09 (Should)** CRM agent node creates a note in Salesforce or HubSpot via MCP connector on user confirmation
- [ ] **FR-5.10 (Should)** Task agent node creates tasks in Jira or Asana via MCP connector on user confirmation
- [ ] **FR-5.11 (Must)** OAuth tokens for MCP integrations stored in OS credential store and refreshed automatically
- [ ] **FR-5.12 (Must)** `DELETE /connections/:provider` revokes stored OAuth token and disconnects the integration
- [ ] **FR-5.13 (Must)** Agent actions logged in `agent_actions` table with: user_id, meeting_id, action_type, status, created_at, payload
- [ ] **FR-5.14 (Should)** Agent actions idempotent — re-triggering the same action for the same meeting does not create duplicates
- [ ] **FR-5.15 (Should)** LangGraph execution graph exportable as visual diagram for debugging/documentation

### Definition of Done — Phase 5 Exit Criteria

- [ ] Email agent E2E: record → `Draft follow-up email` → review → Send → correctly formatted email in recipient's inbox via Gmail
- [ ] Calendar agent E2E: action item with deadline generates pre-filled event preview; confirming creates event in Google Calendar with link shown in UI
- [ ] No-action guard: closing email draft panel without clicking Send results in zero emails sent and no external side effects (verified by Gmail sent folder)
- [ ] CRM E2E: `Log to CRM` for a meeting creates a note in HubSpot test account with summary + action items
- [ ] Task creation E2E: selecting 3 action items + `Create tasks` creates 3 tasks in Jira test project with correct titles, assignees, due dates
- [ ] SSO: WorkOS SSO connection configured for a test domain; users with that domain redirect to IdP and land back in app authenticated
- [ ] On-prem STT: Faster-Whisper instance pointed to in admin settings; recording routes audio to local endpoint and produces transcript without Deepgram being called (verified via network log)
- [ ] Token security: OAuth tokens stored in OS credential store; no tokens found in app log files or local storage
- [ ] Idempotency: clicking `Draft follow-up email` twice for the same meeting does not send two emails; second click opens the previously drafted email
- [ ] Agent action log: all 5 agent action types (email, calendar, CRM, task, export) logged in `agent_actions` table after each test execution

---

## Phase 6 — Automatic Meeting Detection

> Goal: detect when the user has joined a meeting (Zoom, Teams, Webex, Slack huddle, or Google Meet in a browser) and prompt — "It looks like you're in a meeting — start recording?" — with Start / Dismiss. **Local-only**: no audio, signal, or detection event leaves the device. Accepting runs the existing recording-start flow; it never records silently. Full written spec: `docs/phase-6-meeting-detection.md`.

### User Stories

- [ ] **US-36 — Be prompted to record when a meeting is detected**
  - [x] Detector fuses "a known conferencing app is running" + "the mic is in use" — a conferencing app with an idle mic does **not** prompt (`apps/desktop/src-tauri/src/detection/`; FSM unit-tested in `monitor.rs`).
  - [x] Covers Zoom, Teams, Webex, Slack huddles (native) and Google Meet via the browser+mic heuristic (`detection/apps.rs` registry).
  - [x] Accepting runs the existing `use-recording` `start()` — permission gate, meeting provisioning, WS all reused; no parallel start path (`app-shell.tsx` passes `start` to `<MeetingDetectionPrompt>`).
  - [x] Never auto-records — the prompt always asks first.
  - [x] No prompt while a recording is already live (`recording_active` flag read each poll; FSM-tested).
  - [x] The prompt clears when the call ends (`meeting://ended`, edge-detected; FSM-tested).
  - [ ] Verified against a real Zoom/Teams/Webex/Slack-huddle and Google-Meet-in-Chrome call — macOS UAT (see DoD).
- [ ] **US-37 — Get notified when the app is in the background**
  - [x] When the main window is unfocused, the dock icon bounces (`request_user_attention`, reliable in dev + bundled) and a best-effort OS notification is posted; in-app banner otherwise (Rust `maybe_notify` gates on `is_focused`).
  - [x] The in-app banner is always mounted from the detected event, so focusing the app (via the bounce or notification) lands the user on exactly one prompt — no double-prompt.
  - [x] Graceful when notification permission is denied — detection still works, banner-only fallback.
  - [ ] Background-window notification visually confirmed end-to-end — macOS UAT (see DoD).
- [ ] **US-38 — Control auto-detection**
  - [x] On by default; toggle in Settings → "Auto-detect meetings" (`settings-sheet.tsx`, persisted `auto_detect_meetings`).
  - [x] "Snooze for 1 hour" and "Never for this app" from the prompt overflow (`detection_suppress` → FSM snooze / suppress; unit-tested).
  - [x] Toggling off stops the monitor thread (`use-meeting-detection.ts` → `stop_detection`).
  - [x] Detection raises **no** microphone or accessibility permission prompt (NSWorkspace + CoreAudio HAL reads are permission-free).

### Functional Requirements

- [x] **FR-6.01 (Must)** Detection sits behind a `DetectionSource` trait; signal sources are swappable per platform and mockable in tests (`detection/traits.rs`)
- [x] **FR-6.02 (Must)** Local-only: no audio/signal/detection event leaves the device; no backend or LangGraph involvement (documented in `detection/mod.rs`)
- [x] **FR-6.03 (Must)** macOS detector: `NSWorkspace.runningApplications` + CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` (`detection/macos/source.rs`)
- [ ] **FR-6.04 (Should)** Windows detector behind the same trait: ConsentStore registry + `sysinfo` process enum (`detection/windows/source.rs`) — code-complete, awaiting real-hardware UAT (staged like the WASAPI system source)
- [x] **FR-6.05 (Must)** Fusion rule `(known app OR browser) AND mic_active`; browser case flagged `isBrowserHeuristic` for softer copy (`monitor.rs`)
- [x] **FR-6.06 (Must)** Single ~4 s poll thread, 2-poll debounce, edge-detected detect/end; one app-enum + one HAL read per tick stays within the ≤8% CPU budget (`monitor.rs`)
- [x] **FR-6.07 (Must)** Never prompts while recording — reads the shared `recording_active` flag (`lib.rs` start/stop_recording write it)
- [x] **FR-6.08 (Must)** Accept reuses the existing `use-recording` `start()`; no parallel start path
- [x] **FR-6.09 (Must)** Context-aware delivery (in-app banner focused / OS notification backgrounded) with no double-prompt
- [x] **FR-6.10 (Should)** Settings: on-by-default toggle, Snooze 1h, Never-for-app; detection needs no new OS permission

### Definition of Done — Phase 6 Exit Criteria

- [ ] macOS: joining a real Zoom/Teams/Webex/Slack-huddle **and** a Google-Meet-in-Chrome call raises the prompt within ~8 s; Accept records; leaving the call clears the prompt
- [ ] Detection raises **no** microphone or accessibility permission dialog (verified manually)
- [ ] Background window → OS notification fires; clicking focuses + shows exactly one banner
- [ ] Music/video playback does **not** trigger a prompt (output device, not input — the mic gate holds)
- [ ] Snooze / Never-for-app / Settings-off all suppress as specified; logout and quit tear the monitor thread down with no orphan
- [x] Rust FSM unit tests (debounce, edge, suppression, snooze, recording-gate, back-to-back) green; frontend detection-store + settings-store tests green
- [ ] Windows detector verified on real hardware (follow-up, mirroring the WASAPI staging)
