//! Voice activity gate.
//!
//! Wraps `webrtc-vad` to drop silent 20 ms frames before they hit the
//! WebSocket. webrtc-vad operates on signed 16-bit PCM and accepts
//! frames of exactly 10/20/30 ms — at 16 kHz that's 160/320/480 samples.
//! We standardise on **20 ms / 320 samples**, matching the resampler's
//! fixed output (see `audio/resampler.rs::FIXED_OUTPUT_FRAMES`).
//!
//! Aggressiveness modes (from least to most permissive about voice):
//!   Quality          — most permissive; lowest false-negative rate
//!   LowBitrate
//!   Aggressive
//!   VeryAggressive   — strictest; highest false-negative rate
//!
//! We default to `Quality` and let the controller bump it up if the
//! ≥30% silence-drop target (US-05) isn't being met on real meeting
//! audio. The plan flags this as risk #4.

use webrtc_vad::{SampleRate, Vad, VadMode};

use crate::audio::resampler::FIXED_OUTPUT_FRAMES;

/// Env var the audio pipeline reads at session start to pick the VAD
/// aggressiveness. See `parse_vad_mode` for accepted values.
pub const VAD_MODE_ENV_VAR: &str = "VAD_MODE";

/// Parse a `VAD_MODE`-style env value into a `VadMode`. Accepts
/// `"quality"`, `"low-bitrate"`, `"aggressive"`, `"very-aggressive"`
/// (case-insensitive, trimmed). `None`, empty, or unrecognised input
/// falls back to `VadMode::Quality` with a warning logged to stderr —
/// same shape as `pipeline::parse_mic_gain_factor`.
///
/// Pure function so the parsing rules stay test-locked.
pub fn parse_vad_mode(env_value: Option<&str>) -> VadMode {
    let trimmed = env_value.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = trimmed else {
        return VadMode::Quality;
    };
    match s.to_ascii_lowercase().as_str() {
        "quality" => VadMode::Quality,
        "low-bitrate" | "lowbitrate" | "low_bitrate" => VadMode::LowBitrate,
        "aggressive" => VadMode::Aggressive,
        "very-aggressive" | "veryaggressive" | "very_aggressive" => {
            VadMode::VeryAggressive
        }
        _ => {
            eprintln!(
                "audio/vad: invalid {VAD_MODE_ENV_VAR}={s:?}, falling back to quality",
            );
            VadMode::Quality
        }
    }
}

/// 320 samples = 20 ms at 16 kHz. webrtc-vad accepts this exact length.
pub const FRAME_SAMPLES: usize = FIXED_OUTPUT_FRAMES;

/// Verdict for a single 20 ms frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Frame contains voice — pass it through to the encoder.
    Voice,
    /// Frame is silence — drop it.
    Silence,
}

#[derive(Debug, thiserror::Error)]
pub enum VadError {
    #[error("invalid frame length {got} (expected {expected})")]
    InvalidFrame { got: usize, expected: usize },
}

/// Stateful VAD gate. Holds the underlying `webrtc-vad::Vad` instance
/// (which is internally stateful — `is_voice_segment` updates it) plus
/// counters useful for the periodic stats event.
pub struct VadGate {
    vad: Vad,
    voice_frames: u64,
    silence_frames: u64,
}

impl VadGate {
    pub fn new(mode: VadMode) -> Self {
        Self {
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, mode),
            voice_frames: 0,
            silence_frames: 0,
        }
    }

    /// Most permissive mode — accept the broadest range of audio as
    /// voice. Use this as the default; raise to `Aggressive` /
    /// `VeryAggressive` if too much silence is leaking through.
    pub fn quality() -> Self {
        Self::new(VadMode::Quality)
    }

    pub fn voice_frames(&self) -> u64 {
        self.voice_frames
    }

    pub fn silence_frames(&self) -> u64 {
        self.silence_frames
    }

    pub fn total_frames(&self) -> u64 {
        self.voice_frames + self.silence_frames
    }

    /// Drop ratio over the gate's lifetime — what fraction of frames
    /// have been classified as silence. Zero when no frames yet.
    pub fn drop_ratio(&self) -> f32 {
        let total = self.total_frames();
        if total == 0 {
            0.0
        } else {
            self.silence_frames as f32 / total as f32
        }
    }

    /// Reset internal state and counters.
    pub fn reset(&mut self) {
        self.vad.reset();
        self.voice_frames = 0;
        self.silence_frames = 0;
    }

    /// Classify exactly one 320-sample 16-bit PCM frame.
    ///
    /// `webrtc-vad` itself returns `Err(())` only when the frame length
    /// is invalid. We pre-check the length so the caller gets a clearer
    /// error and never sees the empty-error from the FFI side.
    pub fn classify(&mut self, frame: &[i16]) -> Result<Verdict, VadError> {
        if frame.len() != FRAME_SAMPLES {
            return Err(VadError::InvalidFrame {
                got: frame.len(),
                expected: FRAME_SAMPLES,
            });
        }
        let voice = self.vad.is_voice_segment(frame).unwrap_or(false);
        if voice {
            self.voice_frames += 1;
            Ok(Verdict::Voice)
        } else {
            self.silence_frames += 1;
            Ok(Verdict::Silence)
        }
    }
}

