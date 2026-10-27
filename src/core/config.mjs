/**
 * 配置层 —— 一份规格，两个出口。
 *
 * 为什么不 `import schemastery`：那会让 `@deepseek-ai/schemastery` 成为运行时
 * 硬依赖。一旦目标机器上解析不到，`import` 直接抛错 → 整个插件加载失败。
 * 对于一个「装上就该忘掉它」的插件，这个失败模式不能接受。
 *
 * 所以：
 *  - `CONFIG_SPEC` 是唯一真相源，纯 JS，零依赖。
 *  - `resolveConfig()` 自己补默认、做类型转换与范围钳制 —— 行为一定确定。
 *  - `buildSchema(z)` 只在 schemastery 可用时才被调用，额外产出设置页表单用的
 *    schema。拿不到就没有表单，但**所有键照样能在 `cordis.patch.yml` 里写**。
 *
 * ⚠️ 这里**刻意不用 `.volatile()`**。
 * `volatile()` 会把该键从持久化配置里摘掉，而它在 DSH 里的实际表现是：默认值
 * `''` 被包成一个对象，进到插件里变成字符串 `'[object Object]'`，`path.resolve()`
 * 一拼就把记忆库写进 `[object Object]\` 目录里，全程没有任何报错。
 * 我们的配置**全部需要持久化**（周期、容量、强度都是用户要调的），所以不加。
 * 为了万一，`resolveConfig` 对字符串键仍然做「不是字符串就退回默认」的防御。
 */

/**
 * @typedef {'boolean'|'number'|'string'} ConfigType
 * @typedef {object} ConfigField
 * @property {string} key
 * @property {ConfigType} type
 * @property {*} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} label
 */

