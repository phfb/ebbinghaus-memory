#!/usr/bin/env node
/**
 * cordis.patch.yml 校验器。
 *
 * 为什么需要这么个东西：旧版插件踩过 —— cordis.patch.yml **必须是顶层 YAML 数组**。
 * 少写两根横线（写成顶层映射）时，DSH 的 loader 不会说「格式不对」，
 * 而是抛一个完全对不上号的错，人要翻半天才找到这里。
 *
 * 三条检查：
 *   1. 顶层是数组。
 *   2. 每个插件条目的 name 必须等于 package.json 的 name，id 必须非空。
 *   3. config 里的每个键都得在 src/core/config.mjs 的 CONFIG_SPEC 里。
 *      多出来的键在 resolveConfig 里会被**静默丢掉** —— 表现是「设置页里改了没反应」，
 *      比直接报错难查得多，所以这里必须抓住。
 *
 * 零依赖：不装 js-yaml（装了就多一个要维护的运行时依赖，而这文件只用得到
 * 「缩进映射 + 缩进数组 + 标量」这一小撮语法）。遇到用不上的语法
 * （块标量 | >、流式 {...} / [...]）会明确报错，绝不半懂半不懂地解析。
 *
 * 退出码：0 = 全绿（警告不算失败），1 = 有错误。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CONFIG_SPEC } from '../src/core/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_PATCH_FILE = path.join(ROOT, 'cordis.patch.yml');
const PKG_FILE = path.join(ROOT, 'package.json');

/**
 * 允许用 --file 指向别的补丁文件（profile 里的覆写版也要能校验）。
 * 关键：坏样本只能这么测 —— 不然为了验证「会不会报错」就得去改真文件。
 */
function parseArgs(argv) {
  /** @type {{file: string|null}} */
  const args = { file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') {
      args.file = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--file=')) {
      args.file = a.slice('--file='.length);
    }
  }
  return args;
}

// ── 输出 ──────────────────────────────────────────────────────────────────

/**
 * Windows 控制台默认 cp936，Node 写的是 UTF-8 字节 → 中文全成乱码。
 * 只在真终端里改代码页，输出重定向到文件时不动（文件本来就该是 UTF-8）。
 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  if (!process.stdout.isTTY) return;
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 拿不到 chcp 也不影响校验结果
  }
}

const out = (s = '') => process.stdout.write(`${s}\n`);

// ── YAML 子集解析 ─────────────────────────────────────────────────────────

class YamlError extends Error {
  constructor(lineNo, message) {
    super(`第 ${lineNo} 行：${message}`);
    this.name = 'YamlError';
    this.lineNo = lineNo;
  }
}

/**
 * 去掉行尾注释。引号里的 `#` 不算注释 —— `dataDir: 'D:/a#b'` 这种写法要能过。
 * YAML 规定 `#` 只有在行首或前面是空白时才是注释起点。
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 行 → {缩进, 内容, 行号}。空行和纯注释行直接丢。
 */
function tokenize(src) {
  const text = String(src ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const content = stripComment(raw).replace(/[ \t]+$/, '');
    if (content.trim() === '') continue;
    const lead = content.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) {
      throw new YamlError(i + 1, '缩进里混了 Tab，YAML 不允许（一律用空格）');
    }
    rows.push({ indent: lead.length, text: content.slice(lead.length), lineNo: i + 1 });
  }
  return rows;
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

/** 这行是不是 `键: 值`？是就返回冒号位置，不是返回 -1。 */
function keyColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') return -1; // 流式写法，交给上层报错
    if (ch === ':') {
      const next = text[i + 1];
      // `a:b` 不是键值对（键后面必须跟空白或行尾）；`D:\path` 里的冒号同理被挡掉
      return next === undefined || next === ' ' || next === '\t' ? i : -1;
    }
  }
  return -1;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * 标量。只认这个文件里会出现的几类：引号串、布尔、数字、null、裸串。
 *
 * `on/off/yes/no` 故意**不**当布尔 —— 跟 js-yaml v4 的 core schema 保持一致。
 * （就算某个 loader 按 YAML 1.1 把它们当布尔，config.mjs 的 coerce 也会退回默认值，
 *   结果一样，所以不值得为它报错。）
 */
