// 模板插件：把它当成"最小可用骨架"，照着改。
//
// 契约见 docs/PLUGIN-API.md（那份文档里的四张清单与代码双向对齐，示例也被真的装载过）。
// 三条最容易踩的：
//   ① 工具名必须与 plugin.json 的 tools[].name **逐字一致**，多一个少一个整个插件都会被拒；
//   ② 能力没声明就连属性都没有（用错当场 TypeError），所以 capabilities 要与实际用法对齐；
//   ③ 入口导出的是 activate(api)，不是 setup(a)。

/**
 * 代码里的默认值。
 *
 * manifest **不放**默认值 —— 使用者在控制台「插件 → 设置」里编辑的就是这些键。
 * 注意 `api.config` 是**激活时的快照**：改设置要重启服务才生效（凭据 `toolCtx.secret`
 * 才是每次调用现读的）。
 */
const DEFAULTS = {
  greeting: '你好',
  maxBumps: 10000
};

export async function activate(api) {
  api.log.info(`已激活；当前设置 = ${JSON.stringify(api.config)}`);

  // ── 工具一：计数器（演示 storage + 读设置 + 返回值契约）────────────────
  api.registerTool({
    name: 'counter_bump',
    description: '把本插件的计数器加一并回报当前次数。greeting 传一个称呼可以覆盖设置里的问候语。'
      + '群友说"记一下""打个卡"这类要求时用它。',
    parameters: {
      type: 'object',
      properties: {
        greeting: { type: 'string', description: '这一次用的称呼（可选）' }
      },
      required: []
    },
    async execute(toolCtx, args) {
      const settings = readSettings(api);
      // kv 是**同步**的（get/set/delete/list/all），不要写 await
      const current = Number(toolCtx.kv.get('count')) || 0;
      const next = current + 1;
      if (next > settings.maxBumps) {
        // 失败用 return { error }：它会作为工具错误回到模型，而不是把整轮运行炸掉
        return { error: `计数器已到上限 ${settings.maxBumps}（到设置里调大，或把它清一次）。` };
      }
      toolCtx.kv.set('count', next);
      const who = String(args?.greeting ?? '').trim() || String(settings.greeting ?? '') || '你好';
      // 返回字符串就是成功。**成功时不要带 isError: false**（内置工具不带这个字段）
      return `${who}，这是第 ${next} 次被叫到。`;
    }
  });

  // ── 工具二：代我说一句（演示 chat:send）──────────────────────────────
  api.registerTool({
    name: 'say_now',
    description: '让机器人现在就在本会话里说一句话。text 是要说的内容（一条 ≤3000 字；'
      + '也可以给一组，一次最多 5 条）。需要"主动说点什么、但又不用等下一轮回复"时用它。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: ['string', 'array'], description: '要说的话，或一组话' }
      },
      required: ['text']
    },
    async execute(toolCtx, args) {
      const text = args?.text;
      const empty = text === undefined || text === null
        || (Array.isArray(text) ? text.length === 0 : String(text).trim() === '');
      if (empty) return { error: '要说什么？text 不能为空。' };
      // chatKey 由宿主绑死：插件发不到别的会话（这是 chat:send 最要紧的一条约束）
      const result = await toolCtx.send(text);
      if (!result.sent) return { error: `没发出去（失败 ${result.failed} 条）。` };
      return `已发出 ${result.sent} 条。`;
    }
  });

  return {
    async deactivate() {
      // 可选。⚠️ 这里**不要**发消息或发网络请求：卸载发生在进程收尾阶段，成败已经没人能处理。
      // 状态是每次 set 就落盘的，所以也不需要在这里做收尾保存。
    }
  };
}

/** 设置 = 代码默认值 + 使用者在控制台里填的（未填的键用默认值兜）。 */
function readSettings(api) {
  const raw = (api && typeof api.config === 'object' && api.config) || {};
  const out = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
