@echo off
cd /d "%~dp0"
echo Uninstalling Claude Spoof Proxy...

:: Stop if running
call npx csp stop 2>nul

:: Remove global link
call npm unlink 2>nul

:: Remove from PATH (remove this directory from PATH)
for /f "skip=2 tokens=3*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul') do set "userpath=%%a%%b"
if defined userpath (
    set "newpath=%userpath:;%~dp0=%"
    setx PATH "%newpath%" >nul 2>&1
)

echo.
echo Uninstalled.
pause
