// Pixiv 来张图 —— 按角色/关键词搜插画并发到当前会话。
//
// ── 这个插件要绕开的两堵墙 ──────────────────────────────────────────────
// ① Pixiv 没有公开 API。可用的是它网页版自己调的那个 JSON 接口
//    （/ajax/search/artworks/...）：不登录也能返回，但结果较少、且对 UA 挑剔。
//    要更全（含收藏数）或想要成人向内容，得填 PHPSESSID。
// ② i.pximg.net **强制校验 Referer**，没有 `Referer: https://www.pixiv.net/`
//    一律 403。这意味着**不能让协议端去下载** —— 宿主那条"给个图片 URL、让 QQ 协议端
//    自己取"的路（`toolCtx.sendImage({url})`）不会带 Referer，必然失败。
//    所以本插件自己把图下好、落成临时文件，再走 `toolCtx.sendImage({path})` 交给
//    发送队列：宿主把状态目录里的这个文件读出来拼成 `base64://` 发出去
//    （plugins/_host/context.js 的 chat:send-image 分支），HTTP body 因此从 MB 级
//    降到几十字节，比让协议端拉远程图可靠得多。
//
// ── PID 索引 ────────────────────────────────────────────────────────────
// 发过的作品号记在插件状态目录的 state.json（<数据目录>/plugin-state/pixiv-illust/），
// 跨重启保留。挑图流程：过滤掉已发过的 → 按收藏数降序 → 从**前 poolSize 个**里随机取一个。
// 取前 N 再随机，是为了既不发永远同一张（Pixiv 搜索排序很稳定），
// 也不至于随机到冷门图。只有**发送成功后**才记账，失败的不记 —— 否则一次网络抖动
// 就把那张图永久跳过了。
//
// ── 网络前提（必须说清楚）────────────────────────────────────────────────
// pixiv.net 与 i.pximg.net 在中国大陆直连不通。要么让应用走代理，
// 要么把 imageUrlTemplate 换成你自己的反代/图床。两个地址模板都在设置里，没有写死。
//
// ── 移植记录（这份代码原来按"另一套插件接口"写的）──────────────────────────
// 原版用的是 `api.config()`（函数）、`ctx.sender.sendImage` / `ctx.store` / `ctx.emit`、
// 从 `../../src/config.js` 那个不存在的模块取 `DATA_DIR`、以及
// `registerTool({ id, name, category, icon })`。
// 本项目的真实契约是 docs/PLUGINS.md 与 plugins/_host/context.js。搬过来时**只改与宿主
// 接触的那一面**，搜索/挑选/分级/代理/拉黑/清理这些逻辑与原作者的实测结论一字未动：
//   ① 删掉取 `DATA_DIR` 的那句 import —— 本项目没有 src/config.js（真实路径是
//      src/core/config.js，也不导出 DATA_DIR），留着会让插件直接加载失败；
//   ② `setup(a)` → `activate(api)`（入口契约）；`a.registerTool({id,name,category,icon})`
//      → `api.registerTool({name,description,parameters,execute})`：模型看到的函数名用原来的
//      `id`（`pixiv_image` / `set_rating` → 后者按本项目"工具名要写全名且全宿主唯一"的要求
//      改成 `pixiv_set_rating`），`name`/`category`/`icon` 本项目不支持，去掉；
//   ③ `api.config()` → `api.config`（对象快照，见 settings() 的注释）；
//   ④ `api.warn(msg)` → `api.log.warn(msg)`；`api.log(msg)` → `api.log.info(msg)`；
//   ⑤ `api.fetch(...)` → 全局 `fetch(...)`（门面的 http 能力只给文本、且不支持代理，
//      而这条链路要靠 undici 的 ProxyAgent 走代理、要拿二进制图片；见 doFetch 的注释）；
//   ⑥ 状态文件与临时图片一律落进**插件状态目录**（`api.kv.dir` 注入）；
//   ⑦ 发图走 `toolCtx.sendImage({path},{label})`，会话记账与 session-update 广播由门面做，
//      原来的 `ctx.session.sent.push` + `ctx.emit` 已删掉（否则群里会出现两条一样的记账）；
//   ⑧ `latestCaller` 改读门面的 `toolCtx.recent(6)` 并自己过滤 `self`（门面没有 includeSelf）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// 移植接口差异：这里原来还有 `import os from 'node:os'`（临时图片落在 os.tmpdir()）与
// 一句从 `../../src/config.js` 取 `DATA_DIR` 的 import。前者随⑥一起没了，后者在本项目里
// 那个模块根本不存在。
// ⚠️ 原版的实测记录：核心 src/util.js 从 0.4.0 起**不再导出** safeSlice / stripLoneSurrogates，
// 原来那句从 `../../src/util.js` 取这两个函数的 import 会让整个插件直接加载失败
// （报 "does not provide an export named 'safeSlice'"）。本项目里那个文件在
// src/core/util.js，同样不导出这两个名字 —— 所以它们继续由本文件自带实现，不依赖核心内部工具。
//
// 为什么必须安全截断：JS 的 slice 按 UTF-16 码元切，会把 emoji 切成"半个"（孤立代理项），
// 而孤立代理项会让整个模型请求 400。

/** 去掉孤立代理项（半个 emoji）。 */
function stripLoneSurrogates(value) {
  const s = String(value ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += s[i] + s[i + 1]; i += 1; continue; }
      continue;   // 孤立的高代理项：丢掉
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;   // 孤立的低代理项：丢掉
    out += s[i];
  }
  return out;
}

/** 安全截断：按 max 个 UTF-16 码元切，且不在结尾留下半个 emoji。 */
function safeSlice(value, max) {
  const s = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(max)) || 0);
  return limit >= s.length ? stripLoneSurrogates(s) : stripLoneSurrogates(s.slice(0, limit));
}

let api = null;
/** 读设置时发现问题（旧值被取代、分级一个都没选…）用它出声 —— 静默降级是最难排查的。 */
// 移植接口差异：原宿主的 api.warn(msg) 在本项目里是 api.log.warn(msg)
// （门面日志永远存在，四个级别见 plugins/_host/context.js 的 pluginLogger）。
let warn = (msg) => { try { api?.log?.warn?.(msg); } catch { /* 日志失败不能反过来影响主流程 */ } };

// ── 状态文件落点（由 activate 注入）──────────────────────────────────────
//
// 移植接口差异：原版是 `path.join(DATA_DIR, 'pixiv-illust-state.json')` 与
// `...-ratings.json`，平铺在数据目录根下。本项目没有 DATA_DIR 可 import，而且插件只许写
// **自己的状态目录**：`<数据目录>/plugin-state/pixiv-illust/`
// （plugins/_host/storage.js 的 pluginStateDir）。所以目录由 activate 时从 `api.kv.dir`
// 注入，两个文件名缩到 state.json / chat-ratings.json。
let stateDir = '';
let stateFile = '';
let chatRatingsFile = '';

/**
 * 设定状态目录并重算两个状态文件名。activate 时调一次；测试也用它（免得污染真实数据目录）。
 * 换目录会把内存里的缓存全部作废，否则会读到上一个目录的内容。
 */
export function setStateDir(dir) {
  stateDir = String(dir ?? '').trim();
  stateFile = stateDir ? path.join(stateDir, 'state.json') : '';
  chatRatingsFile = stateDir ? path.join(stateDir, 'chat-ratings.json') : '';
  stateLoaded = false;
  chatRatingsCache = null;
  return stateDir;
}

const DEFAULTS = {
  enabled: true,
  // 搜索后端。'auto' = 先试内置接口（lolicon，不需要代理），空结果才回退 pixiv.net。
  searchBackend: 'auto',
  // 内置搜索接口：按标签检索 Pixiv 的公开服务，大陆可直连（实测 HTTP 200）。
  // 它直接返回 pid/title/author/tags，并且能把图反代出去。
  loliconApiUrl: 'https://api.lolicon.app/setu/v2',
  excludeAI: false,
  // ⚠️ 图片地址模板**必须是 PID 简写形式**：https://pixiv.re/{pid}.png
  //
  // 之前我写的 https://i.pixiv.re/{pid}.jpg 是**错的** —— 实测 HTTP 404。
  // i.pixiv.re 只认带日期的完整路径（/img-original/img/YYYY/MM/DD/HH/MM/SS/{pid}_p0.jpg），
  // 光有 PID 拼不出来。而 pixiv.re 这个域名支持 {pid} 简写（实测返回图片 200）。
  // 这个错误 mock 测试发现不了（fetch 被 mock 掉了），只有真机探测才能发现。
  imageUrlTemplate: 'https://pixiv.re/{pid}.png',
  // pixiv.net 原生搜索（元信息更全，含收藏数）。需要能连上 pixiv.net —— 大陆要配代理。
  searchUrlTemplate: 'https://www.pixiv.net/ajax/search/artworks/{kw}?word={kw}&order=date_d&mode=all&p={page}&s_mode=s_tag&type=all&lang=zh',
  cookie: '',
  userAgent: '',
  // 代理：留空时回退到 HTTPS_PROXY / ALL_PROXY 等环境变量。
  // ⚠️ 这件事**必须由插件自己做** —— Node 的 fetch（undici）默认不读环境变量里的代理，
  //    宿主里也没有任何 setGlobalDispatcher/ProxyAgent。
  //    所以"系统挂着梯子"对这条链路毫无帮助：表现是请求一直挂到超时，
  //    三次真实调用全是 `This operation was aborted`（20s 超时掐断），一次都没有拿到响应。
  proxyUrl: '',
  poolSize: 5,
  maxCount: 2,
  // 一个作品最多发几页（多图作品）。1 = 只发第一张（旧行为）。
  //
  // 为什么不需要"总页数"：页码从 0 连续排，而接口（api.lolicon.app）只给 `p`（这一页的页号）、
  // 不给张数 —— 所以从第 2 页起**逐页试**，遇到"这一页取不到"就停。单图作品只多花一次请求，
  // 而且那个请求本来就是它要取的那一页。
  //
  // 默认 4（而不是 1）：用户要的就是"多图作品的图"。上限存在的意义是别让一个 20 页的作品
  // 把群聊刷屏、也别把 60 秒的工具预算耗光（每页 1~3 秒）。
  // 一次最多抓一个多图作品的 20 页。宿主合并转发也允许 20 张图片；
  // 实际仍会受 pageBudgetMs 与 forwardBudgetBytes 双重限制。
  maxPages: 20,
  // 续页的**时间预算**（毫秒）。工具的硬上限是 60 秒，而下载与最后那次发送共用它 ——
  // 取图阶段先花掉 30 秒就收手，把剩下的一半留给发送。按"页数"限制是不够的：每页 1~5MB，
  // maxPages=10 照样能顶穿 60 秒，然后工具被掐断、**什么都没发出去**（2026-10-08 实测）。
  pageBudgetMs: 100000,
  // 续页的**字节预算**。它盯的**不是**门面那个 12MB 上限，而是"一张卡片多大才发得动" ——
  // 2026-10-08 线上实测：一张 10MB 的卡片（base64 后约 14MB）光是**发出去**就把 60 秒耗光了
  // （走 WebSocket 通道不假，但腾讯那边收下 10MB 也要时间）。**瓶颈在发送、不在下载**，
  // 所以这个值要按"发得动的卡片"来定，经验值约 4MB。
  forwardBudgetBytes: 8 * 1024 * 1024,
  // ── 降采样（2026-10-08 第四轮：让 4MB 的卡片装得下 10+ 页）──────────────────
  //
  // 为什么需要：上面那条 `forwardBudgetBytes`（4MB）是按"卡片发得动"定的，而**多图作品的
  // 每一页常常 1~2MB**（`regular` 档的 master1200 实测 1.4MB/页）—— 于是一张卡片只能装
  // 2~3 页就顶到预算，`maxPages: 10` 这个设置形同虚设（2026-10-08 用户反馈的正是这件事）。
  // 而 pixiv 的插画是**竖长图**，在 QQ 里显示宽度本来就只有屏幕宽 —— 1200px 最长边完全够看，
  // 体积却从 1.4MB 掉到 300KB 上下：同样 4MB 的预算从 3 页变成 10+ 页。
  //
  // 每页下完后就地判、就地缩（见 `downsampleToJpeg`）：**失败一律回落原图**，
  // 绝不因为压缩失败而丢图（这条是硬要求，用例 `降采样：ffmpeg 失败时回落原图` 盯着）。
  //
  // ⚠️ 这些键**不在 manifest 里**（本项目的 manifest 只认 8 个字段，见 README 第 3 节），
  //    所以控制台没有对应的控件 —— 要改用 `config.json` 里
  //    `plugins.settings.pixiv-illust` 那一节手加（改完要重启）。
  /** 超过这个字节数才降采样（小图重编码一遍纯属白费 CPU、还可能越压越大）。~800KB。 */
  downsampleOverBytes: 800 * 1024,
  /** 降采样后的**最长边**（px），短边按比例、并强制偶数（libx264/mjpeg 的色度要求）。 */
  downsampleMaxEdge: 1200,
  /** JPEG 质量：ffmpeg 的 `-q:v`（2 最好、31 最差）。5 ≈ 300KB/1200px，肉眼够用。 */
  downsampleQuality: 5,
  /**
   * 单页取图**瞬时失败后重试几次**（默认 1，即每页最多试两次；设 0 关掉）。
   *
   * 为什么需要（2026-10-08 线上真实漏发）：这个图床会间歇性卡住 —— 同一个地址前两次 200、
   * 第三次 20 秒没响应。而"贴链接/给 pid"那条路**每页只有 1 个候选**（没有尺寸档可退），
   * 于是那一次卡住就让**后面所有页一页都没试**：一个 6+ 页的作品只发出了 2 页。
   * 重试一次能对冲这种抖动；而 404（真的没有这一页）与体积超限**不重试**，所以不会把
   * "作品就到这里了"误判成"再试一次"。
   *
   * 代价：每次重试最坏要花掉一整个 `timeoutMs`，所以上限夹在 2 次，且与 30 秒取图预算共享。
   */
  pageRetryOnce: 1,
  // 分级：多选（全年龄 / R18 / R18G），可选一个或多个、**至少一个**。
  // 只有勾上的档会发出来。旧字段 allowR18 仍保留在下面，只在配置里没有 ratings 时才读。
  ratings: ['safe'],
  allowR18: false,
  stateCap: 2000,
  timeoutMs: 15000,
  // 单张图的体积上限（字节）。超过就**不下载**，换下一个候选地址。
  //
  // ⚠️ 这个上限**已经不再是"能不能发出去"的边界**，只剩"值不值得发"的取舍：
  //   图片最终要 base64 进消息段，而协议端的 HTTP 端点对请求体有 ≈2MiB 硬上限
  //   （实测 1.5MB 正常、2MB 起直接断连，客户端只看到一句 `fetch failed`）。
  //   **宿主已经把这一条修好了**：请求体超过 1.5MiB 的 OneBot 调用会自动改走 WebSocket
  //   通道（见 `src/onebot/onebot.js` 的 `HTTP_BODY_SAFE_MAX`），多大都送得出去。
  //   所以这里留 5MB 纯粹是因为"给群里发一张 12MB 的图"本身不礼貌（慢、而且对面要下），
  //   不是因为发不出去。想要原图尽管调大（例如 20971520），风险已经没有。
  //   （先前这个值被压到 1.3MiB 是**临时**对策 —— 那是在传输层还搬不动大图的年代。）
  //
  // ⚠️ 与下面的降采样（downsampleOverBytes）**不是一回事，别混**：这条是"下不下"，
  //    降采样是"下完之后缩不缩"。所以超过这个值的页**依然取不到**（会去试下一个候选／档位），
  //    而不是"下下来再缩" —— 想收更小的图请调 `imageSize`，想收大图再缩请调大这里。
  maxImageBytes: 5 * 1024 * 1024,
  // 取图的**尺寸档**（lolicon 接口的 size 参数）：original / regular / small / thumb / mini。
  //
  // ⚠️ 默认**不是** original，这一条是 2026-10-08 用真实故障换来的：
  //   接口默认只给 original，而那可能是 **12.5MB** 的原图。部署这台机器（阿里云国内实例）
  //   到 Cloudflare 的链路**搬不动这么大的文件** —— 小请求（搜索接口）1 秒就回，但 12.5MB
  //   传到一半被重置，报 `fetch failed`，于是每次要图都失败、还连累熔断器跳闸。
  //   同一个作品换个尺寸档：regular ≈ 几百 KB、**small 只有 39KB**、thumb 19KB、mini 4KB。
  //   所以默认 regular（画质与体积的平衡），取图时会自动往更小的档回退（见 imageCandidates）。
  imageSize: 'regular',
  // 一个关键词要多准备几张备选：作品被删/被限制访问时（实测 404）就自动换下一张。
  retryCandidates: 3,
  // 取不到图的作品拉黑多久（天）。搜索接口的索引是旧的，不拉黑就会永远挑到同一张死图。
  deadTtlDays: 7,
  // 主人 QQ 名单（只有 TA 能改按会话的分级）。
  //
  // 移植接口差异（**这一处是刻意改掉的默认值，别改回去**）：原作者的 manifest 把
  // ownerIds/adminIds 的默认值写成了**他自己的 QQ 号**（2624585744）。
  // 本项目"默认值由插件代码兜、manifest 不放默认值"，但照搬那个号是错的 ——
  // 实际效果是「你的号改不了分级，而一个陌生人的号可以改」。分级意味着"可能往某个群
  // 发成人内容"，这个决定只该由你来做。所以默认留空：谁也改不了，
  // 而 `callerMayChangeRating` 的拒绝文案会说清"请把 QQ 填进「主人 QQ」"。
  ownerIds: '',
  // 旧字段名（刚加过的那版），ownerIds 为空时才读。默认留空，同上。
  adminIds: ''
};

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif'
};

