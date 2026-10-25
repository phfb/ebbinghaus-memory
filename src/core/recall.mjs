/**
 * 选择性检索 —— **查找，不是载入**。
 *
 * 用户对这件事说过一句很准的话：把整个分区倒进上下文，等于让模型在噪声里找信号，
 * 还顺手把 token 烧光。所以这里只有一条路：拿本轮用户说的话去比分，
 * 命中的那几条（默认最多 3 条）才有资格进注入。
 *
 * 打分权重照 SPEC §10：keywords ×3 > title ×2 > detail ×1，再乘 (0.5 + weight)。
 * 乘子让「重要的记忆更容易被想起来」——这就是遗忘曲线里的「复习」，
 * 同样一句话，weight 0.9 的记忆比 0.1 的更容易被触发。
 *
 * 纯函数 / 零依赖。
 */

import { ZONE_DEPTH, clamp01 } from './schema.mjs';

/**
 * 检索停用词。它们出现在几乎每句话里，留着只会让任何 query 都命中任何记忆。
 * 刻意保持短小：停用词表越长，越容易把「想说的事」也一起吃掉。
 */
const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '也', '都',
  '把', '被', '让', '给', '对', '很', '还', '又', '再', '这', '那', '个', '有', '没',
  '一个', '什么', '怎么', '现在', '今天', '可以', '这个', '那个', '我们', '你们',
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'you', 'but', 'not',
  'have', 'has', 'from', 'what', 'how', 'can', 'will', 'just', 'about',
]);

/** 英文/数字词：允许中间带 +#._-（c++ / live-2d / r2d2 这类）。 */
const WORD_RE = /[A-Za-z][A-Za-z0-9+#._-]*|\d{2,}/g;
/** 连续汉字串。 */
const HAN_RE = /[\u4e00-\u9fa5]+/g;

/**
 * 单字停用词。中文 2-gram 里只要含其中一个字，这个 gram 基本都是噪音
 * （「的记忆」「他现」「件的」），留着只会让每句话都命中每条记忆。
 */
const STOP_CHARS = new Set('的了是在我你他她它们和就也都把被让给对很还又再这那个有没'.split(''));

/**
 * 中文按 2-gram、英文/数字按词切；去停用词、去单字、去重。
 *
 * 为什么中文用 2-gram 而不是分词：core 层零依赖，装不了分词库；而且 2-gram 对
 * 「记忆插件 / 插件」这种没有空格的复合词反而更稳 —— 不管用户怎么组合，
 * 「插件」这个 gram 一定在。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const t = String(raw ?? '')
      .toLowerCase()
      .trim();
    if (t.length < 2) return;
    if (STOP.has(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const m of text.matchAll(WORD_RE)) push(m[0]);
  for (const m of text.matchAll(HAN_RE)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (STOP_CHARS.has(gram[0]) || STOP_CHARS.has(gram[1])) continue;
      push(gram);
    }
  }
  return out;
}

/**
 * 单条记忆对一组 query token 的得分（0 起，已含 weight 乘子）。
 *
 * title 命中后不再给 detail 计分：detail 通常复述标题，双计会让「标题长」的
 * 记忆凭空得分更高。
 *
 * @param {object} entry
 * @param {string[]} queryTokens
 * @returns {number}
 */
export function scoreEntry(entry, queryTokens) {
  if (entry === null || typeof entry !== 'object') return 0;
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;

  const keywords = (Array.isArray(entry.keywords) ? entry.keywords : []).map((k) =>
    String(k ?? '').toLowerCase(),
  );
  const title = String(entry.title ?? '').toLowerCase();
  const detail = String(entry.detail ?? '').toLowerCase();

  let raw = 0;
  const seen = new Set();
  for (const token of queryTokens) {
    const t = String(token ?? '')
      .toLowerCase()
      .trim();
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    if (keywords.some((k) => k !== '' && (k.includes(t) || t.includes(k)))) raw += 3;
    if (title.includes(t)) raw += 2;
    else if (detail.includes(t)) raw += 1;
  }

  return raw * (0.5 + clamp01(entry.weight));
}

/**
 * 跨区检索。**只返回命中的少量条目**，绝不返回整区。
 *
 * @param {Record<string, object[]>} zones
 * @param {string} query
 * @param {{top?: number, threshold?: number}} [opts]
 * @returns {object[]} 命中的条目（按分数降序；同分时 永久 > 长期 > 短期）
 */
export function search(zones, query, opts) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const top = Number.isFinite(opts?.top) ? Math.max(1, Math.floor(opts.top)) : 3;
  const threshold = Number.isFinite(opts?.threshold) ? Number(opts.threshold) : 2;

  /** @type {Array<{entry: object, score: number, depth: number}>} */
  const scored = [];
  for (const zone of ['short', 'long', 'permanent']) {
    const list = Array.isArray(zones?.[zone]) ? zones[zone] : [];
    for (const entry of list) {
      const score = scoreEntry(entry, tokens);
      if (score <= 0 || score < threshold) continue;
      // 分区深浅用 ZONE_DEPTH 排，而不是硬编码 0/1/2：将来加区不会静默排错
      const depth = ZONE_DEPTH[entry.zone ?? zone] ?? ZONE_DEPTH[zone] ?? 0;
      scored.push({ entry, score, depth });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth; // 同分：越深越优先
    return (b.entry.ts ?? 0) - (a.entry.ts ?? 0); // 再同分：新的在前
  });

  return scored.slice(0, top).map((x) => x.entry);
}

