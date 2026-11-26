@echo off
setlocal
cd /d "%~dp0.."
if exist ".cache\build-tooling\node-v24.19.0-win-x64\node.exe" (
  ".cache\build-tooling\node-v24.19.0-win-x64\node.exe" "scripts\codex-account-acceptance.mjs" %*
) else (
  node "scripts\codex-account-acceptance.mjs" %*
)
pause
