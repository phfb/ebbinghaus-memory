/**
 * 三分区策略：新记忆进哪、到期去哪、区满了挪多少。
 *
 * 这里是整条遗忘曲线的「时钟」——所有判定只看 `entry.ts`（事件发生时间）。
 * 为什么死死认 ts：迁移进来的旧记忆 createdAt 是「今天」，按它算的话，一条
 * 2024 年的事会显示成「刚发生」，然后安安稳稳在短期区待满 7 天。遗忘曲线就废了。
 *
 * 纯函数：不改入参、不碰 fs、不碰 ctx。`node --test` 直接跑。
 */

import { ZONES, clamp01 } from './schema.mjs';
import { CONFIG_DEFAULTS } from './config.mjs';
import { isExpired } from './time.mjs';

/** 各区容量配置键。写死映射，免得调用方每次拼字符串拼错。 */
const CAPACITY_KEY = Object.freeze({
  short: 'shortCapacity',
  long: 'longCapacity',
  permanent: 'permanentCapacity',
});

/** 分区周期配置键。永久区没有周期 —— 它不会到期。 */
const WINDOW_KEY = Object.freeze({
  short: 'shortDays',
  long: 'longDays',
  permanent: null,
});

/**
 * 配置里的容量上限。缺键/坏值时退回 config.mjs 的默认值，
 * 而不是 Infinity —— 一个坏配置不该把某个区变成无底洞。
 *
 * ⚠️ 兜底值**必须从 CONFIG_DEFAULTS 取**，不能在这里另写一份数字：
 * 默认容量 2026-10-25 从 60/120/240 提到 120/600/1000，这处写死的旧值
 * 会让「坏配置」和「默认配置」算出两个不同的上限，而且面板上看不出来。
 *
 * @param {'short'|'long'|'permanent'} zone
 * @param {any} cfg
 * @returns {number}
 */
export function zoneCapacity(zone, cfg) {
  const key = CAPACITY_KEY[zone];
  if (key === undefined) return 0;
  const n = Number(cfg?.[key]);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return Number(CONFIG_DEFAULTS[key]) || 0;
}

/**
 * 新条目进哪一区。
 *
 * 用户的原话：「由 AI 自主进行权重判断哪些是永久记忆，哪些是短期记忆，哪些是
 * 长期记忆」。所以这里必须给 AI 留下判决权 —— `hint` 是固化时模型自己给的
 * zone 建议（人格、雷区、长期项目这类，模型会直接判 permanent）。
 *
 * 但**判决权不等于自由裁量权**：模型不给 hint 时，只有极高权重才会空降，
 * 因为入库那一刻的权重恰恰是最不可靠的（它还没见过这条记忆被反复引用）。
 * 绝大多数记忆仍然从短期起步，让时间去验证。这就是遗忘曲线本身。
 *
 * @param {number} weight
 * @param {any} cfg
 * @param {'short'|'long'|'permanent'} [hint] 固化时模型给的建议分区
 * @returns {'short'|'long'|'permanent'}
 */
export function initialZoneFor(weight, cfg, hint) {
  if (hint === 'short' || hint === 'long' || hint === 'permanent') return hint;
  const w = clamp01(weight);
  // 空降门槛刻意设得很高：0.92 以上基本只可能是「人格 / 雷区 / 死规矩」这种
  // 一句话就会反复用到的记忆，让它在短期区待 7 天纯属浪费注入预算。
  if (w >= 0.92) return 'permanent';
  if (w >= 0.78) return 'long';
  return 'short';
}