/**
 * 从上一轮列出的候选里，挑出用户这轮点名的那一条。
 *
 * 场景：用户提了件没上下文的事，检索命中 3 条都可能。这时**不该猜**，也不该
 * 把三条全部展开塞进上下文 —— 正确做法是只列「时间 + 标题」让他挑，然后
 * 只读那一条。这个函数就是「他挑了哪条」的判定。
 *
 * 判定顺序（越明确越优先）：
 *  1. **序号**：「第二个」「第 2 个」「2」—— 用户直接点位置，最不容易错。
 *  2. **日期**：「10-22」「10月22」「22 号」「22 日」—— 对得上候选的 ts。
 *  3. **关键词**：他复述了某条的标题/关键词，覆盖最多的那条。
 *  4. 都不沾 → null（宁可不选，也不要猜错）。
 *
 * @param {object[]} candidates 上一轮列出的候选（顺序即编号，从 1 开始）
 * @param {string} userText 用户这轮的回复
 * @returns {object|null}
 */
export function pickFromCandidates(candidates, userText) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(
    (e) => e !== null && typeof e === 'object',
  );
  if (list.length === 0) return null;
  const text = typeof userText === 'string' ? userText.trim() : '';
  if (text === '') return null;

  // ── 1. 序号 ──
  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const ord = text.match(/第\s*([一二三四五六七八九]|\d{1,2})\s*[个条]?/);
  if (ord !== null) {
    const raw = ord[1];
    const idx = /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw];
    if (Number.isFinite(idx) && idx >= 1 && idx <= list.length) return list[idx - 1];
  }
  // 裸数字：整句就是「2」或「22 号那个」之外的「2」
  const bare = text.match(/^\s*(\d{1,2})\s*[个条]?\s*$/);
  if (bare !== null) {
    const idx = Number(bare[1]);
    if (idx >= 1 && idx <= list.length) return list[idx - 1];
  }

  // ── 2. 日期 ──
  const hits = [];
  for (const m of text.matchAll(/(\d{1,2})\s*[-/月]\s*(\d{1,2})/g)) {
    hits.push([Number(m[1]), Number(m[2])]);
  }
  // 「22 号」「22 日」单独出现时只给日
  for (const m of text.matchAll(/(\d{1,2})\s*[号日]/g)) {
    hits.push([null, Number(m[1])]);
  }
  for (const [mo, day] of hits) {
    const matched = list.filter((e) => {
      const d = new Date(Number(e?.ts) || 0);
      if (!Number.isFinite(d.getTime())) return false;
      if (d.getDate() !== day) return false;
      if (mo !== null && d.getMonth() + 1 !== mo) return false;
      return true;
    });
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) {
      // 同一天命中多条：交给关键词再分一次，分不出来就返回第一条（日期已经是他给的最强线索）
      const byKw = rankByKeywords(matched, text);
      return byKw ?? matched[0];
    }
  }

  // ── 3. 关键词 ──
  return rankByKeywords(list, text);
}

