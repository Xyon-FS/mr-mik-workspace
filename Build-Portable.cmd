@echo off
setlocal
cd /d "%~dp0"
if exist ".cache\build-tooling\node-v24.19.0-win-x64\node.exe" (
  ".cache\build-tooling\node-v24.19.0-win-x64\node.exe" "scripts\build-portable.mjs" %*
) else (
  node "scripts\build-portable.mjs" %*
)
set "BUILD_RESULT=%ERRORLEVEL%"

echo.
pause
exit /b %BUILD_RESULT%
