@echo off
setlocal
set "ROOT=%~dp0"
set "ROOTN=%ROOT:~0,-1%"
echo ============================================
echo   AI Knowledge Base - One-Click Start
echo ============================================
echo.

echo [1/4] Starting WSL2 Docker and database containers...
rem ROOTN has no trailing backslash so wslpath quoting stays balanced
for /f "delims=" %%i in ('wsl -d alpine -- wslpath "%ROOTN%"') do set "WSLROOT=%%i"
if not defined WSLROOT goto :wslpath_fail
start "WSLDocker" /min wsl -d alpine -- sh "%WSLROOT%/keep-docker-running.sh"
echo   Waiting for database (max 90s)...
powershell -NoProfile -Command "$t=0; while($t -lt 90){ if(Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 goto :db_fail
echo   Database ready.

echo [2/4] Starting backend (NestJS) ...
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 } else { exit 1 }"
if not errorlevel 1 goto :backend_up
start "KB-Backend" /min cmd /c "%ROOT%start-backend.bat"
echo   Waiting for backend (max 90s)...
powershell -NoProfile -Command "$t=0; while($t -lt 90){ if(Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 goto :backend_fail
:backend_up
echo   Backend ready.

echo [3/4] Starting frontend (Vite) ...
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName localhost -Port 5173 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 } else { exit 1 }"
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
echo [ERROR] Database not ready in 90s.

echo   Fix: run keep-docker-running.sh inside WSL (project root),
pause
exit /b 1

:backend_fail
echo [ERROR] Backend not ready in 90s. Check the KB-Backend window.
pause
exit /b 1