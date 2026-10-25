/**
 * `src/core/compress.mjs` 的**测试桩**（见 zones.mjs 里的说明）。
 *
 * `compressWithModel` 刻意**永远返回 null** —— 这样 host 层的测试跑的就是
 * 「模型压缩失败 → 本地兜底」那条分支，而兜底是必须永远能出条目的那条路。
 */

import { overflowCount } from './zones.mjs';

export function pickCompressGroup(zone, entries, cfg) {
  const list = Array.isArray(entries) ? [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)) : [];
  const k = Math.min(list.length, overflowCount(zone, list, cfg));
  return list.slice(0, k);
}

export function fallbackMerge(entries, { now }) {
  const list = Array.isArray(entries) ? entries : [];
  const oldest = list[0] ?? {};
  const keywords = [...new Set(list.flatMap((e) => (Array.isArray(e?.keywords) ? e.keywords : [])))].slice(0, 10);
  const detail = list
    .map((e) => String(e?.detail ?? e?.title ?? ''))
    .join('；')
    .slice(0, 200);
  const weight = list.length > 0 ? list.reduce((n, e) => n + (Number(e?.weight) || 0), 0) / list.length : 0.4;
  return {
    id: `stub-merge-${Math.random().toString(16).slice(2, 8)}`,
    ts: Number(oldest.ts) || Date.now(),
    zone: oldest.zone ?? 'short',
    weight: Math.round(weight * 100) / 100,
    title: `${oldest.title ?? '（无题）'}（合并 ${list.length} 条）`,
    detail: detail.length >= 40 ? detail : `${detail}${'…'.repeat(40)}`.slice(0, 40),
    keywords: keywords.length > 0 ? keywords : ['合并'],
    source: 'merge',
    depth: Math.min(9, Math.max(...list.map((e) => (Number(e?.depth) || 0) + 1), 1)),
    mergedFrom: list.map((e) => e?.id).filter((x) => typeof x === 'string'),
    session: oldest.session ?? '',
    touchedAt: Number(now) || Date.now(),
    createdAt: Number(now) || Date.now(),
  };
}

export async function compressWithModel(_entries, _opts) {
  return null;
}
