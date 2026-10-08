# Pixiv 来张图（自建）· 操作手册

按角色／关键词搜 Pixiv 插画，把图发到当前会话。工具名：`pixiv_image`、`pixiv_set_rating`。

这份 README 把原作者原 manifest 里的 `configSchema`（逐字段 label / description）、那段长
`description`、以及 `prompt.sections` 的要点都搬了过来 —— 那些文字是实测记录，不随接口移植丢掉。
**本项目的 manifest 只认 8 个字段**（`id` / `name` / `version` / `apiVersion` / `entry` /
`capabilities` / `tools` / `description`，见 [`docs/PLUGINS.md`](../../qq-agent-plus/docs/PLUGINS.md) §4），
原来的 `category` / `author` / `enabledByDefault` / `permissions` / `requires` / `configSchema` /
`prompt` / `settings` 都不再写进 manifest（本项目不认识，留着只会误导）。

---

## 1. 它做什么

- **按关键词/角色搜图并发出来**。搜索走**内置的公开检索接口**
  （`https://api.lolicon.app/setu/v2`，按 Pixiv 标签检索，**实测大陆可直连 HTTP 200**），
  所以「来张初音ミク的图」这类用法**不用挂梯子**。
- **也可以直接给作品**：群里有人贴了 pixiv 链接就传给 `url`，或直接给 `pid`。
  插件会先尝试用内置接口精确补齐作品元数据和分级。当前内置接口不支持按 PID 查询时，
  没有代理也可以恢复旧的 PID 直取路径，但未知分级只能在当前会话同时允许 `r18` 与 `r18g`
  时发送；默认 `safe` 或只允许 `r18` 的会话仍会拒绝。
- **PID 索引**：发过的作品不会再发第二次（记在插件状态目录的 `state.json`，跨重启保留），
  发图时在会话存档里附带【PID · 标题 · 作者（· ★收藏数）】。
- **取不到图自动换下一张**：搜索接口的索引是旧的，里面可能留着**已被作者删除／限制访问**的作品
  （实测：某 pid 在 `pixiv.re` 和 `i.pixiv.re` 两个域名上都是 404，作品本身没了）。
  每张作品都会先试后端给的原图地址、再试 PID 模板，都失败就自动换下一张备选；
  那种作品会被拉黑一段时间（默认 7 天），同一个关键词再问会换别的图，而不是整个请求失败。
- **多图作品自动打包成一条「聊天记录」**：一个作品最多发 `maxPages` 页（默认 20），页码从 0 连续排、逐页试到取不到为止。宿主有 `chat:send-forward` 能力时打包成**一条卡片**（不刷屏）；没有这个能力、或协议端不支持那个 action 时**回落逐张发**，一张都不丢。`maxPages: 1` 就回到"只发第一张"。
- **大图自动降采样**（2026-10-08 加）：每页下完后就地判，**超过 `downsampleOverBytes`（默认 800KB）
  就用系统 ffmpeg 缩成"最长边 `downsampleMaxEdge`（默认 1200）px 的 JPEG"**，再用缩小的那个文件发。
  动机是**卡片预算**：卡片按"发得动"定在 8MB（`forwardBudgetBytes`），而多图作品的每一页常常
  1~2MB（`regular` 档的 master1200 实测 1.4MB/页）—— 不缩的话 8MB 只装得下几页，
  `maxPages: 20` 仍可能受预算限制。缩完每页约 300KB，8MB 约能装 **20 页**。
  2026-10-08 在服务器上对 5 张真实作品实测（原图 → 缩后）：
  `1288→88KB`、`2044→80KB`、`904→140KB`、`4548→236KB`、`24632→124KB`，
  **均值约 134KB/页 ⇒ 4MB 约能装 30 页**。所以别按"每页 300KB"保守估，
  按**线上日志里真实的「降采样：XKB → YKB」**调 `maxPages`（那才是你这批图的真实值）。
  ffmpeg 是**可选能力**：没装或压缩失败**一律回落原图**，绝不因为压缩失败而丢图
  （用例 `降采样：ffmpeg 起不来时回落原图` 专门盯这条）。启动日志里会写明这台机器有没有 ffmpeg。
- **按会话分级**（全年龄 / R18 / R18G），由 `pixiv_set_rating` 维护，**只有主人能改**。
- **可选：pixiv.net 原生搜索**，元信息更全（**含收藏数**）。但 `www.pixiv.net` 在大陆直连不通，
  且 Node 的 fetch **默认不读 `HTTPS_PROXY`**，所以就算系统挂着梯子也得在设置里填「代理地址」
  才会生效。没配代理时这条路失败一次后会被冷却 10 分钟，免得每次白等一整个超时。