/** @type {ConfigField[]} */
export const CONFIG_SPEC = [
  { key: 'enabled', type: 'boolean', default: true, label: '总开关' },
  { key: 'dataDir', type: 'string', default: '', label: '记忆库目录（留空 = $DSH_HOME/ebbinghaus-memory）' },

  // ── 两个临时分区的周期 ────────────────────────────────────────────
  { key: 'shortDays', type: 'number', default: 7, min: 1, max: 90, step: 1, label: '短期记忆周期（天）' },
  { key: 'longDays', type: 'number', default: 28, min: 2, max: 365, step: 1, label: '长期记忆周期（天）' },

  // ── 写入频率 ─────────────────────────────────────────────────────
  { key: 'writeEveryTurns', type: 'number', default: 2, min: 1, max: 30, step: 1, label: '每几轮对话固化一次（1-30 轮，会话第一轮必写）· 频率越高越费 Token' },
  // 哪些 source.kind 算「他亲手打的字」。
  // 这不只是洁癖：别的桥接插件（其它 QQ 框架 / Telegram / Discord / 自建客户端）
  // 用的 kind 各不相同，写死就会**一条都记不上而且不报错**，症状跟坏了没法区分。
  { key: 'sourceKinds', type: 'string', default: 'user,qq', label: '哪些来源算他说的话（逗号分隔）· 换桥接就把它的 source.kind 加进来' },

  // ── bot 记忆专区 ────────────────────────────────────────────────
  // 很多人并不接 QQ bot。所以这一整块默认关着，关着就完全不影响行为（跟 0.8.x 之前一样）。
  // 开了之后：桥接（QQ 之类）来的会话单独绑到一个分区，跟桌面端那些分开存，
  // 互不干扰 —— 桌面端不会读到 QQ 上的碎碎念，QQ 那边也不会翻到桌面的活。
  { key: 'botSpaceEnabled', type: 'boolean', default: false, label: '启用 bot 记忆专区 · 把 QQ 这类桥接的记忆跟桌面端分开放（装了 dsh-qq-bot 时强制开启，不允许关闭）' },
  { key: 'botSpaceId', type: 'string', default: '', label: 'bot 专区用哪个分区（填分区 id，面板里能看到；留空 = 不分区）' },
  { key: 'botUins', type: 'string', default: '', label: '只把这些 QQ 号的消息存进专区（逗号分隔；留空 = 桥接来的全算）' },
  // 两次固化之间的最小间隔：防「连着几轮疯狂触发」把并发和额度一起打爆。
  // **默认 0 = 不限制**，保持「攒够 writeEveryTurns 轮就写」的既有语义；
  // 想降频（比如怕被 API 风控）就调到 60~300。
  { key: 'minIntervalSeconds', type: 'number', default: 0, min: 0, max: 900, step: 5, label: '两次固化最小间隔（秒）· 0 = 不限制；调大能降频省额度' },

  // ── 分区容量（条），超了就回滚压缩 ────────────────────────────────
  { key: 'shortCapacity', type: 'number', default: 120, min: 5, max: 2000, step: 1, label: '短期容量上限（条）' },
  { key: 'longCapacity', type: 'number', default: 600, min: 5, max: 4000, step: 1, label: '长期容量上限（条）' },
  { key: 'permanentCapacity', type: 'number', default: 1000, min: 5, max: 8000, step: 1, label: '永久容量上限（条）' },

  // ── 全库总量（token）：把每一条按**注入格式**渲染成文字后的合计 ──────────
  // 计数口径与注入一致：`renderEntryLine()` 出来的那一行，中文按 1.8 字 ≈ 1 token
  // 估（SPEC §11 同一个系数，两处必须一致，否则面板显示 40K、注入按另一套算）。
  //
  // 为什么要有第二道闸：条数上限管不住体积 —— 永久区 1000 条里只要混进几条
  // 三千字的旧档案，条数才用掉 5%，检索和面板就已经在拖了。300000 是硬顶
  // （用户定的），超过这个数浏览器里滚面板都费劲，曲线也失去意义。
  { key: 'totalTokenCapacity', type: 'number', default: 100000, min: 5000, max: 300000, step: 1000, label: '全库总量上限（token，渲染口径，最多 30 万）' },

  // ── 分区强度：越深越模糊 ─────────────────────────────────────────
  { key: 'shortDetail', type: 'number', default: 0.9, min: 0.1, max: 1, step: 0.05, label: '短期记忆强度（详细度）' },
  { key: 'longDetail', type: 'number', default: 0.55, min: 0.1, max: 1, step: 0.05, label: '长期记忆强度（详细度）' },
  { key: 'permanentDetail', type: 'number', default: 0.3, min: 0.1, max: 1, step: 0.05, label: '永久记忆强度（详细度）' },

  // ── 载入策略 ─────────────────────────────────────────────────────
  { key: 'loadShortCount', type: 'number', default: 12, min: 0, max: 200, step: 1, label: '每轮载入短期几条' },
  // 2026-10-28：长期从「随机忆起」改成「近 N 天内权重最高的」。键名保留是为了不炸老 settings.json。
  { key: 'loadLongRandom', type: 'number', default: 3, min: 0, max: 50, step: 1, label: '每轮载入长期几条（近 N 天内权重最高的）' },
  { key: 'loadLongWindowDays', type: 'number', default: 60, min: 1, max: 365, step: 1, label: '长期只在最近几天内挑（默认 60 天）' },
  { key: 'loadPermanentCount', type: 'number', default: 6, min: 0, max: 50, step: 1, label: '每轮载入永久几条' },
  { key: 'budgetTokens', type: 'number', default: 1400, min: 200, max: 8000, step: 1, label: '注入预算（token）· 每轮聊天都会带上这段，调大同时增加聊天输入花费' },

  // ── 升级 / 淘汰门槛 ──────────────────────────────────────────────
  { key: 'promoteShortToLong', type: 'number', default: 0.55, min: 0, max: 1, step: 0.05, label: '短期→长期的权重门槛' },
  // ⚠️ 默认值必须是 `step` 的整数倍。schemastery 的 `.step()` 是**硬校验**
  // （报 "expected number multiple of 0.05 but got 0.72"），不是滑块的步进建议。
  // 这里原来写的是 0.72，装到真 DSH 里设置页会直接报错、整份配置读不出来。
  // test/config.test.mjs 有一条测试专门盯着这件事。
  { key: 'promoteLongToPermanent', type: 'number', default: 0.7, min: 0, max: 1, step: 0.05, label: '长期→永久的权重门槛' },
  { key: 'forgetBelow', type: 'number', default: 0.2, min: 0, max: 1, step: 0.05, label: '到期后直接遗忘的权重下限' },

  // ── 选择性检索 ───────────────────────────────────────────────────
  { key: 'recallTop', type: 'number', default: 3, min: 1, max: 20, step: 1, label: '检索最多取回几条' },
  { key: 'recallThreshold', type: 'number', default: 2, min: 0, max: 20, step: 0.5, label: '本地自动检索的命中门槛' },

  // ── 记忆库自检（重复记忆合并）────────────────────────────────────
  // 固化那一刻，模型只看得到最近十几条对话，看不到库里已经有什么 —— 所以同一件事
  // 会被反复记下来（实测一晚上写出三种说法的「公众场合不许叫他名字」）。
  // 自检负责事后打扫：跨分区把「说的是同一件事」的并成一条，细节留最全的那份，
  // 原文进 `_archive/`。
  //
  // 为什么是「每 N 条」而不是定时：触发条件本来就是「又攒了一批新的重复」，
  // 按条数比按时间贴切；而且它必须是**不注入对话的自检**（用户原话），
  // 跑在后台队列里，不占任何一轮的上下文。
  { key: 'dedupEnabled', type: 'boolean', default: true, label: '记忆库自检（重复记忆合并）' },
  {
    key: 'dedupEveryEntries',
    type: 'number',
    default: 30,
    min: 5,
    max: 100,
    step: 1,
    label: '每写入多少条记忆自检一次（5-100）',
  },
  {
    // 0.5 是拿真库调出来的：183 条上能抓同一件事的不同写法（「林小满：四川人，
    // 在杭州工作」三种说法、「雷区：不在群里提他的薪资」两种），
    // 又不会把「同一天发生的两件事」揉成一条。调高更保守，调低更主动。
    key: 'dedupThreshold',
    type: 'number',
    default: 0.5,
    min: 0.3,
    max: 0.95,
    step: 0.05,
    label: '重复判定阈值（0.3 激进 ~ 0.95 只合同字句）',
  },

  // ── 固化用模型 ───────────────────────────────────────────────────
  { key: 'provider', type: 'string', default: '', label: '固化用 provider（留空 = 跟随聊天模型）' },
  { key: 'model', type: 'string', default: '', label: '固化用模型（留空 = 跟随聊天模型）' },
  { key: 'reasoningEffort', type: 'string', default: 'off', label: '固化的思考档位（保持 off）' },
  // 2026-10-28：默认 1200 → 4000。会思考的模型（哪怕开了 off 档）一次固化实测要吃
  // 1200~2000 的输出预算，1200 会被思考吃光、content 回来是空串，插件按「解析失败」整批丢弃，
  // 症状就是「memory_stats 一直说模型输出不是合法 JSON，一条也记不进去」。
  { key: 'maxTokens', type: 'number', default: 4000, min: 200, max: 8000, step: 1, label: '固化最大输出 token · 调大只影响固化的花费，不吃聊天上下文' },
  { key: 'jobTimeoutMs', type: 'number', default: 60000, min: 5000, max: 600000, step: 1000, label: '后台任务超时（毫秒）' },

  // ── 固化链路兜底（2026-10-27 加）─────────────────────────────────
  // 主链路 = 跟随聊天模型；聊天模型那边不听话（吐不出合法条目）时，
  // 连续失败到阈值就把固化临时切到官方模型，存成功一次算「好了」，
  // 再切回聊天模型。切回后先稳定一段冷静期才重新计数，免得来回抖。
  { key: 'fallbackEnabled', type: 'boolean', default: true, label: '固化连续失败就临时切到官方模型 · 存成功一次后自动切回聊天模型' },
  { key: 'fallbackAfter', type: 'number', default: 3, min: 2, max: 10, step: 1, label: '连续失败几次切链路（2-10 次）· 越小越早切、也越容易被误判' },
  { key: 'fallbackProvider', type: 'string', default: 'deepseek-account', label: '兜底 provider（官方）' },
  { key: 'fallbackModel', type: 'string', default: 'deepseek-flash', label: '兜底模型（官方）' },
  { key: 'fallbackCooldownSeconds', type: 'number', default: 600, min: 60, max: 7200, step: 60, label: '切回聊天模型后的冷静期（秒）· 期间不再判定失败' },
  // 一键停：记忆插件彻底不调模型（不固化、不压缩）。额度被打爆时先按住这里。
  { key: 'modelCallsPaused', type: 'boolean', default: false, label: '暂停记忆插件的模型调用（不固化、不压缩，纯本地功能照常）' },

  // ── 自动备份镜像（2026-10-26 加）─────────────────────────────────
  // 「每 N 条同步一次」的口径跟 dedup 一样：自上次同步以来**新写进库**的条数。
  // 备份内容：记忆库全部文件 + DSH 人格提示词（AGENT.md / prompt-inject.md）
  // + 其它插件配置（靠 mirrorExtraPaths 手动列，见 README）。
  // 刻意不带 node_modules / 插件源码 / exe —— 那些重装一份就好，塞进来只会让镜像变胖。
  { key: 'mirrorEnabled', type: 'boolean', default: false, label: '自动备份镜像（记忆 + 人格提示词 + 插件配置）' },
  {
    key: 'mirrorEveryEntries',
    type: 'number',
    default: 5,
    min: 1,
    max: 50,
    step: 1,
    label: '每写入多少条记忆同步一次镜像（1-50）',
  },
  {
    key: 'mirrorDir',
    type: 'string',
    default: '',
    label: '镜像目录（绝对路径；留空 = 不备份）',
  },
  {
    key: 'mirrorExtraPaths',
    type: 'string',
    default: '',
    label: '额外要镜像的路径（每行一个，可留空）',
  },

  { key: 'debugLog', type: 'boolean', default: false, label: '开发期调试日志（只打形状）' },
];