/**
 * 按关键词覆盖度排序，取第一名。覆盖为 0 返回 null（不沾就是不沾）。
 * @param {object[]} list
 * @param {string} text
 * @returns {object|null}
 */
function rankByKeywords(list, text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const e of list) {
    const keywords = (Array.isArray(e.keywords) ? e.keywords : []).map((k) =>
      String(k ?? '').toLowerCase(),
    );
    const title = String(e.title ?? '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += 2;
      else if (keywords.some((k) => k !== '' && (k.includes(t) || t.includes(k)))) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 给注入层用的本地自动检索（不调模型）。没有命中返回 []。
 *
 * 四条「保守」规则 —— 宁可漏，也不要每轮都往上下文里塞旧事：
 *  1. 用户这轮说的话太短（< 4 字）不检索：几乎不可能是「提起某件旧事」。
 *  2. **短期区照样参与检索**，重复交给渲染层去重。曾经的写法是「不查短期」，
 *     理由是「短期本来就整批进注入，再检索一遍会出现两次」—— 那个理由在空中成立，
 *     落地不成立：短期 18 条、预算只装得下 8 条，被裁掉的 10 条既没进注入、
 *     又因为不查短期而永远检索不到，成了死角。用户问「上次那个桌宠怎么做的」，
 *     库里明明有，就是想不起来。
 *     `renderInjection` 里本来就有 `shownIds` 去重，重复问题它已经解决了。
 *  3. 必须**锚定**命中：至少一个 token 落在 title 或 keywords 上。
 *     只有 detail 里偶然撞词的，不算「想起来了」。
 *  4. **不捞 `seed`（迁移进来的人格档案）**。这条是实测补的：
 *     档案条目 detail 动辄一两千字，2-gram 覆盖率高到离谱 —— 实测「今天天气怎么样」
 *     会命中「环境·主目录长什么样」，「Python 的 asyncio 怎么用」会命中「档案·干活习惯」。
 *     误报比漏报代价大得多：它每轮都往上下文里塞几条不相干的永久记忆，反而更费 token。
 *
 *     档案是「你是谁」，本来就靠 `loadPermanentCount` 每轮固定注入几条，
 *     不该再被"想起来"一次。真正该被检索捞回来的，是**经历过的事**。
 *
 *     注意：AI 主动调 `memory_search` / 面板搜索走的是 `search()`，**不排除 seed**——
 *     用户明确要查的时候，全库都得能查到。
 *
 * @param {Record<string, object[]>} zones
 * @param {string} lastUserText
 * @param {any} cfg
 * @returns {object[]}
 */
export function autoRecall(zones, lastUserText, cfg) {
  const text = typeof lastUserText === 'string' ? lastUserText.trim() : '';
  if (text.length < 4) return [];

  const top = Number.isFinite(cfg?.recallTop) ? Number(cfg.recallTop) : 3;
  const threshold = Number.isFinite(cfg?.recallThreshold) ? Number(cfg.recallThreshold) : 2;
  if (top <= 0) return [];

  // 多取一些再过滤：前 top 条可能全是 seed，过滤完就空了。
  const wide = search(zones ?? {}, text, { top: top + 8, threshold });
  if (wide.length === 0) return [];

  const tokens = tokenize(text);
  const hits = wide.filter((entry) => {
    // 档案不当"想起来的事"处理
    if (entry?.source === 'seed') return false;
    const keywords = (Array.isArray(entry.keywords) ? entry.keywords : []).map((k) =>
      String(k ?? '').toLowerCase(),
    );
    const title = String(entry.title ?? '').toLowerCase();
    return tokens.some(
      (t) =>
        title.includes(t) || keywords.some((k) => k !== '' && (k.includes(t) || t.includes(k))),
    );
  });
  return hits.slice(0, top);
}
