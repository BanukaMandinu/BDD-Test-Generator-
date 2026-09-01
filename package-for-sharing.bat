@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Package this folder for a teammate
echo ============================================
echo.
echo Builds a zip with your own data left out:
echo   - node_modules  (rebuilt by npm install)
echo   - data          (your runs, and any saved login session)
echo   - .browser-profile, .playwright-mcp, .env
echo   - mcp\playwright-profile.generated.json
echo.

set "STAGE=%TEMP%\tg-share-stage"
set "OUT=%~dp0..\TestGenerator-share.zip"

if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" 2>nul

REM /MIR would delete; a plain copy with exclusions is safer here.
robocopy "%CD%" "%STAGE%" /E ^
  /XD node_modules data .browser-profile .playwright-mcp .git .claude ^
  /XF .env playwright-profile.generated.json ^
  /NFL /NDL /NJH /NJS /NP >nul

REM robocopy returns 0-7 for success; 8+ is a real failure.
if errorlevel 8 (
    echo ERROR: copying files failed.
    echo.
    pause
    exit /b 1
)

if exist "%OUT%" del "%OUT%"

powershell -NoProfile -Command ^
  "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%OUT%' -Force" >nul

if not exist "%OUT%" (
    echo ERROR: could not create the zip.
    echo.
    pause
    exit /b 1
)

rmdir /s /q "%STAGE%"

echo Done.
echo.
echo   %OUT%
echo.
echo Send that file. Tell them to unzip it and double-click start.bat.
echo.
pause