### 原作者的实测记录（一字未改，都很值钱）

1. `www.pixiv.net` 直连拿不到任何响应；
2. `pixiv.re/{pid}.png` 对**部分**作品取图 200，但已删除／受限的作品 404（所以不能只靠它）；
3. `i.pixiv.re` 只认带日期的完整路径，光给 PID 会 404；
4. Bing 国内版完全搜不到 pixiv（被墙站点已剔除索引）；
5. 内置接口返回的 `urls.original` 本身就是 `i.pixiv.re` 的完整路径反代地址，优先用它。

**代价（必须知道）**：内置接口**不返回收藏数**，所以走默认那条路时存档里的 ★ 会缺席。
想要收藏数就把「搜索后端」切成 `pixiv`（需要代理）。

**实现细节**：搜索/取图全部由插件自己发起 —— `i.pximg.net` 强制校验 `Referer`，
而 QQ 协议端下载不会带，所以插件带 Referer 把图下好、落成临时文件再走本地路径发
（顺带把发送 body 从 MB 级降到几十字节）。

---

## 2. 启用

`config.json` 里加上启用与审批快照（`capabilities` 与 `tools` **排序后必须逐字一致**，
宿主就是这么比的）：

```json
{
  "plugins": {
    "enabled": ["pixiv-illust"],
    "approved": {
      "pixiv-illust": {
        "version": "1.6.0",
        "capabilities": ["chat:read", "chat:send-forward", "chat:send-image", "http", "storage"],
        "tools": ["pixiv_image", "pixiv_set_rating"]
      }
    },
    "settings": {
      "pixiv-illust": {
        "ownerIds": "你的QQ号"
      }
    }
  }
}
```

然后重启服务：

```bash
systemctl --user restart qq-agent-linux.service
```

> 不想手抄这份清单就先只写 `enabled: ["pixiv-illust"]`：重启后启动日志与控制台的插件页会告诉你
> 它停在 `pending-approval` 并把待确认清单列出来，照抄即可（`pixiv-illust/test.mjs`
> 也把这套发现流程钉住了）。
>
> ⚠️ **`ownerIds` 一定要填你自己的 QQ 号，否则没人能改分级。**
> 原作者的 manifest 把默认值写成了**他自己的号**（`2624585744`）；照搬那个号是错的 ——
> 实际效果会是「你的号改不了、一个陌生人的号可以改」，而分级意味着"可能往某个群发成人内容"。
> 所以移植后**默认留空**：谁也改不了，工具的拒绝文案会告诉你"请把 QQ 填进「主人 QQ」"。

装载成功的日志长这样：

```
[plugin] 插件：已加载 N 个（工具 M 个）…
[plugin:pixiv-illust] 已激活：状态目录 /…/data/plugin-state/pixiv-illust
```

---

## 3. 设置项（`config.json` → `plugins.settings.pixiv-illust`）

设置是**整体替换**语义（控制台里没写的键会被清空），所以改的时候把要留的键一起写上。
**默认值全部由插件代码兜**（`index.js` 的 `DEFAULTS`），manifest 里不放默认值。

> ⏱ **改完设置要重启服务才生效**：本项目的 `api.config` 是 activate 时刻的**非凭据快照**
> （`plugins/_host/context.js` 的 `buildPluginApi`），不是每次现读的函数。
> 这与宿主控制台"改设置只写配置、回 `restartRequired`"的口径一致。

