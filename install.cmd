@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo MultiMix - stahuji kompletni balicek pro notebook...
echo.

set "ZIP=%TEMP%\multimix-portable.zip"
set "UNPACK=%TEMP%\multimix-unpacked"
curl.exe -L --fail --retry 3 -o "%ZIP%" "https://github.com/psmekal/multimix-notebook/releases/latest/download/multimix-portable.zip"
if errorlevel 1 goto fail_dl

if exist "%UNPACK%" rmdir /s /q "%UNPACK%"
mkdir "%UNPACK%"
tar.exe -xf "%ZIP%" -C "%UNPACK%"
if errorlevel 1 goto fail_tar

set "SRC="
if exist "%UNPACK%\multimix-portable\start-local.cmd" set "SRC=%UNPACK%\multimix-portable"
if not defined SRC if exist "%UNPACK%\start-local.cmd" set "SRC=%UNPACK%"
if not defined SRC goto fail_src

set "DEST=%~dp0"
if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

echo Kopiruji do:
echo   %DEST%
echo Slozka data se nesmaze.
robocopy "%SRC%" "%DEST%" /E /XD data /R:2 /W:1 /NFL /NDL /NJH
if errorlevel 8 goto fail_copy

echo.
echo Hotovo.
echo Spust start-local.cmd
echo Prihlaseni: admin / admin
echo Pozdeji jen sync.cmd - stahne zmeny, data necha.
echo.
pause
exit /b 0

:fail_dl
echo Stazeni ZIP se nezdarilo. Je internet?
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
