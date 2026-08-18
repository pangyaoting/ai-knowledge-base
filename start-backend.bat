@echo off
cd /d "%~dp0apps\server"
set PATH=C:\Program Files\nodejs;%PATH%
echo [1/2] Compiling TypeScript...
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\.pnpm\typescript@5.6.2\node_modules\typescript\bin\tsc" -p tsconfig.build.json
echo [2/2] Starting backend...
"C:\Program Files\nodejs\node.exe" dist/main.js
pause
