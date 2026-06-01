//! Two-stream mono mixer at 16 kHz.
//!
//! Both inputs arrive at the same sample rate (16 kHz mono f32) — the
//! system path arrives natively that way from ScreenCaptureKit, the
//! mic path goes through `audio::resampler` first. The mixer holds a
//! small per-source ring buffer, pops `FIXED_OUTPUT_FRAMES` (320)
//! samples from each, sums with 0.5 gain when both are contributing
//! (unity gain when only one is), and hard-clips to [-1, 1].
//!
//! Active-source tracking: each source is marked active once it has
//! pushed any samples. A source is considered absent only if it has
//! never produced any data — that case happens during session
//! teardown (the source has been dropped) or if a platform is
//! configured without a system source. The mixer will never emit a
//! chunk that mixes real audio with a zero-padded slot for a source
//! that's actively pushing but momentarily empty — that produced
//! audible "walkie-talkie" gaps because the resampler bursts samples
//! into the mic queue while the system queue fills smoothly. Wait
//! for both queues to have ≥320 samples before emitting. The drift
//! policy below keeps the queues from diverging unboundedly.
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

/// Gain applied per source when BOTH are contributing — 0.5 keeps the
/// summed peak at ±1.0 in the worst case where both sources clip
/// simultaneously. When only one source is active in a given chunk
/// (the common case — the user is speaking and nothing is playing,
/// or vice versa), we apply unity gain so we don't pointlessly drop
/// the speech 6 dB before sending it to STT.
const BOTH_SOURCES_GAIN: f32 = 0.5;

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
    /// True once the source has pushed any samples. Used to distinguish
    /// "source is live but momentarily empty" (wait) from "source has
    /// never pushed and isn't going to" (drain the other side).
    system_active: bool,
    mic_active: bool,
    stats: MixerStats,
}

