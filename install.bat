@echo off
echo.
echo ==========================================================
echo   ELYSY - Installer
echo.
echo   This will install all dependencies automatically.
echo   It may take 5-15 minutes on first run.
echo ==========================================================
echo.

REM ----------------------------------------------------------
REM  1. Python check (required)
REM ----------------------------------------------------------
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.10+ from https://python.org
    echo Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)
echo [OK] Python found:
python --version
echo.

REM ----------------------------------------------------------
REM  2. FFmpeg check (recommended, NOT blocking)
REM ----------------------------------------------------------
REM ELYSY decodes WAV/FLAC/OGG natively. FFmpeg is only needed
REM for MP3/M4A input. So we warn, not block.
ffmpeg -version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] FFmpeg was not found on PATH.
    echo        It is only required for MP3/M4A audio files.
    echo        Install it later if needed:
    echo        winget install Gyan.FFmpeg
    echo        (then reopen your terminal so the PATH refreshes)
    echo.
) else (
    echo [OK] FFmpeg found.
    echo.
)

REM ----------------------------------------------------------
REM  3. Virtual environment
REM ----------------------------------------------------------
echo [STEP 1/4] Creating virtual environment...
if not exist "venv" (
    python -m venv venv
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Could not create virtual environment.
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created.
) else (
    echo [OK] Virtual environment already exists.
)
echo.

REM ----------------------------------------------------------
REM  4. Activate + upgrade pip
REM ----------------------------------------------------------
call venv\Scripts\activate.bat
echo [STEP 2/4] Upgrading pip...
python -m pip install --upgrade pip --quiet
echo [OK] pip upgraded.
echo.

REM ----------------------------------------------------------
REM  5. PyTorch with CUDA 12.8 (pinned for whisperx) + CPU fallback
REM     NOTE: do NOT use --no-deps here. The cu128 wheels need the
REM     nvidia-* runtime packages that pip installs automatically.
REM ----------------------------------------------------------
echo [STEP 3/4] Installing PyTorch (CUDA 12.8, pinned for whisperx)...
echo This is the largest download (~2.5 GB + CUDA libraries). Please wait...
echo.
pip install --force-reinstall torch==2.8.0+cu128 torchaudio==2.8.0+cu128 torchvision==0.23.0+cu128 --index-url https://download.pytorch.org/whl/cu128
echo.

REM Verify CUDA by checking the actual output text (not just exit code)
python -c "import torch; print('CUDA available:', torch.cuda.is_available())" > cuda_check.txt 2>&1
findstr /C:"CUDA available: True" cuda_check.txt >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    del cuda_check.txt
    echo [OK] PyTorch installed with CUDA support.
) else (
    type cuda_check.txt
    del cuda_check.txt
    echo.
    echo [WARN] PyTorch cu128 was installed but CUDA was NOT detected.
    echo        This is usually a driver issue. ELYSY needs an NVIDIA
    echo        driver that supports CUDA 12.8 or newer.
    echo        Check the top-right "CUDA Version" of: nvidia-smi
    echo.
    echo        Falling back to CPU-only mode (works, but slower)...
    pip install --force-reinstall torch==2.8.0 torchaudio==2.8.0
)
echo.

REM ----------------------------------------------------------
REM  6. Core dependencies
REM ----------------------------------------------------------
echo [STEP 4/4] Installing core dependencies...
pip install -r backend\requirements.txt --quiet
echo [OK] Core dependencies installed.
echo.

REM ----------------------------------------------------------
REM  7. Verify
REM ----------------------------------------------------------
echo [VERIFY] Checking installation...
python -c "import torch; print('PyTorch', torch.__version__, '| CUDA:', torch.cuda.is_available())" 2>nul
python -c "import flask; print('Flask OK')" 2>nul || echo [WARN] Flask may need additional setup.
python -c "import whisperx; print('WhisperX OK')" 2>nul || echo [WARN] WhisperX may need additional setup.
echo.

echo ==========================================================
echo   Installation Complete!
echo.
echo   Run the app with:  run.bat
echo   Then open:  http://127.0.0.1:8765
echo ==========================================================
echo.
pause