@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   BDD Test Generator
echo ============================================
echo.

REM ---- Node / npm ----
where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js/npm was not found on PATH.
    echo Install Node.js 18 or newer from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

REM ---- Claude Code CLI (generation needs it; the UI still opens without it) ----
REM "where claude" can fail even when Claude Code IS installed, if it was
REM installed after this session's shell/Explorer started (Windows doesn't
REM refresh PATH for already-running processes). So if "where" fails, also
REM check the known install locations directly and add the right one to
REM PATH for this session only - no reboot needed.
set "CLAUDE_FOUND="

where claude >nul 2>&1
if not errorlevel 1 set "CLAUDE_FOUND=1"

REM Native Windows installer location
if not defined CLAUDE_FOUND (
    if exist "%USERPROFILE%\.local\bin\claude.exe" (
        set "PATH=%USERPROFILE%\.local\bin;%PATH%"
        set "CLAUDE_FOUND=1"
    )
)

REM npm global install location (npm install -g @anthropic-ai/claude-code)
if not defined CLAUDE_FOUND (
    for /f "delims=" %%P in ('npm config get prefix 2^>nul') do set "NPM_PREFIX=%%P"
    if defined NPM_PREFIX (
        if exist "!NPM_PREFIX!\claude.cmd" (
            set "PATH=!NPM_PREFIX!;%PATH%"
            set "CLAUDE_FOUND=1"
        )
    )
)

if not defined CLAUDE_FOUND (
    echo WARNING: The "claude" CLI was not found on PATH or in the usual install locations.
    echo   Generating test cases needs Claude Code installed and logged in.
    echo   Install it, run "claude" once to sign in, then restart this script.
    echo   Continuing anyway - the app will open but generation will fail.
    echo.
)

REM ---- Already running? Don't start a second server on the same port. ----
netstat -ano | findstr ":4173" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo A server is already running on port 4173.
    echo Opening the app in your browser instead of starting another one.
    echo.
    start "" http://localhost:4173
    echo If you meant to restart it, close the old server window first, then run this again.
    echo.
    pause
    exit /b 0
)

REM ---- Dependencies ----
REM "npm ls" fails when any declared dependency is missing, so this also catches
REM the case where an update added a new package to an existing node_modules.
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies - this may take a minute the first time...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. See the messages above.
        echo.
        pause
        exit /b 1
    )
    echo Dependencies installed.
    echo.
)

REM ---- Launch ----
echo Starting the server...
start "BDD Test Generator server - keep open, close to stop" cmd /k npm start

REM Give the server a moment to bind before the browser hits it.
timeout /t 3 /nobreak >nul

start "" http://localhost:4173

echo.
echo   App:    http://localhost:4173
echo   Server: running in the other window - close it, or press Ctrl+C there, to stop.
echo.
echo Notes:
echo  - Generating from a URL launches a headless browser via npx the first
echo    time, which can add a minute to that first run.
echo  - Run "npm test" any time to check the app's own logic (45 tests).
echo.
pause
