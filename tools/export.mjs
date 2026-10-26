#!/usr/bin/env node
/**
 * 导出记忆包（DSH 端）。
 *
 * 用法：
 *   node tools/export.mjs                        # 导到 <库>/_exports/ebbinghaus-dsh-<时间>.json
 *   node tools/export.mjs --dir D:/x/y           # 换一个库
 *   node tools/export.mjs --out D:/tmp/mem.json  # 指定文件（或指定目录，文件名自动生成）
 *
 * 为什么要有独立 CLI（面板里已经有 GET /ebbinghaus/export）：
 *   面板的导出只能在本机浏览器里点，而跨端同步的真实场景是「把这台机器的记忆
 *   搬到另一台机器 / 搬进 AstrBot」。要落到一个能拷走的文件，最省事的就是命令行。
 *
 * 这个脚本**只读库**，唯一的写操作是把包写到 _exports/（或 --out 指定处）。
 * 它绝不动 short/long/permanent/meta —— 导出不该改变任何记忆。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createStore } from '../src/core/store.mjs';
import { buildPackage, PACKAGE_FORMAT } from '../src/core/transfer.mjs';
import { ZONES, ZONE_LABEL } from '../src/core/schema.mjs';

/** 本端标识，写进包的 source 字段。 */
const SOURCE = 'dsh';

// ── 控制台小工具 ──────────────────────────────────────────────────────────

function two(n) {
  return String(n).padStart(2, '0');
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function errOut(line = '') {
  process.stderr.write(`${line}\n`);
}

/** Windows 控制台默认 cp936，Node 写的是 UTF-8 —— 不改代码页中文会乱码。 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  if (!process.stdout.isTTY) return;
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 改不了也不影响导出，只是中文难看
  }
}

/** 全角字符占两格，padEnd 会让表格歪掉。 */
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

function padCell(text, width, align) {
  const s = String(text ?? '');
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

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
  return [
    line(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

// ── 时间与路径 ────────────────────────────────────────────────────────────

/** 文件名时间戳：YYYYMMDD-HHmmss（本地时间）。 */
function fileStamp(d) {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** 给人看的时间：YYYY-MM-DD HH:mm。 */
function human(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

function resolveDataDir(cliDir) {
  if (typeof cliDir === 'string' && cliDir.trim() !== '') return path.resolve(cliDir.trim());
  const home = (process.env.DSH_HOME ?? '').trim();
  if (home !== '') return path.join(home, 'ebbinghaus-memory');
  throw new Error('找不到记忆库目录：请设置 DSH_HOME 环境变量，或者用 --dir 指定');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── 参数 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dir: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      args.dir = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--dir=')) {
      args.dir = a.slice('--dir='.length);
    } else if (a === '--out' || a === '-o') {
      args.out = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
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
导出记忆包（DSH 端）

  node tools/export.mjs [选项]

选项
  --dir <path>   记忆库目录
                 默认 $DSH_HOME/ebbinghaus-memory（没设 DSH_HOME 就得用 --dir 指定）
  --out <path>   输出文件；给的是已有目录则自动生成文件名
                 默认 <库目录>/_exports/ebbinghaus-dsh-<YYYYMMDD-HHmmss>.json
  --help, -h     这张帮助

只导 short / long / permanent 三个活分区。
_archive/（冷存档）、_backup-* 、_exports/ 都不会进包。
`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  ensureUtf8Console();

  const dataDir = resolveDataDir(args.dir);
  const now = Date.now();

  // 导出不该顺手建一个空库：库不存在就直说，别让人以为「导出成功但 0 条」。
  if (!(await exists(dataDir))) {
    errOut(`[错误] 记忆库不存在：${dataDir}`);
    errOut('       先让插件跑起来把库建出来，或用 --dir 指到真正的库目录。');
    return 1;
  }

  // 只读载入。坏行会被 store 跳过并 warn（不 throw），不会因为一行坏数据导不出来。
  const store = createStore({
    dir: dataDir,
    log: () => {},
    warn: (m) => errOut(`[库] ${m}`),
  });
  const loaded = await store.load();
  if (!loaded.ok) {
    errOut(`[错误] 记忆库读不了：${dataDir}`);
    return 1;
  }

  const snap = store.snapshot();
  const pkg = buildPackage({ zones: snap.zones, meta: snap.meta, source: SOURCE, now });

  // ── 决定输出路径 ────────────────────────────────────────────────────────
  let outFile;
  if (typeof args.out === 'string' && args.out.trim() !== '') {
    const p = path.resolve(args.out.trim());
    // --out 指到目录 → 目录里按默认名生成；指到文件 → 就用它
    if (await exists(p)) {
      const st = await fsp.stat(p);
      outFile = st.isDirectory() ? path.join(p, `ebbinghaus-${SOURCE}-${fileStamp(new Date(now))}.json`) : p;
    } else if (/[\\/]$/.test(args.out) || path.extname(p) === '') {
      // 不存在且没有扩展名 → 当成目录
      outFile = path.join(p, `ebbinghaus-${SOURCE}-${fileStamp(new Date(now))}.json`);
    } else {
      outFile = p;
    }
  } else {
    outFile = path.join(dataDir, '_exports', `ebbinghaus-${SOURCE}-${fileStamp(new Date(now))}.json`);
  }

  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  // 紧凑 JSON（与磁盘 jsonl 同一风格），末尾补一个换行方便 diff 与 cat。
  const text = `${JSON.stringify(pkg)}\n`;
  await fsp.writeFile(outFile, text, 'utf8');

  // ── 报表 ────────────────────────────────────────────────────────────────
  const total = pkg.counts.short + pkg.counts.long + pkg.counts.permanent;

  const rows = [];
  for (const zone of ZONES) {
    const list = pkg.zones[zone];
    const minTs = list.length > 0 ? list[0].ts : Number.NaN;
    const maxTs = list.length > 0 ? list[list.length - 1].ts : Number.NaN;
    rows.push([
      ZONE_LABEL[zone],
      String(list.length),
      list.length > 0 ? human(minTs) : '—',
      list.length > 0 ? human(maxTs) : '—',
    ]);
  }
  rows.push(['合计', String(total), '', '']);

  out('');
  out('Ebbinghaus-memory · 导出记忆包（DSH 端）');
  out(`  库目录    ${dataDir}`);
  out(`  包文件    ${outFile}`);
  out(`  大小      ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`);
  out(`  格式      ${PACKAGE_FORMAT}  (schema ${pkg.schema})`);
  out(`  导出于    ${human(pkg.exported_at)}`);
  out(`  墓碑      ${pkg.meta.deleted_ids.length} 条（已删除的 id，导入端会跳过它们）`);
  out('');
  out(renderTable(['分区', '条数', '最早', '最晚'], rows, [1]));
  out('');

  if (total === 0) {
    out('提示：这个库里一条记忆都没有，包是空的（不是导出失败）。');
  } else {
    out(`把这张包拷到另一端，用那边的 import 导入即可。`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errOut(`[错误] 导出中断：${e?.stack ?? e}`);
    process.exit(1);
  });
