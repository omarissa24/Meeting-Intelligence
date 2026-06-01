#!/usr/bin/env bash
# Run cargo-llvm-cov over the desktop Rust crate and print a per-file
# summary. Used to verify Phase-1 DoD line 85 (≥70% coverage on
# audio/vad.rs and audio/resampler.rs).
#
# Notes:
#   - Measures Rust LOC only. C++ deps in `webrtc-vad` are excluded by
#     llvm-cov's design — that is exactly what DoD line 85 asks for, since
#     we want coverage on the Rust wrapper, not the third-party C++
#     classifier.
#   - Filters the report to audio/*.rs so the screenful is focused on
#     the modules under test.

set -euo pipefail

if ! command -v cargo-llvm-cov >/dev/null 2>&1; then
  echo "error: cargo-llvm-cov not found." >&2
  echo "install with: cargo install cargo-llvm-cov" >&2
  exit 1
fi

cd "$(dirname "$0")/../src-tauri"
cargo llvm-cov --lib --no-fail-fast --summary-only "$@"
