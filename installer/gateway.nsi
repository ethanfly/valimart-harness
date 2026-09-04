; THE DIVA 公司网关 安装程序（NSIS 3，UTF-8）。由 scripts/build-gateway-installer.mjs 调用：
;   makensis /INPUTCHARSET UTF8 /DVERSION=x.y.z /DSTAGE=<暂存目录> /DOUTFILE=<输出 exe> [/DICON=<ico>] installer\gateway.nsi
; NSIS 只做：复制文件 → node init.mjs 生成配置与服务定义 → WinSW 注册并启动服务 → 防火墙放行。逻辑都在 init.mjs 里。
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
  !define OUTFILE "THE-DIVA-Gateway-Setup-${VERSION}.exe"
!endif

!define PRODUCT "THE DIVA Gateway"
!define SERVICE "TheDivaGateway"
!define PORT "8790"
!define FWRULE "THE DIVA Gateway"
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

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "将安装 THE DIVA 公司网关，并注册为 Windows 服务（${SERVICE}），随系统自动启动。$\r$\n$\r$\n不需要预装 Node.js。安装后员工在客户端登录页填写本机地址即可使用。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_TEXT "服务 ${SERVICE} 已注册并启动，随系统自动运行。$\r$\n管理页：$PublicUrl/admin（种子管理员 boss / boss123456，请尽快修改密码）$\r$\n$\r$\n配置、密钥、日志与数据目录的说明见 $INSTDIR\README.txt；数据在 $ProgramDataDir\${PRODUCT}（卸载保留）。"
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
  SetOutPath "$INSTDIR"
  File "${STAGE}\README.txt"

  DetailPrint "生成配置与服务定义…"
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\service\init.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "初始化失败（退出码 $0），未注册服务。请查看上方日志。" /SD IDOK
    Abort
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

  DetailPrint "防火墙放行 TCP ${PORT}…"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FWRULE}" dir=in action=allow protocol=TCP localport=${PORT}'
  Pop $0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${REGKEY}" "Publisher" "THE DIVA"
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
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  ; 只删自己装的东西（不用 RMDir /r $INSTDIR：用户若选了已有目录会被整个清空）；ProgramData 数据目录不碰
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\service"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${REGKEY}"
  MessageBox MB_OK|MB_ICONINFORMATION "已卸载 ${PRODUCT}。$\r$\n数据（账号 / 令牌 / 任务 / 通道凭据 / 公司盘）仍保留在：$\r$\n$ProgramDataDir\${PRODUCT}$\r$\n不再需要请手动删除。" /SD IDOK
SectionEnd