/**
 * 到期收割。**纯函数，不改入参**（返回的 zones 是新的数组 + 新的条目对象）。
 *
 * 三条分支（短期为例，长期同理）：
 *   weight ≥ promoteShortToLong  → 升级到 long
 *   weight <  forgetBelow        → 淘汰（进 `dropped`，交给调用方先压缩再清掉）
 *   其余                          → 留在原区，depth+1
 *
 * 留级为什么只加 depth 不改 detail：磁盘永远保留细节（SPEC §3.3），
 * 「变模糊」是渲染时按 depth 截断出来的效果。真把 detail 抹短了，
 * 用户日后在面板里就再也找不回原话。
 *
 * 淘汰为什么不在这里直接扔掉：用户的原话是「进行剔除（压缩）后再删去记忆区」。
 * 被淘汰的那几条要先被揉成一条模糊印象留在原区，否则「那段日子发生过什么」
 * 会彻底变成空白 —— 而遗忘曲线的本意是**细节消失、印象留存**。
 * 这里只负责把它们捞出来（`dropped`），压缩动作由调用方做（compress.mjs 在
 * zones.mjs 的下游，反向 import 会成环）。
 *
 * @param {{zones: Record<string, object[]>, cfg: any, now?: number}} p
 * @returns {{zones: Record<string, object[]>, plan: Array<{id: string, from: string, to: string, reason: string}>, dropped: Record<string, object[]>}}
 */
export function harvest(p) {
  const src = p?.zones ?? {};
  const cfg = p?.cfg ?? {};
  const now = Number.isFinite(p?.now) ? /** @type {number} */ (p.now) : Date.now();

  /** @type {Record<string, object[]>} */
  const zones = { short: [], long: [], permanent: [] };
  /** @type {Array<{id: string, from: string, to: string, reason: string}>} */
  const plan = [];
  /** @type {Record<string, object[]>} 被淘汰的条目，按原分区归组 */
  const dropped = { short: [], long: [] };

  const promoteTo = { short: 'long', long: 'permanent' };
  const promoteKey = { short: 'promoteShortToLong', long: 'promoteLongToPermanent' };

  for (const zone of ZONES) {
    const list = Array.isArray(src[zone]) ? src[zone] : [];

    // 永久区不参与到期判定：它已经是最后一站。
    if (WINDOW_KEY[zone] === null) {
      zones[zone].push(...list.map((e) => ({ ...e, zone })));
      continue;
    }

    const windowDays = Number(cfg[WINDOW_KEY[zone]]);
    const promoteLine = clamp01(cfg[promoteKey[zone]] ?? 0.55);
    const forgetLine = clamp01(cfg.forgetBelow ?? 0.2);

    for (const e of list) {
      const ts = Number(e?.ts);
      const entry = { ...e, zone };

      if (!isExpired(ts, windowDays, now)) {
        // 没到期：什么都不做，连 plan 都不记（不然 plan 会淹没在「没变化」里）
        zones[zone].push(entry);
        continue;
      }

      const w = clamp01(entry.weight);
      if (w >= promoteLine) {
        const to = promoteTo[zone];
        // 升级不改 ts、不改 depth：分区深浅本身已经承担了「模糊一层」，
        // 再叠 depth 会让同一条记忆被罚两次。
        zones[to].push({ ...entry, zone: to });
        plan.push({
          id: String(entry.id ?? ''),
          from: zone,
          to,
          reason: `过 ${WINDOW_KEY[zone]}（${windowDays} 天）且权重 ${w.toFixed(2)} ≥ ${promoteLine}，升级`,
        });
        continue;
      }

      if (w < forgetLine) {
        // 淘汰：不进返回的 zones，但**进 dropped** —— 调用方要把这批揉成
        // 一条模糊印象再清掉（「压缩后剔除」，不是凭空消失）。
        dropped[zone].push(entry);
        plan.push({
          id: String(entry.id ?? ''),
          from: zone,
          to: 'drop',
          reason: `过 ${WINDOW_KEY[zone]}（${windowDays} 天）且权重 ${w.toFixed(2)} < ${forgetLine}，遗忘`,
        });
        continue;
      }

      // 留级：加深一层，顺便让它下次更容易被压缩掉。
      const depth = Math.min(9, Math.max(0, Math.round(Number(entry.depth) || 0)) + 1);
      zones[zone].push({ ...entry, depth });
      plan.push({
        id: String(entry.id ?? ''),
        from: zone,
        to: 'stay',
        reason: `过 ${WINDOW_KEY[zone]}（${windowDays} 天）权重 ${w.toFixed(2)} 在 [${forgetLine}, ${promoteLine}) 之间，留在原区并模糊一层`,
      });
    }
  }

  // 文件内按 ts 升序（SPEC §2），store.setZone 也会排，但这里排好能让调用方立刻用。
  for (const zone of ZONES) zones[zone].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  return { zones, plan, dropped };
}

