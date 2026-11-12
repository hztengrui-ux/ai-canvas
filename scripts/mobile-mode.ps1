# 手机联调模式：让微信小程序能连上这台电脑
#
# 做三件事：
#   1) 监听 0.0.0.0（默认只听 127.0.0.1，手机连不上）
#   2) 开手机模式（security.js 会放行私有网段 Host，并且**不**把本机令牌发出去）
#   3) 固定端口 5199（端口随机的话，小程序里每次都要改地址）
$ErrorActionPreference = "SilentlyContinue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  跨多多 AI 创作台 · 手机联调模式" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  这个窗口要一直开着：关掉 = 服务停止，手机就连不上了。" -ForegroundColor Yellow
Write-Host ""

$env:AI_CANVAS_BIND = "0.0.0.0"
$env:AI_CANVAS_MOBILE = "1"
$env:PORT = "5199"
if ($env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }

# 顺手解除文件锁定（避免第一次启动被 SmartScreen 拦）
Get-ChildItem -Path $dir -Recurse -File -Filter *.exe | ForEach-Object {
  try { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction Stop | Out-Null
        Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } catch { }
}

# 本机局域网 IPv4（按 192.168 > 10 > 172 排优先级）
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
    Sort-Object -Property @{ Expression = {
        if ($_.IPAddress -like '192.168.*') { 0 } elseif ($_.IPAddress -like '10.*') { 1 } else { 2 }
      } } |
    Select-Object -ExpandProperty IPAddress
} catch { }

Write-Host "  手机端地址（填进微信小程序「我的 - 服务端地址」）："
if ($ips.Count -gt 0) {
  Write-Host ""
  foreach ($ip in $ips) { Write-Host "      http://${ip}:5199" -ForegroundColor Green }
  Write-Host ""
} else {
  Write-Host "      （没识别到局域网 IP，请手动运行 ipconfig 看 IPv4 地址）" -ForegroundColor Yellow
  Write-Host ""
}

# 优先启动免安装版客户端；没找到就用源码模式起服务
$app = Get-ChildItem -Path $dir -Filter *.exe -File |
  Where-Object { $_.Name -notmatch "uninstall|卸载|诊断" } |
  Select-Object -First 1

if ($app) {
  Write-Host "  启动客户端（手机端服务随客户端一起起来）…"
  Start-Process -FilePath $app.FullName -WorkingDirectory $dir
  Write-Host ""
  Write-Host "  [√] 已启动。首次可能要初始化管理员账号。" -ForegroundColor Green
  Write-Host "      启动后在客户端「设置 → 手机端联调」里核对地址是否一致。" -ForegroundColor Gray
  Start-Sleep -Seconds 6
  exit 0
}

# 源码模式
$projectRoot = Split-Path -Parent $dir
if (Test-Path (Join-Path $projectRoot "server\index.js")) {
  Set-Location $projectRoot
  if (-not (Test-Path (Join-Path $projectRoot "dist\index.html"))) {
    Write-Host "  首次运行，先构建前端…"
    & npm run build
  }
  Write-Host "  以源码模式启动本地服务…"
  Write-Host ""
  & node server\index.js
} else {
  Write-Host "  [×] 没找到客户端 exe，也没找到源码目录。" -ForegroundColor Red
  Write-Host "      请把本文件放在「跨多多 AI 创作台.exe」同一个文件夹里。"
  Read-Host "按回车退出"
}
exit 0