/** 全部默认值（冻结） */
export const CONFIG_DEFAULTS = Object.freeze(
  Object.fromEntries(CONFIG_SPEC.map((f) => [f.key, f.default])),
);

function coerce(field, value) {
  if (value === undefined || value === null) return field.default;

  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return field.default;
  }

  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return field.default;
    let out = n;
    if (Number.isFinite(field.min)) out = Math.max(field.min, out);
    if (Number.isFinite(field.max)) out = Math.min(field.max, out);
    return out;
  }

  // 字符串：**不是字符串就退回默认** —— 防 `[object Object]` 那个坑
  return typeof value === 'string' ? value : field.default;
}

/**
 * 把原始配置（来自 `cordis.patch.yml` 的 `config:`）规整成一定合法的配置对象。
 * **永不抛错** —— 坏配置退回默认值。
 *
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
export function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const field of CONFIG_SPEC) out[field.key] = coerce(field, src[field.key]);

  // 跨字段校正：长期周期不该短于短期周期
  if (out.longDays <= out.shortDays) out.longDays = out.shortDays + 1;
  return out;
}

/* ───────────────────────── 面板可调的运行时覆盖 ─────────────────────────
 *
 * 为什么需要这一层：DSH 的插件设置页走 schemastery 表单，要**重载插件**才生效，
 * 而且不是每个组合里 schemastery 都解析得到 —— 面板里那几个数就无处可改。
 * 所以侧栏面板自带一个调整窗口：改完 POST 给 host，host 写一份
 * `<dataDir>/settings.json` 覆盖层并当场把新值塞进运行中的 config。
 *
 * 三条纪律：
 *  1. **只有白名单里的键能被覆盖。** 面板不是配置文件编辑器 —— `dataDir`、
 *     `enabled`、`provider` 这类动一下就把库写歪或把插件关掉的键不许进来。
 *  2. **覆盖值走同一套 `coerce()`。** 越界钳制、坏类型退默认，跟 DSH 配置
 *     一字不差的规则。面板传 `"120"` 和 `120` 结果必须一样。
 *  3. **DSH 配置仍然是底座。** 覆盖层只盖住它，删掉 settings.json 就回到
 *     `cordis.patch.yml` 的值 —— 这是「恢复默认」按钮的全部实现。
 */

