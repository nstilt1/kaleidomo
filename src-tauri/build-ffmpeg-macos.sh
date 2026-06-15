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

  # NOTE: The previous version of this script used
  #   --disable-w32threads --enable-pthreads
  # which links against MinGW-w64's winpthreads. On Homebrew's mingw-w64,
  # the import library for winpthreads commonly resolves to the *shared*
  # libwinpthread-1.dll rather than a static .a, producing an .exe that
  # depends on libwinpthread-1.dll at runtime. Since Tauri sidecars are
  # shipped as a single bare executable (no accompanying DLLs), this
  # results in STATUS_DLL_NOT_FOUND (exit code -1073741511 / 0xC0000135)
  # on Windows, with the process crashing before main() runs and producing
  # no stdout/stderr.
  #
  # Fix: use Win32 native threads (--enable-w32threads, the MinGW default
  # and recommended option for Windows builds) instead of pthreads, and
  # pass -static to the linker so any remaining MinGW runtime libs
  # (libgcc, libstdc++, winpthread if pulled in transitively) are linked
  # statically into the executable.
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
    --enable-w32threads \
    --disable-pthreads \
    --extra-ldflags="-static -static-libgcc -static-libstdc++"

  make -j"$JOBS"
  make install

  cp "$PREFIX/bin/ffmpeg.exe" "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}.exe"

  # Sanity check: make sure the resulting binary doesn't depend on any
  # MinGW runtime DLLs that won't be present on a bare Windows install or
  # alongside a Tauri sidecar. Requires x86_64-w64-mingw32-objdump.
  if command -v "${CROSS}-objdump" >/dev/null 2>&1; then
    echo ""
    echo "Checking DLL dependencies of ffmpeg-${TRIPLE}.exe:"
    "${CROSS}-objdump" -p "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}.exe" \
      | grep -i "DLL Name" || true
    if "${CROSS}-objdump" -p "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}.exe" \
        | grep -iE "libwinpthread|libgcc|libstdc\+\+|libssp" ; then
      echo "WARNING: binary still depends on a MinGW runtime DLL above." >&2
      echo "         The sidecar will fail with STATUS_DLL_NOT_FOUND unless" >&2
      echo "         that DLL is bundled alongside it on Windows." >&2
    else
      echo "OK: no MinGW runtime DLL dependencies found."
    fi
  fi

  cat > "$SRC_TAURI_DIR/binaries/ffmpeg-${TRIPLE}-build-notes.txt" <<EOF
FFmpeg ref: $FFMPEG_REF
Target triple: $TRIPLE
Cross-compiler: $CROSS
Configure flags: --disable-gpl --disable-nonfree --disable-doc --disable-debug
                 --disable-ffplay --disable-ffprobe --enable-ffmpeg
                 --enable-static --disable-shared
                 --arch=x86_64 --target-os=mingw32 --cross-prefix=${CROSS}-
                 --enable-w32threads --disable-pthreads
                 --extra-ldflags="-static -static-libgcc -static-libstdc++"
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