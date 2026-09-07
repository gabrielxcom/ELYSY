@echo off
echo.
echo ==========================================================
echo   ELYSY | Eliz's Lyrics Synchronizer - Installer
echo.
echo   This will install all dependencies automatically.
echo   It may take 5-15 minutes on first run.
echo ==========================================================
echo.

REM Check for Python
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

REM Check for FFmpeg (required for audio decoding)
ffmpeg -version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [WARN] FFmpeg is not installed.
    echo        Eliz's LRC Generator needs FFmpeg to decode audio.
    echo        Installing it now via winget...
    winget install Gyan.FFmpeg
    echo.
    echo        IMPORTANT: close this window, reopen it, then run install.bat again.
    echo        (FFmpeg is added to PATH only for NEW terminal windows.)
    pause
    exit /b 1
)
echo [OK] FFmpeg found.

REM Create virtual environment
echo.
echo [STEP 1/4] Creating virtual environment...
if not exist "venv" (
    python -m venv venv
    echo [OK] Virtual environment created.
) else (
    echo [OK] Virtual environment already exists.
)

REM Activate venv
call venv\Scripts\activate.bat

REM Upgrade pip
echo.
echo [STEP 2/4] Upgrading pip...
python -m pip install --upgrade pip --quiet

REM Install PyTorch - CUDA 12.8 pinned to 2.8.0 for whisperx compatibility
echo.
echo [STEP 3/4] Installing PyTorch (CUDA 12.8, pinned for whisperx)...
echo This is the largest download (~2.5 GB). Please wait...
echo.
echo Forcing reinstall in place to avoid file-lock issues...
pip install --force-reinstall --no-deps torch==2.8.0+cu128 torchaudio==2.8.0+cu128 torchvision==0.23.0+cu128 --index-url https://download.pytorch.org/whl/cu128

REM Verify GPU; fall back to CPU if needed
python -c "import torch; print('CUDA available:', torch.cuda.is_available())" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] PyTorch installed with CUDA support.
) else (
    echo [WARN] GPU install failed. Falling back to CPU-only PyTorch...
    pip install --force-reinstall --no-deps torch==2.8.0 torchaudio==2.8.0
)

REM Install core dependencies
echo.
echo [STEP 4/4] Installing core dependencies...
pip install -r backend\requirements.txt --quiet

REM Verify
echo.
echo [VERIFY] Checking installation...
python -c "import torch; print('PyTorch', torch.__version__, '| CUDA:', torch.cuda.is_available())" 2>nul
python -c "import whisperx; print('WhisperX OK')" 2>nul || echo [WARN] WhisperX may need additional setup.
python -c "import flask; print('Flask OK')" 2>nul || echo [WARN] Flask may need additional setup.

echo.
echo ==========================================================
echo   Installation Complete!
echo.
echo   Run the app with:  run.bat
echo   Then open:  http://127.0.0.1:8765
echo ==========================================================
echo.
pause