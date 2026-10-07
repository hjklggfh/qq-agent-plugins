#!/usr/bin/env bash
# 在服务器上跑：把这个仓库的插件同步到线上并重启服务。
#
#   cd /mnt/data/qq-agent/plugins && bash sync-plugins.sh
#
# 它做四件事：只快进地拉一次 → 列出将要生效的插件 → 重启服务 → 打一次 /healthz。
# ⚠️ 会重启服务：正在进行的一轮对话会被打断，OneBot 约 3 秒后重连。
#
# 环境变量（都可省）：
#   QQ_AGENT_SERVICE  服务名，默认 qq-agent-linux
#   QQ_AGENT_PORT     控制台端口，默认 3210
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${QQ_AGENT_SERVICE:-qq-agent-linux}"
PORT="${QQ_AGENT_PORT:-3210}"
cd "$DIR"

if [ ! -d .git ]; then
  printf '这不是一个 git 仓库（%s）。先在服务器上 clone 一次，或者直接用 scp 传目录。\n' "$DIR" >&2
  exit 1
fi

echo "==> git pull --ff-only"
# --ff-only：服务器上若有本地改动/分叉，宁可报错也不悄悄合并 —— 插件代码不该出现"只有线上才有的版本"
git pull --ff-only

echo "==> 本仓库里的插件："
found=0
for d in */; do
  [ -f "${d}plugin.json" ] || continue
  found=1
  id="$(basename "$d")"
  printf '    %-28s %s\n' "$id" "$(grep -o '"version"[^,]*' "${d}plugin.json" | head -1 | tr -d ' "')"
done
[ "$found" = 1 ] || echo "    （一个都没有）"

echo "==> 生效还需要两步（控制台里）：对新增/改过能力/工具的点「确认这份能力」，然后重启"
echo "==> 重启 $SERVICE"
systemctl --user restart "$SERVICE"
sleep 3
echo "==> /healthz"
curl -s "http://127.0.0.1:${PORT}/healthz" || true
echo
