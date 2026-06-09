//! Meeting-detection state machine + background poll thread.
//!
//! `DetectionFsm` is the pure core: it fuses one poll's `RawSignals` into a
//! debounced, edge-detected decision and emits an `Edge` (`Detected` / `Ended`
//! / `None`). It makes **no** native calls and takes `now: Instant` +
//! `recording_active: bool` as inputs, so the whole thing is unit-testable
//! against scripted signals (see the tests at the bottom).
//!
//! `spawn` wraps a platform `DetectionSource` in a thread that polls every
//! `POLL_INTERVAL`, drives the FSM, and turns edges into `meeting://detected`
//! / `meeting://ended` Tauri events. Teardown mirrors
//! `recording::spawn_perf_monitor_thread`: a `recv_timeout` stop channel that
//! `DetectionMonitor`'s `Drop` signals + joins.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::detection::traits::{DetectionSource, MatchedApp, RawSignals};

/// Tauri event names — must match the frontend's `detection-bridge.ts`.
pub const EVENT_MEETING_DETECTED: &str = "meeting://detected";
pub const EVENT_MEETING_ENDED: &str = "meeting://ended";

/// Poll cadence. 4 s keeps the thread near-idle (one app-enum + one device
/// property read per tick — orders of magnitude under the US-07 ≤8% budget)
/// while still detecting a call within ~2 polls (~8 s, the Phase-6 DoD).
const POLL_INTERVAL: Duration = Duration::from_secs(4);

/// Payload for `meeting://detected`. Serde camelCase mirrors
/// `recording::AudioChunkPayload`.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectedPayload {
    /// Registry id (bundle id / process basename) — frontend keys snooze and
    /// "never for this app" on it.
    pub app_id: String,
    pub display_name: String,
    /// True when the match came from a browser (the Google Meet heuristic), so
    /// the UI can soften the copy.
    pub is_browser_heuristic: bool,
    /// Monotonic id for this detected session; the matching `ended` echoes it
    /// so a stale end can't dismiss a newer prompt.
    pub detection_id: u64,
}

/// Payload for `meeting://ended`.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEndedPayload {
    pub detection_id: u64,
}

/// The result of advancing the FSM one poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edge {
    None,
    Detected(MeetingDetectedPayload),
    Ended(MeetingEndedPayload),
}

#[derive(Debug, Clone, Copy)]
pub struct FsmConfig {
    /// Consecutive polls a candidate must persist before `Detected` fires.
    /// 2 ⇒ a one-poll blip never prompts.
    pub debounce_polls: u8,
}

impl Default for FsmConfig {
    fn default() -> Self {
        Self { debounce_polls: 2 }
    }
}

struct ActiveMeeting {
    app_id: &'static str,
    detection_id: u64,
}

struct Pending {
    app_id: &'static str,
    count: u8,
}

/// Pure debounce/edge state machine. Owns no OS handles.
pub struct DetectionFsm {
    config: FsmConfig,
    /// The meeting we've already fired `Detected` for. `None` = idle.
    active: Option<ActiveMeeting>,
    /// A candidate seen but not yet confirmed across `debounce_polls`.
    pending: Option<Pending>,
    next_detection_id: u64,
    /// "Never for this app" ids (session-scoped).
    suppressed_apps: HashSet<String>,
    /// Snooze deadline; candidates are ignored until `now >= until`.
    snoozed_until: Option<Instant>,
}

impl DetectionFsm {
    pub fn new(config: FsmConfig) -> Self {
        Self {
            config,
            active: None,
            pending: None,
            next_detection_id: 1,
            suppressed_apps: HashSet::new(),
            snoozed_until: None,
        }
    }

