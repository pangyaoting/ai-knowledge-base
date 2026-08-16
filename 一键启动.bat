@echo off
chcp 65001 >nul
echo ============================================
echo   AI 知识库项目 - 一键启动
echo ============================================
echo.

echo [1/3] 启动 WSL2 中的 Docker 和数据库容器...
wsl -d alpine -- sh /mnt/d/项目/主项目/keep-docker-running.sh &
timeout /t 15 /nobreak >nul

echo [2/3] 启动后端 (NestJS) ...
start "KB-Backend" /min cmd /c "D:\项目\主项目\start-backend.bat"
timeout /t 10 /nobreak >nul

echo [3/3] 启动前端 (Vite) ...
start "KB-Frontend" cmd /c "D:\项目\主项目\start-frontend.bat"

echo.
echo ============================================
echo   启动完成！
echo   前端: http://localhost:5173
echo   后端: http://localhost:3000/api
echo   API文档: http://localhost:3000/api/docs
echo ============================================
echo.
echo 按任意键打开浏览器...
pause >nul
start http://localhost:5173
