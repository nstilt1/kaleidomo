#!/usr/bin/env bash
set -euo pipefail

# Builds an LGPL-only FFmpeg sidecar for the current macOS host architecture
# and copies it to src-tauri/binaries/ffmpeg-$TARGET_TRIPLE.
# Run from anywhere inside the repository:
#   cd /path/to/kaleidomo
#   ./src-tauri/build-ffmpeg-macos.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI_DIR="$SCRIPT_DIR"
PROJECT_ROOT="$(cd "$SRC_TAURI_DIR/.." && pwd)"
BUILD_ROOT="$SRC_TAURI_DIR/ffmpeg-build"
FFMPEG_REF="${FFMPEG_REF:-n7.1.1}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "rustc is required so the Tauri target triple can be detected" >&2
  exit 1
fi

if ! command -v nasm >/dev/null 2>&1; then
  echo "nasm is required. Install it with: brew install nasm" >&2
  exit 1
fi

TARGET_TRIPLE="$(rustc -Vv | awk '/^host:/ { print $2 }')"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "Failed to detect Rust host target triple" >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT" "$SRC_TAURI_DIR/binaries"
cd "$BUILD_ROOT"

if [[ ! -d ffmpeg/.git ]]; then
  git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg
fi

cd ffmpeg
git fetch --tags --force
git checkout "$FFMPEG_REF"

make distclean >/dev/null 2>&1 || true

./configure   --prefix="$BUILD_ROOT/install-$TARGET_TRIPLE"   --disable-gpl   --disable-nonfree   --disable-doc   --disable-debug   --disable-ffplay   --disable-ffprobe   --enable-ffmpeg   --enable-static   --disable-shared

make -j"$JOBS"
make install

cp "$BUILD_ROOT/install-$TARGET_TRIPLE/bin/ffmpeg" "$SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE"
chmod +x "$SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE"

git diff > "$SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE-changes.diff"
./ffmpeg -version > "$SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE-version.txt" || true
cat > "$SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE-build-notes.txt" <<EOF
FFmpeg ref: $FFMPEG_REF
Target triple: $TARGET_TRIPLE
Configure line:
./configure --prefix=$BUILD_ROOT/install-$TARGET_TRIPLE --disable-gpl --disable-nonfree --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-static --disable-shared
EOF

echo "Built sidecar: $SRC_TAURI_DIR/binaries/ffmpeg-$TARGET_TRIPLE"
