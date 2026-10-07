# 我的第一个插件（模板）

一个**可以直接装上去跑通**的最小插件，同时也是你后面写自己插件的起点。

它有两个工具：

| 工具 | 演示了什么 |
| --- | --- |
| `counter_bump` | 读设置（`api.config`）+ 持久化状态（`toolCtx.kv`，同步接口）+ 返回值契约（成功回字符串、失败回 `{ error }`） |
| `say_now` | 发消息（`toolCtx.send`）：`chatKey` 由宿主绑死、结果形状 `{ sent, failed }`、参数缺失要回到工具错误 |

它只用**已有的**能力（`storage` + `chat:send`），所以**装它不需要发版本**。

---

## 1. 装上去（四步）

### ① 准备一个"自建根"（只需一次）

放在**安装目录之外**，这样 `deploy.sh` 的 rsync 一点都不会碰它：

```bash
mkdir -p /mnt/data/qq-agent/plugins
```

然后在**控制台 →「插件」页 →「插件根」→「编辑插件根」**里加上 `/mnt/data/qq-agent/plugins`。
（`0.7.10` 起有这个编辑器；更早的版本要手改 `config.json` 的 `plugins.roots`。）

### ② 把本目录传上去

传成 `/mnt/data/qq-agent/plugins/my-first-plugin/` —— **目录名必须等于 `plugin.json` 里的 `id`**。

```bash
# 从你自己的机器上（把 user@host 换成你的）
scp -r my-first-plugin user@host:/mnt/data/qq-agent/plugins/
```

用宝塔/aaPanel 的文件管理器上传也行。如果你把自建插件放在一个**私有 git 仓库**里
（推荐，有版本、能回滚、以后 `git pull` 就更新），服务器上这样拉：

```bash
cd /mnt/data/qq-agent/plugins && git clone <你的私有仓库地址> .
```

### ③ 在插件页刷新并启用

控制台 →「插件」页 → **刷新** → 应该看到 `my-first-plugin`，来源徽标是 **「自建」**，
状态 **未启用** → 点 **启用** → 点 **确认这份能力**（`storage` / `chat:send`，
工具 `counter_bump` / `say_now`）。

### ④ 重启服务

```bash
systemctl --user restart qq-agent-linux
```

起来后插件页那行应变成 **已装载**。然后跟机器人说一句「打个卡」，它应该回
「你好，这是第 1 次被叫到。」；再说一次变 2；**重启服务后再说，应该是 3 而不是 1** ——
那就证明状态真的持久化了。

> 想确认装载日志：`bash manage.sh logs | grep -i plugin | tail -5`，
> 期望看到 `[plugin:my-first-plugin] 已激活…`。

## 2. 设置

控制台 →「插件」页 → 这一行的 **「设置」**：

```json
{ "greeting": "你好", "maxBumps": 10000 }
```

- `greeting`：没给称呼时用的问候语。
- `maxBumps`：计数器上限，到了就回一条错误。

⚠️ 设置是**整体替换**（编辑器上方有提示）：没写进去的键会被清空。
⚠️ 设置是**冷的** —— 改完要重启服务才生效（而凭据 `toolCtx.secret` 是每次调用现读的）。

## 3. 改成你自己的（照着这个清单改）

1. **改 id 与目录名**：`plugin.json` 的 `id` 只能是 `^[a-z][a-z0-9-]{1,38}$`，
   且**必须等于目录名**。两处一起改。
2. **改 `tools` 列表**：写几个工具就列几个，名字用 `^[a-zA-Z0-9_-]{1,64}$`，
   **全宿主唯一**（建议带上自己的前缀，例如 `weather_now` 而不是 `search`）。
   `manifest` 里的工具名与 `activate` 里 `registerTool` 的名字必须**完全一致** ——
   多一个少一个，装载器会拒绝**整个**插件。
3. **改 `capabilities`**：只声明真的用到的。取值只有六个：
   `chat:send` / `chat:read` / `chat:send-image` / `storage` / `http` / `secrets`。
   **没声明的能力连属性都不存在**（用错当场 `TypeError`）。
4. **`execute(toolCtx, args)`**：`toolCtx` 上有什么取决于能力 —— 见
   `docs/PLUGIN-API.md` 第 6 节。它是**收窄门面**：没有 `store`、没有 `sender`、
   没有 `session.sent`。要用宿主能力就走门面。
5. **返回值**：字符串或 `{ content }` = 成功；`{ error: '原因' }` = 失败。
   **成功时别写 `isError: false`**（内置工具不带这个字段）。
6. **状态**：用 `toolCtx.kv`（键值）或 `toolCtx.dir`（自己的目录，临时文件放
   `<dir>/tmp/`）。**别写进插件目录** —— 升级换代码时那份会没。
7. **默认值写在代码里**（像本文件的 `DEFAULTS`），manifest 不放默认值。

改完把 `version` 加一位（`1.0.0` → `1.0.1`）会让它回到**待确认**，需要重新点一次
「确认这份能力」—— 这是刻意的：改了工具或能力就该让人再看一眼。只改描述或超时不会。

## 4. 更新与删除

| 想做什么 | 怎么做 |
| --- | --- |
| 改插件代码 | 覆盖服务器上的目录（`scp -r` 或 `git pull`）→ 重启服务。**不需要发版本** |
| 临时关掉 | 插件页点「停用」→ 重启。数据保留 |
| 彻底移除 | 插件页点「移除」（清掉启用/确认/设置三处记录，**不删目录**），然后自己删目录。要连数据一起删就点「移除并删数据」 |

## 5. 自测

插件也应该带测试 —— 宿主的门禁只验宿主的契约，验不到"你这个插件写对没有"。

```bash
# QQ_AGENT_HOME 指到宿主代码所在目录（安装目录，或源码 checkout）
QQ_AGENT_HOME=/mnt/data/qq-agent/app node --test /mnt/data/qq-agent/plugins/my-first-plugin/test.mjs
```

`test.mjs` 做的事：把本插件**真的装进宿主**（带审批走完整装载流程）、断言工具集合与
manifest 一致、再**真的调用**两个工具，验设置生效、状态落盘、`chatKey` 是宿主绑死的、
参数缺失回到工具错误。不指 `QQ_AGENT_HOME` 时会跳过而不是误报红。

## 6. 契约在哪

- `docs/PLUGIN-API.md` —— **接口速查**：字段与成员清单、能力边界、返回契约、
  「从别的接口迁过来」的逐条对照表、11 个真实的坑。**先看这份。**
- `docs/PLUGINS.md` —— 设计与理由（为什么只有工具、能力快照为什么 fail-closed、
  故障隔离怎么做）。
- 官方示例：仓库里的 `plugins/hello/`（更小）与 `plugins/pixiv-illust/`（更完整，
  含网络请求、代理、二进制下载、按会话设置）。

## 7. 什么时候**必须**发版本

| 情况 | 要不要发版 |
| --- | --- |
| 用现有六个能力写插件、增删改它 | **不用** |
| 插件需要一个**新的能力**（消息钩子、定时器、提示词注入、发语音、群管理…） | **要** —— 那要改宿主的 `plugins/_host/capabilities.js` 与 `context.js` |
| 改宿主代码本身（`src/`、`plugins/`、`ui/`） | **要** |

一个插件要新能力时，正确做法是**先给宿主加那个能力**（发一次版），之后同类插件就随便加了
—— `chat:send-image` 就是这么来的。
