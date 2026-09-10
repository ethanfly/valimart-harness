; Silent update without --force-run: reopen the copy just written to $INSTDIR.
; Do not open $launchLink. A leftover /D= sandbox install can leave the Start
; Menu / desktop .lnk pointing at an old exe; launching that looks like the
; updater finished and never came back. --force-run still uses electron-builder
; StartApp (shortcut); auto-update does not pass it, so this is the only launch.
!macro customInstall
  ${if} ${Silent}
  ${andIfNot} ${isForceRun}
    HideWindow
    ; StartApp declares a global variable each time it expands. The builder
    ; expands it later as well, so use its user-context launch primitive here.
    StrCpy $R0 ""
    ${if} ${isUpdated}
      StrCpy $R0 "--updated"
    ${endIf}
    ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "$R0"
  ${endIf}
!macroend
