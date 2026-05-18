@echo off
REM ============================================================================
REM  Karaoke Forever Pro - first-time setup (Windows, no-friction)
REM
REM  Re-run any time; everything is idempotent. Missing prereqs are installed
REM  automatically via winget when available.
REM ============================================================================

setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo === Karaoke Forever Pro - setup ===
echo.

REM Detect winget once; used by :install_if_missing helper.
set HAVE_WINGET=0
where winget >NUL 2>&1
if not errorlevel 1 set HAVE_WINGET=1

REM ----- 1. Prereq checks (auto-install via winget when missing) -----
echo [1/6] Checking prerequisites...
set MISSING=

call :install_if_missing go      "GoLang.Go"               "C:\Program Files\Go\bin"
call :install_if_missing node    "OpenJS.NodeJS.LTS"       "C:\Program Files\nodejs"
call :install_if_missing npm     ""                         ""
call :install_if_missing ffmpeg  "Gyan.FFmpeg"              ""

REM Python is special: bare `python` may launch the MS Store stub. Use py.exe
REM (the Python launcher) and prefer 3.11 then 3.10 (3.12 isn't fully
REM supported by demucs+whisperx yet).
set PY=
where py >NUL 2>&1
if not errorlevel 1 (
    py -3.11 --version >NUL 2>&1
    if not errorlevel 1 set "PY=py -3.11"
    if not defined PY (
        py -3.10 --version >NUL 2>&1
        if not errorlevel 1 set "PY=py -3.10"
    )
)
if not defined PY (
    if %HAVE_WINGET%==1 (
        echo   [install] Python 3.11 - installing via winget...
        winget install --id Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
        REM Refresh PATH so py.exe is visible without a new terminal.
        call :refresh_path
        where py >NUL 2>&1
        if not errorlevel 1 (
            py -3.11 --version >NUL 2>&1
            if not errorlevel 1 set "PY=py -3.11"
        )
    )
)
if not defined PY (
    where python >NUL 2>&1
    if not errorlevel 1 (
        python -c "import sys; sys.exit(0)" >NUL 2>&1
        if not errorlevel 1 set "PY=python"
    )
)
if not defined PY (
    echo   [missing] python ^(need 3.10 or 3.11^)
    set MISSING=1
) else (
    for /f "delims=" %%V in ('%PY% --version 2^>^&1') do echo   [found  ] python -- %%V  ^(via: %PY%^)
)

if defined MISSING (
    echo.
    echo One or more prereqs could not be installed automatically.
    if %HAVE_WINGET%==0 (
        echo winget is not on this machine. Install "App Installer" from the
        echo Microsoft Store, or install the missing tools manually:
    ) else (
        echo Install the missing tools manually:
    )
    echo   Go 1.22+  https://go.dev/dl/
    echo   Node 18+  https://nodejs.org/
    echo   Python    https://www.python.org/  ^(check "Add Python to PATH"^)
    echo   ffmpeg    https://ffmpeg.org/
    echo.
    pause
    exit /b 1
)

REM ----- 2. .env -----
echo.
echo [2/6] .env file...
if not exist .env (
    copy /Y .env.example .env >NUL
    echo   created .env from .env.example
) else (
    echo   .env already present - leaving it alone
)

REM ----- 3. Go deps -----
echo.
echo [3/6] Installing Go module dependencies...
pushd backend
go mod tidy
if errorlevel 1 (
    echo.
    echo go mod tidy FAILED. See errors above.
    popd & pause & exit /b 1
)
popd
echo   ok

REM ----- 4. Frontend deps -----
echo.
echo [4/6] Installing frontend dependencies (npm install)...
pushd frontend
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo npm install FAILED. See errors above.
    popd & pause & exit /b 1
)
popd
echo   ok

REM ----- 5. Python worker venv + PyTorch (CUDA 12.1) + deps -----
echo.
echo [5/6] Python worker venv (slow - ~3 GB of CUDA wheels)...
pushd worker
if not exist .venv (
    echo   creating venv at worker\.venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo.
        echo venv creation FAILED. Make sure '%PY%' is a real Python install.
        popd & pause & exit /b 1
    )
) else (
    echo   venv already exists
)

echo   activating venv...
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo activate.bat failed.
    popd & pause & exit /b 1
)

