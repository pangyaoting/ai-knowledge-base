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

# 自愈：容器健康但 docker-proxy 没把端口绑出来时，重启对应容器强制重建转发
# （WSL/dockerd 重启后偶发"容器活着、端口却不通"，一键启动就会卡在等 5432）
repair_port() {
  container=$1
  port=$2
  n=0
  while [ $n -lt 30 ]; do
    if netstat -tln 2>/dev/null | grep -q ":$port "; then
      return 0
    fi
    if docker ps --format '{{.Names}} {{.Status}}' | grep -q "^$container Up"; then
      echo "REPAIR: $container port $port not bound, restarting container"
      docker restart "$container" >/dev/null 2>&1
    fi
    n=$((n+1))
    sleep 2
  done
  echo "WARN: $container port $port still not bound after retries"
}
repair_port kb-postgres 5432
repair_port kb-redis 6379

echo "SERVICES_READY"
# 保持会话存活
exec tail -f /dev/null