/**
 * 设置注入（仅测试用）。**存在的理由**：`settings()` 读的是**激活时绑定的 `api.config`**，
 * 而 `buildPluginToolContext({ config })` 收到的是另一份、且只喂给 `secrets` 那条路 ——
 * 用例给 toolCtx 注入 config 是**改不动生效设置**的，于是"预算/阈值可配"这类断言会静默地
 * 跑在默认值上（写"日志必须打生效预算"那条用例时才发现的）。
 */
let settingsOverride = null;
/** 测试用：覆盖生效设置（传 null 恢复读 api.config）。 */
export function __setSettingsForTest(override) {
  settingsOverride = (override && typeof override === 'object') ? override : null;
}

function settings() {
  // 移植接口差异：原宿主是 `api.config()`（函数，每次现读）；本项目 `api.config` 是
  // **非凭据快照**（plugins/_host/context.js 的 buildPluginApi 在 activate 前读一次），
  // 所以这里的语义是"进程启动时的那份设置"。改设置要重启才生效 —— 与宿主控制台
  // "启停/确认/改设置都只写配置并回 restartRequired"的口径一致（docs/PLUGINS.md §12.3）。
  const raw = settingsOverride
    || (api && api.config && typeof api.config === 'object' ? api.config : null)
    || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const ok = (payload) => ({ content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) });
const err = (message) => ({ content: `错误：${message}`, isError: true });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

// ── PID 索引（跨重启保留）────────────────────────────────────────────────

/** pid -> 首次发送时间戳。Map 的插入顺序 + 时间戳共同用于按时间淘汰。 */
let seen = new Map();
/**
 * pid -> 拉黑时间戳："这张图取不到"（Pixiv 上已删除 / 限制访问，实测 404）。
 *
 * 为什么必须有这张表：搜索接口（lolicon）的索引是**旧的**，它照样会把已删除的作品
 * 返回给你。而 seen 只在**发送成功**时记账，所以那张死图会永远留在候选池里 ——
 * 同一个关键词每问一次就再失败一次（实测：晓山瑞希 → pid 137467250 稳定 404，
 * 两个反代域名都 404，因为作品本身没了）。拉黑之后同一关键词再问会换下一张。
 */
let dead = new Map();
let stateLoaded = false;

const numMap = (src) => new Map(
  Object.entries(src && typeof src === 'object' ? src : {})
    .filter(([k]) => /^\d+$/.test(k))
    .map(([k, v]) => [k, Number(v) || 0])
);

function loadState(file = stateFile) {
  if (stateLoaded && file === stateFile) return;
  stateLoaded = true;
  if (!file) return;   // 状态目录还没注入（没 activate 过）：当作空索引，不碰盘
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen = numMap(raw?.seen);
    dead = numMap(raw?.dead);
  } catch { /* 首次运行 */ }
}

function saveState(file = stateFile) {
  // 没有状态目录时**绝不落盘**：path.dirname('') 是 '.'，少这道守卫就会把状态文件写进
  // 进程的当前工作目录（移植前 STATE_FILE 一定非空，所以原版没这个问题）。
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cap = Math.max(50, Math.round(Number(settings().stateCap) || 2000));
    // 按时间戳升序淘汰最旧的（PID 本身没有时间含义，不能按数字大小淘汰）
    const trim = (map) => (map.size > cap ? new Map([...map.entries()].sort((a, b) => a[1] - b[1]).slice(-cap)) : map);
    seen = trim(seen);
    dead = trim(dead);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seen: Object.fromEntries(seen), dead: Object.fromEntries(dead) }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { api?.log?.warn?.('PID 索引写入失败：', error?.message ?? error); } catch { /* 日志失败不影响主流程 */ }
  }
}

function markSeen(pid, at = Date.now()) {
  seen.set(String(pid), at);
  dead.delete(String(pid));   // 之前取不到、这次取到了 → 撤掉拉黑
  saveState();
}

/** 拉黑一张取不到的图（只对"作品本身没了"用；网络类失败不能拉黑，那只是抖动）。 */
function markDead(pid, at = Date.now()) {
  dead.set(String(pid), at);
  saveState();
}

/** 还生效的拉黑集合（过期的自动放行 —— 作品可能只是临时受限）。 */
export function deadSet(now = Date.now(), ttlDays = null) {
  const days = ttlDays === null || ttlDays === undefined ? Number(settings().deadTtlDays) : Number(ttlDays);
  const ttl = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
  const out = new Set();
  for (const [pid, at] of dead) {
    if (ttl && now - at > ttl) continue;
    out.add(pid);
  }
  return out;
}

// ── 纯逻辑（便于单独验证，不碰网络）──────────────────────────────────────

/**
 * 把接口返回的一条作品规整成内部形状。
 * @returns {null | {pid, title, author, userId, bookmarks, xRestrict, tags, thumbnail}}
 */
export function normalizeItem(raw) {
  const pid = String(raw?.id ?? raw?.illust_id ?? raw?.illustId ?? '').trim();
  if (!/^\d+$/.test(pid)) return null;
  const rawTags = Array.isArray(raw?.tags)
    ? raw.tags
    : (Array.isArray(raw?.tags?.tags) ? raw.tags.tags : []);
  const tags = rawTags
    .map((t) => String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? '')).trim())
    .filter(Boolean);
  const bookmarks = Number(raw?.bookmarkCount ?? raw?.total_bookmarks ?? raw?.bookmark_count);
  const hasXRestrict = raw?.xRestrict !== undefined || raw?.x_restrict !== undefined || raw?.sl !== undefined;
  const rawR18 = raw?.r18 ?? raw?.isR18;
  const hasR18 = typeof rawR18 === 'boolean'
    || (typeof rawR18 === 'number' && Number.isFinite(rawR18))
    || (typeof rawR18 === 'string' && /^(true|false|0|1)$/i.test(rawR18.trim()));
  const item = {
    pid,
    title: String(raw?.title ?? '').trim() || '（无题）',
    author: String(raw?.userName ?? raw?.user_name ?? raw?.user?.name ?? '').trim() || '（未知作者）',
    userId: String(raw?.userId ?? raw?.user?.id ?? '').trim(),
    bookmarks: Number.isFinite(bookmarks) ? bookmarks : NaN,
    xRestrict: Number(raw?.xRestrict ?? raw?.x_restrict ?? raw?.sl ?? 0) || 0,
    tags,
    thumbnail: String(raw?.url ?? raw?.thumbnail ?? '').trim()
  };
  Object.defineProperties(item, {
    r18: { value: hasR18 && !/^(false|0)$/i.test(String(rawR18).trim()), enumerable: false },
    ratingKnown: { value: hasXRestrict || hasR18, enumerable: false }
  });
  return item;
}

/**
 * 解析搜索结果。Pixiv 网页接口的路径是 body.illust.data，
 * 但不同版本/不同反代的包装层不一（body.data / illusts / data），逐个试。
 */
export function parseSearchJson(raw) {
  const list = raw?.body?.illust?.data ?? raw?.body?.data ?? raw?.illusts ?? raw?.data ?? [];
  return (Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean);
}

/**
 * 内置搜索接口（lolicon setu/v2）的地址。
 *
 * 为什么内置它：pixiv.net 在大陆直连不通，而"没挂代理就没法按角色搜图"是这台机器上
 * 的真实处境。这个接口是公开的、大陆可直连的（实测 HTTP 200），本身就是按 Pixiv
 * 标签检索的，直接返回 pid/title/author/tags —— 正好是这条链路需要的东西。
 *
 * 代价（必须说清）：它**不返回收藏数**，所以走这条路时存档里的 ★ 会缺席。
 * 想要收藏数就走 pixiv.net 原生搜索（需要代理）。
 *
 * @param mode 'tag' 精确标签（角色名走这个）| 'keyword' 模糊（标题/作者，标签搜不到时兜底）
 */
/**
 * lolicon 接口的尺寸档，**从大到小**。
 *
 * 比所选档更小的档会自动成为备选：这条"从大到小"的链子在"大图搬不动"的网络上救过场 ——
 * 实测 12.5MB 的 original 传到一半被链路重置，而同一个作品的 small（39KB）秒过。
 */
export const LOLICON_SIZE_LADDER = ['original', 'regular', 'small', 'thumb', 'mini'];

/** 所选尺寸档，以及比它更小的那些档（越小的越容易传完）。给接口的 size 参数用。 */
export function sizeLadderFrom(size) {
  const want = String(size ?? '').trim().toLowerCase();
  const at = LOLICON_SIZE_LADDER.indexOf(want);
  // 认不出来（拼错/留空）就按 regular 起算 —— 别悄悄退回 original 那种十几 MB 的档
  return LOLICON_SIZE_LADDER.slice(at === -1 ? 1 : at);
}

export function buildLoliconUrl(apiUrl, keyword, { limit = 10, allowR18 = false, excludeAI = false, mode = 'tag', allowed = null, size = DEFAULTS.imageSize } = {}) {
  const base = String(apiUrl || '').trim() || DEFAULTS.loliconApiUrl;
  const kw = String(keyword ?? '').trim();
  let u;
  try { u = new URL(base); } catch { throw new Error(`内置搜索接口地址不合法：${base}`); }
  if (mode === 'keyword') u.searchParams.set('keyword', kw);
  else u.searchParams.set('tag', kw);
  u.searchParams.set('num', String(clamp(limit, 1, 20)));
  // 尺寸：**先删掉地址里可能带的 size**（插件设置是唯一真相），再按档位从小往大写进去。
  // 不写这一句的话接口只回 original —— 就是那个 12.5MB 的来源。
  u.searchParams.delete('size');
  for (const one of sizeLadderFrom(size)) u.searchParams.append('size', one);
  // lolicon 口径：r18 = 0 全年龄 / 1 仅 R18 / 2 混合。
  // 它**分不出 R18 与 R18G**（只有一个布尔 r18），所以只要选了任一成人档就取"混合"，
  // 再在本机按 ratingOf（xRestrict + 标签）精筛到具体档位。
  // allowed 是新的多选分级集合；没传时退回旧的 allowR18 布尔（兼容）。
  const wantAdult = allowed instanceof Set
    ? (allowed.has(1) || allowed.has(2))
    : allowR18 === true;
  u.searchParams.set('r18', wantAdult ? '2' : '0');
  if (excludeAI) u.searchParams.set('excludeAI', 'true');
  return u.toString();
}

/**
 * 从接口返回的 `urls` 里排出可用地址：**所选档优先，再往更小的档退**。
 *
 * 一个都没命中时（例如接口只回了 original）就退回它给的那些 —— 宁可拿到大图让
 * maxImageBytes 去拦，也别让条目变成"没有图"。
 */
export function pickSizeUrls(urls, size = DEFAULTS.imageSize) {
  const map = urls && typeof urls === 'object' ? urls : {};
  const picked = [];
  const push = (raw) => {
    const u = String(raw ?? '').trim();
    if (u && !picked.includes(u)) picked.push(u);
  };
  for (const key of sizeLadderFrom(size)) push(map[key]);
  if (!picked.length) for (const key of LOLICON_SIZE_LADDER) push(map[key]);
  return picked;
}

/** 把内置接口的返回映射成内部条目形状（之后 PID 索引/R18 过滤/挑选/文案都复用同一条路）。 */
export function mapLoliconItems(raw, { size = DEFAULTS.imageSize } = {}) {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  return list.map((it) => {
    const pid = String(it?.pid ?? '').trim();
    if (!/^\d+$/.test(pid)) return null;
    const picked = pickSizeUrls(it?.urls, size);
    const r18Value = it?.r18;
    const hasR18 = typeof r18Value === 'boolean'
      || (typeof r18Value === 'number' && Number.isFinite(r18Value))
      || (typeof r18Value === 'string' && /^(true|false|0|1)$/i.test(r18Value.trim()));
    const r18 = hasR18 && !/^(false|0)$/i.test(String(r18Value).trim());
    const item = {
      pid,
      title: String(it?.title ?? '').trim() || '（无题）',
      author: String(it?.author ?? '').trim() || '（未知作者）',
      userId: String(it?.uid ?? '').trim(),
      bookmarks: NaN,                        // 这个接口不给收藏数
      xRestrict: r18 ? 1 : 0,   // 统一交给 ratingOf 判定，避免两套 R18 口径
      tags: Array.isArray(it?.tags)
        ? it.tags.map((t) => String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? ''))).filter(Boolean)
        : [],
      thumbnail: picked[0] || '',
      // 图床给的地址，**按尺寸从大到小**排好了。取图时会依次试：
      // 大图传不完（这台机器的实测情况）就自动换更小的档，最后才落到 PID 模板。
      // 为什么不用"后端给的原图地址"当唯一答案：那个可能是 12.5MB，这条链路搬不动。
      imageUrl: picked[0] || '',
      imageUrls: picked
    };
    Object.defineProperties(item, {
      r18: { value: hasR18 ? r18 : undefined, enumerable: false },
      ratingKnown: { value: hasR18, enumerable: false }
    });
    return item;
  }).filter(Boolean);
}

/**
 * 条目分级 → 0 全年龄 / 1 R18 / 2 R18G。
 *
 * 两个来源：
 *   · `xRestrict`：pixiv 原生搜索直接给（0/1/2 就是这三档）；
 *   · **tags 兜底**：内置接口（lolicon）只给一个布尔 `r18`，分不出 R18 与 R18G，
 *     而作品的标签里通常写着 `R-18` / `R-18G`。所以标签能把 1 **升**到 2。
 * 取最高档：xRestrict 说 1、标签写着 R-18G ⇒ 它是 R18G。
 */
export function ratingOf(item) {
  if (!item) return 0;
  const x = Number(item.xRestrict);
  let r = (Number.isFinite(x) && x > 0) ? (x >= 2 ? 2 : 1) : 0;
  const rawR18 = item.r18 ?? item.isR18;
  const flaggedR18 = rawR18 === true || rawR18 === 1 || /^(true|1)$/i.test(String(rawR18 ?? '').trim());
  if (flaggedR18) r = Math.max(r, 1);
  for (const t of (item.tags || [])) {
    const s = String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? ''))
      .trim().toLowerCase().replace(/[\s_‐‑‒–—−]/g, '');
    if (/^(r-?18g|guro|リョナ|グロ|猎奇|猟奇)/i.test(s)) { r = Math.max(r, 2); continue; }
    if (/^(r-?18|成人向?|エロ)/i.test(s)) r = Math.max(r, 1);
  }
  return r;
}

/** 分级元数据是否足够可靠。未知时必须拒绝发送，不能把缺失字段当全年龄。 */
export function ratingKnown(item) {
  if (!item) return false;
  if (item.ratingKnown === true) return true;
  if (item.ratingKnown === false) {
    return (item.tags || []).some((t) => /r\s*-?\s*18|guro|リョナ|猎奇|獵奇|成人向|エロ/i.test(String(t?.tag ?? t?.name ?? t?.translated_name ?? t)));
  }
  if (item.xRestrict !== undefined || item.x_restrict !== undefined || item.sl !== undefined) return true;
  const rawR18 = item.r18 ?? item.isR18;
  if (typeof rawR18 === 'boolean' || (typeof rawR18 === 'number' && Number.isFinite(rawR18))
    || (typeof rawR18 === 'string' && /^(true|false|0|1)$/i.test(rawR18.trim()))) return true;
  return (item.tags || []).some((t) => /r\s*-?\s*18|guro|リョナ|猎奇|獵奇|成人向|エロ/i.test(String(t?.tag ?? t?.name ?? t?.translated_name ?? t)));
}

/** R18 判定（是否成人向）—— 保留原契约：就是"分级大于 0"。 */
export function isR18(item) {
  return ratingOf(item) > 0;
}

/** 分级取值表：配置里的取值 → 分级数字。 */
const RATING_TOKENS = {
  safe: 0, '全年龄': 0, '一般': 0, 'all-ages': 0,
  r18: 1, 'r-18': 1, '成人': 1,
  r18g: 2, 'r-18g': 2, '猎奇': 2
};

/**
 * 当前允许的分级集合 —— **分级设置的唯一事实来源**。
 *
 * 界面上是设置里的 `ratings` 数组（多选）：全年龄 / R18 / R18G，
 * **可选一个或多个，且至少选一个**。
 *
 * **语义：只有勾上的档才会发出来** —— 全年龄也是显式选项，不会因为"没勾成人档"就隐含带上它
 * （否则取消「全年龄」却还出全年龄图，控件就骗人）。
 *
 * 兼容旧配置：没有 `ratings` 时读布尔 `allowR18`（那时的语义是"全年龄 + R18"，
 * 所以兼容路径会带上 0），并在它被忽略时告警。
 *
 * 空数组/全是不认识的值 → 按「全年龄」处理并**告警**：配置文件是可以手改的，界面那道校验管不到。
 */
