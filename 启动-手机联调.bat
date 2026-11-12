@echo off
rem Wrapper only. Logic lives in scripts\mobile-mode.ps1.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mobile-mode.ps1"
exit /b %errorlevel%
