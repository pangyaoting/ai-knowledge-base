#!/bin/sh
# AI 知识库 - WSL docker 保活脚本（开机自启 / 一键启动 共用）
# 设计要点：
# 1) 用"docker ps 能否连上"判断 dockerd 是否真正可用——旧版用 pgrep 进程名，
#    关机残留的僵尸进程会让守卫误判"已在运行"而跳过启动，导致 5432 永远不通；
# 2) 不可用 → 清残留进程/pid/socket → 重启 dockerd → 等 socket 就绪；
# 3) compose 拉起容器 + 端口自愈（容器活着但端口没绑时重启容器强制重建转发）；
# 4) tail -f 保活：防止 WSL 发行版因空闲被系统回收（回收会断掉所有容器端口）。

log() { echo "[keep-docker] $*"; }

wait_docker() {
  i=0
  while [ $i -lt 30 ]; do
    if docker ps >/dev/null 2>&1; then return 0; fi
    i=$((i+1)); sleep 1
  done
  return 1
}

if ! docker ps >/dev/null 2>&1; then
  log "dockerd 不可用，清理残留并重启..."
  pkill -f dockerd 2>/dev/null
  sleep 3
  rm -f /var/run/docker.pid
  rm -rf /var/run/docker
  nohup dockerd > /var/log/dockerd.log 2>&1 &
  if wait_docker; then
    log "dockerd 已就绪"
  else
    log "ERROR: dockerd 30s 内未就绪，请查看 /var/log/dockerd.log"
  fi
else
  log "dockerd 正常"
fi

cd /mnt/d/项目/主项目
docker compose -p kb up -d 2>&1

# 端口自愈：容器健康但 docker-proxy 没把端口绑出来时，重启对应容器强制重建转发
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
      log "REPAIR: $container 端口 $port 未绑定，重启容器强制重建转发"
      docker restart "$container" >/dev/null 2>&1
    fi
    n=$((n+1)); sleep 2
  done
  log "WARN: $container 端口 $port 反复尝试后仍未绑定（可能被本机其他进程占用，如 rediszt3 服务）"
}
repair_port kb-postgres 5432
repair_port kb-redis 6379

log "SERVICES_READY"
# 保活：防止 WSL 发行版因空闲被系统回收
exec tail -f /dev/null
