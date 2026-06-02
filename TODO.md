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
- [x] **FR-1.06 (Must)** FastAPI gateway proxies audio to Deepgram Nova-2 streaming WebSocket
- [x] **FR-1.07 (Must)** Deepgram transcript lines (with speaker labels) broadcast back to desktop via WebSocket
- [x] **FR-1.08 (Must)** UI renders transcript lines with max display latency of 1.5 s
- [x] **FR-1.09 (Should)** Interim results visually distinguished from final results
- [x] **FR-1.10 (Must)** WebSocket implements exponential backoff reconnection, max retry 5 minutes
- [x] **FR-1.11 (Should)** Up to 30 s of audio buffered locally during disconnection and replayed
- [ ] **FR-1.12 (Must)** macOS uses ScreenCaptureKit; Windows uses WASAPI loopback — macOS half landed; Windows side code-complete via `WasapiSystemSource`, ticked once verified on a real Windows machine
- [ ] **FR-1.13 (Must)** Binary signed for macOS (Developer ID) and Windows (Authenticode)
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
  - [ ] Login/sign-up screen shown on first launch before any recording is accessible
  - [ ] Registration via email + password sends a verification email
  - [ ] Login with email + password; wrong credentials show a clear error
  - [ ] JWT tokens stored in OS credential store (Keychain / Credential Manager), never plain files
  - [ ] Sessions persist across app restarts without re-login
  - [ ] Log Out option available in settings
- [ ] **US-09 — View my meeting history**
  - [ ] History view lists all meetings for logged-in user, newest first
  - [ ] Each entry shows title (auto-generated if blank), date, duration, participant count
  - [ ] Clicking a meeting opens its transcript and summary (if available)
  - [ ] List loads within 2 s for up to 100 meetings
  - [ ] Empty state shown with helpful prompt when no meetings exist
- [ ] **US-10 — Meeting transcript saved automatically**
  - [ ] Each transcript line written to DB in real time as it arrives from STT (not only at meeting end)
  - [ ] On stop, in-flight lines flushed and persisted before session marked complete
  - [ ] Full transcript retrievable from DB after app restart
  - [ ] If app crashes mid-meeting, already-persisted lines retained and visible on next launch
- [ ] **US-11 — Audio recording archived**
  - [ ] At meeting end, raw audio compressed to MP3 (128 kbps) and uploaded to S3 asynchronously
  - [ ] Audio player available in meeting detail view once upload completes
  - [ ] Upload progress visible; UI stays usable during upload
  - [ ] Audio files stored under a path including workspace ID and meeting ID
  - [ ] User can delete a meeting's audio independently of the transcript
- [ ] **US-12 — Name and tag a meeting**
  - [ ] Meeting detail view has editable title field (default auto-generated)
  - [ ] Title saved on blur or Enter
  - [ ] Up to 10 freeform tags can be added/removed
  - [ ] Tags searchable in the history list (full semantic search comes in Phase 4)
- [ ] **US-13 — Data is private and secure**
  - [ ] All API endpoints validate JWT and return 401 for unauthenticated requests
  - [ ] DB queries scoped by user ID; no cross-user data leakage
  - [ ] All data transmitted over TLS 1.3; HTTP rejected
  - [ ] S3 objects not publicly accessible; downloads only via pre-signed URLs with 1 h expiry
  - [ ] Postgres and S3 encrypted at rest (AES-256)

### Functional Requirements

- [ ] **FR-2.01 (Must)** Registration + login via WorkOS (email/password and Google OAuth minimum)
- [ ] **FR-2.02 (Must)** JWT access tokens in OS credential store; refresh tokens rotated on each use
- [ ] **FR-2.03 (Must)** All API endpoints protected by JWT auth middleware
- [ ] **FR-2.04 (Must)** Each transcript line persisted to `transcript_segments` in real time
- [ ] **FR-2.05 (Must)** `meetings` table stores: id, user_id, title, status, started_at, ended_at, duration_seconds, speaker_count — schema landed in PR A (`alembic/versions/0001_phase2_foundation.py`); writes wired in a follow-up PR alongside the auth work
- [ ] **FR-2.06 (Must)** On meeting completion, Celery task compresses + uploads raw audio to S3
- [ ] **FR-2.07 (Must)** S3 objects accessible only via pre-signed URLs, max 1 h expiry
- [ ] **FR-2.08 (Must)** `GET /meetings` returns paginated history for authenticated user
- [ ] **FR-2.09 (Must)** `GET /meetings/:id` returns metadata + all transcript segments
- [ ] **FR-2.10 (Must)** `PATCH /meetings/:id` updates title and tags
- [ ] **FR-2.11 (Should)** `DELETE /meetings/:id/audio` removes S3 audio without deleting transcript
- [ ] **FR-2.12 (Must)** All DB queries scoped by user_id; Row Level Security enabled on all tables — RLS policies (USING + WITH CHECK) on `users`, `meetings`, `transcript_segments` and FORCEd on the table owner; verified by `tests/test_rls_blocks_cross_user.py`. Ticks fully once routes wire `set_request_user` into the request lifecycle (PR B/C).
- [ ] **FR-2.13 (Must)** All data over TLS 1.3; server rejects non-TLS connections
- [ ] **FR-2.14 (Must)** Redis is the Celery broker for all background tasks
- [x] **FR-2.15 (Must)** Alembic manages all schema changes in version control

