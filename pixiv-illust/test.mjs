// pixiv-illust 插件的用例：纯函数 + 两条"与宿主接触面"的契约。
//
// 分三层：
//   ① 纯逻辑（URL 构造 / 字段映射 / 分级 / 挑选 / PID / 主人名单）—— 不碰网络、不碰盘；
//   ② 两个 seam：状态文件读写（临时目录）与 latestCaller/callerMayChangeRating 的授权判定；
//   ③ **门面契约**：拿真的 buildPluginApi / buildPluginToolContext 跑一遍 activate，
//      钉住"注册的工具名 == manifest.tools"、"toolCtx 上没有 store/sender/emit"、
//      "临时图片落在插件状态目录之内"（门面的 sendImage 只认那之内的文件）。
//
// 风格照抄 test/plugin-tools.test.mjs：临时 QQ_AGENT_DATA_DIR + 动态 import。
//
// ⚠️ 这个插件住在**自建插件仓库**里（安装目录之外），所以宿主代码要另外指：
//   本机：  QQ_AGENT_HOME=D:\QQ-Agent\qq-agent-plus  node --test pixiv-illust/test.mjs
//   服务器：QQ_AGENT_HOME=/mnt/data/qq-agent/app    node --test /mnt/data/qq-agent/plugins/pixiv-illust/test.mjs
// 不指就按"与源码 checkout 平级"猜一次；猜不到**整体跳过**，而不是误报一片红。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 本插件所在的那一层就是**插件根**（装载器的 roots 要指向"装着插件目录的那一层"）。 */
const SELF_ROOT = path.dirname(HERE);
const HOST = process.env.QQ_AGENT_HOME
  ? path.resolve(process.env.QQ_AGENT_HOME)
  : path.resolve(HERE, '..', '..', 'qq-agent-plus');
const hostReady = fs.existsSync(path.join(HOST, 'plugins', 'loader.js'));
const SKIP = hostReady
  ? false
  : `找不到宿主代码（试过 ${HOST}）—— 用 QQ_AGENT_HOME 指到安装目录或源码 checkout`;
const hostUrl = (relative) => pathToFileURL(path.join(HOST, relative)).href;

/**
 * 找得到宿主才跑；找不到就整体跳过（下面每一条都走这个包装）。
 *
 * ⚠️ `ownSkip` 是**给单条用例用的**（例如"这台机器没有 ffmpeg"那几条）。原来这里只传
 * `{ skip: SKIP }`，于是 `check(name, { skip: xxx }, fn)` 的第三个参数会被当成 fn ——
 * 用例**静默地什么都不验就报绿**（本机实测抓到：三条"真压缩"用例全绿，而机器上根本没有
 * ffmpeg）。所以这里必须把每条的 skip 合并进来，并在两处都成立时才跳过。
 */
const check = (name, fn, ownSkip = false) => test(name, { skip: SKIP || ownSkip }, fn);
const PLUGIN_DIR = HERE;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-plugin-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const tempDirs = [dataDir];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
  }
});

function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const plugin = hostReady ? await import('./index.js') : {};
const {
  activate, available, internals,
  buildLoliconUrl, mapLoliconItems, resolveRatings, filterByRating, normalizeRatingTokens,
  pickUnseen, buildTryList, extractPid, ownerIdSet, latestCaller, callerMayChangeRating,
  ratingsForChat, ratingOf, describeFetchError, resolveProxyUrl, deadSet, breakerState,
  imageCandidates, sizeLadderFrom, parseOriginalPath, sizeUrlsFromOriginal, pageUrlsOf, parseSuffixPath,
  // 降采样：这几个是**导出**的（不是只挂在 internals 上），因为用例要直接驱动它们
  resolveFfmpeg, buildDownsampleArgs, downsampleToJpeg, __resetFfmpegProbe, __setSpawnForTest,
  __setLogSinkForTest, __setSettingsForTest
} = plugin;

const { buildPluginApi, buildPluginToolContext } = hostReady ? await import(hostUrl('plugins/_host/context.js')) : {};
const { normalizeManifest, readManifest, manifestFingerprint } = hostReady ? await import(hostUrl('plugins/_host/manifest.js')) : {};
const { PLUGIN_CAPABILITY_IDS } = hostReady ? await import(hostUrl('plugins/_host/capabilities.js')) : {};
const { pluginStateDir } = hostReady ? await import(hostUrl('plugins/_host/storage.js')) : {};
const { initPlugins, resetPlugins } = hostReady ? await import(hostUrl('plugins/loader.js')) : {};

// ── 门面：用真的 manifest + 真的 activate 建一次 ────────────────────────────
//
// ⚠️ 这一段必须在 `if (hostReady)` 里：它们调用的是**宿主模块**（normalizeManifest /
// buildPluginApi / activate）。写在顶层的话，宿主找不到时文件会当场 TypeError、
// 连一条 SKIP 都输出不了 —— 而"猜不到宿主就不误报红"是这套自建插件测试的约定。
// 变量声明留在外面（下面的用例会引用它们；宿主缺失时那些用例本来就整体 SKIP）。
//
// config 里给上 ownerIds，下面 callerMayChangeRating/ratingsForChat 才能验到"全局设置"那一层。
const CONFIG = {
  plugins: {
    settings: {
      'pixiv-illust': { ownerIds: '10001,10002', ratings: ['safe'] }
    }
  }
};
let manifest = null;
let pluginToolNames = [];
let pluginApi = null;
let pluginReturned = null;
const registered = new Map();

if (hostReady) {
  manifest = normalizeManifest(readManifest(PLUGIN_DIR), {
    pluginDir: PLUGIN_DIR,
    expectedId: 'pixiv-illust',
    capabilityNames: PLUGIN_CAPABILITY_IDS
  });
  pluginToolNames = manifest.tools.map((tool) => tool.name).sort();
  pluginApi = buildPluginApi({
    manifest,
    config: CONFIG,
    dataDir,
    log: null,
    registerTool: (def) => registered.set(String(def.name), def)
  });
  pluginReturned = await activate(pluginApi);
}

// ── 取图链路的测试夹具（2026-10-08 那次真实故障的固化）────────────────────
//
// 现场：阿里云上一台实例取 `i.pixiv.re` 的原图，响应头 200 回来了，但响应体 13,080,814 字节
// （12.5MB）在 118KB/s 的线路上要下约 108 秒，而工具上限是 60 秒 —— 于是每次都是"整 60 秒被
// 宿主掐断"，看起来像插件坏了。而同一个作品的 `pixiv.re/{pid}.png`（压缩过）4.6 秒就拿到。
//
// 所以这里钉三件事：体积上限要**先看 Content-Length 再决定下不下**、读体要**边读边算**、
// 时限要**覆盖响应体**（原先 doFetch 在响应头到达时就 clearTimeout，等于没有体时限）。

/** 造一个只满足插件用到的那几个字段的假响应（不依赖 Response 对 content-length 的限制）。 */
function fakeImageResponse({ status = 200, contentType = 'image/png', contentLength = null, body = null, onArrayBuffer = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength === null ? null : String(contentLength);
        return null;
      }
    },
    body,
    async arrayBuffer() { if (onArrayBuffer) onArrayBuffer(); return new ArrayBuffer(0); }
  };
}

/** 依次吐出 chunks 的响应体。 */
function chunkStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[i]);
      i += 1;
    }
  });
}

/** "响应头回来了、响应体永不回来"的响应体；靠 abort 信号让它报错（真实 fetch 的行为）。 */
function stallingStream(signal) {
  return new ReadableStream({
    pull() { return new Promise(() => {}); },          // 永远不 resolve：模拟体不回来
    start(controller) {
      signal?.addEventListener('abort', () => {
        try { controller.error(new Error('This operation was aborted')); } catch { /* 已经关掉 */ }
      });
    }
  });
}

/** 临时换上全局 fetch 桩跑一段，跑完必恢复。 */
async function withFetch(stub, run) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = real; }
}

check('取图：Content-Length 超过上限时一个字节都不下（12.5MB 原图 / 5MB 上限）', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-cap-')));
  const tooBig = 13080814;
  let touchedBody = false;
  const error = await withFetch(
    async () => fakeImageResponse({ contentLength: tooBig, onArrayBuffer: () => { touchedBody = true; } }),
    async () => {
      try { await internals.__downloadToTemp('https://i.pixiv.re/x_p0.png', 15000, 5 * 1024 * 1024); return null; }
      catch (e) { return e; }
    }
  );
  assert.ok(error, '超过上限应该抛错而不是成功');
  assert.equal(error.tooBig, true);
  assert.equal(error.bytes, tooBig);
  assert.equal(touchedBody, false, '超过上限时连响应体都不该碰（否则等于先下完 12.5MB 再判大小）');
});

check('取图：没有 Content-Length 时边读边算，越界立刻中止（不会把整张下完）', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-stream-')));
  const chunk = new Uint8Array(2 * 1024 * 1024);
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); }   // 无限给：越界必须由插件自己中止
  });
  const error = await withFetch(
    async () => fakeImageResponse({ body }),
    async () => {
      try { await internals.__downloadToTemp('https://i.pixiv.re/x_p0.png', 15000, 5 * 1024 * 1024); return null; }
      catch (e) { return e; }
    }
  );
  assert.ok(error?.tooBig, `应因超限失败，实际 ${error?.message}`);
  // ⚠️ 不能用"流的 pull 被调了几次"来判断：ReadableStream 会预取一块填队列，那个数会多 1。
  // 该钉的是**插件累计消费了多少**：2MB/块、上限 5MB → 读到第 3 块（6MB）就该中止。
  assert.equal(error.bytes, 6 * 1024 * 1024, '中止时的累计字节数应是"刚好越界"的那一块');
});

check('取图：响应头回来但响应体不回来时，超时必须在时限内掐断（原始 bug 的哨兵）', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-stall-')));
  const started = Date.now();
  // 3000ms 是 downloadToTemp 的下限；这条用例要真等它一次。
  // 看门狗是必须的：时限一旦失效，等待就是**无限**的 —— 没有它这条用例会挂住 CI 而不是判红。
  const settled = await Promise.race([
    withFetch(
      async (url, options) => fakeImageResponse({ body: stallingStream(options?.signal) }),
      async () => {
        try { await internals.__downloadToTemp('https://i.pixiv.re/stall.png', 3000, 5 * 1024 * 1024); return { ok: true }; }
        catch (e) { return { error: e }; }
      }
    ),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 20000))
  ]);
  const spent = Date.now() - started;
  assert.equal(settled.hung, undefined,
    '响应体没有时限 → 一直挂着（这正是原始 bug：挂到宿主 60 秒上限才被掐断）');
  const error = settled.error;
  assert.ok(error, '应该失败，而不是一直挂着');
  assert.ok(spent < 15000, `应在时限内掐断（实际 ${spent}ms）`);
  // 体阶段的失败与"等响应头"阶段同一口径：可读文案 + netError（软失败，值得试下一个候选）
  assert.equal(error.netError, true, '应被当作网络类失败包装');
  assert.equal(error.hardNetError, false, '超时不是硬失败：该给下一个候选机会');
  assert.match(error.message, /连接超时|超时|abort/i);
});

check('取图：第一个候选超限时自动改用 PID 简写形式（这次故障的修法）', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-fallback-')));
  const item = { pid: '116977943', imageUrl: 'https://i.pixiv.re/img-original/img/2024/03/16/21/29/42/116977943_p0.png' };
  const calls = [];
  const got = await withFetch(
    async (url) => {
      calls.push(String(url));
      if (String(url).includes('i.pixiv.re')) return fakeImageResponse({ contentLength: 13080814 });   // 原图 → 秒退
      return fakeImageResponse({ contentLength: 4, body: chunkStream([new Uint8Array([1, 2, 3, 4])]) });
    },
    () => internals.__fetchImage(item, { ...internals.DEFAULTS, timeoutMs: 3000 })
  );
  assert.equal(calls.length, 2, `应该试了两个候选，实际 ${JSON.stringify(calls)}`);
  assert.ok(calls[0].includes('i.pixiv.re'), '第一候选仍是后端给的原图地址');
  assert.ok(calls[1].endsWith('pixiv.re/116977943.png'), `第二候选应是 PID 简写形式，实际 ${calls[1]}`);
  assert.equal(got.bytes, 4);
  assert.ok(fs.existsSync(got.file), '取到的图要落成临时文件');
});

check('取图：第一候选是"软失败"（超时）时也要换下一个候选 —— 这条守住原来那个 break', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-soft-')));
  const item = { pid: '116977943', imageUrl: 'https://i.pixiv.re/img-original/x_p0.png' };
  const calls = [];
  const got = await withFetch(
    async (url) => {
      calls.push(String(url));
      if (String(url).includes('i.pixiv.re')) {
        // 等响应头就超时：这是"软失败"（netError 为真、hardNetError 为假）。
        // 原代码 `if (error?.netError) break;` 会在这里放弃整张 —— 而同一作品的简写形式明明能用。
        const e = new Error('fetch failed');
        e.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
        throw e;
      }
      return fakeImageResponse({ contentLength: 4, body: chunkStream([new Uint8Array([9, 9, 9, 9])]) });
    },
    () => internals.__fetchImage(item, { ...internals.DEFAULTS, timeoutMs: 3000 })
  );
  assert.equal(calls.length, 2, `软失败也该试第二个候选，实际只试了 ${calls.length} 次`);
  assert.ok(calls[1].endsWith('pixiv.re/116977943.png'));
  assert.equal(got.bytes, 4);
});

