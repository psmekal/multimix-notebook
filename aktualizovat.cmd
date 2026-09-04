@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Stahuji aktualni balicek...
curl.exe -L --fail --retry 3 -o "%TEMP%\multimix-portable.zip" "https://github.com/psmekal/multimix-notebook/releases/latest/download/multimix-portable.zip"
if errorlevel 1 goto fail_dl

set "UNPACK=%TEMP%\multimix-unpacked"
if exist "%UNPACK%" rmdir /s /q "%UNPACK%"
mkdir "%UNPACK%"
tar.exe -xf "%TEMP%\multimix-portable.zip" -C "%UNPACK%"
if errorlevel 1 goto fail_tar

set "SRC="
if exist "%UNPACK%\multimix-portable\start-local.cmd" set "SRC=%UNPACK%\multimix-portable"
if not defined SRC if exist "%UNPACK%\start-local.cmd" set "SRC=%UNPACK%"
if not defined SRC goto fail_src

rem %~dp0 ends with \ — that breaks quoted paths in robocopy/xcopy.
set "DEST=%~dp0"
if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

echo Kopiruji soubory, slozka data zustane.
echo Zdroj: %SRC%
echo Cil:   %DEST%
robocopy "%SRC%" "%DEST%" /E /XD data /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 goto fail_copy

echo Hotovo. Spust start-local.cmd
pause
exit /b 0

:fail_dl
echo Stazeni ZIP se nezdarilo.
pause
exit /b 1

:fail_tar
echo Rozbaleni ZIP se nezdarilo.
pause
exit /b 1

:fail_src
echo Ve ZIPu chybi start-local.cmd
dir /s /b "%UNPACK%\start-local.cmd"
pause
exit /b 1

:fail_copy
echo Kopirovani se nezdarilo.
echo SRC=%SRC%
echo DEST=%DEST%
pause
exit /b 1
