# QQ Agent 自建插件

放**不随主程序版本发布**的插件。服务器上把这个仓库 clone 到安装目录**之外**
（例如 `/mnt/data/qq-agent/plugins`），主程序的 `deploy.sh` 就一点都不会碰它 ——
**于是增删改插件都不需要发版本**。

主程序仓库是 [`hjklggfh/qq-agent-plus`](https://github.com/hjklggfh/qq-agent-plus)，
那边的 `plugins/` 是**随版本发布**的那一份（升级时被 rsync 覆盖/合并），不要在这里放同名 id。

---

## 目录规则

```
.
├── README.md                 ← 不会被当成插件（装载器只认子目录里有 plugin.json 的）
├── .gitignore
├── sync-plugins.sh           ← 服务器上跑它 = git pull + 重启
├── my-first-plugin/          ← 一个插件 = 一个目录
│   ├── plugin.json           ← 目录名必须等于这里的 id
│   ├── index.js
│   ├── test.mjs
│   └── README.md
└── pixiv-illust/             ← 从主仓库搬过来的（2026-10-08）：它需要按网络实际情况反复调，
    ├── plugin.json             住在这里之后改它就是 git push + sync-plugins.sh，不用再发版本
    ├── index.js
    ├── test.mjs
    └── README.md
```

`pixiv-illust` 有一条它自己的注意事项：**只有配了 `proxyUrl` 才会用到 `undici`**，
而自建根**拿不到主程序的依赖** —— 配代理前要先在这个插件目录里 `npm i undici`
（详见它的 README 第 9 节）。不配代理时完全不受影响。

**目录名必须等于 `plugin.json` 里的 `id`**（不一致会被直接拒绝）。id 只能是小写字母、
数字、连字符，以字母开头，2~39 位。

## ⚠️ 最要紧的一条限制：拿不到主程序的依赖
本仓库的插件在安装目录之外，而 **Node 只往上层目录找 `node_modules`**：

```
/mnt/data/qq-agent/plugins/my-plugin/index.js   ← 从这里往上找
  /mnt/data/qq-agent/plugins/node_modules
  /mnt/data/qq-agent/node_modules
  /mnt/data/node_modules
  /node_modules                                  ← 都找不到 app/node_modules
```

所以 `import 'undici'` 这类会直接报 `ERR_MODULE_NOT_FOUND`（实测过；同一个插件放到
`<app>/plugins/` 下却能用）。两条出路：

1. **优先零依赖**：`node:fs` / `node:path` / `node:crypto` 这些内置模块随便用，
   `fetch` 是全局的（不用装 undici），网络能力用门面的 `toolCtx.fetch`。
2. **真需要 npm 包**：在那个插件目录里 `npm i --omit=dev`，并把 `node_modules` 一起提交
   （本仓库默认不忽略它）。或者在服务器上 `cd` 进插件目录跑一次 `npm i`。

## 部署（服务器上，只需一次）

```bash
# ① 建插件根（与 app/、data/ 平级）
mkdir -p /mnt/data/qq-agent/plugins

# ② clone 这个仓库进去（私有仓库要先配好凭据，见下）
cd /mnt/data/qq-agent/plugins
git clone <本仓库地址> .

# ③ 在控制台「插件」页 → 插件根 → 编辑插件根，加上 /mnt/data/qq-agent/plugins
# ④ 插件页点「刷新」→ 对要用的插件点「启用」→「确认这份能力」→ 重启服务
```

### 私有仓库在服务器上的凭据（三选一）

| 办法 | 做法 | 说明 |
| --- | --- | --- |
| **Deploy key**（推荐） | 服务器上 `ssh-keygen -t ed25519 -f ~/.ssh/plugin_deploy`，把 `plugin_deploy.pub` 填进仓库 Settings → Deploy keys（**只勾读权限**），clone 用 `git@github.com:<你>/<仓库>.git` | 没有 token 落在文件里，最干净 |
| 细粒度 PAT | 建一个只读、只授权这一个仓库的 token，服务器上 `git config --global credential.helper store`，clone 时用户名随便填、密码填 token | 简单；token 会明文存在 `~/.git-credentials`（0600） |
| 公开仓库 | 什么都不用配 | 插件代码会公开。密钥/设置不在这个仓库里（它们在 `data/config.json`），但你的插件本身会被人看到 |

### 先测一下网络

服务器在国内，`git clone/pull` 到 GitHub 可能不稳。先测：

```bash
git ls-remote https://github.com/<你>/<仓库>.git
```

通不了的话，两个办法：给 git 配代理（`git config --global http.proxy http://127.0.0.1:7890`），
或者改用国内托管（Gitee 之类）—— 这个仓库只需要 `git pull`，放哪都行。

## 日常：改一个插件

```bash
# 本地
vim my-first-plugin/index.js
git add -A && git commit -m "改一下问候语" && git push

# 服务器
cd /mnt/data/qq-agent/plugins && bash sync-plugins.sh
```

`sync-plugins.sh` = `git pull --ff-only` + 列出插件 + 重启服务 + 打一次 `/healthz`。
**注意它会重启服务**（会打断正在进行的一轮对话，OneBot 约 3 秒后重连）。

> 改了插件的 `version` / `capabilities` / `tools` 这三者**任一**，它会回到**待确认**，
> 需要去控制台插件页再点一次「确认这份能力」再重启 —— 这是刻意的：这三样构成"能力指纹"
> （`plugins/_host/manifest.js` 的 `manifestFingerprint`），是"这个插件能给宿主造成多大影响"的
> 全部描述。
>
> ⚠️ **`version` 也在这三者里面**，所以"只改实现、不动能力"时**不要顺手加 `version`** ——
> 加了就要重新确认一次，而能力其实没变。反过来说：只想改实现就把 `version` 留着不动，
> 服务器上 `git pull` + 重启后它会**照常装载，不用重新确认**。
> 真正该加 `version` 的场合是"这次改动值得让人再看一眼"（例如换了取数来源、放宽了限制）。

## 加一个插件

抄 `my-first-plugin/`：它的 `README.md` 第 3 节有一份"改成你自己的"清单，
契约速查在主程序仓库的 `docs/PLUGIN-API.md`。

要点回顾：

- 目录名 = `plugin.json` 的 `id`；
- `tools` 里声明的名字与 `index.js` 里 `registerTool` 的名字**必须完全一致**（多一个少一个，
  整个插件会被拒绝加载）；
- `capabilities` 只声明真的用到的（取值：`chat:send` / `chat:read` / `chat:send-image` /
  `storage` / `http` / `secrets`），**没声明的能力连属性都不存在**；
- 状态写 `toolCtx.kv` 或 `toolCtx.dir`，**别写进插件目录**（升级换代码会丢）；
- 返回值：字符串或 `{ content }` = 成功，`{ error: '原因' }` = 失败。

## 删一个插件

1. 控制台插件页点 **「移除」**（清掉启用/确认/设置三处记录；**不删目录**）。
   要连数据一起删就点「移除并删数据」（不可逆）。
2. 本仓库里删掉那个目录并提交：

```bash
git rm -r --cached my-old-plugin && rm -rf my-old-plugin
git commit -m "删掉 my-old-plugin" && git push
# 服务器：bash sync-plugins.sh
```

> 只删目录而没在控制台移除的话，插件页会显示成 **「找不到」**（配置里还写着启用）。
> 那种残留现在也能直接点「移除」清掉 —— 这正是那个按钮存在的理由。

### 如果这个插件原来住在**主程序仓库**里（搬出来 / 被删掉）

主程序那边删掉了它，**服务器上那份不会被更新删掉** —— `deploy.sh` 对 `plugins/` 用的是
`--filter='protect /plugins/***'`（发送端里有的文件照常更新，**接收端独有的不删**；
这条是刻意的：保护你手动放进 `app/plugins/` 的插件不被更新清掉）。

于是两份同 id 并存：自建根那份**会赢**（`pluginRoots()` 把额外根排在前面），功能正常 ✓，
但每次启动都会留一条误导性的告警 ✗：

```
[plugin] 插件 id xxx 在多个根目录里出现，已忽略 /mnt/data/qq-agent/app/plugins/xxx
```

**手动删一次**就干净了（删了不会回来 —— 仓库里已经没有它了）：

```bash
rm -rf /mnt/data/qq-agent/app/plugins/<插件 id>     # ⚠️ 只删这一个子目录
systemctl --user restart qq-agent-linux
```

> ⚠️ **别删整个 `app/plugins/`** —— 随版本分发的插件（如 `hello`）住在那里，删了就得等下次更新。

## 自测

每个插件都该带自己的测试（主程序的门禁只验主程序的契约，验不到你的插件写对没有）：

```bash
# QQ_AGENT_HOME 指到主程序代码所在目录（安装目录，或源码 checkout）
QQ_AGENT_HOME=/mnt/data/qq-agent/app node --test /mnt/data/qq-agent/plugins/my-first-plugin/test.mjs
```

## 什么时候**必须**回主程序发版本

| 情况 | 要不要发版 |
| --- | --- |
| 用现有六个能力写、增删改插件 | **不用**（就是这个仓库的意义） |
| 插件需要一个**新能力**（消息钩子、定时器、提示词注入、发语音、群管理…） | **要** —— 那要改主程序的 `plugins/_host/capabilities.js` 与 `context.js` |
| 改主程序代码本身 | **要** |
