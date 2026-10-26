import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  LIBRARY_DIRS,
  LIBRARY_FILES,
  MANIFEST_FILE,
  MIRROR_VERSION,
  RESTORE_CMD,
  RESTORE_PS1,
  buildManifest,
  isReadableManifest,
  isSafeMirrorDir,
  parseExtraPaths,
  planMirror,
  renderRestoreCmd,
  renderRestorePs1,
} from '../src/core/mirror.mjs';
import { CONFIG_DEFAULTS, TUNABLE_KEYS, resolveConfig } from '../src/core/config.mjs';

const DATA = 'C:\\dsh\\ebbinghaus-memory';
const HOME = 'C:\\dsh';

/* ─────────────────── 目录安全 ─────────────────── */

test('isSafeMirrorDir: 正常绝对路径放行', () => {
  const r = isSafeMirrorDir('D:\\mirror\\eb', DATA);
  assert.equal(r.ok, true);
});

test('isSafeMirrorDir: 空路径 / 相对路径拒绝', () => {
  assert.equal(isSafeMirrorDir('', DATA).ok, false);
  assert.equal(isSafeMirrorDir('   ', DATA).ok, false);
  assert.equal(isSafeMirrorDir('mirror\\eb', DATA).ok, false);
});

test('isSafeMirrorDir: 镜像就是库目录、或互相嵌套，都拒绝', () => {
  assert.equal(isSafeMirrorDir(DATA, DATA).ok, false);
  // 镜像在库里
  assert.equal(isSafeMirrorDir(path.join(DATA, 'mirror'), DATA).ok, false);
  // 库在镜像里
  assert.equal(isSafeMirrorDir('C:\\dsh', DATA).ok, false);
});

test('isSafeMirrorDir: 大小写和结尾斜杠不影响判断', () => {
  assert.equal(isSafeMirrorDir('c:\\DSH\\EBBINGHAUS-MEMORY\\', DATA).ok, false);
});

/* ─────────────────── 清单规划 ─────────────────── */

test('planMirror: 记忆库那几个文件一个不少', () => {
  const { items } = planMirror({ dataDir: DATA, dshHome: HOME });
  const rels = items.map((i) => i.rel);
  for (const name of LIBRARY_FILES) {
    assert.ok(rels.includes(`library/${name}`), `缺 ${name}`);
  }
  for (const dir of LIBRARY_DIRS) {
    assert.ok(rels.includes(`library/${dir}`), `缺目录 ${dir}`);
  }
});

test('planMirror: 人格提示词进 dsh\\', () => {
  const { items } = planMirror({ dataDir: DATA, dshHome: HOME });
  const rels = items.map((i) => i.rel);
  assert.ok(rels.includes('dsh/AGENT.md'));
  assert.ok(rels.includes('dsh/prompt-inject.md'));
  const agent = items.find((i) => i.rel === 'dsh/AGENT.md');
  assert.equal(agent.src, path.join(HOME, 'AGENT.md'));
});

test('planMirror: 没有 dshHome 时给警告，且不含 dsh 项', () => {
  const { items, warnings } = planMirror({ dataDir: DATA, dshHome: '' });
  assert.ok(warnings.some((w) => w.includes('人格')));
  assert.equal(items.some((i) => i.rel.startsWith('dsh/')), false);
});

test('planMirror: 额外路径加序号前缀，同名文件不会互相覆盖', () => {
  const { items } = planMirror({
    dataDir: DATA,
    dshHome: HOME,
    extraPaths: ['D:\\bot\\data', 'D:\\bot\\data\\config.json'],
  });
  const extras = items.filter((i) => i.kind === 'extra').map((i) => i.rel);
  assert.equal(extras.length, 2);
  assert.equal(extras[0], 'extra/01-data');
  assert.equal(extras[1], 'extra/02-config.json');
});

test('planMirror: 相对路径的额外项被跳过并留警告', () => {
  const { items, warnings } = planMirror({
    dataDir: DATA,
    dshHome: HOME,
    extraPaths: ['relative\\path'],
  });
  assert.equal(items.filter((i) => i.kind === 'extra').length, 0);
  assert.ok(warnings.some((w) => w.includes('绝对路径')));
});

test('planMirror: 库目录为空时啥都不给', () => {
  const { items, warnings } = planMirror({ dataDir: '', dshHome: HOME });
  assert.equal(items.length, 0);
  assert.equal(warnings.length, 1);
});

/* ─────────────────── 额外路径解析 ─────────────────── */

test('parseExtraPaths: 一行一个，跳过空行和 # 注释', () => {
  const raw = ['D:\\a', '  ', '# 这是注释', 'D:\\b  ', ''].join('\r\n');
  assert.deepEqual(parseExtraPaths(raw), ['D:\\a', 'D:\\b']);
  assert.deepEqual(parseExtraPaths(undefined), []);
  assert.deepEqual(parseExtraPaths(123), []);
});

/* ─────────────────── manifest ─────────────────── */

