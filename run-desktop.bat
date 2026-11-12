@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   AI 创作台 - 启动桌面端
echo   目录: %CD%
echo ============================================
echo.

if not exist "package.json" (
  echo [错误] 当前目录没有 package.json
  echo 请确认这个 bat 文件放在 ai-canvas 目录里
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [提示] 还没装 Electron，先安装依赖...
  call npm install
)

echo 正在构建并启动，首次启动会慢一些...
echo.

rem 清掉可能干扰 Electron 启动的变量
set NODE_OPTIONS=
set ELECTRON_RUN_AS_NODE=

call npm run desktop

echo.
echo 窗口已关闭。按任意键退出。
pause >nul
