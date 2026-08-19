@echo off
setlocal
set "ROOT=%~dp0"
set "ROOTN=%ROOT:~0,-1%"
echo ============================================
echo   AI Knowledge Base - One-Click Start
echo ============================================
echo.

rem [1/4] Boot WSL, hang keepalive (prevent idle recycle), then run docker-ready script synchronously.
rem The ready script only exits 0 after containers are healthy AND ports are bound,
rem so no more "Database not ready in 90s" false alarms from slow Test-NetConnection.
echo [1/4] Starting WSL2 Docker and database containers...
rem ROOTN has no trailing backslash so wslpath quoting stays balanced
for /f "delims=" %%i in ('wsl -d alpine -- wslpath "%ROOTN%"') do set "WSLROOT=%%i"
if not defined WSLROOT goto :wslpath_fail
start "KB-Keepalive" /min wsl -d alpine -- sh "%WSLROOT%/keepalive.sh"
echo   Running docker ready-check (containers must be healthy, max ~2min)...
wsl -d alpine -- sh "%WSLROOT%/keep-docker-running.sh"
if errorlevel 1 goto :db_fail
echo   Database ready.

echo [2/4] Starting backend (NestJS) ...
call "%ROOT%check-port.bat" 3000
if not errorlevel 1 goto :backend_up
start "KB-Backend" /min cmd /c "%ROOT%start-backend.bat"
echo   Waiting for backend (max 90s)...
powershell -NoProfile -Command "$t=0; while($t -lt 90){ $c=New-Object Net.Sockets.TcpClient; try{ $r=$c.ConnectAsync('127.0.0.1',3000).Wait(500); if($r -and $c.Connected){ exit 0 } }catch{} finally{ $c.Dispose() }; Start-Sleep -Seconds 1; $t+=1 }; exit 1"
if errorlevel 1 goto :backend_fail
:backend_up
echo   Backend ready.

echo [3/4] Starting frontend (Vite) ...
call "%ROOT%check-port.bat" 5173
if not errorlevel 1 goto :frontend_up
start "KB-Frontend" cmd /c "%ROOT%start-frontend.bat"
:frontend_up

echo.
echo [4/4] All done!
echo   Frontend: http://localhost:5173
echo   Backend:  http://localhost:3000/api
echo   API Docs: http://localhost:3000/api/docs
echo.
echo Press any key to open browser...
pause >nul
start http://localhost:5173
exit /b 0

:wslpath_fail
echo [ERROR] Cannot resolve WSL path. Is WSL2 available?
pause
exit /b 1

:db_fail
echo [ERROR] Docker/database not ready. See messages above; check WSL window for details.
echo   Tip: wsl --shutdown  then run this script again.
pause
exit /b 1

:backend_fail
echo [ERROR] Backend not ready in 90s. Check the KB-Backend window.
pause
exit /b 1