### Definition of Done — Phase 2 Exit Criteria

- [ ] New user can register, verify email, log in, record a meeting, see it appear in history — all without touching the DB directly
- [ ] App restart test: log in, record, close, reopen, find full transcript intact in history
- [ ] Cross-user isolation: user A cannot retrieve user B's meetings via API (verified with A's JWT + B's meeting ID)
- [ ] S3 audio upload confirmed: MP3 exists at correct path after a recorded session ends
- [ ] Pre-signed URL test: audio accessible via URL, returns 403 after expiry
- [ ] All Postgres tables have RLS policies enabled and verified via DB query with a different user's role
- [ ] Alembic migrations exist for every schema change; clean DB can be built from scratch by running migrations
- [ ] `GET /meetings` response time <500 ms for a user with 100 meetings (k6 or equivalent)
- [ ] All new API endpoints have integration tests covering success and auth failure cases
- [ ] Celery worker monitored via Flower; failed tasks retry up to 3 times before dead-lettering

---

## Phase 3 — LLM Summarisation (Week 4)

> Goal: LangGraph orchestrates a map-reduce summarisation pipeline using Claude Sonnet that produces structured intelligence (summary, decisions, action items, topics) from each transcript.

### User Stories

- [ ] **US-14 — Receive a summary when the meeting ends**
  - [ ] Summary appears in meeting detail view within 60 s of clicking Stop
  - [ ] Summary written in clear, professional prose (not bullet fragments)
  - [ ] Summary correctly identifies the meeting's main purpose and outcome
  - [ ] Meetings under 5 minutes still generate a summary (single-pass, not map-reduce)
  - [ ] Loading state (`Generating summary…`) shown while LLM is processing
- [ ] **US-15 — See decisions extracted from the meeting**
  - [ ] Summary view includes dedicated Decisions section
  - [ ] Each decision is a single sentence describing what was agreed (and by whom if determinable)
  - [ ] Decisions numbered and extracted faithfully — no hallucinated decisions
  - [ ] If no decisions made, section states `No decisions recorded` (not hidden)
- [ ] **US-16 — See action items with owners and deadlines**
  - [ ] Summary view includes dedicated Action Items section
  - [ ] Each item shows: description, owner (or `Unassigned`), deadline (or `No deadline set`)
  - [ ] Items extracted faithfully; none invented by the model
  - [ ] Users can mark an action item as complete within the app
  - [ ] Action items editable (owner, deadline, description) inline in detail view
- [ ] **US-17 — See a topic and time breakdown**
  - [ ] Summary view includes Topics section listing 3–8 topics
  - [ ] Each topic shows estimated duration in minutes
  - [ ] Topics ordered by first appearance in the meeting
  - [ ] Topic breakdown generated from transcript structure, not invented
- [ ] **US-18 — Incremental summaries for long meetings**
  - [ ] Meetings >10 min: incremental chunk summaries every 5 minutes in the background during recording
  - [ ] Final summary produced by reduce pass over incremental summaries (not re-processing full transcript)
  - [ ] Final summary generation ≤45 s for any meeting up to 3 h long
  - [ ] 2-hour summary quality comparable to a 30-minute summary
- [ ] **US-19 — Copy and export the summary**
  - [ ] `Copy summary` button copies full structured summary in Markdown
  - [ ] `Copy action items` button copies only action items table
  - [ ] `Export as .txt` downloads a plain-text version
  - [ ] Exported format is clean and professional, not raw JSON
- [ ] **US-20 — Summary quality is consistent and trustworthy**
  - [ ] LLM prompt explicitly instructs model to only use info present in transcript
  - [ ] Hallucination guard: transcripts <50 words skip summarisation and show `Recording too short to summarise`
  - [ ] Summaries include confidence footnote if diarisation quality was low (<2 distinct speakers detected)
  - [ ] `View transcript` link always present alongside summary
- [ ] **US-21 — Re-generate a summary**
  - [ ] `Regenerate summary` button in meeting detail view
  - [ ] Re-generation uses the same pipeline and replaces previous summary
  - [ ] Confirmation dialog warns the current summary will be overwritten
  - [ ] Re-generation completes within same time bounds as initial generation