function parseScalar(text, lineNo) {
  const t = text.trim();
  if (t === '') return '';
  if (/^[|>]/.test(t)) {
    throw new YamlError(lineNo, '不支持块标量（| / >），请写成单行字符串');
  }
  if (/^[{[]/.test(t)) {
    throw new YamlError(lineNo, '不支持流式写法（{...} / [...]），请改成缩进块写法');
  }
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"')) return unquote(t);
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * 缩进映射。遇到缩进变浅或序列项就交还给上层。
 * @returns {[Record<string, any>, number]}
 */
function parseMap(rows, i, indent) {
  /** @type {Record<string, any>} */
  const obj = {};
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (row.indent > indent) {
      throw new YamlError(row.lineNo, `缩进对不上：这一行比上一行多了 ${row.indent - indent} 个空格`);
    }
    if (isSeqItem(row.text)) break;
    const colon = keyColon(row.text);
    if (colon < 0) {
      throw new YamlError(row.lineNo, `这行不是「键: 值」的形式：${row.text}`);
    }
    const key = unquote(row.text.slice(0, colon));
    const rest = row.text.slice(colon + 1).trim();
    if (rest === '') {
      // 值在下一行、缩进更深的地方
      const next = rows[i + 1];
      if (next !== undefined && next.indent > indent) {
        const [value, ni] = parseNode(rows, i + 1, next.indent);
        obj[key] = value;
        i = ni;
      } else {
        obj[key] = null;
        i += 1;
      }
    } else {
      obj[key] = parseScalar(rest, row.lineNo);
      i += 1;
    }
  }
  return [obj, i];
}

/**
 * 缩进数组。
 * `- 键: 值` 这种「序列项本身是映射」的写法是 patch 文件的主力形态，必须支持：
 * 做法是把首行原地改写成等价的映射行（缩进 = 内容起始列），再交给 parseMap。
 */
function parseSeq(rows, i, indent) {
  /** @type {any[]} */
  const arr = [];
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent !== indent || !isSeqItem(row.text)) break;
    const content = row.text === '-' ? '' : row.text.slice(2);
    if (content.trim() === '') {
      const next = rows[i + 1];
      if (next !== undefined && next.indent > indent) {
        const [value, ni] = parseNode(rows, i + 1, next.indent);
        arr.push(value);
        i = ni;
      } else {
        arr.push(null);
        i += 1;
      }
      continue;
    }
    const pad = row.text.length - content.length; // 「-」后面有几个空格
    if (keyColon(content) >= 0) {
      rows[i] = { indent: indent + pad, text: content, lineNo: row.lineNo };
      const [value, ni] = parseMap(rows, i, indent + pad);
      arr.push(value);
      i = ni;
    } else {
      arr.push(parseScalar(content, row.lineNo));
      i += 1;
    }
  }
  return [arr, i];
}

function parseNode(rows, i, indent) {
  const row = rows[i];
  if (row.indent !== indent) {
    throw new YamlError(row.lineNo, `缩进对不上：期望 ${indent} 个空格，实际 ${row.indent} 个`);
  }
  if (isSeqItem(row.text)) return parseSeq(rows, i, indent);
  return parseMap(rows, i, indent);
}

/**
 * 整份文档。
 * 顶层不是数组时给一条**能直接改**的错误，而不是等 loader 抛天书。
 */
function parseDocument(src) {
  const rows = tokenize(src);
  if (rows.length === 0) throw new YamlError(1, '文件是空的（或整份都是注释）');
  if (rows[0].indent !== 0) {
    throw new YamlError(rows[0].lineNo, '第一个有效行不应该有缩进');
  }
  if (!isSeqItem(rows[0].text)) {
    throw new YamlError(
      rows[0].lineNo,
      '顶层不是 YAML 数组 —— 第一个有效行必须以「- 」开头（一个横线加一个空格）。' +
        '写成顶层映射的话，DSH 的 loader 会直接抛错。',
    );
  }
  const [value, next] = parseNode(rows, 0, 0);
  if (next < rows.length) {
    throw new YamlError(
      rows[next].lineNo,
      `这里还有内容没解析到，多半是缩进错位：${rows[next].text}`,
    );
  }
  return value;
}