/** 面板里允许改的键。**新增键要同时改 client 面板与 README。** */
export const TUNABLE_KEYS = Object.freeze([
  'shortDays',
  'longDays',
  'writeEveryTurns',
  'sourceKinds',
  'shortCapacity',
  'longCapacity',
  'permanentCapacity',
  'totalTokenCapacity',
  'loadShortCount',
  'loadLongRandom',
  'loadLongWindowDays',
  'loadPermanentCount',
  'budgetTokens',
  'dedupEnabled',
  'dedupEveryEntries',
  'dedupThreshold',
  'mirrorEnabled',
  'mirrorEveryEntries',
  'mirrorDir',
  'mirrorExtraPaths',
  // 2026-10-27：固化频率与链路兜底。这几项是「每个分区各自的写入策略」，
  // 所以放在按分区覆盖的白名单里；`fallbackProvider` / `fallbackModel` 故意
  // **不**进来 —— 跟 provider / model 一样是全局的，只在 DSH 设置页或 yml 里改。
  'minIntervalSeconds',
  'fallbackEnabled',
  'fallbackAfter',
  'fallbackCooldownSeconds',
  'modelCallsPaused',
]);

/** @type {Record<string, ConfigField>} */
const FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(CONFIG_SPEC.map((f) => [f.key, f])),
);

