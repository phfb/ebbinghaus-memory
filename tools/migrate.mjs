#!/usr/bin/env node
/**
 * 旧记忆迁移：把 feiyu-diary / persona / USER-PROFILE 等散落的旧档案搬进 Ebbinghaus 三分区。
 *
 * 为什么要有这个脚本（而不是手动导一次）：
 *
 *  1. 旧档案散在 5 个文件里、三种格式（jsonl / md / json），手工会漏，而且漏了不知道漏了。
 *  2. **时间戳必须是原始记忆自带的 created_at**（用户原话：「时间戳按照原有记忆时间」）。
 *     如果按导入时刻算，所有旧记忆都变成「今天刚发生」，遗忘曲线当场失效 ——
 *     7 天后它们会被判成刚写的短期条目，永远升不了级，旧事永远压在短期区顶格。
 *  3. 必须能反复跑。改完源码想再导一次是常态，不幂等就会一天导出一堆重复。
 *     这里用 sha1(ts + '|' + title) 去重：同一条旧记忆重跑一次哈希不变，直接跳过。
 *  4. 这是唯一会写用户既有记忆的脚本，所以 --apply 之前**先备份**，且默认是 --dry-run。
 *
 * 用法：
 *   node tools/migrate.mjs                       # 默认只演不写，打一张统计表
 *   node tools/migrate.mjs --apply               # 真写（先备份）
 *   node tools/migrate.mjs --apply --dir D:/x/y  # 换目标库
 *   node tools/migrate.mjs --short-days 3 --long-days 10   # 临时改分区阈值再演一遍
 *   node tools/migrate.mjs --verbose             # 逐条打印 title 与去向
 *
 * 依赖：只 import src/core 里已经冻结的实现（schema / store / config / time）。
 * 不自己发明字段名、不自己写 jsonl —— 一旦这里另写一套，面板和注入层就读不出去了。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ZONES,
  ZONE_LABEL,
  normalizeEntry,
  deriveKeywords,
  normalizeKeywords,
} from '../src/core/schema.mjs';
import { createStore } from '../src/core/store.mjs';
import { resolveConfig } from '../src/core/config.mjs';
import { daysBetween, fullStamp, stampFor } from '../src/core/time.mjs';

// ── 源目录 ────────────────────────────────────────────────────────────────
// 默认值就是这台机器的真实位置；允许用环境变量搬走，换电脑时不用改代码。
const DSH_HOME = process.env.DSH_HOME || 'D:/DSH/dsh-home';
const FEIYU_HOME = process.env.FEIYU_HOME || 'D:/DSH/feiyu-diary';
const PROFILE_WS = path.join(
  DSH_HOME,
  'profiles',
  'desktop',
  'plugins',
  'dsh-persona-bootstrap',
  'workspace',
);

/** 迁移进来的记忆一律 source='seed' 或 'note'，跟对话里现固化的 'chat' 区分开。 */

// ── 小工具 ────────────────────────────────────────────────────────────────

