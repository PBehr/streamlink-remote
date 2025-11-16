@echo off
echo.
echo ===================================
echo   Streamlink Remote - Restart
echo ===================================
echo.

cd /d "%~dp0"

echo Stopping server...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *streamlink-remote*" >nul 2>&1

timeout /t 2 /nobreak >nul

echo Starting server...
start "Streamlink Remote Server" cmd /k "npm start"

echo.
echo Server is starting in new window...
echo Open: http://localhost:3000
echo.
pause
