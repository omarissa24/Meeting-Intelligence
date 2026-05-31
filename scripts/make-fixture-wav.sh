#!/usr/bin/env bash
# Generate a 16 kHz mono 16-bit PCM WAV that the replay_audio.py tool accepts.
#
# Usage:
#   pnpm fixture                                # default text → /tmp/sample.wav
#   pnpm fixture "Custom text to say"           # custom text → /tmp/sample.wav
#   pnpm fixture "Custom text" ./my-clip.wav    # custom text + output path
#
# Requires:
#   - macOS `say` (built in) OR Linux `espeak-ng`
#   - ffmpeg (brew install ffmpeg)

set -euo pipefail

TEXT="${1:-The quick brown fox jumps over the lazy dog. Hello from Meeting Intelligence.}"
OUT="${2:-/tmp/sample.wav}"
TMP="$(mktemp -t mi-fixture-XXXXXX)"

cleanup() {
  rm -f "$TMP" "$TMP.aiff" "$TMP.raw"
}
trap cleanup EXIT

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found. Install with: brew install ffmpeg" >&2
  exit 1
fi

if command -v say >/dev/null 2>&1; then
  # macOS path: say → aiff → ffmpeg
  AIFF="$TMP.aiff"
  say "$TEXT" -o "$AIFF"
  ffmpeg -y -loglevel error -i "$AIFF" -ar 16000 -ac 1 -acodec pcm_s16le "$OUT"
elif command -v espeak-ng >/dev/null 2>&1; then
  # Linux path: espeak-ng directly emits 16 kHz mono.
  espeak-ng -v en -w "$TMP.raw" "$TEXT"
  ffmpeg -y -loglevel error -i "$TMP.raw" -ar 16000 -ac 1 -acodec pcm_s16le "$OUT"
else
  echo "error: need either 'say' (macOS) or 'espeak-ng' (apt install espeak-ng)" >&2
  exit 1
fi

# Sanity-check the output is what replay_audio.py expects.
RATE="$(ffprobe -v error -show_entries stream=sample_rate -of csv=p=0 "$OUT" 2>/dev/null || echo "")"
echo "wrote $OUT  (${RATE} Hz mono 16-bit PCM)"
echo "→ pnpm replay $OUT"
