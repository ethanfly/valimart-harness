; Legacy clients launch the updater with /S alone. Reopen after files and
; shortcuts are installed; --force-run is handled by electron-builder below
; customInstall, so leave that path alone to avoid launching twice.
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
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$R0"
  ${endIf}
!macroend
