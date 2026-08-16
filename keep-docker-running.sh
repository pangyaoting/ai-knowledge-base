#!/bin/sh
# 启动 dockerd（如果没运行）
if ! pgrep dockerd > /dev/null 2>&1; then
  dockerd > /var/log/dockerd.log 2>&1 &
  i=0
  while [ $i -lt 30 ]; do
    if docker ps > /dev/null 2>&1; then break; fi
    i=$((i+1))
    sleep 1
  done
fi
# 确保容器在运行
cd /mnt/d/项目/主项目
docker compose -p kb up -d 2>&1
echo "SERVICES_READY"
# 保持会话存活
exec tail -f /dev/null