@echo off
rem Wrapper only: cmd parsing is fragile with encoding/parentheses,
rem so all real logic lives in open-app.ps1 next to this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-app.ps1"
exit /b %errorlevel%
