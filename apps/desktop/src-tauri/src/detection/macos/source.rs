//! macOS detection signals.
//!
//! Two reads per poll, both permission-free:
//!   * **Running apps** — `NSWorkspace.runningApplications`, matched against
//!     `apps::REGISTRY` by bundle id. No TCC or accessibility permission.
//!   * **Mic in use** — CoreAudio HAL `kAudioDevicePropertyDeviceIsRunningSomewhere`
//!     on the default input device. This is a device-metadata read, not a
//!     capture, so it triggers **no** microphone permission prompt.
//!
//! Written in the same objc2 / FFI style as `audio::macos::permissions`.

use std::ffi::c_void;
use std::ptr::{self, NonNull};

use objc2_app_kit::NSWorkspace;
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress,
};

use crate::detection::apps;
use crate::detection::traits::{DetectionError, DetectionSource, RawSignals};

pub struct MacosDetectionSource;

impl MacosDetectionSource {
    pub fn new() -> Self {
        Self
    }
}

impl DetectionSource for MacosDetectionSource {
    fn poll(&self) -> Result<RawSignals, DetectionError> {
        Ok(RawSignals {
            conferencing_app: matched_conferencing_app(),
            mic_active: mic_in_use(),
        })
    }
}

/// Enumerate running apps, match each bundle id against the registry, and keep
/// the best (native beats browser).
fn matched_conferencing_app() -> Option<crate::detection::traits::MatchedApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let running = workspace.runningApplications();
    let matches = running.iter().filter_map(|app| {
        app.bundleIdentifier()
            .and_then(|bundle| apps::match_mac_bundle_id(&bundle.to_string()))
    });
    apps::prefer_best(matches)
}

/// Read whether the default input device is in use by any process. Best-effort:
/// any HAL error (no input device, exotic sandbox) returns `false` — the
/// app-process signal still gates a prompt, so a missed mic read just means we
/// don't fire on a browser-only heuristic.
fn mic_in_use() -> bool {
    let Some(device) = default_input_device() else {
        return false;
    };
    if device == 0 {
        return false;
    }

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut running: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;

    // SAFETY: `address` and the out/size pointers are valid stack locals for
    // the duration of the call; CoreAudio writes a u32 into `running`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            NonNull::from(&address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::new(&mut running as *mut u32 as *mut c_void).unwrap(),
        )
    };

    status == 0 && running != 0
}

/// Resolve the system default input `AudioDeviceID`. Returns `None` on any HAL
/// error.
fn default_input_device() -> Option<AudioObjectID> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut device: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;

    // SAFETY: same as `mic_in_use` — valid stack locals; CoreAudio writes one
    // AudioObjectID into `device`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::new(&mut device as *mut AudioObjectID as *mut c_void).unwrap(),
        )
    };

    (status == 0).then_some(device)
}
