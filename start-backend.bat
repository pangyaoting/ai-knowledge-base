@echo off
chcp 65001 >nul
cd /d "D:\项目\主项目\apps\server"
set PATH=C:\Program Files\nodejs;%PATH%
echo [1/2] 编译 TypeScript...
"C:\Program Files\nodejs\node.exe" "D:\项目\主项目\node_modules\.pnpm\typescript@5.6.2\node_modules\typescript\bin\tsc" -p tsconfig.build.json
echo [2/2] 启动后端服务...
"C:\Program Files\nodejs\node.exe" dist/main.js
pause