/**
 * 某个键的规格（含 min/max/step/label）。面板画输入框要用。
 * 不认识的键返回 undefined。
 *
 * @param {string} key
 * @returns {ConfigField | undefined}
 */
export function fieldSpec(key) {
  return FIELD_BY_KEY[key];
}

/**
 * 面板可调键的规格表 —— 客户端不重复写一遍字段定义，直接从 host 拿。
 *
 * @returns {{key:string,type:ConfigType,min?:number,max?:number,step?:number,label:string,default:*,
 *            value:*, overridden:boolean}[]}
 */
export function tunableFields(config, overrides) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  /** @type {any[]} */
  const out = [];
  for (const key of TUNABLE_KEYS) {
    const f = FIELD_BY_KEY[key];
    if (f === undefined) continue;
    out.push({
      key,
      type: f.type,
      min: f.min,
      max: f.max,
      step: f.step,
      label: f.label,
      default: f.default,
      value: config?.[key] ?? f.default,
      overridden: Object.prototype.hasOwnProperty.call(src, key),
    });
  }
  return out;
}

/**
 * 把覆盖值叠到一份已解析的配置上。**返回新对象，不改入参。**
 * 白名单外的键、坏值、越界值都在这里被吃掉（坏值退默认，越界钳制）。
 *
 * @param {Record<string, any>} config 已经 `resolveConfig()` 过的配置
 * @param {unknown} overrides settings.json 的内容
 * @returns {{ config: Record<string, any>, accepted: string[], rejected: string[] }}
 */
export function applyOverrides(config, overrides) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  /** @type {Record<string, any>} */
  const out = { ...(config ?? {}) };
  /** @type {string[]} */
  const accepted = [];
  /** @type {string[]} */
  const rejected = [];

  for (const key of Object.keys(src)) {
    if (!TUNABLE_KEYS.includes(key)) {
      rejected.push(key);
      continue;
    }
    const f = FIELD_BY_KEY[key];
    if (f === undefined) {
      rejected.push(key);
      continue;
    }
    const raw = src[key];
    // 显式 null = 「删掉这一项覆盖」，不是「设成 null」
    if (raw === null || raw === undefined) {
      rejected.push(key);
      continue;
    }
    const v = coerce(f, raw);
    // coerce 对坏值退默认 —— 但「传了垃圾」和「明确传了默认值」在面板上
    // 是两件事：前者要告诉用户没生效，后者要静默接受。这里用原始值判断。
    if (f.type === 'number' && !Number.isFinite(Number(raw))) {
      rejected.push(key);
      continue;
    }
    out[key] = v;
    accepted.push(key);
  }

  // 跨字段校正：跟 resolveConfig 保持同一条规矩
  if (Number(out.longDays) <= Number(out.shortDays)) {
    out.longDays = Number(out.shortDays) + 1;
  }
  return { config: out, accepted, rejected };
}

/**
 * 用 schemastery 构造 Config。**只在能 require 到 schemastery 时调用。**
 *
 * @param {any} z schemastery 默认导出
 * @returns {any}
 */
export function buildSchema(z) {
  /** @type {Record<string, any>} */
  const shape = {};
  for (const f of CONFIG_SPEC) {
    let s;
    if (f.type === 'boolean') s = z.boolean();
    else if (f.type === 'number') {
      s = z.number();
      if (Number.isFinite(f.step)) s = s.step(f.step);
      if (Number.isFinite(f.min)) s = s.min(f.min);
      if (Number.isFinite(f.max)) s = s.max(f.max);
    } else s = z.string();
    shape[f.key] = s.default(f.default).description(f.label ?? '');
  }
  return z.object(shape);
}
