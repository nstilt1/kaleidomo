# Changelog

All notable changes to Kaleidomo are documented here.

### 1.3.3 — 2026-09-24

- Fixed export progress bar disappearing after switching pages.
- Fixed zoom rates to accept different units.
- Fixed zoom rates being rounded down to a whole number in live previews.
- Fixed issue where Kaleidomo.exe would continue to run on Windows after closing it.

### 1.3.2 — 2026-09-23

- Fixed Windows WASM/WGPU bug that prevented the live preview from loading.

## 1.3 — 2026-09-20

- Added multiple enhancement algorithms for anti-aliasing and supersampling.
- Added several seeded "recolor" algorithms for quickly recoloring the output.
- Added progress checking for exporting video.
- Added Undo/Redo feature.
- Fixed live preview resolution and FPS rendering on macOS.

## 1.2 — 2026-07-28

- Added CLI for windows EXE so that you can run the app from the command line with a preset file path like so:
```bat
kaleidomo.exe "C:\Path\To\Preset.kmo.json"
```
- Removed some license limits so that high quality live feeds can be streamed without needing a license.

## 1.1 — 2026-07-15

- Added a full screen mode.
- Added live audio peak monitoring and reactivity from other apps for both Windows and MacOS.

## 1.0 — 2026-06-05

- First stable release of Kaleidomo.
- Added live preview pane.
- Added audio reactivity with uploaded audio.

## 0.9 — 2026-04-01

- Initial public beta release.
- Added basic kaleidoscope generation.
- Added early parameter controls.
- Added initial GPU rendering support.