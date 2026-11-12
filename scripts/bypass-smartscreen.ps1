# 跳过 SmartScreen 检查（当前 Windows 用户级，可随时恢复）
#
# 正常情况不需要跑这个：
#   1) 先试「直接打开-免安装版.bat」（解除文件锁定，绝大多数情况到这就够了）
#   2) 还弹就点一次「更多信息 → 仍要运行」
#   只有系统策略层面直接拦死、连"更多信息"都不给时，才用这里的第 1 项。
$ErrorActionPreference = "SilentlyContinue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$regPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost"

function Show-Header {
  Write-Host ""
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host "  跨多多 AI 创作台 · 跳过 SmartScreen 检查" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
}

function Find-App {
  Get-ChildItem -Path $dir -Filter *.exe -File |
    Where-Object { $_.Name -notmatch "uninstall|卸载|诊断" } |
    Select-Object -First 1
}

function Disable-Check {
  reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost" /v EnableWebContentEvaluation /t REG_DWORD /d 0 /f | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [×] 写入失败：这台机器可能被组策略接管了注册表。" -ForegroundColor Red
    Write-Host "      这种情况只能用「直接打开-免安装版.bat」点一次「仍要运行」，或找 IT 放行。"
    return $false
  }
  Write-Host "  [√] 已关闭当前 Windows 用户的「检查应用和文件」。立即生效，无需重启。" -ForegroundColor Green
  return $true
}

function Enable-Check {
  reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost" /v EnableWebContentEvaluation /t REG_DWORD /d 1 /f | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [×] 恢复失败。" -ForegroundColor Red
  } else {
    Write-Host "  [√] 已恢复为「开启检查」。" -ForegroundColor Green
  }
}

Show-Header
Write-Host ""
Write-Host "  【这是做什么】"
Write-Host "    Windows SmartScreen 对没有代码签名的程序默认拦一道。"
Write-Host "    正常做法是解除文件锁定，或点「更多信息 → 仍要运行」（一次性）。"
Write-Host ""
Write-Host "    只有在系统策略层面直接拦死时，才需要关掉当前用户的"
Write-Host "    「检查应用和文件」开关（HKCU，不需要管理员，可随时恢复）。"
Write-Host ""
Write-Host "  【代价，想清楚再继续】" -ForegroundColor Yellow
Write-Host "    关掉之后，这台电脑运行**任何**未签名程序都不再有那道提示，" -ForegroundColor Yellow
Write-Host "    也包括你以后从网上下载的东西。风险由你自己承担。" -ForegroundColor Yellow
Write-Host ""
Write-Host "    [1] 关闭检查并打开软件"
Write-Host "    [2] 恢复检查（把开关改回来）"
Write-Host "    [3] 退出"
Write-Host ""
$choice = Read-Host "请输入 1 / 2 / 3 然后回车"

switch ($choice) {
  "1" {
    Write-Host ""
    if (Disable-Check) {
      # 顺手也解除文件锁定（双保险）
      Get-ChildItem -Path $dir -Recurse -File | ForEach-Object {
        try { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction Stop | Out-Null
              Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } catch { }
      }
      if ($env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
      $app = Find-App
      if ($app) {
        Write-Host "  正在启动 $($app.Name) …"
        Start-Process -FilePath $app.FullName -WorkingDirectory $dir
      } else {
        Write-Host "  [!] 本目录没找到主程序 exe，只完成了设置修改。"
      }
    }
  }
  "2" {
    Write-Host ""
    Enable-Check
  }
  default {
    Write-Host ""
    Write-Host "  已取消，什么都没改。"
    Start-Sleep -Seconds 2
    exit 0
  }
}

Write-Host ""
Read-Host "按回车退出"
exit 0