function two(n) {
  return String(n).padStart(2, '0');
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function errOut(line = '') {
  process.stderr.write(`${line}\n`);
}

/**
 * Windows 控制台默认是 cp936（GBK），而 Node 往 stdout 写的是 UTF-8 字节，
 * 于是「短期记忆」在 cmd.exe 里会变成一串乱码。改一次代码页最省事。
 * 只在真终端里改：输出被重定向到文件/管道时不需要，也避免干扰父 shell。
 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  if (!process.stdout.isTTY) return;
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 拿不到 chcp 也不影响功能，顶多中文难看
  }
}

/** 全角字符占两格，直接 padEnd 会让表格歪掉。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x200b || c === 0xfeff) continue;
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

function padCell(text, width, align = 'left') {
  const s = String(text ?? '');
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

/**
 * 打一张等宽表。数字列右对齐 —— 条数一眼横扫，不用数位数。
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {'left'|'right'} [alignFor]
 */
function renderTable(headers, rows, rightCols) {
  const right = new Set(rightCols ?? []);
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells) =>
    cells
      .map((c, i) => padCell(c, widths[i], right.has(i) ? 'right' : 'left'))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  const lines = [line(headers), sep, ...rows.map((r) => line(r))];
  return lines.join('\n');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 同年只写 MM-DD，跨年才补年份 —— 表会窄很多，读起来也快。 */
function spanLabel(minTs, maxTs) {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return '—';
  const a = new Date(minTs);
  const b = new Date(maxTs);
  const same = a.getFullYear() === b.getFullYear();
  const left = same ? stampFor(minTs) : fullStamp(minTs);
  const right = same ? stampFor(maxTs) : fullStamp(maxTs);
  return `${left} ~ ${right}`;
}

/**
 * 一句话标题：取首句。
 * 太短的「句子」（<8 字）多半是「注意：」「另外，」这类引导语，整段拿来当标题更贴切。
 */
function titleFromText(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const stop = flat.search(/[。！？!?；;]/);
  let t = stop >= 8 ? flat.slice(0, stop) : flat;
  if (t.length > max) t = t.slice(0, max);
  return t.trim();
}

/**
 * markdown 段落 → 一行 detail。
 * normalizeEntry 会把换行压成空格，但那样列表项会连成「- 甲 - 乙 - 丙」，
 * 读起来像乱码。这里先把项目符号剥掉、用「；」连，语义保住了，还是一行。
 */
function toPlain(bodyLines) {
  const kept = [];
  for (const raw of bodyLines) {
    let line = String(raw ?? '').trim();
    if (line === '') continue;
    if (/^<!--/.test(line)) continue; // 人格锚点注释这类纯机器标记
    if (/^```/.test(line)) continue; // 代码围栏本身没信息
    if (/^[-=*_]{3,}$/.test(line)) continue; // 分隔线
    line = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line !== '') kept.push(line);
  }
  return kept.join('；');
}

/** 剥掉引用块和注释后还剩多少字 —— 用来判断「这段是不是纯说明文字」。 */
function meaningfulLength(bodyLines) {
  let n = 0;
  for (const raw of bodyLines) {
    const line = String(raw ?? '').trim();
    if (line === '') continue;
    if (line.startsWith('>')) continue;
    if (/^<!--/.test(line)) continue;
    n += line.length;
  }
  return n;
}

/**
 * 按标题切段。
 *
 * 为什么要保留「第一个目标标题之前」的那一段：persona.md 的核心人格正文
 * （「我是某某，社区管我叫……性格：……」）就写在 H1 下面、
 * 第一个 H2 之前。只认 H2 会把它整段丢掉 —— 那是整份文件最重要的一段。
 *
 * @param {string} text
 * @param {{level?: number}} [opts]
 * @returns {Array<{title: string, body: string[], upper: string}>}
 */
function splitSections(text, opts) {
  const level = opts?.level ?? 2;
  const lines = String(text ?? '').split(/\r?\n/);
  const reAt = (lv) => new RegExp(`^#{${lv}}[ \\t]+(.+?)[ \\t]*$`);
  const reTarget = reAt(level);
  const reUpper = level > 1 ? reAt(level - 1) : null;

  const out_ = [];
  let upperTitle = '';
  /** @type {{title: string, body: string[], upper: string}|null} */
  let cur = null;

  const flush = () => {
    if (cur === null) return;
    const title = (cur.title || cur.upper || '').trim();
    out_.push({ title, body: cur.body, upper: cur.upper });
    cur = null;
  };
  const ensure = () => {
    if (cur === null) cur = { title: '', body: [], upper: upperTitle };
  };

  for (const line of lines) {
    if (reUpper !== null) {
      const mu = line.match(reUpper);
      if (mu) {
        flush();
        upperTitle = mu[1].trim();
        continue;
      }
    }
    const mt = line.match(reTarget);
    if (mt) {
      flush();
      cur = { title: mt[1].trim(), body: [], upper: upperTitle };
      continue;
    }
    ensure();
    cur.body.push(line);
  }
  flush();
  // 纯注释/纯空白的段（`<!-- feiyu:anchor:begin -->` 这类机器标记）直接丢掉，
  // 别让它混进「空段」计数里去干扰判断
  return out_.filter((s) => {
    if (s.title !== '') return true;
    return s.body.some((l) => {
      const t = l.trim();
      return t !== '' && !/^<!--/.test(t);
    });
  });
}

/** 幂等键：时间戳 + 标题。标题在 normalizeEntry 里已被压平截断，所以重跑稳定。 */
function dedupeKey(ts, title) {
  return crypto.createHash('sha1').update(`${ts}|${title}`, 'utf8').digest('hex');
}

/**
 * 分区：距今 ≤ shortDays → short；≤ longDays → long；更老 → permanent。
 *
 * 用日历天（daysBetween）而不是毫秒差，是为了跟注入里显示的「6 天前」对齐 ——
 * 用户看到「7 天前」却在长期区，会以为坏了。
 */
function zoneForTs(ts, cfg, now) {
  const d = daysBetween(ts, now);
  if (d <= cfg.shortDays) return 'short';
  if (d <= cfg.longDays) return 'long';
  return 'permanent';
}

/** 读出空的报告骨架，各 collect* 往里填。 */
function newReport(label, file) {
  return {
    label,
    file,
    ok: true,
    reason: '',
    rawCount: 0, // 从磁盘读出多少条原始记录
    bad: 0, // 解析失败 / 被 normalizeEntry 退回的
    dup: 0, // 撞幂等键跳过的
    empty: 0, // 空段落跳过（只有标题没有正文）
    meta: 0, // 元信息段跳过（说明文字，不是记忆）
    zones: { short: 0, long: 0, permanent: 0 },
    minTs: Number.POSITIVE_INFINITY,
    maxTs: Number.NEGATIVE_INFINITY,
    items: [],
    notes: [],
  };
}

// ── 源 1：feiyu-diary 的 jsonl 日记 ───────────────────────────────────────

/**
 * 「关于这个人的判断」而不是「发生过的事」。
 *
 * 旧档案给这类日记打了标签：关系 / 人设 / 偏好 / 雷区 / 锚点 / 相处 / 说话方式 /
 * 护着我 / 别自贬 / 认下 / 不争定义 / 舍不得 / 他 / 凌晨 / 用户 / 语气。
 *
 * 为什么它们不能按时间走：这些条目讲的是「他是什么样的人、我该怎么待他」。
 * 如果按 created_at 塞进短期区，7 天后权重不够就被压缩掉 —— 等于把人格忘了，
 * 而这恰恰是最不该忘的东西。所以判定顺序是**先判人格类，再判时间**。
 */
const PERSONA_TAGS = new Set([
  '关系',
  '人设',
  '偏好',
  '雷区',
  '锚点',
  '相处',
  '说话方式',
  '护着我',
  '别自贬',
  '认下',
  '不争定义',
  '舍不得',
  '他',
  '凌晨',
  '用户',
  '语气',
]);

/**
 * feiyu-diary 的 manifest.json 里有「这份档案什么时候建的」。
 * 人格文档自己不带时间戳，拿它比拿文件 mtime 更接近真实 ——
 * mtime 会被每次重写刷成今天，人格就变成了「今天才形成」。
 */
async function readFeiyuManifestTs() {
  const file = path.join(FEIYU_HOME, 'manifest.json');
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    const ts = Number(data?.created_at);
    if (Number.isFinite(ts) && ts > 0) return ts;
  } catch {
    // 读不到就退下面的兜底时间
  }
  return null;
}

async function collectDiary(now) {
  const dir = path.join(FEIYU_HOME, 'diary');
  const rep = newReport('日记', `${dir}${path.sep}*.jsonl`);

  if (!(await exists(dir))) {
    rep.ok = false;
    rep.reason = `目录不存在：${dir}`;
    return rep;
  }

  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.jsonl')).sort();
  } catch (e) {
    rep.ok = false;
    rep.reason = `读不了目录：${e?.message ?? e}`;
    return rep;
  }
  if (names.length === 0) {
    rep.ok = false;
    rep.reason = `目录里没有 .jsonl：${dir}`;
    return rep;
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (e) {
      rep.notes.push(`${name} 读不了（${e?.code ?? e?.message}）`);
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      rep.rawCount += 1;
      /** @type {any} */
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        rep.bad += 1;
        continue;
      }
      if (o === null || typeof o !== 'object') {
        rep.bad += 1;
        continue;
      }

      // 时间：优先 created_at（毫秒）。老档案偶尔只有 date（YYYY-MM-DD），
      // 那就当那天中午写的 —— 取正午是为了不被时区推成前一天。
      let ts = Number(o.created_at);
      if (!Number.isFinite(ts) || ts <= 0) ts = dateFieldToTs(o.date);
      if (!Number.isFinite(ts) || ts <= 0) {
        rep.bad += 1;
        continue;
      }

      const text_ = typeof o.text === 'string' ? o.text : '';
      if (text_.trim() === '') {
        rep.bad += 1;
        continue;
      }

      const salience = Number(o.salience);
      const tags = (Array.isArray(o.tags) ? o.tags : [])
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      const personaTags = tags.filter((t) => PERSONA_TAGS.has(t));
      const isPersona = personaTags.length > 0;
      const title = titleFromText(text_);

      rep.items.push({
        source: 'note',
        // 人格类不看时间，直接锁进永久区；其余交给主循环按 ts 判
        zone: isPersona ? 'permanent' : undefined,
        raw: {
          ts,
          title,
          detail: text_,
          // 旧档案的 keywords 字段基本是空 []，光靠 tags 检索面太窄 ——
          // 补一层 2-gram 兜底，否则「选择性记忆检索」几乎一条都命中不了。
          // tags 放在前面，让 normalizeKeywords 截前 10 个时优先保住精准标签。
          keywords: normalizeKeywords([
            ...(o.keywords ?? []),
            ...tags,
            ...deriveKeywords(`${title} ${text_}`, 8),
          ]),
          // 人格类统一 0.9（不随时间衰减）；其余沿用旧插件当时的 salience，
          // 那是它当时判的重要度，这里不该二次改写。
          weight: isPersona ? 0.9 : Number.isFinite(salience) && salience > 0 ? salience : 0.45,
          session: typeof o.session === 'string' ? o.session : '',
          // 日记是「已经写下来的东西」，不是聊天现场，所以 source=note
        },
      });
      if (isPersona) rep.persona = (rep.persona ?? 0) + 1;
    }
  }

  if (rep.items.length === 0) {
    rep.ok = false;
    rep.reason = '读到 0 条有效日记';
  }
  return rep;
}

