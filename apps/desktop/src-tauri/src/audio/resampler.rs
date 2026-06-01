//! Streaming resampler: any-rate f32 mono → 16 kHz f32 mono with a
//! **fixed 320-sample output** per call. 320 samples at 16 kHz is exactly
//! 20 ms, which is the chunk size webrtc-vad expects, so the downstream
//! VAD gate can consume `process()` output one-for-one.
//!
//! Backed by `rubato::Async` in `FixedAsync::Output` mode. Input frame
//! count varies — `input_frames_next()` reports how many samples to feed
//! before the next `process()` call.
//!
//! The mic path goes through this; the system-audio path doesn't, since
//! ScreenCaptureKit emits 16 kHz natively.

use audioadapter_buffers::direct::SequentialSlice;
use rubato::{
    calculate_cutoff, Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

/// Target rate for everything downstream of resample.
pub const TARGET_RATE: u32 = 16_000;
/// 20 ms at 16 kHz; matches webrtc-vad's frame size requirement.
pub const FIXED_OUTPUT_FRAMES: usize = 320;

#[derive(Debug, thiserror::Error)]
pub enum ResamplerError {
    #[error("constructing resampler: {0}")]
    Construct(String),
    #[error("processing: {0}")]
    Process(String),
    #[error("input rate {0} not supported (must be > 0)")]
    InvalidInputRate(u32),
}

/// Wraps a `rubato::Async` resampler configured for fixed-output mono.
///
/// Hold one per source whose native rate isn't already 16 kHz. The
/// resampler buffers internally, so frames pushed across multiple
/// `process_one_chunk` calls are stitched together — caller just keeps
/// feeding `input_frames_next()` samples at a time.
pub struct SourceResampler {
    inner: Async<f32>,
    input_rate: u32,
    /// Reusable scratch buffer for the input adapter, sized to the
    /// largest `input_frames_next()` we have seen so far.
    input_scratch: Vec<f32>,
}

impl SourceResampler {
    pub fn new(input_rate: u32) -> Result<Self, ResamplerError> {
        if input_rate == 0 {
            return Err(ResamplerError::InvalidInputRate(input_rate));
        }

        let resample_ratio = TARGET_RATE as f64 / input_rate as f64;

        // Conservative quality settings — same shape rubato's own
        // examples use. sinc_len 128 + Blackman2 is a balanced
        // speech-friendly preset; oversampling 2048 keeps interpolation
        // artifacts well below human hearing for the speech band we care
        // about. CPU cost is fine on the 16 kHz output path.
        let sinc_len = 128;
        let oversampling_factor = 2048;
        let interpolation = SincInterpolationType::Linear;
        let window = WindowFunction::Blackman2;
        let f_cutoff = calculate_cutoff(sinc_len, window);
        let params = SincInterpolationParameters {
            sinc_len,
            f_cutoff,
            interpolation,
            oversampling_factor,
            window,
        };

        // In `FixedAsync::Output` mode, `chunk_size` is the fixed number
        // of OUTPUT frames every `process_into_buffer` call produces.
        // Downstream (VAD) wants exactly 320-sample chunks (20 ms @ 16 kHz),
        // so we size the resampler to that — NOT to rubato's example
        // default of 1024, which would make every call demand a 1024-slot
        // output buffer the pipeline doesn't allocate.
        let inner = Async::<f32>::new_sinc(
            resample_ratio,
            1.0, // resample ratio is fixed, so max_relative_ratio = 1.0
            &params,
            FIXED_OUTPUT_FRAMES,
            1, // mono
            FixedAsync::Output,
        )
        .map_err(|e| ResamplerError::Construct(format!("{e:?}")))?;

        Ok(Self {
            inner,
            input_rate,
            input_scratch: Vec::with_capacity(2048),
        })
    }

    pub fn input_rate(&self) -> u32 {
        self.input_rate
    }

    /// Number of input samples needed before the next `process_one_chunk`
    /// call. Caller buffers exactly this many and calls process.
    pub fn input_frames_next(&self) -> usize {
        self.inner.input_frames_next()
    }

    /// Always returns [`FIXED_OUTPUT_FRAMES`] (320). Exposed for parity
    /// with rubato's API rather than because it changes.
    pub fn output_frames_next(&self) -> usize {
        self.inner.output_frames_next()
    }

    /// Consume exactly `input_frames_next()` mono f32 samples and write
    /// `FIXED_OUTPUT_FRAMES` mono f32 samples into `output`.
    ///
    /// Returns the number of output frames actually produced (always 320
    /// in `FixedAsync::Output` mode, but reported back so callers can
    /// trust the contract rather than assume).
    pub fn process_one_chunk(
        &mut self,
        input: &[f32],
        output: &mut [f32],
    ) -> Result<usize, ResamplerError> {
        let needed = self.inner.input_frames_next();
        if input.len() != needed {
            return Err(ResamplerError::Process(format!(
                "expected {needed} input frames, got {}",
                input.len()
            )));
        }
        let want_out = self.inner.output_frames_next();
        if output.len() < want_out {
            return Err(ResamplerError::Process(format!(
                "output buffer too small: {} < {want_out}",
                output.len()
            )));
        }

        // SequentialSlice expects channel-major layout; mono is just a
        // single channel-slice over the whole buffer.
        let in_adapter = SequentialSlice::new(input, 1, needed)
            .map_err(|e| ResamplerError::Process(format!("input adapter: {e:?}")))?;
        let mut out_adapter = SequentialSlice::new_mut(output, 1, want_out)
            .map_err(|e| ResamplerError::Process(format!("output adapter: {e:?}")))?;

        let indexing = Indexing {
            input_offset: 0,
            output_offset: 0,
            active_channels_mask: None,
            partial_len: None,
        };
        let (_in_used, out_written) = self
            .inner
            .process_into_buffer(&in_adapter, &mut out_adapter, Some(&indexing))
            .map_err(|e| ResamplerError::Process(format!("{e:?}")))?;
        Ok(out_written)
    }

    /// Push interleaved or mono f32 samples and emit any 320-sample
    /// output chunks that are ready. Buffers excess input internally.
    /// Returns the number of complete output chunks written into `out_chunks`.
    ///
    /// Convenience wrapper around `process_one_chunk` for callers that
    /// don't want to manage the input-frame pacing themselves.
    pub fn push_and_drain<F: FnMut(&[f32])>(
        &mut self,
        input: &[f32],
        mut on_chunk: F,
    ) -> Result<usize, ResamplerError> {
        self.input_scratch.extend_from_slice(input);
        let mut out_chunks = 0;
        let mut output = vec![0.0f32; FIXED_OUTPUT_FRAMES];

        loop {
            let needed = self.inner.input_frames_next();
            if self.input_scratch.len() < needed {
                break;
            }
            let mut chunk = Vec::with_capacity(needed);
            chunk.extend_from_slice(&self.input_scratch[..needed]);
            self.input_scratch.drain(..needed);
            let written = self.process_one_chunk(&chunk, &mut output)?;
            on_chunk(&output[..written]);
            out_chunks += 1;
        }
        Ok(out_chunks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the contract the pipeline relies on: at common cpal rates the
    /// resampler must accept exactly `FIXED_OUTPUT_FRAMES` slots of output.
    /// If `chunk_size` ever drifts back to rubato's example default of
    /// 1024, this test catches it.
    #[test]
    fn process_accepts_a_fixed_output_frames_buffer_at_common_rates() {
        for &rate in &[44_100u32, 48_000u32] {
            let mut r = SourceResampler::new(rate).expect("construct");
            let needed = r.input_frames_next();
            let input = vec![0.0f32; needed];
            let mut output = vec![0.0f32; FIXED_OUTPUT_FRAMES];
            let written = r
                .process_one_chunk(&input, &mut output)
                .unwrap_or_else(|e| panic!("process at {rate}Hz failed: {e}"));
            assert_eq!(
                written, FIXED_OUTPUT_FRAMES,
                "FixedAsync::Output must produce exactly {FIXED_OUTPUT_FRAMES} frames at {rate}Hz",
            );
        }
    }

    #[test]
    fn push_and_drain_emits_320_sample_chunks() {
        let mut r = SourceResampler::new(48_000).expect("construct");
        // Feed ~1 s of audio at 48 kHz — should produce at least one 320-sample chunk.
        let input = vec![0.0f32; 48_000];
        let mut chunk_lens = Vec::new();
        let n = r
            .push_and_drain(&input, |chunk| chunk_lens.push(chunk.len()))
            .expect("push_and_drain");
        assert!(n > 0, "expected at least one output chunk");
        for len in &chunk_lens {
            assert_eq!(*len, FIXED_OUTPUT_FRAMES, "every chunk must be 320 samples");
        }
    }
}
