# 📖 Eliz's LRC Generator — User Guide

Everything you need to go from audio + lyrics → perfect karaoke files.

---

## 1. First-time setup

### Windows
1. Install **Python 3.10+** from [python.org](https://python.org) — check
   *"Add Python to PATH"*.
2. Double-click **`install.bat`**.
   - It checks for FFmpeg (installs via winget if missing — reopen the terminal
     afterward so the PATH refreshes).
   - Installs PyTorch with **CUDA 12.8** (best for NVIDIA RTX GPUs).
   - Installs the rest of the dependencies.
   - **First run downloads ~3.5 GB of AI models.** Be patient.
3. Double-click **`run.bat`** and open **http://127.0.0.1:8765**.

### macOS / Linux
```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
# open http://127.0.0.1:8765