impl Default for VadGate {
    fn default() -> Self {
        Self::quality()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Resolves the absolute path to the bundled voice fixture WAV.
    /// Used by the GMM-path tests to exercise the real classifier.
    fn voice_wav_path() -> PathBuf {
        // CARGO_MANIFEST_DIR points to apps/desktop/src-tauri at test
        // time, so the fixture lives at tests/fixtures/voice_16k.wav.
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("tests/fixtures/voice_16k.wav");
        p
    }

    /// Minimal WAV reader: locates the `data` sub-chunk by tag and
    /// decodes its body as little-endian i16. Asserts the file is the
    /// expected 16 kHz mono PCM_S16LE format (which is what the fixture
    /// generator script emits). Panics on malformed input — this is
    /// test-only code, the fixture is committed alongside.
    fn read_wav_pcm16(path: &std::path::Path) -> Vec<i16> {
        let bytes = std::fs::read(path).expect("read fixture WAV");
        assert!(bytes.len() > 44, "WAV file too small: {}", bytes.len());
        assert_eq!(&bytes[0..4], b"RIFF", "not a RIFF file");
        assert_eq!(&bytes[8..12], b"WAVE", "not a WAVE file");

        // Walk sub-chunks from offset 12 until we find `data`.
        let mut i = 12usize;
        let mut data_off = None;
        let mut data_len = 0usize;
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let sz = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap())
                as usize;
            if id == b"fmt " {
                // Sanity-check format: PCM(1), channels=1, rate=16000, bps=16.
                let audio_format = u16::from_le_bytes(
                    bytes[i + 8..i + 10].try_into().unwrap(),
                );
                let channels = u16::from_le_bytes(
                    bytes[i + 10..i + 12].try_into().unwrap(),
                );
                let rate = u32::from_le_bytes(
                    bytes[i + 12..i + 16].try_into().unwrap(),
                );
                let bps = u16::from_le_bytes(
                    bytes[i + 22..i + 24].try_into().unwrap(),
                );
                assert_eq!(audio_format, 1, "expected PCM (1), got {audio_format}");
                assert_eq!(channels, 1, "expected mono, got {channels}");
                assert_eq!(rate, 16_000, "expected 16 kHz, got {rate}");
                assert_eq!(bps, 16, "expected 16-bit, got {bps}");
            } else if id == b"data" {
                data_off = Some(i + 8);
                data_len = sz;
                break;
            }
            i += 8 + sz;
        }
        let off = data_off.expect("no `data` chunk in WAV");
        bytes[off..off + data_len]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    fn silence_frame() -> [i16; FRAME_SAMPLES] {
        [0; FRAME_SAMPLES]
    }

    #[test]
    fn frame_size_is_320_samples() {
        // Sanity-check that the public constant matches the resampler's
        // chunk size. If either side moves, the rest of the audio
        // pipeline breaks before this assertion does — but having the
        // assertion makes the contract explicit.
        assert_eq!(FRAME_SAMPLES, FIXED_OUTPUT_FRAMES);
        assert_eq!(FRAME_SAMPLES, 320);
    }

    #[test]
    fn all_zeros_frame_classifies_as_silence() {
        let mut gate = VadGate::quality();
        let verdict = gate.classify(&silence_frame()).unwrap();
        assert_eq!(verdict, Verdict::Silence);
        assert_eq!(gate.silence_frames(), 1);
        assert_eq!(gate.voice_frames(), 0);
    }

    #[test]
    fn voice_wav_majority_classifies_as_voice() {
        // Real GMM-path test. The fixture is ~5 s of synthesised
        // English speech at 16 kHz mono. webrtc-vad's Quality mode
        // should classify the bulk of speech frames as Voice; we
        // assert ≥60% to leave headroom for the leading/trailing
        // silence periods that bookend the clip.
        let samples = read_wav_pcm16(&voice_wav_path());
        let mut gate = VadGate::quality();
        let mut classified = 0u32;
        for frame in samples.chunks_exact(FRAME_SAMPLES) {
            gate.classify(frame).unwrap();
            classified += 1;
        }
        assert!(classified > 100, "fixture too short: {classified} frames");
        let voice_ratio =
            gate.voice_frames() as f32 / gate.total_frames() as f32;
        assert!(
            voice_ratio >= 0.60,
            "expected ≥60% voice frames in speech clip, got {:.1}% ({} voice / {} total)",
            voice_ratio * 100.0,
            gate.voice_frames(),
            gate.total_frames(),
        );
    }

