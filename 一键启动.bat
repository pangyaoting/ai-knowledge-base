@echo off
chcp 65001 >nul
echo ============================================
echo   AI 知识库项目 - 一键启动
echo ============================================
echo.

echo [1/4] 启动 WSL2 中的 Docker 和数据库容器...
start "WSLDocker" /min wsl -d alpine -- sh /mnt/d/项目/主项目/keep-docker-running.sh

echo  等待数据库就绪（最多 90 秒）...
powershell -NoProfile -Command "$t=0; while($t -lt 90){ if(Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 (
  echo [错误] 数据库 90 秒内未就绪，请检查 WSL/Docker 状态
  pause
  exit /b 1
)
echo  数据库已就绪 ✓

echo [2/4] 启动后端 (NestJS) ...
start "KB-Backend" /min cmd /c "D:\项目\主项目\start-backend.bat"
echo  等待后端就绪（最多 60 秒）...
powershell -NoProfile -Command "$t=0; while($t -lt 60){ if(Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet){ exit 0 }; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 (
  echo [错误] 后端 60 秒内未就绪，请查看 KB-Backend 窗口的报错
  pause
  exit /b 1
)
echo  后端已就绪 ✓

echo [3/4] 启动前端 (Vite) ...
start "KB-Frontend" cmd /c "D:\项目\主项目\start-frontend.bat"

echo.
echo [4/4] 启动完成！
echo   前端:   http://localhost:5173
echo   后端:   http://localhost:3000/api
echo   API文档: http://localhost:3000/api/docs
echo.
echo 按任意键打开浏览器...
pause >nul
start http://localhost:5173
