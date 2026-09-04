@echo off
cd /d "%~dp0"
echo MultiMix - lokalni rezim
echo.

set "NODEEXE="
if exist "%~dp0runtime\node\node.exe" (
  set "NODEEXE=%~dp0runtime\node\node.exe"
  goto have_node
)
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where node') do (
    set "NODEEXE=%%i"
    goto have_node
  )
)

where docker >nul 2>&1
if not errorlevel 1 (
  docker info >nul 2>&1
  if not errorlevel 1 goto use_docker
)

echo Neni Node.js ani Docker.
echo.
echo Prenosna varianta bez instalace:
echo   1. Stahni Node 24 ZIP win-x64 z nodejs.org
echo   2. Rozbal tak, aby existoval runtime\node\node.exe
echo   3. Spust znovu start-local.cmd
echo.
pause
exit /b 1

:have_node
set MULTIMIX_LOCAL=1
set ADMIN_PASSWORD=admin
rem Bind na vsechny sitove karty. Pro jednu IP zmen dalsi radek, treba: set HOST=192.168.1.50
if not defined HOST set HOST=0.0.0.0
netsh advfirewall firewall add rule name="MultiMix HTTP" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
if not exist node_modules (
  echo Instaluji npm zavislosti, potrebuje internet...
  if exist "%~dp0runtime\node\npm.cmd" (
    call "%~dp0runtime\node\npm.cmd" ci --omit=dev
  ) else (
    call npm ci --omit=dev
  )
  if errorlevel 1 (
    echo npm ci selhalo. Zkopiruj slozku node_modules z pripraveneho PC.
    pause
    exit /b 1
  )
)
echo Startuji Node...
echo Rezie:           http://localhost:3000/admin/
echo Panel haly:      http://localhost:3000/hall/?hall=1
echo Svetelny panel:  http://localhost:3000/panel/?hall=1
echo Prihlaseni:      admin / admin
echo Aktualizace:     sync.cmd
echo Zastaveni:       zavri toto okno
start "" "http://localhost:3000/admin/"
"%NODEEXE%" src\index.js
goto :eof

:use_docker
echo Startuji Docker...
docker compose -f docker-compose.local.yml up -d --build
if errorlevel 1 (
  docker-compose -f docker-compose.local.yml up -d --build
)
if errorlevel 1 (
  echo Docker se nepodarilo spustit.
  pause
  exit /b 1
)
echo.
echo Rezie:           http://localhost:3000/admin/
echo Panel haly:      http://localhost:3000/hall/?hall=1
echo Svetelny panel:  http://localhost:3000/panel/?hall=1
echo Prihlaseni:      admin / admin
echo Aktualizace:     sync.cmd
echo Zastaveni:       stop-local.cmd
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:3000/admin/"
