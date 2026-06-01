//! macOS-specific audio capture impls. Built only for macOS; the rest of the
//! audio pipeline (resampler/mixer/vad/encoder/pipeline) is platform-neutral
//! and stays under `audio/`.

pub mod mic;
pub mod permissions;
pub mod system;
