#!/usr/bin/env bash
# 只做本地校验：验 sync-plugins.sh 里那两处提取的语义。
# 覆盖的正是上一版踩到的坑：sed 的 `.*` 贪婪，单行 JSON 会取到嵌套的 tree.sha。
set -u
cd /d/QQ-Agent || exit 1
rm -rf .check && mkdir -p .check && cd .check || exit 1

# ① 单行 JSON：必须取到**顶层**那个 sha（上一版这里取到了 0000…）
printf '%s' '{"sha":"1aa7e9416d8c81107d8b1dd19d96186abe7acea0","node_id":"x","commit":{"tree":{"sha":"0000000000000000000000000000000000000000"}}}' > one.json
got="$(grep -o '"sha" *: *"[0-9a-f]\{40\}"' one.json | head -1 | cut -d'"' -f4)"
if [ "$got" = "1aa7e9416d8c81107d8b1dd19d96186abe7acea0" ]; then echo "  ① 单行 JSON   OK  $got"; else echo "  ① 单行 JSON   FAIL 取到 $got"; fi

# ② 多行 JSON
printf '{\n  "sha": "ac7dce99532d0150bd8988bb89f9a97725f43c72",\n  "commit": {"tree": {"sha": "1111111111111111111111111111111111111111"}}\n}\n' > pretty.json
got="$(grep -o '"sha" *: *"[0-9a-f]\{40\}"' pretty.json | head -1 | cut -d'"' -f4)"
if [ "$got" = "ac7dce99532d0150bd8988bb89f9a97725f43c72" ]; then echo "  ② 多行 JSON   OK  $got"; else echo "  ② 多行 JSON   FAIL 取到 $got"; fi

# ③ 404 响应：必须取不到（空），否则会拿一个空 sha 去拼 URL
printf '%s' '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}' > notfound.json
got="$(grep -o '"sha" *: *"[0-9a-f]\{40\}"' notfound.json | head -1 | cut -d'"' -f4)"
if [ -z "$got" ]; then echo "  ③ 404 响应    OK  取不到（空）"; else echo "  ③ 404 响应    FAIL 取到 $got"; fi

# ④ 真·GitHub commits 响应里的 "url" 字段也带一个 commit sha，但它在 sha 之后，head -1 不受影响
printf '%s' '{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","commit":{"url":"https://api.github.com/repos/o/r/git/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' > url.json
got="$(grep -o '"sha" *: *"[0-9a-f]\{40\}"' url.json | head -1 | cut -d'"' -f4)"
if [ "$got" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]; then echo "  ④ 带 url 字段  OK  $got"; else echo "  ④ 带 url 字段  FAIL 取到 $got"; fi

# ⑤ 插件列表 + 版本号提取（照抄脚本里的逻辑）
DIR=/d/QQ-Agent/my-plugins
echo '  ⑤ 插件列表：'
for d in "$DIR"/*/; do
  [ -f "${d}plugin.json" ] || continue
  id="$(basename "$d")"
  version="$(grep -o '"version" *: *"[^"]*"' "${d}plugin.json" | head -1 | cut -d'"' -f4)"
  printf '      %-22s %s\n' "$id" "$version"
done

cd /d/QQ-Agent && rm -rf .check
echo '（校验完成，临时文件已删）'
