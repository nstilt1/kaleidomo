#!/usr/bin/env bash
# src-tauri/build-ffmpeg-macos.sh
set -euo pipefail

# Builds LGPL-only FFmpeg sidecars for:
#   - x86_64-apple-darwin
#   - aarch64-apple-darwin
#   - x86_64-pc-windows-msvc.exe  (cross-compiled via MinGW)
# and creates a universal macOS binary via lipo.
#
# These builds link against Cisco's OpenH264 (BSD-2-Clause, NOT GPL/nonfree)
# to get an actual H.264 encoder (`libopenh264`) into the bundled ffmpeg —
# `--disable-gpl` means `libx264` is not an option, and FFmpeg has no
# built-in/native H.264 encoder, so without this the bundled ffmpeg cannot
# encode H.264 at all. This mirrors the `openh264` crate already used
# elsewhere in the project, so the licensing story is unchanged.
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
OPENH264_REF="${OPENH264_REF:-v2.5.0}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
CROSS="x86_64-w64-mingw32"

for cmd in git nasm lipo "${CROSS}-gcc" pkg-config; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required tool: $cmd" >&2
    echo "  Install with: brew install nasm mingw-w64 pkg-config" >&2
    exit 1
  fi
done

mkdir -p "$BUILD_ROOT" "$SRC_TAURI_DIR/binaries"

# ── OpenH264 (static, per target) ─────────────────────────────────────────
#
# FFmpeg's `libopenh264` encoder links against this at build time — it does
# not vendor or reimplement it. We build it once per target triple as a
# static lib + pkg-config file, then point FFmpeg's configure at it via
# PKG_CONFIG_PATH so `--enable-libopenh264` can find it.

build_openh264() {
  local TRIPLE="$1"
  shift
  local PREFIX="$BUILD_ROOT/install-$TRIPLE"

  echo ""
  echo "── Building OpenH264 for $TRIPLE ──"

  local SRC_DIR="$BUILD_ROOT/openh264-$TRIPLE"
  if [[ ! -d "$SRC_DIR/.git" ]]; then
    git clone https://github.com/cisco/openh264.git "$SRC_DIR"
  fi
  (
    cd "$SRC_DIR"
    git fetch --tags --force
    git checkout "$OPENH264_REF"
    # `make clean` is NOT safe to rely on here: OpenH264's `clean` target
    # computes the object-file list to remove from the ARCH/OS passed to
    # *that* invocation, so a plain `make clean` (no ARCH= override) only
    # cleans the host's default arch and silently leaves behind objects
    # from a previous run built with a different ARCH=. `git clean -fdx`
    # guarantees a pristine tree regardless of what any previous run did.
    git clean -fdx
    # Everything through `install-static` happens in ONE `make` invocation
    # with the OS/ARCH/CC/CXX overrides ("$@") attached throughout.
    # Previously this was two separate `make` calls — a build, then a
    # bare `make install-static` with no overrides — and that second call
    # is what actually corrupted the archive: `install-static` depends on
    # the static-lib target itself, so without ARCH= that dependency check
    # re-ran under the *host's* default arch (arm64 on Apple Silicon),
    # compiled the missing aarch64-specific objects, and `ar` appended
    # them into the same .a as the x86_64 objects — hence "cputype does
    # not match" from ranlib. BUILDTYPE=Release avoids pulling in debug
    # symbols the sidecar doesn't need.
    make -j"$JOBS" install-static BUILDTYPE=Release PREFIX="$PREFIX" "$@"
  )
  echo "Built OpenH264 for $TRIPLE -> $PREFIX"
}

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

  build_openh264 "$TRIPLE" OS=darwin ARCH="$ARCH" CC="clang -arch $ARCH" CXX="clang++ -arch $ARCH"
  local OPENH264_PREFIX="$BUILD_ROOT/install-$TRIPLE"

  make distclean >/dev/null 2>&1 || true

  PKG_CONFIG_PATH="$OPENH264_PREFIX/lib/pkgconfig" \
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
    --disable-autodetect \
    --enable-libopenh264 \
    --enable-encoder=libopenh264 \
    --arch="$ARCH" \
    --cc="clang -arch $ARCH" \
    --host-cc="clang" \
    --extra-cflags="-arch $ARCH -I$OPENH264_PREFIX/include" \
    --extra-ldflags="-arch $ARCH -L$OPENH264_PREFIX/lib" \
    --pkg-config-flags="--static"

  make -j"$JOBS"
  make install

  cp "$PREFIX/bin/ffmpeg" "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE"
  chmod +x "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE"

  "$PREFIX/bin/ffmpeg" -version > "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE-version.txt" 2>&1 || true
  "$PREFIX/bin/ffmpeg" -hide_banner -encoders 2>&1 | grep -i openh264 \
    >> "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE-version.txt" || {
    echo "WARNING: libopenh264 encoder not found in the built ffmpeg!" >&2
    echo "         Check the OpenH264/FFmpeg configure logs above." >&2
  }

  # Sanity check: `./configure` autodetects and links against ANY optional
  # library it finds installed on the build machine unless told not to
  # (--disable-autodetect above should prevent this, but verify — a
  # Homebrew-installed lib like SDL2 linked in here works fine from a dev
  # shell but breaks inside the signed .app bundle at runtime with a
  # "code signature ... not valid for use in process" dyld error, since
  # macOS's library validation rejects a dylib signed with a different
  # Team ID than the main executable). Flag anything outside
  # /usr/lib, /System, and @rpath/@executable_path (i.e. not part of the
  # OS or statically linked).
  local stray_deps
  stray_deps="$(otool -L "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE" \
    | tail -n +2 \
    | awk '{print $1}' \
    | grep -vE '^(/usr/lib/|/System/|@rpath|@executable_path)')" || true
  if [[ -n "$stray_deps" ]]; then
    echo "WARNING: ffmpeg-$TRIPLE links against non-system libraries — these" >&2
    echo "         will likely fail to load inside the signed .app bundle:" >&2
    echo "$stray_deps" | sed 's/^/         /' >&2
  else
    echo "OK: ffmpeg-$TRIPLE has no stray non-system dylib dependencies."
  fi

  cat > "$SRC_TAURI_DIR/binaries/ffmpeg-$TRIPLE-build-notes.txt" <<EOF
