#!/bin/sh
# AI 知识库 - WSL 保活脚本：只做 tail -f，防止 WSL2 VM 因空闲被系统回收（回收会断掉所有容器端口）。
# 由一键启动在独立最小化窗口后台运行；与 docker 就绪脚本分离，各司其职。
exec tail -f /dev/null