check('取图：硬失败（DNS 解析不了）直接放弃整张，不白等第二个候选', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-hard-')));
  const item = { pid: '1', imageUrl: 'https://i.pixiv.re/x_p0.png' };
  let calls = 0;
  const error = await withFetch(
    async () => {
      calls += 1;
      const e = new Error('fetch failed');
      e.cause = { code: 'ENOTFOUND' };
      throw e;
    },
    async () => {
      try { await internals.__fetchImage(item, { ...internals.DEFAULTS, timeoutMs: 3000 }); return null; }
      catch (e) { return e; }
    }
  );
  assert.ok(error, '应该抛错');
  assert.equal(calls, 1, 'ENOTFOUND 换域名也一样连不上，不该再试第二个候选');
});


/** 一个尽量贴近宿主真实 ctx 的假上下文（含那些**不许**泄漏给插件的字段）。 */
function fakeHostCtx(overrides = {}) {
  const images = [];
  const sends = [];
  const emitted = [];
  const session = { id: 'sess-1', leaseId: 'lease-1', rounds: 3, sent: [], triggerText: '在吗' };
  const forwards = [];
  const ctx = {
    chatKey: 'group:12345',
    kind: 'group',
    chatId: '12345',
    selfId: '999',
    selfNickname: '小鲸鱼',
    botName: '小鲸鱼',
    signal: null,
    sender: {
      async sendTextBatch(chatKey, messages) {
        sends.push({ chatKey, messages });
        return { sent: messages.map((text, i) => ({ text, messageId: i + 1, at: '00:00:01' })), failed: [] };
      },
      async image(chatKey, payload, options) {
        images.push({ chatKey, payload, options });
        return { message_id: 4242 };
      },
      async forward(chatKey, payload, options) {
        forwards.push({ chatKey, payload, options });
        return { message_id: 4343 };
      }
    },
    store: {
      recent: () => [{
        id: 1, mid: 10, ts: 1700000000000, senderId: '10001', senderName: '主人', self: false, text: '来张初音ミク的图'
      }]
    },
    memory: { append() { throw new Error('插件不该碰到 memory'); } },
    onebot: { selfId: '999' },
    identityPilot: null,
    stickers: {},
    reminders: {},
    games: null,
    emit: (type, payload) => emitted.push([type, payload]),
    session,
    ...overrides
  };
  return { ctx, images, forwards, sends, emitted, session };
}

/**
 * 假 logger：把插件的四行日志收进数组，供用例断言"日志里说的是真正生效的值"。
 * 形状照 `plugins/_host/context.js` 的 `pluginLogger`（宿主会加 `[plugin:<id>]` 前缀，这里不模拟）。
 */
function fakeLogger() {
  const lines = [];
  const push = (level) => (...args) => { lines.push(`${level}:${args.map((a) => String(a)).join(' ')}`); };
  return {
    lines,
    all: () => lines.join('\n'),
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
  };
}

function makeToolCtx(hostCtx, log = null, config = CONFIG) {
  return buildPluginToolContext({
    manifest, hostCtx, config, dataDir, log, signal: null
  });
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────────

check('buildLoliconUrl：关键词编码、num/r18/excludeAI 参数、tag 与 keyword 两种模式', () => {
  const tagUrl = buildLoliconUrl('https://api.lolicon.app/setu/v2', '初音ミク', { limit: 10 });
  const tag = new URL(tagUrl);
  assert.equal(tag.searchParams.get('tag'), '初音ミク');
  assert.equal(tag.searchParams.get('num'), '10');
  assert.equal(tag.searchParams.get('r18'), '0');
  assert.equal(tag.searchParams.get('excludeAI'), null);
  // 关键词必须真的 URL 编码过（日文原名要能安全拼进查询串）
  assert.match(tagUrl, /tag=%E5%88%9D%E9%9F%B3/);

  const kw = new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', '天童アリス', { mode: 'keyword' }));
  assert.equal(kw.searchParams.get('keyword'), '天童アリス');
  assert.equal(kw.searchParams.get('tag'), null);

  // 选了任一成人档 → r18=2（混合），到本机再精筛；只选全年龄 → 0
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowed: new Set([2]) })).searchParams.get('r18'), '2');
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowed: new Set([0]) })).searchParams.get('r18'), '0');
  // 旧字段兼容：没给 allowed 时看 allowR18 布尔
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowR18: true })).searchParams.get('r18'), '2');
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { excludeAI: true })).searchParams.get('excludeAI'), 'true');
  // num 被夹到 1~20
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { limit: 999 })).searchParams.get('num'), '20');
  // 地址不合法要报出来，而不是拿空串去请求
  assert.throws(() => buildLoliconUrl('not a url', 'x'), /内置搜索接口地址不合法/);

  // ── 尺寸档（2026-10-08 加：接口默认只给 original，而那可能是 12.5MB，部分网络传不完）──
  const sizes = (u) => new URL(u).searchParams.getAll('size');
  assert.deepEqual(sizes(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { size: 'original' })),
    ['original', 'regular', 'small', 'thumb', 'mini'], '选了 original 就把它和更小的档都写上');
  assert.deepEqual(sizes(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { size: 'regular' })),
    ['regular', 'small', 'thumb', 'mini'], 'regular 起算：不带 original（那正是要避开的大家伙）');
  assert.deepEqual(sizes(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x')),
    ['regular', 'small', 'thumb', 'mini'], '默认就是 regular');
  assert.deepEqual(sizes(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { size: '没这个档' })),
    ['regular', 'small', 'thumb', 'mini'], '认不出来的档位按 regular 起算，别悄悄退回 original');
  // 地址里原本带的 size 要被设置覆盖掉（插件设置是唯一真相），否则会多出一份 original
  assert.deepEqual(sizes(buildLoliconUrl('https://api.lolicon.app/setu/v2?size=original', 'x', { size: 'small' })),
    ['small', 'thumb', 'mini']);
  // 原有参数不能被 size 挤掉
  const withProxy = new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2?proxy=pixiv.re', 'x'));
  assert.equal(withProxy.searchParams.get('proxy'), 'pixiv.re');
  assert.equal(withProxy.searchParams.getAll('size').length, 4);
});

