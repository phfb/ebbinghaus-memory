/**
 * 时间处理。**全部按本地时区**。
 *
 * 记忆里最重要的一个字段就是时间戳 —— 用户明确要求「记忆内容必须带时间戳」。
 * 而「带时间戳」有两层意思，两层都要做到：
 *
 *   1. 磁盘上要有精确的、可排序的时间（`ts` 毫秒 + `iso` 字符串）。
 *   2. 注入/面板上要读得懂（「昨天」「3 天前」「10-05」）。
 *
 * 第 2 层刻意用相对说法：人的记忆就是这样编码的。写成「2026-10-24 21:30」
 * 反而会让模型把注意力花在算日期上。
 */

import { isoOfLocal } from './schema.mjs';

/** 一天的毫秒数。刻意不用 86400000 常量散落各处 —— 夏令时不存在于本机，但仍统一。 */
export const DAY_MS = 86400000;

function two(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} ts
 * @returns {string} 本地时区 ISO 串
 */
export function isoOf(ts) {
  return isoOfLocal(ts);
}

/**
 * 短签：`10-24 21:30`。同一年里够用，注入里最常用这个。
 * @param {number} ts
 * @returns {string}
 */
export function stampFor(ts) {
  const d = new Date(ts);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 全签：`2026-10-24 21:30`。面板和导出用。
 * @param {number} ts
 * @returns {string}
 */
export function fullStamp(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

/**
 * 当天 00:00:00.000 的时间戳。
 * @param {number} ts
 * @returns {number}
 */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 日历天差：b 比 a 晚几天。今天和昨天 = 1，同一分钟 = 0。
 *
 * 用日历天而不是 24 小时，是因为「昨天晚上」和「今天凌晨」对人是两天，
 * 对 86400000 是一天 —— 后者会让注入里出现「今天」修饰一件昨天的事。
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

/**
 * 相对时间说法。这是注入里给人看的那一层。
 *
 *  0 → 今天   1 → 昨天   2..6 → N 天前   7.. → MM-DD
 *
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function relativeLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const d = daysBetween(ts, now);
  if (d <= 0) {
    // 同一天但跨了几小时：说「今天」比「0 天前」自然
    return '今天';
  }
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  const dt = new Date(ts);
  return `${two(dt.getMonth() + 1)}-${two(dt.getDate())}`;
}

/**
 * 相对时间 + 点钟：`昨天 21:30` / `3 天前 03:12` / `10-05 14:00`。
 * 面板里用这个，比裸时间戳友好，又不丢精度。
 *
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function relativeStamp(ts, now = Date.now()) {
  const d = new Date(ts);
  const label = relativeLabel(ts, now);
  const hhmm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return label === '今天' ? `今天 ${hhmm}` : `${label} ${hhmm}`;
}

/**
 * 这条记忆是否已过它的分区周期。
 *
 * 判定一律用 `ts`（事件发生时间）—— 用户明确要求「时间戳按照原有记忆时间」，
 * 迁移进来的旧记忆如果按入库时间算，会全部变成「刚发生」，遗忘曲线就失效了。
 *
 * @param {number} ts
 * @param {number} windowDays
 * @param {number} [now]
 * @returns {boolean}
 */
export function isExpired(ts, windowDays, now = Date.now()) {
  if (!Number.isFinite(ts)) return false;
  const w = Number(windowDays);
  if (!Number.isFinite(w) || w <= 0) return false;
  return now - ts >= w * DAY_MS;
}

/**
 * 距离过期还有几天（已经过期返回 0，不足一天返回 1 —— 人不会说「还有 0.3 天」）。
 * @param {number} ts
 * @param {number} windowDays
 * @param {number} [now]
 * @returns {number}
 */
export function daysUntilExpiry(ts, windowDays, now = Date.now()) {
  if (!Number.isFinite(ts)) return 0;
  const w = Number(windowDays);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const left = ts + w * DAY_MS - now;
  if (left <= 0) return 0;
  return Math.max(1, Math.ceil(left / DAY_MS));
}

/**
 * 给「这一区最近一条什么时候到期」用的汇总。
 * @param {Array<{ts:number}>} entries
 * @param {number} windowDays
 * @param {number} [now]
 * @returns {{nextInDays: number|null, expired: number}}
 */
export function expiryOverview(entries, windowDays, now = Date.now()) {
  let expired = 0;
  /** @type {number|null} */
  let soonest = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const ts = Number(e?.ts);
    if (!Number.isFinite(ts)) continue;
    if (isExpired(ts, windowDays, now)) {
      expired += 1;
      continue;
    }
    const left = daysUntilExpiry(ts, windowDays, now);
    if (soonest === null || left < soonest) soonest = left;
  }
  return { nextInDays: soonest, expired };
}