| 字段 | 类型 | 默认 | label | 说明（原文照录） |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | 启用 Pixiv 来张图 | 关掉后模型看不到这个工具。 |
| `searchBackend` | enum：`auto`/`builtin`/`pixiv` | `auto` | 搜索后端 | `auto`（默认）= 先用内置公开接口（不需要代理），它没结果才回退 pixiv.net。`builtin` = 只用内置接口。`pixiv` = 只用 pixiv.net 原生接口（元信息更全、有收藏数，但需要配代理）。 |
| `loliconApiUrl` | string | `https://api.lolicon.app/setu/v2` | 内置搜索接口地址 | 默认 `https://api.lolicon.app/setu/v2` —— 按 Pixiv 标签检索的公开接口，实测大陆可直连。它不返回收藏数。换成你自己的反代时保持返回同样的 JSON 结构（`data[]` 里含 pid/title/author/tags/r18/urls）。 |
| `excludeAI` | boolean | `false` | 排除 AI 生成的作品 | 默认关。开启后内置接口会过滤掉标记为 AI 生成的插画。 |
| `proxyUrl` | string | `''` | 代理地址（可选） | http(s) 代理，如 `http://127.0.0.1:7890`。**默认 builtin 关键词搜索不需要它**；PID/链接补元数据和 `pixiv.net` 搜索需要它。Clash / v2ray 等一般都开了 HTTP(混合) 端口 —— 注意本插件底层是 undici 的 `ProxyAgent`，**不支持 `socks5://`**。留空会回退读 `HTTPS_PROXY` / `ALL_PROXY` 环境变量。 |
| `searchUrlTemplate` | string | 见 `DEFAULTS` | pixiv.net 搜索地址模板（高级） | 只在使用 pixiv.net 后端时生效。占位符：`{kw}` 关键词(已 URL 编码)、`{page}` 页码。 |
| `imageUrlTemplate` | string | `https://pixiv.re/{pid}.png` | 图片地址模板（**最后兜底**） | `{pid}` 替换成作品号。默认 `https://pixiv.re/{pid}.png` 能用，但 **2026-10-08 实测它 301 重定向到原图** —— 所以它拿到的是十几 MB 的大图，只有前面那些尺寸地址（`imageSize` 那条路）全失败时才轮到它，而且通常会被 `maxImageBytes` 拦掉。⚠️ 别改成 `i.pixiv.re/{pid}.jpg`：那个域名只认带日期的完整路径，光给 PID 会 404（踩过）。 |
| `cookie` | string | `''` | Pixiv Cookie（可选） | 填 `PHPSESSID=xxxx` 可拿到更完整的结果（含收藏数）与成人向内容。留空也能用，只是结果较少。 |
| `userAgent` | string | `''` | User-Agent（可选） | 留空用内置的常见浏览器 UA。Pixiv 对空 UA 会 403。 |
| `poolSize` | number | `5` | 候选池大小 | 按收藏数排序后，从前 N 个里随机挑一个发。默认 5 —— 既不发永远同一张，也不至于发冷门图。 |
| `maxCount` | number | `2` | 一次最多发几张 | 默认 2，上限 5。**这是"几个作品"**，不是"几张图" —— 多图作品每页算同一个作品（见 `maxPages`）。 |
| `maxPages` | number | `20` | 一个作品最多发几页（多图作品） | `1` = 只发第一张（旧行为）。默认最多 20 页；仍受 `pageBudgetMs`、`forwardBudgetBytes` 和宿主合并转发上限约束。⚠️ **续页失败不会影响已经发出去的第一张**，也不会报成"图都没发出去" ✓。 |
| `pageBudgetMs` | number | `100000` | 多图作品续页的时间预算（毫秒） | 默认 100 秒；工具总超时为 120 秒，预留约 20 秒给最后的合并转发。 |
| `forwardBudgetBytes` | number | `8388608`（8MB） | 单个合并转发的图片合计预算 | 宿主上限为 16MB；默认 8MB 约可容纳 20 张经过降采样的图片，实际仍取决于图片大小和协议端。 |
| `ratings` | string[]：`safe`/`r18`/`r18g` | `["safe"]` | 允许的分级（可多选，至少选一个） | 对应 Pixiv 的分级：全年龄=0、R18=1、R18G=2。**可选一个或多个，至少留一个**（空数组会被兜成"全年龄"并告警）。**只有列出来的档才会发出来**：只写 `["safe"]` = 只出全年龄（默认，群聊推荐）；`["safe","r18"]` = 两个都出，R18G 仍被滤掉；`["r18g"]` = **只出 R18G**（连全年龄也不出）。判定来源：pixiv.net 后端直接给分级的 `xRestrict`；内置接口（lolicon）只给一个布尔 `r18`，分不出 R18 与 R18G，所以还会看**作品标签**（`R-18` / `R-18G`）来升级档位。选了任一成人档时，内置接口按 `r18=2`（混合）取回，再在本机精筛到具体档位（日志里能看到每次筛掉多少、哪些档）。⚠️ 成人档还需要：① 内置接口本身能返回成人内容（它默认会过滤）；② 走 pixiv.net 那条路时填 `cookie`。搜到的作品全被分级滤掉时，工具会明确告诉你「这不是没有图」。 |
| `allowR18` | boolean（旧设置） | `false` | 允许 R18（旧设置·已并入上面的多选） | 以前的布尔勾选框，现在改用 `ratings` 多选（可以分开选 R18 与 R18G）。只有在配置里**没有** `ratings` 时才会读它（兼容旧配置）。 |
| `ownerIds` | string | `''`（**必须自己填**） | 主人 QQ（只有 TA 能改分级） | 逗号分隔的 QQ 号。**只有这里的人能改按会话的分级** —— 群主/管理员也不行，这是刻意收紧的：分级意味着「可能往某个群发成人内容」，只该由主人决定。留空 = 谁也改不了（默认值刻意留空：原作者那份把默认值写成了他自己的号，照搬会变成"你的号改不了、陌生人的号可以改"）。本宿主**没有**「主人识别」这第二个判定来源，所以只能靠这个名单。分隔符逗号、中文逗号、顿号、空格都认。 |
| `adminIds` | string（旧字段） | `''` | 管理员 QQ（旧字段·已改名为「主人 QQ」） | 这个字段刚加不久就改名了：现在叫 `ownerIds`，而且权限收紧成**只有主人**能改分级（以前群主/管理员也能改）。为兼容仍会读这里的值（`ownerIds` 为空时才用）。 |
| `stateCap` | number | `2000` | PID 索引上限 | 记住多少个已发过的作品，默认 2000，超出按时间淘汰最旧的。 |
| `retryCandidates` | number | `3` | 额外备选张数 | 默认 3。除了要发的张数，再多准备几张备选：抽到的作品如果已经被作者删了／限制访问（取图 404），就自动换成备选里的下一张，不会让整个请求失败。 |
| `deadTtlDays` | number | `7` | 取不到的作品拉黑天数 | 默认 7 天。取图 404 的作品会被拉黑，避免同一个关键词每次都挑到同一张死图；到期自动放行（作品可能只是临时受限）。网络类失败（超时）不会被拉黑。 |
| `timeoutMs` | number | `15000` | 单次请求超时（毫秒） | 这是单张下载/接口请求的超时；插件工具 `pixiv_image` 的总超时已提高到 120 秒。这个时限覆盖到"读完响应体"，不只是等响应头。 |
| `imageSize` | enum：`original`/`regular`/`small`/`thumb`/`mini` | `regular` | 取图的尺寸档 | **默认不是 `original`，这是 2026-10-08 用真实故障换来的**：接口默认只给 original，而那可能是 **12.5MB**；某些网络（实测阿里云一台国内实例）到 Cloudflare 的链路**搬不动这么大的文件** —— 小请求（搜索接口）1 秒就回，12.5MB 传到一半被重置，报 `fetch failed`。同一个作品换档后：`regular` ≈ 几百 KB、**`small` 只有 39KB**、`thumb` 19KB、`mini` 4KB。取图时会**自动往更小的档回退**（`regular` 传不完就试 `small`、再 `thumb`），所以除非你的网络很好，不建议改成 `original`。 |
| `maxImageBytes` | number | `5242880`（5MB） | 单张图片体积上限 | 超过就**不下载**，直接换下一个候选地址（有 `Content-Length` 就先看大小、一个字节都不下；没有就边读边算、越界即中止）。**它已经不再是"能不能发出去"的边界**：协议端的 HTTP 端点对请求体有 ≈2MiB 硬上限（实测 1.5MB 正常、2MB 起断连），但宿主已把超过 1.5MiB 的调用自动改走 WebSocket 通道（`src/onebot/onebot.js` 的 `HTTP_BODY_SAFE_MAX`），多大都送得出去。所以这里留 5MB 只是因为"给群里发一张 12MB 的图"本身不礼貌；想要原图尽管调大。**注意**：这个值曾被压到 1.3MiB，那是传输层还搬不动大图时的临时对策，已随宿主修复撤掉。⚠️ 它与下面的降采样**不是一回事**：这条管"下不下"，降采样管"下完之后缩不缩"——所以超过这个值的页**依然取不到**，不会"先下来再缩"。 |
| `downsampleOverBytes` | number | `819200`（800KB） | 降采样阈值（字节） | **超过这个大小的图才会被缩**。小图不碰：重编码一遍既费 CPU，又可能越压越大。设为 `0` = **关掉降采样**（永远按原图发）。⚠️ 这条**不在 manifest 里**（本项目 manifest 只认 8 个字段），所以控制台没有控件，要改就在 `config.json` 的 `plugins.settings.pixiv-illust` 里手加，**改完要重启**。 |
| `downsampleMaxEdge` | number | `1200` | 降采样后的最长边（px） | 短边按比例、并取整到偶数（mjpeg 要求）。**只缩不放**（小图永远不会被拉大）。pixiv 的插画多是竖长图，在 QQ 里显示宽度本来就只有屏幕宽，1200px 够看；真实作品实测缩后 80~240KB（见上面 §1 的实测表）。**代价**：动图（GIF/动 WebP）只留第 1 帧；带透明通道的 PNG 会合成到黑底（JPEG 没有 alpha）。 |
| `downsampleQuality` | number | `5` | 降采样 JPEG 质量 | ffmpeg 的 `-q:v`（2 最好 / 31 最差）。默认 5 是"画质与体积的平衡"的经验值（1200px 噪声图约 240KB）。⚠️ 实测**调高它几乎没用**：q:v5 与 q:v2（近无损）在 1200px 下只差 0.3 dB（37.4 vs 37.7），体积却差 46%。要更清晰请调 `downsampleMaxEdge`，不要调这个。 |
| `pageRetryOnce` | number | `1` | 取图瞬时失败重试次数 | 默认 1（每页最多试两次），设 0 关掉，上限夹在 2。**这是 2026-10-08 线上漏发的修复**：这个图床会间歇性卡住（同一地址前两次 200、第三次 20 秒没响应），而"贴链接/给 pid"那条路**每页只有 1 个候选**，那一次卡住就会让**后面所有页一页都没试** —— 实测一个 6+ 页的作品只发出了 2 页。404/410（真的没有这一页）与体积超限**不重试**，所以不会把"作品到此为止"误判成"再试试"。代价：每次重试最坏花掉一整个 `timeoutMs`，与 30 秒取图预算共享。 |

