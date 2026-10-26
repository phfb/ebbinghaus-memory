/**
 * 从冷存档里捞记忆回来。
 *
 * 背景：记忆在两种情况下会从主库消失 —— 压缩（N 条揉成 1 条）和淘汰
 * （到期权重太低）。这两种情况都会先把**原始条目**追加进 `_archive/*.jsonl`，
 * 但那个文件只是躺在那儿，没有任何入口能读回来。
 *
 * 这个脚本就是那个入口。
 *
 * 用法（node 不在 PATH，用全路径）：
 *
 *   # 看有哪些归档、各多少条
 *   & "…\node.exe" tools\restore.mjs --list
 *
 *   # 看看能恢复什么（默认只演不写）
 *   & "…\node.exe" tools\restore.mjs --tag compressed
 *   & "…\node.exe" tools\restore.mjs --since 2026-10-20
 *   & "…\node.exe" tools\restore.mjs --id em-20261022T0448-a1b2
 *   & "…\node.exe" tools\restore.mjs --keyword 桌宠
 *
 *   # 真写回去
 *   & "…\node.exe" tools\restore.mjs --tag dropped --apply
 *
 * 恢复的条目会带着它原来的 `zone`（短期/长期/永久）回到主库，
 * 同时把墓碑撤掉（否则下一次落盘前的合并又会把它过滤掉）。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createStore } from '../src/core/store.mjs';
import { ZONES, ZONE_LABEL, isValidEntry, normalizeEntry } from '../src/core/schema.mjs';
import { relativeStamp, fullStamp } from '../src/core/time.mjs';
import { tokenize } from '../src/core/recall.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const APPLY = Boolean(arg('--apply', false));
const LIST = Boolean(arg('--list', false));
const DSH_HOME_DIR = (process.env.DSH_HOME ?? `).trim();
const dir = String(arg('--dir', DSH_HOME_DIR !== '' ? path.join(DSH_HOME_DIR, 'ebbinghaus-memory') : ''));
if (dir === '') {
  console.error('找不到记忆库目录：请设置 DSH_HOME 环境变量，或者用 --dir 指定');
  process.exit(1);
}
const wantId = typeof arg('--id', undefined) === 'string' ? arg('--id') : '';
const wantTag = typeof arg('--tag', undefined) === 'string' ? arg('--tag') : '';
const wantSince = typeof arg('--since', undefined) === 'string' ? arg('--since') : '';
const wantKeyword = typeof arg('--keyword', undefined) === 'string' ? arg('--keyword') : '';

const archiveDir = path.join(dir, '_archive');

function line(s = '') {
  console.log(s);
}

function pad(s, n) {
  const str = String(s);
  // 中文按两个宽度算，表格才对得齐
  const width = [...str].reduce((w, ch) => w + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

/**
 * 读一个归档文件。坏行跳过（只坏一行，不毁整份）。
 * @param {string} file
 * @returns {Promise<object[]>}
 */
async function readArchiveFile(file) {
  const text = await fsp.readFile(file, 'utf8');
  /** @type {object[]} */
  const out = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (s === '') continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && typeof obj.id === 'string') out.push(obj);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) line(`  ⚠ ${path.basename(file)} 有 ${bad} 行读不出来，已跳过`);
  return out;
}

/** 列出所有归档文件。 */
async function listArchives() {
  let files = [];
  try {
    files = await fsp.readdir(archiveDir);
  } catch {
    line(`没有归档目录：${archiveDir}`);
    line('（还没发生过压缩或淘汰，或者根本不是这个库）');
    return [];
  }
  const targets = files.filter((f) => f.endsWith('.jsonl')).sort();
  if (targets.length === 0) {
    line('归档目录是空的。');
    return [];
  }
  line(`归档目录：${archiveDir}`);
  line('');
  line(`${pad('文件', 24)}${pad('条数', 8)}${pad('最早', 18)}最晚`);
  line('─'.repeat(64));
  const result = [];
  for (const f of targets) {
    const list = await readArchiveFile(path.join(archiveDir, f));
    if (list.length === 0) continue;
    const tsList = list.map((e) => Number(e.ts)).filter(Number.isFinite).sort((a, b) => a - b);
    line(
      `${pad(f, 24)}${pad(list.length, 8)}` +
        `${pad(tsList.length > 0 ? fullStamp(tsList[0]) : '—', 18)}` +
        `${tsList.length > 0 ? fullStamp(tsList[tsList.length - 1]) : '—'}`,
    );
    result.push({ file: f, list });
  }
  line('');
  line('想捞回来：--tag <文件名去掉 .jsonl> [--since 2026-10-20] [--keyword 关键词] [--apply]');
  return result;
}

/* ───────────────────────── 主流程 ───────────────────────── */

if (LIST) {
  await listArchives();
  process.exit(0);
}