### Functional Requirements

- [ ] **FR-3.01 (Must)** LangGraph graph orchestrates summarisation with nodes: `chunk_buffer`, `incremental_summary`, `final_reduce`
- [ ] **FR-3.02 (Must)** Meetings >10 min: one incremental summary per 5-minute transcript chunk during recording
- [ ] **FR-3.03 (Must)** Final reduce pass synthesises all incremental summaries into a single structured output
- [ ] **FR-3.04 (Must)** LLM is Claude `claude-sonnet-4-20250514` via Anthropic API
- [ ] **FR-3.05 (Must)** LLM output validated as structured JSON matching `MeetingSummary` schema
- [ ] **FR-3.06 (Must)** `MeetingSummary` schema includes: summary (string), decisions (array), action_items (array w/ owner/deadline/description), topics (array w/ name/duration)
- [ ] **FR-3.07 (Must)** Token budget guard rejects inputs >180,000 tokens and falls back to chunked strategy
- [ ] **FR-3.08 (Must)** System prompt explicitly instructs model to only use info present in transcript
- [ ] **FR-3.09 (Must)** Transcripts <50 words skip summarisation and record status `too_short`
- [ ] **FR-3.10 (Must)** Final summary stored in `meeting_summaries` table linked to meeting by FK
- [ ] **FR-3.11 (Must)** Action items stored in separate `action_items` table for future agent automation
- [ ] **FR-3.12 (Must)** `PATCH /meetings/:id/action_items/:item_id` updates owner, deadline, description, completion status
- [ ] **FR-3.13 (Should)** `POST /meetings/:id/summarise` triggers re-generation
- [ ] **FR-3.14 (Should)** `GET /meetings/:id/export` returns formatted plain-text summary
- [ ] **FR-3.15 (Must)** Final summary generation ≤45 s for any meeting up to 3 h

### Definition of Done — Phase 3 Exit Criteria

- [ ] E2E test: 30-minute recorded meeting produces a summary with all 4 sections populated within 45 s of stopping
- [ ] E2E test: simulated 2-hour meeting (injected transcript) produces a valid summary via map-reduce in <45 s
- [ ] Schema validation: JSON output from Claude matches `MeetingSummary` schema on 20/20 successive test runs with varied transcripts
- [ ] Hallucination guard: transcript with no decisions produces `No decisions recorded` section, not invented content
- [ ] Faithfulness spot-check: 3 real meeting transcripts manually reviewed; summary/decisions/action items confirmed free of invented info
- [ ] Token guard: transcript >180,000 tokens triggers chunked fallback without error
- [ ] Action item edit: changing owner + deadline persists after page reload
- [ ] Re-generation: `Regenerate summary` produces a new summary that replaces the previous one
- [ ] Export: plain-text export contains all sections and renders cleanly when pasted into Notion
- [ ] LangGraph pipeline observable: each node execution logged with input/output token counts and duration

---

## Phase 4 — Search, Teams & Polish (Week 5)

> Goal: semantic search across all meetings, polished signed binary with auto-updates, refined UX informed by real usage.

### User Stories

- [ ] **US-22 — Search across all my meetings**
  - [ ] Search bar accessible from History view
  - [ ] Query + Enter returns ranked results within 2 s
  - [ ] Results show meeting title, date, and most relevant transcript excerpt
  - [ ] Search uses semantic similarity (vector search), not just keywords (e.g. `cost savings` also returns `budget reduction`)
  - [ ] Clicking a result opens meeting detail view with the relevant passage highlighted
- [ ] **US-23 — Filter meeting history**
  - [ ] History view has filter panel: date range picker, min/max duration slider, tag multi-select
  - [ ] Filters applied in real time without page reload
  - [ ] Active filters visually indicated; clearable individually or all at once
  - [ ] Filtered results compatible with semantic search (filters applied as pre-filters to vector query)
- [ ] **US-24 — Receive app updates automatically**
  - [ ] App checks for updates on launch and once per day while running
  - [ ] Non-intrusive banner with `Restart to update` appears when an update is available
  - [ ] Updates download in background and do not interrupt active recording
  - [ ] Update mechanism uses Tauri updater with self-hosted update manifest
  - [ ] Downgrade protection: app will not install a lower version number
- [ ] **US-25 — Customise recording settings**
  - [ ] Settings screen lets user select microphone device from available devices
  - [ ] User can toggle system audio capture on/off independently of mic
  - [ ] User can set transcription language (default auto-detect)
  - [ ] Settings changes take effect at start of next recording session
  - [ ] Settings persisted locally and survive app updates
