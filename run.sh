#!/bin/bash

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     🎵  Eliz's LRC Generator  🎵                     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Activate virtual environment
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
else
    echo "[ERROR] Virtual environment not found."
    echo "Please run ./install.sh first."
    exit 1
fi

echo "Starting server..."
echo ""
echo "Open your browser to: http://127.0.0.1:8765"
echo "Press Ctrl+C to stop the server."
echo ""

python3 backend/app.py --host 127.0.0.1 --port 8765