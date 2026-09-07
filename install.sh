#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ 🎵  ELYSY | Eliz's Lyrics Synchronizer — Installer  🎵      ║"
echo "║              macOS / Linux                                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python 3 is not installed."
    echo "Install it from https://python.org or your package manager."
    exit 1
fi

echo "[OK] Python found: $(python3 --version)"

# Create virtual environment
echo ""
echo "[STEP 1/4] Creating virtual environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "[OK] Virtual environment created."
else
    echo "[OK] Virtual environment already exists."
fi

# Activate
source venv/bin/activate

# Upgrade pip
echo ""
echo "[STEP 2/4] Upgrading pip..."
pip install --upgrade pip --quiet

# Install PyTorch
echo ""
echo "[STEP 3/4] Installing PyTorch..."
# CPU-only on macOS/Linux by default (CUDA version if available)
if python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null | grep -q "True"; then
    pip install torch torchaudio --quiet
else
    echo "   (CPU-only mode — no NVIDIA GPU detected)"
    pip install torch torchaudio --quiet
fi

# Install core dependencies
echo ""
echo "[STEP 4/4] Installing core dependencies..."
pip install -r backend/requirements.txt --quiet

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     ✅  Installation Complete!                       ║"
echo "║                                                    ║"
echo "║     Run the app with:  ./run.sh                     ║"
echo "║     Then open:  http://127.0.0.1:8765               ║"
echo "╚══════════════════════════════════════════════════════╝"