check('mapLoliconItems：字段映射与缺字段兜底', () => {
  const items = mapLoliconItems({
    data: [
      {
        pid: 12345678, title: '标题', author: '作者', uid: 42, r18: true,
        tags: ['初音ミク', 'R-18'], urls: { original: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg' }
      },
      { pid: 87654321 },                       // 缺字段兜底
      { pid: 'not-a-pid', title: '坏条目' }     // pid 非法 → 丢掉
    ]
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    pid: '12345678',
    title: '标题',
    author: '作者',
    userId: '42',
    bookmarks: NaN,                          // 这个接口不给收藏数
    xRestrict: 1,                            // r18:true → 1，统一交给 isR18/ratingOf
    tags: ['初音ミク', 'R-18'],
    thumbnail: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg',
    imageUrl: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg',
    // 只给了 original（旧接口/旧地址的行为）→ 退回它给的那些，别让条目变成"没有图"
    imageUrls: ['https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg']
  });
  assert.equal(items[1].pid, '87654321');
  assert.equal(items[1].title, '（无题）');
  assert.equal(items[1].author, '（未知作者）');
  assert.equal(items[1].xRestrict, 0);
  assert.deepEqual(items[1].tags, []);
  assert.deepEqual(mapLoliconItems(null), []);
  assert.deepEqual(mapLoliconItems({ data: 'nope' }), []);
});

check('sizeLadderFrom：档位从大到小，认不出按 regular 起算（别悄悄退回十几 MB 的 original）', () => {
  assert.deepEqual(sizeLadderFrom('original'), ['original', 'regular', 'small', 'thumb', 'mini']);
  assert.deepEqual(sizeLadderFrom('regular'), ['regular', 'small', 'thumb', 'mini']);
  assert.deepEqual(sizeLadderFrom('mini'), ['mini']);
  assert.deepEqual(sizeLadderFrom(''), ['regular', 'small', 'thumb', 'mini']);
  assert.deepEqual(sizeLadderFrom(undefined), ['regular', 'small', 'thumb', 'mini']);
  assert.deepEqual(sizeLadderFrom('ORIGINAL'), ['original', 'regular', 'small', 'thumb', 'mini'], '大小写不敏感');
  assert.deepEqual(sizeLadderFrom('巨大'), ['regular', 'small', 'thumb', 'mini'], '认不出就当 regular');
});

check('尺寸档映射：所选档优先、更小的档留着当备选（大图传不完就退档）', () => {
  const u = {
    original: 'https://i.pximg.net/img-original/img/x_p0.png',
    regular: 'https://i.pximg.net/c/1200x1200/img-master/x_p0_master1200.jpg',
    small: 'https://i.pximg.net/c/540x540_70/img-master/x_p0_master1200.jpg',
    thumb: 'https://i.pximg.net/c/250x250_80_a2/img-master/x_p0_square1200.jpg'
  };
  const raw = { data: [{ pid: 138387319, r18: false, urls: u }] };

  const [item] = mapLoliconItems(raw, { size: 'regular' });
  assert.deepEqual(item.imageUrls, [u.regular, u.small, u.thumb],
    '从 regular 起按从大到小排；**不含 original**（那正是要避开的十几 MB 大图）');
  assert.equal(item.imageUrl, u.regular, '首选就是所选档');
  assert.equal(item.thumbnail, u.regular);

  const [big] = mapLoliconItems(raw, { size: 'original' });
  assert.deepEqual(big.imageUrls, [u.original, u.regular, u.small, u.thumb],
    '选了 original 就把它排最前，但更小的档仍要留着当备选');

  // 某个档缺失就跳过它，不能因此空手而归
  const [hole] = mapLoliconItems({ data: [{ pid: 1, urls: { original: 'https://a/o.png', small: 'https://a/s.jpg' } }] },
    { size: 'regular' });
  assert.deepEqual(hole.imageUrls, ['https://a/s.jpg'], 'regular 缺失 → 退到 small');

  // 两个档给同一个地址要去重
  const [dup] = mapLoliconItems({ data: [{ pid: 1, urls: { regular: 'https://a/x.jpg', small: 'https://a/x.jpg' } }] },
    { size: 'regular' });
  assert.deepEqual(dup.imageUrls, ['https://a/x.jpg']);
});

check('imageCandidates：各尺寸档依次试，最后才落到 PID 模板', () => {  const item = {
    pid: '138387319',
    imageUrl: 'https://i.pximg.net/c/1200x1200/r.jpg',
    imageUrls: ['https://i.pximg.net/c/1200x1200/r.jpg', 'https://i.pximg.net/c/540x540/s.jpg']
  };
  const list = imageCandidates(item, 'https://pixiv.re/{pid}.png');
  assert.deepEqual(list, [
    'https://i.pximg.net/c/1200x1200/r.jpg',
    'https://i.pximg.net/c/540x540/s.jpg',
    'https://pixiv.re/138387319.png'
  ], '先按尺寸从大到小，再是条目自带的地址，最后才是 PID 模板');
  assert.equal(list.filter((one) => one === item.imageUrl).length, 1, 'imageUrl 已在 imageUrls 里就不重复');

  // 老形状（只有 imageUrl、没有 imageUrls）照样能用
  assert.deepEqual(imageCandidates({ pid: '1', imageUrl: 'https://a/x.png' }, 'https://b/{pid}.png'),
    ['https://a/x.png', 'https://b/1.png']);
  // 什么都没有时，模板是最后的兜底
  assert.deepEqual(imageCandidates({ pid: '1' }, 'https://b/{pid}.png'), ['https://b/1.png']);
});

check('resolveRatings / filterByRating：只勾 R18G 时就只出 R18G；空选择被兜成 safe', () => {
  const items = [
    { pid: '1', xRestrict: 0, tags: [] },
    { pid: '2', xRestrict: 1, tags: ['R-18'] },
    { pid: '3', xRestrict: 1, tags: ['R-18G'] },   // 标签把 1 升到 2
    { pid: '4', xRestrict: 2, tags: [] }
  ];
  assert.deepEqual([...resolveRatings({ ratings: ['safe'] })], [0]);
  assert.deepEqual([...resolveRatings({ ratings: ['safe', 'r18'] })].sort(), [0, 1]);
  // 只勾 R18G：全年龄也不出（"没勾的档一律不出"）
  const onlyG = resolveRatings({ ratings: ['r18g'] });
  assert.deepEqual([...onlyG], [2]);
  assert.deepEqual(filterByRating(items, onlyG).kept.map((x) => x.pid), ['3', '4']);
  // 空选择/全是垃圾 → 兜成「全年龄」（配置文件可以手改，界面那道校验管不到）
  assert.deepEqual([...resolveRatings({ ratings: [] })], [0]);
  assert.deepEqual([...resolveRatings({ ratings: ['  ', '不存在'] })], [0]);
  // 逗号串也认；旧字段 allowR18 的兼容语义是"全年龄 + R18"
  assert.deepEqual([...resolveRatings({ ratings: 'safe,r18' })].sort(), [0, 1]);
  assert.deepEqual([...resolveRatings({ allowR18: true })].sort(), [0, 1]);
  assert.deepEqual([...resolveRatings({})], [0]);
  // 标签兜底：xRestrict=1 + R-18G 标签 ⇒ R18G
  assert.equal(ratingOf(items[2]), 2);
  assert.equal(ratingOf(items[1]), 1);
});

check('normalizeRatingTokens：中文「全年龄/R18」也认，规范顺序，脏值丢掉', () => {
  assert.deepEqual(normalizeRatingTokens('全年龄,R18'), ['safe', 'r18']);
  assert.deepEqual(normalizeRatingTokens(['R18G', '全年龄']), ['safe', 'r18g']);
  assert.deepEqual(normalizeRatingTokens('r18g r18 safe'), ['safe', 'r18', 'r18g']);
  assert.deepEqual(normalizeRatingTokens('R-18'), ['r18']);
  assert.deepEqual(normalizeRatingTokens('猎奇'), ['r18g']);
  // ⚠️ 原型链上的键不算有效取值（否则一个乱写的值就能往集合里塞个函数）
  assert.deepEqual(normalizeRatingTokens('constructor'), []);
  assert.deepEqual(normalizeRatingTokens('__proto__'), []);
  assert.deepEqual(normalizeRatingTokens(''), []);
  assert.deepEqual(normalizeRatingTokens(null), []);
});

check('pickUnseen：跳过已发、按收藏数降序、从前 N 随机、全发过返回 null', () => {
  const items = [
    { pid: 'a', bookmarks: 10 },
    { pid: 'b', bookmarks: 500 },
    { pid: 'c', bookmarks: 300 },
    { pid: 'd', bookmarks: NaN },
    { pid: 'e', bookmarks: 50 }
  ];
  // 已发过的 a、b 要被跳过
  const seen = new Set(['a', 'b']);
  assert.equal(pickUnseen(items, seen, 5, () => 0).pid, 'c');        // 剩下的最高收藏
  assert.equal(pickUnseen(items, seen, 2, () => 0.999).pid, 'e');    // 前 2 里随机取第 2 个
  assert.equal(pickUnseen(items, seen, 2, () => 0).pid, 'c');
  // 收藏数缺失（NaN）排在最后
  assert.equal(pickUnseen(items, new Set(['a', 'b', 'c', 'e']), 5, () => 0).pid, 'd');
  // 全发过 → null
  assert.equal(pickUnseen(items, new Set(items.map((x) => x.pid)), 5), null);
  assert.equal(pickUnseen([], new Set(), 5), null);
});

check('buildTryList：备选张数 = need + extra，且已发/已拉黑的 pid 不进队列', () => {
  const items = ['1', '2', '3', '4', '5', '6'].map((pid, i) => ({ pid, bookmarks: 100 - i }));
  const list = buildTryList(items, new Set(), 2, 1, 3, () => 0);
  assert.equal(list.length, 4);                       // 1 张要发的 + 3 张备选
  assert.deepEqual([...new Set(list.map((x) => x.pid))].length, list.length);   // 不重复
  assert.equal(buildTryList(items, new Set(), 2, 2, 1, () => 0).length, 3);
  // 池子比 need+extra 小就只给池子里的
  assert.equal(buildTryList(items.slice(0, 2), new Set(), 2, 1, 3, () => 0).length, 2);
  // 全被排除 → 空
  assert.deepEqual(buildTryList(items, new Set(items.map((x) => x.pid)), 2, 1, 3, () => 0), []);
});

check('extractPid：从各种 pixiv 链接里抠 pid', () => {
  assert.equal(extractPid('https://www.pixiv.net/artworks/12345678'), '12345678');
  assert.equal(extractPid('https://www.pixiv.net/i/12345678'), '12345678');
  assert.equal(extractPid('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=12345678'), '12345678');
  assert.equal(extractPid('https://pixiv.re/12345678.png'), '12345678');
  assert.equal(extractPid('https://i.pixiv.re/12345678.jpg'), '12345678');
  assert.equal(extractPid('https://i.pximg.net/img-original/img/2024/01/02/03/04/05/12345678_p0_master1200.jpg'), '12345678');
  assert.equal(extractPid('12345678'), '12345678');
  assert.equal(extractPid(12345678), '12345678');
  // 认不出来就返回空串（不猜）
  assert.equal(extractPid(''), '');
  assert.equal(extractPid('嗯，来张图'), '');
  assert.equal(extractPid('https://example.com/abc'), '');
  assert.equal(extractPid('1234'), '');                        // 太短：不像 PID
  assert.equal(extractPid('12345678 和 87654321'), '');        // 多个数字：不猜
});

check('ownerIdSet：逗号 / 中文逗号 / 顿号 / 空格都当分隔符，旧字段 adminIds 兼容', () => {
  assert.deepEqual([...ownerIdSet({ ownerIds: '1,2' })], ['1', '2']);
  assert.deepEqual([...ownerIdSet({ ownerIds: '1，2' })], ['1', '2']);
  assert.deepEqual([...ownerIdSet({ ownerIds: '1、2 3' })], ['1', '2', '3']);
  assert.deepEqual([...ownerIdSet({ ownerIds: ' 1 ,, 2 ' })], ['1', '2']);
  // ownerIds 为空时回落到旧字段
  assert.deepEqual([...ownerIdSet({ ownerIds: '', adminIds: '9' })], ['9']);
  assert.deepEqual([...ownerIdSet({ adminIds: '9' })], ['9']);
  assert.deepEqual([...ownerIdSet({})], []);
  assert.deepEqual([...ownerIdSet()], []);
  // DEFAULTS 里**刻意留空**：原作者那份把默认值写成了他自己的号（2624585744），
  // 照搬的实际效果是"你的号改不了分级、而一个陌生人的号可以改"。分级意味着"可能往某个群
  // 发成人内容"，这个决定只该由使用者自己做 —— 没填就谁也改不了。
  assert.deepEqual([...ownerIdSet(internals.DEFAULTS)], [],
    'ownerIds 默认必须是空的，不许兜任何具体 QQ 号');
});

check('resolveProxyUrl：设置优先，留空回退环境变量', () => {
  assert.equal(resolveProxyUrl({ proxyUrl: 'http://127.0.0.1:7890' }, {}), 'http://127.0.0.1:7890');
  assert.equal(resolveProxyUrl({}, { HTTPS_PROXY: 'http://a:1' }), 'http://a:1');
  assert.equal(resolveProxyUrl({}, { all_proxy: 'http://b:2' }), 'http://b:2');
  assert.equal(resolveProxyUrl({ proxyUrl: '  ' }, {}), '');
  assert.equal(resolveProxyUrl({}, {}), '');
  // 设置里的值优先于环境变量
  assert.equal(resolveProxyUrl({ proxyUrl: 'http://cfg:1' }, { HTTPS_PROXY: 'http://env:2' }), 'http://cfg:1');
});

// ── ② latestCaller / callerMayChangeRating ────────────────────────────────

check('latestCaller：取最近一条别人发的消息；只有自己说过 / 取不到时返回空 callerId', () => {
  const ctx = {
    chatKey: 'group:12345',
    recent: (limit) => {
      assert.equal(limit, 6, '门面的 recent(limit) 要按原版语义传 6');
      return [
        { senderId: '7', senderName: '阿花', self: false, text: '早' },
        { senderId: '999', senderName: '小鲸鱼', self: true, text: '（我自己说的）' },
        { senderId: '8', senderName: '小刚', self: false, text: '来张初音ミク的图' }
      ];
    }
  };
  const caller = latestCaller(ctx);
  assert.equal(caller.callerId, '8');       // 最近一条**别人**发的，跳过 self:true
  assert.equal(caller.callerName, '小刚');

  // 本会话只有机器人自己说过话 → 认不出调用者（宁可拒改）
  assert.deepEqual(latestCaller({ recent: () => [{ senderId: '999', self: true }] }), { callerId: '', callerName: '' });
  // 没有 recent 能力（没声明 chat:read）→ 空
  assert.deepEqual(latestCaller({ chatKey: 'group:1' }), { callerId: '', callerName: '' });
  // recent 抛错也不能把工具带崩
  assert.deepEqual(latestCaller({ recent: () => { throw new Error('宿主消息存储不可用'); } }), { callerId: '', callerName: '' });
  assert.deepEqual(latestCaller(null), { callerId: '', callerName: '' });
});

check('callerMayChangeRating：主人在名单里 → 放行；不在名单且没有 api.capability → 拒绝并给出原因', async () => {
  const ownerCtx = { recent: () => [{ senderId: '10001', senderName: '主人', self: false }] };
  const allowed = await callerMayChangeRating(ownerCtx, { ownerIds: '10001,10002' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.callerId, '10001');
  assert.equal(allowed.how, '在「主人 QQ」名单里');

  const strangerCtx = { recent: () => [{ senderId: '55555', senderName: '路人', self: false }] };
  const denied = await callerMayChangeRating(strangerCtx, { ownerIds: '10001' });
  assert.equal(denied.ok, false);
  assert.equal(denied.callerId, '55555');
  assert.match(denied.reason, /只有主人能改/);
  // 本宿主没有"主人识别"插件：文案要照实说，别让人以为装了就有
  assert.match(denied.reason, /主人识别/);
  assert.equal(pluginApi.capability, undefined, '本项目的 api 上没有 capability 成员');

  // 认不出说话人 → 一律不放行
  const unknown = await callerMayChangeRating({ recent: () => [] }, { ownerIds: '10001' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /没能确认是谁在说话/);

  // 默认（不给设置）时**谁都不能改**：ownerIds 刻意留空。这条是安全口径 ——
  // 原作者的默认值是他自己的号，照搬会让一个陌生人的号有权改分级。
  const nobody = await callerMayChangeRating(
    { recent: () => [{ senderId: '2624585744', self: false }] }, internals.DEFAULTS
  );
  assert.equal(nobody.ok, false, '默认留空时，连原作者那个号也不该放行');
  assert.match(nobody.reason, /只有主人能改/);
  // 填上自己的号之后才放行 —— README §2 要求的那一步
  const mineNow = await callerMayChangeRating(
    { recent: () => [{ senderId: '2624585744', self: false }] },
    { ...internals.DEFAULTS, ownerIds: '2624585744' }
  );
  assert.equal(mineNow.ok, true);
});

// ── ③ internals 的 seam ───────────────────────────────────────────────────

check('internals：状态文件写在注入的状态目录里，PID 索引能落盘并读回，超上限按时间淘汰', () => {
  const dir = mkTemp('qq-pixiv-state-');
  internals.__setStateDir(dir);
  assert.equal(internals.__stateDir(), dir);
  assert.equal(internals.__stateFile(), path.join(dir, 'state.json'));
  assert.equal(internals.__chatRatingsFile(), path.join(dir, 'chat-ratings.json'));

  internals.__setState([], []);
  internals.__markSeen('12345678', 1000);
  internals.__markDead('87654321', 2000);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(written.seen['12345678'], 1000);
  assert.equal(written.dead['87654321'], 2000);
  // 生效中的拉黑集合（deadTtlDays 默认 7 天，用 now=2001 一定还在）
  assert.deepEqual([...deadSet(2001)], ['87654321']);

  // 清空内存后重新读盘 —— 证明它是真的落盘了，不是只改了内存
  internals.__setState([], []);
  internals.__loadState();
  assert.deepEqual([...internals.__getSeen().keys()], ['12345678']);
  assert.deepEqual([...internals.__getDead().keys()], ['87654321']);

  // 发送成功会撤掉拉黑（同一个 pid 之前取不到、这次取到了）
  internals.__markSeen('87654321', 3000);
  assert.equal(internals.__getDead().has('87654321'), false);

  // 超出 stateCap（默认 2000）时按时间戳淘汰最旧的
  const many = [];
  for (let i = 0; i < 2001; i += 1) many.push([String(10000000 + i), 1000 + i]);
  internals.__setState(many, []);
  internals.__saveState();
  assert.equal(internals.__getSeen().size, 2000);
  assert.equal(internals.__getSeen().has('10000000'), false, '最旧的那条应被淘汰');
  assert.equal(internals.__getSeen().has('10002000'), true, '最新的那条要留着');

  // 没有状态目录时**绝不落盘**（否则 path.dirname('') === '.'，会写进进程的 cwd）
  internals.__setStateDir('');
  internals.__setState([], []);
  assert.equal(internals.__markSeen('1', 1), undefined);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'state.json')), false);
  // 临时图片目录也在状态目录之下，没有状态目录就没法建
  assert.throws(() => internals.__tempDir(), /状态目录还没初始化/);
});

