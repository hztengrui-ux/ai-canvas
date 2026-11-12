@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0tools\dev-start.mjs" --stop
if errorlevel 1 pause
