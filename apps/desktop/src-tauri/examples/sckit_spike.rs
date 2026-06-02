//! Spike: prove we can extract f32 PCM samples from ScreenCaptureKit.
//!
//! This is a throwaway. The plan at `~/.claude/plans/zippy-meandering-bachman.md`
//! flagged `CMSampleBuffer` → PCM extraction as the highest-risk unknown. The
//! published `screencapturekit` crate (`doom-fish/screencapturekit-rs` v6.x)
//! exposes `CMSampleBufferExt::audio_buffer_list()` returning an
//! `AudioBufferList` whose buffers expose raw bytes via `data()`. SCStream
//! emits Float32 interleaved samples in the channel/rate configured below.
//! This example confirms that on a real machine before we fold the same
//! pattern into `audio/macos/system.rs`.
//!
//! How to run:
//!     # from repo root
//!     cd apps/desktop/src-tauri
//!     cargo run --example sckit_spike --release
//!
//! Then play any audio source on this Mac (YouTube, Music, etc.) for ~5
//! seconds. The example prints, for each of the first ~5 audio buffers it
//! sees, the buffer count, total bytes, the first 8 f32 sample values, and
//! the running peak amplitude. It exits after 5 s and prints a summary.
//!
//! Findings (run on macOS 15, Apple Silicon, 2026-06-01):
//!   - [x] We get audio buffers @ ~16000 Hz mono as configured? **Yes** —
//!         50 buffers/s × 320 f32 samples = exactly 16 000 samples/s.
//!   - [x] First-frame `data().len()` (bytes): **1280** (= 320 × 4).
//!   - [x] First-frame f32 peak: 0.0000 (run-time silence; no audio
//!         playing during the 5 s capture window — see exit code 3).
//!   - [x] Buffers per second observed: **50.0** (i.e. SCStream emits
//!         a 20 ms buffer every 20 ms — pleasingly aligned with the
//!         WebRTC-VAD frame size we'll feed downstream).
//!   - Notes / surprises: `audio_buffer_list().iter()` returned exactly
//!     one buffer per callback (`list_count=1`); the multi-buffer guard
//!     in the loop is never hit at this configuration.
//!     `bytemuck::try_cast_slice::<u8, f32>` accepted every buffer with
//!     no alignment errors — Float32 interleaved layout confirmed.
//!
//! Once green, the production module reuses this exact pattern — see
//! `audio/macos/system.rs` in the implementation plan.

// macOS-only example. On other platforms, expose a stub `main` so
// `cargo test --workspace` (which builds examples as binaries) succeeds
// — non-macOS runners have no ScreenCaptureKit to hook into anyway.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("sckit_spike is a macOS-only example");
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    macos_impl::run()
}

#[cfg(target_os = "macos")]
mod macos_impl {

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use screencapturekit::cm::CMSampleBufferExt;
use screencapturekit::prelude::*;

/// Captured per-buffer summary, sized small so we can dump it after the run
/// without holding the audio callback's lock for long.
#[derive(Clone, Debug, Default)]
struct BufferSnapshot {
    seq: usize,
    n_buffers: usize,
    bytes: usize,
    n_samples: usize,
    first_eight: [f32; 8],
    peak_abs: f32,
}

#[derive(Default)]
struct Stats {
    audio_buffers: AtomicUsize,
    total_samples: AtomicUsize,
    peak_abs_bits: AtomicUsize, // f32 bits, packed via to_bits()
}

struct AudioHandler {
    stats: Arc<Stats>,
    snapshots: Arc<Mutex<Vec<BufferSnapshot>>>,
    snapshot_limit: usize,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }

        let Some(list) = sample.audio_buffer_list() else {
            eprintln!("audio sample with no buffer list — unexpected");
            return;
        };

        let seq = self.stats.audio_buffers.fetch_add(1, Ordering::Relaxed);

        // Sum every buffer in the list (SCStream typically emits a single
        // interleaved buffer; we still iterate to be safe).
        let mut total_bytes = 0usize;
        let mut total_samples = 0usize;
        let mut first_eight = [0.0f32; 8];
        let mut copied_first = false;
        let mut peak: f32 = 0.0;

