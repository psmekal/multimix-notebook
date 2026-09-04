@echo off
setlocal EnableExtensions
net session >nul 2>&1
if errorlevel 1 (
  echo Spust toto jako spravce: pravy klik na povolit-sit.cmd, Spustit jako administrator.
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="MultiMix HTTP" >nul 2>&1
netsh advfirewall firewall delete rule name="MultiMix HTTPS" >nul 2>&1
netsh advfirewall firewall add rule name="MultiMix HTTP" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 goto fail
netsh advfirewall firewall add rule name="MultiMix HTTPS" dir=in action=allow protocol=TCP localport=3443 profile=any
if errorlevel 1 goto fail
echo Hotovo. Port 3000 a 3443 jsou povolene ve Windows Firewall na vsech profilech.
echo Pak spust start-local.cmd a z jineho PC otevri http://IP-TOHOTO-PC:3000/admin/
pause
exit /b 0
:fail
echo Pravidlo se nepodarilo pridat.
pause
exit /b 1