// ── 校验 ──────────────────────────────────────────────────────────────────

/** patch 的动作键。带这些键的对象要继续往下钻，它本身不是插件条目。 */
const ACTION_KEYS = new Set(['insert', 'update', 'remove', 'patch', 'before', 'after']);
/** 插件条目上允许出现的键。 */
const ENTRY_KEYS = new Set(['id', 'name', 'config', 'disabled', 'optional', 'inject']);

/**
 * 从 patch 结构里把所有插件条目揪出来。
 * 形状是 `[{ insert: [ {...}, ... ] }]`，但也兼容直接写成 `[{ id, name, config }]`。
 * @returns {Array<{node: Record<string, any>, where: string}>}
 */
function collectEntries(doc) {
  /** @type {Array<{node: Record<string, any>, where: string}>} */
  const found = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((n, j) => walk(n, `${where}[${j}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const keys = Object.keys(node);
    const hasAction = keys.some((k) => ACTION_KEYS.has(k));
    if (!hasAction && (keys.includes('name') || keys.includes('config') || keys.includes('id'))) {
      found.push({ node, where });
      return;
    }
    for (const k of keys) walk(node[k], `${where}.${k}`);
  };
  walk(doc, '$');
  return found;
}

async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function main() {
  ensureUtf8Console();
  const args = parseArgs(process.argv.slice(2));
  const PATCH_FILE =
    typeof args.file === 'string' && args.file.trim() !== ''
      ? path.resolve(args.file.trim())
      : DEFAULT_PATCH_FILE;

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const passes = [];

  out('');
  out('cordis.patch.yml 校验');
  out('');

  // package.json 是 name 的基准，读不到就没法比
  /** @type {any} */
  let pkg;
  try {
    pkg = await readJson(PKG_FILE);
  } catch (e) {
    out(`[错误] 读不了 package.json：${e?.message ?? e}`);
    return 1;
  }
  out(`  补丁文件  ${PATCH_FILE}`);
  out(`  包名      ${pkg.name}`);
  out('');

  // 1) 解析
  let src = '';
  try {
    src = await fsp.readFile(PATCH_FILE, 'utf8');
  } catch (e) {
    out(`[错误] 读不了 cordis.patch.yml：${e?.message ?? e}`);
    return 1;
  }

  /** @type {any[]} */
  let doc;
  try {
    doc = parseDocument(src);
  } catch (e) {
    out(`[错误] YAML 解析失败 —— ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // 2) 顶层必须是数组
  if (!Array.isArray(doc)) {
    errors.push(`顶层不是数组（解析成了 ${doc === null ? 'null' : typeof doc}）`);
  } else {
    passes.push(`顶层是 YAML 数组（${doc.length} 个元素）`);
  }

  // 3) 找出插件条目
  const entries = collectEntries(doc);
  if (entries.length === 0) {
    errors.push('没找到任何插件条目 —— 期望形如 [{ insert: [{ id, name, config }] }]');
  } else {
    passes.push(`找到 ${entries.length} 个插件条目：${entries.map((e) => e.where).join('、')}`);
  }

  // 4) 逐个条目校验
  const known = new Set(CONFIG_SPEC.map((f) => f.key));
  const specByKey = new Map(CONFIG_SPEC.map((f) => [f.key, f]));

  for (const { node, where } of entries) {
    const tag = where;

    // id
    if (typeof node.id !== 'string' || node.id.trim() === '') {
      errors.push(`${tag}：缺 id（设置项的命名空间靠它）`);
    } else {
      passes.push(`${tag}：id = ${node.id}`);
    }

    // name
    if (typeof node.name !== 'string' || node.name.trim() === '') {
      errors.push(`${tag}：缺 name`);
    } else if (node.name !== pkg.name) {
      errors.push(
        `${tag}：name 是「${node.name}」，但 package.json 的 name 是「${pkg.name}」—— ` +
          '两者不一致时插件加载会找不到自己',
      );
    } else {
      passes.push(`${tag}：name = ${node.name}（与 package.json 一致）`);
    }

    // 条目上的可疑键（拼错 confg / nmae 这类）
    for (const k of Object.keys(node)) {
      if (!ENTRY_KEYS.has(k) && !ACTION_KEYS.has(k)) {
        warnings.push(`${tag}：不认识的键「${k}」（是不是拼错了？）`);
      }
    }

    // config
    const cfg = node.config;
    if (cfg === undefined || cfg === null) {
      warnings.push(`${tag}：没有 config，全部走代码默认值`);
      continue;
    }
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
      errors.push(`${tag}：config 必须是「键: 值」映射，实际是 ${Array.isArray(cfg) ? '数组' : typeof cfg}`);
      continue;
    }

    const keys = Object.keys(cfg);
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) {
      const scored = unknown
        .map((k) => {
          const near = [...known].filter(
            (c) => c.toLowerCase() === k.toLowerCase() || c.includes(k) || k.includes(c),
          );
          return near.length > 0 ? `${k}（是不是想写 ${near.slice(0, 3).join(' / ')}？）` : k;
        })
        .join('\n      ');
      errors.push(
        `${tag}：config 里有 ${unknown.length} 个键不在 CONFIG_SPEC 里 —— ` +
          `resolveConfig 会静默丢掉它们，表现是「设置页改了没反应」：\n      ${scored}`,
      );
    } else {
      passes.push(
        `${tag}：config ${keys.length} 个键全部在 CONFIG_SPEC 内（CONFIG_SPEC 共 ${known.size} 个）`,
      );
    }

    // 值的形状：对象/数组是那个出了名难查的坑
    for (const k of keys) {
      const v = cfg[k];
      const spec = specByKey.get(k);
      if (v !== null && typeof v === 'object') {
        errors.push(
          `${tag}：${k} 的值是${Array.isArray(v) ? '数组' : '对象'}。配置值是标量，` +
            '写成对象十有八九是 schemastery 的 .volatile() 把空字符串包成了 {} —— ' +
            '进到插件里会变成字符串 "[object Object]"，记忆库会被写进 [object Object] 目录',
        );
        continue;
      }
      if (spec === undefined) continue;

      if (spec.type === 'number') {
        if (typeof v !== 'number') {
          warnings.push(`${tag}：${k} 期望数字，写的是 ${JSON.stringify(v)}（会被 Number() 转，能跑但建议写对）`);
        } else {
          if (Number.isFinite(spec.min) && v < spec.min) {
            warnings.push(`${tag}：${k} = ${v} 小于下限 ${spec.min}（会被夹到 ${spec.min}）`);
          }
          if (Number.isFinite(spec.max) && v > spec.max) {
            warnings.push(`${tag}：${k} = ${v} 大于上限 ${spec.max}（会被夹到 ${spec.max}）`);
          }
        }
      } else if (spec.type === 'boolean') {
        if (typeof v !== 'boolean') {
          warnings.push(`${tag}：${k} 期望 true/false，写的是 ${JSON.stringify(v)}`);
        }
      } else if (spec.type === 'string') {
        if (typeof v !== 'string') {
          warnings.push(`${tag}：${k} 期望字符串，写的是 ${JSON.stringify(v)}（会退回默认值）`);
        }
      }
    }
  }

  // ── 报告 ────────────────────────────────────────────────────────────────
  if (passes.length > 0) {
    for (const p of passes) out(`[通过] ${p}`);
    out('');
  }
  if (warnings.length > 0) {
    for (const w of warnings) out(`[提醒] ${w}`);
    out('');
  }
  if (errors.length > 0) {
    for (const e of errors) out(`[错误] ${e}`);
    out('');
    out(`结果：${errors.length} 个错误，${warnings.length} 个提醒 —— 这个文件现在不能装。`);
    return 1;
  }

  out(`结果：全部通过（${passes.length} 项检查，${warnings.length} 个提醒）。`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stdout.write(`[错误] 校验器自己挂了：${e?.stack ?? e}\n`);
    process.exit(1);
  });
