@echo off
echo.
echo ==========================================================
echo   ELYSY - Eliz's Lyrics Synchronizer
echo ==========================================================
echo.

REM Activate virtual environment
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else (
    echo [ERROR] Virtual environment not found.
    echo Please run install.bat first.
    pause
    exit /b 1
)

REM Start the server (the app auto-opens your browser)
echo Starting server...
echo.
echo If the browser does not open automatically, visit: http://127.0.0.1:8765
echo Press Ctrl+C to stop the server.
echo.

python backend\app.py --host 127.0.0.1 --port 8765

pause