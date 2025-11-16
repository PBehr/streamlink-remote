@echo off
echo ===================================
echo   Killing Node processes...
echo ===================================
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo ===================================
echo   Starting fresh server...
echo ===================================
echo.
cd /d "%~dp0"
node server/index.js
