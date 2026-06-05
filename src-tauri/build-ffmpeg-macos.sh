#!/usr/bin/env bash
set -euo pipefail

# Builds LGPL-only FFmpeg sidecars for:
#   - x86_64-apple-darwin
#   - aarch64-apple-darwin
#   - x86_64-pc-windows-msvc.exe  (cross-compiled via MinGW)
# and creates a universal macOS binary via lipo.
#
# Prerequisites:
#   brew install nasm mingw-w64
#
# Run from anywhere inside the repository:
#   cd /path/to/kaleidomo
#   ./src-tauri/build-ffmpeg-macos.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI_DIR="$SCRIPT_DIR"
BUILD_ROOT="$SRC_TAURI_DIR/ffmpeg-build"
FFMPEG_REF="${FFMPEG_REF:-n7.1.1}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
CROSS="x86_64-w64-mingw32"

for cmd in git nasm lipo "${CROSS}-gcc"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required tool: $cmd" >&2
    echo "  Install with: brew install nasm mingw-w64" >&2
    exit 1
  fi
done

mkdir -p "$BUILD_ROOT" "$SRC_TAURI_DIR/binaries"

cd "$BUILD_ROOT"
if [[ ! -d ffmpeg/.git ]]; then
  git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg
fi
cd ffmpeg
git fetch --tags --force
git checkout "$FFMPEG_REF"

# ── macOS native builds ───────────────────────────────────────────────────

build_macos() {
  local ARCH="$1"    # x86_64 or arm64
  local TRIPLE="$2"  # x86_64-apple-darwin or aarch64-apple-darwin
  local PREFIX="$BUILD_ROOT/install-$TRIPLE"

  echo ""
  echo "══════════════════════════════════════════"
  echo "  Building $TRIPLE"
  echo "══════════════════════════════════════════"

  make distclean >/dev/null 2>&1 || true

  ./configure \
    --prefix="$PREFIX" \
    --disable-gpl \
    --disable-nonfree \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-ffprobe \
    --enable-ffmpeg \
    --enable-static \
    --disable-shared \
    --arch="$ARCH" \
    --cc="clang -arch $ARCH" \
    --host-cc="clang" \
    --extra-cflags="-arch $ARCH" \
    --extra-ldflags="-arch $ARCH"

  make -j"$JOBS"
  make install

  cp "$PREFIX/bin/ffmpeg" "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE"
  chmod +x "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE"

  "$PREFIX/bin/ffmpeg" -version > "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE-version.txt" 2>&1 || true
  cat > "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE-build-notes.txt" <<EOF
FFmpeg ref: $FFMPEG_REF
Target triple: $TRIPLE
Configure flags: --disable-gpl --disable-nonfree --disable-doc --disable-debug
                 --disable-ffplay --disable-ffprobe --enable-ffmpeg
                 --enable-static --disable-shared
                 --arch=$ARCH --cc="clang -arch $ARCH"
EOF

  echo "Built: $SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE"
}

# ── Windows cross-compile ─────────────────────────────────────────────────

build_windows() {
  local TRIPLE="x86_64-pc-windows-msvc"
  local PREFIX="$BUILD_ROOT/install-$TRIPLE"

  echo ""
  echo "══════════════════════════════════════════"
  echo "  Building $TRIPLE  (MinGW cross-compile)"
  echo "══════════════════════════════════════════"

  make distclean >/dev/null 2>&1 || true

  ./configure \
    --prefix="$PREFIX" \
    --disable-gpl \
    --disable-nonfree \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-ffprobe \
    --enable-ffmpeg \
    --enable-static \
    --disable-shared \
    --arch=x86_64 \
    --target-os=mingw32 \
    --cross-prefix="${CROSS}-" \
    --pkg-config=pkg-config \
    --disable-w32threads \
    --enable-pthreads

  make -j"$JOBS"
  make install

  cp "$PREFIX/bin/ffmpeg.exe" "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}.exe"

  cat > "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}-build-notes.txt" <<EOF
FFmpeg ref: $FFMPEG_REF
Target triple: $TRIPLE
Cross-compiler: $CROSS
Configure flags: --disable-gpl --disable-nonfree --disable-doc --disable-debug
                 --disable-ffplay --disable-ffprobe --enable-ffmpeg
                 --enable-static --disable-shared
                 --arch=x86_64 --target-os=mingw32 --cross-prefix=${CROSS}-
EOF

  echo "Built: $SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}.exe"
}

# ── Run all three ─────────────────────────────────────────────────────────

build_macos x86_64 x86_64-apple-darwin
build_macos arm64  aarch64-apple-darwin
build_windows

# ── Universal macOS binary ────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo "  Creating universal binary via lipo"
echo "══════════════════════════════════════════"
lipo -create \
  "$SRC_TAURI_DIR/binaries/ffmpeg-x86_64-apple-darwin" \
  "$SRC_TAURI_DIR/binaries/ffmpeg-aarch64-apple-darwin" \
  -output "$SRC_TAURI_DIR/binaries/ffmpeg-universal-apple-darwin"

echo ""
echo "All done. Binaries in $SRC_TAURI_DIR/binaries/:"
ls -lh "$SRC_TAURI_DIR/binaries/ffmpeg-"*