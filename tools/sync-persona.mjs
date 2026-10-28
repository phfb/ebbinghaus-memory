/**
 * 人格同步：永久记忆区 → AGENT.md
 *
 * 用户的原话：「所有人格以永久记忆区为准，你把永久记忆区的人格复制上去」。
 *
 * 所以真相源是 ebbinghaus 库永久区里那 6 条「人格·xxx」，
 * `D:\DSH\dsh-home\AGENT.md` 是它们的一份**可注入副本**（dsh-agent-md 读它）。
 *
 * 这个脚本做两件事：
 *   1. 从库里读出 6 条「人格·」，按原顺序拼成 Markdown，写进 AGENT.md
 *   2. 把这 6 条在主库里的 weight 压到 0.1，让它们**不再占注入名额**
 *      （内容已经在 AGENT.md 里注入了，再注入一遍就是同一段话讲两遍）
 *
 * 以后你改了人格（改 AGENT.md，或者往永久区里加新的人格条目），
 * 跑一次 `node tools/sync-persona.mjs` 就同步回去。
 *
 * 用法：
 *   node tools/sync-persona.mjs              # 演算，只打印不写
 *   node tools/sync-persona.mjs --apply      # 真写 AGENT.md + 降权
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createStore } from '../src/core/store.mjs';

const APPLY = process.argv.includes('--apply');
const DIR = 'D:/DSH/dsh-home/ebbinghaus-memory';
const TARGET = 'D:/DSH/dsh-home/AGENT.md';

/** 永久区里哪些标题算「人格」。顺序就是写进 AGENT.md 的顺序。 */
const PERSONA_TITLES = [
  '人格·我是谁',
  '人格·我的形象',
  '人格·说话方式',
  '人格·主食',
  '人格·我的底线',
  '人格·我承认的缺点',
  '人格·别对我做的事',
  '人格·他怎么叫我',
  '人格·我自己想的',
];

/** 压到多低就不再占注入名额（loadPermanentCount 取 weight 最高的几条）。 */
const DEMOTE_TO = 0.1;

/**
 * 把一条记忆的 detail 还原成 Markdown 正文。
 *
 * 库里存的形状是「句子；句子；句子」—— 迁移时把多行压成了一行，用「；」连接。
 * 这里按「；」切开还原成列表；单句或两段的（我是谁 / 主食）保留成散文。
 *
 * @param {string} title
 * @param {string} detail
 * @returns {string}
 */
function toMarkdown(title, detail) {
  const text = String(detail ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';

  // 「我的形象」是按「｜」分条存的（一条里常常还带「；」，比如「种族…；职业…；组织…」，
  // 按分号切会把一句话砍成三条）。`§xxx` 单独成小标题，其余成列表项。
  if (title === '人格·我的形象') {
    return text
      .split('｜')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => (s.startsWith('§') ? `\n### ${s.slice(1).trim()}\n` : `- ${s}`))
      .join('\n');
  }

  // 「我是谁」原文是两段散文，切开会破坏语气
  if (title === '人格·我是谁') {
    return text
      .replace(/，；/g, '，')
      .split('；')
      .filter((s) => s.trim() !== '')
      .map((s) => s.trim())
      .join('\n\n');
  }

  // 「我的底线」是个例外：它只有 2 条，而**第 2 条内部本身带分号**
  // （「他问，我就这么答；不必绕，不必往回找补…」）。
  // 天真的按「；」全切会把那句拦腰截断，读起来像两句话说不完。
  // 这条只在第一个「；」处切一次，剩下的原样保留。
  if (title === '人格·我的底线') {
    const idx = text.indexOf('；');
    if (idx > 0) {
      const head = text.slice(0, idx).trim();
      const tail = text.slice(idx + 1).trim();
      return `- ${head}\n- ${tail}`;
    }
    return `- ${text}`;
  }

  const parts = text
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  // 只有一两句的（主食），直接成段
  if (parts.length <= 1) return parts[0] ?? text;

  return parts.map((p) => `- ${p}`).join('\n');
}

const store = createStore({ dir: DIR, log: () => {}, warn: (m) => console.log('warn:', m) });
await store.load();

const all = store.all();
const found = [];
const missing = [];
for (const title of PERSONA_TITLES) {
  const e = all.find((x) => x.title === title);
  if (e === undefined) missing.push(title);
  else found.push({ title, entry: e });
}

if (found.length === 0) {
  console.log('永久区里一条「人格·」都没找到，不动 AGENT.md。');
  process.exit(1);
}
if (missing.length > 0) {
  console.log(`⚠ 库里缺这些（会跳过）：${missing.join('、')}`);
}

