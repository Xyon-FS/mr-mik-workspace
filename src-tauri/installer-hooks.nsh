; The stock Tauri running-app check offers a forced kill, which bypasses native
; writer shutdown and leaves retained conversation leases. Require a user-owned
; graceful exit before reaching that check, for both install and uninstall.
!macro MrMikRequireClosed
  !define MrMikClosedCheckId ${__LINE__}
  Push $R0
  mrmik_check_${MrMikClosedCheckId}:
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $R0
    ${If} $R0 = 0
      IfSilent mrmik_busy_${MrMikClosedCheckId} 0
      ${If} $PassiveMode = 1
        Goto mrmik_busy_${MrMikClosedCheckId}
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Mr. Mik is still running. Finish any active work, then choose 'Quit Mr. Mik and stop terminals' from its notification-area menu. Wait for it to close, then click Retry. Your conversations will be kept." IDRETRY mrmik_check_${MrMikClosedCheckId} IDCANCEL mrmik_busy_${MrMikClosedCheckId}
      mrmik_busy_${MrMikClosedCheckId}:
        Pop $R0
        SetErrorLevel 2
        Abort "Close Mr. Mik from its notification-area menu before installing or uninstalling. No processes have been terminated."
    ${EndIf}
  Pop $R0
  !undef MrMikClosedCheckId
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MrMikRequireClosed
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MrMikRequireClosed
!macroend
