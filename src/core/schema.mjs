/**
 * 记忆条目的形状、不变量、id 生成。
 *
 * 这是**冻结**的：磁盘上的每一行、注入里的每一行、面板上的每一条，
 * 都走这一套字段名。改字段名等于让历史档案全部读不出来。
 *
 * 一条记忆 = 一个「事件」的打包：
 *
 *   {
 *     id: 'em-20261025T0058-a1b2',
 *     ts: 1761321600000,        ← 事件发生的时间（不是入库时间）
 *     iso: '2026-10-25T00:58:57+08:00',
 *     zone: 'short' | 'long' | 'permanent',
 *     weight: 0.7,              ← AI 判的重要度
 *     title: '一句话',
 *     detail: '细节',
 *     keywords: ['记忆插件','DSH'],
 *     source: 'chat' | 'seed' | 'note' | 'merge',
 *     depth: 0,                 ← 压缩层级，越大越模糊
 *     mergedFrom: [],
 *     session: 'abc123',
 *     touchedAt: 0,             ← 最近一次被检索/引用
 *     createdAt: 0              ← 入库时间
 *   }
 */

/** 三个分区，顺序即「深度」：越往后越深、越模糊、越不容易想起。 */
export const ZONES = /** @type {const} */ (['short', 'long', 'permanent']);

export const ZONE_LABEL = Object.freeze({
  short: '短期',
  long: '长期',
  permanent: '永久',
});

/** 分区深度序号，用来比较「谁更深」。 */
export const ZONE_DEPTH = Object.freeze({ short: 0, long: 1, permanent: 2 });

export const SOURCES = /** @type {const} */ (['chat', 'seed', 'note', 'merge']);

const MAX_TITLE = 80;
const MAX_DETAIL = 2000;
const MAX_KEYWORDS = 10;
const MAX_MERGED = 64;
const MAX_DEPTH = 9;

/**
 * 把任意数夹到 [0,1]。非数 → 0。
 * @param {unknown} n
 * @returns {number}
 */
export function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 把模型给的 weight 折回 0~1。**只折算「明显不是 0~1 量纲」的值，其余原样返回。**
 *
 * 为什么需要：固化提示词要求 weight 用 0.1/0.5/0.8/0.95，但实际上模型
 * （deepseek-v4.1-flash、glm-5.3-flash 都观察到过）会按 10 分制给 3、8 这种值。
 * 3 直接 clamp01 会变成 1.0 —— 于是 `initialZoneFor` 判它 ≥0.92，整批记忆
 * 空降永久区，权重和分区一起失真。
 *
 * 保守起见只在 >1 时按 /10 折算；正常写法（0~1）一个字节都不动，
 * 非数字也原样返回，让调用方自己决定兜底值。
 *
 * @param {unknown} n
 * @returns {number}
 */
export function normalizeWeight(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 1) return clamp01(v / 10);
  return v;
}

function two(n) {
  return String(n).padStart(2, '0');
}

/**
 * 生成 id：`em-<YYYYMMDD>T<HHmm>-<4位hex>`。
 *
 * 4 位随机后缀不是为了好看 —— 后台一次固化可能在同一分钟内写入两条，
 * 只用时间戳会撞 id，而在 jsonl 里撞 id = 删一条删两条。
 *
 * @param {number} ts
 * @param {Set<string>|string[]} [taken] 已占用的 id（防撞）
 * @returns {string}
 */
