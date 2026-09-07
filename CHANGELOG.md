# Changelog

All notable changes to **ELYSY** = **E**liz's **Ly**rics **SY**nchronizer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-09

### Added
- **Rebrand**: now **ELYSY | Eliz's Lyrics Synchronizer**.
- Server auto-opens the browser once the app is ready (`--no-browser` to disable).
- Karaoke-style word ends are now normalized **server-side** on alignment, so
  exports (Enhanced LRC / Enhanced SRT) are always contiguous — no gaps.
- Project state now marks **Unsaved** (red) after re-aligning, manual-tap
  refinement, or LRC import of a loaded project.
- Undo stacks are cleared on align / refine / load / import, so `Ctrl+Z` can
  never restore a snapshot from a previous session.

### Fixed
- Removed dead imports and a no-op line in the LRC import path.
- Headless/browser-title now reads ELYSY.

[1.1.0]: https://github.com/gabrielxcom/elysy/releases/tag/v1.1.0

## [1.0.0] - 2026-08-14

### Added

#### Alignment
- **AI Auto-Align** mode: Demucs vocal separation → WhisperX forced alignment →
  difflib lyrics matcher. Preserves every original line and word (interpolates
  words the transcriber misses, flags them as low-confidence).
- **Manual Tap + AI** mode: tap `Space` per line, review & nudge the line timing,
  then refine word timing within your tapped windows.
- **Monotonic timestamp enforcement** — reorders out-of-order words from repeated
  sections (e.g., a chorus sung twice).

#### Editor
- **Word-by-word precision controls** (`« < 00:23.45 > »`) with ±0.1 s / ±0.3 s
  nudge and audio preview at the exact word position.
- **Line controls**: nudge `« < > »`, edit, insert, delete.
- **Multi-line select + batch shift** (`Ctrl`/`Cmd`+click, then −0.1 / +0.1).
- **Undo / Redo** (50-step history): `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, plus buttons.
- **Karaoke-style word ends** — each word highlights up to the next word's start.
- **Seek-to-start** transport button (⏮).
- Word click now seeks **and** plays a short preview.

#### Projects & files
- **Save / Save As New** — self-contained project folders (audio + `project.json`).
- **Load** — reopen saved projects instantly.
- **Import LRC** — load standard or enhanced `.lrc` files to fix them up
  (with audio-first prompt and optional even word-splitting).
- **`/api/sync-alignment`** — edits sync to the backend so exports match the editor.
- Safe-delete: the backend only deletes temp uploads, **never** saved project files.

#### Exports
- **Enhanced SRT** (word-by-word captions) — works in Premiere & CapCut.
- Distinct filenames per format: `song_enhanced-LRC.lrc`, `song_standard-LRC.lrc`,
  `song_premiere-SRT.srt`, `song_enhanced-SRT.srt`, `song_JSON.json`.

#### Stats & UI
- Stats panel: Words, Lines, Match Rate, **Vocal Duration**, **Song Duration**,
  **Project State** (Saved / Unsaved / Not saved).
- "Guides and more" section (image + pill links — placeholders for your content).
- Redesigned left panel (compact upload zone, language row, Lyrics + Import row,
  vocal-sep + line-count row, rewritten shortcut hints).

#### Docs & packaging
- `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `docs/USER_GUIDE.md`.
- `install.bat`: FFmpeg check, CUDA 12.8 pin (`torch==2.8.0+cu128`) for whisperX
  compatibility + Blackwell GPUs, `--force-reinstall` to avoid file-lock issues,
  CPU fallback. 100% ASCII-safe.
- `.gitignore` covers `projects/` (user data) and generated `*.lrc` / `*.srt`.

### Changed
- Alignment output now **always preserves the original lyrics** (lines + words),
  rather than Whisper's transcription.
- Manual mode uses one full-song transcription (reliable) instead of fragile
  per-window VAD.
- Duration stat clamped to non-negative (no more `-1:-2`).

### Fixed
- Status badge now frontend-driven (no more "32 lines" on a fresh page load).
- "Create New Project" no longer deletes saved project audio.
- Import `mutagen` (audio-duration fallback) added to `requirements.txt`.
- Redundant/unused imports and dead code removed.

### Security / safety
- Backend only ever deletes files in its own temp upload folder.
- File names sanitized for project folders.

---

[1.0.0]: https://github.com/YOUR_USERNAME/eliz-lrc-generator/releases/tag/v1.0.0