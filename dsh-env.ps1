# ============================================================
#  dsh-env.ps1 —— 让 ai-canvas 在 DSH 沙箱里跑起来的全部环境修正
# ------------------------------------------------------------
#  用法（必须 dot-source，否则变量不会留在当前会话）：
#      . .\dsh-env.ps1
#
#  为什么需要这个文件：
#  DSH 的文件沙箱只允许写工作区（E:\DSH项目）。而这个项目的默认行为
#  会往沙箱外写四个地方，全部会被拒绝（EPERM / Access denied）：
#    1. npm 缓存      -> %LOCALAPPDATA%\npm-cache        ← 被沙箱拦
#    2. esbuild 临时目录 -> %TEMP%\esbuild-xxx            ← 被沙箱拦
#    3. 运行数据      -> %USERPROFILE%\.ai-canvas         ← 被沙箱拦
#    4. Electron 二进制缓存 -> %LOCALAPPDATA%\electron    ← 被沙箱拦
#  统一改写到工作区内，即可全程无需放宽沙箱权限。
#
#  另一类限制（改环境变量解决不了，属于沙箱的命名管道禁令）：
#    - esbuild 常驻服务（vite build 需要）
#    - run-tests.mjs 用管道 stdio 拉起被测服务
#  这两条需要一次性放开沙箱执行，详见 使用说明-DSH.md。
# ============================================================

$ErrorActionPreference = "Stop"

# 项目根 = 本脚本所在目录
# ⚠️ dot-source 时 `$PSScriptRoot` 指向的是**调用者脚本**的目录（在被调用文件里通常为空，
#    于是回退到当前工作目录），2026-11-03 实测会打印「项目根 E:\DSH项目」这种错误值。
#    必须用 `$PSCommandPath`（本文件自身路径）才稳定。
$Root = $null
$self = $PSCommandPath
if (-not $self) { $self = $MyInvocation.MyCommand.Path }
if ($self) { $Root = Split-Path -Parent $self }
if (-not $Root) { $Root = $PSScriptRoot }
if (-not $Root) { $Root = (Get-Location).Path }

# ---------- 1. 缓存与临时目录全部落进工作区 ----------
$env:npm_config_cache      = Join-Path $Root ".npm-cache"
$env:npm_config_tmp        = Join-Path $Root ".tmp"
$env:TEMP                  = Join-Path $Root ".tmp"
$env:TMP                   = Join-Path $Root ".tmp"
$env:ELECTRON_CACHE        = Join-Path $Root ".electron-cache"
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root ".electron-cache\builder"

# ---------- 2. 运行数据隔离（否则会往 ~/.ai-canvas 写，被沙箱拦）----------
$env:AI_CANVAS_HOME    = Join-Path $Root ".rundata"
$env:AI_CANVAS_OUTPUTS = Join-Path $Root ".rundata\outputs"
# file = 用本地加密文件存密钥，不碰系统凭据管理器（沙箱内更稳）
$env:AI_CANVAS_VAULT   = "file"

# ---------- 3. 国内镜像（Electron 二进制体积大，走镜像快很多）----------
$env:ELECTRON_MIRROR   = "https://npmmirror.com/mirrors/electron/"
$env:electron_mirror   = "https://npmmirror.com/mirrors/electron/"

# ---------- 4. 端口 ----------
$env:PORT = "5199"   # 后端；也可用 npm run dev 的 5180/5181 组合

# ---------- 5. 目录就位 ----------
foreach ($d in @($env:npm_config_cache, $env:npm_config_tmp, $env:ELECTRON_CACHE,
                 $env:AI_CANVAS_HOME, $env:AI_CANVAS_OUTPUTS)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

Write-Host "DSH 环境已就绪（dot-source 生效）：" -ForegroundColor Green
Write-Host "  项目根        $Root"
Write-Host "  npm 缓存      $env:npm_config_cache"
Write-Host "  TEMP          $env:TEMP"
Write-Host "  运行数据      $env:AI_CANVAS_HOME"
Write-Host "  密钥后端      $env:AI_CANVAS_VAULT"
Write-Host "  端口          $env:PORT"
Write-Host ""
Write-Host "常用命令（在 $Root 下）：" -ForegroundColor Cyan
Write-Host "  npm install --ignore-scripts --registry=https://registry.npmmirror.com"
Write-Host "  npm run dev:desktop   # ★ 一键开发态：后端+Vite+Electron（tools/dev-start.mjs）"
Write-Host "  npm run dev:status / npm run dev:stop"
Write-Host "  npm test"
Write-Host "  npm run build"
Write-Host "  npm run server        # 只起后端 http://127.0.0.1:5199"
