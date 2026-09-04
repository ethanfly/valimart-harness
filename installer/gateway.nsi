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
!define MUI_FINISHPAGE_TEXT "服务 ${SERVICE} 已启动。$\r$\n$\r$\n管理页：$PublicUrl/admin$\r$\n种子管理员：boss / boss123456（请尽快修改密码）$\r$\n$\r$\n数据目录（卸载保留）：$ProgramDataDir\${PRODUCT}\data$\r$\n配置：$INSTDIR\server\config.local.json（改端口 / 公司名 / 额度后重启服务）"
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
    MessageBox MB_ICONSTOP "需要 64 位 Windows。"
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
    MessageBox MB_ICONSTOP "初始化失败（退出码 $0），未注册服务。请查看上方日志。"
    Abort
  ${EndIf}

  DetailPrint "注册并启动服务 ${SERVICE}…"
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" uninstall'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "注册服务失败（退出码 $0）。"
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "服务已注册但启动失败（退出码 $0）。请查看 $ProgramDataDir\${PRODUCT}\logs。"
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
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${REGKEY}"
  MessageBox MB_ICONINFORMATION "已卸载 ${PRODUCT}。$\r$\n数据（账号 / 令牌 / 任务 / 通道凭据 / 公司盘）仍保留在：$\r$\n$ProgramDataDir\${PRODUCT}$\r$\n不再需要请手动删除。"
SectionEnd