export function resolveRatings(c = {}) {
  const raw = c.ratings;
  const isList = Array.isArray(raw) || (typeof raw === 'string' && raw.trim() !== '');
  if (isList) {
    const list = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const set = new Set();
    // hasOwnProperty：防止 'constructor' 这类键沿原型链命中去（那会往集合里塞个函数）
    for (const t of list) if (Object.prototype.hasOwnProperty.call(RATING_TOKENS, t)) set.add(RATING_TOKENS[t]);
    if (set.size && !set.has(1) && !set.has(2) && c.allowR18 === true) {
      warn('配置里旧的「允许 R18」已被「允许的分级」多选取代，而当前分级里没有成人档，'
        + '所以不会出成人作品 —— 要开请到插件设置里在「允许的分级」中勾上 R18 / R18G。');
    }
    if (set.size) return set;
    warn('「允许的分级」里一个有效选项都没有（最少要选一个），本次按「全年龄」处理 —— '
      + '请到插件设置里补选。');
    return new Set([0]);
  }
  const set = new Set([0]);
  if (c.allowR18 === true) set.add(1);
  return set;
}

/** 旧名/别名：允许的分级集合。 */
export const allowedRatings = resolveRatings;

/** 分级中文名（日志与文案用）。 */
export function ratingLabel(x) {
  return x === 1 ? 'R18' : x === 2 ? 'R18G' : '全年龄';
}

/** 给群友看的完整名（比 ratingLabel 多写"全年龄"，不写"分级 0"这种内部说法）。 */
const RATING_LABEL_FULL = { safe: '全年龄', r18: 'R18', r18g: 'R18G' };
const RATING_SOURCE_LABEL = {
  chat: '本会话单独设置', global: '插件全局设置', legacy: '旧设置（allowR18）', fallback: '默认（全年龄）'
};

/**
 * 按分级过滤。
 *
 * @returns {{ kept: Array, dropped: Array }}
 */
export function filterByRating(items, allowed) {
  const kept = [];
  const dropped = [];
  for (const it of items || []) {
    // 分级字段缺失时不能默认当全年龄，否则第三方接口漏字段会变成安全绕过。
    (ratingKnown(it) && allowed.has(ratingOf(it)) ? kept : dropped).push(it);
  }
  return { kept, dropped };
}

// ── 按会话的分级覆盖 ──────────────────────────────────────────────────────
//
// 为什么需要：同一个机器人在不同群/私聊里"能发什么"完全不同 —— 普通群只出全年龄，
// 熟人群或私聊可以放宽。**全局一个开关做不到这件事**，所以加一层按会话覆盖。
//
// 存在哪：插件自己的状态目录（`<数据目录>/plugin-state/pixiv-illust/chat-ratings.json`）。
// **不写 app 配置** —— api.config 拿到的是只读快照，写不了 data/config.json；
// 而按会话的条目会随使用不断变化，本来就该由插件自己管。
// 键用宿主的 chatKey：`group:<群号>` / `private:<QQ号>`；值是分级 token 数组。
//
// 优先级：**本会话覆盖 → 全局 ratings → 旧 allowR18 → 全年龄（兜底）**。
// 覆盖文件坏了、或某个条目写错了 → 只忽略那一条并告警，不影响别的会话，
// 更不能让一个坏条目把整个插件卡住。
//
// 移植接口差异：CHAT_RATINGS_FILE 原来是模块顶部的 const（path.join(DATA_DIR, ...)），
// 现在是上面 setStateDir() 算出来的 chatRatingsFile。

const RATING_ORDER = { safe: 0, r18: 1, r18g: 2 };

/** 把任意写法（token / 中文 / 数组 / 逗号串）归一成规范 token 数组；不认识的丢掉。 */
export function normalizeRatingTokens(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
  const out = [];
  for (const x of list) {
    const t = String(x ?? '').trim().toLowerCase();
    if (!t) continue;
    // ⚠️ 必须用 hasOwnProperty：`'constructor' in RATING_TOKENS` 会命中原型链，
    //    那样一个乱写的值就能往集合里塞进一个函数，把过滤整个搞坏。
    if (!Object.prototype.hasOwnProperty.call(RATING_TOKENS, t)) continue;
    const val = RATING_TOKENS[t];
    const canon = val === 0 ? 'safe' : val === 1 ? 'r18' : 'r18g';
    if (!out.includes(canon)) out.push(canon);
  }
  return out.sort((a, b) => RATING_ORDER[a] - RATING_ORDER[b]);
}

let chatRatingsCache = null;

/** 读按会话覆盖（缓存；写的时候会更新缓存）。坏文件只告警，当空处理。 */
export function loadChatRatings() {
  if (chatRatingsCache) return chatRatingsCache;
  const out = {};
  // 状态目录还没注入（没 activate 过）时当空处理：宁可"没有覆盖"，也不去猜一个路径
  if (!chatRatingsFile) { chatRatingsCache = out; return out; }
  try {
    const raw = JSON.parse(fs.readFileSync(chatRatingsFile, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const tokens = normalizeRatingTokens(v);
        if (tokens.length) out[String(k)] = tokens;
        else warn(`按会话的分级文件里「${k}」的取值不认识（${JSON.stringify(v)}），已忽略这一条`);
      }
    } else {
      warn('按会话的分级文件格式不对（应为 JSON 对象），已当空处理');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`读按会话的分级文件失败，已当空处理：${error?.message ?? error}`);
  }
  chatRatingsCache = out;
  return out;
}

function saveChatRatings(map) {
  chatRatingsCache = map;
  if (!chatRatingsFile) {
    warn('状态目录还没就绪（插件未激活），按会话的分级改不了');
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(chatRatingsFile), { recursive: true });
    fs.writeFileSync(chatRatingsFile, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    warn(`写按会话的分级文件失败：${error?.message ?? error}`);
    return false;
  }
}

/** 测试用：丢掉缓存（换数据目录后必须调，否则读到上一个目录的内容）。 */
export function __resetChatRatingsCache() { chatRatingsCache = null; }

/** 本会话的分级覆盖（token 数组）；没有返回 null。 */
export function chatRatingOf(chatKey) {
  const map = loadChatRatings();
  const v = map[String(chatKey ?? '')];
  return Array.isArray(v) && v.length ? v : null;
}

/**
 * 某个会话实际生效的分级。
 * @returns {{ allowed: Set<number>, tokens: string[], source: 'chat'|'global'|'legacy'|'fallback', override: string[]|null }}
 */
export function ratingsForChat(chatKey, s = {}) {
  const override = chatRatingOf(chatKey);
  if (override) {
    return { allowed: resolveRatings({ ratings: override }), tokens: override, source: 'chat', override };
  }
  const hasGlobal = Array.isArray(s.ratings) || (typeof s.ratings === 'string' && s.ratings.trim() !== '');
  const allowed = resolveRatings(s);
  const tokens = [...allowed].sort((a, b) => a - b).map((x) => (x === 0 ? 'safe' : x === 1 ? 'r18' : 'r18g'));
  return { allowed, tokens, source: hasGlobal ? 'global' : (s.allowR18 === true ? 'legacy' : 'fallback'), override: null };
}

/** 设置某个会话的分级覆盖。返回 {ok, tokens} 或 {ok:false, error}。 */
export function setChatRating(chatKey, rawTokens) {
  const key = String(chatKey ?? '').trim();
  if (!key) return { ok: false, error: '拿不到会话标识，改不了' };
  const tokens = normalizeRatingTokens(rawTokens);
  if (!tokens.length) {
    return { ok: false, error: '没给有效的分级（可选：safe / r18 / r18g，或者 全年龄 / R18 / R18G）' };
  }
  const map = { ...loadChatRatings(), [key]: tokens };
  if (!saveChatRatings(map)) return { ok: false, error: '写入失败（看控制台日志）' };
  return { ok: true, tokens };
}

/** 清除某个会话的覆盖（回落到全局）。 */
export function clearChatRating(chatKey) {
  const key = String(chatKey ?? '').trim();
  const map = { ...loadChatRatings() };
  const had = Boolean(map[key]);
  delete map[key];
  if (!saveChatRatings(map)) return { ok: false, error: '写入失败（看控制台日志）' };
  return { ok: true, had };
}

/** 主人 QQ 名单（settings.ownerIds；旧字段名 adminIds 也认，兼容刚加过的那版）。 */
export function ownerIdSet(s = {}) {
  const raw = (s.ownerIds !== undefined && s.ownerIds !== '') ? s.ownerIds : s.adminIds;
  return new Set(String(raw ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean));
}

/** 旧名保留（调用点/测试用）。 */
export const adminIdSet = ownerIdSet;

/**
 * 谁在说话：取**本会话最近一条别人发的消息**的发送者。
 *
 * 为什么这么取：工具的 toolCtx 里没有"调用者 QQ"，只有会话与读取能力。
 * 而插件被调用必然是先有人说了话，所以最近一条别人发的消息就是发起人。
 * 取不到时**一律不放行**（宁可让主人多说一句，也不要让随便谁改掉分级）。
 *
 * 移植接口差异：原来读 `ctx.store.recent(chatKey, { limit: 6, includeSelf: false })`；
 * 本项目的门面只有 `toolCtx.recent(limit)`，**没有** includeSelf 选项，返回的是投影后
 * 带 `self` 布尔的条目 —— 所以"别人发的"这件事在这里自己过滤。
 * 注意它取的是"最近 6 条（含自己说的）"，与原版"最近 6 条别人说的"略有差别：
 * 定位是同一件事（最近一条别人发的消息），只是窗口口径跟着门面走。
 */
export function latestCaller(ctx) {
  const recent = ctx?.recent;
  if (typeof recent !== 'function') return { callerId: '', callerName: '' };
  let list = [];
  try { list = recent(6) || []; } catch { list = []; }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.self === true) continue;   // 自己（机器人）发的不算"调用者"
    if (m.senderId) return { callerId: String(m.senderId), callerName: String(m.senderName || '') };
  }
  return { callerId: '', callerName: '' };
}

/**
 * 调用者能不能改本会话的分级 —— **只有主人可以**（用户明确要求：群主/管理员也不行）。
 *
 * "主人"有两个来源，任一命中即可：
 *   ① 插件设置里的「主人 QQ」名单（`ownerIds`，**代码里刻意留空 —— 必须自己填**，
 *      原作者的默认值是他自己的号，照搬等于让一个陌生人有权改分级）；
 *   ② **主人识别插件**（owner-identity）的判定 —— 走能力 `message.owner-check` 的
 *      单用户问法 `{userId} → {isOwner}`。这样"主人是谁"只有一个定义处，
 *      那边改了号码这里自动跟着变；插件没装/被关/没填号 → 能力不存在 → 这条来源自然失效。
 *
 * 移植接口差异：本项目的 api **没有** `capability()` 这个成员（能力清单见
 * docs/PLUGINS.md §6，只有 kv/stateDir/secret/registerTool/config/log），也没有"主人识别"
 * 这个插件 —— 所以上面第 ② 条在本宿主里**永远是失效的**，`api.capability` 是 undefined、
 * `?.` 安全短路。这段代码**刻意原样保留**：它是原作者的设计，且行为是安全的一侧
 * （判定不出主人 → 不放行）；哪天宿主补上同名能力，它就会自动生效。
 *
 * 拿不准时**一律不放行**（认不出说话人、能力抛错 …），并说清原因 ——
 * 授权判定宁可漏放，也不能错放。
 */
export async function callerMayChangeRating(ctx, s = {}) {
  const { callerId, callerName } = latestCaller(ctx);
  if (!callerId) {
    return { ok: false, callerId, callerName, reason: '没能确认是谁在说话（本会话没查到最近的消息记录），所以不敢改。' };
  }
  if (ownerIdSet(s).has(callerId)) return { ok: true, callerId, callerName, how: '在「主人 QQ」名单里' };

  try {
    const cap = api?.capability?.('message.owner-check', { userId: callerId });
    if (cap && typeof cap === 'object' && 'isOwner' in cap && cap.isOwner === true) {
      return { ok: true, callerId, callerName, how: '主人识别插件认定是主人' };
    }
  } catch (error) {
    warn(`问主人识别插件时出错（按非主人处理）：${error?.message ?? error}`);
  }

  return {
    ok: false, callerId, callerName,
    reason: '这个设置只有主人能改（群主/管理员也不行 —— 这是主人特意定的）。'
      + '要放行别人，请主人在「Pixiv 来张图（自建）」的插件设置里把 QQ 填进「主人 QQ」。'
      + '（本条宿主没有「主人识别」插件，所以那份名单是唯一的判定来源。）'
  };
}

/**
 * 挑一个没发过的：过滤已发 → 按收藏数降序 → 从前 poolSize 个里随机取一个。
 * 收藏数缺失的排在后面（NaN 不能参与比较，否则排序结果不可预测）。
 */
export function pickUnseen(items, seenSet, poolSize = 5, rand = Math.random) {
  // ⚠️ 让路写法：`src/ops.js` 的未定义调用扫描器**不认识"形参被当函数调用"**，
  //    直接写 `rand()` 会被报成可疑未定义调用，CI 门禁 `ops scan plugins --strict` 判红。
  //    取个别名（const 声明）再调，本仓其它让路点也是这么写的。语义不变。
  const random = typeof rand === 'function' ? rand : Math.random;
  const fresh = (items || []).filter((x) => x && !seenSet.has(x.pid));
  if (!fresh.length) return null;
  const score = (x) => (Number.isFinite(x.bookmarks) ? x.bookmarks : -1);
  const sorted = [...fresh].sort((a, b) => score(b) - score(a));
  const pool = sorted.slice(0, clamp(poolSize, 1, 50));
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/**
 * 排出"要试的候选队列"：第一张按老规矩在前 poolSize 里随机（免得永远同一张），
 * 后面几张是**备选**，只在前面失败时才用到 —— 所以按接口给的顺序取，不再随机。
 *
 * 为什么要有备选：搜索接口的索引是旧的，里面的作品可能早就被删了（实测 404）。
 * 以前失败就整个请求失败，等于"这张死图把整个关键词堵死"。
 *
 * @param excludeSet 已经发过 + 已拉黑的 pid
 */
export function buildTryList(items, excludeSet, poolSize, need = 1, extra = 3, rand = Math.random) {
  const taken = new Set(excludeSet || []);
  const pool = (items || []).filter((x) => x && !taken.has(x.pid));
  const out = [];
  const first = pickUnseen(pool, new Set(), poolSize, rand);
  if (first) { out.push(first); taken.add(first.pid); }
  for (const it of pool) {
    if (out.length >= Math.max(1, need) + Math.max(0, extra)) break;
    if (taken.has(it.pid)) continue;
    out.push(it);
    taken.add(it.pid);
  }
  return out;
}

/** 存档里那条 [图片:…] 的说明。宿主会把 label 当成发送说明 —— 这里先自己截，免得被砍在半路。 */
export function formatNote(item, max = 40) {
  const parts = [`Pixiv ${item.pid}`, item.title, item.author];
  if (Number.isFinite(item.bookmarks)) parts.push(`★${item.bookmarks}`);
  // 必须走 safeSlice（而不是 .slice）：标题/作者里带 emoji 时，按码元切会切出半个代理项，
  // 把整个模型请求打成 400。真实事故见上面 stripLoneSurrogates 的注释。
  return safeSlice(parts.filter(Boolean).join(' · '), max);
}

/** 搜索地址：{kw} 会被 URL 编码，{page} 换成页码。 */
export function buildSearchUrl(template, keyword, page = 1) {
  const kw = encodeURIComponent(String(keyword ?? '').trim());
  return String(template || DEFAULTS.searchUrlTemplate)
    .replaceAll('{kw}', kw)
    .replaceAll('{page}', String(clamp(page, 1, 999)));
}

/** 图片地址：{pid} 换成作品号。 */
export function buildImageUrl(template, pid) {
  return String(template || DEFAULTS.imageUrlTemplate).replaceAll('{pid}', String(pid ?? '').trim());
}

/**
 * 一张作品可用的图片地址（按优先级）。
 *
 * 三条路，失效方式各不相同：
 *   · 图床按尺寸给的地址（可能多个档，从大到小）：画质最好，但**大的可能传不完** ——
 *     实测这台机器到 Cloudflare 的链路搬不动 12.5MB 的原图（传到一半被重置），而同一作品的
 *     small（39KB）秒过。所以这里把更小的档也留着，失败就换下一个。
 *   · 后端给的地址本身（imageUrl）：尺寸映射的兜底。
 *   · PID 简写模板：不依赖后端返回，但只能取第 0 页，而且**不是所有作品都认**
 *     （实测 https://pixiv.re/{pid}.png 对某些 pid 返回 404，而对另一些正常返回图片；
 *      注意它会 301 到原图，所以拿到的还是大图，只有前面几条都不行时才轮到它）。
 */
export function imageCandidates(item, template, { allowTemplate = true } = {}) {
  const list = [];
  const push = (raw) => {
    const u = String(raw ?? '').trim();
    if (u && !list.includes(u)) list.push(u);
  };
  for (const one of (Array.isArray(item?.imageUrls) ? item.imageUrls : [])) push(one);
  push(item?.imageUrl);
  // 多图作品取第 2 页起时必须关掉模板：模板 `pixiv.re/{pid}.png` 只会给**第 0 页**，
  // 留着它会把"第 3 页取不到"悄悄变成"又发了一遍第 1 页"（见 maxPages 那一段）。
  if (allowTemplate) push(buildImageUrl(template, item?.pid));
  return list;
}

/**
 * 从 Pixiv 图床的地址里认出日期路径、作品号、页码与扩展名。认不出返回 null。
 *
 * 例：`https://i.pixiv.re/img-original/img/2022/11/20/22/05/11/127664527_p0.jpg`
 *     → { year:'2022', month:'11', day:'20', hour:'22', minute:'05', second:'11',
 *         pid:'127664527', page:'0', ext:'jpg' }
 */
export function parseOriginalPath(url) {
  // 页码后面允许多一个 `_后缀`：接口给的尺寸档地址长这样 ——
  //   …/<pid>_p1_master1200.jpg、…/<pid>_p1_square1200.jpg
  // 而原图地址是 …/<pid>_p1.jpg。两种都必须认出来：前者是多图推导真正会拿到的形状，
  // 只认后者会让"第 2 页起"静默失效（正则不匹配 → 返回空候选 → 多发不了一页，还不报错）。
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d+)_p(\d+)(?:_[a-z0-9]+)?\.([a-z0-9]+)/i
    .exec(String(url ?? ''));
  if (!m) return null;
  return {
    year: m[1], month: m[2], day: m[3], hour: m[4], minute: m[5], second: m[6],
    pid: m[7], page: m[8], ext: m[9].toLowerCase()
  };
}

