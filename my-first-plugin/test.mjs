// 插件的自测：把它**真的装进宿主**跑一遍，并真的调用两个工具。
//
// 为什么插件也该带测试：宿主那套门禁只验"宿主的契约"，验不到"你这个插件有没有写对"。
// 而插件写错的代价很具体 —— 工具集合与 manifest 不一致会让**整个插件**被拒绝加载，
// 那种错误在群里表现为"模型说它不会"，很难查。
//
// 运行（QQ_AGENT_HOME 指到宿主代码所在的目录，也就是安装目录或仓库 checkout）：
//   本机：  QQ_AGENT_HOME=D:\QQ-Agent\qq-agent-plus  node --test my-first-plugin/test.mjs
//   服务器：QQ_AGENT_HOME=/mnt/data/qq-agent/app    node --test /mnt/data/qq-agent/plugins/my-first-plugin/test.mjs
// 不指的话默认按"与源码 checkout 平级"猜一次，猜不到就跳过（不误报红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = 'my-first-plugin';
const HOST = process.env.QQ_AGENT_HOME
  ? path.resolve(process.env.QQ_AGENT_HOME)
  : path.resolve(HERE, '..', '..', 'qq-agent-plus');

const hostReady = fs.existsSync(path.join(HOST, 'plugins', 'loader.js'));
const SKIP = hostReady
  ? false
  : `找不到宿主代码（试过 ${HOST}）—— 用 QQ_AGENT_HOME 指到安装目录或源码 checkout`;

const hostUrl = (relative) => pathToFileURL(path.join(HOST, relative)).href;
const { initPlugins, resetPlugins } = hostReady ? await import(hostUrl('plugins/loader.js')) : {};
const { manifestFingerprint, normalizeManifest, readManifest } =
  hostReady ? await import(hostUrl('plugins/_host/manifest.js')) : {};
const { pluginToolDefs } = hostReady ? await import(hostUrl('plugins/_host/registry.js')) : {};

function fakeHostCtx() {
  const sent = [];
  return {
    sent,
    chatKey: 'group:10001',
    kind: 'group',
    chatId: '10001',
    selfId: '999',
    signal: null,
    session: { id: 's1', rounds: 1, sent: [], leaseId: 'lease-1' },
    store: { recent: () => [] },
    emit: () => {},
    sender: {
      async sendTextBatch(chatKey, messages, options) {
        sent.push({ chatKey, messages, options });
        return { sent: messages.map((text, index) => ({ text, messageId: index + 1, at: '00:00:01' })), failed: [] };
      },
      async image() { return { message_id: 1 }; }
    }
  };
}

test('manifest 合法，且注册的工具与声明完全一致，两个工具都能真的调用', { skip: SKIP }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-first-plugin-'));
  t.after(async () => {
    await resetPlugins();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
  });

  const manifest = normalizeManifest(readManifest(HERE), { pluginDir: HERE, expectedId: ID });
  assert.equal(manifest.id, path.basename(HERE), '目录名必须等于 manifest 的 id');

  await resetPlugins();
  const warnings = [];
  const result = await initPlugins({
    dataDir,
    bundledRoot: null,                        // 测试隔离：别顺带扫宿主自带的插件
    builtinToolNames: [],                     // 真实部署时这里会有内置工具名，用来查重名
    log: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    config: {
      plugins: {
        roots: [path.dirname(HERE)],          // 插件根 = 本插件所在的那一层
        enabled: [ID],
        approved: { [ID]: manifestFingerprint(manifest) },
        settings: { [ID]: { greeting: '早' } } // 演示"改设置"这条路
      }
    }
  });

  const status = (result.statuses || []).find((item) => item.id === ID);
  assert.ok(status, '装载结果里没有这个插件');
  assert.equal(status.status, 'loaded', `装载失败：${status.reason}`);
  assert.deepEqual(warnings, [], `不该有告警：${warnings.join(' / ')}`);

  const defs = pluginToolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ['counter_bump', 'say_now'],
    '注入的工具必须与 plugin.json 的 tools 完全一致（多一个少一个都会被装载器拒绝）');

  const hostCtx = fakeHostCtx();
  const bump = defs.find((d) => d.name === 'counter_bump');

  // ① 计数器：第一次 1、第二次 2 —— 走的是 toolCtx.kv（同步接口）
  const first = await bump.execute(hostCtx, {});
  assert.equal(first.isError, undefined, `第一次调用就失败：${first.content}`);
  assert.match(first.content, /早，这是第 1 次被叫到。/, '设置里的 greeting 应该生效');
  const second = await bump.execute(hostCtx, { greeting: '小明' });
  assert.match(second.content, /小明，这是第 2 次被叫到。/, 'args 里的 greeting 应该覆盖设置');

  // ② 状态落在 dataDir/plugin-state/<id>/，不是插件目录里（升级换代码不会丢数据）
  const kvFile = path.join(dataDir, 'plugin-state', ID, 'kv.json');
  assert.ok(fs.existsSync(kvFile), `状态应落在 ${kvFile}`);
  assert.equal(JSON.parse(fs.readFileSync(kvFile, 'utf8')).count, 2);

  // ③ say_now：真发一次，并确认 chatKey 是宿主绑死的那个
  const say = defs.find((d) => d.name === 'say_now');
  const sent = await say.execute(hostCtx, { text: '我先说一句' });
  assert.match(sent.content, /已发出 1 条/);
  assert.equal(hostCtx.sent.length, 1);
  assert.equal(hostCtx.sent[0].chatKey, 'group:10001', 'chatKey 必须来自宿主，插件发不到别的会话');
  assert.equal(hostCtx.sent[0].options.runId, 'lease-1', '要带 runId，否则 outbox 记账挂不上这次运行');

  // ④ 参数缺失要回到"工具错误"，而不是抛出去把整轮运行炸掉
  const bad = await say.execute(hostCtx, {});
  assert.equal(bad.isError, true);
  assert.match(bad.content, /不能为空/);
  assert.equal(hostCtx.sent.length, 1, '失败的调用不该发任何东西');
});
