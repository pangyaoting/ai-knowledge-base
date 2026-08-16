@echo off
chcp 65001 >nul
cd /d "D:\项目\主项目\apps\web"
set PATH=C:\Program Files\nodejs;%PATH%
echo 启动前端开发服务器...
"C:\Program Files\nodejs\node.exe" "D:\项目\主项目\node_modules\.pnpm\vite@5.4.8_@types+node@20.19.43_terser@5.50.0\node_modules\vite\bin\vite.js" --host
pause