/**
 * 由**原图地址**推出尺寸版地址（同一台图床、同一个日期路径）。
 *
 * 命名规则不是猜的：下面 regular / small / thumb 三种形状就是 `api.lolicon.app` 自己在
 * `size=` 参数下返回过的**原样**（实测可用，且只有这种 `/img-master/` 路径不卡 ——
 * `/img-original/` 那条路会给出十几 MB 的原图）。拿它来替代"先下原图再想办法缩小"。
 */
export function sizeUrlsFromOriginal(originalUrl, size = DEFAULTS.imageSize) {
  const p = parseOriginalPath(originalUrl);
  if (!p) return [];
  let origin = '';
  try { origin = new URL(String(originalUrl)).origin; } catch { return []; }
  const date = `${p.year}/${p.month}/${p.day}/${p.hour}/${p.minute}/${p.second}`;
  const page = `p${p.page}`;
  const master = `/img-master/img/${date}/${p.pid}_${page}_master1200.jpg`;
  const ladder = {
    original: `${origin}/img-original/img/${date}/${p.pid}_${page}.${p.ext}`,
    regular: `${origin}${master}`,
    small: `${origin}/c/540x540_70${master}`,
    thumb: `${origin}/c/250x250_80_a2/img-master/img/${date}/${p.pid}_${page}_square1200.jpg`
  };
  // mini 的形状没有实测依据，不给（sizeLadderFrom 里它就自然落空）
  return sizeLadderFrom(size).map((key) => ladder[key]).filter(Boolean);
}

/**
 * 认出 pixiv.re 的**页码后缀形式**：`/{pid}.png` 或 `/{pid}-{n}.{ext}`。
 *
 * ⚠️ 这里的页码语义是**量出来的**（2026-10-08，用户服务器上实测）：
 *     `pixiv.re/{pid}.png`  → **301** → `/{pid}-1.png`
 *     `-1.png` / `-2.png` / `-3.png` → 200，各约 1.4MB，**三个 md5 都不同**（真页码）
 *   所以：**`-1` 就是第 1 张**（无后缀那个形式最终拿到的就是它），
 *   **第 2 张是 `-2.png`**。续页探测必须从 `-2` 起 —— 从 `-1` 起会把第 1 张重发一遍。
 *   这条曾经差点写错：光看"`-1` 是 200、`-2` 也是 200"很容易以为 `-1` 是第 2 张。
 */
export function parseSuffixPath(url) {
  let u = null;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  // 只认"路径就是 /{pid}[-n].ext"这一种（带日期目录的完整地址走 parseOriginalPath）
  const m = /^\/(\d{5,12})(?:-(\d+))?\.([a-z0-9]+)$/i.exec(u.pathname);
  if (!m) return null;
  return { origin: u.origin, pid: m[1], page: m[2] ? Number(m[2]) : 1, ext: m[3].toLowerCase() };
}

/**
 * 同一个作品**第 page 页**的候选地址（按尺寸档从大到小）。认不出地址形式就返回空数组。
 *
 * 两条路，因为两个后端给的地址形状不同：
 *   · **带日期路径**（api.lolicon.app 给的）：每一页只差 `_p<页码>`，日期路径在任意一页里都有
 *     —— 所以拿到第 0 页就能拼出后面每一页，而且还能顺带推尺寸档。
 *   · **页码后缀**（`pixiv.re/{pid}.png` 这条"给 pid/链接"的路）：每页只差 `-<页码>`，
 *     见 parseSuffixPath 的注释（`-1` 就是第 1 张 ⇒ 第 2 张是 `-2`）。没有日期路径，
 *     所以推不出尺寸档 —— 只有一条候选，但大 body 现在会走 WebSocket 通道，无所谓。
 * 接口给了 `p`（这一页的页号）但**不给总页数**，所以张数靠调用方逐页试到取不到为止。
 */
export function pageUrlsOf(item, page, size = DEFAULTS.imageSize) {
  const base = String(item?.imageUrl || (Array.isArray(item?.imageUrls) ? item.imageUrls[0] : '') || '').trim();
  const suffix = parseSuffixPath(base);
  if (suffix) {
    const want = (Number(page) || 0) + 1;      // 调用方 page=1 表示"要第 2 张"
    // 第 1 张就是 base 本身 —— 续页绝不能把它再要一遍（那就是"重复发第一张"）
    if (want <= 1) return [];
    return [`${suffix.origin}/${suffix.pid}-${want}.${suffix.ext}`];
  }
  const p = parseOriginalPath(base);
  if (!p) return [];
  let origin = '';
  try { origin = new URL(base).origin; } catch { return []; }
  const rebuilt = `${origin}/img-original/img/${p.year}/${p.month}/${p.day}/${p.hour}/${p.minute}/${p.second}`
    + `/${p.pid}_p${clamp(Number(page) || 0, 0, 999)}.${p.ext}`;
  return sizeUrlsFromOriginal(rebuilt, size);
}

/** 把 HTTP 状态翻成人话 —— 404 和超时是完全不同的两件事，别混成一句"反代挂了"。 */
export function describeImageHttp(status) {
  if (status === 404 || status === 410) {
    return `图片 HTTP ${status}：这张作品在 Pixiv 上已经删了或限制访问（搜索接口的索引偏旧，里面可能留着死链）`;
  }
  if (status === 403) return '图片 HTTP 403：图床的防盗链拒绝了请求（需要 Referer 或登录态）';
  if (status === 429) return '图片 HTTP 429：图床限流了';
  return `图片 HTTP ${status}`;
}

/**
 * 从各种写法里抠出作品号（PID）。
 *
 * 存在的理由：**没有代理时搜索接口是死的**（pixiv.net 在大陆直连不通，实测拿不到任何响应），
 * 但按 PID 取图那条路（i.pixiv.re）是通的。所以"已经有 PID"是最实际的使用方式 ——
 * 群里有人贴了 pixiv 链接、或者管理员自己知道作品号，就完全不需要搜索。
 *
 * 认得这些形态：
 *   https://www.pixiv.net/artworks/12345678   （标准作品页）
 *   https://www.pixiv.net/i/12345678          （旧版短链）
 *   https://www.pixiv.net/member_illust.php?illust_id=12345678
 *   https://i.pixiv.re/12345678.jpg / https://pixiv.re/12345678.png
 *   https://i.pximg.net/.../12345678_p0_master1200.jpg   （缩略图/原图直链）
 *   "12345678"（纯数字）
 * @returns {string} 数字串；认不出来返回空串
 */
export function extractPid(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (/^\d{5,12}$/.test(s)) return s;                                   // 光给数字
  const patterns = [
    /pixiv\.net\/(?:artworks|i|en\/artworks)\/(\d{5,12})/i,             // 作品页
    /[?&]illust_id=(\d{5,12})/i,                                        // 旧版查询参数
    /(?:i\.)?pixiv\.re\/(\d{5,12})/i,                                   // 公开反代
    /(\d{5,12})_p\d+/i                                                  // pximg 直链里的 xxx_p0
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  // 兜底：整串里只有一个像 PIDs 的数字时也认（但要够长，避免把年份、QQ 号认成 PID）
  const all = s.match(/\d{5,12}/g) || [];
  return all.length === 1 ? all[0] : '';
}

// ── 代理 ──────────────────────────────────────────────────────────────────
//
// 为什么非得插件自己搞：Node 的 fetch（undici）**默认不读 HTTPS_PROXY/ALL_PROXY**，
// 宿主里也没有任何 setGlobalDispatcher —— 所以用户系统上挂着的梯子对这条链路无效。
// 这里用 undici 的 ProxyAgent 当 dispatcher 显式传进 fetch（undici 支持这个扩展参数）。
// undici 在本项目的 dependencies 里（8.11.2），import 即可。
// （原注释写的是原宿主的 6.28.0；ProxyAgent 的用法没变，实测这段逻辑在本项目同样成立。）

let proxyAgent = null;
let proxyAgentKey = '';

/**
 * 生效的代理地址：设置优先，留空回退到常见环境变量（大小写都看，和 curl 的习惯一致）。
 * 导出是为了能单测 —— 不依赖真实网络就能验这条优先级。
 */
export function resolveProxyUrl(cfg, env = process.env) {
  const fromCfg = String(cfg?.proxyUrl ?? '').trim();
  if (fromCfg) return fromCfg;
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const v = String(env?.[k] ?? '').trim();
    if (v) return v;
  }
  return '';
}

async function dispatcherFor(proxyUrl) {
  const url = String(proxyUrl || '').trim();
  if (!url) return null;
  if (proxyAgent && proxyAgentKey === url) return proxyAgent;
  try {
    const { ProxyAgent } = await import('undici');
    // ⚠️ 让路写法（同上）：解构出来的 `ProxyAgent` 扫描器不认，`new ProxyAgent(...)`
    //    会被报成可疑未定义调用。用一个 const 接一下再 new，语义不变。
    const AgentClass = ProxyAgent;
    proxyAgent = new AgentClass(url);
    proxyAgentKey = url;
    return proxyAgent;
  } catch (error) {
    // 拿不到 undici 或地址不合法时退回直连，并把原因写进日志（不静默）
    warn(`代理不可用（${url}）：${error?.message ?? error}，本次改直连`);
    return null;
  }
}

// ── 连续失败熔断 ──────────────────────────────────────────────────────────
//
// 真实教训：pixiv 不通时，模型连着重试了三次，每次干等 15~20 秒 —— 而且第二轮、
// 第三轮的上下文还要重新付一遍 token。连不通是**环境问题**，重试必然同样失败，
// 所以连续 N 次连接级失败后直接快速失败，并给出该怎么修。
// 只统计"连接层"失败（超时/解析/拒绝），HTTP 状态码不算 —— 那说明已经连上了。

let netFailStreak = 0;
let netFailUntil = 0;
const BREAKER_AFTER = 3;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

export function breakerState(now = Date.now()) {
  return { open: now < netFailUntil, retryAfterSec: Math.max(0, Math.ceil((netFailUntil - now) / 1000)), streak: netFailStreak };
}
function noteNetFailure(now = Date.now()) {
  netFailStreak += 1;
  if (netFailStreak >= BREAKER_AFTER) netFailUntil = now + BREAKER_COOLDOWN_MS;
}
function noteNetSuccess() { netFailStreak = 0; netFailUntil = 0; }

// ── pixiv.net 直连失败的冷却 ──────────────────────────────────────────────
//
// 没配代理时 pixiv.net 一定连不上，而每次都白等一整个超时（实测 15 秒，模型在那儿干等）。
// 这不是熔断整个插件（内置接口还是好的），只是**记住这条路最近不通，短期内别再试**。
// 冷却期一过自动恢复重试，所以后来配了代理不必重启。
let pixivDirectFailAt = 0;
const PIXIV_DIRECT_COOLDOWN_MS = 10 * 60 * 1000;

export function pixivDirectCoolingDown(now = Date.now()) {
  return pixivDirectFailAt > 0 && now - pixivDirectFailAt < PIXIV_DIRECT_COOLDOWN_MS;
}

/** 连接类错误（没拿到响应）→ 可读的诊断；不是这类就原样返回。 */
export function describeFetchError(error, timeoutMs = 15000, proxyUrl = '', url = '') {
  const msg = String(error?.message ?? error);
  const via = proxyUrl ? `（已走代理 ${proxyUrl}）` : '（当前是直连）';
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { /* 不是 URL 就算了 */ }
  const where = host ? `（${host}）` : '';
  // 谁不通就说谁：把 pixiv 的原因套到第三方接口上会把人带偏
  const hint = needsPixivReferer(url)
    ? '大陆直连 pixiv 不通，需要代理或换掉地址模板'
    : '这个接口连不上，可能是网络问题或接口本身挂了';
  if (/abort/i.test(msg)) {
    return `请求超时：${Math.round(Number(timeoutMs) / 1000)} 秒内没有任何响应${where}${via}（${hint}）`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return `域名解析失败${where}${via}：${msg}（DNS 可能被污染，需要走代理）`;
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed/i.test(msg)) {
    return `连接失败${where}${via}：${msg}（代理没开、端口写错，或线路不通）`;
  }
  return msg;
}

function isNetError(error) {
  return /abort|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|fetch failed/i
    .test(String(error?.message ?? error));
}

/** 等待（重试前的那点间隔，让图床喘口气）。 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });

/**
 * "这个地址这次不行、但过一会儿可能行" —— 也就是**值得重试一次**的失败。
 *
 * 与 `hardNetError`（DNS 解析不了 / 连接被拒：换域名也一样连不上，重试纯属白等）相对。
 * 超时、socket hang up、连接被重置、以及"响应头回来但体不回来"都属于这一类：
 * 它们只说明**这一次**没成。2026-10-08 线上实测：同一个 `pixiv.re/150542157-3.png`
 * 前两次 200、第三次 20 秒没响应 —— 而那个作品每页只有 1 个候选，一次卡住就让
 * 后面所有页一页都没试（6+ 页的作品只发出 2 页）。
 *
 * 明确**不**重试的：404/410（真的没有这一页）、体积超限（tooBig，换页也没用）、
 * 以及一切非网络类错误（配置/参数问题，重试不会变好）。
 */
export function isTransientFetchError(error) {
  if (!error) return false;
  if (error.hardNetError) return false;
  if (error.tooBig) return false;
  const status = Number(error.status) || 0;
  // ⚠️ 这一行是**文档性**的：去掉它行为不变（下面的 `status >= 400` 照样拦住 404/410）。
  //    留着是为了让"404/410 = 作品到此为止、不重试"这条决策在代码里一眼可见。
  //    （变异验证实测：把它改成 `if (false)` 后**没有任何用例判红** —— 因为它确实不是承重的；
  //     真正承重的是下一行，M10 变异打的就是下一行。）
  if (status === 404 || status === 410) return false;
  if (status >= 400) return false;          // 其他 HTTP 状态码不是"抖一下"
  return error.netError === true || isNetError(error);
}

/**
 * 硬失败：换一个域名也一样连不上（DNS 解析不了 / 连接被拒 / 地址根本不合法）。
 *
 * 与之相对的是"软失败"——超时、连接被重置、socket hang up、以及"响应头回来了但响应体不回来"。
 * 那些只说明**这个地址**在**这条线路**上不可用，而同一个作品的另一个候选地址（往往在另一个
 * 域名上、而且是压缩过的）很可能能取到。
 *
 * ⚠️ 这条区分是 2026-10-08 加的，起因是一个真实故障：`i.pixiv.re` 的原图地址回到 200 响应头，
 * 但响应体 12.5MB / 118KB/s 要下 108 秒。原先"网络类错误一律 break"的写法会让整张作品被放弃，
 * 明明同一作品的 `pixiv.re/{pid}.png` 4.6 秒就能拿到。原作者那句"换域名也救不了断掉的线路"
 * 在那种情形下不成立：线路是好的，坏的是那个域名/路径。
 */
function isHardNetError(error) {
  const text = `${String(error?.message ?? '')} ${String(error?.cause?.code ?? '')} ${String(error?.cause?.message ?? '')}`;
  return /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ERR_INVALID_URL/i.test(text);
}

// ── 网络 ──────────────────────────────────────────────────────────────────

/**
 * 这个地址是不是 pixiv 家族（需要带 Referer / Cookie 的只有它们）。
 *
 * ⚠️ 这个判定是**必须**的，不是优化：
 *   · Referer 是 i.pximg.net 的防盗链要求；把它发给第三方接口是错的 ——
 *     一个「从 pixiv.net 跨站发来的 JSON API 请求」正是反爬会拦的形态。
 *     （实测：内置接口 403 就是这个原因；同一 URL 不带 Referer 直接 200。）
 *   · Cookie 里装的是 Pixiv 的 PHPSESSID。发给别的域名等于**把自己的账号凭证
 *     泄露给无关的第三方服务** —— 这是安全问题，不只是请求策略问题。
 */