/**
 * 把一批被淘汰的记忆揉成一条「那段时间的印象」。
 *
 * 这是「压缩后剔除」的落地：N 条要忘掉的记忆 → 1 条模糊印象留在原区。
 * 权重刻意压在 `forgetBelow + 0.1` 左右 —— 高于遗忘线（不会下一轮又被判死），
 * 低于升级线（不会反向爬回长期）。它只能靠一次次到期不断 depth+1 变模糊，
 * 像人对一段过去的记忆：说不出细节，但知道那阵子在忙什么。
 *
 * @param {object[]} droppedList 被淘汰的条目
 * @param {any} cfg
 * @param {number} [now]
 * @returns {object|null} 印象条目；少于 2 条时不生成（一条不值得单独留印象）
 */
export function digestDropped(droppedList, cfg, now) {
  const list = (Array.isArray(droppedList) ? droppedList : []).filter(
    (e) => e !== null && typeof e === 'object',
  );
  if (list.length < 2) return null;

  const stamp = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const oldest = list.reduce((a, b) => ((a?.ts ?? Infinity) <= (b?.ts ?? Infinity) ? a : b));
  const zone = oldest?.zone === 'long' ? 'long' : 'short';
  const forgetLine = clamp01(cfg?.forgetBelow ?? 0.2);
  const promoteLine = clamp01(
    zone === 'long' ? (cfg?.promoteLongToPermanent ?? 0.7) : (cfg?.promoteShortToLong ?? 0.55),
  );
  // 夹在遗忘线和升级线之间，并偏向遗忘线
  const weight = Math.min(
    Math.max(0, promoteLine - 0.05),
    Math.min(1, forgetLine + 0.1),
  );

  const titles = list
    .map((e) => String(e.title ?? '').trim())
    .filter((t) => t !== '')
    .slice(0, 6);
  const baseDepth = list.reduce((d, e) => Math.max(d, Math.round(Number(e.depth) || 0)), 0);

  return {
    ts: Number.isFinite(oldest?.ts) ? oldest.ts : stamp,
    zone,
    weight,
    title: `那阵子：${titles[0] ?? '一些零碎的事'}`.slice(0, 80),
    detail:
      `（这段日子有 ${list.length} 件事已经记不清细节，只剩下一个大概印象：` +
      `${titles.join('；') || '和他在忙些事情'}。）`,
    keywords: [],
    source: 'merge',
    depth: Math.min(9, baseDepth + 1),
    mergedFrom: list.map((e) => String(e?.id ?? '')).filter((x) => x !== ''),
    session: typeof oldest?.session === 'string' ? oldest.session : '',
    createdAt: stamp,
  };
}

/**
 * 某区是否超容。**严格大于**：正好等于上限不算超（否则每次写到上限都要压一次）。
 * @param {'short'|'long'|'permanent'} zone
 * @param {object[]} entries
 * @param {any} cfg
 * @returns {boolean}
 */
export function isOverCapacity(zone, entries, cfg) {
  const list = Array.isArray(entries) ? entries : [];
  return list.length > zoneCapacity(zone, cfg);
}

/**
 * 超容时要挪走多少条。
 *
 * 没超容返回 0（返回 1 的话调用方一调 `pickCompressGroup` 就会无端压掉一条新记忆）。
 * 超容时至少 1，正好把条数压回上限以内。
 *
 * @param {'short'|'long'|'permanent'} zone
 * @param {object[]} entries
 * @param {any} cfg
 * @returns {number}
 */
export function overflowCount(zone, entries, cfg) {
  const list = Array.isArray(entries) ? entries : [];
  const over = list.length - zoneCapacity(zone, cfg);
  if (over <= 0) return 0;
  return Math.max(1, over);
}
