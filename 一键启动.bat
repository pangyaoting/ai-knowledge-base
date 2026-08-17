@echo off
echo ============================================
echo   AI Knowledge Base - One-Click Start
echo ============================================
echo.

echo [1/4] Starting WSL2 Docker and database containers...
start "WSLDocker" /min wsl -d alpine -- sh /mnt/d/??/???/keep-docker-running.sh

echo   Waiting for database (max 90s)...
powershell -NoProfile -Command "$t=0; while($t -lt 90){ if(Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Database not ready in 90s. Check WSL/Docker.
  pause
  exit /b 1
)
echo   Database ready.

echo [2/4] Starting backend (NestJS) ...
start "KB-Backend" /min cmd /c "D:\??\???\start-backend.bat"
echo   Waiting for backend (max 60s)...
powershell -NoProfile -Command "$t=0; while($t -lt 60){ if(Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Backend not ready in 60s. Check the KB-Backend window.
  pause
  exit /b 1
)
echo   Backend ready.

echo [3/4] Starting frontend (Vite) ...
start "KB-Frontend" cmd /c "D:\??\???\start-frontend.bat"

echo.
echo [4/4] All done!
echo   Frontend: http://localhost:5173
echo   Backend:  http://localhost:3000/api
echo   API Docs: http://localhost:3000/api/docs
echo.
echo Press any key to open browser...
pause >nul
start http://localhost:5173