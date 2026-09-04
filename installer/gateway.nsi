; THE DIVA 公司网关 安装程序（NSIS 3，UTF-8）。由 scripts/build-gateway-installer.mjs 调用：
;   makensis /INPUTCHARSET UTF8 /DVERSION=x.y.z /DSTAGE=<暂存目录> /DOUTFILE=<输出 exe> [/DICON=<ico>] installer\gateway.nsi
; NSIS 只做：复制文件 → node init.mjs 生成配置与服务定义 → icacls 收紧 ProgramData 数据目录 → WinSW 注册并启动服务 → 防火墙放行。逻辑都在 init.mjs 里。
; 系统程序（netsh / icacls）一律用 "$SYSDIR\xxx.exe" 全路径：安装器提权运行，不能靠 PATH 找可执行文件。
Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "需要 /DVERSION=x.y.z"
!endif
!ifndef STAGE
  !error "需要 /DSTAGE=<暂存目录>"
!endif
!ifndef OUTFILE
  !define OUTFILE "valimart-harness-Gateway-Setup-${VERSION}.exe"
!endif

!define PRODUCT "valimart harness Gateway"
!define SERVICE "TheDivaGateway"
!define PORT "8790"
!define LANPORT "18790"
!define FWRULE "valimart harness Gateway"
!define FWRULE_LAN "valimart harness Gateway LAN"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE}"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT}"
InstallDirRegKey HKLM "${REGKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif

Var PublicUrl
Var ProgramDataDir
Var BackupNote

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "将安装 valimart harness 公司网关，并注册为 Windows 服务（${SERVICE}），随系统自动启动。$\r$\n$\r$\n不需要预装 Node.js。安装后员工打开客户端，登录页会自动寻找局域网里的网关。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_TEXT "服务 ${SERVICE} 已注册并启动，随系统自动运行。$\r$\n管理页：$PublicUrl/admin（首次打开会引导设置公司名、初始管理员账号与密码，没有演示数据）$\r$\n$\r$\n配置、密钥、日志与数据目录的说明见 $INSTDIR\README.txt；数据在 $ProgramDataDir\${PRODUCT}（卸载保留）。"
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "打开管理页"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenAdmin
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function OpenAdmin
  ExecShell "open" "$PublicUrl/admin"
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "需要 64 位 Windows。" /SD IDOK
    Abort
  ${EndIf}
  ReadEnvStr $0 COMPUTERNAME
  StrCpy $PublicUrl "http://$0:${PORT}"
  ReadEnvStr $ProgramDataDir ProgramData
FunctionEnd

Function un.onInit
  ReadEnvStr $ProgramDataDir ProgramData
FunctionEnd

Section "网关" SecMain
  ${If} ${FileExists} "$INSTDIR\service\${SERVICE}.exe"
    DetailPrint "停止已有服务…"
    nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" stop'
    Pop $0
  ${EndIf}

  SetOutPath "$INSTDIR\runtime"
  File /r "${STAGE}\runtime\*.*"
  SetOutPath "$INSTDIR\server"
  File /r "${STAGE}\server\*.*"
  SetOutPath "$INSTDIR\service"
  File /r "${STAGE}\service\*.*"
  ; server\src\api.js 启动时静态导入 scripts\kernel 与 scripts\lib（catalog + prepare），缺了会 ERR_MODULE_NOT_FOUND；pin.json 也给管理页显示内核版本
  SetOutPath "$INSTDIR\scripts"
  File /r "${STAGE}\scripts\*.*"
  ; 管理页 header / favicon 花标（与开发态 ../../plugins/desk-ui/src/client/assets 相对位置一致）
  SetOutPath "$INSTDIR\plugins\desk-ui\src\client\assets"
  File /r "${STAGE}\plugins\desk-ui\src\client\assets\*.*"
  SetOutPath "$INSTDIR"
  File "${STAGE}\README.txt"

  DetailPrint "生成配置与服务定义…"
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\service\init.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "初始化失败（退出码 $0），未注册服务。请查看上方日志。" /SD IDOK
    Abort
  ${EndIf}

  ; 数据目录（账号 / 令牌 / 通道凭据）只给 SYSTEM 与 Administrators：服务以 LocalSystem 运行，管理员保留完全控制；失败只警告不中止
  DetailPrint "收紧数据目录权限（仅 SYSTEM 与 Administrators）…"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$ProgramDataDir\${PRODUCT}" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "警告：数据目录权限设置失败（退出码 $0），$ProgramDataDir\${PRODUCT} 仍为默认 ACL，请手工检查；继续安装。"
  ${EndIf}

  DetailPrint "注册并启动服务 ${SERVICE}…"
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" uninstall'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "注册服务失败（退出码 $0）。" /SD IDOK
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "服务已注册但启动失败（退出码 $0）。请查看 $ProgramDataDir\${PRODUCT}\logs。" /SD IDOK
  ${EndIf}

  DetailPrint "防火墙放行 TCP ${PORT} 与 UDP ${LANPORT}…"
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FWRULE_LAN}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FWRULE}" dir=in action=allow protocol=TCP localport=${PORT}'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FWRULE_LAN}" dir=in action=allow protocol=UDP localport=${LANPORT}'
  Pop $0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${REGKEY}" "Publisher" "Valimart"
  WriteRegStr HKLM "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKLM "${REGKEY}" "DisplayIcon" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  DetailPrint "停止并注销服务…"
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" uninstall'
  Pop $0
  ${If} $0 != 0
    DetailPrint "服务注销失败（$0），请手工执行 sc delete ${SERVICE}"
    MessageBox MB_OK|MB_ICONEXCLAMATION "服务注销失败（$0），请手工执行 sc delete ${SERVICE}。将继续删除文件。" /SD IDOK
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FWRULE_LAN}"'
  Pop $0
  ; 管理员改过的 config.local.json（端口 / publicUrl / 密钥）备份到数据目录，重装后可复制回 server 目录
  ; （注释末尾不能是反斜杠：NSIS 会把它当作续行符，吞掉下一行）
  StrCpy $BackupNote ""
  ${If} ${FileExists} "$INSTDIR\server\config.local.json"
    CreateDirectory "$ProgramDataDir\${PRODUCT}"
    CopyFiles /SILENT "$INSTDIR\server\config.local.json" "$ProgramDataDir\${PRODUCT}\config.local.json.bak"
    StrCpy $BackupNote "$\r$\n原 server\config.local.json 已备份为该目录下的 config.local.json.bak，重装后可复制回 server\ 并重启服务。"
  ${EndIf}
  ; 只删自己装的东西（不用 RMDir /r $INSTDIR：用户若选了已有目录会被整个清空）；ProgramData 数据目录不碰
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\service"
  RMDir /r "$INSTDIR\scripts"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${REGKEY}"
  MessageBox MB_OK|MB_ICONINFORMATION "已卸载 ${PRODUCT}。$\r$\n数据（账号 / 令牌 / 任务 / 通道凭据 / 公司盘）仍保留在：$\r$\n$ProgramDataDir\${PRODUCT}$BackupNote$\r$\n不再需要请手动删除。" /SD IDOK
SectionEnd