check('internals：按会话分级写在状态目录的 chat-ratings.json 里，坏条目只忽略不炸', () => {
  const dir = mkTemp('qq-pixiv-ratings-');
  internals.__setStateDir(dir);
  internals.__resetChatRatingsCache();
  assert.equal(internals.__chatRatingsFile(), path.join(dir, 'chat-ratings.json'));

  assert.deepEqual(internals.setChatRating('group:123', ['safe', 'r18']), { ok: true, tokens: ['safe', 'r18'] });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat-ratings.json'), 'utf8'));
  assert.deepEqual(raw, { 'group:123': ['safe', 'r18'] });
  assert.deepEqual(internals.chatRatingOf('group:123'), ['safe', 'r18']);
  assert.equal(internals.chatRatingOf('group:999'), null);

  // 覆盖优先于全局：全局只允许 safe，本会话放宽到 r18
  const eff = ratingsForChat('group:123', { ratings: ['safe'] });
  assert.equal(eff.source, 'chat');
  assert.deepEqual(eff.tokens, ['safe', 'r18']);
  assert.deepEqual([...eff.allowed].sort(), [0, 1]);

  // 坏条目（不认识的取值）只忽略那一条并告警，别的会话照常
  fs.writeFileSync(path.join(dir, 'chat-ratings.json'), JSON.stringify({ 'group:123': ['safe'], 'group:456': ['不存在'] }), 'utf8');
  internals.__resetChatRatingsCache();
  assert.deepEqual(Object.keys(internals.loadChatRatings()), ['group:123']);

  // 清除覆盖 → 回落全局
  internals.__resetChatRatingsCache();
  assert.deepEqual(internals.setChatRating('group:999', ['r18g']), { ok: true, tokens: ['r18g'] });
  assert.deepEqual(internals.clearChatRating('group:999'), { ok: true, had: true });
  assert.equal(ratingsForChat('group:999', { ratings: ['safe'] }).source, 'global');
  // 没给有效分级时明确报错，而不是静默存个空
  assert.equal(internals.setChatRating('group:1', []).ok, false);
  assert.equal(internals.setChatRating('', ['safe']).ok, false);
});

check('describeFetchError：超时与代理不可用给出可读文案，别的错误原样返回', () => {
  const timeout = describeFetchError(new Error('This operation was aborted'), 15000, 'http://127.0.0.1:7890', 'https://www.pixiv.net/ajax/x');
  assert.match(timeout, /请求超时：15 秒内没有任何响应/);
  assert.match(timeout, /已走代理 http:\/\/127\.0\.0\.1:7890/);
  assert.match(timeout, /（www\.pixiv\.net）/);
  assert.match(timeout, /大陆直连 pixiv 不通/);

  const refused = describeFetchError(new Error('connect ECONNREFUSED 127.0.0.1:7890'), 15000, 'http://127.0.0.1:7890', 'https://api.lolicon.app/setu/v2');
  assert.match(refused, /连接失败/);
  assert.match(refused, /代理没开、端口写错/);
  assert.match(refused, /（api\.lolicon\.app）/);
  // 谁不通就说谁：第三方接口不能套 pixiv 的那句原因
  assert.doesNotMatch(refused, /大陆直连 pixiv/);

  // 同一个错误、不同目标：pixiv 会给出"需要代理"，第三方接口给的是另一个原因
  const thirdParty = describeFetchError(new Error('This operation was aborted'), 20000, '', 'https://api.lolicon.app/setu/v2');
  assert.match(thirdParty, /请求超时：20 秒内没有任何响应/);
  assert.match(thirdParty, /这个接口连不上/);
  assert.match(thirdParty, /（当前是直连）/);
  assert.doesNotMatch(thirdParty, /大陆直连 pixiv/);

  const dns = describeFetchError(new Error('getaddrinfo ENOTFOUND www.pixiv.net'), 15000, '', 'https://www.pixiv.net/x');
  assert.match(dns, /域名解析失败/);
  assert.match(dns, /DNS 可能被污染/);
  assert.match(dns, /（当前是直连）/);

  // 不是连接类错误就原样返回
  assert.equal(describeFetchError(new Error('api.lolicon.app HTTP 403')), 'api.lolicon.app HTTP 403');
});

check('internals：熔断与 pixiv.net 直连冷却的状态机', () => {
  internals.__resetBreaker();
  assert.deepEqual(breakerState(1000), { open: false, retryAfterSec: 0, streak: 0 });
  internals.__noteNetFailure(1000);
  internals.__noteNetFailure(1001);
  assert.equal(breakerState(1002).open, false);
  internals.__noteNetFailure(1003);                 // 第 3 次连接级失败 → 熔断
  const open = breakerState(1004);
  assert.equal(open.open, true);
  assert.ok(open.retryAfterSec > 0);
  // 冷却 5 分钟，之后自动恢复
  assert.equal(breakerState(1004 + 5 * 60 * 1000 + 1).open, false);
  internals.__resetBreaker();
  assert.equal(internals.pixivDirectCoolingDown(1000), false);
  internals.__setPixivDirectFailAt(2000);
  assert.equal(internals.pixivDirectCoolingDown(2001), true);
  assert.equal(internals.pixivDirectCoolingDown(2000 + 10 * 60 * 1000 + 1), false);
  internals.__resetBreaker();
});

// ── ④ 门面契约 ────────────────────────────────────────────────────────────

check('activate：注册的工具名与 manifest.tools 完全相等（多一个少一个都会被装载器拒绝）', () => {
  assert.deepEqual([...registered.keys()].sort(), pluginToolNames);
  assert.deepEqual(pluginToolNames, ['pixiv_image', 'pixiv_set_rating']);
  // 每个工具都得有 description / parameters / execute —— 装载器的 registerTool 会逐条校验
  for (const [name, def] of registered) {
    assert.ok(String(def.description || '').trim().length > 0, `${name} 缺少 description`);
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.execute, 'function');
  }
  // 移植要求：模型看到的函数名用原来的 id，name/category/icon 不再传
  assert.equal(registered.has('pixiv_image'), true);
  assert.equal(registered.has('set_rating'), false, '工具名必须是全宿主唯一的 pixiv_set_rating');
  // 分级那段"教模型"的指令（原 manifest 的 prompt.sections）折进了工具描述
  assert.match(registered.get('pixiv_set_rating').description, /按会话/);
  assert.match(registered.get('pixiv_set_rating').description, /只有主人能改/);
  assert.match(registered.get('pixiv_set_rating').description, /不要.*假装改/);
  // 入口还返回了 deactivate（宿主在同进程重载/退出时调）
  assert.equal(typeof pluginReturned.deactivate, 'function');
  // 原宿主那个探测钩子保留了，但本宿主不会调它
  assert.deepEqual(available(), { ok: true });
});

check('activate 的 stateDir 就是 api.kv.dir（<数据目录>/plugin-state/pixiv-illust）', async () => {
  // 重跑一次 activate：上面的 seam 用例把模块状态目录指到自己的临时目录了，
  // 这里顺便验证"重新激活会把目录指回来"（stateLoaded / chatRatingsCache 都会跟着作废）。
  await activate(pluginApi);
  assert.equal(pluginApi.kv.dir, pluginStateDir(dataDir, 'pixiv-illust'));
  assert.equal(pluginApi.stateDir, pluginApi.kv.dir);
  assert.equal(internals.__stateDir(), pluginApi.kv.dir);
  assert.equal(internals.__stateFile(), path.join(pluginApi.kv.dir, 'state.json'));
  // 没声明 storage 时必须抛错（不假装能持久化），而不是静默记在内存里
  const bare = buildPluginApi({
    manifest: { ...manifest, capabilities: ['chat:read'] },
    config: CONFIG,
    dataDir,
    registerTool: () => {}
  });
  assert.equal(bare.kv, undefined);
  await assert.rejects(() => activate(bare), /缺少 storage 能力/);
  await activate(pluginApi);   // 恢复给后面的用例
});

check('门面收窄：toolCtx 上只有声明过的能力，原始 ctx 的 sender/store/emit 一个都没泄漏', () => {
  const { ctx } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);

  assert.equal(toolCtx.chatKey, 'group:12345');
  assert.deepEqual([...toolCtx.capabilities].sort(), manifest.capabilities);
  assert.equal(typeof toolCtx.sendImage, 'function');
  assert.equal(typeof toolCtx.recent, 'function');
  assert.equal(typeof toolCtx.kv.get, 'function');
  assert.equal(toolCtx.dir, pluginStateDir(dataDir, 'pixiv-illust'));
  // 这些一律不许出现：插件改宿主状态机的入口全在这儿
  for (const key of ['sender', 'store', 'memory', 'onebot', 'emit']) {
    assert.equal(toolCtx[key], undefined, `${key} 泄漏给了插件`);
  }
  assert.equal(toolCtx.session.leaseId, undefined, 'session 只给 {id, rounds} 快照');
  // recent 给的是投影后的对象（带 self 布尔），latestCaller 依赖它
  const entries = toolCtx.recent(5);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].self, false);
  assert.equal(entries[0].senderId, '10001');
});

