@echo off
cd /d "%~dp0apps\web"
set PATH=C:\Program Files\nodejs;%PATH%
echo Starting frontend dev server...
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\.pnpm\vite@5.4.8_@types+node@20.19.43_terser@5.50.0\node_modules\vite\bin\vite.js" --host
pause