echo   upgrading pip/wheel...
python -m pip install --upgrade pip wheel >NUL
if errorlevel 1 (
    echo pip upgrade FAILED.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage A: install every wheel-having dep from wheels ONLY. --only-binary=:all:
REM refuses any source build, so pip can't fall back to compiling av against
REM ffmpeg dev libs the user doesn't have.
echo   stage A: installing wheel-only deps ^(torch + av + framework^)...
python -m pip install --only-binary=:all: ^
    --extra-index-url https://download.pytorch.org/whl/cu121 ^
    torch==2.3.1 torchaudio==2.3.1 ^
    "av>=14.0.0,<15" ^
    numpy cython setuptools wheel ^
    fastapi==0.115.5 "uvicorn[standard]==0.32.1" httpx==0.27.2 ^
    python-multipart==0.0.12 pydantic==2.9.2 pydantic-settings==2.6.1 ^
    yt-dlp==2024.11.18 mutagen==1.47.0 Pillow==11.0.0
if errorlevel 1 (
    echo.
    echo Stage A FAILED ^(wheel install^). See errors above.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage B: install demucs + whisperx. They're sdist-only on PyPI; pip
REM builds local wheels but their setup.py is pure Python (no compiler
REM needed). --no-build-isolation reuses the venv's installed packages
REM (notably the av wheel from Stage A) instead of re-resolving in an
REM isolated env, which was what triggered the av source build.
echo   stage B: installing demucs + whisperx ^(pure-python wheel builds^)...
python -m pip install --no-build-isolation --prefer-binary ^
    demucs==4.0.1 whisperx==3.1.5
if errorlevel 1 (
    echo.
    echo Stage B FAILED ^(demucs/whisperx^). See errors above.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage C: install our editable package, skipping dep resolution since
REM everything is already in the venv.
echo   stage C: installing djclaude-worker ^(editable, no deps^)...
python -m pip install -e . --no-deps
if errorlevel 1 (
    echo.
    echo Worker install FAILED.
    echo.
    echo If you see a CUDA/torch wheel error, you can fall back to CPU:
    echo     cd worker
    echo     .venv\Scripts\activate.bat
    echo     pip install -e . --index-url https://download.pytorch.org/whl/cpu
    echo Then edit .env and set WORKER_DEVICE=cpu
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

call .venv\Scripts\deactivate.bat
popd
echo   ok

REM ----- 6. Build frontend -----
echo.
echo [6/6] Building frontend bundle...
pushd frontend
call npm run build
if errorlevel 1 (
    echo Frontend build FAILED.
    popd & pause & exit /b 1
)
popd
echo   ok

echo.
echo ============================================================================
echo  Setup complete.
echo.
echo  Next: run start.bat. Browser will open http://localhost:8080/admin
echo  Default login: admin / admin  ^(forced password change on first login^)
echo ============================================================================
echo.
pause
exit /b 0


REM ============================================================================
REM  helpers
REM ============================================================================

REM :install_if_missing <cmd> <winget-id> <fallback-PATH-dir>
REM   Checks `where <cmd>`. If missing AND winget is available AND a winget
REM   package id was given, installs it silently, then optionally prepends
REM   a known install dir to PATH so the new exe is visible without a new
REM   terminal session.
:install_if_missing
set "CMD=%~1"
set "WID=%~2"
set "FALLBACK=%~3"

where !CMD! >NUL 2>&1
if not errorlevel 1 (
    for /f "delims=" %%V in ('!CMD! --version 2^>^&1') do (
        echo   [found  ] !CMD! -- %%V
        goto :install_if_missing_done
    )
    echo   [found  ] !CMD!
    goto :install_if_missing_done
)

if "!WID!"=="" (
    echo   [missing] !CMD! ^(no winget package known^)
    set MISSING=1
    goto :install_if_missing_done
)

if %HAVE_WINGET%==0 (
    echo   [missing] !CMD! ^(winget not installed; install manually^)
    set MISSING=1
    goto :install_if_missing_done
)

echo   [install] !CMD! - installing !WID! via winget...
winget install --id !WID! -e --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo   [warn   ] winget install of !WID! returned an error; trying anyway
)

REM winget updates the system PATH but the running cmd doesn't see it yet.
REM Prepend the known install dir for this session.
if not "!FALLBACK!"=="" (
    if exist "!FALLBACK!" set "PATH=!FALLBACK!;!PATH!"
)
call :refresh_path

where !CMD! >NUL 2>&1
if errorlevel 1 (
    echo   [missing] !CMD! still not found after install. Close this window,
    echo            open a NEW terminal, and re-run setup.bat.
    set MISSING=1
) else (
    for /f "delims=" %%V in ('!CMD! --version 2^>^&1') do (
        echo   [found  ] !CMD! -- %%V  ^(just installed^)
        goto :install_if_missing_done
    )
    echo   [found  ] !CMD!  ^(just installed^)
)

:install_if_missing_done
goto :eof

REM :refresh_path
REM   Reads the persistent system + user PATH from the registry and applies
REM   it to this cmd session. Lets winget-installed tools be found without
REM   restarting the terminal.
:refresh_path
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>NUL ^| findstr /R "REG_EXPAND_SZ REG_SZ"') do set "_SYSPATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>NUL ^| findstr /R "REG_EXPAND_SZ REG_SZ"') do set "_USERPATH=%%b"
if defined _SYSPATH (
    if defined _USERPATH (
        set "PATH=!_SYSPATH!;!_USERPATH!"
    ) else (
        set "PATH=!_SYSPATH!"
    )
)
goto :eof
