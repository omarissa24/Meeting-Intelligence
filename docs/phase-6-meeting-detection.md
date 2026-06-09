# Phase 6 — Automatic Meeting Detection

> The phases doc (`Meeting_Intelligence_Development_Phases.docx`) is the nominal
> source of truth, but it's a binary Word file. This markdown is the
> authoritative written spec for Phase 6; `TODO.md` mirrors its user stories,
> functional requirements, and Definition of Done.

## Why

Recording is fully manual today — the user must remember to click Record before
a call. People forget, and the most valuable meetings go uncaptured. Phase 6
adds a **local-only detector** that notices when a call has actually started and
offers to record it. It never records silently: it always asks first.

## What it does

While the user is signed in and the "Auto-detect meetings" setting is on, a
background monitor watches two signals. When it concludes a meeting has started,
it surfaces a prompt — *"It looks like you're in a meeting — start recording?"* —
as an in-app banner (window focused) or an OS notification (window
backgrounded). Accepting runs the **existing** recording-start flow.

Supported surfaces: Zoom, Microsoft Teams, Webex, Slack huddles (native), and
Google Meet in a browser (Chrome/Edge/Safari/Arc).

## Locked decisions

1. **Prompt delivery:** context-aware — in-app banner when focused; when the
   window is backgrounded, the dock icon bounces (`request_user_attention`, the
   reliable cross-environment signal) and a best-effort OS notification is
   posted. The banner is always mounted from the detected event, so focusing the
   app lands on exactly one prompt. (macOS `tauri:dev` posts notifications as
   Terminal, so the banner-style notification is only reliable in a bundled
   build — the dock bounce covers dev.)
2. **Scope:** native conferencing apps **and** Google Meet via a browser+mic
   heuristic.
3. **Platforms:** macOS is the verified path; the Windows detector is written
   behind the same trait but staged code-complete-unverified (mirrors the
   WASAPI system source).
4. **Default:** on by default, always prompts (never auto-records). Per-app
   "Never for this app" and "Snooze 1 hour" from the prompt.

## How detection works

Two signals are fused on one background thread every ~4 s:

1. **A known conferencing app is running.** macOS: `NSWorkspace.runningApplications`
   matched against a bundle-id registry. Windows: `sysinfo` process names.
2. **The microphone is in use** by some process — the signal that distinguishes
   "app open" from "in a call". macOS: CoreAudio HAL
   `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device.
   Windows: the ConsentStore registry (`LastUsedTimeStop == 0`).

**Fusion rule:** prompt when `(known app OR browser) AND mic_active`. A
conferencing app with an idle mic is "open, not in a call" → no prompt. Browser
matches are flagged `isBrowserHeuristic` so the copy is softer and the case is
the most dismissable (browser mic use is inherently ambiguous).

**Permissions:** both the HAL read and the app enumeration are permission-free —
they trigger **no** microphone (TCC) or accessibility prompt. Music/video
playback uses the *output* device, so it does not trip `mic_active` — the key
false-positive guard.

**Debounce / edges:** a candidate must persist across 2 consecutive polls before
`Detected` fires (a one-poll blip never prompts); `Ended` fires immediately when
signals clear. Each detected session gets a monotonic `detectionId` so a stale
`ended` can't dismiss a newer prompt. The monitor never prompts while a
recording is live (it reads a shared `recording_active` flag the recording
commands flip).

## Architecture

**Local only.** No audio, no signal, and no detection event leaves the device or
touches the FastAPI backend. This is intentionally **not** a LangGraph node —
that orchestration invariant is a backend concern. Detection sits behind a Rust
`DetectionSource` trait (mirroring `audio::traits::MicSource`/`SystemSource`),
so signal sources are swappable per platform and mockable in tests.

### Rust — `apps/desktop/src-tauri/src/detection/`

| File | Responsibility |
| --- | --- |
| `traits.rs` | `DetectionSource` trait + `RawSignals` + `MatchedApp` (the swappable seam) |
| `apps.rs` | Registry of known conferencing apps (bundle id / process / browser flag) |
| `monitor.rs` | Pure `DetectionFsm` (debounce/edge), the poll-thread driver, event payloads, OS-notification helper |
| `macos/source.rs` | NSWorkspace app enum + CoreAudio HAL mic-active read |
| `windows/source.rs` | `sysinfo` process enum + ConsentStore registry read |

- Events: `meeting://detected` `{ appId, displayName, isBrowserHeuristic, detectionId }`,
  `meeting://ended` `{ detectionId }`.
- Commands (in `lib.rs` `generate_handler!`): `start_detection`, `stop_detection`,
  `detection_suppress(app_id, snooze_secs)`.
- State: a shared `RecordingActiveFlag(Arc<AtomicBool>)` (set by start/stop_recording)
  and a `Mutex<DetectionMonitorState>` holding the live monitor.
- Plugin: `tauri-plugin-notification` (capability `notification:default`); the OS
  notification is sent from Rust via `NotificationExt` only when the window is
  unfocused.

### Frontend — `apps/desktop/src/`

| File | Responsibility |
| --- | --- |
| `lib/detection-bridge.ts` | `subscribeMeetingDetected` / `subscribeMeetingEnded` |
| `stores/detection-store.ts` | Single source of truth for the active prompt; gates on recording phase idle, clears on matching `detectionId` |
| `hooks/use-meeting-detection.ts` | Subscribes the bridge + starts/stops the native monitor with the setting |
| `components/meeting-detection-prompt.tsx` | Non-modal banner (Start / Dismiss / Snooze / Never) |
| `lib/tauri-commands.ts` | `startDetection` / `stopDetection` / `detectionSuppress` wrappers |

The accept handler reuses the **real** `start()` from `use-recording.ts` (lifted
into `AppShell` and passed to the prompt by identity, exactly like
`RecordControl`), so the permission gate, meeting provisioning, and WS wiring all
come for free. Settings add one tolerant `auto_detect_meetings` key (the `theme`
precedent — no schema bump). The lifecycle hook is mounted in `AppShell`, the
single authenticated surface, so logout tears the monitor down.

## Edge cases

- **Music/video playback** — output device, not input; does not set `mic_active`.
- **Dictation inside a browser tab** — a residual false positive; covered by
  Dismiss / Snooze / Never.
- **Google Meet ambiguity** — can't be told apart from other browser mic use
  without accessibility; bounded to browser+mic and worded softly.
- **Back-to-back meetings** — edge detection + a fresh `detectionId` per session.
- **Permission not yet granted on accept** — `start()` re-checks and routes into
  the existing `PermissionPrompt` flow.
- **Logout / quit** — `stop_detection` (on logout) and the monitor's `Drop` join
  the poll thread; the stop channel wakes it immediately.

## Out of scope

Calendar-based detection (that's the Phase 5 Calendar MCP connector), exact
browser-tab/URL inspection (would need accessibility permission), and persisted
cross-restart "never" lists (ephemeral per-session for the MVP).

## Verification

- **Automated:** Rust FSM unit tests in `monitor.rs` (debounce, edge, suppression,
  snooze, recording-gate, back-to-back); frontend `detection-store` and
  `settings-store` tests.
- **Manual UAT (gates the DoD):** join a real Zoom/Teams/Webex/Slack-huddle and a
  Google-Meet-in-Chrome call on macOS; confirm the prompt within ~8 s, that no
  mic/accessibility dialog appears, the background-window notification path, and
  that music playback does not trigger a prompt. Windows detector UAT is a
  follow-up.