check('临时图片必须落在插件状态目录之内（否则门面的 sendImage 路径守卫会拒发）', async () => {
  const { ctx, images } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);

  // 把插件的状态目录指到门面认的那个（activate 已经指过一次，这里显式再说一次）
  internals.__setStateDir(toolCtx.dir);
  const tmp = internals.__tempDir();
  const rel = path.relative(toolCtx.dir, tmp);
  assert.equal(rel.startsWith('..'), false, `临时目录越出了状态目录：${tmp}`);
  assert.equal(path.isAbsolute(rel), false);
  assert.equal(fs.existsSync(tmp), true);

  // 状态目录之内的文件能发出去，且走的是 base64:// 约定（本地图片）
  const file = path.join(tmp, 'pixiv_test.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sent = await toolCtx.sendImage({ path: file }, { label: 'Pixiv 12345678 · 标题 · 作者' });
  assert.equal(sent.sent, true);
  assert.equal(images.length, 1);
  assert.equal(images[0].chatKey, 'group:12345');
  assert.match(images[0].payload.url, /^base64:\/\//);
  assert.equal(images[0].payload.label, 'Pixiv 12345678 · 标题 · 作者');

  // 而状态目录之外的文件（宿主自己的 config.json 就是最典型的例子）必须被拒 ——
  // 这条守卫正是"临时图片不能落在 os.tmpdir()"的原因。
  const outside = path.join(dataDir, 'config.json');
  fs.writeFileSync(outside, JSON.stringify({ secret: 'sk-should-never-be-sent' }), 'utf8');
  await assert.rejects(() => toolCtx.sendImage({ path: outside }, {}), /只接受插件自己状态目录里的文件/);
  assert.equal(images.length, 1, '被拒绝的调用不能真的发出图片');

  // 收尾：清理逻辑原样保留（把 mtime 改成 16 分钟前，sweep 应该把它删掉）
  const stale = path.join(tmp, 'stale.png');
  fs.writeFileSync(stale, 'x');
  const old = Date.now() - 16 * 60 * 1000;
  fs.utimesSync(stale, new Date(old), new Date(old));
  internals.__sweepTemp();
  assert.equal(fs.existsSync(stale), false, '超过 15 分钟的临时图应被清掉');
  assert.equal(fs.existsSync(file), true, '刚写的那张要留着（还要发）');
});

check('装载器全流程：带审批 initPlugins → loaded，注入的工具与 manifest 声明完全相等', async () => {
  // 这一条是"acceptance 第 5 步"的固化版：走真正的发现 / 审批比对 / 动态 import /
  // activate / 工具集相等校验。manifest 非法或注册的工具多于/少于声明，这里都会是 failed。
  const result = await initPlugins({
    dataDir,
    config: {
      plugins: {
        roots: [SELF_ROOT],
        enabled: ['pixiv-illust'],
        approved: { 'pixiv-illust': manifestFingerprint(manifest) },
        settings: {}
      }
    },
    builtinToolNames: ['send_message', 'send_sticker', 'web_fetch', 'finish', 'remind'],
    bundledRoot: null
  });
  const status = result.statuses.find((item) => item.id === 'pixiv-illust');
  assert.ok(status, '装载器应该发现 plugins/pixiv-illust');
  assert.equal(status.status, 'loaded', `期望 loaded，实际 ${status.status}：${status.reason}`);
  assert.deepEqual(status.capabilities, ['chat:read', 'chat:send-forward', 'chat:send-image', 'http', 'storage']);
  assert.deepEqual(status.tools, ['pixiv_image', 'pixiv_set_rating']);
  assert.deepEqual(result.toolDefs.map((def) => def.name).sort(), pluginToolNames);
  // 同一个自建根里的另一个插件（my-first-plugin）也在，未启用就是 disabled
  assert.equal(result.statuses.find((item) => item.id === 'my-first-plugin').status, 'disabled');
  await resetPlugins();
});

// ── 多图作品（2026-10-08 第三轮）─────────────────────────────────────────────
//
// 需求：通过 pid 发图时只发第一张，而很多作品是多图的。
// 办法：多图作品每一页的地址只差 `_p<页码>`，而**日期路径在任意一页的地址里都有** ——
// 所以拿到第 0 页的地址就能拼出后面每一页。接口（api.lolicon.app）给了 `p`（这一页的页号）
// 但**不给总页数**，所以张数靠逐页试：页码从 0 连续排，遇到"这一页取不到"就停。

check('parseOriginalPath：原图 / master1200 / square1200 三种形状都要认出来', () => {
  const want = {
    year: '2021', month: '11', day: '13', hour: '12', minute: '46', second: '15',
    pid: '94101307', page: '1', ext: 'jpg'
  };
  // 原图形状
  assert.deepEqual(parseOriginalPath('https://i.pixiv.re/img-original/img/2021/11/13/12/46/15/94101307_p1.jpg'), want);
  // ⚠️ 接口给的是这两种 —— 第一版的正则要求页码后紧跟一个点，于是**只认原图形状**，
  //    多图续页会静默失效（返回空候选、多发不了一页、还不报错）。这条用例专门盯它。
  assert.deepEqual(parseOriginalPath('https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p1_master1200.jpg'), want);
  assert.deepEqual(parseOriginalPath('https://i.pixiv.re/c/250x250_80_a2/img-master/img/2021/11/13/12/46/15/94101307_p1_square1200.jpg'), want);
  assert.equal(parseOriginalPath('https://pixiv.re/94101307.png'), null);
});

check('pageUrlsOf：从任意一页推出别的页（含 master1200 形状与尺寸档）', () => {
  // 这是接口真实返回过的形状（pid 94101307 = 用户实测那条）
  const item = { pid: '94101307', imageUrl: 'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p0_master1200.jpg' };
  assert.equal(pageUrlsOf(item, 1, 'regular')[0],
    'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p1_master1200.jpg');
  assert.equal(pageUrlsOf(item, 2, 'regular')[0],
    'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p2_master1200.jpg');
  // 尺寸档照旧生效（大图传不完就换小的）
  assert.deepEqual(pageUrlsOf(item, 1, 'small'), [
    'https://i.pixiv.re/c/540x540_70/img-master/img/2021/11/13/12/46/15/94101307_p1_master1200.jpg',
    'https://i.pixiv.re/c/250x250_80_a2/img-master/img/2021/11/13/12/46/15/94101307_p1_square1200.jpg'
  ]);
  // 认不出日期路径、也不是后缀形式（pid 位数不对）→ 空数组，调用方据此放弃续页
  assert.deepEqual(pageUrlsOf({ pid: '1', imageUrl: 'https://pixiv.re/1.png' }, 1), []);
  assert.deepEqual(pageUrlsOf({}, 1), []);
});

check('pageUrlsOf：pixiv.re 的页码后缀形式 —— **第 2 张是 -2，不是 -1**', () => {
  // 实测依据（2026-10-08 在用户服务器上量的，别凭直觉改）：
  //   pixiv.re/150374854.png    → 301 → /150374854-1.png
  //   -1.png / -2.png / -3.png  → 200，各约 1.4MB，**三个 md5 都不同**
  // ⇒ 无后缀那个形式拿到的**就是 -1**；所以 -1 是第 1 张（已经发过的那张），第 2 张是 -2。
  // 这条差点写错：光看"-1 是 200、-2 也是 200"很容易以为 -1 是第 2 张。
  const item = { pid: '150374854', imageUrl: 'https://pixiv.re/150374854.png' };
  assert.equal(pageUrlsOf(item, 1)[0], 'https://pixiv.re/150374854-2.png',
    '第 2 张必须是 -2：写成 -1 就会把第 1 张重发一遍');
  assert.equal(pageUrlsOf(item, 2)[0], 'https://pixiv.re/150374854-3.png');
  assert.equal(pageUrlsOf(item, 9)[0], 'https://pixiv.re/150374854-10.png');
  // page=0（= 第 1 张本身）绝不能返回 —— 那是"重复发第一张"的入口
  assert.deepEqual(pageUrlsOf(item, 0), []);
  assert.deepEqual(pageUrlsOf(item, -1), []);

  // 后缀形式只在"路径就是 /{pid}[-n].ext"时成立：带日期目录的完整地址走另一条分支
  assert.equal(parseSuffixPath('https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p0_master1200.jpg'), null);
  assert.deepEqual(parseSuffixPath('https://pixiv.re/150374854-3.png'),
    { origin: 'https://pixiv.re', pid: '150374854', page: 3, ext: 'png' });
  assert.deepEqual(parseSuffixPath('https://pixiv.re/150374854.png'),
    { origin: 'https://pixiv.re', pid: '150374854', page: 1, ext: 'png' });
  assert.equal(parseSuffixPath('不是地址'), null);
});

check('imageCandidates：取第 2 页起必须关掉 PID 模板（否则会重复发第 1 页）', () => {
  const page2 = ['https://i.pixiv.re/img-master/img/2021/11/13/12/46/15/94101307_p1_master1200.jpg'];
  const item = { pid: '94101307', imageUrl: '', imageUrls: page2 };
  // 开模板：多出 `pixiv.re/{pid}.png` —— 那个**只给第 0 页** ✗
  assert.deepEqual(imageCandidates(item, 'https://pixiv.re/{pid}.png'),
    [...page2, 'https://pixiv.re/94101307.png']);
  // 关模板：只剩这一页
  assert.deepEqual(imageCandidates(item, 'https://pixiv.re/{pid}.png', { allowTemplate: false }), page2);
});

check('多图作品：有合并转发能力时打包成**一条**聊天记录（不刷屏）', async () => {
  internals.__setState([], []);            // PID 索引清空（否则这张作品会被当成"已发过"）
  const pid = '94101307';
  const base = 'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15';
  const asked = [];
  const { ctx, images, forwards } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);
  // ⚠️ 状态目录必须用**门面**给的那个（toolCtx.dir）：门面的 sendForward({path}) 有路径守卫，
  //    只接受 pluginStateDir(dataDir, id) 之内的文件。自己 mkdtemp 一个会**每一条都被拒**，
  //    于是回落逐张发 —— 症状看着像"转发没生效"，其实与转发无关。
  internals.__setStateDir(toolCtx.dir);

  await withFetch(
    async (url) => {
      const u = String(url);
      asked.push(u);
      if (u.includes('/setu/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
          async json() {
            return {
              data: [{
                pid: Number(pid), p: 0, title: '多图作品', author: '作者', r18: false,
                tags: ['测试'], ext: 'jpg', urls: { regular: `${base}/${pid}_p0_master1200.jpg` }
              }]
            };
          }
        };
      }
      if (u.includes(`/${pid}_p0_`)) return fakeImageResponse({ contentLength: 1000, body: chunkStream([new Uint8Array(1000)]) });
      if (u.includes(`/${pid}_p1_`)) return fakeImageResponse({ contentLength: 2000, body: chunkStream([new Uint8Array(2000)]) });
      if (u.includes(`/${pid}_p2_`)) return fakeImageResponse({ status: 404 });   // 第 3 页不存在
      throw new Error(`不该请求这个地址：${u}`);
    },
    () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
  );

  assert.equal(forwards.length, 1, '多图作品该走**一条**合并转发');
  assert.equal(images.length, 0, '走转发时不该再逐张发（否则等于既刷屏又多一条）');
  const nodes = forwards[0].payload.nodes;
  assert.equal(nodes.length, 3, '一条说明 + 两张图 = 3 个 node');
  assert.match(nodes[0].data.content[0].data.text, /有 2 页/, '第一个 node 说明这个作品有几页');
  assert.equal(nodes[1].data.content[0].type, 'image');
  assert.equal(nodes[2].data.content[0].type, 'image');
  assert.equal(nodes[1].data.name, '小鲸鱼', '显示名由宿主填');
  // 遇到"这一页不存在"必须**立刻停**：不然后面每一页都要白等一整个超时
  assert.ok(!asked.some((one) => one.includes(`/${pid}_p3_`)),
    `第 3 页已经 404，不该再去试第 4 页。实际请求过：${asked.filter((one) => one.includes('_p')).join(', ')}`);
  assert.ok(!asked.some((one) => one.includes('pixiv.re/94101307.png')),
    '绝不该请求 PID 模板（那会重复发第 1 页）');
});

check('给 pid 那条路：用 `-2`/`-3` 续页并打包成一条卡片，且**绝不碰 -1**', async () => {
  internals.__setState([], []);
  const pid = '150374854';
  const asked = [];
  const { ctx, images, forwards } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);
  internals.__setStateDir(toolCtx.dir);

  await withFetch(
    async (url, options) => {
      const u = String(url);
      asked.push({ url: u, redirect: options?.redirect });
      // 第一步是那次"读 301"的探测：这里故意不给 location（就是线上那次 HTTP 200 的现场）
      if (options?.redirect === 'manual') {
        return { ok: true, status: 200, headers: { get: () => null }, body: null };
      }
      if (u === `https://pixiv.re/${pid}.png`) {
        return fakeImageResponse({ contentLength: 1000, body: chunkStream([new Uint8Array(1000)]) });
      }
      if (u.endsWith(`/${pid}-2.png`)) {
        return fakeImageResponse({ contentLength: 2000, body: chunkStream([new Uint8Array(2000)]) });
      }
      if (u.endsWith(`/${pid}-3.png`)) return fakeImageResponse({ status: 404 });   // 只有两页
      throw new Error(`不该请求这个地址：${u}`);
    },
    () => registered.get('pixiv_image').execute(toolCtx, { pid })
  );

  const got = asked.filter((one) => one.redirect !== 'manual').map((one) => one.url);
  assert.deepEqual(got, [
    `https://pixiv.re/${pid}.png`,     // 第 1 张
    `https://pixiv.re/${pid}-2.png`,   // 第 2 张
    `https://pixiv.re/${pid}-3.png`    // 探测到 404 就停
  ], `续页地址必须从 -2 起、并在 404 处停，实际：${got.join(' , ')}`);
  // ★ 这条是本次改动的核心哨兵：`-1` 就是第 1 张，请求它 = 重复发图
  assert.ok(!asked.some((one) => one.url.endsWith(`/${pid}-1.png`)),
    '绝不该请求 -1.png —— 那是第 1 张（无后缀形式拿到的就是它）');
  assert.equal(forwards.length, 1, '两页 → 打包成一条「聊天记录」');
  assert.equal(images.length, 0);
  assert.equal(forwards[0].payload.nodes.length, 3, '说明 + 两张图');
});

check('续页预算：日志里必须打**真正生效的那个**预算值（不是写死的 12MB）', async () => {
  // 现场教训（2026-10-08，服务器日志）：预算是可配的（现场配的 4MB），而这条收手日志
  // 写死成"（合并转发上限 12MB）" → 一边说"已 10MB"一边说"上限 12MB"，
  // 跟"生效设置：… 卡片预算=4.0MB"那行**自相矛盾**，排查时被带偏过。
  internals.__setState([], []);
  const pid = '77700001';
  const pageBase = 'https://i.pixiv.re/img-master/img/2024/04/04/04/04/04';
  const { ctx, forwards } = fakeHostCtx();
  const sink = fakeLogger();
  const budget = 1536 * 1024;   // 1.5MB：故意取一个**不等于默认值**的数，写死就必然对不上
  const toolCtx = makeToolCtx(ctx);
  internals.__setStateDir(toolCtx.dir);

  // ⚠️ 插件日志走的是**激活时绑定的** api.log，生效设置读的也是**激活时绑定的** api.config
  //    （不是 toolCtx 上的那份）—— 所以两样都得用测试缝注入，否则这条用例会静默地
  //    跑在默认值上（第一次就是这么踩的：注入的 1.5MB 根本没生效，4 页全收了）。
  __setLogSinkForTest((level, message) => sink.lines.push(`${level}:${message}`));
  __setSettingsForTest({ maxCount: 1, maxPages: 10, forwardBudgetBytes: budget });
  try {
    await withFetch(
      async (url) => {
        const u = String(url);
        if (u.includes('/setu/v2')) {
          return {
            ok: true,
            status: 200,
            headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
            async json() {
              return {
                data: [{
                  pid: Number(pid), p: 0, title: '大图多页', author: '作者', r18: false,
                  tags: ['测试'], ext: 'jpg', urls: { regular: `${pageBase}/${pid}_p0_master1200.jpg` }
                }]
              };
            }
          };
        }
        // 每页 900KB：默认 4MB 预算下装得下 4 页（不会收手），1.5MB 预算下第 2 页就该收手
        if (/_p\d+_/.test(u)) {
          return fakeImageResponse({ contentLength: 900 * 1024, body: chunkStream([new Uint8Array(900 * 1024)]) });
        }
        return fakeImageResponse({ status: 404 });
      },
      () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
    );
  } finally {
    __setLogSinkForTest(null);
    __setSettingsForTest(null);
  }

  const text = sink.all();
  // 预算按**一位小数**打（1.5MB 被四舍五入成"2MB"就是在骗人）
  assert.match(text, /预算 1\.5MB/,
    `收手日志必须打实际生效的预算（1.5MB），实际日志：\n${text}`);
  assert.doesNotMatch(text, /12MB/,
    `绝不能再出现写死的 12MB —— 它与"生效设置"那行自相矛盾。实际日志：\n${text}`);
  // 收手确实发生了（不然上面那条可能是在空跑）
  assert.match(text, /就发前 1 页/,
    `首页 900KB、预算 1.5MB 时，第 2 页（会到 1.8MB）就该被拦下。实际日志：\n${text}`);
  assert.equal(forwards.length, 0, '只发了 1 页时不套卡片（走逐张发那条路）');
});

