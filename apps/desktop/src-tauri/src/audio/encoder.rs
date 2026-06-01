//! Final stage: f32 → i16 LE bytes, aggregated into 1-second WS payloads,
//! base64-encoded for transport over the existing JSON `audio_chunk`
//! protocol.
//!
//! Wire format is locked by `packages/shared-types/src/ws.ts::ClientAudioChunk`
//! and demonstrated by `backend/scripts/replay_audio.py` — base64 of raw
//! 16-bit little-endian PCM samples, one sample per channel per
//! 1/16000 s, payload sized to ~1 s. The backend's audio queue caps at
//! 64 chunks (~64 s) of slack, so emitting at the 1 s cadence is the
//! sweet spot.
//!
//! `EncodedChunk.seq` is monotonic across the encoder's lifetime; the
//! WS layer forwards it to the backend so out-of-order delivery is
//! detectable.

use base64::engine::{general_purpose::STANDARD, Engine as _};

use crate::audio::resampler::{FIXED_OUTPUT_FRAMES, TARGET_RATE};

/// 50× 320-sample chunks = 16 000 samples = exactly 1 s at 16 kHz.
pub const FRAMES_PER_CHUNK: usize = 50;
/// 16 000 samples × 2 bytes/sample = 32 000 bytes per chunk.
pub const SAMPLES_PER_CHUNK: usize = FIXED_OUTPUT_FRAMES * FRAMES_PER_CHUNK;
pub const BYTES_PER_CHUNK: usize = SAMPLES_PER_CHUNK * 2;
/// Chunk duration in milliseconds — emitted alongside the payload so the
/// frontend can show progress without decoding the base64.
pub const CHUNK_DURATION_MS: u32 = (SAMPLES_PER_CHUNK as u32 * 1000) / TARGET_RATE;

/// One encoder output, ready for the WS layer.
#[derive(Debug, Clone)]
pub struct EncodedChunk {
    pub seq: u64,
    pub pcm_base64: String,
    pub duration_ms: u32,
}

#[derive(Debug, Default, Clone)]
pub struct EncoderStats {
    pub chunks_emitted: u64,
    pub samples_in: u64,
    pub trailing_samples_flushed: u32,
}

/// Stateful encoder. The pipeline pushes 320-sample voice frames in;
/// when 50 have accumulated, the encoder produces one chunk.
pub struct ChunkEncoder {
    /// i16 samples buffered toward the next chunk.
    pcm: Vec<i16>,
    seq: u64,
    stats: EncoderStats,
}

impl ChunkEncoder {
    pub fn new() -> Self {
        Self {
            pcm: Vec::with_capacity(SAMPLES_PER_CHUNK),
            seq: 0,
            stats: EncoderStats::default(),
        }
    }

    pub fn next_seq(&self) -> u64 {
        self.seq
    }

    pub fn stats(&self) -> &EncoderStats {
        &self.stats
    }

    /// Push one frame's worth of f32 samples (typically 320 from the
    /// VAD's voice path) and emit a chunk if the threshold is reached.
    /// Returns `Some(chunk)` when a complete 1-second chunk has been
    /// produced, otherwise `None`.
    pub fn push_frame(&mut self, frame: &[f32]) -> Option<EncodedChunk> {
        for &s in frame {
            self.pcm.push(f32_to_i16(s));
        }
        self.stats.samples_in += frame.len() as u64;

        if self.pcm.len() >= SAMPLES_PER_CHUNK {
            Some(self.emit_full_chunk())
        } else {
            None
        }
    }

    /// At session end, flush any partial buffer as a smaller chunk.
    /// Returns `None` if there's nothing pending.
    pub fn flush(&mut self) -> Option<EncodedChunk> {
        if self.pcm.is_empty() {
            return None;
        }
        let len = self.pcm.len() as u32;
        let pcm = std::mem::take(&mut self.pcm);
        let duration_ms = (len * 1000) / TARGET_RATE;
        self.stats.trailing_samples_flushed = len;
        Some(self.emit_chunk_with(pcm, duration_ms))
    }

    fn emit_full_chunk(&mut self) -> EncodedChunk {
        let mut pcm = std::mem::replace(&mut self.pcm, Vec::with_capacity(SAMPLES_PER_CHUNK));
        // If the VAD ever passes a partial frame (it shouldn't), trim
        // down to the chunk size and put the overflow back.
        if pcm.len() > SAMPLES_PER_CHUNK {
            self.pcm.extend_from_slice(&pcm[SAMPLES_PER_CHUNK..]);
            pcm.truncate(SAMPLES_PER_CHUNK);
        }
        self.emit_chunk_with(pcm, CHUNK_DURATION_MS)
    }

    fn emit_chunk_with(&mut self, pcm: Vec<i16>, duration_ms: u32) -> EncodedChunk {
        let seq = self.seq;
        self.seq += 1;
        self.stats.chunks_emitted += 1;

        let bytes = i16_slice_to_le_bytes(&pcm);
        let pcm_base64 = STANDARD.encode(&bytes);
        EncodedChunk {
            seq,
            pcm_base64,
            duration_ms,
        }
    }
}

impl Default for ChunkEncoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Saturating f32→i16 conversion at the [-1.0, 1.0] convention. Out-of-
/// range f32s clamp to i16::MIN/i16::MAX rather than wrapping.
#[inline]
fn f32_to_i16(s: f32) -> i16 {
    let scaled = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round();
    scaled as i16
}

/// Pack i16 samples as little-endian bytes — backend's
/// `pcm16le-mono-16khz` contract.
fn i16_slice_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}
