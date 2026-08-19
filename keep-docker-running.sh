#!/bin/sh
# AI 知识库 - WSL docker 就绪脚本（一键启动前台同步调用）
# 职责：确保 dockerd 可用 → 容器健康 → 端口绑定，全部就绪后 exit 0。
# 设计要点（针对"开机后一键启动误报 Database not ready"的根治）：
# 1) 用 docker ps 能否连上判断 dockerd 是否真正可用（进程存在≠可用）；
# 2) 不可用 → 彻底清理残留（dockerd + containerd + shim + pid/socket）→ 重启 dockerd；
# 3) 就绪判断：容器 HEALTHCHECK 通过（不是只看端口开），再确认端口已绑定；
# 4) 每步失败都给明确 exit code，供 bat 判断，不再让 bat 用慢速探测瞎等。

log() { echo "[docker-ready] $*"; }

# 等 dockerd 可连（60s）
wait_docker() {
  i=0
  while [ $i -lt 60 ]; do
    if docker ps >/dev/null 2>&1; then return 0; fi
    i=$((i+1)); sleep 1
  done
  return 1
}

# 等容器 HEALTHCHECK 通过（60s）
wait_healthy() {
  container=$1
  i=0
  while [ $i -lt 60 ]; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null)
    if [ "$status" = "healthy" ]; then return 0; fi
    if [ "$status" = "" ]; then
      # 无 healthcheck 的容器：只要 Running 就算就绪
      running=$(docker ps --format '{{.Names}}' | grep -qx "$container" && echo yes)
      [ "$running" = "yes" ] && return 0
    fi
    i=$((i+1)); sleep 1
  done
  return 1
}

# 端口已绑定（在 WSL 网络命名空间内检查）
port_bound() {
  port=$1
  netstat -tln 2>/dev/null | grep -q ":$port "
}

# ============ 1. dockerd ============
# NOTE: keep log messages pure ASCII -- the script's stdout is shown in cmd's GBK
# console via the one-click bat; UTF-8 Chinese renders as mojibake there.
if ! docker ps >/dev/null 2>&1; then
  log "dockerd unavailable, cleaning stale processes and sockets..."
  # 彻底清理：dockerd + 其子进程 containerd + runc shim（残留 containerd 会占住 socket 导致新 dockerd 起不来）
  pkill -9 -f 'dockerd' 2>/dev/null
  pkill -9 -f 'containerd' 2>/dev/null
  sleep 3
  rm -f /var/run/docker.pid
  rm -rf /var/run/docker
  nohup dockerd > /var/log/dockerd.log 2>&1 &
  if wait_docker; then
    log "dockerd ready"
  else
    log "ERROR: dockerd not ready in 60s, check /var/log/dockerd.log"
    exit 1
  fi
else
  log "dockerd OK"
fi

# ============ 2. 容器 ============
# 项目根目录 = 脚本所在目录（脚本就放在项目根）；移动/复制项目到别处也自动适配
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1
docker compose -p kb up -d 2>&1

for c in kb-postgres kb-redis; do
  if wait_healthy "$c"; then
    log "$c healthy"
  else
    log "ERROR: $c not healthy in 60s, trying one restart"
    docker restart "$c" >/dev/null 2>&1
    if wait_healthy "$c"; then
      log "$c healthy (restarted)"
    else
      log "ERROR: $c still unhealthy, run 'docker logs $c' to debug"
      exit 1
    fi
  fi
done

# ============ 3. 端口绑定 ============
i=0
while [ $i -lt 30 ]; do
  if port_bound 5432 && port_bound 6379; then
    break
  fi
  i=$((i+1)); sleep 2
done
if port_bound 5432 && port_bound 6379; then
  log "ports 5432/6379 bound"
else
  log "WARN: port binding issue (maybe a local service holds IPv4 6379; project uses ::1 workaround)"
  # 不致命：redis 走 ::1 仍可用，postgres 若绑定失败则后端连不上——再给 postgres 一次重启
  if ! port_bound 5432; then
    docker restart kb-postgres >/dev/null 2>&1
    sleep 8
  fi
fi

log "SERVICES_READY"
exit 0