### 按会话的分级覆盖

每个会话可以单独设分级，**本会话覆盖 → 全局 `ratings` → 旧 `allowR18` → 全年龄**。
覆盖存在状态目录的 `chat-ratings.json` 里（形如
`{ "group:123": ["safe"], "private:456": ["safe","r18"] }`），由 `pixiv_set_rating` 工具维护，

查看当前会话实际生效的名单：在对应群聊/私聊中调用 `pixiv_set_rating`（不传 `action` 和 `ratings`），返回的
`now` / `nowText` 就是当前允许的分级。服务器上也可以直接查看
`<数据目录>/plugin-state/pixiv-illust/chat-ratings.json`；其中 `group:<群号>` 和 `private:<QQ号>`
分别对应群聊与私聊覆盖。全局默认值在 `<数据目录>/config.json` 的
`plugins.settings.pixiv-illust.ratings`。
也可以直接改这个文件，**但改完要重启才生效** —— 插件把这份文件缓存在内存里
（`loadChatRatings` 命中缓存就不再读盘），改盘上的文件进程内看不到。
**想让它在不重启的情况下生效，就在那个会话里让机器人改**（走 `pixiv_set_rating` 工具，
那条路会同步更新缓存）。写坏的条目只会被忽略并记一条告警，不影响别的会话。

