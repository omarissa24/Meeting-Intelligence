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