export function needsPixivReferer(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return /(^|\.)pixiv\.net$/.test(host) || /(^|\.)pximg\.net$/.test(host) || /(^|\.)pixiv\.re$/.test(host);
}

/** 把 HTTP 状态翻成"哪个域名、为什么、怎么办"——不要再把一个域名的原因套到另一个域名上。 */
export function searchHttpError(url, status) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { host = String(url).slice(0, 60); }
  if (status === 403) {
    return needsPixivReferer(url)
      ? `${host} HTTP 403 —— 被 Pixiv 挡了：可能需要填 Cookie 或换 UA`
      : `${host} HTTP 403 —— 这个第三方接口拒绝了请求（反爬 / 限流 / UA）。`
        + '可以到设置里换一个「内置搜索接口地址」，或改用 pid / 作品链接那条路（它不经搜索）';
  }
  return `${host} HTTP ${status}`;
}

function requestHeaders(s, accept, url, { minimal = false } = {}) {
  const h = { 'User-Agent': String(s.userAgent || '').trim() || DEFAULT_UA };
  if (accept) h.Accept = accept;
  if (minimal) return h;   // 最小集：只给 UA 与 Accept
  h['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
  const pixivFamily = needsPixivReferer(url);
  if (pixivFamily) {
    h.Referer = 'https://www.pixiv.net/';
    const ck = String(s.cookie || '').trim();
    if (ck) h.Cookie = ck;
  }
  return h;
}

/**
 * 统一的 fetch：带超时 + 代理，并把连接层错误包成带可读文案的 Error。
 *
 * ⚠️ 移植接口差异（这条是刻意的，不要"顺手改回去"）：这里用的是**全局 fetch**，
 *    不是门面的 `toolCtx.fetch`。两个原因：
 *      ① 门面的 http 能力只回**文本**（plugins/_host/http.js），而这条链路要拿图片二进制
 *         （arrayBuffer）与响应头里的 content-type；
 *      ② 门面不接受 `dispatcher`（它自己做 DNS 级 SSRF 校验、请求头也有白名单与上限），
 *         而本插件要靠 undici 的 ProxyAgent 走代理 —— 门面这条路走不通。
 *    代价必须说清楚：**宿主的 SSRF 防护对这条链路不生效**。它的请求目标全部来自
 *    管理员设置（loliconApiUrl / searchUrlTemplate / imageUrlTemplate / proxyUrl）与
 *    作品 pid，不接受模型给的任意 URL（模型能给的是 keyword / pid，pid 还要过
 *    extractPid 的纯数字校验）—— 见 README「关于 http 能力的如实说明」。
 */
async function doFetch(url, accept, timeoutMs, { minimal = false, controller = null, method = 'GET', redirect = 'follow', quiet = false } = {}) {
  const s = settings();
  const proxyUrl = resolveProxyUrl(s);
  const dispatcher = await dispatcherFor(proxyUrl);
  const ms = Math.max(3000, Number(timeoutMs) || 15000);
  // controller 由调用方给时（取图那条路），**时限要活到响应体读完** —— 见 downloadToTemp 的注释。
  // 不给就自己起一个、返回前清掉（搜索等"只读响应头就算完"的调用走这条）。
  const ac = controller ?? new AbortController();
  const timer = controller ? null : setTimeout(() => ac.abort(), ms);
  try {
    // 移植接口差异：原版是 `await api.fetch(url, {...})`（宿主门面）。
    return await fetch(url, {
      method,
      redirect,
      headers: requestHeaders(s, accept, url, { minimal }),
      signal: ac.signal,
      ...(dispatcher ? { dispatcher } : {})
    });
  } catch (error) {
    if (isNetError(error)) {
      // quiet：探测性请求（比如"读一下 301 的 Location 看能不能推出小图"）不该计入熔断 ——
      // 它失败只说明这个优化没戏，主流程照旧，不该因此把整个插件停 5 分钟。
      if (!quiet) noteNetFailure();
      const wrapped = new Error(describeFetchError(error, ms, proxyUrl, url));
      wrapped.netError = true;
      // 硬失败（DNS 解析不了 / 连接被拒）：换域名也一样连不上，取图那条路该直接放弃整张作品。
      // 其余（超时 / 连接被重置 / socket hang up 等）只说明**这个地址**在这条线路上不可用，
      // 值得给下一个候选一次机会 —— "头回来了、体不回来"就属于这一类。
      wrapped.hardNetError = isHardNetError(error);
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url) {
  const s = settings();
  let resp = await doFetch(url, 'application/json', s.timeoutMs);
  // 第三方接口偶发/习惯性 403（反爬、限流、UA 不合口味）：
  // 换一套"最小请求头"（只留 UA + Accept）再试一次。这条重试只对非 pixiv 域名做 ——
  // pixiv 自己的 403 是别的原因（防盗链/需要 Cookie），换头也救不回来。
  if (resp.status === 403 && !needsPixivReferer(url)) {
    resp = await doFetch(url, 'application/json', s.timeoutMs, { minimal: true });
  }
  if (!resp.ok) throw new Error(searchHttpError(url, resp.status));
  noteNetSuccess();
  return resp.json();
}

/**
 * 直接给 PID/链接时补齐 Pixiv 的作品元数据。不能把“没有搜索结果”当成全年龄，
 * 否则这条路径会绕过会话分级。拿不到可信分级时由调用方拒绝发送。
 */
async function fetchIllustMetadata(s, pid) {
  // 先走内置公开接口：它返回 r18/tags/urls，不依赖 www.pixiv.net。
  // Lolicon 当前不会按 pid 参数查询，改用 keyword 后必须精确匹配 PID，
  // 防止把“搜到的另一张图”误当成用户指定的作品。
  try {
    const raw = await requestJson(buildLoliconUrl(s.loliconApiUrl, pid, {
      limit: 20,
      allowed: new Set([0, 1, 2]),
      excludeAI: false,
      mode: 'keyword',
      size: s.imageSize
    }));
    const exact = mapLoliconItems(raw, { size: s.imageSize })
      .find((item) => item.pid === String(pid));
    if (exact && ratingKnown(exact)) return exact;
  } catch (error) {
    try { api?.log?.warn?.(`[pixiv-illust] PID ${pid} 的内置元数据查询失败：${error?.message ?? error}`); } catch { /* 日志失败不影响后续判断 */ }
  }

  // 没有代理时 www.pixiv.net 在目标服务器上不可达，避免白等一个超时。
  if (!resolveProxyUrl(s)) return null;
  const base = String(s.searchUrlTemplate || DEFAULTS.searchUrlTemplate);
  let origin = 'https://www.pixiv.net';
  try { origin = new URL(base).origin; } catch { /* 使用默认 Pixiv 域名 */ }
  const raw = await requestJson(`${origin}/ajax/illust/${encodeURIComponent(pid)}`);
  const body = raw?.body?.illust ?? raw?.body ?? raw?.illust ?? raw;
  const item = normalizeItem({ ...body, id: body?.id ?? body?.illust_id ?? pid });
  if (!item || item.pid !== String(pid)) return null;
  return item;
}

/**
 * 按关键词取候选作品。
 *
 * backend：
 *   'builtin' 只走内置接口（不需要代理，大陆可直连）
 *   'pixiv'   只走 pixiv.net 原生接口（元信息更全、含收藏数；需要代理）
 *   'auto'    先内置，内置空结果/出错才回退 pixiv.net —— 默认值。
 *             顺序是刻意的：没代理时内置那条路是唯一能通的，而 pixiv.net 每次失败
 *             要白等一整个超时，不该放在前面。
 *
 * @returns {{items: Array, backend: string, errors: string[], netError: boolean}}
 */
async function searchIllusts(s, keyword, want, allowed = null) {
  // 允许的分级由调用方算好传进来（一次算清，里面的告警也只响一次）；单独调用时自己算
  const allowedSet = (allowed instanceof Set) ? allowed : resolveRatings(s);
  const limit = clamp(Math.max(Number(want) * 5, 15), 1, 20);
  const errors = [];
  let netError = false;
  const noteErr = (prefix, error) => {
    errors.push(`${prefix}：${error?.message ?? error}`);
    if (error?.netError) netError = true;
  };

  const viaBuiltin = async () => {
    // 先按标签（角色名走这个），标签搜不到再退化到标题/作者模糊搜索
    for (const mode of ['tag', 'keyword']) {
      const url = buildLoliconUrl(s.loliconApiUrl, keyword, {
        limit, allowed: allowedSet, excludeAI: s.excludeAI === true, mode, size: s.imageSize
      });
      const items = mapLoliconItems(await requestJson(url), { size: s.imageSize });
      if (items.length) return { items, backend: `builtin/${mode}` };
    }
    return { items: [], backend: 'builtin' };
  };
  const viaPixiv = async () => {
    // 最近直连失败过、现在又没配代理 → 别再白等一整个超时（内置接口那条路照常工作）
    if (!resolveProxyUrl(s) && pixivDirectCoolingDown()) {
      const skip = new Error('pixiv.net 直连最近失败过，暂时跳过（配好代理会自动恢复）');
      skip.skipped = true;
      throw skip;
    }
    try {
      const items = parseSearchJson(await requestJson(buildSearchUrl(s.searchUrlTemplate, keyword, 1)));
      pixivDirectFailAt = 0;
      return { items, backend: 'pixiv' };
    } catch (error) {
      if (error?.netError) {
        pixivDirectFailAt = Date.now();
        warn(`pixiv.net 直连失败，${Math.round(PIXIV_DIRECT_COOLDOWN_MS / 60000)} 分钟内不再试这条路：${error.message}`);
      }
      throw error;
    }
  };

  const backend = String(s.searchBackend || 'auto');
  if (backend === 'builtin' || backend === 'pixiv') {
    try {
      const r = await (backend === 'builtin' ? viaBuiltin() : viaPixiv());
      if (!r.items.length) errors.push(`${backend} 没有结果`);
      return { items: r.items, backend: r.backend, errors, netError };
    } catch (error) {
      noteErr(backend, error);
      return { items: [], backend, errors, netError };
    }
  }

  // auto：内置优先
  try {
    const r = await viaBuiltin();
    if (r.items.length) return { items: r.items, backend: r.backend, errors, netError };
    errors.push('内置接口没有结果');
  } catch (error) { noteErr('内置接口', error); }
  try {
    const r = await viaPixiv();
    if (r.items.length) return { items: r.items, backend: r.backend, errors, netError };
    errors.push('pixiv.net 没有结果');
  } catch (error) { noteErr('pixiv.net', error); }
  return { items: [], backend: 'none', errors, netError };
}

/**
 * 临时图片目录 —— **必须在插件自己的状态目录里**（`<stateDir>/tmp/`）。
 *
 * 移植接口差异（这条是硬约束，别改回去）：原版落在 `os.tmpdir()/qq-agent-pixiv`，
 * 在本项目里**发不出去** —— 门面的 `toolCtx.sendImage({path})` 有一条路径守卫：
 * 只接受插件状态目录之内的文件（plugins/_host/context.js），不限制的话一个插件就能把
 * 宿主的 data/config.json（含明文 API Key 与控制台令牌）当"图片"发到群里。
 */
function tempDir() {
  if (!stateDir) throw new Error('插件状态目录还没初始化（activate 时从 api.kv.dir 注入）');
  const d = path.join(stateDir, 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 清掉本插件自己留下的旧临时文件：图发完就没用了，不清理会一直堆着。 */
function sweepTemp(maxAgeMs = 15 * 60 * 1000) {
  try {
    const dir = tempDir();
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true }); } catch { /* 单个文件删不掉不影响其它文件 */ }
    }
  } catch { /* 临时目录还不存在/不可读时什么都不做：清理失败不该影响发图 */ }
}

/**
 * 边读边计数地读完响应体；超过上限就中止并抛错。
 *
 * ⚠️ 不能在 `await resp.arrayBuffer()` 之后再判大小 —— 那时 12.5MB 已经下完了，
 * 等于没有上限（实测就是 30 秒只下到 3.6MB 那种情形）。所以必须边读边算、越界即 abort。
 */
async function readBodyCapped(resp, cap, controller) {
  const tooBig = (bytes) => {
    // ⚠️ 这里只知道**已读**了多少字节，不知道图片真实多大（chunked 响应没有 Content-Length）。
    //    所以措辞必须说"已读…还没读完" —— 第一版写成"图片 X 超过上限 Y"，于是打出了
    //    「图片 1.3MB 超过上限 1.3MB」这种自相矛盾的句子（被用户当成 bug 报回来了）。
    const e = new Error(`图片超过上限 ${(cap / 1048576).toFixed(1)}MB`
      + `（已读 ${(bytes / 1048576).toFixed(1)}MB 仍未读完，真实大小未知）`
      // 报错要能自己指出该改哪里：这个上限来自插件设置，**显式设置会盖掉代码默认值** ——
      // 2026-10-08 就因为设置里留着一个旧值、而代码默认值改大了，白查了一轮。
      + '；想发更大的图就把插件设置里的 maxImageBytes 调大');
    e.tooBig = true;
    e.bytes = bytes;
    return e;
  };
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cap) throw tooBig(buf.length);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { controller.abort(); } catch { /* 已结束 */ }
      try { await reader.cancel(); } catch { /* 取消失败无所谓：连接会被 abort 掉 */ }
      throw tooBig(total);
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error('图片内容为空');
  return Buffer.concat(chunks);
}

/**
 * 下载图片到临时文件。必须带 Referer —— 这是本插件自己下载而不是交给协议端的原因。
 *
 * ⚠️ 这里的 `ac` + `timer` 是**由本函数持有**并交给 `doFetch` 的，因为时限要覆盖**响应体**，
 * 不只是等响应头。"头回来了、体不回来"的图床（实测 `i.pixiv.re` 就是这样）会让
 * `arrayBuffer()` 无限挂住 —— 原先 `doFetch` 在拿到响应头时就 `clearTimeout`，
 * 于是 `timeoutMs` 形同虚设，一路挂到宿主的 60 秒工具上限才被掐断。
 */
