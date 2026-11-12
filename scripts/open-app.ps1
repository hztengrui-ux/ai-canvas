# 直接打开跨多多 AI 创作台
#
# 为什么要做成 PowerShell + 一个几乎空的 bat：
#   cmd 的 .bat 对中文编码（系统代码页 936）、for 括号块里的管道、^ 续行都很敏感，
#   一不留神就报 "'PP' is not recognized" 这种完全不指向根因的错误。
#   所以逻辑全放在这里（.ps1 用 UTF-8 BOM，PowerShell 能正确读中文），
#   外面的 .bat 只负责三行：切目录、叫 PowerShell、退出。
#
# 这台机器还有一个环境问题：Chromium 沙箱初始化会直接失败（0x80000003 STATUS_BREAKPOINT），
# 表现是"双击一闪就没了 / 点了没反应"；加 --no-sandbox 才起得来
# （原装 Electron 33.2.0 同样如此，属于系统策略层面，不是程序问题）。
# 所以这里先正常启动，起不来就自动用 --no-sandbox 重试，并记住这台机器的选择
# （data\launch-mode.txt），下次一步到位。
$ErrorActionPreference = "SilentlyContinue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

function Find-App {
  Get-ChildItem -Path $dir -Filter *.exe -File |
    Where-Object { $_.Name -notmatch "uninstall|卸载|诊断" } |
    Select-Object -First 1
}

# 进程"活够了"就算启动成功。
# 沙箱失败是**立刻**死的（<1 秒，STATUS_BREAKPOINT），所以只需观察 3 秒；
# 不能用"等到超时"的写法 —— 那会让每次启动都白等 8 秒（实测总共 12.4 秒才出窗口）。
function Wait-Alive($proc, $graceSeconds) {
  $deadline = (Get-Date).AddSeconds($graceSeconds)
  while ($true) {
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { return $false }
    if ((Get-Date) -ge $deadline) { return $true }
    Start-Sleep -Milliseconds 400
  }
}

function Start-App($app, $noSandbox) {
  $a = @()
  if ($noSandbox) { $a += "--no-sandbox" }
  return Start-Process -FilePath $app.FullName -WorkingDirectory $dir -ArgumentList $a -PassThru
}

$app = Find-App
if (-not $app) {
  Write-Host "  [×] 这个目录里没找到主程序 exe。" -ForegroundColor Red
  Write-Host "      请把本文件放在「跨多多 AI 创作台.exe」同一个文件夹里再运行。"
  Write-Host ""
  Read-Host "按回车退出"
  exit 1
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  跨多多 AI 创作台 · 直接打开" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  主程序：$($app.FullName)"
Write-Host ""

# 1) 解除 Mark-of-the-Web（SmartScreen「已保护你的电脑」的根因）
#
# ⚠️ 只处理会被"执行"的文件：主 exe + 目录里的 bat/ps1。
#   以前对整个目录 -Recurse 扫（里面含 node_modules，上万个文件），
#   单这一步就要好几秒 —— 实测总启动耗时 11.7 秒，用户体感就是"点了半天没反应"。
#   Windows 的 SmartScreen 只检查**被启动的那个 exe**，DLL/pak 之类不需要逐个解除。
Write-Host "  正在解除安全锁定…"
$targets = @($app)
Get-ChildItem -Path $dir -File | Where-Object { $_.Extension -in @(".bat", ".ps1", ".exe") } | ForEach-Object { $targets += $_ }
$blocked = 0
foreach ($f in $targets) {
  try {
    Get-Item -LiteralPath $f.FullName -Stream Zone.Identifier -ErrorAction Stop | Out-Null
    Unblock-File -LiteralPath $f.FullName -ErrorAction SilentlyContinue
    $blocked++
  } catch { }
}
if ($blocked -gt 0) {
  Write-Host "  [√] 解除了 $blocked 个文件的网络锁定。" -ForegroundColor Green
} else {
  Write-Host "  [√] 无锁定标记（正常）。" -ForegroundColor Green
}

# 2) 清掉会让 Electron 变成"跑 Node"的环境变量
if ($env:ELECTRON_RUN_AS_NODE) {
  Write-Host "  检测到 ELECTRON_RUN_AS_NODE=1，已清除。" -ForegroundColor Yellow
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

# 3) 启动（带"上次用的模式"记忆）
$modeFile = Join-Path $dir "data\launch-mode.txt"
$knownNoSandbox = $false
if (Test-Path $modeFile) {
  $knownNoSandbox = ((Get-Content $modeFile -Raw -ErrorAction SilentlyContinue) -match "nosandbox")
}

$proc = $null
if ($knownNoSandbox) {
  Write-Host "  启动（兼容模式，上次在这台机器上验证过）…"
  $proc = Start-App $app $true
  if (-not (Wait-Alive $proc 4)) { $proc = $null }
} else {
  Write-Host "  启动（正常模式）…"
  $proc = Start-App $app $false
  if (-not (Wait-Alive $proc 3)) {
    Write-Host "  正常模式没撑住（这台机器 Chromium 沙箱起不来），改用兼容模式重试…" -ForegroundColor Yellow
    $proc = $null
  }
}

if (-not $proc) {
  $proc = Start-App $app $true
  if (Wait-Alive $proc 4) {
    New-Item -ItemType Directory -Force -Path (Split-Path $modeFile) | Out-Null
    Set-Content -Path $modeFile -Value "nosandbox" -Encoding ascii
    Write-Host "  [√] 已用兼容模式启动，并记住设置（下次一步到位）。" -ForegroundColor Green
    Write-Host "      说明：--no-sandbox 只关渲染进程的沙箱隔离，本机自用工具可接受；" -ForegroundColor Gray
    Write-Host "      代价是页面若加载了不可信内容，隔离强度会低一些。" -ForegroundColor Gray
  } else {
    Write-Host "  [×] 两种模式都没起来。请把 data\appdata\boot.log 最后几行发我看。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
  }
} else {
  Write-Host "  [√] 已启动，窗口大约 2-5 秒后出现。" -ForegroundColor Green
}

Write-Host ""
Write-Host "  提示："
Write-Host "    · 首次进入会引导初始化管理员账号，建议立刻改成自己的密码。"
Write-Host "    · 想让桌面/开始菜单有图标：双击「创建桌面快捷方式.bat」。"
Write-Host "    · 手机上也要用：双击「启动-手机联调.bat」。"
Write-Host ""
Start-Sleep -Seconds 3
exit 0
