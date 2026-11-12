<#
  安装失败诊断（只读，不改动任何东西）

  用法：右键 → 使用 PowerShell 运行；或
        powershell -ExecutionPolicy Bypass -File diagnose-install.ps1

  它只做检查并打印结果，不安装、不删除、不改权限。
#>

$ErrorActionPreference = "Continue"
$out = @()
function Say($t) { $script:out += $t; Write-Host $t }

Say "================ 跨多多 AI 创作台 · 安装失败诊断 ================"
Say ("时间: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Say ""

# ---------- 1. 目标目录状态 ----------
Say "【1】目标安装目录"
$dir = Join-Path $env:LOCALAPPDATA "Programs\ai-canvas"
Say "    路径: $dir"
Say "    是否存在: $(Test-Path $dir)"
if (Test-Path $dir) {
    Say "    内容:"
    Get-ChildItem $dir -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Say ("      {0}  {1}" -f $(if ($_.PSIsContainer) { "[目录]" } else { "[文件]" }), $_.Name) }
    $un = Join-Path $dir "Uninstall 跨多多 AI 创作台.exe"
    if (Test-Path $un) {
        $i = Get-Item $un -Force
        Say "    卸载器: 只读=$($i.IsReadOnly) 大小=$([math]::Round($i.Length/1KB,1))KB"
    } else {
        Say "    卸载器: 不存在"
    }
}

# ---------- 2. 是否有进程占用 ----------
Say ""
Say "【2】是否有程序正在运行（占用文件会导致写入失败）"
$procs = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '跨多多|ai-canvas' }
if ($procs) {
    foreach ($p in $procs) { Say "    ⚠ 正在运行: $($p.ProcessName) (PID $($p.Id))" }
    Say "    → 请先全部退出（含托盘图标），再重试安装"
} else {
    Say "    ✅ 没有相关进程在运行"
}

# ---------- 3. 父目录写权限实测 ----------
Say ""
Say "【3】父目录是否可写（安装器要在这里建 ai-canvas 目录）"
$parent = Join-Path $env:LOCALAPPDATA "Programs"
Say "    父目录: $parent  存在=$(Test-Path $parent)"
$probe = Join-Path $parent "dsh-write-test-tmp"
try {
    New-Item -ItemType Directory -Path $probe -Force -ErrorAction Stop | Out-Null
    Set-Content -Path (Join-Path $probe "t.txt") -Value "ok" -Encoding ascii -ErrorAction Stop
    Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
    Say "    ✅ 可写（能建目录、能写文件）"
} catch {
    Say "    ❌ 不可写: $($_.Exception.Message)"
    Say "    → 这是安装失败的直接原因：安装器在这个目录建不了文件"
    Say "    → 处理办法见文末【建议】"
}

# ---------- 4. 临时目录 ----------
Say ""
Say "【4】临时目录（NSIS 安装器也要用它）"
$tmp = $env:TEMP
Say "    TEMP = $tmp"
Say "    存在: $(Test-Path $tmp)"
try {
    $f = Join-Path $tmp "dsh-tmp-test.txt"
    Set-Content -Path $f -Value "ok" -Encoding ascii -ErrorAction Stop
    Remove-Item $f -Force -ErrorAction SilentlyContinue
    Say "    ✅ 可写"
} catch {
    Say "    ❌ 不可写: $($_.Exception.Message)"
}

# ---------- 5. 安全软件 ----------
Say ""
Say "【5】可能拦截写入的安全软件"
$av = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'MsMpEng|360|huorong|HipsTray|QQPCTray|kxescore|avp|ekrn|ZhuDongFangYu' } |
    Select-Object -ExpandProperty ProcessName -Unique
if ($av) {
    Say "    发现: $($av -join ', ')"
    Say "    → 安装前先临时关闭它的「文件实时防护」，装完再开"
} else {
    Say "    未发现常见国产杀软进程"
}
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    Say "    Windows Defender 实时防护: $($mp.RealTimeProtectionEnabled)"
} catch {
    Say "    （未能读取 Defender 状态，可忽略）"
}

# ---------- 6. 免安装版状态 ----------
Say ""
Say "【6】免安装版（推荐，绕过安装器）"
Say "    如果你的免安装版目录在别处，请自行确认该目录下存在："
Say "      跨多多 AI 创作台.exe"
Say "      portable.flag"
Say "      data\"
Say "    双击 exe 即可运行，数据会写在同目录的 data\ 下。"

# ---------- 建议 ----------
Say ""
Say "================ 建议 ================"
Say "首选：直接用免安装版（双击 exe）—— 它不经过安装器，不受上面这些问题影响。"
Say ""
Say "若必须用安装器，按顺序试："
Say "  1) 确认托盘里没有残留的「跨多多 AI 创作台」进程，全部退出后重试"
Say "  2) 临时关闭杀软的实时文件防护，重试；装完再打开"
Say "  3) 用管理员身份运行安装包（右键 → 以管理员身份运行）"
Say "  4) 手动删除 C:\Users\<你>\AppData\Local\Programs\ai-canvas 整个目录后重试"
Say "  5) 仍失败 → 把本脚本的输出整段发给我"

$logPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "ai-canvas-安装诊断.txt"
try {
    $out | Out-File -FilePath $logPath -Encoding utf8
    Write-Host ""
    Write-Host "诊断结果已保存到桌面: ai-canvas-安装诊断.txt" -ForegroundColor Green
} catch {
    Write-Host "（结果未能保存到桌面，请直接复制上面的输出）" -ForegroundColor Yellow
}

Write-Host ""
Read-Host "按回车键关闭"