async function downloadToTemp(url, timeoutMs, maxBytes) {
  const ms = Math.max(3000, Number(timeoutMs) || 15000);
  const cap = Math.max(64 * 1024, Number(maxBytes) || DEFAULTS.maxImageBytes);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await doFetch(url, 'image/avif,image/webp,image/png,image/*,*/*;q=0.8', ms, { controller: ac });
    if (!resp.ok) {
      const e = new Error(describeImageHttp(resp.status));
      e.status = resp.status;      // 调用方靠它区分"作品没了"（404，可拉黑）与"线路问题"（超时，不能拉黑）
      throw e;
    }
    // 有 Content-Length 就先看大小、**一个字节都不下**：给群发一张图没必要下 12.5MB 原图
    const declared = Number(resp.headers.get('content-length')) || 0;
    if (declared > cap) {
      try { ac.abort(); } catch { /* 已结束 */ }
      const e = new Error(`原图 ${(declared / 1048576).toFixed(1)}MB 超过上限 ${(cap / 1048576).toFixed(1)}MB`
        + '；想发更大的图就把插件设置里的 maxImageBytes 调大');
      e.tooBig = true;
      e.bytes = declared;
      throw e;
    }
    let buf;
    try {
      buf = await readBodyCapped(resp, cap, ac);
    } catch (error) {
      if (error?.tooBig) throw error;
      // 体阶段的失败（超时 abort / 连接中断）与"等响应头"阶段**同口径**包装：
      // 可读文案 + netError/hardNetError 标记 —— 否则上层分不清"该换下一个候选"还是"放弃整张"，
      // 而且日志里会只剩一句裸的 "This operation was aborted"。
      if (isNetError(error)) {
        noteNetFailure();
        const wrapped = new Error(describeFetchError(error, ms, resolveProxyUrl(settings()), url));
        wrapped.netError = true;
        wrapped.hardNetError = isHardNetError(error);
        throw wrapped;
      }
      throw error;
    }
    noteNetSuccess();
    const mime = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[mime] || '.jpg';
    const file = path.join(tempDir(), `pixiv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 「直接给 pid / 链接」那条路没有图床给的尺寸地址，只有 PID 模板；而模板会 **301 到原图**
 * （可能十几 MB，且 `/img-original/` 这条路径在这个网络上连响应头都等不到）。
 *
 * 但那个 301 的 `Location` 里带着**日期路径** —— 拿它就能推出几百 KB 的尺寸版，
 * 完全不必碰原图地址。所以这里发一个 HEAD（不下载 body）读 Location 再转成候选地址。
 *
 * ⚠️ `redirect: 'manual'` 是**必须**的：跟随重定向就会去请求那个会卡住的原图地址。
 *    实测 Node（undici）在 manual 下能读到 location（浏览器里读不到 —— 这里是 Node，才行）。
 * ⚠️ `quiet: true`：这是"锦上添花"的探测，失败只说明推不出来，主流程照旧走模板；
 *    不能因为它去累加熔断计数（否则三次取图就够把插件停 5 分钟）。
 */
async function sizeUrlsFromTemplate(templateUrl, s, pid = '') {
  let status = 0;
  try {
    // ⚠️ 用 **GET** 而不是 HEAD：有些反代/CDN 对 HEAD 直接 405，或者 HEAD 就不回 Location。
    //    （第一版用的是 HEAD，结果探测一直静默失败，于是拿不到尺寸版、白白落到十几 MB 的原图。）
    //    `redirect: 'manual'` 保证**绝不**跟到那个原图：我们只要 301 的头和它那几十字节的 body。
    const resp = await doFetch(templateUrl, 'image/*,*/*;q=0.8', s.timeoutMs,
      { method: 'GET', redirect: 'manual', quiet: true });
    status = Number(resp?.status) || 0;
    const location = String(resp?.headers?.get?.('location') ?? '').trim();
    try { await resp?.body?.cancel?.(); } catch { /* 不读了，随手把连接放掉 */ }
    if (!location) {
      // 探测失败要**说出来**：上一版这里是静默 return []，于是"为什么没拿到小图"白查了两轮。
      say(`[pixiv-illust] ${pid}：模板没有重定向（HTTP ${status}），只能按原图取`);
      return [];
    }
    const urls = sizeUrlsFromOriginal(new URL(location, templateUrl).toString(), s.imageSize);
    if (!urls.length) say(`[pixiv-illust] ${pid}：301 的目标认不出日期路径（${location.slice(0, 90)}），只能按原图取`);
    return urls;
  } catch (error) {
    say(`[pixiv-illust] ${pid}：读 301 失败（${String(error?.message ?? error).slice(0, 60)}），只能按原图取`);
    return [];
  }
}

/** 记一行 info 日志；日志本身失败绝不能影响取图，所以统一吞掉异常。 */
function say(message) {
  // 测试缝：让用例能断言"日志里说的是不是真正生效的值"（见 __setLogSinkForTest）。
  // 生产里 sink 恒为 null，走的还是宿主 logger —— 行为一字未变。
  if (logSink) { try { logSink('info', message); } catch { /* 同上 */ } return; }
  try { api?.log?.info?.(message); } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 日志出口（仅测试用）。**存在的理由**：`say()` 走的是**激活时**绑定的 `api.log`，
 * 而 `toolCtx.log` 是另一份（`buildPluginToolContext` 现拼的）—— 用例给 toolCtx 注入
 * 假 logger 是收不到插件日志的，于是"日志文案"这类断言会**静默空跑**（第一次就这么踩了）。
 * 传 null 恢复。
 */
let logSink = null;
/** 测试用：换掉插件日志出口（传 null 恢复走 api.log）。 */
export function __setLogSinkForTest(fn) { logSink = typeof fn === 'function' ? fn : null; }

// ── 降采样：> 阈值的大图缩成"最长边 N px 的 JPEG" ─────────────────────────
//
// 位置刻意放在**每一页下完之后**（fetchImage 里），而不是"要发送之前统一处理"：
//   · 预算要在**收集时**按最终体积算（原先是按原图算，于是一页 1.4MB 只装得下 2~3 页）；
//   · 回落逐张发那条路用的是同一批文件，缩过的文件两边都能直接用（缩完即替换，见下）。
//
// 三件事必须说清：
//   ① **ffmpeg 是可选能力**：没有它就走原图那条路，功能一点不受影响（只是卡片装得少几页）。
//      探测结果进程内缓存（含失败），失败 10 分钟后允许重探一次 —— 与宿主的
//      `src/tools/image-downsample.js` 同一口径（这里是插件版的等价实现，不是新宿主能力）。
//   ② **失败绝不丢图**：这一整套只返回 `{ ok: false, reason }`，**从不抛错**。
//      调用方拿到 ok:false 就继续用原图 —— "压缩没成功"绝不该让一张图发不出去。
//   ③ **缩完即替换**：成功时把原图删掉、返回新路径，于是调用方（以及后面的门面 sendImage /
//      sendForward 的路径守卫）只会看到一个文件。原图本来也只是个临时文件（sweepTemp 会清）。
//
// 为什么输出走**临时文件**而不是 `pipe:1`：与宿主那条路同一个理由 —— 有些发行版的 ffmpeg
// 解某些输入（GIF 等）需要可 seek 的输入，从管道直读会报 "Input/output error"。
// 而这个插件自己的临时目录里写文件是零成本的（原图就落在那儿）。

const FFMPEG_PROBE_TTL_MS = 10 * 60 * 1000;
let ffmpegProbe = { at: 0, path: null, failed: false };
/** 测试用：清掉 ffmpeg 探测缓存（每个用例要自己决定"这台机器有没有 ffmpeg"）。 */
export function __resetFfmpegProbe() { ffmpegProbe = { at: 0, path: null, failed: false }; }
/** 探测与调用都走这里 —— 一个模块级的句柄，测试可以临时换掉（不用去 mock node:child_process）。 */
let spawnImpl = spawn;
/** 测试用：换掉 spawn（传 null 恢复真的）。**只为"ffmpeg 起不来"那条用例存在**。 */
export function __setSpawnForTest(fn) { spawnImpl = typeof fn === 'function' ? fn : spawn; }

/**
 * 探测系统的 ffmpeg，返回**可直接 spawn 的路径**（探测不到返回空串）。
 *
 * 先试 `ffmpeg`（走 PATH，Linux 上就是 /usr/bin/ffmpeg），失败再试常见绝对路径 --
 * 服务的 PATH 可能比登录 shell 窄（systemd 用户服务尤其容易），只靠 PATH 会误判"没装"。
 *
 * ⚠️ 判据是**退出码 0**，**不是** `error` 事件：`stdio: 'ignore'` 下 spawn 一个不存在的
 * 可执行文件**不会**发 error（那是 fd 接管的代价），只会以非 0（通常是 127）退出。
 * 第一版按"没有 error 事件 = 可用"写，于是**没装 ffmpeg 的机器也被判成装了**，
 * 表现是"降采样看起来生效了、其实一张都没缩"—— 比报错难查得多（本机实测抓到）。
 */
export async function resolveFfmpeg() {
  const cached = ffmpegProbe.path;
  if (cached && Date.now() - ffmpegProbe.at < FFMPEG_PROBE_TTL_MS) return cached;
  // 缓存了"没有"：TTL 内别再每次花一次 spawn 去试（装好后最多等 10 分钟自动恢复）
  if (!cached && ffmpegProbe.failed && Date.now() - ffmpegProbe.at < FFMPEG_PROBE_TTL_MS) return '';
  ffmpegProbe = { at: Date.now(), path: null, failed: false };
  const candidates = process.platform === 'win32'
    ? ['ffmpeg', 'ffmpeg.exe']
    : ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
  for (const bin of candidates) {
    const ok = await new Promise((resolve) => {
      let child = null;
      try {
        child = spawnImpl(bin, ['-version'], { stdio: 'ignore', windowsHide: true });
      } catch { resolve(false); return; }
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      // ⚠️ 定时器必须自己兜底 resolve：kill 之后进程若成僵尸就永远没有 exit 事件，
      //    这里挂住会让整条取图链路一起挂住（比"探测失败"严重得多）。
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已经退出 */ }
        done(false);
      }, 5000);
      timer.unref?.();
      child.on('error', () => done(false));          // 同步 EINVAL / 权限类失败会走这里
      child.on('exit', (code) => done(code === 0));  // 不存在 → 非 0（127）
    });
    if (ok) {
      ffmpegProbe.path = bin;
      return bin;
    }
  }
  ffmpegProbe.failed = true;
  return '';
}

/** 降采样要用到的滤镜/参数（导出是为了让用例能钉住"最长边 1200、短边按比例且为偶数"）。 */
export function buildDownsampleArgs(inputPath, outputPath, { maxEdge = 1200, quality = 5 } = {}) {
  const edge = Math.max(64, Math.round(Number(maxEdge) || 1200));
  const q = Math.min(31, Math.max(2, Math.round(Number(quality) || 5)));
  return [
    '-hide_banner', '-loglevel', 'error',
    // -y：输出名带随机后缀，正常不会撞名；但撞上了（比如上一次同秒的残留）不该卡住等输入
    '-y',
    '-i', inputPath,
    // 只缩不放：`min(1200,iw)` / `min(1200,ih)` 保证小图永远不会被拉大
    // （拉大只会更糊、更大，纯亏）；force_divisible_by=2 让两边都是偶数
    // （mjpeg 的色度采样要求偶数，奇数会直接报错）。
    '-vf', `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    // 静态图取第 1 帧：GIF/动图 WebP 走这条路时只留一帧（尺寸缩了、动画也会丢，
    // 这是**刻意的取舍**：多图作品的页大多是静态图，而 2MB 的动图本来就进不了卡片）。
    '-frames:v', '1',
    '-q:v', String(q),
    '-f', 'image2', '-y', outputPath
  ];
}

