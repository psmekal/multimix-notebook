@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Stahuji aktualizator...
curl.exe -L --fail --retry 3 -o "%TEMP%\multimix-update.mjs" "https://raw.githubusercontent.com/psmekal/multimix-notebook/main/update.mjs"
if errorlevel 1 goto fail_dl
copy /Y "%TEMP%\multimix-update.mjs" "%~dp0update.mjs" >nul

set "NODEEXE="
if exist "%~dp0runtime\node\node.exe" set "NODEEXE=%~dp0runtime\node\node.exe"
if not defined NODEEXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODEEXE=node"
)
if not defined NODEEXE goto fail_node

echo Porovnavam soubory s GitHubem...
"%NODEEXE%" "%~dp0update.mjs"
if errorlevel 1 goto fail_run
echo.
pause
exit /b 0

:fail_dl
echo Stazeni aktualizatoru se nezdarilo. Je internet?
pause
exit /b 1

:fail_node
echo Chybi Node. Spust nejdriv start-local.cmd, nebo zkontroluj runtime\node\node.exe
pause
exit /b 1

:fail_run
echo Aktualizace se nezdarila.
pause
exit /b 1
