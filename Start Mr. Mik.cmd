@echo off
setlocal
set "MRMAK_LAUNCH_ROOT=%~dp0"
if exist "%LOCALAPPDATA%\Mr. Mik\mrmak-workspace.exe" (
  start "" "%LOCALAPPDATA%\Mr. Mik\mrmak-workspace.exe" --repo "%MRMAK_LAUNCH_ROOT%."
  exit /b 0
)
if exist "%MRMAK_LAUNCH_ROOT%src-tauri\target\release\mrmak-workspace.exe" (
  start "" "%MRMAK_LAUNCH_ROOT%src-tauri\target\release\mrmak-workspace.exe" --repo "%MRMAK_LAUNCH_ROOT%."
  exit /b 0
)
echo Install Mr. Mik from the maintainer's release, or build this source.
echo Build: powershell -NoProfile -ExecutionPolicy Bypass -File Setup.ps1 -Mode Desktop
pause
