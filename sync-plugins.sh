#!/usr/bin/env bash
# 在服务器上跑：把插件同步到线上并重启服务。
#
#   cd /mnt/data/qq-agent/plugins && bash sync-plugins.sh
#
# 两条通道，与主程序更新器同一套思路（docs/AUTO_UPDATE.md 的"第二条下载通道"）：
#   ① 先试 git（快，而且能看出改了什么）；
#   ② git 不通就改用 GitHub API + codeload 源码包。
#
# 为什么必须有第二条：这类网络（阿里云国内实例）到 github.com 的 git 通道经常是黑洞 ——
# TCP 443 连上就卡、`ls-remote` 干等超时、或者 "Error in the HTTP2 framing layer"，
# 而 api.github.com 与 codeload.github.com 是好的。主程序的更新器就是靠这条备用通道
# 才能自动更新的，这里照抄同一套。
#
# 环境变量：
#   QQ_AGENT_SERVICE       服务名，默认 qq-agent-linux
#   QQ_AGENT_PORT          控制台端口，默认 3210
#   QQ_AGENT_GITHUB_TOKEN  私有仓库的只读 PAT；留空则读同目录的 .github-token（已 gitignore）
#   QQ_AGENT_CODELOAD      codeload 基地址（镜像用），默认 https://codeload.github.com
#   QQ_AGENT_GITHUB_API    GitHub API 基地址（镜像用），默认 https://api.github.com
#   GIT_HTTP11=0           设为 0 则不强制 git 走 HTTP/1.1（默认强制：可规避 HTTP/2 链路抖动）
set -euo pipefail

OWNER=hjklggfh
REPO=qq-agent-plugins
BRANCH=main
SERVICE="${QQ_AGENT_SERVICE:-qq-agent-linux}"
PORT="${QQ_AGENT_PORT:-3210}"
API="${QQ_AGENT_GITHUB_API:-https://api.github.com}"
CODELOAD="${QQ_AGENT_CODELOAD:-https://codeload.github.com}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOKEN="${QQ_AGENT_GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$DIR/.github-token" ]; then
  TOKEN="$(tr -d ' \r\n' < "$DIR/.github-token")"
fi

# 私有仓库要用 token；公开仓库留空即可（这条通道对两者都成立）
curl_gh() {
  if [ -n "$TOKEN" ]; then
    curl -fsS -H "Authorization: Bearer $TOKEN" "$@"
  else
    curl -fsS "$@"
  fi
}

echo "==> ① 先试 git 通道"
# 强制 HTTP/1.1：这台机器的实测失败模式之一就是 "Error in the HTTP2 framing layer"。
# 主程序更新器里的「强制 Git HTTP/1.1」开关治的是同一件事。
GIT_PULL_OK=0
if [ -d "$DIR/.git" ]; then
  if [ "${GIT_HTTP11:-1}" = "0" ]; then
    git -C "$DIR" pull --ff-only 2>/dev/null && GIT_PULL_OK=1
  else
    git -c http.version=HTTP/1.1 -C "$DIR" pull --ff-only 2>/dev/null && GIT_PULL_OK=1
  fi
fi
if [ "$GIT_PULL_OK" = 1 ]; then
  echo "    git 通道可用"
else
  echo "    git 通道不通（或这不是 git 仓库），改用 GitHub API + codeload 源码包"
  # ⚠️ 提取 sha 必须用 `grep -o | head -1`，**不能**用 sed 的 `s/.*"sha".*/\1/`：
  #    sed 的 `.*` 是贪婪的，单行 JSON 里 `"sha"` 出现两次（顶层 + 嵌套的 commit.tree.sha），
  #    它会取到**最后**那个 tree sha，于是去拉一个不存在的 tarball —— 实测踩过。
  #    grep -o 是"从左往右找不重叠的第一个"，配 head -1 才是我们要的顶层 sha。
  sha="$(curl_gh -H 'Accept: application/vnd.github+json' \
    "$API/repos/$OWNER/$REPO/commits/$BRANCH" \
    | grep -o '"sha" *: *"[0-9a-f]\{40\}"' | head -1 | cut -d'"' -f4)"
  if [ -z "$sha" ]; then
    echo "    拿不到 commit sha —— 私有仓库要填 token（.github-token 或 QQ_AGENT_GITHUB_TOKEN）" >&2
    echo "    也可以先用 curl 看一眼 API 通不通：$API/repos/$OWNER/$REPO" >&2
    exit 1
  fi
  echo "    sha=$sha"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # 用 API 的 tarball 端点：它 302 到 codeload 并带上签名 URL，
  # 所以 token 只发给 api.github.com，不会跟着跳到 codeload 那边去。
  curl_gh -L --max-time 180 -o "$tmp/repo.tar.gz" "$API/repos/$OWNER/$REPO/tarball/$sha"
  mkdir -p "$tmp/out"
  tar -xzf "$tmp/repo.tar.gz" -C "$tmp/out" --strip-components=1
  if command -v rsync >/dev/null 2>&1; then
    # --delete：上一版里有、这一版已删掉的插件要跟着消失，否则它会被当成"还在"。
    # 排除 .git 与 token 文件，其余按仓库内容为准。
    rsync -a --delete --exclude '.git' --exclude '.github-token' "$tmp/out/" "$DIR/"
    echo "    已同步（rsync --delete）"
  else
    ( cd "$tmp/out" && tar -cf - . ) | ( cd "$DIR" && tar -xf - )
    echo "    已同步（没有 rsync：只覆盖，不会删除已移除的文件）"
  fi
fi

echo "==> ② 本仓库里的插件："
found=0
for d in "$DIR"/*/; do
  [ -f "${d}plugin.json" ] || continue
  found=1
  id="$(basename "$d")"
  # 同样用 grep -o 而不是贪婪的 sed（理由见上面那段注释）
  version="$(grep -o '"version" *: *"[^"]*"' "${d}plugin.json" | head -1 | cut -d'"' -f4)"
  printf '    %-24s %s\n' "$id" "$version"
done
[ "$found" = 1 ] || echo "    （一个都没有）"

echo "==> ③ 生效还需要两步（控制台里）：对新增/改过能力/工具的点「确认这份能力」，然后重启"
echo "==> ④ 重启 $SERVICE"
systemctl --user restart "$SERVICE"
sleep 3
echo "==> ⑤ /healthz"
curl -s "http://127.0.0.1:${PORT}/healthz" || true
echo
