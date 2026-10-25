/**
 * `src/core/render.mjs` 的**测试桩**（见 zones.mjs 里的说明）。
 *
 * 注入文本的**形状**照 SPEC §11 写（开闭标签、分区标题、空区不出现），
 * 措辞从简 —— host 层测试只关心「这段文本有没有被真的渲染出来、
 * 缓存有没有按轮作废」。
 */

import { stampFor } from '../../src/core/time.mjs';

const ZONE_TITLE = {
  short: '〔短期 · 最近 7 天〕',
  long: '〔长期 · 偶尔想起来〕',
  permanent: '〔永久 · 我记得的〕',
};

function line(entry, now, detailLimit) {
  const when = now - (Number(entry?.ts) || 0) < 86400000 ? '今天' : stampFor(entry?.ts);
  const detail = String(entry?.detail ?? '');
  const cut = Number.isFinite(detailLimit) ? Math.max(40, detailLimit) : detail.length;
  const shown = detail.length > cut ? `${detail.slice(0, cut)}…` : detail;
  return `- [${when}] ${String(entry?.title ?? '')} —— ${shown} · ${Number(entry?.weight ?? 0).toFixed(2)}`;
}

export function renderEntryLine(entry, { now = Date.now(), detailLimit } = {}) {
  return line(entry, now, detailLimit);
}

export function renderInjection({ zones, cfg: _cfg, now = Date.now(), recalled = [], budgetTokens }) {
  const parts = [];
  const breakdown = {};
  parts.push('<ebbinghaus-memory>');
  parts.push('你的记忆按遗忘曲线分三层。时间戳是事件发生的时间，不是你现在的时间。');
  parts.push('不要凭空补全这里没有的事。');
  for (const zone of ['short', 'long', 'permanent']) {
    const entries = zones?.[zone] ?? [];
    breakdown[zone] = entries.length;
    if (entries.length === 0) continue;
    parts.push('');
    parts.push(ZONE_TITLE[zone]);
    const limit = zone === 'short' ? 400 : zone === 'long' ? 240 : 120;
    for (const e of entries) parts.push(line(e, now, limit));
  }
  if (Array.isArray(recalled) && recalled.length > 0) {
    breakdown.recalled = recalled.length;
    parts.push('');
    parts.push('〔这轮想起来的〕');
    for (const e of recalled) parts.push(line(e, now, 200));
  }
  parts.push('</ebbinghaus-memory>');
  const text = parts.join('\n');
  const tokens = Math.ceil(text.length / 1.8);
  const budget = Number(budgetTokens) || 1400;
  if (tokens > budget) breakdown.dropped = tokens - budget;
  return { text, tokens, breakdown };
}