/** 'YYYY-MM-DD' → 当天中午的毫秒。 */
function dateFieldToTs(s) {
  if (typeof s !== 'string') return Number.NaN;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m === null) return Number.NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0).getTime();
}

// ── 源 2-4：markdown 人格/档案类文档 ─────────────────────────────────────

/**
 * 剥掉 markdown 开头的 YAML front matter。
 *
 * 不剥会出两个问题，都是实测撞到的：
 *  1. USER-PROFILE.md 的 front matter 是 `schema: 1 / created: … / updated: …`，
 *     它会被当成「第一个 H2 之前的前言段正文」，于是生成一条内容是
 *     「schema: 1；created: 2026-10-18T14:46:25.816Z；…」的垃圾记忆。
 *  2. 反过来，front matter 里的 `created` 恰恰是这份档案**真正的创建时间** ——
 *     比文件 mtime 可信（插件每次重写档案都会把 mtime 刷成今天）。
 *
 * @param {string} text
 * @returns {{meta: Record<string,string>, body: string}}
 */
function splitFrontMatter(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return { meta: {}, body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: src }; // 只有开头那根横线，不是 front matter
  /** @type {Record<string,string>} */
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (m !== null) meta[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

/**
 * @param {object} p
 * @param {string} p.label 表里显示的名字
 * @param {string} p.file 绝对路径
 * @param {number} p.weight 这一整份文档的权重
 * @param {string} p.tag 关键词里带的来源标记（英文，便于英文检索命中）
 * @param {string} p.titlePrefix title 前缀，让「说话方式」这种标题脱离上下文也读得懂
 * @param {number} [p.ts] 显式指定时间戳（人格文档用档案创建时间，不用 mtime）
 * @param {string} [p.tsNote] 时间戳来源说明，会打在明细里
 * @param {Set<string>} [p.skipTitles] 明确要跳过的段标题（元信息）
 */
async function collectMarkdown(p, now) {
  const rep = newReport(p.label, p.file);
  if (!(await exists(p.file))) {
    rep.ok = false;
    rep.reason = `文件不存在：${p.file}`;
    return rep;
  }

  let text = '';
  let mtime = now;
  try {
    text = await fsp.readFile(p.file, 'utf8');
    const st = await fsp.stat(p.file);
    mtime = Math.round(st.mtimeMs);
  } catch (e) {
    rep.ok = false;
    rep.reason = `读不了：${e?.message ?? e}`;
    return rep;
  }
  // 剥 front matter：既防垃圾记忆，又能拿到这份档案真正的创建时间
  const { meta, body } = splitFrontMatter(text);
  const fmCreated = typeof meta.created === 'string' ? Date.parse(meta.created) : Number.NaN;

  // 时间戳优先级：调用方显式给 > front matter 的 created > 文件 mtime。
  // mtime 排最后，因为它会被「档案每次重写」刷成今天。
  let ts = mtime;
  let tsNote = '文件 mtime';
  if (Number.isFinite(fmCreated)) {
    ts = fmCreated;
    tsNote = 'front matter 的 created';
  }
  if (Number.isFinite(p.ts)) {
    ts = /** @type {number} */ (p.ts);
    tsNote = p.tsNote ?? '调用方指定';
  }
  rep.notes.push(`时间戳：${tsNote}（${fullStamp(ts)}）`);

  const sections = splitSections(body, { level: 2 });
  for (const sec of sections) {
    if (sec.title !== '' && p.skipTitles?.has(sec.title)) {
      rep.meta += 1;
      continue;
    }
    // 纯引用块（「> 这份文件是…生成的」）是文件说明，不是记忆内容
    if (meaningfulLength(sec.body) < 20) {
      rep.empty += 1;
      continue;
    }
    const detail = toPlain(sec.body);
    if (detail.length < 20) {
      rep.empty += 1;
      continue;
    }
    rep.rawCount += 1;
    const heading = sec.title !== '' ? sec.title : p.label;
    rep.items.push({
      source: 'seed',
      // 人格/档案是「不随时间忘记」的东西，分区由内容决定，不看时间
      zone: 'permanent',
      raw: {
        // 这些文档没有内建时间戳。ts 只作记录点，分区已经由上面的 zone 固定为 permanent，
        // 所以用「档案创建时间」或「文件 mtime」都不会影响它们会不会被忘掉。
        ts,
        title: `${p.titlePrefix}·${heading}`,
        detail,
        keywords: normalizeKeywords([
          ...deriveKeywords(heading, 4),
          ...deriveKeywords(detail, 8),
          p.tag,
        ]),
        weight: p.weight,
      },
    });
  }

  if (rep.items.length === 0) {
    rep.ok = false;
    rep.reason = '没有可导入的段落（全空 / 全是说明文字）';
  }
  return rep;
}

// ── 源 5：relationship.json（traits / grievances / nickname） ─────────────

async function collectRelationship(p, now) {
  const file = path.join(FEIYU_HOME, 'relationship.json');
  const rep = newReport('关系档案', file);
  if (!(await exists(file))) {
    rep.ok = false;
    rep.reason = `文件不存在：${file}`;
    return rep;
  }

  let data;
  let mtime = now;
  try {
    const text = await fsp.readFile(file, 'utf8');
    data = JSON.parse(text);
    mtime = Math.round((await fsp.stat(file)).mtimeMs);
  } catch (e) {
    rep.ok = false;
    rep.reason = `读不了 / 不是合法 JSON：${e?.message ?? e}`;
    return rep;
  }
  if (data === null || typeof data !== 'object') {
    rep.ok = false;
    rep.reason = '内容不是对象';
    return rep;
  }
  const ts = Number.isFinite(p?.ts) ? p.ts : mtime;

  const push = (text, weight, label) => {
    const t = String(text ?? '').trim();
    if (t === '') return;
    rep.rawCount += 1;
    rep.items.push({
      source: 'seed',
      zone: 'permanent',
      raw: {
        ts,
        title: `${label}·${titleFromText(t, 60)}`,
        detail: t,
        keywords: normalizeKeywords([...deriveKeywords(t, 6), 'relationship', label]),
        weight,
      },
    });
  };

  for (const t of Array.isArray(data.traits) ? data.traits : []) push(t, 0.9, '倾向');
  for (const g of Array.isArray(data.grievances) ? data.grievances : []) push(g, 0.9, '雷区');
  if (typeof data.nickname === 'string' && data.nickname.trim() !== '') {
    push(`他叫我「${data.nickname.trim()}」`, 0.8, '称呼');
  }

  if (rep.items.length === 0) {
    rep.ok = false;
    rep.reason = '文件在，但 traits / grievances / nickname 都是空的';
  }
  return rep;
}

// ── 源 6：手记.md（给「下一棒的我」留话的地方） ───────────────────────────

/**
 * 手记的规则是「一行一条，以短横线开头」，那么导进来就该是一行一条永久记忆。
 * 现在这个文件里只有模板和示例（都在代码围栏里），所以会正确地导 0 条；
 * 以后他真写了，重跑一次 --apply 就自动进来了 —— 这里刻意**不写死**「跳过手记.md」。
 */
async function collectNotebook(now) {
  const file = path.join(FEIYU_HOME, '手记.md');
  const rep = newReport('手记', file);
  if (!(await exists(file))) {
    rep.ok = false;
    rep.reason = `文件不存在：${file}`;
    return rep;
  }

  let text = '';
  let mtime = now;
  try {
    text = await fsp.readFile(file, 'utf8');
    mtime = Math.round((await fsp.stat(file)).mtimeMs);
  } catch (e) {
    rep.ok = false;
    rep.reason = `读不了：${e?.message ?? e}`;
    return rep;
  }

  // 代码围栏里的是示例，不算内容 —— 文件自己第 4 条规则就是这么说的
  /** @type {string[]} */
  const lines = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines.push(line);
  }

  // 「下面从这里开始写你自己的：」之前全是模板说明
  const marker = lines.findIndex((l) => l.includes('开始写你自己的'));
  const body = marker >= 0 ? lines.slice(marker + 1) : lines;

  for (const line of body) {
    if (line === '') continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^<!--/.test(line)) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue;
    const isBullet = /^[-*+]\s+/.test(line);
    // 找不到「开始写你自己」那行时，只认短横线开头（文件自己定的格式），免得把说明当内容
    if (marker < 0 && !isBullet) continue;
    const t = line.replace(/^[-*+]\s+/, '').trim();
    if (t.length < 4) continue;
    rep.rawCount += 1;
    rep.items.push({
      source: 'note',
      zone: 'permanent', // 留话本来就是给以后的自己看的，不该过期
      raw: {
        ts: mtime,
        title: titleFromText(t, 60),
        detail: t,
        keywords: normalizeKeywords([...deriveKeywords(t, 8), '手记']),
        weight: 0.9,
      },
    });
  }

  if (rep.items.length === 0) {
    rep.ok = false;
    rep.reason = '现在只有模板和示例（都在代码围栏里），还没有他自己写的内容';
  }
  return rep;
}

