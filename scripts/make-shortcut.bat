@echo off
rem ============================================================
rem  免安装版 · 创建快捷方式
rem  在桌面和开始菜单放一个「跨多多 AI 创作台」图标，
rem  以后从图标启动即可（数据仍然写在程序目录的 data\ 下）。
rem  不需要管理员权限，不碰注册表。
rem ============================================================
setlocal
cd /d "%~dp0"

set "TARGET=%~dp0跨多多 AI 创作台.exe"
set "NAME=跨多多 AI 创作台"

if not exist "%TARGET%" (
  echo [错误] 没找到主程序：
  echo        %TARGET%
  echo 请把这个 bat 放在免安装版目录里（和 exe 同级）再运行。
  pause
  exit /b 1
)

if not exist "portable.flag" (
  echo [警告] 没找到 portable.flag —— 这个标记决定数据是否写在程序目录。
  echo 缺失时数据会写到 %%APPDATA%%，不再是绿色版。
  echo 正在为你补上...
  echo 1> "portable.flag"
)

echo 正在创建快捷方式...

rem 用 VBScript 建 .lnk（Windows 自带能力，无需额外工具）
> "%TEMP%\mklnk_ai_canvas.vbs" echo Set sh = CreateObject("WScript.Shell")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo Set fso = CreateObject("Scripting.FileSystemObject")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo desk = sh.SpecialFolders("Desktop")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo startMenu = sh.SpecialFolders("Programs")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo target = "%TARGET%"
>>"%TEMP%\mklnk_ai_canvas.vbs" echo workdir = fso.GetParentFolderName(target)
>>"%TEMP%\mklnk_ai_canvas.vbs" echo Set lnk = sh.CreateShortcut(desk ^& "\%NAME%.lnk")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk.TargetPath = target
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk.WorkingDirectory = workdir
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk.IconLocation = target ^& ",0"
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk.Description = "跨多多 AI 创作台（免安装版）"
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk.Save
>>"%TEMP%\mklnk_ai_canvas.vbs" echo Set lnk2 = sh.CreateShortcut(startMenu ^& "\%NAME%.lnk")
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk2.TargetPath = target
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk2.WorkingDirectory = workdir
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk2.IconLocation = target ^& ",0"
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk2.Description = "跨多多 AI 创作台（免安装版）"
>>"%TEMP%\mklnk_ai_canvas.vbs" echo lnk2.Save
>>"%TEMP%\mklnk_ai_canvas.vbs" echo WScript.Echo "OK"

cscript //nologo "%TEMP%\mklnk_ai_canvas.vbs"
del "%TEMP%\mklnk_ai_canvas.vbs" >nul 2>&1

echo.
echo ============================================
echo   完成！
echo   桌面和开始菜单都已放好「%NAME%」
echo.
echo   提醒：程序目录请勿只拷 exe ——
echo   要搬家就把整个文件夹一起拷走，数据在 data\ 里。
echo ============================================
echo.
pause
