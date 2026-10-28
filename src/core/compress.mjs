/**
 * 压缩：一个区满了，就把最老的几条揉成一条更模糊的记忆，推进下一区。
 *
 * 三条不可动摇的规矩（它们全都在这个文件里落实）：
 *   1. 合并后保留**最老那条**的 ts —— 记忆的时间是事件发生的时间，
 *      不是「被揉成一团」的那天。丢了 ts，这条记忆在遗忘曲线上的位置就漂了。
 *   2. depth = max(depth)+1 —— 每揉一次就模糊一层。
 *   3. detail 永远不空、且不短于 40 字（源数据本身短于 40 的除外，不许编内容）。
 *
 * 纯函数 / 零依赖。模型那条路（compressWithModel）把 stream 从外面传进来，
 * 这样测试不用起真的 LLM，也不会把 core 层绑死在任何 provider 上。
 */

import {
  clamp01,
  detailFloor,
  makeId,
  normalizeEntry,
  normalizeKeywords,
} from './schema.mjs';
import { overflowCount } from './zones.mjs';

/**
 * 按字符上限截断 detail，尽量切在句末标点，免得把一句话砍成半截观感更差。
 * 不追加省略号 —— 注入文本的形状由 SPEC §11 定死，不在这里加新符号。
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncateDetail(text, limit) {
  const s = String(text ?? '');
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : s.length;
  if (s.length <= max) return s;
  if (max <= 0) return '';
  const head = s.slice(0, max);
  // 只在截断点附近（后 30%）找句末标点，否则会把 detail 砍得只剩第一句
  const tailFrom = Math.floor(max * 0.7);
  const m = head.slice(tailFrom).match(/[。！？；!?;]/);
  if (m && typeof m.index === 'number') {
    const cut = tailFrom + m.index + 1;
    if (cut >= 40 || cut >= max * 0.5) return head.slice(0, cut);
  }
  return head;
}

/** 取「首句」，用于兜底合并时压缩每条 detail。 */
function firstSentence(text) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return '';
  const m = s.match(/^[^。！？!?；;\n]*[。！？!?；;]?/);
  const cut = (m ? m[0] : s).trim();
  return cut === '' ? s : cut;
}

/** 按 ts 找最老的一条。entries 可能为空。 */
function oldestOf(entries) {
  let oldest = null;
  for (const e of entries) {
    if (oldest === null || (e.ts ?? 0) < (oldest.ts ?? 0)) oldest = e;
  }
  return oldest;
}

/**
 * 组内权重的算术平均。**故意等权**：
 * 按 weight 自己加权会让一条 0.95 的记忆把整组的权重抬到 0.9，等于压缩不但没
 * 代价，还奖励了「混进一条高分记忆」。等权平均反而天然实现「越揉越淡」——
 * 这正是遗忘曲线想要的。
 */
function averageWeight(entries) {
  if (entries.length === 0) return 0.4;
  const sum = entries.reduce((n, e) => n + clamp01(e.weight), 0);
  return clamp01(sum / entries.length);
}

/**
 * 挑出该被压缩的那批：按 ts 升序取最老的 k 条。
 * k 来自 `overflowCount`（没超容 → 空数组，调用方不用自己判）。
 *
 * @param {'short'|'long'|'permanent'} zone
 * @param {object[]} entries
 * @param {any} cfg
 * @returns {object[]}
 */
export function pickCompressGroup(zone, entries, cfg) {
  const list = Array.isArray(entries) ? [...entries] : [];
  if (list.length === 0) return [];
  // 容量判定收在 zones.mjs 里，这里不重新推一遍公式（两处公式 = 迟早不同步）
  const over = overflowCount(zone, list, cfg);
  if (over <= 0) return [];
  return list
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .slice(0, Math.min(over, list.length));
}

/**
 * 本地兜底合并。**必须永远能出一个条目** —— 模型挂了、被截断、返回乱码时，
 * 记忆不能因此消失，只能变模糊。
 *
 * @param {object[]} entries
 * @param {{now?: number}} [opts]
 * @returns {object}
 */