check('续页预算：首页自己就顶过预算时，也要明确说一句（不许一声不响只发一页）', async () => {
  // 边界：把预算配得比单页还小（或首页特别大）时，续页循环的第一条判据就直接 break ——
  // 原来**什么日志都不打**，于是"只发了一页"看起来像正常（没有续页机会），
  // 而不是"被预算拦了"。用户要查"为什么只有一页"时完全没有线索。
  internals.__setState([], []);
  const pid = '77700002';
  const pageBase = 'https://i.pixiv.re/img-master/img/2024/04/05/04/04/04';
  const { ctx, forwards } = fakeHostCtx();
  const sink = fakeLogger();
  const toolCtx = makeToolCtx(ctx);
  internals.__setStateDir(toolCtx.dir);

  __setLogSinkForTest((level, message) => sink.lines.push(`${level}:${message}`));
  __setSettingsForTest({ maxCount: 1, maxPages: 10, forwardBudgetBytes: 512 * 1024 });   // 0.5MB
  try {
    await withFetch(
      async (url) => {
        const u = String(url);
        if (u.includes('/setu/v2')) {
          return {
            ok: true,
            status: 200,
            headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
            async json() {
              return {
                data: [{
                  pid: Number(pid), p: 0, title: '超大首页', author: '作者', r18: false,
                  tags: ['测试'], ext: 'jpg', urls: { regular: `${pageBase}/${pid}_p0_master1200.jpg` }
                }]
              };
            }
          };
        }
        // 单页 2MB，已经是 0.5MB 预算的 4 倍
        if (/_p\d+_/.test(u)) {
          return fakeImageResponse({ contentLength: 2 * 1024 * 1024, body: chunkStream([new Uint8Array(2 * 1024 * 1024)]) });
        }
        return fakeImageResponse({ status: 404 });
      },
      () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
    );
  } finally {
    __setLogSinkForTest(null);
    __setSettingsForTest(null);
  }

  const text = sink.all();
  assert.match(text, /图片合计已 2\.0MB（卡片预算 0\.5MB），不再续页/,
    `首页就超预算时必须明确说是预算拦的，实际日志：\n${text}`);
  assert.equal(forwards.length, 0, '只有一页 → 不套卡片');
});

check('单图作品：就算有转发能力也**不要**套一层卡片（一张图不值得）', async () => {
  internals.__setState([], []);
  const pid = '55500001';
  const base = 'https://i.pixiv.re/img-master/img/2022/02/02/02/02/02';
  const { ctx, images, forwards } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);
  internals.__setStateDir(toolCtx.dir);

  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/setu/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
          async json() {
            return {
              data: [{
                pid: Number(pid), p: 0, title: '单图作品', author: '作者', r18: false,
                tags: ['测试'], ext: 'jpg', urls: { regular: `${base}/${pid}_p0_master1200.jpg` }
              }]
            };
          }
        };
      }
      if (u.includes(`/${pid}_p0_`)) return fakeImageResponse({ contentLength: 500, body: chunkStream([new Uint8Array(500)]) });
      if (u.includes(`/${pid}_p1_`)) return fakeImageResponse({ status: 404 });   // 只有一页
      throw new Error(`不该请求这个地址：${u}`);
    },
    () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
  );

  assert.equal(forwards.length, 0, '单页作品不该为了一张图套一层"聊天记录"');
  assert.equal(images.length, 1);
  assert.equal(images[0].payload.bytes, 500);
});

check('多图作品：宿主没有合并转发能力时，回落逐张发（一张都不丢）', async () => {
  internals.__setState([], []);
  const pid = '94101307';
  const base = 'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15';
  const { ctx, images, forwards } = fakeHostCtx();
  // 模拟**旧宿主**：门面上没有 sendForward（能力没声明/宿主版本老）
  const toolCtx = { ...makeToolCtx(ctx) };
  delete toolCtx.sendForward;
  internals.__setStateDir(toolCtx.dir);

  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/setu/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
          async json() {
            return {
              data: [{
                pid: Number(pid), p: 0, title: '多图作品', author: '作者', r18: false,
                tags: ['测试'], ext: 'jpg', urls: { regular: `${base}/${pid}_p0_master1200.jpg` }
              }]
            };
          }
        };
      }
      if (u.includes(`/${pid}_p0_`)) return fakeImageResponse({ contentLength: 1000, body: chunkStream([new Uint8Array(1000)]) });
      if (u.includes(`/${pid}_p1_`)) return fakeImageResponse({ contentLength: 2000, body: chunkStream([new Uint8Array(2000)]) });
      if (u.includes(`/${pid}_p2_`)) return fakeImageResponse({ status: 404 });
      throw new Error(`不该请求这个地址：${u}`);
    },
    () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
  );

  assert.equal(forwards.length, 0, '没有能力就不该用转发');
  assert.equal(images.length, 2, '回落逐张发：两张都要发出去，一张都不能丢');
  assert.equal(images[0].payload.bytes, 1000);
  assert.equal(images[1].payload.bytes, 2000);
  assert.match(images[1].payload.label, /第 2 页/);
});

check('多图作品：转发失败（协议端不支持那个 action）时也回落逐张发', async () => {
  internals.__setState([], []);
  const pid = '94101307';
  const base = 'https://i.pixiv.re/img-master/img/2021/11/13/12/46/15';
  const { ctx, images } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);
  // 门面上有 sendForward，但它一调就抛（协议端不认这个 action 的现场）
  toolCtx.sendForward = async () => { throw new Error('OneBot send_group_forward_msg 失败: unsupported action'); };
  internals.__setStateDir(toolCtx.dir);

  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/setu/v2')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
          async json() {
            return {
              data: [{
                pid: Number(pid), p: 0, title: '多图作品', author: '作者', r18: false,
                tags: ['测试'], ext: 'jpg', urls: { regular: `${base}/${pid}_p0_master1200.jpg` }
              }]
            };
          }
        };
      }
      if (u.includes(`/${pid}_p0_`)) return fakeImageResponse({ contentLength: 1000, body: chunkStream([new Uint8Array(1000)]) });
      if (u.includes(`/${pid}_p1_`)) return fakeImageResponse({ contentLength: 2000, body: chunkStream([new Uint8Array(2000)]) });
      if (u.includes(`/${pid}_p2_`)) return fakeImageResponse({ status: 404 });
      throw new Error(`不该请求这个地址：${u}`);
    },
    () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
  );

  assert.equal(images.length, 2, '转发失败必须回落，否则一条卡片失败就一张图都发不出去');
  assert.equal(images[0].payload.bytes, 1000);
  assert.equal(images[1].payload.bytes, 2000);
});

// ── 5MB→1.3MiB 那个上限、以及"给 pid 时推出尺寸版"（2026-10-08 第二轮）────────
//
// 现场：一张 3.6MB 的图**下载成功**却在发送时报 `fetch failed`，日志里没有任何线索。
// 查下来是协议端对 HTTP 请求体有 **2MB** 硬上限（实测 1.5MB 正常、2MB 起直接断连，
// 报 UND_ERR_SOCKET），而图片是 base64 进 JSON body 的（膨胀 1.37 倍）。

check('maxImageBytes 默认值：不再压着（宿主已把大 body 改走 WS，那条路不再怕大图）', () => {
  assert.equal(internals.DEFAULTS.maxImageBytes, 5 * 1024 * 1024);
  assert.ok(internals.DEFAULTS.maxImageBytes > 1024 * 1024, '别小到把正常的 regular 也拦掉');
  // 这个值曾被压到 1.3MiB —— 那是"协议端 HTTP 请求体 2MiB 上限"逼出来的临时对策。
  // 宿主把超过 1.5MiB 的调用改走 WebSocket 之后，大图能发了，就不该再压着：
  // 压着只会让 3.6MB 那种原图被无谓拒掉。留个下限防止以后又被谁压回去。
  assert.ok(internals.DEFAULTS.maxImageBytes >= 4 * 1024 * 1024,
    '宿主已支持大 body（WS 通道），别再压到几 MB 以下');
});

check('parseOriginalPath / sizeUrlsFromOriginal：拼出来的与接口给过的形状逐字节相同', () => {
  const orig = 'https://i.pixiv.re/img-original/img/2022/11/20/22/05/11/102960701_p0.jpg';
  assert.deepEqual(parseOriginalPath(orig), {
    year: '2022', month: '11', day: '20', hour: '22', minute: '05', second: '11',
    pid: '102960701', page: '0', ext: 'jpg'
  });
  // 下面这三个 URL 是 api.lolicon.app 在 size=regular/small/thumb 下**原样返回过**的
  // （从这台服务器上抓下来的），所以这是一条"与外部事实对齐"的断言，不是自说自话。
  assert.deepEqual(sizeUrlsFromOriginal(orig, 'regular'), [
    'https://i.pixiv.re/img-master/img/2022/11/20/22/05/11/102960701_p0_master1200.jpg',
    'https://i.pixiv.re/c/540x540_70/img-master/img/2022/11/20/22/05/11/102960701_p0_master1200.jpg',
    'https://i.pixiv.re/c/250x250_80_a2/img-master/img/2022/11/20/22/05/11/102960701_p0_square1200.jpg'
  ]);
  assert.equal(sizeUrlsFromOriginal(orig, 'small')[0],
    'https://i.pixiv.re/c/540x540_70/img-master/img/2022/11/20/22/05/11/102960701_p0_master1200.jpg');
  assert.equal(sizeUrlsFromOriginal(orig, 'original')[0], orig, 'original 档给的就是 301 的目标本身');

  // 多图作品的页码要跟着走（第 2 页不能被换成第 0 页）
  const p2 = 'https://i.pximg.net/img-original/img/2023/01/02/03/04/05/123_p2.png';
  assert.match(sizeUrlsFromOriginal(p2, 'regular')[0], /123_p2_master1200\.jpg$/);
  // 认不出就返回空 —— 不猜、不乱拼地址
  assert.deepEqual(sizeUrlsFromOriginal('https://x/y.png'), []);
  assert.equal(parseOriginalPath('https://x/y.png'), null);
  assert.deepEqual(sizeUrlsFromOriginal(''), []);
  assert.deepEqual(sizeUrlsFromOriginal(null), []);
});

check('给 pid 那条路：用 301 的 Location 推出尺寸版，绝不请求原图地址', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-301-')));
  const orig = 'https://i.pixiv.re/img-original/img/2022/11/20/22/05/11/102960701_p0.jpg';
  const calls = [];
  const got = await withFetch(
    async (url, options) => {
      calls.push({ url: String(url), method: options?.method, redirect: options?.redirect });
      // 探测与真下载都是 GET，靠 redirect 区分：探测必须是 manual（不跟随重定向）
      if (options?.redirect === 'manual') {
        // 模拟 pixiv.re/{pid}.png 的 301：manual 模式下 location 可读（实测 Node 可以）
        return {
          ok: false,
          status: 301,
          headers: { get: (n) => (String(n).toLowerCase() === 'location' ? orig : null) },
          body: null
        };
      }
      if (String(url).includes('/img-master/')) {
        return fakeImageResponse({ contentLength: 4, body: chunkStream([new Uint8Array([7, 7, 7, 7])]) });
      }
      throw new Error(`不该请求这个地址：${url}`);
    },
    () => internals.__fetchImage({ pid: '102960701' }, { ...internals.DEFAULTS, timeoutMs: 3000 })
  );

  assert.equal(calls[0].method, 'GET', '第一步用 GET（HEAD 会被一些反代 405 掉、也不回 Location）');
  assert.equal(calls[0].redirect, 'manual', '必须 manual：跟随重定向就会去请求卡住的原图地址');
  assert.ok(calls[0].url.endsWith('pixiv.re/102960701.png'), `第一步该探测模板地址，实际 ${calls[0].url}`);
  assert.ok(calls[1].url.includes('/img-master/'), `第二步该是尺寸版，实际 ${calls[1].url}`);
  assert.ok(!calls.some((one) => one.url.includes('/img-original/')),
    '绝不该请求原图地址 —— 那是十几 MB，也正是这次故障的来源');
  assert.equal(got.bytes, 4);
  assert.equal(got.downsized, false, '4 字节的假图远在阈值之内，不该被降采样（否则这条用例量的就不是取图了）');
});

check('给 pid 那条路：推不出来（没有 Location）时照旧退回模板，不报错', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-noloc-')));
  const calls = [];
  const got = await withFetch(
    async (url, options) => {
      calls.push(String(url));
      if (options?.redirect === 'manual') return { ok: true, status: 200, headers: { get: () => null }, body: null };
      return fakeImageResponse({ contentLength: 3, body: chunkStream([new Uint8Array([1, 2, 3])]) });
    },
    () => internals.__fetchImage({ pid: '4242' }, { ...internals.DEFAULTS, timeoutMs: 3000 })
  );
  assert.equal(got.bytes, 3, '没有 Location 时模板仍然要能用');
  assert.equal(got.downsized, false, '3 字节的假图不该被降采样');
  assert.ok(calls.some((one) => one.endsWith('pixiv.re/4242.png')), '回到模板地址');
});