impl Mixer {
    pub fn new() -> Self {
        Self {
            // Cap each ring at ~2 s of audio. Anything older than that
            // is gone anyway — the worker is too far behind to recover.
            system: VecDeque::with_capacity(2 * 16_000),
            mic: VecDeque::with_capacity(2 * 16_000),
            system_active: false,
            mic_active: false,
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
        if !samples.is_empty() {
            self.system_active = true;
        }
        self.system.extend(samples.iter().copied());
        self.stats.system_samples_in += samples.len() as u64;
        self.handle_drift();
    }

    /// Push samples from the mic source after resampling+downmix to
    /// 16 kHz mono.
    pub fn push_mic(&mut self, samples: &[f32]) {
        if !samples.is_empty() {
            self.mic_active = true;
        }
        self.mic.extend(samples.iter().copied());
        self.stats.mic_samples_in += samples.len() as u64;
        self.handle_drift();
    }

    /// Emit one 320-sample mixed chunk if we can do so without
    /// stretching time. Concretely:
    ///   - If both sources are active, emit only when BOTH have ≥320
    ///     queued samples. This prevents the resampler's burst output
    ///     pattern from racing ahead of the system source and producing
    ///     half-zero chunks (the "walkie-talkie" bug).
    ///   - If only one source has ever pushed samples (the other is
    ///     absent — e.g. teardown, or never present), emit using that
    ///     source alone with unity gain.
    ///
    /// Per-source gain is 0.5 when both contribute (avoids clipping),
    /// unity when only one is active.
    ///
    /// Returns `true` if a chunk was written into `out`.
    pub fn try_emit_chunk(&mut self, out: &mut [f32]) -> bool {
        debug_assert_eq!(out.len(), FIXED_OUTPUT_FRAMES);
        let system_has_chunk = self.system.len() >= FIXED_OUTPUT_FRAMES;
        let mic_has_chunk = self.mic.len() >= FIXED_OUTPUT_FRAMES;

        let (drain_system, drain_mic, gain) = match (
            self.system_active,
            self.mic_active,
            system_has_chunk,
            mic_has_chunk,
        ) {
            // Both sources active: wait for both to be ready before mixing.
            // This is the path that prevents the alternating-zero bug.
            (true, true, true, true) => (true, true, BOTH_SOURCES_GAIN),
            (true, true, _, _) => return false,
            // System-only active (mic absent — rare but possible during
            // teardown). Drain system at unity gain.
            (true, false, true, _) => (true, false, 1.0),
            (true, false, false, _) => return false,
            // Mic-only active (system absent). Drain mic at unity gain.
            (false, true, _, true) => (false, true, 1.0),
            (false, true, _, false) => return false,
            // Nothing has ever pushed.
            (false, false, _, _) => return false,
        };

        for slot in out.iter_mut().take(FIXED_OUTPUT_FRAMES) {
            let s = if drain_system {
                self.system.pop_front().unwrap_or(0.0)
            } else {
                0.0
            };
            let m = if drain_mic {
                self.mic.pop_front().unwrap_or(0.0)
            } else {
                0.0
            };
            let mixed = (s + m) * gain;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn drained_chunk(mixer: &mut Mixer) -> Vec<f32> {
        let mut out = vec![0.0; FIXED_OUTPUT_FRAMES];
        assert!(mixer.try_emit_chunk(&mut out), "expected a chunk");
        out
    }

    #[test]
    fn single_active_source_passes_through_at_unity_gain() {
        // System never pushes — only the mic is active.
        let mut m = Mixer::new();
        let mic_samples = vec![0.5f32; FIXED_OUTPUT_FRAMES];
        m.push_mic(&mic_samples);

        let chunk = drained_chunk(&mut m);
        // Every sample should equal 0.5 — NOT 0.25 (the old gain bug).
        for s in &chunk {
            assert!(
                (*s - 0.5).abs() < 1e-6,
                "single-source chunk should be at unity gain, got {s}",
            );
        }
    }

    #[test]
    fn waits_for_both_sources_when_both_active() {
        // Regression test for the "walkie-talkie" alternating-zero bug.
        // Once BOTH sources have pushed any samples, the mixer must wait
        // for both queues to have ≥320 samples before emitting; never
        // produce a chunk where one slot is the active source and the
        // other is `unwrap_or(0.0)`.
        let mut m = Mixer::new();
        // Mark both active by pushing a small amount, then push a full
        // chunk only to the system side.
        m.push_system(&[0.1; 5]);
        m.push_mic(&[0.1; 5]);
        m.push_system(&vec![0.5f32; FIXED_OUTPUT_FRAMES]);

        // System has 325 samples queued, mic has only 5 — must NOT emit.
        let mut out = vec![0.0; FIXED_OUTPUT_FRAMES];
        assert!(
            !m.try_emit_chunk(&mut out),
            "must not emit while one active source is short",
        );

        // Now top up the mic. Both have ≥320 → emit.
        m.push_mic(&vec![0.5f32; FIXED_OUTPUT_FRAMES]);
        assert!(m.try_emit_chunk(&mut out));
    }

    #[test]
    fn both_active_sources_halve_to_avoid_clipping() {
        let mut m = Mixer::new();
        m.push_system(&vec![0.8f32; FIXED_OUTPUT_FRAMES]);
        m.push_mic(&vec![0.8f32; FIXED_OUTPUT_FRAMES]);

        let chunk = drained_chunk(&mut m);
        // (0.8 + 0.8) * 0.5 = 0.8 — both contribute, total stays bounded.
        for s in &chunk {
            assert!(
                (*s - 0.8).abs() < 1e-6,
                "two-source chunk should sum*0.5, got {s}",
            );
        }
    }

    #[test]
    fn two_sources_clipping_hard_clip_to_pm_one() {
        let mut m = Mixer::new();
        m.push_system(&vec![1.0f32; FIXED_OUTPUT_FRAMES]);
        m.push_mic(&vec![1.0f32; FIXED_OUTPUT_FRAMES]);

        let chunk = drained_chunk(&mut m);
        // (1.0 + 1.0) * 0.5 = 1.0 — exactly at the ceiling, no clip needed.
        for s in &chunk {
            assert!((*s - 1.0).abs() < 1e-6, "expected 1.0, got {s}");
        }
    }
}