FFmpeg ref: $FFMPEG_REF
OpenH264 ref: $OPENH264_REF
Target triple: $TRIPLE
Configure flags: --disable-gpl --disable-nonfree --disable-doc --disable-debug
                 --disable-ffplay --disable-ffprobe --enable-ffmpeg
                 --enable-static --disable-shared --disable-autodetect
                 --enable-libopenh264 --enable-encoder=libopenh264
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

  build_openh264 "$TRIPLE" OS=mingw_nt ARCH=x86_64 CROSS_PREFIX="${CROSS}-" CC="${CROSS}-gcc" CXX="${CROSS}-g++" AR="${CROSS}-ar"
  local OPENH264_PREFIX="$BUILD_ROOT/install-$TRIPLE"

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
  # statically into the executable. The same applies to OpenH264's
  # static lib below — it must not pull in libwinpthread-1.dll either.
  PKG_CONFIG_PATH="$OPENH264_PREFIX/lib/pkgconfig" \
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
    --disable-autodetect \
    --enable-libopenh264 \
    --enable-encoder=libopenh264 \
    --arch=x86_64 \
    --target-os=mingw32 \
    --cross-prefix="${CROSS}-" \
    --pkg-config=pkg-config \
    --enable-w32threads \
    --disable-pthreads \
    --extra-cflags="-I$OPENH264_PREFIX/include" \
    --extra-ldflags="-L$OPENH264_PREFIX/lib -static -static-libgcc -static-libstdc++" \
    --pkg-config-flags="--static"

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
OpenH264 ref: $OPENH264_REF
Target triple: $TRIPLE
Cross-compiler: $CROSS
Configure flags: --disable-gpl --disable-nonfree --disable-doc --disable-debug
                 --disable-ffplay --disable-ffprobe --enable-ffmpeg
                 --enable-static --disable-shared --disable-autodetect
                 --enable-libopenh264 --enable-encoder=libopenh264
                 --arch=x86_64 --target-os=mingw32 --cross-prefix=${CROSS}-
                 --enable-w32threads --disable-pthreads
                 --extra-ldflags="-static -static-libgcc -static-libstdc++"

NOTE: this .exe cannot run on the macOS build host, so the
"-encoders | grep openh264" sanity check done for the macOS builds isn't
run here. Verify libopenh264 is present by running the built
ffmpeg-${TRIPLE}.exe -encoders on a Windows machine (or under Wine) before
shipping it.
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