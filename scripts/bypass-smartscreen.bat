@echo off
rem Wrapper only. Logic lives in bypass-smartscreen.ps1.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bypass-smartscreen.ps1"
exit /b %errorlevel%
