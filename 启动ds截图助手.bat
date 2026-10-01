@echo off
setlocal
set "APPDIR=%~dp0"
rem %~dp0 always ends with a backslash; strip it, otherwise the trailing \" breaks
rem the quoted path (classic Windows batch quoting trap -> app exits silently).
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

set "EXE=%APPDIR%\node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo [ERROR] Electron runtime not found:
  echo   %EXE%
  echo Run "npm install" in %APPDIR% first.
  pause
  exit /b 1
)

rem Write any startup error to a log next to the app so it can be checked later.
start "" "%EXE%" "%APPDIR%" 2>"%APPDIR%\startup-error.log"
exit /b 0