> 旧 manifest 的 `configSchema` 里有一条 `chatRatingsFile`（label「按会话的分级覆盖
> （技能自己管的文件）」）。它当时也不是一个可填的设置，只是**说明这个文件**；本项目里位置
> 固定为 `<数据目录>/plugin-state/pixiv-illust/chat-ratings.json`（不再平铺在数据目录根下），
> 所以它没有对应的设置项 —— 想手改就直接改那个文件。

---

## 4. 数据落在哪

**插件状态目录**：`<数据目录>/plugin-state/pixiv-illust/`

| 文件 | 内容 |
| --- | --- |
| `state.json` | PID 索引：`{ seen: {pid: 时间戳}, dead: {pid: 拉黑时间戳} }` |
| `chat-ratings.json` | 按会话的分级覆盖 |
| `tmp/` | 下载好的临时图片（发送用），超过 15 分钟的会在下次发图时被清掉 |

三点与原版的差别（都是本项目契约要求的）：

1. 原版把 `state.json` / `chat-ratings.json` 平铺在数据目录根下（`DATA_DIR`），
   而本项目**没有** `src/config.js`（真实路径是 `src/core/config.js`，也不导出 `DATA_DIR`），
   插件的状态只能放自己的状态目录 —— 目录由 `activate` 时从 `api.kv.dir` 注入；
2. 临时图片原来落在 `os.tmpdir()/qq-agent-pixiv`，现在**必须**落在 `<状态目录>/tmp/`：
   门面的 `toolCtx.sendImage({path})` 有一条路径守卫，**只接受插件状态目录之内的文件**
   （`plugins/_host/context.js`）。不设这条守卫，任何插件都能把宿主的 `data/config.json`
   （含明文 API Key 与控制台令牌）当"图片"发到群里。清理逻辑（15 分钟）原样保留。
3. 停用插件**不会删这些数据**。想彻底清掉就连那个目录一起删。

---

## 5. 关于 `http` 能力的如实说明

manifest 里声明了 `http`，但**本插件实际没有走宿主的 fetch 门面**。必须写清楚：