check('给 pid 那条路：探测失败不计入熔断（否则三次取图就把插件停 5 分钟）', async () => {
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-quiet-')));
  internals.__resetBreaker();
  try {
    // ⚠️ 这里必须让**所有**请求都失败才能验出来：如果只是 HEAD 失败、后面的模板取图成功，
    //    成功会把计数清零（noteNetSuccess），于是"有没有 quiet"结果都一样 —— 用例就成了空跑
    //    （第一版就是这么写的，是靠变异测试才发现的）。
    await withFetch(
      async () => {
        const e = new Error('fetch failed');
        e.cause = { code: 'ECONNRESET' };
        throw e;
      },
      async () => {
        try {
          await internals.__fetchImage({ pid: '1' }, { ...internals.DEFAULTS, timeoutMs: 3000 });
        } catch { /* 全失败是这条用例的预期 */ }
      }
    );
    // HEAD 探测 + 模板取图各失败一次。只有后者该计数 → 1；HEAD 也计就是 2。
    assert.equal(breakerState().streak, 1, '只该记模板那一次失败，探测性 HEAD 不算');
  } finally {
    internals.__resetBreaker();
  }
});

// ── ④ 降采样（2026-10-08 第四轮：让 4MB 的卡片装得下 10+ 页）──────────────────
//
// 需求：每页下完后，超过 ~800KB 就缩成"最长边 1200px 的 JPEG"（~300KB）再发，
// 让 4MB 的卡片预算从"3 页"变成"10+ 页"。
//
// 用例分工（仓库惯例"缺件跳过"）：
//   · **纯逻辑**（阈值、滤镜、回落分支）不依赖 ffmpeg，**永远跑**；
//   · **真压缩**那三条要有 ffmpeg 才跑，没有就 skip（`node --test` 会记成 skipped）；
//   · **回落**单独一条：用假的 spawn 造"ffmpeg 起不来"，**在任何机器上都能跑**
//     （这条正是"绝不因为压缩失败而丢图"的哨兵，不能只挂在"这台机器装了 ffmpeg"上）。

/** 等一个子进程结束（探测/生图/量尺寸用；这个插件自己的调用链不依赖它）。 */
function runProcess(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ code: -1, error: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ code: -1, error: 'timeout', stdout });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, error: String(error?.message ?? error), stdout });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** true = 文件头是 JPEG 的 SOI 标记。 */
const isJpeg = (file) => {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  return head[0] === 0xff && head[1] === 0xd8;
};

/**
 * 一个**真的能执行**的 ffmpeg 替身（POSIX：一个 sh 脚本，chmod +x 即可）。
 *
 * 为什么需要它：开发机（Windows）**没有** ffmpeg，那三条"真压缩"用例会整体 skip，
 * 而"降采样接线接对没有"就永远没在这台机器上验过。替身让它们在**没有 ffmpeg 的机器**上
 * 也能跑起来（线上 Linux 有真 ffmpeg 时根本轮不到它）。
 *
 * 它**不**参与探测：探测只认真的 `ffmpeg` 命令（见"按退出码判"那条用例），替身只在
 * `downsampleToJpeg(..., { ffmpegPath })` 这个显式出口、以及测试里显式接的 spawn 委托上被驱动。
 * 行为严格照真 ffmpeg：`-version` 退出 0；造图退出 0；输入不存在 → **退出 1**
 * （真 ffmpeg 在那种情形下也是"悄悄地失败"）。
 *
 * ⚠️ Windows 上**不做**替身，也做不了（三条路都试过，别再来一遍）：
 *   · `spawn('ffmpeg.cmd')` → EINVAL（Node 对 .cmd 必须走 shell）；
 *   · 拷贝 node.exe + `-e <脚本>` → ESM 加载器会把 `-e`/`--` 从 argv 里拿掉；
 *   · 拷贝 node.exe + `NODE_OPTIONS=--require` → **node 先校验自己的命令行参数**才轮到
 *     preload，ffmpeg 风格的 `-version` 会当场 "bad option" 退出 9。
 *   所以 Windows 上就照仓库惯例"缺件跳过"，那三条用例会明确标成 SKIP（不是悄悄变绿）。
 */
function makeFakeFfmpeg() {
  if (process.platform === 'win32') return null;
  const dir = mkTemp('qq-pixiv-fakeffmpeg-');
  const bin = path.join(dir, 'ffmpeg');
  const body = [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const val = (f) => { const i = args.indexOf(f); return i === -1 ? '' : args[i + 1]; };",
    "if (args.includes('-version')) { console.log('ffmpeg version fake'); process.exit(0); }",
    "const out = args[args.length - 1] || '';",
    "const input = val('-i');",
    "if (!input || !fs.existsSync(input)) { console.error('fake ffmpeg: no such input: ' + input); process.exit(1); }",
    "if (args.includes('lavfi')) {",                    // 造"大原图"：qv 越小越大
    "  const qv = Number(val('-q:v')) || 3;",
    "  const size = Math.round(1200 * 1024 * ((32 - qv) / 30));",
    "  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);",
    "  fs.writeFileSync(out, Buffer.concat([head, Buffer.alloc(Math.max(64, size - head.length), 7)]));",
    "  process.exit(0);",
    "}",
    "const inBytes = fs.statSync(input).size;",          // 降采样：写一个 1/5 大的假 JPEG
    "const size = Math.max(2048, Math.round(inBytes / 5));",
    "const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);",
    "fs.writeFileSync(out, Buffer.concat([head, Buffer.alloc(size - head.length, 9)]));",
    "process.exit(0);"
  ].join('\n');
  try {
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" -e ${JSON.stringify(body)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
  } catch { return null; }
  return { bin };
}

/** 让替身跑一段（模拟"代码里 spawn 一次 ffmpeg"）。 */
function runFakeFfmpeg(fake, ffArgs) {
  return runChild(fake.bin, ffArgs, process.env);
}

/** 起一个子进程、只关心它怎么退出（不给管道：本沙箱里给管道会 EPERM）。 */
function runChild(bin, args, env) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(bin, args, { stdio: 'ignore', windowsHide: true, env });
    } catch { resolve(-1); return; }
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code));
  });
}

/**
 * 假子进程：**启动就失败**（`error` + 非 0 退出），模拟 ffmpeg 不存在 / 没权限 / 被拦掉。
 * `error` 与 `exit` 都发，是因为两条路径的判据不同 —— 探测按**退出码**，调用按 `error`/`close`。
 *
 * ⚠️ `exit` 之后必须再发 `close`：真实的 ChildProcess 两个都发，而 `runFfmpegToFile` 等的是
 *    **`close`**（它要确认 stderr 也读完了）。只发 `exit` 的话那条路径会一路等到 10 秒超时，
 *    于是"没产出文件"这条用例拿到的是"ffmpeg 超时"——本机实测踩到。
 */
function rejectingSpawn() {
  return () => ({
    stderr: { on() {} },
    kill() {},
    on(event, fn) {
      // 下一个 tick 再回调：真实 spawn 的事件也是异步的
      if (event === 'error') setImmediate(() => fn(new Error('spawn ffmpeg ENOENT')));
      if (event === 'exit') setImmediate(() => fn(127));
      if (event === 'close') setImmediate(() => fn(-2));
      return this;
    }
  });
}

/** 假子进程：**退出码 0 但什么都不写**（真 ffmpeg 也会这样"悄悄地失败"）。 */
function silentSuccessSpawn() {
  return () => ({
    stderr: { on() {} },
    kill() {},
    on(event, fn) {
      if (event === 'exit') setImmediate(() => fn(0));
      if (event === 'close') setImmediate(() => fn(0));
      return this;
    }
  });
}

const FAKE = hostReady ? makeFakeFfmpeg() : null;
/** 替身真的能跑起来吗（起不来就照旧 skip 那三条用例，不假装验过）。 */
let fakeWorks = false;
if (FAKE) fakeWorks = (await runFakeFfmpeg(FAKE, ['-version'])) === 0;

/**
 * 真的探测一次 ffmpeg（**必须清缓存**：上面那条"探测按退出码判"的用例把假 spawn 的结果
 * 写进了进程级缓存，不清的话会拿到假的 'ffmpeg'，后面的"真压缩"就**静默地什么都不验**
 * —— 第一版正是如此：三条用例全绿而机器上根本没有 ffmpeg）。
 */
async function probeRealFfmpeg() {
  __resetFfmpegProbe();
  __setSpawnForTest(null);
  return resolveFfmpeg();
}

const FFMPEG = hostReady ? await probeRealFfmpeg() : '';
/** 这台机器上"有真的 ffmpeg"吗 —— 有则用它，没有则用替身，两者都没有才 skip。 */
const HAVE_REAL_FFMPEG = Boolean(FFMPEG);
const NEED_FFMPEG = FFMPEG
  ? false
  : (fakeWorks ? false : '这台机器上既没有 ffmpeg、也装不上内置替身（Windows）—— 这条用例要真压缩，按惯例跳过');

/** 造一张"大原图"：有真 ffmpeg 就用它（顺带把真实产物也验了），否则用替身造。 */
async function makeBigImage(dir, name = 'big.jpg', qv = 3) {
  const out = path.join(dir, name);
  if (FFMPEG) {
    const r = await runProcess(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `nullsrc=s=1600x1600,format=rgb24,geq=random(1)*255:random(2)*255:random(3)*255,format=yuvj420p`,
      '-frames:v', '1', '-q:v', String(qv), out
    ]);
    if (r.code === 0 && fs.existsSync(out)) return { file: out, bytes: fs.statSync(out).size };
    return null;
  }
  if (!fakeWorks) return null;
  const code = await runFakeFfmpeg(FAKE, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'nullsrc=s=1600x1600', '-frames:v', '1', '-q:v', String(qv), out
  ]);
  if (code !== 0 || !fs.existsSync(out)) return null;
  return { file: out, bytes: fs.statSync(out).size };
}

/** 调 downsampleToJpeg：有真 ffmpeg 就不传路径（验生产路径），没有就显式给替身。 */
const downsample = (file, options = {}) => {
  if (FFMPEG) return downsampleToJpeg(file, options);
  // 没有真 ffmpeg 又没有替身（Windows）时不该走到这里 —— 上面的 skip 已经拦住了；
  // 万一漏了，就退成"没有 ffmpeg"那条路径，而不是 TypeError。
  if (!FAKE) return downsampleToJpeg(file, { ...options, ffmpegPath: '/definitely/not/ffmpeg' });
  return downsampleToJpeg(file, { ...options, ffmpegPath: FAKE.bin });
};

/**
 * 把插件内部的 spawn 接到替身上（仅当这台机器没有真 ffmpeg 时用）。
 * 返回一个"恢复原状"的函数 —— 用例的 finally 必须调它，否则后面的用例会继续看到替身。
 */
function delegateSpawnToFake() {
  const delegate = (bin, args, options) => spawn(FAKE.bin, args || [], options);  __setSpawnForTest(delegate);
  __resetFfmpegProbe();
  return () => {
    __setSpawnForTest(null);
    __resetFfmpegProbe();
  };
}

check('降采样：探测按**退出码**判"有没有 ffmpeg"（本机实测抓到的那个坑）', async () => {
  // 现场：`stdio: 'ignore'` 下 spawn 一个**不存在**的可执行文件不会发 `error` 事件，
  // 只以非 0（127）退出。第一版按"没收到 error = 可用"写，于是**没装 ffmpeg 的机器
  // 也被判成装了** —— 表现是"降采样看起来生效、其实一张都没缩"，比报错难查得多。
  const stub = (code) => () => ({
    stderr: { on() {} },
    kill() {},
    on(event, fn) {
      if (event === 'exit') setImmediate(() => fn(code));
      return this;
    }
  });
  __setSpawnForTest(stub(127));          // 不存在：只有 exit 127，没有 error
  __resetFfmpegProbe();
  try {
    assert.equal(await resolveFfmpeg(), '', '退出码非 0 必须判成"没有 ffmpeg"');
  } finally {
    __setSpawnForTest(null);
    __resetFfmpegProbe();
  }
});

check('降采样：只在大图时动手（阈值内连 spawn 都不该发生）', async () => {
  const dir = mkTemp('qq-pixiv-ds-small-');
  const file = path.join(dir, 'small.bin');
  fs.writeFileSync(file, Buffer.alloc(700 * 1024));   // < 800KB 阈值
  let spawned = 0;
  __setSpawnForTest(() => { spawned += 1; return null; });   // 一旦被调到就说明判错了
  __resetFfmpegProbe();
  try {
    const r = await downsampleToJpeg(file, { overBytes: 800 * 1024 });
    assert.equal(r.downsized, false);
    assert.equal(r.bytes, 700 * 1024);
    assert.equal(r.file, file, '阈值内必须原样返回同一个文件');
    assert.equal(spawned, 0, '阈值内不该去 spawn 任何进程（连 ffmpeg 探测都不该做）');
    assert.equal(fs.existsSync(file), true, '绝不该动原文件');
  } finally {
    __setSpawnForTest(null);
    __resetFfmpegProbe();
  }
});

