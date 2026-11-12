@echo off
rem Wrapper only. Logic lives in mobile-mode.ps1.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mobile-mode.ps1"
exit /b %errorlevel%