test('buildManifest: 条数合计与版本、恢复入口都在', () => {
  const mf = buildManifest({
    createdAt: Date.parse('2026-10-26T15:00:00+08:00'),
    dataDir: DATA,
    dshHome: HOME,
    counts: { short: 93, long: 105, permanent: 97 },
    pluginVersion: '0.2.0',
    files: [{ rel: 'library/short.jsonl', src: path.join(DATA, 'short.jsonl'), kind: 'library', size: 10, mtime: 1 }],
  });
  assert.equal(mf.kind, 'ebbinghaus-mirror');
  assert.equal(mf.version, MIRROR_VERSION);
  assert.equal(mf.total, 295);
  assert.equal(mf.counts.permanent, 97);
  assert.equal(mf.source.dataDir, DATA);
  assert.equal(mf.restore.cmd, RESTORE_CMD);
  assert.equal(mf.files.length, 1);
  assert.equal(mf.createdAt, '2026-10-26T07:00:00.000Z');
});

test('isReadableManifest: 认自己写的，不认别人的 / 未来的', () => {
  const ok = buildManifest({ createdAt: Date.now(), dataDir: DATA, dshHome: HOME, counts: {}, pluginVersion: '0.2.0', files: [] });
  assert.equal(isReadableManifest(ok), true);
  assert.equal(isReadableManifest({ ...ok, kind: 'other' }), false);
  assert.equal(isReadableManifest({ ...ok, version: 99 }), false);
  assert.equal(isReadableManifest(null), false);
});

/* ─────────────────── 恢复程序 ─────────────────── */

test('renderRestoreCmd: 切 UTF-8 页面、调 ps1、留一个 pause', () => {
  const cmd = renderRestoreCmd();
  assert.match(cmd, /chcp 65001/);
  assert.ok(cmd.includes(RESTORE_PS1));
  assert.match(cmd, /pause/);
  // .cmd 里不该出现中文 —— 没 BOM 的 cmd 会把中文显示成乱码
  assert.equal(/[\u4e00-\u9fa5]/.test(cmd), false, '.cmd 里不要写中文');
});

test('renderRestorePs1: 该有的五件事都在（读清单、找人、问一句、先备份、再写回）', () => {
  const ps1 = renderRestorePs1();
  assert.ok(ps1.includes(MANIFEST_FILE), '要读清单');
  assert.ok(ps1.includes('Find-Candidates'), '要自己找目标目录');
  assert.match(ps1, /确认执行记忆恢复\?/, '要问一句');
  assert.ok(ps1.includes('_backup-before-restore-'), '要先备份当前库');
  assert.match(ps1, /kind -eq 'library'/, '要按来源类型分流');
  assert.ok(ps1.includes('重启 DSH'), '要提示重启');
  // 覆盖前必须先备份 —— 顺序不能反
  assert.ok(ps1.indexOf('_backup-before-restore-') < ps1.indexOf('写回 '), '备份要发生在写回之前');
});

test('renderRestorePs1: 支持 -Target 直接指定恢复目标', () => {
  const ps1 = renderRestorePs1();
  assert.match(ps1, /param\(\[string\]\$Target/);
  assert.match(ps1, /\$destDir = \$Target/);
});

test('renderRestorePs1: 目录走合并复制（直接 Copy-Item 目录会套一层同名目录）', () => {
  const ps1 = renderRestorePs1();
  // 注释里提到这种写法没关系，要防的是真的去执行它
  const bad = ps1
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#') && /Copy-Item\s+\$src\s+\$dest\s+-Recurse/.test(l));
  assert.equal(bad.length, 0, '有顶格的 Copy-Item \$src \$dest -Recurse，会套娃');
  assert.match(ps1, /Get-ChildItem -LiteralPath \$src/);
});

/* ─────────────────── 配置 ─────────────────── */

test('配置默认值：镜像默认关、每 5 条同步、目录留空', () => {
  assert.equal(CONFIG_DEFAULTS.mirrorEnabled, false);
  assert.equal(CONFIG_DEFAULTS.mirrorEveryEntries, 5);
  assert.equal(CONFIG_DEFAULTS.mirrorDir, '');
  assert.equal(CONFIG_DEFAULTS.mirrorExtraPaths, '');
});

test('配置钳制：每 N 条卡在 1~50，目录写错类型退回空串', () => {
  assert.equal(resolveConfig({ mirrorEveryEntries: 0 }).mirrorEveryEntries, 1);
  assert.equal(resolveConfig({ mirrorEveryEntries: 999 }).mirrorEveryEntries, 50);
  assert.equal(resolveConfig({ mirrorEveryEntries: 'abc' }).mirrorEveryEntries, 5);
  assert.equal(resolveConfig({ mirrorDir: 123 }).mirrorDir, '');
});

test('四个镜像键都能在面板里改（TUNABLE_KEYS 白名单）', () => {
  for (const key of ['mirrorEnabled', 'mirrorEveryEntries', 'mirrorDir', 'mirrorExtraPaths']) {
    assert.ok(TUNABLE_KEYS.includes(key), `${key} 没进白名单，面板上就不会出现`);
  }
});
