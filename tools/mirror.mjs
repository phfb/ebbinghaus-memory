/**
 * 手动跑一次镜像同步 —— 或者只看「这次会复制什么」。
 *
 * 插件自己会在「每写入 N 条记忆」之后自动同步（面板里打开「自动备份镜像」）。
 * 这个脚本是给它配好之后**立刻验证一次**用的：不填镜像目录、或者想先看看清单，都用它。
 *
 * 用法：
 *   node tools/mirror.mjs --dir D:/mirror/ebbinghaus             # 只预演，不写盘
 *   node tools/mirror.mjs --dir D:/mirror/ebbinghaus --apply      # 真写
 *   node tools/mirror.mjs --dir ... --apply --data D:/other-library --extra D:/plugin-data
 *
 * 不传 --dir 时，会去库目录的 settings.json 里读面板上填的那个镜像目录。
 *
 * ⚠️ 复制规则和 `src/host/index.mjs` 的 `runMirrorNow` 是同一套（都走 core/mirror.mjs 的
 *    planMirror）。改了一边记得看另一边 —— 清单本身有单测守着，不会悄悄漂。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  MANIFEST_FILE,
  RESTORE_CMD,
  RESTORE_PS1,
  buildManifest,
  isSafeMirrorDir,
  parseExtraPaths,
  planMirror,
  renderRestoreCmd,
  renderRestorePs1,
  shouldSkipName,
} from '../src/core/mirror.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

if (has('--help') || has('-h')) {
  console.log(
    [
      '',
      '镜像同步（手动）',
      '',
      '  node tools/mirror.mjs --dir <镜像目录> [--apply]',
      '',
      '选项',
      '  --dir <path>    镜像目录（绝对路径）。不给就去库目录 settings.json 里读',
      '  --data <path>   记忆库目录，默认 $DSH_HOME/ebbinghaus-memory',
      '  --extra <path>  额外要镜像的路径，可重复；也可以用逗号分隔',
      '  --apply         真的写盘（默认只预演）',
      '  --help, -h      这张帮助',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

function dshHome() {
  const env = (process.env.DSH_HOME ?? '').trim();
  return env !== '' ? env : path.join(homedir(), '.dsh');
}

const dataDir = path.resolve(String(arg('--data', '') || path.join(dshHome(), 'ebbinghaus-memory')));

/** 从库目录的 settings.json（面板覆盖层）里读镜像目录。 */
function mirrorDirFromSettings() {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return typeof raw?.mirrorDir === 'string' ? raw.mirrorDir.trim() : '';
  } catch {
    return '';
  }
}

const explicitDir = String(arg('--dir', '') ?? '').trim();
const mirrorDir = explicitDir !== '' ? explicitDir : mirrorDirFromSettings();

if (mirrorDir === '') {
  console.error('没给镜像目录：加 --dir <目录>，或者先在面板里填好再跑。');
  process.exit(2);
}

const extraRaw = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--extra') continue;
  const v = argv[i + 1];
  if (typeof v === 'string' && !v.startsWith('--')) {
    for (const part of v.split(',')) if (part.trim() !== '') extraRaw.push(part.trim());
  }
}
if (extraRaw.length === 0) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    extraRaw.push(...parseExtraPaths(raw?.mirrorExtraPaths));
  } catch {
    // 没有就没有
  }
}

const safe = isSafeMirrorDir(mirrorDir, dataDir);
console.log('');
console.log('记忆库   :', dataDir);
console.log('镜像目录 :', path.resolve(mirrorDir));
if (!safe.ok) {
  console.error('✗ 目录不安全：' + safe.reason);
  process.exit(2);
}

const plan = planMirror({ dataDir, dshHome: dshHome(), extraPaths: extraRaw });
let count = 0;
let missing = 0;
let bytes = 0;
console.log('');
console.log('这次会同步：');
for (const item of plan.items) {
  if (!existsSync(item.src)) {
    missing += 1;
    continue;
  }
  let size = 0;
  try {
    size = statSync(item.src).size;
  } catch {
    size = 0;
  }
  bytes += size;
  count += 1;
  console.log(`  ✓ ${item.rel}  ←  ${item.src}  (${size} B)`);
}
for (const w of plan.warnings) console.log('  ! ' + w);
console.log('');
console.log(`共 ${count} 项，${(bytes / 1024).toFixed(1)} KB${missing > 0 ? `（另有 ${missing} 项源文件不存在，已跳过）` : ''}`);

if (!has('--apply')) {
  console.log('');
  console.log('这是预演。要真写，加 --apply。');
  process.exit(0);
}

// ── 真写 ─────────────────────────────────────────────────────────────
const mir = path.resolve(mirrorDir);
mkdirSync(mir, { recursive: true });
for (const sub of ['library', 'dsh', 'extra']) {
  try {
    rmSync(path.join(mir, sub), { recursive: true, force: true });
  } catch {
    // 删不掉就覆盖
  }
}

let written = 0;
const files = [];
for (const item of plan.items) {
  if (!existsSync(item.src)) continue;
  const dest = path.join(mir, item.rel.split('/').join(path.sep));
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(item.src, dest, { recursive: true, force: true, filter: (s) => !shouldSkipName(path.basename(s)) });
  let size = 0;
  try {
    size = statSync(dest).size;
  } catch {
    size = 0;
  }
  files.push({ rel: item.rel, src: item.src, kind: item.kind, size, mtime: Date.now() });
  written += 1;
}

function countLines(p) {
  try {
    return readFileSync(p, 'utf8').split('\n').filter((s) => s.trim() !== '').length;
  } catch {
    return 0;
  }
}

const manifest = buildManifest({
  createdAt: Date.now(),
  dataDir,
  dshHome: dshHome(),
  counts: {
    short: countLines(path.join(dataDir, 'short.jsonl')),
    long: countLines(path.join(dataDir, 'long.jsonl')),
    permanent: countLines(path.join(dataDir, 'permanent.jsonl')),
  },
  pluginVersion: (() => {
    try {
      return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '';
    } catch {
      return '';
    }
  })(),
  files,
});
writeFileSync(path.join(mir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeFileSync(path.join(mir, RESTORE_CMD), renderRestoreCmd(), 'utf8');
writeFileSync(path.join(mir, RESTORE_PS1), `\uFEFF${renderRestorePs1()}`, 'utf8');

console.log('');
console.log(`✓ 已同步 ${written} 项到 ${mir}`);
console.log(`  清单：${MANIFEST_FILE}   恢复程序：${RESTORE_CMD}`);