- 它的网络请求是插件自己用**全局 `fetch`**（Node/undici）发出的，走的是
  `await fetch(url, { headers, signal, dispatcher })`，`dispatcher` 是 undici 的 `ProxyAgent`
  （为了支持代理）。两个原因：
  1. 门面的 `toolCtx.fetch` **只回文本**（`plugins/_host/http.js`），而这条链路要拿图片二进制
     （`arrayBuffer`）和响应头里的 `content-type`；
  2. 门面不接受 `dispatcher`（它自己做 DNS 级 SSRF 校验、请求头也有白名单与上限），
     而本插件要靠 `ProxyAgent` 走代理 —— 门面那条路走不通。
- **因此宿主的 SSRF 防护对这条链路不生效**（不拒绝内网/本机地址、不做 DNS rebinding 防护、
  没有门面那套响应体积与重定向上限）。这一点不含糊：这是"要能走代理 + 要拿二进制"换来的代价。
- **它的请求目标全部来自管理员设置与作品 pid，不接受模型给的任意 URL**：
  - 域名只可能是 `loliconApiUrl`、`searchUrlTemplate`、`imageUrlTemplate` 里的主机
    （管理员在 `config.json` 里填的），以及 `proxyUrl`；
  - 模型能给的只有 `keyword`（拼进 `searchParams`，会被 URL 编码）与 `pid` / `url`
    —— 后者先过 `extractPid()`，只认**纯数字**（`^\d{5,12}$`）或 pixiv 系列链接里抠出来的数字串，
    抠不出数字就当作没给，绝不会把模型给的整串当成 URL 去请求。
  - 作品 pid 拼进 `imageUrlTemplate` 前也已被限成纯数字，不构成"任意 URL"。
- 另外两条刻意的请求策略（保留自原作者）：
  - `Referer` 与 `Cookie` **只发给 pixiv 家族域名**（`pixiv.net` / `pximg.net` / `pixiv.re`）：
    把 PHPSESSID 发给第三方接口等于泄露账号凭证，这是安全问题；
  - 非 pixiv 域名遇到 403 时，会换一套"最小请求头"（只留 UA + Accept）重试一次。

如果你不能接受"这个插件的出网不走宿主的 SSRF 防护"，**不要启用它**（或者把它改成走
`toolCtx.fetch`，代价是失去代理支持与图片二进制能力，那这条路就不成立了）。

---

## 6. 与原作者设计的功能性差异（只有这些）

1. **提示词注入没了**。原 manifest 的 `prompt.sections` 会在系统提示词里插一段
   「分级是按会话的、只有主人能改」。本项目**没有提示词注入能力**（插件只贡献工具，
   见 `docs/PLUGINS.md` §14），所以那段指令被**折进 `pixiv_set_rating` 的工具
   `description`** 里 —— 工具描述就是模型能看到的全部信息。这是唯一的功能性差异。
2. **`prompt.sections` 最后那句"主人要的禁言/解禁/踢人：在群里 @你 发对应指令即可"没有搬过来**。
   本项目宿主的系统提示词（`src/llm/prompt.js`）明确要求模型拒绝"管理群（禁言/踢人/改群名片）"
   这类请求并提示"需要管理员在管理端操作" —— 搬过来会与宿主既有规则冲突。
3. **工具名**：`set_rating` → `pixiv_set_rating`（本项目要求工具名全宿主唯一、且要能看出归属）。
4. **能力清单比原始设计多一项 `chat:read`**：`pixiv_set_rating` 要靠"本会话最近一条别人发的
   消息"来确认说话人，门面上这个能力就是 `toolCtx.recent`，而它只在声明了 `chat:read` 时
   才存在（未声明的能力连属性都没有）。不声明它 → 永远认不出说话人 → 分级功能等于死的。
5. **`api.config` 是快照**：改设置要重启（见 §3 的说明）。
6. **主人识别的第二个来源在本宿主里永远失效**：`callerMayChangeRating` 里那段
   `api.capability('message.owner-check', …)` **原样保留**了，但本项目没有 `api.capability`
   这个成员、也没有那个插件，`?.` 会安全短路到"不是主人"（拒绝是安全的一侧）。
   哪天宿主补上同名能力，它会自动生效。

其余全部保留：PID 索引、死图拉黑、按会话分级、分级在挑选**之前**过滤、代理、
备选换图、最小请求头重试、熔断与 pixiv.net 直连冷却、临时文件清理、安全截断（防半个 emoji）。

---

## 7. 排错