export function fallbackMerge(entries, opts) {
  const now = Number.isFinite(opts?.now) ? /** @type {number} */ (opts.now) : Date.now();
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e !== null && typeof e === 'object',
  );
  const oldest = oldestOf(list);
  const n = list.length;

  const ts = Number.isFinite(oldest?.ts) ? /** @type {number} */ (oldest.ts) : now;
  const baseDepth = list.reduce(
    (d, e) => Math.max(d, Math.round(Number(e.depth) || 0)),
    0,
  );
  const depth = Math.min(9, baseDepth + 1);
  const zone = oldest?.zone ?? 'short';

  // ── title：最老那条的标题 + 条数后缀（后缀不能被 80 字上限吃掉）──
  const suffix = n > 1 ? `（合并 ${n} 条）` : '（压缩）';
  const baseTitle = String(oldest?.title ?? oldest?.detail ?? '').trim() || '（无标题记忆）';
  const title = `${baseTitle.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;

  // ── detail：各条首句「；」连接，按 depth 截断，但不短于 40 ──
  const parts = [];
  for (const e of list) {
    const s = firstSentence(e.detail) || firstSentence(e.title);
    if (s === '') continue;
    if (!parts.includes(s)) parts.push(s);
  }
  let joined = parts.join('；');
  if (joined === '') {
    // 全组都没有可用文字：也要给出一句人看得懂的话，且长度顶得住 40 字下限 ——
    // 返回一句「（空）」等于这条记忆被静默删掉了。
    joined = `（合并了 ${n} 条记忆，原始细节已经丢失，只剩下这个时间点和主题作为线索，具体内容不再保留）`;
  }
  const target = detailFloor(depth, joined.length);
  const detail = truncateDetail(joined, target) || joined;

  // ── keywords：并集去重取前 10（normalizeKeywords 负责去重与上限）──
  const keywords = normalizeKeywords(list.flatMap((e) => (Array.isArray(e.keywords) ? e.keywords : [])));

  const mergedFrom = list
    .map((e) => (typeof e.id === 'string' ? e.id : ''))
    .filter((id) => id !== '');

  return normalizeEntry(
    {
      id: makeId(ts, mergedFrom),
      ts,
      zone,
      weight: averageWeight(list),
      title,
      detail,
      keywords: keywords.length > 0 ? keywords : undefined,
      source: 'merge',
      depth,
      mergedFrom,
      session: oldest?.session ?? '',
      createdAt: now,
    },
    { zone, now, source: 'merge' },
  );
}

/** 调模型把几条揉成一条。**失败一律返回 null**，由调用方退回 fallbackMerge。 */
const COMPRESS_SYSTEM = [
  '你是记忆压缩器。把下面几条记忆揉成一条更模糊、但还能认出来的记忆。',
  '',
  '规则：',
  '1. 只保留共同主题与最关键的事实，丢掉具体细节、具体数字、具体措辞。',
  '2. title 一句话，不超过 40 字；detail 用第一人称「我」写（他称「他」），40-120 字，不能为空；',
  '   不要出现"对方""用户""她"这类第三人称指代 —— 2026-10-28 之前这里写的是"第三人称"，',
  '   结果压缩一次就把语气抹平一次，注入进上下文之后她说话也跟着变成旁白。',
  '3. keywords 给 2-6 个词，用于日后检索。',
  '4. 不要输出时间、日期、解释、markdown 围栏。',
  '5. 输出严格 JSON：{"title":"…","detail":"…","keywords":["…"]}',
].join('\n');

/** 把 stream 的返回值（字符串 / 异步可迭代 / 对象）统统收成一段文本。 */
async function collectText(out) {
  if (out === null || out === undefined) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object' && typeof out.then === 'function') {
    return collectText(await out);
  }
  if (typeof out === 'object' && typeof out[Symbol.asyncIterator] === 'function') {
    let text = '';
    for await (const chunk of out) {
      if (chunk === null || chunk === undefined) continue;
      if (typeof chunk === 'string') {
        text += chunk;
        continue;
      }
      // DSH 的 llm.stream 用 text-delta 增量；别的事件（reasoning/tool）一律不收
      const type = String(chunk.type ?? chunk.kind ?? '');
      if (type !== '' && type !== 'text-delta' && type !== 'text') {
        if (type === 'error') return '';
        continue;
      }
      const piece = chunk.text ?? chunk.delta ?? chunk.textDelta ?? chunk.content;
      if (typeof piece === 'string') text += piece;
    }
    return text;
  }
  if (typeof out === 'object') {
    const piece = out.text ?? out.content ?? out.result;
    if (typeof piece === 'string') return piece;
  }
  return '';
}

/** 剥围栏 + 找第一个 JSON 值。解析失败返回 null（整批丢弃，不写半成品）。 */
function parseModelJson(text) {
  let s = String(text ?? '').trim();
  if (s === '') return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const slice = s.slice(start);
  // 从最后一个闭合符往前退，容忍尾巴上多一句「希望有帮助」
  const endA = slice.lastIndexOf('}');
  const endB = slice.lastIndexOf(']');
  const end = Math.max(endA, endB);
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(slice.slice(0, end + 1));
    if (Array.isArray(parsed)) return parsed.find((x) => x && typeof x === 'object') ?? null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 调模型压缩成一条更模糊的记忆。
 *
 * @param {object[]} entries
 * @param {object} p
 * @param {(req: object) => any} p.stream 注入的流函数（测试里是桩）
 * @param {string} [p.provider]
 * @param {string} [p.model]
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 * @param {'short'|'long'|'permanent'} [p.zone] 合并后要落进哪个区
 * @param {number} [p.now]
 * @returns {Promise<object|null>}
 */
export async function compressWithModel(entries, p) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e !== null && typeof e === 'object',
  );
  if (list.length === 0) return null;
  if (typeof p?.stream !== 'function') return null;
  const now = Number.isFinite(p?.now) ? /** @type {number} */ (p.now) : Date.now();
  const oldest = oldestOf(list);
  const zone = ['short', 'long', 'permanent'].includes(p?.zone) ? p.zone : oldest?.zone ?? 'short';
  const ts = Number.isFinite(oldest?.ts) ? /** @type {number} */ (oldest.ts) : now;
  const depth = Math.min(
    9,
    list.reduce((d, e) => Math.max(d, Math.round(Number(e.depth) || 0)), 0) + 1,
  );

  const listing = list
    .map((e, i) => `${i + 1}. [${e.title ?? ''}] ${e.detail ?? ''}`)
    .join('\n');

  let out = '';
  try {
    out = await collectText(
      await p.stream({
        provider: p.provider,
        model: p.model,
        maxTokens: Number.isFinite(p.maxTokens) ? p.maxTokens : 800,
        system: COMPRESS_SYSTEM,
        messages: [{ role: 'user', content: `要压缩的记忆：\n${listing}` }],
        temperature: 0.2,
        // 压缩这种活不需要思考档位，开着反而更容易吐不完就被 max-tokens 截断
        reasoningEffort: 'off',
        signal: p.signal,
      }),
    );
  } catch {
    // 超时 / abort / 网络炸 / 解析炸：统一退回本地兜底
    return null;
  }

  const raw = parseModelJson(out);
  if (raw === null) return null;

  const fallback = fallbackMerge(list, { now });
  const modelDetail = String(raw.detail ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  // detail 低于 40 字（或干脆空）就退回本地拼出来的那段：越揉越模糊，
  // 但绝不能揉成一句空话 —— 那样等于这条记忆被静默删掉了。
  const detail = modelDetail.length >= 40 ? modelDetail : fallback.detail;
  const title = String(raw.title ?? '').trim() || fallback.title;
  const keywords = normalizeKeywords(
    Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords ?? ''),
  );

  let entry;
  try {
    entry = normalizeEntry(
      {
        ts,
        zone,
        // 模型给了合理的 weight 就用它的（它见过原文），否则用组内平均
        weight: Number.isFinite(Number(raw.weight)) ? Number(raw.weight) : fallback.weight,
        title: title.slice(0, 80),
        detail,
        keywords: keywords.length > 0 ? keywords : fallback.keywords,
        source: 'merge',
        depth,
        mergedFrom: list.map((e) => e.id).filter((id) => typeof id === 'string' && id !== ''),
        session: oldest?.session ?? '',
        createdAt: now,
      },
      { zone, now, source: 'merge' },
    );
  } catch {
    return null;
  }

  if (entry === null) return null;
  // 最后一道闸：任何路径都不许交出空 detail
  if (typeof entry.detail !== 'string' || entry.detail.trim() === '') {
    return { ...entry, detail: fallback.detail };
  }
  return entry;
}
