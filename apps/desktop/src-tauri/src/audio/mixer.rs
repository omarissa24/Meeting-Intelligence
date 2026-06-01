//! Two-stream mono mixer at 16 kHz.
//!
//! Both inputs arrive at the same sample rate (16 kHz mono f32) — the
//! system path arrives natively that way from ScreenCaptureKit, the
//! mic path goes through `audio::resampler` first. The mixer holds a
//! small per-source ring buffer, pops `FIXED_OUTPUT_FRAMES` (320)
//! samples from each, sums with 0.5 gain, and hard-clips to [-1, 1].
//!
//! Sources can come and go: if one buffer is empty, the mixer treats
//! that source as silence for the missing slot rather than blocking on
//! it. This is what lets the system or mic source individually fail or
//! be disabled without breaking the pipeline.
//!
//! Drift policy (plan risk #2): the two streams have independent clocks
//! and will drift over a long session. If one source's queued sample
//! count exceeds the other by more than `DRIFT_THRESHOLD_SAMPLES` (50
//! ms), we drop the oldest 20 ms (320 samples) from the lead source to
//! resync. Sample-perfect alignment is not required — speech-quality
//! tolerance is a lot looser than that.

use std::collections::VecDeque;

use crate::audio::resampler::FIXED_OUTPUT_FRAMES;

/// 50 ms at 16 kHz. Above this, we discard one chunk from the lead
/// source to catch the lagging one back up.
const DRIFT_THRESHOLD_SAMPLES: usize = 800;

/// 0.5 per source so the summed peak still lands at ±1.0 in the worst
/// case (both sources clipping). Hard-clip on overshoot.
const PER_SOURCE_GAIN: f32 = 0.5;

#[derive(Debug, Default, Clone)]
pub struct MixerStats {
    /// Total chunks emitted on `try_emit_chunk`.
    pub chunks_emitted: u64,
    /// Times we dropped a chunk from the system source to realign.
    pub system_drift_drops: u64,
    /// Times we dropped a chunk from the mic source to realign.
    pub mic_drift_drops: u64,
    /// Total samples ever pushed (per source).
    pub system_samples_in: u64,
    pub mic_samples_in: u64,
}

pub struct Mixer {
    system: VecDeque<f32>,
    mic: VecDeque<f32>,
    stats: MixerStats,
}

impl Mixer {
    pub fn new() -> Self {
        Self {
            // Cap each ring at ~2 s of audio. Anything older than that
            // is gone anyway — the worker is too far behind to recover.
            system: VecDeque::with_capacity(2 * 16_000),
            mic: VecDeque::with_capacity(2 * 16_000),
            stats: MixerStats::default(),
        }
    }

    pub fn stats(&self) -> &MixerStats {
        &self.stats
    }

    /// Push samples from the system audio source. Caller should ensure
    /// the slice is mono f32 at 16 kHz; we don't validate here because
    /// the source struct already enforces that contract.
    pub fn push_system(&mut self, samples: &[f32]) {
        self.system.extend(samples.iter().copied());
        self.stats.system_samples_in += samples.len() as u64;
        self.handle_drift();
    }

    /// Push samples from the mic source after resampling+downmix to
    /// 16 kHz mono.
    pub fn push_mic(&mut self, samples: &[f32]) {
        self.mic.extend(samples.iter().copied());
        self.stats.mic_samples_in += samples.len() as u64;
        self.handle_drift();
    }

    /// If at least 320 samples of *either* source are queued, emit one
    /// 320-sample mixed chunk. The slot for an empty source is treated
    /// as silence — this keeps the pipeline running while only one
    /// source is active.
    ///
    /// Returns `true` if a chunk was written into `out`.
    pub fn try_emit_chunk(&mut self, out: &mut [f32]) -> bool {
        debug_assert_eq!(out.len(), FIXED_OUTPUT_FRAMES);
        if self.system.len() < FIXED_OUTPUT_FRAMES && self.mic.len() < FIXED_OUTPUT_FRAMES {
            return false;
        }

        for slot in out.iter_mut().take(FIXED_OUTPUT_FRAMES) {
            let s = self.system.pop_front().unwrap_or(0.0);
            let m = self.mic.pop_front().unwrap_or(0.0);
            let mixed = (s + m) * PER_SOURCE_GAIN;
            *slot = mixed.clamp(-1.0, 1.0);
        }
        self.stats.chunks_emitted += 1;
        true
    }

    /// One source significantly ahead of the other → drop a chunk from
    /// the leader. Cheap, ungraceful, and effective for the speech-band
    /// drift tolerances we need. Sample-aligning across two independent
    /// clocks at 16 kHz isn't worth the complexity.
    fn handle_drift(&mut self) {
        if self.system.len() > self.mic.len() + DRIFT_THRESHOLD_SAMPLES {
            let drop = self.system.len() - self.mic.len() - DRIFT_THRESHOLD_SAMPLES;
            let drop = drop.min(FIXED_OUTPUT_FRAMES);
            for _ in 0..drop {
                self.system.pop_front();
            }
            self.stats.system_drift_drops += 1;
        } else if self.mic.len() > self.system.len() + DRIFT_THRESHOLD_SAMPLES {
            let drop = self.mic.len() - self.system.len() - DRIFT_THRESHOLD_SAMPLES;
            let drop = drop.min(FIXED_OUTPUT_FRAMES);
            for _ in 0..drop {
                self.mic.pop_front();
            }
            self.stats.mic_drift_drops += 1;
        }
    }
}

impl Default for Mixer {
    fn default() -> Self {
        Self::new()
    }
}