export function makeId(ts, taken) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const head =
    `em-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `T${two(d.getHours())}${two(d.getMinutes())}`;
  const used = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
  for (let i = 0; i < 64; i += 1) {
    const tail = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    const id = `${head}-${tail}`;
    if (!used.has(id)) return id;
  }
  // 极端情况：同一分钟 64 次撞车，退化成时间戳后缀（依然唯一）
  return `${head}-${(Date.now() % 0x10000).toString(16).padStart(4, '0')}`;
}

/**
 * 本地时区的 ISO 串，带偏移。DSH 的读者是本地人，UTC 串读起来别扭。
 * @param {number} ts
 * @returns {string}
 */
export function isoOfLocal(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = two(Math.floor(Math.abs(off) / 60));
  const om = two(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // 压掉换行与连续空白：一条记忆在 jsonl 里必须是一行
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 关键词清洗：去空、去重、限长、限量。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeKeywords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\s]+/) : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const k = item.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (k.length === 0) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** 极简中文停用词：检索时它们只会制造噪音。 */
const KEYWORD_STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '和', '就', '也', '都',
  '把', '被', '让', '给', '对', '很', '还', '又', '再', '这', '那', '个', '有',
  'the', 'and', 'for', 'with', 'that', 'this',
]);

/**
 * 从标题/细节里**兜底**抽关键词（模型没给 keywords 时）。
 * 中文按 2-gram 抽，英文按词。只抽少量，别把整句塞进去。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function deriveKeywords(text, limit = 6) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (k) => {
    const key = k.toLowerCase();
    if (seen.has(key) || KEYWORD_STOP.has(key)) return;
    seen.add(key);
    out.push(k);
  };

  // 英文/数字词
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+#._-]{1,}/g)) push(m[0]);
  // 中文：连续汉字串切 2-gram（「记忆插件」→ 记忆/忆插/插件）
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length && out.length < limit * 3; i += 1) {
      push(run.slice(i, i + 2));
    }
  }
  return out.slice(0, limit);
}

/**
 * 人称漂移的机械修补：把「对方」「用户」换成「你」。
 *
 * 背景（2026-10-29）：条目约定是「我 = 我自己，你 = 对话对面那个人」。
 * 可模型（尤其 flash 档）经常退回第三人称写「对方」「用户」。这两个词在
 * 这个库里**没有第二种指代可能**，所以入库和读盘时直接换掉最稳，不靠提示词。
 *
 * 「他」「她」故意**不**机械换：它们可能真的是第三方（室友、同事、别的 AI）。
 * 那一层交给两处兜底：① 固化/压缩提示词 ② 注入时那句硬映射
 * （render.mjs 的 HEAD_LINES：「老条目里写成『他』的，指的就是『你』」）。
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeReferences(text) {
  return String(text ?? '').replace(/对方/g, '你').replace(/用户/g, '你');
}

/**
 * 规整一条记忆。**不合格返回 null**（调用方丢弃，绝不写半成品）。
 *
 * @param {any} raw
 * @param {object} opts
 * @param {'short'|'long'|'permanent'} opts.zone   期望分区
 * @param {number} [opts.now]
 * @param {string} [opts.session]
 * @param {'chat'|'seed'|'note'|'merge'} [opts.source]
 * @param {Set<string>|string[]} [opts.taken]
 * @returns {object|null}
 */
export function normalizeEntry(raw, opts) {
  if (raw === null || typeof raw !== 'object') return null;
  const zone = ZONES.includes(opts?.zone) ? opts.zone : 'short';
  const now = Number.isFinite(opts?.now) ? /** @type {number} */ (opts.now) : Date.now();

  let ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) {
    ts = Number(raw.created_at ?? raw.createdAt);
  }
  if (!Number.isFinite(ts) || ts <= 0) ts = now;
  // 未来时间一律拉回现在（时钟漂移不该让记忆永远不到期）
  if (ts > now + 60000) ts = now;

  // 正文兜底：模型不一定会用 title/detail 这两个键名。实测 unlimit 代理下的
  // deepseek-v4.1-flash 和 glm-5.3-flash 都习惯输出 {"type":"fact","content":"..."}，
  // content 不在原来那两个键里 → 被判成「空条目」直接丢掉，整批 added=0，
  // 而这条路径只在 debugLog 打开时才可见（症状就是「用了半天一条没记上」）。
  // 正文从哪个键都能捞，是这里唯一该硬的地方；至于它叫什么名字，不该决定记忆的生死。
  const body = raw.content ?? raw.summary ?? raw.memo ?? raw.text;
  // 2026-10-29：入库/读盘统一把「对方」「用户」拧成「你」（见 sanitizeReferences）。
  const title = cleanText(sanitizeReferences(raw.title ?? body ?? ''), MAX_TITLE);
  const detail = cleanText(sanitizeReferences(raw.detail ?? body ?? ''), MAX_DETAIL);
  if (title === '' && detail === '') return null;

  const keywords = normalizeKeywords(raw.keywords ?? raw.tags);
  const finalKeywords =
    keywords.length > 0 ? keywords : deriveKeywords(`${title} ${detail}`, 6);

  const source = SOURCES.includes(raw.source) ? raw.source : (opts?.source ?? 'chat');
  const session =
    typeof raw.session === 'string'
      ? raw.session.slice(0, 40)
      : typeof opts?.session === 'string'
        ? opts.session.slice(0, 40)
        : '';

  const depth = Math.min(MAX_DEPTH, Math.max(0, Math.round(Number(raw.depth) || 0)));
  const mergedFrom = (Array.isArray(raw.mergedFrom) ? raw.mergedFrom : [])
    .filter((x) => typeof x === 'string')
    .slice(0, MAX_MERGED);

  const taken = opts?.taken instanceof Set ? opts.taken : new Set(Array.isArray(opts?.taken) ? opts.taken : []);
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : makeId(ts, taken);

  // 注意：这里的 clamp01 是**契约**（SPEC：越界一律夹到 1），不要在这里做量纲折算。
  // 模型给的 10 分制 weight 由调用方（host 的 ingest）先用 normalizeWeight 折好再传进来。
  const weight = clamp01(raw.weight ?? 0.4);

  return {
    id,
    ts,
    iso: typeof raw.iso === 'string' && raw.iso !== '' ? raw.iso : isoOfLocal(ts),
    zone,
    weight: Math.round(weight * 100) / 100,
    title,
    detail: detail === '' ? title : detail,
    keywords: finalKeywords,
    source,
    depth,
    mergedFrom,
    session,
    touchedAt: Number.isFinite(Number(raw.touchedAt)) ? Number(raw.touchedAt) : ts,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
  };
}

/**
 * 读盘后的校验：字段缺了可以补，类型塌了就不行。
 * @param {unknown} e
 * @returns {boolean}
 */
export function isValidEntry(e) {
  if (e === null || typeof e !== 'object') return false;
  const x = /** @type {any} */ (e);
  if (typeof x.id !== 'string' || x.id === '') return false;
  if (!Number.isFinite(x.ts) || x.ts <= 0) return false;
  if (!ZONES.includes(x.zone)) return false;
  if (typeof x.title !== 'string' && typeof x.detail !== 'string') return false;
  return true;
}

/**
 * 压缩层级 → detail 的保留比例。
 * 深度越深越模糊，但**有下限**（=40 字），绝不允许「模糊成没有」。
 *
 * @param {number} depth
 * @param {number} baseLen 原始 detail 长度
 * @returns {number} 应保留的字符数
 */
export function detailFloor(depth, baseLen) {
  const d = Math.min(MAX_DEPTH, Math.max(0, Math.round(Number(depth) || 0)));
  const factor = [1, 0.55, 0.35, 0.25][Math.min(3, d)] ?? 0.25;
  const len = Number.isFinite(baseLen) ? baseLen : 0;
  return Math.max(40, Math.min(len || 40, Math.round((len || 40) * factor)));
}