    /// Advance one poll. `recording_active` short-circuits everything (we never
    /// prompt while recording); `now` is injected so tests don't touch the
    /// clock.
    pub fn step(&mut self, raw: &RawSignals, recording_active: bool, now: Instant) -> Edge {
        // While recording, never prompt. Clear any in-flight candidate and end
        // a lingering active meeting exactly once so the banner dismisses.
        if recording_active {
            self.pending = None;
            if let Some(active) = self.active.take() {
                return Edge::Ended(MeetingEndedPayload {
                    detection_id: active.detection_id,
                });
            }
            return Edge::None;
        }

        // Expire an elapsed snooze.
        if let Some(until) = self.snoozed_until {
            if now >= until {
                self.snoozed_until = None;
            }
        }

        // Fusion rule: a meeting is present iff a known app is up AND the mic
        // is hot. Browser entries follow the same rule (mic gate always
        // applies) and only differ in the softer copy flag downstream.
        let mut candidate: Option<MatchedApp> = match raw.conferencing_app {
            Some(app) if raw.mic_active => Some(app),
            _ => None,
        };
        // Snooze + per-app suppression mask the candidate.
        if let Some(app) = candidate {
            if self.snoozed_until.is_some() || self.suppressed_apps.contains(app.id) {
                candidate = None;
            }
        }

        match candidate {
            None => {
                self.pending = None;
                match self.active.take() {
                    Some(active) => Edge::Ended(MeetingEndedPayload {
                        detection_id: active.detection_id,
                    }),
                    None => Edge::None,
                }
            }
            Some(app) => {
                if let Some(active) = &self.active {
                    if active.app_id == app.id {
                        // Same meeting, still going — no edge.
                        self.pending = None;
                        return Edge::None;
                    }
                    // A different meeting replaced the old one (back-to-back).
                    // End the old now; the new one debounces from scratch.
                    let ended = active.detection_id;
                    self.active = None;
                    self.pending = Some(Pending {
                        app_id: app.id,
                        count: 1,
                    });
                    return Edge::Ended(MeetingEndedPayload {
                        detection_id: ended,
                    });
                }

                // Idle → debounce.
                let count = match &self.pending {
                    Some(p) if p.app_id == app.id => p.count + 1,
                    _ => 1,
                };
                if count >= self.config.debounce_polls.max(1) {
                    self.pending = None;
                    let detection_id = self.next_detection_id;
                    self.next_detection_id += 1;
                    self.active = Some(ActiveMeeting {
                        app_id: app.id,
                        detection_id,
                    });
                    Edge::Detected(MeetingDetectedPayload {
                        app_id: app.id.to_string(),
                        display_name: app.display_name.to_string(),
                        is_browser_heuristic: app.is_browser,
                        detection_id,
                    })
                } else {
                    self.pending = Some(Pending {
                        app_id: app.id,
                        count,
                    });
                    Edge::None
                }
            }
        }
    }

    /// "Never for this app" — permanently (this session) stop prompting for
    /// `app_id`. The frontend has already dismissed the banner, so no `Ended`
    /// is emitted here.
    pub fn suppress_app(&mut self, app_id: &str) {
        self.suppressed_apps.insert(app_id.to_string());
        self.pending = None;
        if self.active.as_ref().is_some_and(|a| a.app_id == app_id) {
            self.active = None;
        }
    }

    /// Snooze all prompts until `until`. Clears the current prompt/candidate;
    /// the frontend dismisses the banner in the same gesture.
    pub fn snooze(&mut self, until: Instant) {
        self.snoozed_until = Some(until);
        self.pending = None;
        self.active = None;
    }
}

/// Live monitor handle. Dropping it signals the poll thread to stop and joins
/// it — same teardown contract as `recording::Session`'s helper threads.
pub struct DetectionMonitor {
    stop_tx: Sender<()>,
    join: Option<JoinHandle<()>>,
    fsm: Arc<Mutex<DetectionFsm>>,
}

impl DetectionMonitor {
    /// Shared FSM handle, so the `detection_suppress` command can apply
    /// snooze / "never for this app" to the running monitor.
    pub fn fsm(&self) -> Arc<Mutex<DetectionFsm>> {
        self.fsm.clone()
    }
}

