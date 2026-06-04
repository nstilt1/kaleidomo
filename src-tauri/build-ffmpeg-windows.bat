@echo off
setlocal enabledelayedexpansion

REM Builds an LGPL-only FFmpeg sidecar for the current Windows host architecture
REM and copies it to src-tauri\binaries\ffmpeg-%TARGET_TRIPLE%.exe.
REM
REM Run this from a MSYS2 MinGW64 shell or from Command Prompt after installing MSYS2
REM and adding its MinGW64 tools to PATH.
REM
REM Recommended MSYS2 packages:
REM   pacman -S --needed git make nasm diffutils mingw-w64-x86_64-gcc mingw-w64-x86_64-pkgconf
REM
REM Then from the repo root:
REM   src-tauri\build-ffmpeg-windows.bat

where rustc >nul 2>nul
if errorlevel 1 (
  echo rustc is required so the Tauri target triple can be detected.
  exit /b 1
)

for /f "tokens=2" %%A in ('rustc -Vv ^| findstr /b "host:"') do set TARGET_TRIPLE=%%A
if "%TARGET_TRIPLE%"=="" (
  echo Failed to detect Rust host target triple.
  exit /b 1
)

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%..
set BUILD_ROOT=%SCRIPT_DIR%ffmpeg-build
if "%FFMPEG_REF%"=="" set FFMPEG_REF=n7.1.1
if "%JOBS%"=="" set JOBS=%NUMBER_OF_PROCESSORS%

if not exist "%SCRIPT_DIR%binaries" mkdir "%SCRIPT_DIR%binaries"
if not exist "%BUILD_ROOT%" mkdir "%BUILD_ROOT%"

where bash >nul 2>nul
if errorlevel 1 (
  echo bash was not found. Install MSYS2 and make sure bash, git, make, nasm, and gcc are on PATH.
  exit /b 1
)

bash -lc "set -euo pipefail; cd '$(cygpath -u '%BUILD_ROOT%')'; if [ ! -d ffmpeg/.git ]; then git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg; fi; cd ffmpeg; git fetch --tags --force; git checkout '%FFMPEG_REF%'; make distclean >/dev/null 2>&1 || true; ./configure --prefix='$(cygpath -u '%BUILD_ROOT%')/install-%TARGET_TRIPLE%' --disable-gpl --disable-nonfree --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-static --disable-shared; make -j%JOBS%; make install; cp '$(cygpath -u '%BUILD_ROOT%')/install-%TARGET_TRIPLE%/bin/ffmpeg.exe' '$(cygpath -u '%SCRIPT_DIR%')/binaries/ffmpeg-%TARGET_TRIPLE%.exe'; git diff > '$(cygpath -u '%SCRIPT_DIR%')/binaries/ffmpeg-%TARGET_TRIPLE%-changes.diff'; ./ffmpeg.exe -version > '$(cygpath -u '%SCRIPT_DIR%')/binaries/ffmpeg-%TARGET_TRIPLE%-version.txt' || true; cat > '$(cygpath -u '%SCRIPT_DIR%')/binaries/ffmpeg-%TARGET_TRIPLE%-build-notes.txt' <<EOF
FFmpeg ref: %FFMPEG_REF%
Target triple: %TARGET_TRIPLE%
Configure line:
./configure --prefix=$(cygpath -u '%BUILD_ROOT%')/install-%TARGET_TRIPLE% --disable-gpl --disable-nonfree --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-static --disable-shared
EOF"

if errorlevel 1 exit /b 1

echo Built sidecar: %SCRIPT_DIR%binaries\ffmpeg-%TARGET_TRIPLE%.exe