check('降采样：ffmpeg 起不来时回落原图（**这条用例不需要 ffmpeg，任何机器都跑**）', async () => {
  const dir = mkTemp('qq-pixiv-ds-nofail-');
  const file = path.join(dir, 'big.jpg');
  // 必须**真的超过阈值**才会走到 spawn 那一步（阈值内会提前返回，这条就空跑了）
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  // 造一个"启动就报错"的子进程，模拟 ffmpeg 不存在 / 没权限 / 被 AV 拦掉
  const rejecting = rejectingSpawn();
  __setSpawnForTest(rejecting);
  __resetFfmpegProbe();
  try {
    // ⚠️ 必须**显式给 ffmpegPath**，不能只靠上面的假 spawn：
    //    探针按"退出码 0"判可用，而这个假子进程既不报 error 也不退出 0 → 探测结论是
    //    "没有 ffmpeg"，于是 downsampleToJpeg 在探测那一步就短路了、**根本走不到 spawn**，
    //    这条用例量的就成了"没装 ffmpeg"而不是"起不来"（变异验证抓出来的空跑）。
    const r = await downsampleToJpeg(file, { overBytes: 800 * 1024, ffmpegPath: 'ffmpeg' });
    // ★ 核心断言：压缩没成 → **原图照旧可用**，绝不抛错、绝不丢图
    assert.equal(r.downsized, false, 'ffmpeg 起不来时必须回落原图');
    assert.equal(r.file, file, '回落的路径必须还是原文件');
    assert.equal(r.bytes, 1024 * 1024, '回落的体积必须还是原体积');
    assert.equal(fs.existsSync(file), true, '★ 压缩失败绝不能把原图删掉');
    assert.ok(r.reason, '回落要说清原因（否则"卡片为什么只装了 3 页"又得从头查）');
    // ⚠️ 必须钉住**是哪一种回落**：上面那句只断言"有原因"，而"这台机器上没有 ffmpeg"
    //    与"ffmpeg 真的失败了"都会走到这里、都满足"有原因"。不写这一条的话，把
    //    `!result.ok` 这个守卫改坏（失败被当成成功）这条用例照样绿 —— 变异验证抓出来的。
    assert.match(r.reason, /启动失败/, `这条路径的回落原因必须是"ffmpeg 起不来"，实际：${r.reason}`);
    assert.deepEqual([...fs.readdirSync(dir)], ['big.jpg'], '不该留下半成品文件');
  } finally {
    __setSpawnForTest(null);
    __resetFfmpegProbe();
  }
});

check('降采样：ffmpeg 说成功但**没产出文件**时也要回落原图（只看退出码是不够的）', async () => {
  const dir = mkTemp('qq-pixiv-ds-nofile-');
  const file = path.join(dir, 'big.jpg');
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024));   // 超过阈值，必须走到 spawn 那一步
  // 造一个"退出码 0、但什么文件都没写"的子进程：真 ffmpeg 也会这样"悄悄地失败"
  // （参数不对、编码器缺失、写到一半被杀…），所以只看退出码是不够的。
  __setSpawnForTest(silentSuccessSpawn());
  __resetFfmpegProbe();
  try {
    const r = await downsampleToJpeg(file, { overBytes: 800 * 1024, ffmpegPath: 'ffmpeg' });
    assert.equal(r.downsized, false, '没产出文件就不能声称压缩成功');
    assert.equal(r.file, file, '回落必须指向原文件');
    assert.equal(r.bytes, 1024 * 1024, '回落的体积必须是原体积（不是那个不存在的产物）');
    assert.equal(fs.existsSync(file), true, '★ 压缩没产出东西时绝不能把原图删掉');
    assert.match(r.reason, /没有产出文件/, `原因要说清是"没产出"，实际：${r.reason}`);
    assert.deepEqual([...fs.readdirSync(dir)], ['big.jpg'], '不该留下半成品文件');
  } finally {
    __setSpawnForTest(null);
    __resetFfmpegProbe();
  }
});

check('降采样：滤镜参数钉住"最长边 1200、只缩不放、取第 1 帧"', () => {
  const args = buildDownsampleArgs('/in/x.png', '/out/y.jpg', { maxEdge: 1200, quality: 5 });
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /min\(1200,iw\)/, '最长边要卡在 1200（宽度方向）');
  assert.match(vf, /min\(1200,ih\)/, '最长边要卡在 1200（高度方向）');
  assert.match(vf, /force_original_aspect_ratio=decrease/, '只缩不放：短边按比例');
  assert.match(vf, /force_divisible_by=2/, 'mjpeg 要求两边都是偶数（奇数会直接报错）');
  assert.equal(args[args.indexOf('-frames:v') + 1], '1', '静态图只取第 1 帧');
  assert.equal(args[args.indexOf('-q:v') + 1], '5');
  assert.equal(args[args.indexOf('-i') + 1], '/in/x.png');
  assert.equal(args[args.length - 1], '/out/y.jpg');
  // 参数必须收敛在合法区间：quality 是 ffmpeg 的 2..31，maxEdge 再小也不该小于 64
  const lo = buildDownsampleArgs('a', 'b', { maxEdge: 1, quality: 999 });
  assert.match(lo[lo.indexOf('-vf') + 1], /min\(64,iw\)/);
  assert.equal(lo[lo.indexOf('-q:v') + 1], '31');
  const hi = buildDownsampleArgs('a', 'b', { quality: -5 });
  assert.equal(hi[hi.indexOf('-q:v') + 1], '2');
});

check('降采样（真压缩）：大图缩成 JPEG，最长边 1200、体积明显变小', async () => {
  const dir = mkTemp('qq-pixiv-ds-real-');
  const big = await makeBigImage(dir);
  assert.ok(big, '第一步就得造出一张真的大图（造不出来说明这条用例本身有问题，不是被测代码的问题）');
  assert.ok(big.bytes > 800 * 1024, `造的图要超过阈值才验得到压缩，实际 ${big.bytes} 字节`);

  const r = await downsample(big.file, { overBytes: 800 * 1024, maxEdge: 1200, quality: 5 });
  assert.equal(r.downsized, true, `应该真的压缩了（reason=${r.reason ?? '无'}）`);
  assert.ok(r.bytes < big.bytes, `缩完必须更小：${big.bytes} → ${r.bytes}`);
  assert.equal(r.bytes, fs.statSync(r.file).size, '返回的 bytes 要是盘上的真实大小');
  assert.ok(isJpeg(r.file), '产物必须是 JPEG（SOI 0xFFD8）');
  assert.equal(fs.existsSync(big.file), false, '缩完要替换掉原图（不让调用方看到两个文件）');
  // ⚠️ "最长边 1200"这条只有**真的 ffmpeg** 才验得了：替身是自己写的，量它等于自证。
  //    本机没装真 ffmpeg（用替身）时这一节整体跳过 —— 别把"替身说我缩对了"当结论。
  if (!HAVE_REAL_FFMPEG) return;
  // 用 ffprobe（与 ffmpeg 同目录的名字）量一下真实尺寸
  const probe = path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const probed = await runProcess(probe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.file
  ]);
  if (probed.code !== 0) return;   // 没有 ffprobe 就不量尺寸（不是本用例的重点）
  const raw = String(probed.stdout ?? '');
  if (!/\d+,\d+/.test(raw)) return;
  const [w, h] = raw.trim().split(',').map((n) => parseInt(n, 10));
  assert.equal(Math.max(w, h), 1200, `最长边必须缩到 1200，实际 ${w}x${h}`);
  assert.equal(w % 2, 0, `宽必须是偶数（mjpeg 要求），实际 ${w}`);
  assert.equal(h % 2, 0, `高必须是偶数（mjpeg 要求），实际 ${h}`);
}, NEED_FFMPEG);

check('降采样（真压缩）：4MB 卡片预算下 5 页大图能全收进、并打包成一条卡片', async () => {
  const dir = mkTemp('qq-pixiv-ds-card-');
  const big = await makeBigImage(dir);
  assert.ok(big, '造图失败');
  assert.ok(big.bytes > 1500 * 1024,
    `这条用例要的是"原图大到装不下几张"的现场，实际只有 ${big.bytes} 字节 —— 造图参数要调大`);
  const pageBytes = fs.readFileSync(big.file);

  internals.__setState([], []);
  const { ctx, images, forwards } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);
  internals.__setStateDir(toolCtx.dir);   // 门面 sendForward 的路径守卫只认这个目录

  const pid = '123450001';
  const base = 'https://i.pixiv.re/img-master/img/2023/03/03/03/03/03';
  const PAGES = 5;
  const asked = [];
  // 本机没装真 ffmpeg 时，把"spawn ffmpeg"接到替身上 —— 这样这条路走的仍然是**真的**
  // "下载 → spawn ffmpeg → 检查产物 → 按最终体积记账 → 打包"，只是压缩器换了实现。
  const restoreSpawn = HAVE_REAL_FFMPEG ? null : delegateSpawnToFake();
  try {
    await withFetch(
      async (url) => {
        const u = String(url);
        asked.push(u);
        if (u.includes('/setu/v2')) {
          return {
            ok: true,
            status: 200,
            headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
            async json() {
              return {
                data: [{
                  pid: Number(pid), p: 0, title: '多图大图', author: '作者', r18: false,
                  tags: ['测试'], ext: 'jpg', urls: { regular: `${base}/${pid}_p0_master1200.jpg` }
                }]
              };
            }
          };
        }
        // 5 页都给**真实的大 JPEG 字节** —— 这样这条路走的就是真的"下载 → ffmpeg 压缩 → 记账"
        if (new RegExp(`/${pid}_p[0-${PAGES - 1}]_`).test(u)) {
          return fakeImageResponse({
            contentType: 'image/jpeg',
            contentLength: pageBytes.length,
            body: chunkStream([new Uint8Array(pageBytes)])
          });
        }
        return fakeImageResponse({ status: 404 });   // 第 6 页不存在 → 续页到此为止
      },
      () => registered.get('pixiv_image').execute(toolCtx, { keyword: '测试' })
    );
  } finally {
    // 内存里的 PID 索引清干净（盘上那份在刚才那个临时状态目录里，不影响别的用例）
    internals.__setState([], []);
    if (restoreSpawn) restoreSpawn();
  }

  const paged = asked.filter((one) => one.includes(`_p`));
  assert.equal(paged.length, PAGES + 1, `应该取了 5 页 + 探测第 6 页，实际请求 ${paged.length} 次`);
  assert.equal(forwards.length, 1, '5 页大图该打包成**一条**卡片');
  assert.equal(images.length, 0, '走卡片时不该再逐张发');
  const nodes = forwards[0].payload.nodes;
  assert.equal(nodes.length, PAGES + 1, '一条说明 + 5 张图');
  // ★ 这条就是本轮改动的目的：缩过之后，5 页大图加起来还远在 4MB 预算之内
  const total = nodes.filter((n) => n.data.content[0].type === 'image')
    .reduce((sum, n) => sum + Buffer.byteLength(n.data.content[0].data.file.replace('base64://', ''), 'base64'), 0);
  assert.ok(total < internals.DEFAULTS.forwardBudgetBytes,
    `5 页缩完应该在 4MB 预算之内（实际 ${total} 字节）`);
  assert.ok(total < pageBytes.length * PAGES / 2,
    `缩过的总字节要明显小于原图之和（原图 ${pageBytes.length}×${PAGES}，实际 ${total}）`);
}, NEED_FFMPEG);

check('降采样（真压缩）：走逐张发那条路时，发的也是**缩小的**那个文件', async () => {
  const dir = mkTemp('qq-pixiv-ds-send-');
  const big = await makeBigImage(dir, 'single.jpg');
  assert.ok(big && big.bytes > 800 * 1024, '造图失败或不够大');
  internals.__setState([], []);
  internals.__setStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-ds-sendstate-')));
  const calls = [];
  // 同上：这条路要经过插件内部的 resolveFfmpeg()，替身必须接进 spawn
  const restoreSpawn = HAVE_REAL_FFMPEG ? null : delegateSpawnToFake();
  try {
    const got = await withFetch(
      async () => fakeImageResponse({
        contentType: 'image/jpeg',
        contentLength: big.bytes,
        body: chunkStream([new Uint8Array(fs.readFileSync(big.file))])
      }),
      () => internals.__fetchImage({ pid: '99900001', imageUrl: 'https://i.pixiv.re/x_p0.jpg' },
        { ...internals.DEFAULTS, timeoutMs: 3000 })
    );
    calls.push(got);
    assert.equal(got.downsized, true, '取图这一步就该把它缩掉（预算是按最终体积算的）');
    assert.ok(got.bytes < big.bytes, `返回的体积必须是缩过的：${big.bytes} → ${got.bytes}`);
    // 以后面真正发送的那一段看到的就是这个路径 —— 它必须存在，且在插件状态目录之内
    assert.equal(fs.existsSync(got.file), true, '缩过的文件得真的在盘上（否则发的时候才发现没了）');
    assert.equal(path.dirname(path.resolve(got.file)), path.resolve(internals.__tempDir()));
  } finally {
    internals.__setState([], []);
    if (restoreSpawn) restoreSpawn();
  }
}, NEED_FFMPEG);

