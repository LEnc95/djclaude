@echo off
REM ============================================================================
REM  Karaoke Forever Pro — show the LAN URL + QR for guest phones
REM
REM  Run this AFTER start.bat on the machine hosting the karaoke server.
REM  It prints the URL guests should visit (or scan) to submit songs.
REM
REM  Usage:
REM    connect.bat                  print URL + open QR in browser
REM    connect.bat CODE             same, but link straight to an event /r/CODE
REM ============================================================================

setlocal
cd /d "%~dp0"

set CODE=%~1

REM Find the first IPv4 address that isn't 127.x or 169.254.x (link-local).
set LANIP=
for /f "tokens=*" %%l in ('ipconfig ^| findstr /R /C:"IPv4.*[0-9]"') do (
    for /f "tokens=2 delims=:" %%a in ("%%l") do (
        set CANDIDATE=%%a
        set CANDIDATE=!CANDIDATE: =!
        echo !CANDIDATE! | findstr /R /B "127\." > NUL
        if errorlevel 1 (
            echo !CANDIDATE! | findstr /R /B "169\.254\." > NUL
            if errorlevel 1 (
                if not defined LANIP set LANIP=!CANDIDATE!
            )
        )
    )
)

REM ipconfig parsing without delayed expansion is brittle — try again the
REM lazy way for hosts where the loop above misses.
if not defined LANIP (
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4.*[0-9]"') do (
        set LANIP=%%a
        goto :got_ip
    )
    :got_ip
    set LANIP=%LANIP: =%
)

if not defined LANIP (
    echo Could not detect a LAN IPv4 address. Are you on a network?
    exit /b 1
)

set BASE=http://%LANIP%:8080
if defined CODE (
    set TARGET=%BASE%/r/%CODE%
) else (
    set TARGET=%BASE%/
)

echo.
echo ============================================================================
echo  Guests on the same WiFi can scan or visit:
echo.
echo      %TARGET%
echo.
echo ============================================================================
echo.

REM Use a free QR-rendering web service for the visual code. (No deps installed
REM locally; uses an HTTPS image API. If you'd rather not, just share the URL.)
set QR_URL=https://api.qrserver.com/v1/create-qr-code/?size=400x400^&data=%TARGET%
echo Opening a QR code in your browser...
start "" "%QR_URL%"

echo.
echo Tip: project this browser tab on the bar TV so people can scan as they walk in.
exit /b 0