// ── 拼 Markdown ──────────────────────────────────────────────
//
// 开头这段 HTML 注释是给**人和 AI 读文件时**看的，**不进模型上下文**
// （dsh-agent-md 会把 <!-- --> 剥掉，省 token）。
// 所以这里是这套人格机制唯一的「说明书」：改人格该改哪、真相源在哪、怎么同步。
const HEADER = `<!--
人格文件 · 由 D:\\Ebbinghaus-memory\\tools\\sync-persona.mjs 从永久记忆区生成

【怎么改人格】
1. 最省事：DSH 设置 → 人格 → 全局人格，直接编辑保存，下一回合生效。
2. 或者直接改本文件（Markdown，随便什么编辑器）。
3. 改完想把「永久记忆区」也同步回这个版本 —— 反过来手动改库里那 9 条
   「人格·xxx」，再跑：node tools/sync-persona.mjs --apply

【真相源】D:\\DSH\\dsh-home\\ebbinghaus-memory\\permanent.jsonl 里 9 条「人格·」
          （weight 0.1，只存不注入；内容已在本文件里，注入走本文件）
【注入源】本文件。dsh-agent-md 每回合读它，改完下一回合生效，不用重启。
【别做的事】别在这里写双花括号的模板变量，宿主会当变量解析失败；
            要写示例就放进这段 HTML 注释里，注释不会进上下文。
【坑】这段注释里**不能出现 HTML 注释的起止符号本身** ——
      dsh-agent-md 的剥离是「遇到起始符开始跳过、遇到终止符结束」，
      在注释里再写一遍终止符，会让它提前收尾，后半段漏进上下文（真踩过）。
-->`;

const blocks = [];
for (const { title, entry } of found) {
  const heading = title.replace(/^人格·/, '').trim(); // 「人格·我是谁」→「我是谁」
  const body = toMarkdown(title, entry.detail);
  if (body === '') continue;
  blocks.push(`# ${heading}\n\n${body}`);
}
const markdown = `${HEADER}${blocks.join('\n\n')}\n`;

console.log('=== 将写入 AGENT.md 的内容 ===');
console.log(markdown);
console.log(`字数：${markdown.length}`);

// ── 降权清单 ────────────────────────────────────────────────
const toDemote = found.filter(({ entry }) => (entry.weight ?? 0) > DEMOTE_TO);
console.log(`=== 需要降权：${toDemote.length} 条（weight > ${DEMOTE_TO}）===`);
for (const { title, entry } of toDemote) {
  console.log(`  ${title}  ${entry.weight} → ${DEMOTE_TO}`);
}

if (!APPLY) {
  console.log('');
  console.log('（这是演算。确认要写就加 --apply）');
  process.exit(0);
}

// ── 写 AGENT.md（先比对，内容一样就不动）────────────────────
//
// 幂等：同步是个会反复跑的动作（改一次人格跑一次），
// 内容没变还硬写一遍，只会把 `AGENT.md.bak-*` 堆成一排没用的文件。
const resolved = path.resolve(TARGET);
if (path.basename(resolved) !== 'AGENT.md') {
  console.log(`目标路径不对：${resolved}`);
  process.exit(1);
}

let current = null;
try {
  current = await fsp.readFile(resolved, 'utf8');
} catch {
  current = null;
}

if (current === markdown) {
  console.log('\nAGENT.md 内容已经是最新的，不重写（也不产生新备份）。');
} else {
  if (current !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fsp.writeFile(`${resolved}.bak-${stamp}`, current, 'utf8');
    console.log(`\n旧 AGENT.md 已备份：AGENT.md.bak-${stamp}（${current.length} 字）`);
  } else {
    console.log('\nAGENT.md 原来不存在，直接新建。');
  }
  await fsp.writeFile(resolved, markdown, 'utf8');
  console.log(`已写入：${resolved}（${markdown.length} 字）`);
}

// ── 降权 ───────────────────────────────────────────────────
let changed = 0;
for (const { entry } of toDemote) {
  const live = store.get(entry.id);
  if (live === undefined) continue;
  live.weight = DEMOTE_TO;
  changed += 1;
}
if (changed > 0) {
  await store.save();
  await store.flush();
  console.log(`已降权 ${changed} 条 → ${DEMOTE_TO}（不再占注入名额，但留在库里当源）`);
}

// ── 结果 ───────────────────────────────────────────────────
const perm = [...store.zones.permanent].sort(
  (a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (b.ts ?? 0) - (a.ts ?? 0),
);
console.log('\n永久区前 8 条（重启后 loadPermanentCount=6 会取前 6）：');
perm.slice(0, 8).forEach((e, i) => console.log(`  ${i + 1}. w=${e.weight}  ${String(e.title).slice(0, 40)}`));
console.log(`\n人格真相源：永久区那 ${found.length} 条「人格·」（weight ${DEMOTE_TO}，只存不注入）`);
console.log('人格注入源：D:\\DSH\\dsh-home\\AGENT.md（dsh-agent-md 每回合读它）');
