@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Sync - stahuji jen zmenene soubory, slozka data zustane...
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

"%NODEEXE%" "%~dp0update.mjs"
if errorlevel 1 goto fail_run
echo.
pause
exit /b 0

:fail_dl
echo Stazeni se nezdarilo. Je internet? Pokud jeste nemas balicek, spust install.cmd.
pause
exit /b 1

:fail_node
echo Chybi Node. Spust nejdriv install.cmd.
pause
exit /b 1

:fail_run
echo Sync se nezdaril.
pause
exit /b 1
