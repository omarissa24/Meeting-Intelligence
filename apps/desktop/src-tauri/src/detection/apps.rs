//! Registry of conferencing apps the detector recognises.
//!
//! Each entry maps a platform identifier (macOS bundle id, Windows process
//! basename) to a display name and a browser flag. The platform sources match
//! running processes/apps against this table; the fusion rule lives in the
//! monitor (`app present AND mic active`), so a browser entry only differs from
//! a native one in how the prompt is worded — never in whether the mic gate
//! applies (it always does).
//!
//! Keep ids lowercased for Windows process matching; bundle ids stay verbatim
//! (macOS `bundleIdentifier` is case-sensitive in practice but we compare
//! exact).

use crate::detection::traits::MatchedApp;

/// One known conferencing surface. `mac_bundle_ids` and `win_processes` are the
/// platform identifiers; either list may be empty if the app doesn't exist on
/// that platform.
pub struct ConferencingApp {
    pub id: &'static str,
    pub display_name: &'static str,
    pub is_browser: bool,
    pub mac_bundle_ids: &'static [&'static str],
    /// Lowercased process basenames (with `.exe`).
    pub win_processes: &'static [&'static str],
}

impl ConferencingApp {
    fn as_matched(&self) -> MatchedApp {
        MatchedApp {
            id: self.id,
            display_name: self.display_name,
            is_browser: self.is_browser,
        }
    }
}

/// Native conferencing apps and the browser set. Native apps are listed first
/// so `match_mac_bundle_id` / `match_win_process` prefer a high-confidence
/// native match over a browser when both are running.
pub const REGISTRY: &[ConferencingApp] = &[
    ConferencingApp {
        id: "zoom",
        display_name: "Zoom",
        is_browser: false,
        mac_bundle_ids: &["us.zoom.xos"],
        win_processes: &["zoom.exe"],
    },
    ConferencingApp {
        id: "teams",
        display_name: "Microsoft Teams",
        is_browser: false,
        // `com.microsoft.teams2` is the new (work/school) client; the older
        // bundle id stays for users who haven't migrated.
        mac_bundle_ids: &["com.microsoft.teams2", "com.microsoft.teams"],
        win_processes: &["ms-teams.exe", "teams.exe"],
    },
    ConferencingApp {
        id: "webex",
        display_name: "Webex",
        is_browser: false,
        mac_bundle_ids: &["com.cisco.webexmeetingsapp", "Cisco-Systems.Spark"],
        win_processes: &["webexmta.exe", "webex.exe", "ciscowebexstart.exe"],
    },
    ConferencingApp {
        id: "slack",
        display_name: "Slack",
        is_browser: false,
        mac_bundle_ids: &["com.tinyspeck.slackmacgap"],
        win_processes: &["slack.exe"],
    },
    // --- Browsers: only count toward a meeting when the mic is also hot ---
    ConferencingApp {
        id: "chrome",
        display_name: "Google Meet",
        is_browser: true,
        mac_bundle_ids: &["com.google.Chrome"],
        win_processes: &["chrome.exe"],
    },
    ConferencingApp {
        id: "edge",
        display_name: "your browser",
        is_browser: true,
        mac_bundle_ids: &["com.microsoft.edgemac"],
        win_processes: &["msedge.exe"],
    },
    ConferencingApp {
        id: "safari",
        display_name: "your browser",
        is_browser: true,
        mac_bundle_ids: &["com.apple.Safari"],
        win_processes: &[],
    },
    ConferencingApp {
        id: "arc",
        display_name: "your browser",
        is_browser: true,
        mac_bundle_ids: &["company.thebrowser.Browser"],
        win_processes: &["arc.exe"],
    },
];

/// Match a macOS bundle identifier against the registry. Exact match.
// `iter().any(|b| *b == x)` over `&[&'static str]` can't become `.contains(&x)`
// here: the slice holds `&'static str` while the arg is a shorter-lived `&str`,
// so `contains` (which wants `&&'static str`) doesn't typecheck. Keep the
// explicit compare and silence the perf lint's (incorrect) suggestion.
#[cfg(target_os = "macos")]
#[allow(clippy::manual_contains)]
pub fn match_mac_bundle_id(bundle_id: &str) -> Option<MatchedApp> {
    REGISTRY
        .iter()
        .find(|app| app.mac_bundle_ids.iter().any(|b| *b == bundle_id))
        .map(ConferencingApp::as_matched)
}

/// Match a lowercased Windows process basename against the registry.
#[cfg(target_os = "windows")]
#[allow(clippy::manual_contains)]
pub fn match_win_process(process_lower: &str) -> Option<MatchedApp> {
    REGISTRY
        .iter()
        .find(|app| app.win_processes.iter().any(|p| *p == process_lower))
        .map(ConferencingApp::as_matched)
}

/// Pick the best of several matches: a native app beats a browser, so a Zoom
/// call detected while Chrome is also open is reported as Zoom, not Meet.
/// Returns `None` for an empty iterator.
pub fn prefer_best<I: IntoIterator<Item = MatchedApp>>(matches: I) -> Option<MatchedApp> {
    let mut best: Option<MatchedApp> = None;
    for m in matches {
        match best {
            // First match wins unless we later find a native one.
            None => best = Some(m),
            Some(b) if b.is_browser && !m.is_browser => best = Some(m),
            _ => {}
        }
    }
    best
}
