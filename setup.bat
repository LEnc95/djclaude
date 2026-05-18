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

REM Go gets a special path: if winget hangs or fails, we fall through to a
REM direct ZIP install (no msiexec, no UAC, no installer service drama).
where go >NUL 2>&1
if errorlevel 1 (
    call :install_go_smart
) else (
    for /f "delims=" %%V in ('go --version 2^>^&1') do echo   [found  ] go -- %%V
)

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

REM Stage A: core wheel-only install. No whisperx (drags in PyAV +
REM faster-whisper version conflict). Use faster-whisper directly — it
REM provides word_timestamps natively and has clean Windows wheels.
echo   stage A: installing core wheels ^(torch + faster-whisper + framework^)...
python -m pip install --only-binary=:all: ^
    --extra-index-url https://download.pytorch.org/whl/cu121 ^
    torch==2.3.1 torchaudio==2.3.1 ^
    "numpy<2" cython setuptools wheel ^
    fastapi==0.115.5 "uvicorn[standard]==0.32.1" httpx==0.27.2 ^
    python-multipart==0.0.12 pydantic==2.9.2 pydantic-settings==2.6.1 ^
    "yt-dlp>=2024.11.18" mutagen==1.47.0 Pillow==11.0.0 ^
    "faster-whisper>=1.0.3,<2"
if errorlevel 1 (
    echo.
    echo Stage A FAILED ^(wheel install^). See errors above.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage B: demucs's runtime Python deps. openunmix IS required (demucs's
REM hdemucs imports it at module load); luckily it doesn't actually pull
REM PyAV — that was a different transitive chain. Install everything with
REM --prefer-binary so pure-Python sdists (julius) install fine while
REM compiled packages prefer wheels.
echo   stage B: installing demucs runtime deps...
python -m pip install --prefer-binary ^
    julius einops pyyaml tqdm omegaconf diffq dora-search ^
    openunmix lameenc soundfile
if errorlevel 1 (
    echo.
    echo Stage B FAILED ^(demucs deps^). See errors above.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage C: demucs itself with --no-deps. Pip won't try to resolve its
REM dependencies (which is what was pulling openunmix → av source build).
echo   stage C: installing demucs ^(no transitive deps^)...
python -m pip install --no-deps demucs==4.0.1
if errorlevel 1 (
    echo.
    echo Stage C FAILED ^(demucs^). See errors above.
    call .venv\Scripts\deactivate.bat
    popd & pause & exit /b 1
)

REM Stage D: install our editable package, skipping dep resolution since
REM everything is already in the venv.
echo   stage D: installing djclaude-worker ^(editable, no deps^)...
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

REM :install_go_smart
REM   Try winget first (90-second timeout). If it hangs or fails, fall back
REM   to downloading the latest Go ZIP from go.dev and extracting it to
REM   %LOCALAPPDATA%\Programs\Go — no installer, no UAC, can't hang.
:install_go_smart
echo   [install] go - trying winget first...
where winget >NUL 2>&1
if not errorlevel 1 (
    REM Run winget with a 90s wall clock; kill the orphan if it stalls.
    powershell -NoProfile -Command "$p = Start-Process winget -ArgumentList 'install','--id','GoLang.Go','-e','--silent','--accept-package-agreements','--accept-source-agreements' -PassThru -WindowStyle Hidden; if (-not $p.WaitForExit(90000)) { try { $p.Kill() } catch {}; Get-Process msiexec -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 1 }; exit $p.ExitCode"
    if not errorlevel 1 (
        call :refresh_path
        if exist "C:\Program Files\Go\bin\go.exe" set "PATH=C:\Program Files\Go\bin;%PATH%"
        where go >NUL 2>&1
        if not errorlevel 1 (
            for /f "delims=" %%V in ('go --version 2^>^&1') do echo   [found  ] go -- %%V  ^(via winget^)
            goto :install_go_done
        )
    )
    echo   [warn   ] winget install of Go failed or hung; falling back to direct ZIP
)

REM ZIP fallback: download the latest stable release straight from go.dev.
echo   [install] go - downloading ZIP from go.dev ^(no admin needed^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $rel = (Invoke-RestMethod 'https://go.dev/dl/?mode=json' -TimeoutSec 30)[0]; $f = $rel.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' } | Select-Object -First 1; $url = 'https://go.dev/dl/' + $f.filename; $zip = $env:TEMP + '\' + $f.filename; $dst = $env:LOCALAPPDATA + '\Programs'; if (Test-Path ($dst + '\Go')) { Remove-Item ($dst + '\Go') -Recurse -Force }; Write-Host ('  downloading ' + $rel.version + ' ~' + [math]::Round($f.size/1MB,0) + ' MB'); Invoke-WebRequest $url -OutFile $zip -UseBasicParsing; if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }; Expand-Archive $zip $dst -Force; Remove-Item $zip -Force; $bin = $dst + '\Go\bin'; $up = [Environment]::GetEnvironmentVariable('Path','User'); if ($up -notlike ('*' + $bin + '*')) { [Environment]::SetEnvironmentVariable('Path', $bin + ';' + $up, 'User') }; Write-Host '  installed to ' $bin"
if errorlevel 1 (
    echo   [missing] go - ZIP fallback also failed. Check your internet connection.
    set MISSING=1
    goto :install_go_done
)
set "PATH=%LOCALAPPDATA%\Programs\Go\bin;%PATH%"
where go >NUL 2>&1
if errorlevel 1 (
    echo   [missing] go - PATH update failed. Try restarting the terminal.
    set MISSING=1
) else (
    for /f "delims=" %%V in ('go --version 2^>^&1') do echo   [found  ] go -- %%V  ^(via go.dev ZIP^)
)
:install_go_done
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