| 现象 | 原因 |
| --- | --- |
| 状态停在 `pending-approval` | 审批快照缺失，或 `version`/`capabilities`/`tools` 与审批不一致。照抄控制台给的清单。 |
| 状态是 `invalid` | manifest 本身不合法（`id` 与目录名不一致、`entry` 越界、工具名非法…）。 |
| 状态是 `failed` | 入口 import 或 `activate` 抛错、或注册的工具集与 `tools` 不相等。日志里有原因。 |
| 调过去报"未知工具" | 插件不是 `loaded`。 |
| 「没搜到…」且提示搜索接口连不上 | 网络/配置问题。让对方贴作品链接或直接给 pid（那条路不用搜索接口）。 |
| 「搜到 N 个但全都被分级设置滤掉了」 | 这不是"没有图"。到设置里在 `ratings` 中补上对应档位。 |
| 走 pixiv.net 后端一直超时 | 没配 `proxyUrl`。Node 的 fetch 不读环境变量代理时会被冷却 10 分钟。 |
| 「只有主人能改」 | 说话人的 QQ 不在 `ownerIds` 里（本宿主没有第二个判定来源）。 |
| 日志里「候选地址不可用（原图 12.5MB 超过上限 5.0MB），改试 PID 简写形式」 | **这是正常的回退，不是错误**：后端给的原图太大，插件按 `maxImageBytes` 拒掉它、改用压缩过的简写形式。想让它去下原图就调大 `maxImageBytes`（代价见设置表）。 |
| 异常面板报 `图都没发出去 —— <pid>：fetch failed`（**不是**超时、不是 404） | 传输**中途被重置**：图太大而这条链路搬不完。先确认 `imageSize` 是不是被改成了 `original`（默认 `regular` 不会撞上）；还是不行就再往小调一档（`small` 只有 39KB）。**这不是"网络不通"** —— 搜索接口能返回就说明网是通的。 |
| 图**下下来了**（日志里有「取图成功」）却在发送时报 `fetch failed` | 协议端对 HTTP 请求体有 **2MB** 上限，而图片要 base64（×1.37）再进 JSON body。`maxImageBytes` 的默认值就是照这个换算出来的，正常情况下撞不上；撞上说明它被调大了 —— 调回 `1363148` 左右。**根治要改宿主**（让门面在发送前降采样），插件这边能做的只是"不发"。 |
| 日志里「降采样跳过（这台机器上没有 ffmpeg），按原图 XXXKB 继续」 | **这不是错误**：没装 ffmpeg 就走原图那条路（功能不受影响），只是同样 4MB 的卡片少装几页。想开就 `apt install ffmpeg`（Debian/Ubuntu）或 `dnf install ffmpeg`，装完**最多等 10 分钟**自动恢复（探测结果有 10 分钟缓存），急就重启服务。探测会先试 `PATH` 里的 `ffmpeg`，再试 `/usr/bin`、`/usr/local/bin`、`/bin` 这几个绝对路径 —— 服务的 PATH 比登录 shell 窄也不会误判"没装"。 |
| 日志里「降采样跳过（ffmpeg 退出码 N：…）」 | ffmpeg 在，但这次没成（输入损坏、临时目录满、被杀…）。**图照旧按原图发出去**（绝不丢图）。看那一行里的 ffmpeg 报错；单张偶发可以不管，每次都这样就查磁盘/权限。 |
| 卡片里只装了几页就停了，而 `maxPages` 设了 20 | 按 `forwardBudgetBytes`（默认 8MB）或 `pageBudgetMs`（默认 90 秒）停的。先看启动日志那行 ffmpeg 有没有 —— 没有就是按原图算的，装不了几页；有的话看「降采样：XKB → YKB」那几行实际缩到多大。 |
| 日志里「第 N 页取不到（请求超时：15 秒内没有任何响应），这个作品就发到这里」 | 图床抖了（README 顶部记过：同一作品几分钟前 200、几分钟后没响应）。**默认会重试一次**（`pageRetryOnce`），日志里会先出现一行「瞬时失败（…），400ms 后重试一次」。若重试也失败，作品就到此为止 —— 换一次的图床/换作品会好。裸 pid 那条路每页只有 1 个候选，所以这种中断的概率比带日期路径那条路高。 |
| 日志里「瞬时失败（…），400ms 后重试一次」但**后面还是断了** | 重试用完仍失败。可以把 `timeoutMs` 从 15000 调到 8000：卡住的页更快失败，省下的时间够多试下一页。**别调大** `pageBudgetMs`（它保护工具 60 秒上限）。 |
| 直接给 pid / pixiv 链接时无法确认分级 | 内置接口不支持按 PID 查询；没有代理时会走旧的直取路径，但只有同时允许 `r18` 与 `r18g` 的会话才会发送未知分级作品。普通 `safe` 群聊会拒绝。 |
| 异常面板报「最近 3 次请求都没连上，已暂停取图」 | 熔断器跳闸（连续 3 次连接级失败，停 5 分钟）。注意它只在"这次请求彻底失败"时累加，成功一次就清零；`404` 和"体积超限"都**不计入**。所以反复跳闸通常意味着图一直传不完 —— 按上一条调 `imageSize`。 |
| 每次取图都"整 120 秒超时" | 图床的原图在你这条线路上太大/太慢。先看日志有没有回退记录；没有的话说明**第一候选卡在响应体上**，把 `timeoutMs` 调小（例如 `6000`）能让它更快失败、更快退到简写形式。 |
| 日志里「本会话…有分级覆盖 / 分级过滤」之后没有下文 | 搜索通了，卡在取图。按上面两条排查。 |