/** 明确不导的源，也要占表格一行 —— 否则看起来像漏了。 */
function skipReport(label, file, reason) {
  const rep = newReport(label, file);
  rep.ok = false;
  rep.reason = reason;
  return rep;
}

// ── 参数与主流程 ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    apply: false,
    dir: null,
    shortDays: undefined,
    longDays: undefined,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') {
      args.apply = true;
    } else if (a === '--dry-run') {
      // 默认就是 dry-run，写出来只是为了让人一眼看明白 + 可以覆盖前面的 --apply
      args.apply = false;
    } else if (a === '--dir') {
      args.dir = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--dir=')) {
      args.dir = a.slice('--dir='.length);
    } else if (a === '--short-days') {
      args.shortDays = Number(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--short-days=')) {
      args.shortDays = Number(a.slice('--short-days='.length));
    } else if (a === '--long-days') {
      args.longDays = Number(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--long-days=')) {
      args.longDays = Number(a.slice('--long-days='.length));
    } else if (a === '--verbose' || a === '-v') {
      args.verbose = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      errOut(`[警告] 不认识的参数，已忽略：${a}`);
    }
  }
  return args;
}

function printHelp() {
  out(`
旧记忆迁移工具（默认只演不写）

  node tools/migrate.mjs [选项]

选项
  --apply                 真的写盘（写前自动备份到 <库目录>/_backup-<YYYYMMDD-HHmmss>/）
  --dir <path>            目标记忆库目录
                          默认 $DSH_HOME/ebbinghaus-memory，再退回 D:/DSH/dsh-home/ebbinghaus-memory
  --short-days <n>        覆盖短期周期（默认读 config 的 7）
  --long-days <n>         覆盖长期周期（默认读 config 的 28）
  --verbose, -v           逐条打印标题与去向
  --help, -h              这张帮助

分区规则（时间戳一律用原始记忆自带的 created_at）
  距今 ≤ shortDays      → 短期
  距今 ≤ longDays       → 长期
  更老 / 人格 / 档案类   → 永久

幂等：按 sha1(ts + '|' + title) 去重，重复跑不会产生重复条目。
`);
}

