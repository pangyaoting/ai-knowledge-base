@echo off
rem Backend start (idempotent: skip if port 3000 already in use)
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [SKIP] Backend already running on port 3000.
  exit /b 0
)
cd /d "%~dp0apps\server"
set PATH=C:\Program Files\nodejs;%PATH%
echo [1/2] Compiling TypeScript...
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\.pnpm\typescript@5.6.2\node_modules\typescript\bin\tsc" -p tsconfig.build.json
echo [2/2] Starting backend...
"C:\Program Files\nodejs\node.exe" dist/main.js
pause
