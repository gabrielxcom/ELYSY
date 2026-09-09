# 🎵 ELYSY | Eliz's Lyrics Synchronizer

![Project Image](https://gabrielx.com/wp-content/uploads/2026/09/ELYSY-1.jpg)

**AI-Powered Word-by-Word Lyrics Synchronization — Free & Open Source (MIT)**

Named in honor of **Eliz**, the sweetest vocalist. 🎤

Turn any song + its lyrics into perfectly timed, **word-by-word** karaoke files.
Upload your audio, paste (or import) the lyrics, and let AI do the alignment —
then fine-tune every word by hand. Runs **100% locally** on your own machine:
no cloud, no paywall, no per-song credits.

---

## ✨ Features

### 🤖 Two alignment modes
- **AI Auto-Align** — upload → paste lyrics → click. Demucs isolates the vocals,
  WhisperX produces word-level timestamps, a matcher maps them onto your *exact*
  lyrics (never Whisper's mangled version).
- **Manual Tap + AI** — tap `Space` at each line boundary, review/nudge the
  line timing, then let AI refine word timing inside your tapped windows.
  Perfect for songs with distortion or unusual phrasing.

### ✏️ Pro-grade editor
- **Word-by-word precision controls** — hover any word for `« < 00:23.45 > »`
  buttons that nudge it by ±0.1s / ±0.3s *with audio preview* at that exact spot.
- **Line controls** — same nudge buttons per line, plus edit / insert / delete.
- **Multi-line select + batch shift** — Ctrl/Cmd-click lines, shift them together.
- **Undo / Redo** — `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y` (50-step history), with
  on-screen buttons.
- **Karaoke-style ends** — every word's highlight runs right up to the next word.

### 💾 Projects
- **Save / Save As New** — self-contained project folders (audio + `project.json`).
- **Load** — reopen any saved project instantly (no re-transcription).
- **Import LRC** — load an existing `.lrc` file (standard or enhanced) to fix it up.

### 📤 Exports (all with distinct filenames)
| Format | Use case |
|--------|----------|
| ⭐ **Enhanced LRC** | Word-by-word karaoke apps |
| ⭐ **Enhanced SRT** | Word-by-word captions for Premiere / CapCut / DaVinci |
| 📄 **Standard LRC** | Classic line-level lyrics |
| 🎬 **SRT (Premiere)** | Line-level subtitles for video editors |
| 🔧 **JSON** | Raw structured data for programmatic use |

### 🌍 Languages
Spanish & English (first-class) + Japanese, Chinese, Korean, Russian,
French, German, Italian, Portuguese.

---

## 🚀 Quick Start

### Install the repo
Command:
`git clone https://github.com/gabrielxcom/elysy.git`

### Windows
```bat
# 1. Double-click to install everything (Python, FFmpeg, CUDA, models)
install.bat

# 2. Double-click to launch
run.bat

# 3. Open your browser
→ http://127.0.0.1:8765

macOS / Linux
 
# 1. Install
chmod +x install.sh run.sh
./install.sh

# 2. Launch
./run.sh

# 3. Open your browser
→ http://127.0.0.1:8765
```

--- 

### Want to support more Open-Source projects? 🤖
*All you need to do is:*
## 🎵 Listen to our songs!
### Visit [I am Eliz Ai .com](https://www.iamelizai.com) 🎵 
We are on YouTube Music, Spotify and Apple Music