    #[test]
    fn wrong_frame_length_returns_invalid_frame_error() {
        let mut gate = VadGate::quality();
        let short = vec![0i16; FRAME_SAMPLES - 1];
        let long = vec![0i16; FRAME_SAMPLES + 1];

        match gate.classify(&short).unwrap_err() {
            VadError::InvalidFrame { got, expected } => {
                assert_eq!(got, FRAME_SAMPLES - 1);
                assert_eq!(expected, FRAME_SAMPLES);
            }
        }
        match gate.classify(&long).unwrap_err() {
            VadError::InvalidFrame { got, expected } => {
                assert_eq!(got, FRAME_SAMPLES + 1);
                assert_eq!(expected, FRAME_SAMPLES);
            }
        }
        // Counters should not have advanced on error.
        assert_eq!(gate.total_frames(), 0);
    }

    #[test]
    fn counters_advance_with_classification() {
        let mut gate = VadGate::quality();
        for _ in 0..5 {
            gate.classify(&silence_frame()).unwrap();
        }
        assert_eq!(gate.total_frames(), 5);
        assert_eq!(gate.voice_frames() + gate.silence_frames(), 5);
    }

    #[test]
    fn drop_ratio_is_zero_when_no_frames() {
        let gate = VadGate::quality();
        assert_eq!(gate.drop_ratio(), 0.0);
    }

    #[test]
    fn drop_ratio_reflects_silence_fraction_from_voice_wav() {
        // The voice clip is mostly speech, so the silence-drop ratio
        // should be small. Bound it under 0.5 — even with leading/
        // trailing pauses, more than half being silence would mean
        // the classifier has lost its mind.
        let samples = read_wav_pcm16(&voice_wav_path());
        let mut gate = VadGate::quality();
        for frame in samples.chunks_exact(FRAME_SAMPLES) {
            gate.classify(frame).unwrap();
        }
        let ratio = gate.drop_ratio();
        assert!(
            ratio < 0.5,
            "drop ratio on speech should be <0.5, got {ratio:.3}",
        );
    }

    #[test]
    fn reset_clears_counters_and_internal_state() {
        let mut gate = VadGate::quality();
        for _ in 0..3 {
            gate.classify(&silence_frame()).unwrap();
        }
        assert_eq!(gate.total_frames(), 3);

        gate.reset();
        assert_eq!(gate.total_frames(), 0);
        assert_eq!(gate.voice_frames(), 0);
        assert_eq!(gate.silence_frames(), 0);
        assert_eq!(gate.drop_ratio(), 0.0);

        // Classification still works after reset.
        gate.classify(&silence_frame()).unwrap();
        assert_eq!(gate.total_frames(), 1);
    }

    /// `VadMode` (webrtc-vad 0.4) doesn't derive `PartialEq` or `Debug`,
    /// but the variants have explicit `i32` discriminants, so we compare
    /// via cast. This is the same trick we'd use for any foreign enum
    /// without derives.
    fn mode_id(m: &VadMode) -> i32 {
        match m {
            VadMode::Quality => 0,
            VadMode::LowBitrate => 1,
            VadMode::Aggressive => 2,
            VadMode::VeryAggressive => 3,
        }
    }

    #[test]
    fn parse_vad_mode_default_is_quality() {
        assert_eq!(mode_id(&parse_vad_mode(None)), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some(""))), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some("   "))), 0);
    }

    #[test]
    fn parse_vad_mode_recognizes_each_variant() {
        assert_eq!(mode_id(&parse_vad_mode(Some("quality"))), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some("low-bitrate"))), 1);
        assert_eq!(mode_id(&parse_vad_mode(Some("aggressive"))), 2);
        assert_eq!(mode_id(&parse_vad_mode(Some("very-aggressive"))), 3);
    }

    #[test]
    fn parse_vad_mode_is_case_insensitive_and_trimmed() {
        assert_eq!(mode_id(&parse_vad_mode(Some("  AGGRESSIVE  "))), 2);
        assert_eq!(mode_id(&parse_vad_mode(Some("Quality"))), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some("VERY_AGGRESSIVE"))), 3);
        assert_eq!(mode_id(&parse_vad_mode(Some("low_bitrate"))), 1);
    }

    #[test]
    fn parse_vad_mode_falls_back_on_garbage() {
        assert_eq!(mode_id(&parse_vad_mode(Some("banana"))), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some("quality!"))), 0);
        assert_eq!(mode_id(&parse_vad_mode(Some("3"))), 0);
    }

    #[test]
    fn quality_factory_matches_default() {
        // Both factories should produce a gate that classifies the same
        // frame the same way — i.e. they're the same VadMode under the
        // hood. We use the WAV's first frame (it has structure, so the
        // verdict is meaningful and stable across runs).
        let samples = read_wav_pcm16(&voice_wav_path());
        let frame: &[i16] = &samples[0..FRAME_SAMPLES];

        let mut a = VadGate::quality();
        let mut b = VadGate::default();
        assert_eq!(a.classify(frame).unwrap(), b.classify(frame).unwrap());
    }
}
