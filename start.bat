@echo off
REM ============================================================================
REM  Karaoke Forever Pro — start the full local stack
REM
REM  Launches three things in separate windows so you can watch logs:
REM    1. Go API server (port 8080)
REM    2. Python worker (port 8090)
REM    3. (optional) Vite dev server for hot-reload (port 5173)
REM
REM  Both processes auto-discover the project root by walking up to find
REM  .env, so they always share the same karaoke.db and media/ regardless
REM  of which directory they're launched from. No env vars to set here.
REM
REM  Usage:
REM    start.bat            production: Go serves the built frontend on 8080
REM    start.bat dev        also starts Vite for hot-reload on 5173
REM ============================================================================

setlocal
cd /d "%~dp0"

set MODE=%~1
if "%MODE%"=="" set MODE=prod

REM Sanity checks.
if not exist backend\go.sum (
    echo backend\go.sum missing. Run setup.bat first.
    pause & exit /b 1
)
if not exist worker\.venv\Scripts\python.exe (
    echo worker\.venv missing. Run setup.bat first.
    pause & exit /b 1
)
if not exist .env (
    echo .env missing. Run setup.bat first.
    pause & exit /b 1
)
if "%MODE%"=="prod" if not exist frontend\dist\index.html (
    echo frontend\dist missing. Run setup.bat to build the frontend first,
    echo or pass "dev" to use the Vite dev server instead.
    pause & exit /b 1
)

echo.
echo === Karaoke Forever Pro — starting stack ===
echo.

REM Make sure the media dir exists at the project root before either
REM process tries to write to it.
if not exist "%~dp0media" mkdir "%~dp0media"

REM Detect LAN IP for the on-screen "guests connect here" hint.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4.*[0-9]"') do (
    set LANIP=%%a
    goto :got_ip
)
:got_ip
set LANIP=%LANIP: =%

REM 1. Go API. We cd into backend/ so `go run` finds go.mod; the Go
REM    server's findProjectRoot() walks up from there to locate .env.
start "Karaoke API (Go)" cmd /k "cd /d %~dp0backend && go run ./cmd/server"

REM 2. Python worker. Stay at project root so worker/__init__.py is
REM    discoverable as the `worker` package.
start "Karaoke Worker (Python)" cmd /k "cd /d %~dp0 && worker\.venv\Scripts\python.exe -m worker.main"

REM 3. Vite (only in dev mode)
if /I "%MODE%"=="dev" (
    start "Karaoke Frontend (Vite)" cmd /k "cd /d %~dp0frontend && npm run dev"
    set OPEN_URL=http://localhost:5173/admin
) else (
    set OPEN_URL=http://localhost:8080/admin
)

REM Give the API a moment to bind before opening the browser.
timeout /t 3 /nobreak > NUL

echo Stack started. Three console windows opened.
echo.
echo   Admin (this machine):    %OPEN_URL%
if defined LANIP (
    echo   Guests on the same WiFi: http://%LANIP%:8080/
    echo   ^^- Show them this URL or run connect.bat for a QR code.
)
echo.
echo Default admin login: admin / admin   ^(forced password change on first login^)
echo.
start "" "%OPEN_URL%"

echo Press any key to STOP the stack...
pause > NUL

REM Best-effort shutdown of the spawned cmd windows.
taskkill /FI "WINDOWTITLE eq Karaoke API*" /T /F > NUL 2>&1
taskkill /FI "WINDOWTITLE eq Karaoke Worker*" /T /F > NUL 2>&1
taskkill /FI "WINDOWTITLE eq Karaoke Frontend*" /T /F > NUL 2>&1
echo Stopped.
exit /b 0
