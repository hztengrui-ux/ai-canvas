@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  AI 创作台 - 打包 Windows 安装包
rem
rem  用法：
rem    build-installer.bat            打默认品牌（跨多多）
rem    build-installer.bat oem-a      打 X.MULO 白标包
rem    build-installer.bat oem-b      打 晶灵服装AI 白标包
rem
rem  产物目录是 release\（由 electron-builder.config.cjs 的 directories.output 决定），
rem  不是 dist\ —— dist\ 是 vite 的前端产物，这里曾经写错过，找半天找不到 exe。
rem ============================================================

echo ============================================
echo   AI 创作台 - 打包 Windows 安装包
echo   目录: %CD%
echo ============================================
echo.

if not exist "package.json" (
  echo [错误] 当前目录没有 package.json
  echo 请确认这个 bat 文件放在 ai-canvas 目录里
  pause
  exit /b 1
)

if not "%~1"=="" (
  set "BRAND=%~1"
  echo [品牌] BRAND=%BRAND%  （可用：kuaduoduo / oem-a / oem-b）
) else (
  echo [品牌] 未指定，使用默认品牌 kuaduoduo
)
echo.

set NODE_OPTIONS=
set ELECTRON_RUN_AS_NODE=

call npm run dist

if errorlevel 1 (
  echo.
  echo [失败] 打包没成功，把上面的报错发我看看
  pause
  exit /b 1
)

echo.
echo ============================================
echo   打包完成，安装包在 release 目录里：
echo ============================================

if not exist "release" (
  echo [警告] 没有找到 release 目录。
  echo        正常应该在 %CD%\release 下生成安装包，
  echo        请翻上面的打包日志确认 electron-builder 是否真的执行了。
  pause
  exit /b 1
)

dir /b /a-d "release\*.exe" >nul 2>nul
if errorlevel 1 (
  echo [警告] release 目录里没有 .exe 安装包。
  echo        可能只生成了 latest.yml / blockmap 等元数据，请检查打包日志。
  pause
  exit /b 1
)

dir /b "release\*.exe"
echo.
explorer "release"
pause >nul