const archives = await listArchives();
if (archives.length === 0) process.exit(0);

// 只取指定的 tag
const picked = wantTag === '' ? archives : archives.filter((a) => a.file.replace(/\.jsonl$/, '') === wantTag);
if (picked.length === 0) {
  line(`没有叫「${wantTag}」的归档。看看 --list 里有哪些。`);
  process.exit(1);
}

// 同一个 id 可能被归档过多次（先压缩、后来又淘汰），只留最新那次
/** @type {Map<string, object>} */
const byId = new Map();
for (const { list } of picked) {
  for (const e of list) {
    const prev = byId.get(e.id);
    if (prev === undefined || Number(e.archivedAt ?? 0) >= Number(prev.archivedAt ?? 0)) {
      byId.set(e.id, e);
    }
  }
}

const store = createStore({ dir });
const loaded = await store.load();
if (!loaded.ok) {
  line(`记忆库读不了：${dir}`);
  process.exit(1);
}

const existing = store.ids();
const sinceTs =
  wantSince === ''
    ? 0
    : (() => {
        // 支持 2026-10-20 和 2026-10-20 12:30 两种写法
        const m = wantSince.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
        if (m === null) return Number.NaN;
        return new Date(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4] ?? 0),
          Number(m[5] ?? 0),
          0,
          0,
        ).getTime();
      })();

if (Number.isNaN(sinceTs)) {
  line('--since 的格式看不懂，要 2026-10-20 或 "2026-10-20 12:30"。');
  process.exit(1);
}

const kwTokens = wantKeyword === '' ? [] : tokenize(wantKeyword);

/** @type {object[]} */
const candidates = [];
let skippedExisting = 0;
let skippedTime = 0;
let skippedKeyword = 0;
let skippedId = 0;

for (const e of byId.values()) {
  if (existing.has(e.id)) {
    skippedExisting += 1;
    continue;
  }
  // --id 精确匹配。之前这里漏了：变量定义过、也写进了用法说明，但过滤循环里
  // 从没查它 —— 于是 `--id xxx` 会静默把**全部**候选都恢复出来。
  if (wantId !== '' && e.id !== wantId) {
    skippedId += 1;
    continue;
  }
  const ts = Number(e.ts);
  if (!Number.isFinite(ts) || ts < sinceTs) {
    skippedTime += 1;
    continue;
  }
  if (kwTokens.length > 0) {
    const hay = `${e.title ?? ''} ${e.detail ?? ''} ${(e.keywords ?? []).join(' ')}`.toLowerCase();
    if (!kwTokens.some((t) => hay.includes(t.toLowerCase()))) {
      skippedKeyword += 1;
      continue;
    }
  }
  candidates.push(e);
}

candidates.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

line('');
line(
  `候选 ${candidates.length} 条` +
    (skippedExisting > 0 ? ` · 已在主库跳过 ${skippedExisting}` : '') +
    (skippedId > 0 ? ` · id 不符跳过 ${skippedId}` : '') +
    (skippedTime > 0 ? ` · 时间不符跳过 ${skippedTime}` : '') +
    (skippedKeyword > 0 ? ` · 关键词不符跳过 ${skippedKeyword}` : ''),
);

if (candidates.length === 0) {
  line('没有可恢复的。');
  process.exit(0);
}

line('');
line(`${pad('时间', 20)}${pad('分区', 8)}${pad('权重', 8)}标题`);
line('─'.repeat(76));
for (const e of candidates.slice(0, 40)) {
  const zone = ZONES.includes(e.zone) ? e.zone : 'short';
  line(
    `${pad(relativeStamp(Number(e.ts), Date.now()), 20)}` +
      `${pad(ZONE_LABEL[zone], 8)}` +
      `${pad(Number(e.weight ?? 0).toFixed(2), 8)}` +
      `${String(e.title ?? '').slice(0, 40)}`,
  );
}
if (candidates.length > 40) line(`… 还有 ${candidates.length - 40} 条`);

if (!APPLY) {
  line('');
  line('（这是演算。确认要写回去就加 --apply）');
  process.exit(0);
}

// 真恢复：按原 zone 放回去，store.add 会顺手撤掉墓碑
let restored = 0;
for (const e of candidates) {
  const zone = ZONES.includes(e.zone) ? e.zone : 'short';
  const entry = normalizeEntry(
    { ...e, zone, source: e.source ?? 'merge' },
    { zone, now: Date.now(), source: 'merge', taken: store.ids() },
  );
  if (entry === null) continue;
  store.add(entry);
  restored += 1;
}

await store.save();
await store.flush();

line('');
line(`恢复 ${restored} 条 → 现在 短 ${store.zones.short.length} / 长 ${store.zones.long.length} / 永 ${store.zones.permanent.length}`);
line('（归档文件没动 —— 原文还在，可以重复捞）');
