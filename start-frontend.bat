@echo off
rem Frontend start (idempotent: skip if port 5173 already in use)
call "%~dp0check-port.bat" 5173
if not errorlevel 1 (
  echo [SKIP] Frontend already running on port 5173.
  exit /b 0
)
cd /d "%~dp0apps\web"
set PATH=C:\Program Files\nodejs;%PATH%
echo Starting frontend dev server...
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\.pnpm\vite@5.4.8_@types+node@20.19.43_terser@5.50.0\node_modules\vite\bin\vite.js" --host
pause