function resolveDataDir(cliDir) {
  if (typeof cliDir === 'string' && cliDir.trim() !== '') return path.resolve(cliDir.trim());
  const home = (process.env.DSH_HOME ?? '').trim();
  if (home !== '') return path.join(home, 'ebbinghaus-memory');
  return path.join('D:/DSH/dsh-home', 'ebbinghaus-memory');
}

/**
 * 备份。只备 store 真正管的四个文件，_backup-* 目录本身不备份（否则越备越大）。
 * 空库时不留空目录 —— 免得几个月后看到一堆空的 _backup。
 * @returns {Promise<{dest: string, copied: string[]}|null>}
 */
async function backupStore(dir) {
  const d = new Date();
  const name =
    `_backup-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const dest = path.join(dir, name);
  const files = ['meta.json', 'short.jsonl', 'long.jsonl', 'permanent.jsonl'];
  const copied = [];
  let created = false;
  for (const f of files) {
    const src = path.join(dir, f);
    try {
      if (!created) {
        await fsp.mkdir(dest, { recursive: true });
        created = true;
      }
      await fsp.copyFile(src, path.join(dest, f));
      copied.push(f);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  if (copied.length === 0) {
    if (created) await fsp.rm(dest, { recursive: true, force: true });
    return null;
  }
  return { dest, copied };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  ensureUtf8Console();

  const now = Date.now();
  // 用核心层的 resolveConfig 兜底：会把不合法值夹回范围，并校正 longDays > shortDays
  const cfg = resolveConfig({ shortDays: args.shortDays, longDays: args.longDays });
  const dataDir = resolveDataDir(args.dir);

  // 人格文档自己不带时间戳：用 feiyu 档案的创建时间，读不到就退 2026-10-18 00:00
  const manifestTs = await readFeiyuManifestTs();
  const personaTs = manifestTs ?? new Date(2026, 9, 18, 0, 0, 0, 0).getTime();
  const personaTsNote =
    manifestTs !== null ? 'manifest.json 的 created_at' : '兜底 2026-10-18 00:00';

  // 先把源全读进来（纯读，不碰目标库）
  const reports = [
    await collectDiary(now),
    // 日记.md 是 diary/*.jsonl 自动生成的人类可读窗口（文件头自己写着「改它没用」）。
    // 导它 = 29 条日记各存两份，纯重复。
    skipReport(
      '日记.md',
      path.join(FEIYU_HOME, '日记.md'),
      '是 diary/*.jsonl 自动生成的渲染版，内容与 jsonl 完全重复，导入会产生双份记忆',
    ),
    await collectNotebook(now),
    await collectMarkdown(
      {
        label: '人格正文',
        file: path.join(FEIYU_HOME, 'persona.md'),
        weight: 0.9,
        tag: 'persona',
        titlePrefix: '人格',
        ts: personaTs,
        tsNote: personaTsNote,
      },
      now,
    ),
    await collectRelationship({ ts: personaTs }, now),
    await collectMarkdown(
      {
        label: '用户画像',
        file: path.join(PROFILE_WS, 'USER-PROFILE.md'),
        weight: 0.9,
        tag: 'profile',
        titlePrefix: '档案',
      },
      now,
    ),
    await collectMarkdown(
      {
        label: '机器证据',
        file: path.join(PROFILE_WS, 'evidence.md'),
        weight: 0.6,
        tag: 'evidence',
        titlePrefix: '环境',
        // 「采集说明」讲的是扫描脚本怎么跑，不是关于他的事实
        skipTitles: new Set(['采集说明']),
      },
      now,
    ),
    await collectMarkdown(
      {
        label: '用户指令',
        file: path.join(DSH_HOME, 'prompt-inject.md'),
        weight: 0.9,
        tag: 'directive',
        titlePrefix: '指令',
      },
      now,
    ),
  ];

  // ── 载入现有库（只为去重，不写） ──────────────────────────────────────
  // 目录不存在时**不** load：createStore 的 load 会 mkdir，dry-run 不该建目录。
  const dataExists = await exists(dataDir);
  const store = createStore({
    dir: dataDir,
    log: args.verbose ? (m) => out(`[库] ${m}`) : () => {},
    warn: (m) => errOut(`[库] ${m}`),
  });
  if (dataExists || args.apply) await store.load();
  const existingAll = store.all();

  const seen = new Set(existingAll.map((e) => dedupeKey(e.ts, e.title)));
  const taken = new Set(existingAll.map((e) => e.id));

  /** @type {object[]} */
  const incoming = [];
  let dupTotal = 0;
  let dropTotal = 0;
  // 本次导入里「时间上已经出了短期窗口」的条数。用来把下面的提示说准 ——
  // 它们可能全被「人格类锁永久」接走了，这时长期区是 0 但不代表没有旧记忆。
  let overShortTotal = 0;

  for (const rep of reports) {
    if (!rep.ok) continue;
    for (const item of rep.items) {
      // 先 probe 一次拿到 ts（normalizeEntry 负责把 ts / created_at / 未来时间都理顺），
      // 再按 ts 判分区 —— 这样就不用在这边重写一遍时间规则。
      const probe = normalizeEntry(item.raw, { zone: 'short', now, source: item.source, taken });
      if (probe === null) {
        rep.bad += 1;
        dropTotal += 1;
        continue;
      }
      taken.add(probe.id);

      const zone = item.zone ?? zoneForTs(probe.ts, cfg, now);
      const entry =
        probe.zone === zone
          ? probe
          : normalizeEntry({ ...probe, zone }, { zone, now, source: item.source, taken });

      const key = dedupeKey(entry.ts, entry.title);
      if (seen.has(key)) {
        rep.dup += 1;
        dupTotal += 1;
        if (args.verbose) out(`  [重复] ${entry.title}`);
        continue;
      }
      seen.add(key);
      rep.zones[zone] += 1;
      rep.minTs = Math.min(rep.minTs, entry.ts);
      rep.maxTs = Math.max(rep.maxTs, entry.ts);
      if (daysBetween(entry.ts, now) > cfg.shortDays) overShortTotal += 1;
      incoming.push(entry);
      if (args.verbose) {
        out(`  [${ZONE_LABEL[zone]}] ${fullStamp(entry.ts)}  ${entry.title}`);
      }
    }
  }

  // ── 统计表 ────────────────────────────────────────────────────────────
  out('');
  out('Ebbinghaus-memory · 旧记忆迁移');
  out(`  模式    ${args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（只演不写）'}`);
  out(`  目标库  ${dataDir}${dataExists ? '' : '   （还不存在，--apply 时创建）'}`);
  out(`  现有库  短 ${store.zones.short.length} / 长 ${store.zones.long.length} / 永久 ${store.zones.permanent.length}`);
  out(`  分区    ≤ ${cfg.shortDays} 天 → 短期   ≤ ${cfg.longDays} 天 → 长期   更老 → 永久`);
  out('');

  const rows = [];
  for (const rep of reports) {
    if (!rep.ok) {
      // 跳过行的原因放到下面「明细」里 —— 塞进表格会把列宽撑爆
      rows.push([rep.label, '跳过', '—', '—', '—', '—', '—', '—', '—']);
      continue;
    }
    rows.push([
      rep.label,
      String(rep.rawCount),
      String(rep.zones.short + rep.zones.long + rep.zones.permanent),
      String(rep.zones.short),
      String(rep.zones.long),
      String(rep.zones.permanent),
      rep.persona > 0 ? String(rep.persona) : '·',
      String(rep.dup),
      spanLabel(rep.minTs, rep.maxTs),
    ]);
  }

  const totalRaw = reports.filter((r) => r.ok).reduce((n, r) => n + r.rawCount, 0);
  const totalIn = incoming.length;
  const sum = (k) => reports.reduce((n, r) => n + (r.ok ? r.zones[k] : 0), 0);
  const sumPersona = reports.reduce((n, r) => n + (r.ok ? (r.persona ?? 0) : 0), 0);
  rows.push([
    '合计',
    String(totalRaw),
    String(totalIn),
    String(sum('short')),
    String(sum('long')),
    String(sum('permanent')),
    String(sumPersona),
    String(dupTotal),
    '',
  ]);

  out(
    renderTable(
      ['源', '读', '入', '短', '长', '永', '人格', '去重', '时间跨度'],
      rows,
      [1, 2, 3, 4, 5, 6, 7],
    ),
  );
  out('');
  out('  读 = 从磁盘读出多少条原始记录；入 = 去重后真正要写的条数');
  out('  人格 = 按标签锁进永久区的条数（已包含在「永」里，不是额外的）');

  // 每源的细节说明（坏行、空段、跳过原因）——表里放不下，又不想藏起来
  const details = [];
  for (const rep of reports) {
    if (!rep.ok) {
      details.push(`  · ${rep.label}：跳过 —— ${rep.reason}`);
      continue;
    }
    const bits = [`${rep.file}`];
    if (rep.persona > 0) bits.push(`其中人格类 ${rep.persona} 条（按标签锁永久）`);
    if (rep.bad > 0) bits.push(`坏数据 ${rep.bad} 条`);
    if (rep.empty > 0) bits.push(`空段 ${rep.empty} 个`);
    if (rep.meta > 0) bits.push(`元信息段跳过 ${rep.meta} 个`);
    if (rep.dup > 0) bits.push(`去重 ${rep.dup} 条`);
    for (const n of rep.notes) bits.push(n);
    details.push(`  · ${rep.label}：${bits.join('，')}`);
  }
  out('');
  out('明细');
  for (const line of details) out(line);

  out('');
  out(
    `时间跨度（全部）：${spanLabel(
      Math.min(...reports.filter((r) => r.ok).map((r) => r.minTs)),
      Math.max(...reports.filter((r) => r.ok).map((r) => r.maxTs)),
    )}`,
  );
  if (dupTotal > 0) out(`去重跳过：${dupTotal} 条（库里已经有同 ts + 同标题的条目）`);
  if (dropTotal > 0) out(`丢弃：${dropTotal} 条（normalizeEntry 判定不合格）`);

  if (sum('long') === 0 && totalIn > 0) {
    out('');
    if (overShortTotal === 0) {
      out(
        `提示：长期区 0 条 —— 这批旧记忆里最老的一条距离今天也没超过 ${cfg.shortDays} 天，` +
          '全都还在短期窗口内，这是如实的结果。想看点分层效果可以跑 --short-days 3 再演一次。',
      );
    } else {
      out(
        `提示：长期区 0 条 —— 有 ${overShortTotal} 条时间上已经出了 ${cfg.shortDays} 天窗口，` +
          '但它们都命中人格类标签，被直接锁进永久区了（先判人格、再判时间）。这是设计，不是 bug。',
      );
    }
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────
  out('');
  if (!args.apply) {
    out('DRY-RUN 结束，没有写任何文件。确认无误后加 --apply 真写。');
    return 0;
  }

  if (incoming.length === 0) {
    out('没有新条目，库保持原样（幂等：重复导入不会产生重复记忆）。');
    return 0;
  }

  const backup = await backupStore(dataDir);
  if (backup === null) {
    out('备份：目标库还是空的，没有可备份的文件。');
  } else {
    out(`备份：${backup.dest}`);
    out(`      ${backup.copied.join(' / ')}`);
  }

  const before = {
    short: store.zones.short.length,
    long: store.zones.long.length,
    permanent: store.zones.permanent.length,
  };
  for (const e of incoming) store.add(e);
  await store.save();
  await store.flush();

  // 后验：另开一个 store 把文件读回来。save 内部吞异常，只看返回值会误报成功。
  const verify = createStore({ dir: dataDir, warn: (m) => errOut(`[校验] ${m}`) });
  await verify.load();
  const after = {
    short: verify.zones.short.length,
    long: verify.zones.long.length,
    permanent: verify.zones.permanent.length,
  };
  const expected = {
    short: before.short + sum('short'),
    long: before.long + sum('long'),
    permanent: before.permanent + sum('permanent'),
  };
  const okAll =
    after.short === expected.short &&
    after.long === expected.long &&
    after.permanent === expected.permanent;

  out('');
  out('写入结果');
  for (const z of ZONES) {
    out(
      `  ${ZONE_LABEL[z]}  ${before[z]} + ${expected[z] - before[z]} → ${after[z]}` +
        (after[z] === expected[z] ? '' : `（期望 ${expected[z]}，对不上！）`),
    );
  }
  out(okAll ? '  校验：读回文件条数与预期一致。' : '  校验：条数对不上，请检查上面的 warn。');

  const cap = verify.capacity(cfg);
  out('');
  out('容量占用');
  for (const z of ZONES) {
    const c = cap[z];
    out(
      `  ${ZONE_LABEL[z]}  ${String(c.count).padStart(3)} / ${String(c.max).padEnd(3)}` +
        `  ${(c.ratio * 100).toFixed(1)}%${c.ratio > 0.8 ? '  ← 超 80%，下次收割会压缩' : ''}`,
    );
  }

  return okAll ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errOut(`[错误] 迁移中断：${e?.stack ?? e}`);
    process.exit(1);
  });
