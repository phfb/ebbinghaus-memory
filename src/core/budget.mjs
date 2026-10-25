/**
 * 全库总量（token）—— 第二道闸。
 *
 * 为什么要它：条数上限管不住体积。永久区 1000 条里只要混进几条三千字的旧档案，
 * 条数才用掉 5%，检索、面板渲染、回收判断就都开始拖。所以除了「每个分区最多
 * 多少条」，还要有「整库按注入格式渲染出来一共多少 token」。
 *
 * 口径必须与注入**完全一致**：
 *   同一套 `detailLimitFor()` 截断 → 同一个 `renderEntryLine()` 措辞 →
 *   同一个 `countTokens()` 系数（中文 1.8 字 ≈ 1 token）。
 * 换任何一个，面板上的数和实际进上下文的东西就不是一回事了。
 *
 * 这一层是纯函数：不碰 fs、不碰 ctx，`node --test` 直跑。
 */

import { countTokens, detailLimitFor, renderEntryLine } from './render.mjs';

/** 总量上限的钳制区间。300000 是硬顶（用户定的）。 */
export const TOTAL_CAPACITY_MIN = 5000;
export const TOTAL_CAPACITY_MAX = 300000;
export const TOTAL_CAPACITY_DEFAULT = 100000;

/**
 * 回收时先动哪个区。
 *
 * 与注入预算的裁剪顺序同源（render.mjs 的 CUT_ORDER）：长期区是「随机忆起的
 * 背景音」，砍了不心疼；短期是刚发生的事，次之；永久是人格底色，最后动。
 */
const ZONE_RECLAIM_ORDER = Object.freeze(['long', 'short', 'permanent']);

/** 永久区里 weight 到这个数的是「关于这个人本身」的底色，不参与回收。 */
const CORE_WEIGHT_FLOOR = 0.92;

/** 24 小时内的记忆不优先压 —— 刚记下来的事很可能马上要用。 */
const FRESH_MS = 86400000;

/** 一次压几条。少于 2 条不压（一条揉不成印象）。 */
const GROUP_SIZE = 3;

/**
 * 配置里的总量上限，钳到合法区间。
 *
 * @param {any} cfg
 * @returns {number}
 */
export function totalCapacityOf(cfg) {
  const n = Number(cfg?.totalTokenCapacity);
  if (!Number.isFinite(n) || n <= 0) return TOTAL_CAPACITY_DEFAULT;
  return Math.min(TOTAL_CAPACITY_MAX, Math.max(TOTAL_CAPACITY_MIN, Math.round(n)));
}

/**
 * 单条记忆按注入格式渲染后的 token 估算。
 *
 * @param {object} entry
 * @param {'short'|'long'|'permanent'} zone
 * @param {any} cfg
 * @param {number} [now]
 * @returns {number}
 */
export function estimateEntryTokens(entry, zone, cfg, now) {
  if (entry === null || typeof entry !== 'object') return 0;
  const t = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const z = zone === 'long' || zone === 'permanent' ? zone : 'short';
  try {
    const limit = detailLimitFor(entry, z, cfg);
    return countTokens(renderEntryLine(entry, { now: t, detailLimit: limit }));
  } catch {
    // 渲染失败不该让整块统计塌掉 —— 退回「标题 + 权重」的粗估
    return Math.ceil((String(entry.title ?? '').length + 12) / 1.8);
  }
}

/**
 * 全库总量。面板、工具、回收判断共用这一份，绝不在别处另算一遍。
 *
 * @param {object} zones 三区条目
 * @param {any} cfg
 * @param {number} [now]
 * @returns {{total:number, capacity:number, ratio:number, over:boolean,
 *            left:number, byZone:Record<string,number>, count:number}}
 */
export function tokenUsage(zones, cfg, now) {
  const t = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const src = zones && typeof zones === 'object' ? zones : {};
  /** @type {Record<string, number>} */
  const byZone = { short: 0, long: 0, permanent: 0 };
  let count = 0;

  for (const zone of ['short', 'long', 'permanent']) {
    const list = Array.isArray(src[zone]) ? src[zone] : [];
    let sum = 0;
    for (const e of list) {
      sum += estimateEntryTokens(e, /** @type {any} */ (zone), cfg, t);
      count += 1;
    }
    byZone[zone] = sum;
  }

  const total = byZone.short + byZone.long + byZone.permanent;
  const capacity = totalCapacityOf(cfg);
  return {
    total,
    capacity,
    ratio: capacity > 0 ? Math.min(1, total / capacity) : 0,
    over: total > capacity,
    left: Math.max(0, capacity - total),
    byZone,
    count,
  };
}

/** 「这条太新，先别动」= 1，否则 0。排序时把新鲜的推到后面。 */
function freshRank(entry, now) {
  const ts = Number(entry?.ts);
  if (!Number.isFinite(ts)) return 0;
  return now - ts < FRESH_MS ? 1 : 0;
}

/**
 * 挑一组该被回收的记忆。一次只挑一组 —— 回收必须一轮一轮来，
 * 因为每压一次库就变了，下一组的判断得基于新的库。
 *
 * 组内规则：**同一个区**（压缩是「压进下一区」，跨区压没有意义）、
 * 权重最低 + 最老优先、新记忆（24h 内）排在后面、永久区的底色（weight ≥0.92）不碰。
 *
 * 返回 `null` 表示「没得压了」—— 这时总量还超着，就是真的到极限了
 * （所有剩下的条目要么是人格底色，要么一条区里只剩一条）。
 *
 * @param {object} zones
 * @param {any} cfg
 * @param {number} [now]
 * @param {{groupSize?:number}} [opts]
 * @returns {{zone:'short'|'long'|'permanent', entries:object[]} | null}
 */
export function pickReclaimGroup(zones, cfg, now, opts) {
  const t = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const src = zones && typeof zones === 'object' ? zones : {};
  const rawSize = Number(opts?.groupSize);
  const groupSize = Number.isFinite(rawSize) && rawSize >= 2 ? Math.floor(rawSize) : GROUP_SIZE;

  for (const zone of ZONE_RECLAIM_ORDER) {
    const list = Array.isArray(src[zone]) ? src[zone] : [];
    const usable = list.filter((e) => {
      if (e === null || typeof e !== 'object') return false;
      if (typeof e.id !== 'string' || e.id === '') return false;
      // 永久区的人格底色不参与回收 —— 那是「我记得你是什么样的人」
      if (zone === 'permanent' && (Number(e.weight) || 0) >= CORE_WEIGHT_FLOOR) return false;
      return true;
    });
    if (usable.length < 2) continue;

    const sorted = usable.slice().sort((a, b) => {
      const fa = freshRank(a, t);
      const fb = freshRank(b, t);
      if (fa !== fb) return fa - fb;
      const wa = Number(a.weight) || 0;
      const wb = Number(b.weight) || 0;
      if (wa !== wb) return wa - wb;
      return (Number(a.ts) || 0) - (Number(b.ts) || 0);
    });

    const group = sorted.slice(0, Math.min(groupSize, sorted.length));
    if (group.length < 2) continue;
    return { zone: /** @type {any} */ (zone), entries: group };
  }
  return null;
}