---

## 8. 测试

这个插件住在**自建插件仓库**里（安装目录之外），所以宿主代码要另外指：

```bash
# 本机
QQ_AGENT_HOME=D:\QQ-Agent\qq-agent-plus  node --test pixiv-illust/test.mjs
# 服务器（主程序装在 /mnt/data/qq-agent/app 时）
QQ_AGENT_HOME=/mnt/data/qq-agent/app node --test /mnt/data/qq-agent/plugins/pixiv-illust/test.mjs
```

不指 `QQ_AGENT_HOME` 就按"与源码 checkout 平级"猜一次（`../../qq-agent-plus`）；
猜不到就**整体 SKIP**，不会误报一片红。

> 为什么不像别的插件那样把用例放在主仓库的 `test/` 下：它已经搬出主仓库了，CI 扫不到。
> 代价是**这 50 条要手动跑**（`sync-plugins.sh` 不会跑它）。改这个插件之后建议跑一次。

覆盖纯函数（URL 构造、字段映射、分级解析与过滤、挑选与备选、PID 提取、主人名单）、
`latestCaller`（假 `toolCtx.recent()`，含 `self` 过滤）、`callerMayChangeRating` 的放行/拒绝、
状态文件的读写 seam、`describeFetchError` 的可读文案、**取图链路的四类失败**
（体积上限、边读边算、响应体时限、候选回退/硬失败）、**降采样**（阈值、回落、滤镜参数，
以及三条"真压缩"），以及**门面契约**：用假的宿主 ctx + `buildPluginApi` /
`buildPluginToolContext` 跑一遍 `activate`，断言注册的工具名与 manifest 完全一致、
临时目录落在状态目录之内、`toolCtx` 上没有 `store` / `sender` / `emit`。

**降采样那几条用例与 ffmpeg 的关系**（照仓库惯例"缺件跳过"）：

| 用例 | 需要 ffmpeg 吗 | 说明 |
| --- | --- | --- |
| 阈值内不动手 / 滤镜参数 | 不要 | 纯逻辑，永远跑。 |
| ffmpeg 起不来时回落原图 | **不要** | 用假的 spawn 造"启动就失败"，**任何机器都跑** —— 这条是"绝不因压缩失败而丢图"的哨兵。 |
| 探测按退出码判"有没有 ffmpeg" | 不要 | 用的也是假 spawn（这条钉的正是本机踩到的那个坑：`stdio:'ignore'` 下 spawn 一个不存在的可执行文件**不发 `error`**，只以非 0 退出）。 |
| 三条"真压缩" | **要** | 没有就标 SKIP。服务器上装了 ffmpeg（`/usr/bin/ffmpeg`）所以会跑；本机（Windows 开发机）没装，会明确显示为 skipped —— 这不是失败，但也意味着**"真压缩的产物尺寸"只在服务器上验过**。 |

## 9. 住在自建插件仓库里的两个后果

**① 拿不到主程序的依赖。** Node 只往上层目录找 `node_modules`，而
`<插件根>/<id>/` 的上层够不到 `<安装目录>/node_modules`（实测：同一个插件放在
`<安装目录>/plugins/` 下能 `import('undici')`，放到自建根就 `ERR_MODULE_NOT_FOUND`）。

对本插件的具体影响：**只有配了 `proxyUrl` 才会用到 `undici`**（`dispatcherFor` 在
`proxyUrl` 为空时直接返回，根本不 import）。所以：

- 现在（没配代理）：**不受影响** ✓
- 以后要用代理 → 得在这个插件目录里 `npm i undici` 并把 `node_modules` 一起提交，
  否则日志里会出现「代理不可用（…）：Cannot find package 'undici'…本次改直连」
  （它会**如实告警并退回直连**，不会静默）。

**② 不在 CI 覆盖里。** 见第 8 节最后那段。