impl Drop for DetectionMonitor {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Start the poll thread for `source`. `recording_active` is the shared flag
/// the recording commands flip, so the monitor and the recorder agree on
/// "are we recording" without the FSM reaching into recording state.
pub fn spawn<R: Runtime>(
    app: AppHandle<R>,
    source: Box<dyn DetectionSource>,
    recording_active: Arc<AtomicBool>,
) -> DetectionMonitor {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let fsm = Arc::new(Mutex::new(DetectionFsm::new(FsmConfig::default())));
    let fsm_thread = fsm.clone();

    let join = std::thread::Builder::new()
        .name("meeting-detection".into())
        .spawn(move || loop {
            match stop_rx.recv_timeout(POLL_INTERVAL) {
                Ok(()) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            let raw = match source.poll() {
                Ok(r) => r,
                Err(e) => {
                    // Transient read failure: skip this poll rather than
                    // stepping with empty signals (which would end an active
                    // meeting on a blip).
                    eprintln!("meeting-detection: poll failed: {e}");
                    continue;
                }
            };
            let recording = recording_active.load(Ordering::Relaxed);
            let now = Instant::now();
            let edge = match fsm_thread.lock() {
                Ok(mut f) => f.step(&raw, recording, now),
                Err(_) => Edge::None,
            };

            match edge {
                Edge::Detected(payload) => {
                    maybe_notify(&app, &payload);
                    if let Err(e) = app.emit(EVENT_MEETING_DETECTED, payload) {
                        eprintln!("meeting-detection: emit detected failed: {e}");
                    }
                }
                Edge::Ended(payload) => {
                    if let Err(e) = app.emit(EVENT_MEETING_ENDED, payload) {
                        eprintln!("meeting-detection: emit ended failed: {e}");
                    }
                }
                Edge::None => {}
            }
        })
        .expect("failed to spawn meeting-detection thread");

    DetectionMonitor {
        stop_tx,
        join: Some(join),
        fsm,
    }
}

/// Fire an OS notification only when the main window isn't focused — when it
/// is, the in-app banner is the single prompt. Clicking the notification
/// activates the app (macOS default), and the banner is already mounted from
/// the `meeting://detected` event, so the user lands on exactly one prompt.
fn maybe_notify<R: Runtime>(app: &AppHandle<R>, payload: &MeetingDetectedPayload) {
    let window = app.get_webview_window("main");
    let focused = window
        .as_ref()
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    eprintln!(
        "meeting-detection: detected app={} browser={} window_focused={focused}",
        payload.display_name, payload.is_browser_heuristic,
    );
    if focused {
        // Window is foreground — the in-app banner is the single prompt.
        return;
    }

    // Reliable attention signal that works even when OS notifications don't
    // (notably macOS `tauri:dev`, where the plugin posts as Terminal): bounce
    // the dock icon / flash the taskbar entry until the user focuses the app.
    // No notification permission required.
    if let Some(w) = &window {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }

    let body = if payload.is_browser_heuristic {
        "Looks like a call in your browser. Open Meeting Intelligence to record.".to_string()
    } else {
        format!(
            "{} looks active. Open Meeting Intelligence to record.",
            payload.display_name
        )
    };

    // NOTE (macOS dev): the notification plugin posts as `com.apple.Terminal`
    // under `tauri:dev`, so it only shows if Terminal.app has notification
    // permission — and not at all if you launched dev from iTerm/Warp/VS Code.
    // A bundled build posts under the real bundle id and is reliable. `show()`
    // returns Ok once dispatched (it spawns internally), so a swallowed display
    // failure won't surface here — the eprintln above is the source of truth
    // that we reached this path with the window unfocused.
    use tauri_plugin_notification::NotificationExt;
    match app
        .notification()
        .builder()
        .title("Start recording?")
        .body(body)
        .show()
    {
        Ok(()) => eprintln!("meeting-detection: OS notification dispatched"),
        Err(e) => eprintln!("meeting-detection: notification failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZOOM: MatchedApp = MatchedApp {
        id: "zoom",
        display_name: "Zoom",
        is_browser: false,
    };
    const TEAMS: MatchedApp = MatchedApp {
        id: "teams",
        display_name: "Microsoft Teams",
        is_browser: false,
    };
    const MEET: MatchedApp = MatchedApp {
        id: "chrome",
        display_name: "Google Meet",
        is_browser: true,
    };

    fn sig(app: Option<MatchedApp>, mic: bool) -> RawSignals {
        RawSignals {
            conferencing_app: app,
            mic_active: mic,
        }
    }

    fn fsm() -> DetectionFsm {
        DetectionFsm::new(FsmConfig::default())
    }

    fn detected(edge: Edge) -> MeetingDetectedPayload {
        match edge {
            Edge::Detected(p) => p,
            other => panic!("expected Detected, got {other:?}"),
        }
    }

    fn ended(edge: Edge) -> MeetingEndedPayload {
        match edge {
            Edge::Ended(p) => p,
            other => panic!("expected Ended, got {other:?}"),
        }
    }

    #[test]
    fn debounce_requires_two_consecutive_polls_and_fires_once() {
        let mut f = fsm();
        let now = Instant::now();
        // One poll is not enough.
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, now), Edge::None);
        // Second consecutive poll confirms.
        let p = detected(f.step(&sig(Some(ZOOM), true), false, now));
        assert_eq!(p.app_id, "zoom");
        assert_eq!(p.detection_id, 1);
        assert!(!p.is_browser_heuristic);
        // Third identical poll is the level, not an edge — no re-fire.
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, now), Edge::None);
    }

    #[test]
    fn ended_fires_immediately_when_signals_clear() {
        let mut f = fsm();
        let now = Instant::now();
        f.step(&sig(Some(ZOOM), true), false, now);
        detected(f.step(&sig(Some(ZOOM), true), false, now));
        let e = ended(f.step(&sig(None, false), false, now));
        assert_eq!(e.detection_id, 1);
        // Stays idle afterwards.
        assert_eq!(f.step(&sig(None, false), false, now), Edge::None);
    }

    #[test]
    fn app_open_without_mic_never_fires() {
        let mut f = fsm();
        let now = Instant::now();
        assert_eq!(f.step(&sig(Some(ZOOM), false), false, now), Edge::None);
        assert_eq!(f.step(&sig(Some(ZOOM), false), false, now), Edge::None);
        assert_eq!(f.step(&sig(Some(ZOOM), false), false, now), Edge::None);
    }

    #[test]
    fn recording_active_suppresses_and_ends_active() {
        let mut f = fsm();
        let now = Instant::now();
        // From idle, recording suppresses entirely.
        assert_eq!(f.step(&sig(Some(ZOOM), true), true, now), Edge::None);
        assert_eq!(f.step(&sig(Some(ZOOM), true), true, now), Edge::None);

        // Become active, then recording starts → Ended once, then quiet.
        let mut g = fsm();
        g.step(&sig(Some(ZOOM), true), false, now);
        detected(g.step(&sig(Some(ZOOM), true), false, now));
        let e = ended(g.step(&sig(Some(ZOOM), true), true, now));
        assert_eq!(e.detection_id, 1);
        assert_eq!(g.step(&sig(Some(ZOOM), true), true, now), Edge::None);
    }

    #[test]
    fn browser_match_is_flagged_heuristic() {
        let mut f = fsm();
        let now = Instant::now();
        f.step(&sig(Some(MEET), true), false, now);
        let p = detected(f.step(&sig(Some(MEET), true), false, now));
        assert!(p.is_browser_heuristic);
        assert_eq!(p.display_name, "Google Meet");
    }

    #[test]
    fn suppress_app_blocks_future_prompts() {
        let mut f = fsm();
        let now = Instant::now();
        f.step(&sig(Some(ZOOM), true), false, now);
        detected(f.step(&sig(Some(ZOOM), true), false, now));
        f.suppress_app("zoom");
        // Same app reappears — no fire, no matter how many polls.
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, now), Edge::None);
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, now), Edge::None);
    }

    #[test]
    fn snooze_blocks_until_deadline_then_prompts_again() {
        let mut f = fsm();
        let now = Instant::now();
        f.snooze(now + Duration::from_secs(3600));
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, now), Edge::None);
        assert_eq!(
            f.step(&sig(Some(ZOOM), true), false, now + Duration::from_secs(10)),
            Edge::None
        );
        // After the window, the meeting prompts again (with debounce).
        let later = now + Duration::from_secs(3601);
        assert_eq!(f.step(&sig(Some(ZOOM), true), false, later), Edge::None);
        let p = detected(f.step(&sig(Some(ZOOM), true), false, later));
        assert_eq!(p.app_id, "zoom");
    }

    #[test]
    fn back_to_back_meetings_get_fresh_ids_with_end_between() {
        let mut f = fsm();
        let now = Instant::now();
        f.step(&sig(Some(ZOOM), true), false, now);
        let a = detected(f.step(&sig(Some(ZOOM), true), false, now));
        assert_eq!(a.detection_id, 1);

        // Switch straight to Teams: the old meeting ends now…
        let e = ended(f.step(&sig(Some(TEAMS), true), false, now));
        assert_eq!(e.detection_id, 1);
        // …and the new one confirms on the next poll with a fresh id.
        let b = detected(f.step(&sig(Some(TEAMS), true), false, now));
        assert_eq!(b.app_id, "teams");
        assert_eq!(b.detection_id, 2);
    }
}
