/**
 * 固化输出的**容错层**：让任意模型吐出来的东西都能被接住。
 *
 * 为什么要这一层：固化提示词要求模型输出
 *   [{"ts":<ms>,"weight":0.7,"zone":"short","title":"…","detail":"…","keywords":["…"]}]
 * 但这是「请求」，不是「合同」。实测过的现实：
 *
 *   - unlimit/deepseek-v4.1-flash、glm-5.3-flash 都习惯输出
 *     {"type":"fact","content":"…","session":"…"} —— 正文键叫 content，不叫 detail；
 *   - zone 会给 "semantic" / "episodic" / "config" 这种语义词，不在三区枚举里；
 *   - weight 会给 3、8（10 分制），直接 clamp 成 1.0 会让整批空降永久区；
 *   - ts 会给 "2026-10-27 15:30:00" 字符串、或者秒级时间戳；
 *   - 整个数组会被包在 {"memories":[…]} 里，或者前后带一句「好的，这是记忆条目：」；
 *   - 偶尔小模型漏个大括号、末尾多个逗号。
 *
 * 这一层不改变「模型说什么」的正确性判断 —— 它只负责**把同一句话从别的键名、
 * 别的包装、别的时间写法里捞出来**。捞不出来的仍然当空条目丢掉，绝不编内容。
 *
 * 纯函数 / 零依赖，可单独测试。
 */

/** 正文候选键，按优先级。模型实际用过的都在前三名。 */
const BODY_KEYS = [
  'detail', 'content', 'body', 'text', 'description', 'summary', 'memo',
  'fact', 'statement', 'note', 'value', 'message', 'paragraph',
];

/** 标题候选键。 */
const TITLE_KEYS = ['title', 'headline', 'heading', 'name', 'label', 'topic', 'short'];

/** 时间候选键。 */
const TS_KEYS = ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'date', 'event_time', 'at', 'when'];

/** 权重候选键。 */
const WEIGHT_KEYS = ['weight', 'importance', 'score', 'priority', 'level', 'significance'];

/** 关键词候选键。 */
const KEYWORD_KEYS = ['keywords', 'tags', 'labels', 'keys', 'topics', 'kw'];

/** 分区候选键。`type` 放在靠后：它是模型最常用的键，但语义上也可能是「记录类型」。 */
const ZONE_KEYS = ['zone', 'layer', 'memory_type', 'memoryType', 'category', 'kind', 'type', 'tier', 'bucket'];

/** 数组包装键：模型常把数组塞进一个对象里。 */
const WRAPPER_KEYS = ['memories', 'entries', 'items', 'data', 'results', 'list', 'array', 'records', 'notes'];

/**
 * 分区语义别名。按顺序匹配：先命中哪个算哪个。
 *
 * 这张表只解决「模型给了一个意思明确但不叫 short/long/permanent 的词」。
 * 认不出来的照旧按 weight 判（initialZoneFor 的规则），绝不硬猜。
 */
const ZONE_ALIASES = [
  ['permanent', [
    'permanent', 'identity', 'preference', 'profile', 'core', 'personality', 'persona',
    'habit', 'rule', 'constraint', 'persona_core', 'longterm_identity',
    '永久', '人格', '偏好', '习惯', '雷区', '性格',
  ]],
  ['long', [
    'long', 'semantic', 'fact', 'config', 'configuration', 'project', 'knowledge',
    'topic', 'milestone', 'decision', 'task', 'todo',
    '长期', '事实', '项目', '知识', '决定',
  ]],
  ['short', [
    'short', 'episodic', 'event', 'temp', 'temporary', 'instant', 'instantly',
    'recent', 'log', 'misc', 'context', 'session', 'moment',
    '短期', '即时', '事件', '临时',
  ]],
];

/** 取第一个「有内容」的键值。空串 / null / undefined 都算没有。 */
function pick(obj, keys) {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return undefined;
}

function str(v) {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/**
 * 把模型给的时间写成毫秒时间戳。认三种写法：
 *   13 位毫秒 / 10 位秒（自动 ×1000）/ 任何 Date.parse 认得的日期串。
 * 认不出来返回 undefined —— 交给 normalizeEntry 用「现在」兜底。
 *
 * @param {unknown} v
 * @returns {number|undefined}
 */
export function toTs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    // 1e11 ms ≈ 1973 年。小于它的一律当成秒级时间戳。
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(String(v).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 把分区语义词映射到 short / long / permanent。
 * 认不出来返回 undefined，让调用方按 weight 判。
 *
 * @param {unknown} v
 * @returns {'short'|'long'|'permanent'|undefined}
 */
export function toZone(v) {
  const s = str(v).trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'short' || s === 'long' || s === 'permanent') return /** @type {any} */ (s);
  for (const [zone, aliases] of ZONE_ALIASES) {
    for (const a of aliases) {
      if (s === a || s.includes(a)) return /** @type {any} */ (zone);
    }
  }
  return undefined;
}

/**
 * 关键词：数组照收；逗号/顿号/空格分隔的字符串拆开。
 * 真正的清洗（去重、限长、限量）还是 normalizeKeywords 干，这里只管形状。
 *
 * @param {unknown} v
 * @returns {string[]|undefined}
 */
function toKeywords(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') {
    return v.split(/[,，、;；\s]+/).filter((x) => x.trim() !== '');
  }
  return undefined;
}