- [ ] **US-25a — Real-time mic level meter in the Record control**
  - [ ] Live dBFS bar meter visible while recording (Record control area)
  - [ ] Reads from a new Tauri event `audio://level` emitted ~10 Hz from the audio pipeline
  - [ ] Displays both `mic_raw` (device peak) and `mic_resampled` (post-gain, what STT sees)
  - [ ] Visual states: green (-18 to -6 dBFS), yellow (<-18 or >-3), red (clipping or near-floor)
  - [ ] Yellow/red triggers a one-line hint pointing the user to System Settings → Sound → Input
  - [ ] Subscribe pattern matches the existing `audio://chunk` / `audio://error` flow in `apps/desktop/src/lib/audio-bridge.ts`
  - [ ] Decoupled from the static-gain compensation; meter is purely informational
- [ ] **US-26 — Meeting participants are listed**
  - [ ] Meeting detail view has Participants section listing all detected speaker labels
  - [ ] User can rename a speaker label to a real name (`Speaker 1` → `Omar`)
  - [ ] Speaker name overrides applied retroactively to all transcript lines in that meeting
  - [ ] Speaker names local to each meeting (no global learning in MVP)
- [ ] **US-27 — Dark mode support**
  - [ ] App detects OS dark/light mode preference on launch
  - [ ] All UI components render correctly in both modes with sufficient contrast (WCAG AA minimum)
  - [ ] Mode switches dynamically if OS preference changes while app is open
  - [ ] User can override OS preference via manual toggle in Settings
- [ ] **US-28 — Keyboard shortcuts**
  - [ ] `Cmd/Ctrl+R` starts a recording
  - [ ] `Cmd/Ctrl+.` stops a recording
  - [ ] `Cmd/Ctrl+H` opens History view
  - [ ] `Cmd/Ctrl+F` focuses search bar
  - [ ] All shortcuts listed in a discoverable Keyboard Shortcuts panel (`Cmd/Ctrl+?`)
  - [ ] Shortcuts do not conflict with common OS/browser shortcuts

### Functional Requirements

- [ ] **FR-4.01 (Must)** Background Celery task generates pgvector embedding for each transcript segment after a meeting ends
- [ ] **FR-4.02 (Must)** Embeddings stored in `transcript_segments` in a vector column (1536 dimensions)
- [ ] **FR-4.03 (Must)** `POST /search` accepts natural language query, embeds it, returns top-10 semantically similar segments with meeting context
- [ ] **FR-4.04 (Must)** Search results returned within 2 s for a user with up to 500 meetings
- [ ] **FR-4.05 (Must)** Search endpoint supports pre-filtering by user_id, date range, and tags before the vector similarity query
- [ ] **FR-4.06 (Must)** Tauri updater checks on launch + daily; updates downloaded in background
- [ ] **FR-4.07 (Must)** CI publishes signed update manifest and binary assets to update server on every release tag
- [ ] **FR-4.08 (Must)** Settings schema persisted locally via Tauri store plugin and survives app updates
- [ ] **FR-4.09 (Must)** Audio device selection enumerates available input devices via native audio API
- [ ] **FR-4.10 (Should)** Speaker label overrides stored in `speaker_aliases` table linked to meeting_id + original_label
- [ ] **FR-4.11 (Should)** Speaker aliases applied retroactively to `transcript_segments` on save
- [ ] **FR-4.12 (Must)** UI supports light + dark modes driven by OS preference with manual override
- [ ] **FR-4.13 (Should)** Global keyboard shortcuts registered at OS level (not requiring window focus) for Record and Stop
- [ ] **FR-4.14 (Must)** History view supports server-side pagination, max 25 meetings per page
- [ ] **FR-4.15 (Must)** pgvector HNSW index on the embedding column for sub-second query performance at scale

### Definition of Done — Phase 4 Exit Criteria

- [ ] Semantic search: query `budget concerns` returns segments discussing `financial risk` and `cost overrun` in top 5 results — not just exact keyword matches
- [ ] Search latency: 50 queries against test DB with 500 meetings all return in <2 s (pytest-benchmark)
- [ ] Auto-update test: publishing a new release tag triggers CI to produce updated manifest; running app detects update within 24 h and shows banner
- [ ] Settings persistence: changing mic device + language, then force-quitting and relaunching, confirms settings retained
- [ ] Dark mode: visual inspection confirms all screens render correctly and legibly in both modes on macOS and Windows
- [ ] Keyboard shortcuts: all 6 defined shortcuts work correctly when app is the active window
- [ ] Speaker rename: renaming `Speaker 1` to `Omar` reflected immediately in all transcript lines for that meeting
- [ ] HNSW index confirmed present on embedding column via `EXPLAIN ANALYZE` on a vector similarity query
- [ ] Pagination: navigating pages in History view works correctly; page 2 shows items 26–50 in correct order
- [ ] All new features have unit or integration tests; overall coverage stays above 70%

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