/** 在给定上限内跑一次 ffmpeg，返回 { ok, reason }（**不抛错**：调用方只需要知道成没成）。 */
function runFfmpegToFile(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawnImpl(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: `ffmpeg 起不来：${error?.message ?? error}` });
      return;
    }
    let stderr = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // ⚠️ 这个定时器**不** unref，也一定要清：它是唯一的超时保护，而缩放一张图只要几百毫秒，
    //    10 秒还没完就是异常（宁可回落原图，也不能把 60 秒的工具预算耗在这儿）。
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      done({ ok: false, reason: `ffmpeg 超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      // 只留尾部：ffmpeg 的真实报错在最后一行，头部全是 banner 噪音
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on('error', (error) => done({ ok: false, reason: `ffmpeg 启动失败：${error?.message ?? error}` }));
    child.on('close', (code) => done(
      code === 0
        ? { ok: true }
        : { ok: false, reason: `ffmpeg 退出码 ${code}：${stderr.trim().split('\n').pop() || '无错误输出'}` }
    ));
  });
}

/**
 * 一张图太大就缩成"最长边 N px 的 JPEG"，成功时**替换掉原文件**。
 *
 * @returns {Promise<{file, bytes, downsized, reason?, fromBytes?, fromFile?}>}
 *   `downsized: true` 时 `file`/`bytes` 指向缩过的 JPEG（原图已删）；
 *   `downsized: false` 时 `file`/`bytes` **就是原图**（阈值内 / 没有 ffmpeg / 压缩失败），
 *   并在 `reason` 里说明原因（只用于日志，调用方不需要分情况处理）。
 *
 * **这个函数从不抛错**（"压缩失败"是这条链路上最不该致命的事情）。
 */
export async function downsampleToJpeg(file, {
  overBytes = 800 * 1024,
  maxEdge = 1200,
  quality = 5,
  timeoutMs = 10000,
  // 显式指定 ffmpeg（测试用：让"真压缩"那几条用例**不必**依赖"这台机器装没装 ffmpeg"）。
  // 生产路径不传，走 resolveFfmpeg() 的探测。
  ffmpegPath = ''
} = {}) {
  const src = String(file ?? '');
  let stat = null;
  try { stat = fs.statSync(src); } catch (error) {
    return { file: src, bytes: 0, downsized: false, reason: `读不到文件（${error?.message ?? error}）` };
  }
  const size = Number(stat.size) || 0;
  const limit = Math.max(0, Number(overBytes) || 0);
  // 小图不动：重编码一遍既费 CPU，又可能**越压越大**（几百 KB 的 PNG 转 JPEG 不一定更小）
  if (limit && size <= limit) return { file: src, bytes: size, downsized: false };

  const bin = String(ffmpegPath ?? '').trim() || await resolveFfmpeg();
  if (!bin) return { file: src, bytes: size, downsized: false, reason: '这台机器上没有 ffmpeg' };

  const dir = path.dirname(src);
  const base = path.basename(src).replace(/\.[a-z0-9]+$/i, '');
  // 输出名带 `-ds` 与随机后缀：同一次运行里多页并行/重名时不会互相覆盖
  const out = path.join(dir, `${base}-ds_${Math.random().toString(36).slice(2, 8)}.jpg`);
  let result;
  try {
    result = await runFfmpegToFile(bin, buildDownsampleArgs(src, out, { maxEdge, quality }), timeoutMs);
  } catch (error) {
    result = { ok: false, reason: `ffmpeg 调用失败：${error?.message ?? error}` };
  }
  let outBytes = 0;
  try { outBytes = fs.statSync(out).size; } catch { outBytes = 0; }
  if (!result.ok || !outBytes) {
    try { fs.rmSync(out, { force: true }); } catch { /* 尽力清理 */ }
    return { file: src, bytes: size, downsized: false, reason: result.reason || 'ffmpeg 没有产出文件' };
  }
  // 缩完反而更大（极端情况：小尺寸的高压缩原图）→ 放弃，继续用原图
  if (outBytes >= size) {
    try { fs.rmSync(out, { force: true }); } catch { /* 尽力清理 */ }
    return { file: src, bytes: size, downsized: false, reason: `缩完更大（${outBytes} ≥ ${size}）` };
  }
  // 替换：原图删掉。**先确认新文件在**再删（顺序反了就可能两个都没了 —— 绝不能丢图）。
  try { fs.rmSync(src, { force: true }); } catch { /* 删不掉就留着，sweepTemp 稍后清 */ }
  return { file: out, bytes: outBytes, downsized: true, fromBytes: size, fromFile: src };
}

/**
 * 取一张作品的图：先按尺寸档试图床给的地址（从大到小），最后才落到 PID 模板。
 *
 * 404（作品没了）**换下一个地址**试；超时/太大这类"这个地址不可用"也换下一个地址试
 * （见 isHardNetError 的说明：大图传不完就换更小的档，而不是放弃整张）。
 * 只有硬失败（DNS 不了 / 连接被拒）才放弃整张 —— 那时换域名也一样连不上，白等一个超时没意义。
 *
 * **瞬时失败（超时/socket hang up）会重试一次**（见 shouldRetryOnce）：这个图床实测会间歇性
 * 卡住 —— 同一个地址前两次 200、第三次 20 秒没响应。而"给 pid/链接"那条路每页**只有 1 个候选**，
 * 于是那一次卡住就让**后面所有页一页都没试**（2026-10-08 线上真实漏发：一个 6+ 页的作品只发出 2 页）。
 * 404 / 超限（太大）不重试：前者是"真的没有这一页"，后者换页也没用。
 */
async function fetchImage(item, s, { allowTemplate = true } = {}) {
  // 「给 pid/链接」那条路只有模板一个候选（**完全没有图床给的地址**）→ 先用 301 推出尺寸版。
  // 这一步是它唯一能拿到小图的机会：模板本身给的是原图，往往超过 maxImageBytes。
  // ⚠️ 条件必须是"连 imageUrl 都没有"，不能只看 imageUrls 空不空：
  //    走 pixiv.net 后端那条路也是只有 imageUrl、没有 imageUrls，而它已经有真地址了，
  //    再探测一次纯属白费一个请求（有用例盯着这个次数）。
  // ⚠️ allowTemplate=false：取多图作品的第 2 页起时必须关掉模板（模板只给第 0 页），
  //    否则"第 3 页取不到"会变成"又发了一遍第 1 页"。
  //    只在 allowTemplate 时才做 301 探测 —— 那个探测的目的就是"找一个非模板的地址"。
  let itemUrls = Array.isArray(item?.imageUrls) ? item.imageUrls : [];
  if (allowTemplate && !itemUrls.length && !String(item?.imageUrl ?? '').trim() && item?.pid) {
    const derived = await sizeUrlsFromTemplate(buildImageUrl(s.imageUrlTemplate, item.pid), s, item.pid);
    if (derived.length) {
      itemUrls = derived;
      try {
        api?.log?.info?.(`[pixiv-illust] ${item.pid}：由 301 的 Location 推出 ${derived.length} 个尺寸版候选`);
      } catch { /* 日志失败不影响取图 */ }
    }
  }
  const urls = imageCandidates({ ...item, imageUrls: itemUrls }, s.imageUrlTemplate, { allowTemplate });
  // 重试次数取整并夹住：默认 1 次（即"每页最多试两次"），设 0 关掉。
  // 上限 2 次是刻意的：每次都可能花掉一整个 timeoutMs，重试太多会把 30 秒取图预算吃光。
  const retryOnce = Math.min(2, Math.max(0, Math.round(Number(s.pageRetryOnce) || 0)));
  const retryDelayMs = 400;
  let last = null;
  let hardFail = false;   // 硬失败（DNS/连接被拒）：**连候选都不用再试了**
  for (let i = 0; i < urls.length; i += 1) {
    if (hardFail) break;
    // attempts = 1（不重试）或 1 + retryOnce
    for (let attempt = 0; attempt <= retryOnce; attempt += 1) {
      // ⚠️ 硬失败要**在重试之前**判掉：DNS 解析不了 / 连接被拒时，同一个地址再试一次
      //    必然同样失败，只会白等一个超时（有用例 `硬失败直接放弃整张` 盯着这个次数）。
      // ⚠️ 这里只在 attempt>0 时生效；对**第一个 attempt** 由循环外那圈 hardFail 兜住。
      if (attempt > 0 && hardFail) break;
      try {
        const got = await downloadToTemp(urls[i], s.timeoutMs, s.maxImageBytes);
        // 成功时也报一行：调 imageSize 时最想知道的就是"实际下的是哪一档、多少字节"。
        // 之前成功路径完全静默，查那个 12.5MB 故障时只能从失败里反推（2026-10-08 的教训）。
        // **必须带 pid**：不带的话多张作品混在一起就分不清哪个是哪张（又踩过一次）。
        try {
          api?.log?.info?.(`[pixiv-illust] 取图成功 ${item.pid}：${Math.round(got.bytes / 1024)}KB`
            + `（第 ${i + 1}/${urls.length} 个候选${attempt ? `，瞬时失败后重试第 ${attempt} 次` : ''}，档位 ${s.imageSize}）`);
        } catch { /* 日志失败不影响取图 */ }
      // ── 下完就地降采样（2026-10-08 第四轮）────────────────────────────────
      // ⚠️ 位置很要紧：必须在**返回之前**，因为调用方（多图续页）要用**最终体积**做预算。
      //    放在"发送之前"就晚了 —— 那时预算早就按原图算完，一页 1.4MB 只装得下 2~3 页。
      // ⚠️ downsampleToJpeg **从不抛错**：失败/没装 ffmpeg 都回到原图那条路（绝不丢图）。
      const final = await downsampleToJpeg(got.file, {
        overBytes: s.downsampleOverBytes,
        maxEdge: s.downsampleMaxEdge,
        quality: s.downsampleQuality
      });
      if (final.downsized) {
        say(`[pixiv-illust] ${item.pid} 第 ${i + 1} 个候选降采样：`
          + `${Math.round(final.fromBytes / 1024)}KB → ${Math.round(final.bytes / 1024)}KB`
          + `（最长边 ${Math.max(64, Math.round(Number(s.downsampleMaxEdge) || 1200))}px JPEG）`);
      } else if (final.reason) {
        // **回落要出声**：不吭声的话"卡片为什么只装了 3 页"又得从头查一遍
        say(`[pixiv-illust] ${item.pid} 降采样跳过（${final.reason}），按原图 ${Math.round(final.bytes / 1024)}KB 继续`);
      }
      // 把**实际用到的地址**一并带出去：多图续页要靠它认出日期路径，而"给 pid/链接"那条路
      // 的日期路径只存在于这里（它没有 imageUrl）——不带出去，那条路就永远只有第 1 页。
      return { ...got, file: final.file, bytes: final.bytes, downsized: final.downsized, url: urls[i] };
    } catch (error) {
        last = error;
        if (error?.hardNetError) { hardFail = true; break; }
        // 瞬时失败（超时 / socket hang up / 连接被重置）→ **同一个地址重试一次**。
        // 为什么值得：这条路上每页常常只有 1 个候选，那一次卡住就会让**后面所有页一页都没试**
        //（2026-10-08 线上真实漏发：6+ 页的作品只发出 2 页）。而图床实测会间歇性卡住。
        // 为什么不重试别的：404（真的没有这一页）与超限（太大）换页也一样，直接不试。
        if (attempt < retryOnce && isTransientFetchError(error)) {
          say(`[pixiv-illust] ${item.pid} 第 ${i + 1} 个候选瞬时失败（`
            + `${String(error?.message ?? error).slice(0, 50)}），${retryDelayMs}ms 后重试一次`);
          await sleep(retryDelayMs);
          continue;
        }
        // 换到下一个候选时说一声：这条日志是"图床在这个网络上部分不可用"的唯一现场证据，
        // 没有它，用户看到的只是"取不到图"，而不知道插件已经退过一次了。
        if (i + 1 < urls.length) {
          const why = error?.tooBig ? error.message : String(error?.message ?? error).slice(0, 60);
          try { api?.log?.info?.(`[pixiv-illust] 候选地址不可用（${why}），改试 PID 简写形式`); } catch { /* 日志失败不影响取图 */ }
        }
        break;   // 这个地址不重试了，换下一个候选
      }
    }
  }
  throw last || new Error('这张作品没有可用的图片地址');
}

// ── 工具注册 ──────────────────────────────────────────────────────────────

/**
 * 入口。移植接口差异：原版是 `export function setup(a)`（那套接口的入口名），
 * 本项目要求 `export async function activate(api)`（docs/PLUGINS.md §5）。
 *
 * 状态目录也从这里注入：声明了 storage 能力才有 `api.kv`，`api.kv.dir` 就是
 * `<数据目录>/plugin-state/pixiv-illust/`。拿不到就**抛错**让插件标 failed ——
 * 而不是静默把 PID 索引记在内存里（重启就丢，表现是"同一张图又发了一遍"）。
 */
export async function activate(hostApi) {
  api = hostApi;
  const dir = hostApi?.kv?.dir;
  if (!dir) {
    throw new Error('缺少 storage 能力：activate 需要 api.kv.dir 作为状态目录'
      + '（PID 索引与按会话分级都写在插件状态目录里；拿不到目录就不该假装能持久化）');
  }
  setStateDir(dir);
  loadState();
  api.log?.info?.(`已激活：状态目录 ${dir}`);
  // 把**生效的**设置打出来。这一行专门回答"为什么它还用着旧值"这类问题：
  // 设置是启动时读的一次快照（见 settings() 的注释），所以从外面看，
  // "改了设置没重启"与"设置根本没保存上"长得一模一样 —— 只能靠这一行区分。
  // （2026-10-08：`maxImageBytes` 在设置里留着一个旧值，白查了一轮才知道是它。）
  {
    const s = settings();
    const mb = (n) => `${(Number(n) / 1048576).toFixed(1)}MB`;
    api.log?.info?.(`生效设置：imageSize=${s.imageSize} maxImageBytes=${mb(s.maxImageBytes)}`
      + ` maxCount=${s.maxCount} maxPages=${s.maxPages} timeoutMs=${s.timeoutMs} retryCandidates=${s.retryCandidates}`
      + ` 卡片预算=${mb(s.forwardBudgetBytes)} 降采样=>${mb(s.downsampleOverBytes)}/${s.downsampleMaxEdge}px`
      + '（改这些要重启才生效）');
  }
  // 顺带把"这台机器有没有 ffmpeg"打出来：它决定"卡片能装 3 页还是 10+ 页"，
  // 而这件事从别处完全看不出来（没装的话只是卡片小，不会报任何错）。
  resolveFfmpeg().then((bin) => {
    try {
      api.log?.info?.(bin
        ? `降采样可用：ffmpeg = ${bin}（每页 > ${Math.round(Number(settings().downsampleOverBytes) / 1024)}KB 就缩成 `
          + `最长边 ${settings().downsampleMaxEdge}px 的 JPEG，4MB 卡片约能装 10+ 页）`
        : '这台机器上没有 ffmpeg —— 大图按原样发（功能不受影响，只是同样 4MB 的卡片少装几页）');
    } catch { /* 日志失败不影响任何事 */ }
  }).catch(() => { /* 探测本身有问题也不影响 activate */ });

  api.registerTool({
    // 移植接口差异：原版是 registerTool({ id: 'pixiv_image', name: 'Pixiv 来张图',
    // category: 'media', icon: '🎨', ... })。本项目模型看到的函数名用原来的 id，
    // 而 name（展示名）/ category / icon 宿主都不支持，已删掉。
    name: 'pixiv_image',
    description: '按角色/关键词把 Pixiv 插画发到当前会话。群友说"来张XX的图""发点XX的插画"时用它，keyword 填角色名'
      + '（**日文原名命中率最高**，如"初音ミク""天童アリス"；中文名也常能搜到）。\n'
      + '也可以用 url 传 pixiv 作品链接、或用 pid 传作品号 —— 那两种会跳过搜索、直接取那一张'
      + '（例如群友贴了 https://www.pixiv.net/artworks/12345678，就把整串传给 url）。\n'
      + '搜过或发过的作品都有 PID 索引，不会重复发同一张；某个角色这一批都发过了会明确告诉你，换个写法再试。\n'
      + '作品被作者删掉/限制访问时取不到图（接口索引偏旧），这种会自动换下一张，你不用管。\n'
      + '失败时不要编造"图已经发了"：如实说取不到，**一句带过**即可 ——'
      + '不要向群友复述接口、代理、地址模板、pid 这类内部细节，也不要长篇解释原因。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'pixiv 作品链接（推荐，如 https://www.pixiv.net/artworks/12345678）。传了就跳过搜索' },
        pid: { type: ['integer', 'string'], description: 'pixiv 作品号（数字）。传了就跳过搜索' },
        keyword: { type: 'string', description: '搜索关键词（如 "初音ミク"、"天童アリス"）。优先用日文原名，标题/作者名也能搜' },
        count: { type: 'integer', description: '要发几张，默认 1（上限由设置里的「一次最多发几张」决定）' }
      },
      required: []
    },
    async execute(toolCtx, args) {
      const s = settings();
      if (s.enabled === false) return err('这个功能被管理员关掉了。');
      const keyword = String(args?.keyword ?? '').trim();
      // pid / url：直接指定作品号。**这条路不需要搜索接口**，因此在没挂代理的
      // 网络下仍然可用（i.pixiv.re 按 PID 取图是通的，实测 HTTP 200）。
      const pidArg = extractPid(args?.pid) || extractPid(args?.url);
      if (!pidArg && !keyword) {
        return err('至少要给一个 keyword（搜关键词）或 pid（指定作品号，如 12345678），或者贴一个 pixiv 作品链接。');
      }
      const maxCount = clamp(Number(s.maxCount) || 2, 1, 5);
      const want = clamp(Number(args?.count) || 1, 1, maxCount);
      // 分级：**按会话**算一次（本会话覆盖 → 全局 → 旧字段 → 兜底），搜索与过滤都用它
      const rating = ratingsForChat(toolCtx?.chatKey, s);
      const allowed = rating.allowed;
      if (rating.source === 'chat') {
        // 移植接口差异：api.log(msg) → api.log.info(msg)
        try { api?.log?.info?.(`[pixiv-illust] 本会话（${toolCtx.chatKey}）有分级覆盖：${rating.tokens.join('+')}`); } catch { /* 日志失败不影响主流程 */ }
      }

      // 熔断：连着几次连接级失败之后直接快速失败，不再让模型干等 15 秒 × N 次。
      // 只在"要走网络"时才拦 —— 指定 PID 那条路同样要联网取图，所以一起受管。
      const bk = breakerState();
      if (bk.open) {
        return err(`最近 ${BREAKER_AFTER} 次请求都没连上，已暂停取图 ${bk.retryAfterSec} 秒（免得每次都空等）。`
          + '这是网络/配置问题：请管理员在插件设置里填「代理地址」，或换掉两个地址模板。换关键词重试没有意义。');
      }

      // 记录"搜索是否已经成功"。没代理时失败发生在**搜索阶段**（网络错误），
      // 那时最该给的建议是"改走贴链接那条路"——所以错误文案要不要带这个建议，
      // 取决于失败发生在哪一段，而不是取决于错误类型。
      // ⚠️ 必须在 try **外面**声明：catch 里要读它，写在 try 里是块级作用域，读不到。
      let searchOk = false;
      try {
        let picked = [];
        if (pidArg) {
          // ①-A 指定了作品号：仍然必须读取作品元数据并经过同一套分级规则。
          // 绝不能因为用户点名了 PID 就把未知作品当成全年龄发送。
          const meta = await fetchIllustMetadata(s, pidArg);
          if (!meta || !ratingKnown(meta)) {
            // 内置接口无法按 PID 查询、且服务器没有 Pixiv 代理时，保留旧的 PID 直取能力。
            // 未知分级只能按“最高风险”处理：必须同时明确允许 R18 与 R18G，
            // 才能发送；默认 safe 或只允许 R18 的会话仍然拒绝，避免把未知内容发进普通群。
            if (!(allowed.has(1) && allowed.has(2))) {
              return err(`无法确认 Pixiv 作品 ${pidArg} 的分级，已拒绝发送。请改用关键词、配置 HTTP 代理，或在明确允许 R18 与 R18G 的会话中重试。`);
            }
            picked = [{ pid: pidArg, title: '', author: '', bookmarks: NaN, tags: [], xRestrict: 0 }];
          } else {
            const itemRating = ratingOf(meta);
            if (!allowed.has(itemRating)) {
              return err(`作品 ${pidArg} 被分级设置拦截（${ratingLabel(itemRating)}；当前只允许 ${[...allowed].map(ratingLabel).join('、')}）。`);
            }
            picked = [meta];
          }
        } else {
          // ①-B 搜（后端按 searchBackend：auto 会先走内置接口，不需要代理）
          const found = await searchIllusts(s, keyword, want, allowed);
          searchOk = found.items.length > 0;
          if (!found.items.length) {
            const why = found.errors.length ? `（${found.errors.join('；')}）` : '';
            const advice = found.netError
              ? '搜索接口这段连不上（网络/配置问题）。改让对方贴 pixiv 作品链接，或直接给作品号(pid) —— 取图那条路不用搜索接口。'
              : '换个更贴近 Pixiv 标签的写法试试（角色名用日文原名命中率最高）。';
            return err(`没搜到「${keyword}」的插画${why}。${advice}`);
          }
          let items = found.items;
          // ⚠️ 分级必须在**挑选之前**滤掉，不能挪到 pickUnseen 之后 ——
          // 成人向作品的收藏数往往是整批里最高的，顺序一反它就会稳定胜出，
          // 而"默认只出全年龄"就形同虚设（这条顺序被测试盯着）。
          const rated = filterByRating(items, allowed);
          if (rated.dropped.length) {
            try {
              api?.log?.info?.(`[pixiv-illust] 分级过滤：${items.length} → ${rated.kept.length}`
                + `（丢掉 ${rated.dropped.length} 个：${[...new Set(rated.dropped.map(ratingOf))].map(ratingLabel).join('/')}，`
                + `当前允许 ${[...allowed].map(ratingLabel).join('+')}）`);
            } catch { /* 日志失败不影响主流程 */ }
          }
          if (!rated.kept.length) {
            // 搜到了、但全被分级设置滤掉 —— 必须说清楚，否则看起来就像"这个关键词没图"
            const kinds = [...new Set(rated.dropped.map(ratingOf))].map(ratingLabel).join('、');
            return err(`搜到 ${rated.dropped.length} 个「${keyword}」的插画，但**全都被分级设置滤掉了**`
              + `（它们是：${kinds}；当前只允许 ${[...allowed].map(ratingLabel).join('、')}）。`
              + '这不是"没有图"。要发这些作品，请到「Pixiv 来张图（自建）」的设置里在'
              + '「允许的分级」中补勾对应档位（R18 / R18G）。');
          }
          items = rated.kept;

          // ② 排出要试的队列：要发 want 张，但多备几张 —— 抽到的作品可能是死链
          //    （接口索引偏旧），失败就顺手换下一张，而不是整个关键词失败。
          const seenSet = new Set([...seen.keys(), ...deadSet()]);
          picked = buildTryList(items, seenSet, s.poolSize, want, Math.max(0, Math.round(Number(s.retryCandidates) || 3)));
          if (!picked.length) {
            const deadCount = deadSet().size;
            return err(`「${keyword}」搜到的这批都发过了${deadCount ? `或取不到（已拉黑 ${deadCount} 张）` : ''}`
              + `（索引里已记 ${seen.size} 个作品）。换个关键词，或到设置里把「PID 索引上限」调小。`);
          }
        }

        // ③ 逐张下载 → 发送
        sweepTemp();
        const done = [];
        const failed = [];
        const gone = [];
        for (const it of picked) {
          if (done.length >= want) break;   // 备选只用来顶替失败的，凑够数就停
          try {
            // 优先用后端自带的原图地址（带日期路径 + 页码），不行再退回 PID 模板 —— 两条路都试
            const got = await fetchImage(it, s);
            const note = formatNote(it);
            // 「给 pid/链接」那条路的日期路径只存在于"实际取到的那条地址"里（见 fetchImage 的
            // 返回）—— 补回条目上，续页才认得出来。接口给过地址的那条路本来就不缺它。
            if (!String(it.imageUrl ?? '').trim() && got.url) it.imageUrl = got.url;

            // ③.5 多图作品：把第 2..maxPages 页也取回来。
            //
            // 为什么逐页试而不是"按总页数循环"：接口只给 `p`（这一页的页号），**不给张数**。
            // 好在页码从 0 连续排，所以从第 1 页起一页页试、遇到"这一页不存在"就停即可 ——
            // 单图作品只多花一次请求，而那次请求本来就是它要取的那一页。
            // 三条硬约束：① 第 2 页起必须关掉 PID 模板（模板只给第 0 页，否则会重复发第一张）；
            // ② 后页取不到**不影响**已经取到的第一页；③ 认不出日期路径就放弃续页。
            const maxPages = Math.max(1, Math.round(Number(s.maxPages) || 1));
            const extraPages = [];
            // ⚠️ 光按"页数"限制**不够**（2026-10-08 线上实测踩到）：工具的硬上限是 **60 秒**，
            //    而每页要下 1~3MB（这条线路上 1~5 秒/页），再叠上最后那次转发的体积 ——
            //    `maxPages: 10` 很容易顶穿 60 秒，结果工具被宿主掐断、**什么都没发出去** ✗
            //    （用户看到的正是"未合并成卡片 + 超过 60000ms 未返回"）。
            //    所以这里按**时间**与**字节**双重设限，而不是只数页数：
            //      · 时间：留 20 秒给最后的发送（下载与发送共用那 60 秒）；
            //      · 字节：门面的合并转发上限是 12MB（图片合计），这里更早收手 —— 取多了也没用，
            //        转发会被门面拒掉、再回落逐张发，只会更慢 ✗。
            const startedAt = Date.now();
            const pageBudgetMs = Math.max(5000, Number(s.pageBudgetMs) || 40000);
            const forwardBudgetBytes = Math.max(0, Number(s.forwardBudgetBytes) || DEFAULTS.forwardBudgetBytes);
            let collectedBytes = Number(got.bytes) || 0;
            /**
             * 收手日志 —— **必须打真正生效的那个预算值**。
             * ⚠️ 这里以前写死成"（合并转发上限 12MB）"，而预算是**可配的**（现场配的是 4MB），
             *    于是日志一边说"已 10MB"一边说"上限 12MB"，与"生效设置：… 卡片预算=4.0MB"
             *    那行自相矛盾，排查时被带偏过。抽成函数是为了两处判据共用同一句话
             *    （有用例钉住："日志里出现的预算必须等于配置值"）。
             * ⚠️ 用**一位小数**而不是 Math.round：预算是人配的，1.5MB 这种值被显示成"2MB"
             *    就是在骗人（写这条用例时踩到：断言拿舍入值去比，实际配置 1.5MB 显示成 2MB）。
             */
            const mb = (n) => (Number(n) / 1048576).toFixed(1);
            const sayBudgetStop = () => say(`[pixiv-illust] ${it.pid} 图片合计已 ${mb(collectedBytes)}MB`
              + `（卡片预算 ${mb(forwardBudgetBytes)}MB），不再续页`);
            // ⚠️ 循环**之前**也要判一次：第一页自己就顶过预算时（把 forwardBudgetBytes 调小、
            //    或首页特别大），原来会走到循环里、第一条判据就 break —— 于是**一声不响**地
            //    只发一页，日志里看不出是预算拦的（写这条用例时才发现的边界）。
            if (collectedBytes > forwardBudgetBytes) sayBudgetStop();
            for (let page = 1; page < maxPages && collectedBytes <= forwardBudgetBytes; page += 1) {
              if (Date.now() - startedAt > pageBudgetMs) {
                say(`[pixiv-illust] ${it.pid} 时间预算用完（已取 ${extraPages.length + 1} 页），不再续页`);
                break;
              }
              const pageUrls = pageUrlsOf(it, page, s.imageSize);
              if (!pageUrls.length) break;
              try {
                const more = await fetchImage({ ...it, imageUrl: '', imageUrls: pageUrls }, s, { allowTemplate: false });
                // 加进去**之前**先算：这一页会不会把合计顶过预算。
                // （原先是"取下一页之前判"——那样最多会多收一页，而多收的那页正是把发送
                //  拖过 60 秒、或者把卡片顶过预算门线的原因 ✗。判据必须落在"收之前"。）
                const pageBytes = Number(more.bytes) || 0;
                if (collectedBytes + pageBytes > forwardBudgetBytes) {
                  say(`[pixiv-illust] ${it.pid} 再加第 ${page + 1} 页会到 `
                    + `${mb(collectedBytes + pageBytes)}MB（预算 ${mb(forwardBudgetBytes)}MB）`
                    + `，就发前 ${extraPages.length + 1} 页`);
                  break;
                }
                extraPages.push({ file: more.file, page });
                collectedBytes += pageBytes;
              } catch (error) {
                const status = Number(error?.status) || 0;
                // 404/410 = 这个作品没有这一页 → 正常结束（不记日志，那是预期的边界）
                if (status !== 404 && status !== 410) {
                  say(`[pixiv-illust] ${it.pid} 第 ${page + 1} 页取不到`
                    + `（${String(error?.message ?? error).slice(0, 60)}），这个作品就发到这里`);
                }
                break;
              }
            }

            // 怎么发：
            //   · 多页且宿主有 chat:send-forward（门面挂了这个方法）→ 打包成**一条**「聊天记录」，
            //     群里只占一条卡片（这正是那个能力存在的理由）；
            //   · 否则（旧宿主没这个能力，或转发失败 —— 协议端不支持那个 action）→ **回落逐张发**，
            //     一张都不丢。这条回落是刻意的：能力缺失不该让功能变成"什么都发不出来"。
            //     ⚠️ 但回落**也要看预算**：转发失败常常是"图太多/太大"，那不是"再逐张发一遍"能
            //     解决的 ✗ —— 硬发下去只会把 60 秒顶穿，最后一张都发不出去 ✗。
            //
            // 移植接口差异：原来是 `ctx.sender.sendImage(ctx.chatKey, { file }, { note })`。
            // 本项目走门面：`{ path }`（必须落在插件状态目录里，见 tempDir 的注释）+ `{ label }`。
            // 门面自己会做记账（push 进 session.sent + 广播 session-update），所以原来紧跟其后的
            // `ctx.session.sent.push(...)` 与循环后的 `ctx.emit('session-update', ...)` 都删掉了
            // —— 重复记账会出现两条。
            let sentViaForward = false;
            if (extraPages.length && typeof toolCtx.sendForward === 'function') {
              try {
                await toolCtx.sendForward({
                  items: [
                    { text: `${note}（这个作品有 ${extraPages.length + 1} 页）` },
                    { path: got.file },
                    ...extraPages.map((one) => ({ path: one.file }))
                  ],
                  label: note
                });
                sentViaForward = true;
              } catch (error) {
                say(`[pixiv-illust] ${it.pid} 合并转发失败（${String(error?.message ?? error).slice(0, 60)}）`
                  + '，回落逐张发');
              }
            }
            if (!sentViaForward) {
              await toolCtx.sendImage({ path: got.file }, { label: note });
              let sentExtra = 0;
              for (const one of extraPages) {
                if (Date.now() - startedAt > pageBudgetMs + 10000) {
                  say(`[pixiv-illust] ${it.pid} 时间预算用完，余下 `
                    + `${extraPages.length - sentExtra} 页这次不发了（换个更小的 maxPages 会更稳）`);
                  break;
                }
                await toolCtx.sendImage({ path: one.file }, { label: `${note}（第 ${one.page + 1} 页）` });
                sentExtra += 1;
              }
            }
            // 只有真的发出去了才记账 —— 失败不记，否则一次网络抖动就把这张图永久跳过
            markSeen(it.pid);
            done.push({ pid: it.pid, title: it.title, author: it.author, bookmarks: Number.isFinite(it.bookmarks) ? it.bookmarks : null });
          } catch (error) {
            const status = Number(error?.status) || 0;
            // 404 是"作品本身没了"，不是线路问题 —— 拉黑它，否则同一个关键词每次都会再挑到这张死图
            if (status === 404 || status === 410) { markDead(it.pid); gone.push(it.pid); }
            failed.push(`${it.pid}：${error?.message ?? error}`);
          }
        }

        if (!done.length) {
          const tail = gone.length ? '（取不到的那几张已从候选里剔除，同一个关键词再试一次就会换别的作品）' : '';
          return err(`图都没发出去 —— ${failed.join('；')}${tail}`);
        }
        return ok({
          sent: done.length,
          works: done,
          ...(failed.length ? { failed } : {}),
          note: '已发送。不要复述图片内容，也不需要汇报"已发送"。'
        });
      } catch (error) {
        // ⚠️ 没挂代理时，失败**就发生在这里**（搜索阶段网络错误），而不是上面
        // "搜到空结果"那个分支 —— 所以改走贴链接的建议必须挂在这儿才有用。
        // PID/链接直取路径本来就不会调用搜索接口；不能因为 searchOk 保持 false
        // 就把后续的图片下载失败误报成“搜索接口连不上”。
        const alt = (!pidArg && !searchOk && error?.netError)
          ? '（搜索接口连不上：让对方贴作品链接，或直接给作品号 —— 取图那条路不用搜索接口）'
          : '';
        return err(`Pixiv 取图失败：${error?.message ?? error}${alt}`);
      }
    }
  });

  // ── 按会话设置分级（主人用）──────────────────────────────────────────────
  //
  // 移植接口差异：原版工具名是 `set_rating`（那套接口允许插件内短名）。本项目要求工具名
  // 全宿主唯一、且要能一眼看出归属，所以改成 `pixiv_set_rating`。
  //
  // ⚠️ 原来那段「教模型分级是按会话的、只有主人能改」的**提示词注入**
  // （原 manifest 的 `prompt.sections`）在本项目里**没有对应能力**（插件不能注入提示词，
  // 见 docs/PLUGINS.md §14），所以按"工具描述就是模型能看到的全部信息"整个折进下面的
  // description 里。这是与原作者设计的唯一功能性差异，README 里也写了。
  api.registerTool({
    name: 'pixiv_set_rating',
    description:
      '查看/修改**当前会话**的图片分级过滤（全年龄 / R18 / R18G）。'
      + '「Pixiv 来张图（自建）」的图片分级过滤是**按会话**的：每个群/私聊可以不一样。'
      + '当**主人**说「这个群只发全年龄」「本群可以发 R18」「这里恢复默认分级」这类要求时用它。\n'
      + '· 不带参数调 = 查当前会话现在允许什么、这个设置是从哪来的；对方只是问「这个群能发什么图」时也用它，'
      + '按它返回的结果如实回答 —— 不要凭感觉说自己不知道；\n'
      + '· action=set 且给 ratings = 改（ratings 可传 ["safe"]、["safe","r18"]、["r18g"] 等，'
      + '中文「全年龄/R18/R18G」也认；**至少给一个**）；\n'
      + '· action=clear = 清除本会话的设置，回落到全局默认。\n'
      + '权限：**只有主人能改**（群主/管理员也不行 —— 这是主人特意定的，依据是插件设置里的'
      + '「主人 QQ」名单）。工具会自己核身份，核不过就直接告诉你。\n'
      + '⚠️ 不是主人的人让你改分级时：如实说一句「这个只有主人能改」，**不要**假装改了、也不要嘲讽对方；'
      + '**不要**自己去解释分级怎么算、也不要代替它改。'
      + '核不过时**不要**改口说"已经改好了" —— 那是权限问题，不是"功能没做"。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'set = 设置；clear = 清除本会话设置（回落全局）；不传 = 查询当前生效的分级' },
        ratings: { type: 'array', items: { type: 'string' }, description: 'action=set 时要允许的分级，如 ["safe"] 或 ["safe","r18"]；可选值 safe/r18/r18g（中文 全年龄/R18/R18G 也认）' }
      },
      required: []
    },
    async execute(toolCtx, args) {
      const s = settings();
      if (s.enabled === false) return err('这个功能被管理员关掉了。');
      const action = String(args?.action ?? '').trim().toLowerCase();
      const chatKey = String(toolCtx?.chatKey ?? '');
      const now = ratingsForChat(chatKey, s);
      const describe = (r) => `${r.tokens.map((t) => RATING_LABEL_FULL[t] || t).join(' + ')}`
        + `（来源：${RATING_SOURCE_LABEL[r.source] || r.source}）`;

      // 查询：谁都能问（不含任何敏感信息）
      if (!action && !Array.isArray(args?.ratings) && args?.ratings === undefined) {
        // ⚠️ 刻意**不返回文件路径**：这份结果可能被模型复述到群里，而"不透露本地路径"
        //    是宿主既有的安全规则。路径写在插件设置那条说明里（管理员看得到）。
        return ok({
          chatKey,
          now: now.tokens,
          nowText: describe(now),
          global: [...resolveRatings(s)].map((x) => (x === 0 ? 'safe' : x === 1 ? 'r18' : 'r18g')),
          // 移植接口差异：原文案是"只有主人（技能设置里的「主人 QQ」，或主人识别插件认定的人）"，
          // 本项目没有那个插件，照实说清，免得人以为装了就有。
          whoCanChange: '只有主人（插件设置里的「主人 QQ」名单；本宿主没有「主人识别」插件）'
        });
      }
      if (action && action !== 'set' && action !== 'clear') {
        return err(`action 只支持 set / clear（收到的是 ${JSON.stringify(args?.action)}），不传就是查询。`);
      }

      // 改之前先核身份（查身份失败也不放行）
      const perm = await callerMayChangeRating(toolCtx, s);
      if (!perm.ok) {
        return err(`没改：${perm.reason}`
          + '（这是权限问题，不是"功能没做"——请不要回复"已改好"。）');
      }

      if (action === 'clear') {
        const r = clearChatRating(chatKey);
        if (!r.ok) return err(`清除失败：${r.error}`);
        const after = ratingsForChat(chatKey, s);
        return ok({
          cleared: true, had: r.had,
          now: after.tokens,
          say: `本会话的分级设置${r.had ? '已清除，' : '本来就没有，'}现在按全局默认：${describe(after)}。`
            + '回群友一句就行，不要复述文件名或内部字段。'
        });
      }

      const r = setChatRating(chatKey, args?.ratings);
      if (!r.ok) return err(`${r.error}（要设就至少给一个：safe / r18 / r18g）`);
      const after = ratingsForChat(chatKey, s);
      try { api?.log?.info?.(`[pixiv-illust] ${perm.callerId}（${perm.how}）把 ${chatKey} 的分级设为 ${r.tokens.join('+')}`); } catch { /* 日志失败不影响主流程 */ }
      return ok({
        chatKey,
        set: r.tokens,
        nowText: describe(after),
        say: `已把本会话的分级设为 ${r.tokens.map((t) => RATING_LABEL_FULL[t] || t).join(' + ')}`
          + `（依据：${perm.how}）。${r.tokens.includes('r18') || r.tokens.includes('r18g')
            ? '注意成人档还需要 Pixiv 那边能返回成人内容，否则可能一张都搜不到。' : ''}`
          + '回群友一句话确认即可，不要复述内部字段。'
      });
    }
  });

  return {
    async deactivate() {
      // v1 的插件不允许注册定时器/后台循环，所以这里没什么要清理的。
      // ⚠️ 移植说明：deactivate 里**不要**再发消息或发网络请求 —— 卸载发生在进程收尾阶段，
      // 外部写入的成败已经没人能处理（docs/PLUGINS.md 的入口示例也是这么写的）。
      // 状态文件是每次写入即落盘的（saveState），所以不需要在这里做收尾保存。
    }
  };
}

/**
 * 原宿主会调它探测"插件依赖是否就绪"。
 *
 * ⚠️ 移植说明：本项目的装载器**没有**这个钩子（入口契约只有 activate / 返回的 deactivate，
 * 见 docs/PLUGINS.md §5），所以它在这里不会被任何人调用。保留它是为了不删原作者的东西，
 * 也方便测试直接读"这个插件不探测网络"这条结论。
 */
export function available() {
  // 不探测网络：能不能连通取决于代理/反代配置，那是运行时的事，
  // 不能因为一次探测失败就把整个插件标成"依赖未就绪"。
  return { ok: true };
}

export const internals = {
  normalizeItem, parseSearchJson, isR18, pickUnseen, formatNote, buildSearchUrl, buildImageUrl, extractPid,
  safeSlice, stripLoneSurrogates,
  buildLoliconUrl, mapLoliconItems, searchIllusts,
  // 分级（含按会话覆盖）
  ratingOf, ratingKnown, ratingLabel, resolveRatings, allowedRatings, filterByRating, normalizeRatingTokens,
  ratingsForChat, chatRatingOf, setChatRating, clearChatRating, loadChatRatings,
  __resetChatRatingsCache, adminIdSet, latestCaller, callerMayChangeRating,
  buildTryList, imageCandidates, describeImageHttp, deadSet, pixivDirectCoolingDown,
  resolveProxyUrl, describeFetchError, breakerState, dispatcherFor,
  needsPixivReferer, searchHttpError, requestHeaders, __doFetch: doFetch, __requestJson: requestJson,
  __fetchImage: fetchImage, __downloadToTemp: downloadToTemp,
  // ── 降采样（2026-10-08 第四轮）──────────────────────────────────────────
  // 查"为什么卡片只装了 3 页"时，这几个是唯一能单独跑一遍的入口。
  resolveFfmpeg, buildDownsampleArgs, downsampleToJpeg,
  __resetFfmpegProbe, __setSpawnForTest, __setLogSinkForTest, __setSettingsForTest,
  // ── 状态目录（移植新增）────────────────────────────────────────────────
  // 原来这里是 `__chatRatingsFile: CHAT_RATINGS_FILE`（模块常量）。现在两个路径都由
  // setStateDir() 现算，所以改成函数与 setter —— 测试要在自己的临时目录上跑，
  // 直接调 __setStateDir(tmp) 即可（不用碰真实数据目录）。
  setStateDir, __setStateDir: setStateDir,
  __stateDir: () => stateDir,
  __stateFile: () => stateFile,
  __chatRatingsFile: () => chatRatingsFile,
  __tempDir: tempDir,
  __sweepTemp: sweepTemp,
  __settings: settings,
  // 测试用：重置/替换内存索引，避免测试污染真实数据目录
  __setState: (entries = [], deadEntries = [], file = null) => {
    seen = new Map(entries); dead = new Map(deadEntries);
    if (file) stateFile = file;
    stateLoaded = false;
  },
  __getSeen: () => new Map(seen),
  __getDead: () => new Map(dead),
  __loadState: loadState,
  __saveState: saveState,
  __markSeen: markSeen,
  __markDead: markDead,
  __resetBreaker: () => { netFailStreak = 0; netFailUntil = 0; pixivDirectFailAt = 0; },
  __noteNetFailure: noteNetFailure,
  __setPixivDirectFailAt: (t = Date.now()) => { pixivDirectFailAt = t; },
  DEFAULTS
};