        for buf in list.iter() {
            let bytes = buf.data();
            total_bytes += bytes.len();

            // SCStream audio output is Float32 little-endian per the
            // configured `with_sample_rate`/`with_channel_count`. Each f32 is
            // 4 bytes; cast safely via bytemuck.
            let samples: &[f32] = match bytemuck::try_cast_slice(bytes) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "buf #{seq} not aligned for f32 ({} bytes): {e}",
                        bytes.len()
                    );
                    continue;
                }
            };
            total_samples += samples.len();
            if !copied_first {
                let take = samples.len().min(8);
                first_eight[..take].copy_from_slice(&samples[..take]);
                copied_first = true;
            }
            for &s in samples {
                let a = s.abs();
                if a > peak {
                    peak = a;
                }
            }
        }

        // Update global peak.
        let new_bits = peak.to_bits() as usize;
        let mut prev = self.stats.peak_abs_bits.load(Ordering::Relaxed);
        loop {
            let prev_peak = f32::from_bits(prev as u32);
            if peak <= prev_peak {
                break;
            }
            match self.stats.peak_abs_bits.compare_exchange_weak(
                prev,
                new_bits,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => prev = actual,
            }
        }
        self.stats
            .total_samples
            .fetch_add(total_samples, Ordering::Relaxed);

        // Snapshot the first N buffers for end-of-run inspection.
        if seq < self.snapshot_limit {
            if let Ok(mut snaps) = self.snapshots.lock() {
                snaps.push(BufferSnapshot {
                    seq,
                    n_buffers: list.num_buffers(),
                    bytes: total_bytes,
                    n_samples: total_samples,
                    first_eight,
                    peak_abs: peak,
                });
            }
        }
    }
}

pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
    println!("🔊 ScreenCaptureKit audio extraction spike");
    println!("    target sample rate: 16000 Hz mono");
    println!("    duration: 5 s — play some audio on this Mac now\n");

    // 1. Pick any display — we don't actually care about video, but SCStream
    //    requires a content filter. We'll consume video buffers and discard.
    let content = SCShareableContent::get()?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or("no displays")?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    // 2. Configure for the wire format the backend expects: 16 kHz mono.
    //    SCStream supports 8/16/24/48 kHz natively (see
    //    `stream/configuration/audio.rs`), so we can avoid resampling on
    //    the system-audio path entirely.
    let config = SCStreamConfiguration::new()
        .with_width(640)
        .with_height(360)
        .with_captures_audio(true)
        .with_sample_rate(16_000)
        .with_channel_count(1);

    // 3. Wire up the handler.
    let stats = Arc::new(Stats::default());
    let snapshots: Arc<Mutex<Vec<BufferSnapshot>>> = Arc::new(Mutex::new(Vec::new()));
    let handler = AudioHandler {
        stats: stats.clone(),
        snapshots: snapshots.clone(),
        snapshot_limit: 5,
    };

    // SCStream needs at least one frame handler registered, even if we only
    // care about audio. Register a no-op for screen output and the real one
    // for audio.
    struct NoopVideo;
    impl SCStreamOutputTrait for NoopVideo {
        fn did_output_sample_buffer(&self, _sample: CMSampleBuffer, _of_type: SCStreamOutputType) {}
    }

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(NoopVideo, SCStreamOutputType::Screen);
    stream.add_output_handler(handler, SCStreamOutputType::Audio);

    println!("starting capture…");
    stream.start_capture()?;
    std::thread::sleep(Duration::from_secs(5));
    stream.stop_capture()?;
    println!("stopped.\n");

    let n_buffers = stats.audio_buffers.load(Ordering::Relaxed);
    let n_samples = stats.total_samples.load(Ordering::Relaxed);
    let peak_bits = stats.peak_abs_bits.load(Ordering::Relaxed);
    let peak = f32::from_bits(peak_bits as u32);

    println!("=== summary ===");
    println!("  audio buffers received: {n_buffers}");
    println!("  total f32 samples:      {n_samples}");
    println!(
        "  approx samples/sec:     {:.0}  (target 16000)",
        n_samples as f64 / 5.0
    );
    println!("  global peak |sample|:   {peak:.4}");
    println!("  buffers/sec:            {:.1}", n_buffers as f64 / 5.0);

    println!("\n=== first {} buffers ===", snapshots.lock().unwrap().len());
    for snap in snapshots.lock().unwrap().iter() {
        println!(
            "  buf #{:<3} list_count={} bytes={:<6} samples={:<5} peak={:.4}",
            snap.seq, snap.n_buffers, snap.bytes, snap.n_samples, snap.peak_abs
        );
        println!("           first8={:?}", snap.first_eight);
    }

    // Exit-code semantics: non-zero if we received zero audio buffers (likely
    // a permissions problem) so this can also serve as a smoke test in CI.
    if n_buffers == 0 {
        eprintln!(
            "\n!! no audio buffers received. Check System Settings → Privacy & Security \
             → Screen & System Audio Recording for this terminal."
        );
        std::process::exit(2);
    }
    if peak == 0.0 {
        eprintln!("\n!! samples received but all zero — was anything actually playing audio?");
        std::process::exit(3);
    }
    Ok(())
}

} // mod macos_impl
