//! Windows detection signals.
//!
//! Two reads per poll, both permission-free:
//!   * **Running processes** — `sysinfo` (already linked), matched against
//!     `apps::REGISTRY` by lowercased process basename.
//!   * **Mic in use** — the ConsentStore registry under
//!     `HKCU\…\CapabilityAccessManager\ConsentStore\microphone`. Each app leaf
//!     carries a `LastUsedTimeStop` `REG_QWORD`; a value of `0` means the app
//!     is *currently* holding the mic. We walk the packaged-app leaves and the
//!     `NonPackaged` subtree; any `LastUsedTimeStop == 0` ⇒ mic active.
//!
//! Reading `HKCU` needs no elevation and no permission prompt.
//!
//! NOTE: this path is code-complete but awaits real-hardware UAT (Phase 6
//! follow-up). The macOS source is the verified path that gates the DoD.

use std::sync::Mutex;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    REG_QWORD, REG_VALUE_TYPE,
};

use crate::detection::apps;
use crate::detection::traits::{DetectionError, DetectionSource, MatchedApp, RawSignals};

/// `HKCU` subpath of the microphone ConsentStore.
const MIC_CONSENT_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

pub struct WindowsDetectionSource {
    // sysinfo's `System` is reused across polls so we don't re-allocate the
    // process table each tick. Interior mutability keeps `poll(&self)`.
    system: Mutex<System>,
}

impl WindowsDetectionSource {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }

    fn matched_conferencing_app(&self) -> Option<MatchedApp> {
        let mut sys = self.system.lock().ok()?;
        sys.refresh_processes_specifics(ProcessesToUpdate::All, false, ProcessRefreshKind::new());
        let matches = sys.processes().values().filter_map(|p| {
            let name = p.name().to_string_lossy().to_lowercase();
            apps::match_win_process(&name)
        });
        apps::prefer_best(matches)
    }
}

impl DetectionSource for WindowsDetectionSource {
    fn poll(&self) -> Result<RawSignals, DetectionError> {
        Ok(RawSignals {
            conferencing_app: self.matched_conferencing_app(),
            mic_active: mic_in_use(),
        })
    }
}

/// Walk the microphone ConsentStore for any app currently holding the mic.
fn mic_in_use() -> bool {
    let Some(root) = open_hkcu(MIC_CONSENT_PATH) else {
        return false;
    };
    // depth 2: root → {packaged-app leaves, NonPackaged} → desktop-app leaves.
    let active = key_mic_active(root, 2);
    unsafe {
        let _ = RegCloseKey(root);
    }
    active
}

/// True if `hkey` (or, within `depth` levels, any descendant) has
/// `LastUsedTimeStop == 0` — i.e. the mic is in use right now.
fn key_mic_active(hkey: HKEY, depth: u8) -> bool {
    if read_qword(hkey, "LastUsedTimeStop") == Some(0) {
        return true;
    }
    if depth == 0 {
        return false;
    }
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 512];
        let mut name_len = name.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(
                hkey,
                index,
                PWSTR(name.as_mut_ptr()),
                &mut name_len,
                None,
                PWSTR::null(),
                None,
                None,
            )
        };
        if rc == ERROR_NO_MORE_ITEMS {
            break;
        }
        if rc != ERROR_SUCCESS {
            break;
        }
        index += 1;

        if let Some(subkey) = open_subkey(hkey, &name[..name_len as usize]) {
            let active = key_mic_active(subkey, depth - 1);
            unsafe {
                let _ = RegCloseKey(subkey);
            }
            if active {
                return true;
            }
        }
    }
    false
}

/// Read a `REG_QWORD` value by name. `None` if absent or not a QWORD.
fn read_qword(hkey: HKEY, value: &str) -> Option<u64> {
    let name = wide(value);
    let mut typ = REG_VALUE_TYPE(0);
    let mut data: u64 = 0;
    let mut len = std::mem::size_of::<u64>() as u32;
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut typ),
            Some(&mut data as *mut u64 as *mut u8),
            Some(&mut len),
        )
    };
    (rc == ERROR_SUCCESS && typ == REG_QWORD).then_some(data)
}

fn open_hkcu(path: &str) -> Option<HKEY> {
    let sub = wide(path);
    let mut hkey = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    (rc == ERROR_SUCCESS).then_some(hkey)
}

fn open_subkey(parent: HKEY, name_no_nul: &[u16]) -> Option<HKEY> {
    let mut sub = name_no_nul.to_vec();
    sub.push(0);
    let mut hkey = HKEY::default();
    let rc = unsafe { RegOpenKeyExW(parent, PCWSTR(sub.as_ptr()), 0, KEY_READ, &mut hkey) };
    (rc == ERROR_SUCCESS).then_some(hkey)
}

/// UTF-16, null-terminated — the encoding the wide registry APIs want.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
