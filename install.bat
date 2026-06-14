@echo off
cd /d "%~dp0"
echo Installing Claude Spoof Proxy...

:: Install npm dependencies
call npm install

:: Link globally so `csp` works from anywhere
call npm link

:: Add to PATH permanently (for cmd.exe)
setx PATH "%PATH%;%~dp0" >nul 2>&1

echo.
echo Done! Installed successfully.
echo.
echo Open a NEW terminal, then use:
echo   csp start     - Start the proxy
echo   csp stop      - Stop the proxy
echo   csp status    - Check status
echo   csp dashboard - Live dashboard
echo.
pause
