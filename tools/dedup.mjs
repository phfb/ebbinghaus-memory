#!/usr/bin/env node
/**
 * 记忆库自检（去重）的命令行版 —— 看 / 做。
 *
 * 默认**只演不写**：列出会合成哪几组、省多少 token，你点头了再加 `--apply`。
 * 真正落盘前会把被合并的原文写进 `_archive/dedup.jsonl`（和压缩同一套冷存档）。
 *
 * 用法：
 *   node tools/dedup.mjs                          # 只看（默认阈值）
 *   node tools/dedup.mjs --threshold 0.55         # 换个阈值看
 *   node tools/dedup.mjs --apply                  # 真合并
 *   node tools/dedup.mjs --dir D:\some\dir        # 指定记忆库（默认走 $DSH_HOME）
 */

import path from 'node:path';

import { createStore } from '../src/core/store.mjs';
import { findDuplicateGroups, mergeDuplicateGroup, dedupThresholdOf } from '../src/core/dedup.mjs';
import { resolveConfig } from '../src/core/config.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

/** 记忆库目录：--dir 优先，其次 $DSH_HOME，最后退回本机默认。 */
function resolveDataDir(cliDir) {
  if (typeof cliDir === 'string' && cliDir.trim() !== '') return path.resolve(cliDir.trim());
  const home = (process.env.DSH_HOME ?? '').trim();
  if (home !== '') return path.join(home, 'ebbinghaus-memory');
  return path.join('D:/DSH/dsh-home', 'ebbinghaus-memory');
}

const APPLY = has('--apply');
const dir = resolveDataDir(valueOf('--dir', ''));
const thresholdArg = valueOf('--threshold', '');
const cfg = resolveConfig({
  dataDir: dir,
  ...(thresholdArg !== '' ? { dedupThreshold: Number(thresholdArg) } : {}),
});
const threshold = dedupThresholdOf(cfg);

const store = createStore({ dir, log: () => {}, warn: (m) => console.warn(`! ${m}`) });
const loaded = await store.load();
if (loaded?.ok === false) {
  console.error(`记忆库读不出来：${dir}`);
  process.exit(1);
}

const all = store.all();
console.log(`记忆库  ${dir}`);
console.log(`条数    ${all.length}`);
console.log(`阈值    ${threshold}${thresholdArg !== '' ? '（命令行指定）' : '（默认）'}`);
console.log('');

const { groups, checked, compared } = findDuplicateGroups(store.zones, cfg, { threshold });
console.log(`参与自检 ${checked} 条，达标边 ${compared} 条，找到 ${groups.length} 组重复\n`);

if (groups.length === 0) {
  console.log('没有需要合并的。');
  process.exit(0);
}

let mergedCount = 0;
for (const [i, g] of groups.entries()) {
  console.log(`── 第 ${i + 1} 组 · 相似度 ${g.similarity} · 合并后进「${g.zone}」──`);
  for (const e of g.entries) {
    const detail = String(e.detail ?? '').replace(/\s+/g, ' ');
    console.log(`   [${e.zone}] 权重 ${e.weight} · ${e.title}`);
    if (detail !== '') console.log(`        ${detail.slice(0, 80)}${detail.length > 80 ? '…' : ''}`);
  }
  mergedCount += g.entries.length - 1;
  console.log('');
}

console.log(`合计：${groups.length} 组，能少 ${mergedCount} 条（${all.length} → ${all.length - mergedCount}）`);

if (!APPLY) {
  console.log('\n这是只演不写。确认没问题加 --apply 真合并。');
  process.exit(0);
}

// ── 真合并 ──
let done = 0;
for (const g of groups) {
  const merged = mergeDuplicateGroup(g.entries, { now: Date.now(), zone: g.zone, taken: store.ids() });
  if (merged === null) continue;
  await store.archive(g.entries, 'dedup');
  for (const e of g.entries) store.remove(e.id);
  store.add(merged);
  done += 1;
}
await store.save();
console.log(`\n已合并 ${done} 组，现在 ${store.all().length} 条。原文在 ${path.join(dir, '_archive', 'dedup.jsonl')}`);