/**
 * 单条原始输出 → 标准键名。
 *
 * **幂等**：已经是标准形状的条目走一遍不会变样（这是硬要求 —— 这张函数会同时
 * 作用在模型输出和导入数据上）。
 *
 * @param {unknown} raw
 * @returns {object} 标准键名的条目（不认识的原字段原样保留，交给下游忽略）
 */
export function canonicalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  /** @type {any} */
  const src = raw;
  /** @type {any} */
  const out = { ...src };

  const body = pick(src, BODY_KEYS);
  const bodyText = str(body);

  if (str(out.detail).trim() === '' && bodyText.trim() !== '') out.detail = bodyText;
  if (str(out.title).trim() === '') {
    const t = pick(src, TITLE_KEYS);
    // 没有独立标题时，用正文开头当标题（normalizeEntry 会按 MAX_TITLE 截断）
    if (t !== undefined) out.title = str(t);
    else if (bodyText.trim() !== '') out.title = bodyText.slice(0, 40);
  }

  if (toTs(out.ts) === undefined) {
    for (const k of TS_KEYS) {
      const t = toTs(src[k]);
      if (t !== undefined) { out.ts = t; break; }
    }
  } else {
    // 已经是能认的值，但仍然统一成毫秒（模型可能给了秒级 ts）
    const t = toTs(out.ts);
    if (t !== undefined) out.ts = t;
  }

  if (!Number.isFinite(Number(out.weight))) {
    const w = pick(src, WEIGHT_KEYS);
    if (w !== undefined && Number.isFinite(Number(w))) out.weight = Number(w);
  }

  if (toKeywords(out.keywords) === undefined) {
    const k = pick(src, KEYWORD_KEYS);
    const kw = toKeywords(k);
    if (kw !== undefined) out.keywords = kw;
  } else if (!Array.isArray(out.keywords)) {
    out.keywords = toKeywords(out.keywords);
  }

  const zone = toZone(pick(src, ZONE_KEYS));
  if (zone !== undefined && toZone(out.zone) === undefined) out.zone = zone;

  return out;
}

/**
 * 批量版本，顺带剔掉非对象成员。
 *
 * @param {unknown} list
 * @returns {object[]}
 */
export function canonicalizeList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => canonicalizeEntry(x)).filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** 剥掉 markdown 代码围栏。没围栏就原样返回。 */
function stripFence(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (m !== null) return m[1].trim();
  // 只有开头围栏、结尾被截断的情况
  const open = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*)$/);
  if (open !== null) return open[1].trim();
  return s;
}

/** 去尾逗号（`[1,2,]` / `{"a":1,}`）。 */
function dropTrailingCommas(s) {
  return s.replace(/,\s*([\]}])/g, '$1');
}

/** 尝试把「被截断的数组」补完整：砍到最后一个完整的 } 或 ] 再闭合。 */
function closeTruncated(s) {
  const openBracket = s.indexOf('[');
  if (openBracket < 0) return null;
  const body = s.slice(openBracket);
  // 从后往前找最后一个 } 或 ]
  for (let cut = body.length - 1; cut > 0; cut -= 1) {
    const ch = body[cut];
    if (ch !== '}' && ch !== ']') continue;
    const head = body.slice(0, cut + 1);
    const closed = ch === '}' ? `${head}]` : head;
    try {
      const v = JSON.parse(dropTrailingCommas(closed));
      if (Array.isArray(v) && v.length > 0) return v;
    } catch {
      // 继续往前退
    }
  }
  return null;
}

/**
 * 从任意文本里抠出一个对象数组。
 *
 * 依次尝试：整体解析 → 剥围栏再解析 → 从第一个 `[`/`{` 到最后一个 `]`/`}` →
 * 去尾逗号 → 补全被截断的数组 → 拆对象包装（{memories:[…]}）→ 单个对象包成数组。
 *
 * 全程**不修内容**：解析出来的就是模型写的东西，只是换了个包装。
 *
 * @param {unknown} text
 * @returns {object[]|null} 干净的对象数组；一点都抠不出来时 null
 */
export function extractJsonArray(text) {
  if (text === undefined || text === null) return null;
  const raw = stripFence(text);
  if (raw === '') return null;

  /** @type {unknown} */
  let value;
  let parsed = false;

  const attempt = (s) => {
    if (parsed) return;
    try {
      value = JSON.parse(s);
      parsed = true;
    } catch {
      // 下一个策略
    }
  };

  attempt(raw);
  if (!parsed) attempt(dropTrailingCommas(raw));
  if (!parsed) {
    const start = raw.search(/[[{]/);
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      const slice = raw.slice(start, end + 1);
      attempt(slice);
      if (!parsed) attempt(dropTrailingCommas(slice));
    }
  }
  if (!parsed) {
    const closed = closeTruncated(raw);
    if (closed !== null) return canonicalizeList(closed);
  }
  if (!parsed) return null;

  if (Array.isArray(value)) return canonicalizeList(value);

  if (value !== null && typeof value === 'object') {
    /** @type {any} */
    const obj = value;
    for (const k of WRAPPER_KEYS) {
      if (Array.isArray(obj[k])) return canonicalizeList(obj[k]);
    }
    // 单个对象也当一条（模型只记了一条时很常见）
    return canonicalizeList([obj]);
  }

  return null;
}
