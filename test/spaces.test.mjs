import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  LEGACY_LIB_FILES,
  MAX_SPACES,
  emptyRegistry,
  findSpace,
  isValidSpaceId,
  makeSpaceId,
  normalizeSpaceName,
  parseRegistry,
  bindIfNew,
  parseBindings,
  planLegacyMigration,
  pruneBindings,
  resolveSessionSpace,
  spaceDirOf,
  verifyMigration,
} from '../src/core/spaces.mjs';

/* ─────────────────── id / 名字 ─────────────────── */

test('分区 id：只收 ASCII 小写数字下划线短横，2~32 位', () => {
  assert.equal(isValidSpaceId('private'), true);
  assert.equal(isValidSpaceId('work-2'), true);
  assert.equal(isValidSpaceId('a_1'), true);
  assert.equal(isValidSpaceId('a'), false, '太短');
  assert.equal(isValidSpaceId('私生活'), false, '不许中文（它还是目录名）');
  assert.equal(isValidSpaceId('-abc'), false);
  assert.equal(isValidSpaceId('A B'), false);
  assert.equal(isValidSpaceId(''), false);
  assert.equal(isValidSpaceId(123), false);
});

test('显示名：去换行、裁到 24 字、空的返回空串', () => {
  assert.equal(normalizeSpaceName('  私生活 '), '私生活');
  assert.equal(normalizeSpaceName('a\nb'), 'a b');
  assert.equal(normalizeSpaceName(''), '');
  assert.equal(normalizeSpaceName('x'.repeat(50)).length, 24);
});

test('makeSpaceId：英文名转 slug，中文名退成 space-N，撞名自动加序号', () => {
  assert.equal(makeSpaceId('Work'), 'work');
  assert.equal(makeSpaceId('my work'), 'my-work');
  assert.equal(makeSpaceId('私生活', []), 'space');
  assert.equal(makeSpaceId('私生活', ['space']), 'space-2');
  assert.equal(makeSpaceId('work', ['work']), 'work-2');
});

/* ─────────────────── 注册表 ─────────────────── */

test('注册表：空的也能用（自动一个默认分区）', () => {
  const r = emptyRegistry(Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(r.version, 1);
  assert.equal(r.active, DEFAULT_SPACE_ID);
  assert.equal(r.spaces.length, 1);
  assert.equal(r.spaces[0].name, DEFAULT_SPACE_NAME);
});

test('注册表：坏数据整流 —— 非法 id 跳过、重复去掉、active 不存在就回退', () => {
  const { registry, problems } = parseRegistry({
    version: 1,
    active: 'nope',
    spaces: [
      { id: 'work', name: '工作' },
      { id: 'work', name: '重复的' },
      { id: '中文', name: '非法 id' },
      { name: '没有 id' },
    ],
  });
  assert.equal(registry.spaces.length, 1);
  assert.equal(registry.spaces[0].id, 'work');
  assert.equal(registry.active, 'work', 'active 指向不存在的分区时要回退到第一个');
  assert.ok(problems.length >= 2);
});

test('注册表：一个合法分区都没有 → 重建默认', () => {
  const { registry, problems } = parseRegistry({ spaces: [{ id: 'X' }] });
  assert.equal(registry.spaces[0].id, DEFAULT_SPACE_ID);
  assert.ok(problems.some((p) => p.includes('重建')));
});

test('注册表：超过 10 个就截断', () => {
  const spaces = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, name: `分区${i}` }));
  const { registry, problems } = parseRegistry({ active: 's0', spaces });
  assert.equal(registry.spaces.length, MAX_SPACES);
  assert.ok(problems.some((p) => p.includes('超过')));
});

test('findSpace / spaceDirOf', () => {
  const r = emptyRegistry();
  assert.equal(findSpace(r, DEFAULT_SPACE_ID)?.id, DEFAULT_SPACE_ID);
  assert.equal(findSpace(r, 'nope'), null);
  assert.equal(spaceDirOf('C:/lib', 'work'), path.join('C:/lib', 'spaces', 'work'));
});

/* ─────────────────── 老库迁移判定 ─────────────────── */

test('迁移判定：根目录有老库、且还没有 spaces → 该搬', () => {
  const plan = planLegacyMigration({
    rootHasSpacesDir: false,
    rootFiles: ['short.jsonl', 'long.jsonl', 'permanent.jsonl', 'meta.json', 'settings.json', '我自己放的.txt'],
    targetDirExists: false,
  });
  assert.equal(plan.needed, true);
  assert.ok(plan.files.includes('short.jsonl'));
  assert.ok(plan.files.includes('settings.json'));
  assert.ok(!plan.files.includes('我自己放的.txt'), '不相干的文件不动');
  assert.deepEqual(plan.files.every((f) => LEGACY_LIB_FILES.includes(f)), true);
});

test('迁移判定：已经有 spaces / 目标是空的 / 目标已存在 → 都不搬', () => {
  const base = { rootFiles: ['short.jsonl'], targetDirExists: false };
  assert.equal(planLegacyMigration({ ...base, rootHasSpacesDir: true }).needed, false);
  assert.equal(
    planLegacyMigration({ rootHasSpacesDir: false, rootFiles: ['readme.txt'], targetDirExists: false }).needed,
    false,
  );
  assert.equal(planLegacyMigration({ ...base, rootHasSpacesDir: false, targetDirExists: true }).needed, false);
});

test('迁移校验：条数对上才许删原件', () => {
  assert.equal(verifyMigration({ short: 3, long: 2, permanent: 1 }, { short: 3, long: 2, permanent: 1 }).ok, true);
  const bad = verifyMigration({ short: 3, long: 2, permanent: 0 }, { short: 3, long: 2, permanent: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems[0].includes('permanent'));
});

test('迁移校验：缺字段按 0 算，不会误判成通过', () => {
  assert.equal(verifyMigration({}, { short: 1, long: 0, permanent: 0 }).ok, false);
});

/* ─────────────────── 端到端：ensureSpaces ─────────────────── */

const hostModule = await import('../src/host/index.mjs');
const ensureSpaces = hostModule.__spacesTest?.ensureSpaces;

function makeLegacyDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eb-space-'));
  writeFileSync(path.join(dir, 'short.jsonl'), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
  writeFileSync(path.join(dir, 'long.jsonl'), '{"id":"d"}\n');
  writeFileSync(path.join(dir, 'permanent.jsonl'), '{"id":"e"}\n{"id":"f"}\n');
  writeFileSync(path.join(dir, 'meta.json'), '{"schema":1}');
  mkdirSync(path.join(dir, '_archive'));
  writeFileSync(path.join(dir, '_archive', 'dedup.jsonl'), '{"id":"z"}\n');
  return dir;
}

test('ensureSpaces：老库整体搬进「私生活」，条数一条不少', (t) => {
  assert.ok(ensureSpaces, 'host 要导出 __spacesTest.ensureSpaces');
  const dir = makeLegacyDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = ensureSpaces(dir);
  assert.equal(r.activeId, DEFAULT_SPACE_ID);
  assert.equal(r.activeName, DEFAULT_SPACE_NAME);
  assert.equal(r.migrated, true);
  assert.equal(r.degraded, false);

  const lib = path.join(dir, 'spaces', DEFAULT_SPACE_ID);
  assert.equal(r.spaceDir, lib);
  assert.equal(existsSync(path.join(lib, 'short.jsonl')), true);
  assert.equal(existsSync(path.join(lib, '_archive', 'dedup.jsonl')), true, '冷存档也要跟着搬');
  assert.equal(readFileSync(path.join(lib, 'short.jsonl'), 'utf8').trim().split('\n').length, 3);

  assert.equal(existsSync(path.join(dir, 'short.jsonl')), false, '原件搬完要删掉');
  assert.equal(existsSync(path.join(dir, 'spaces.json')), true, '注册表要写出来');
  const reg = JSON.parse(readFileSync(path.join(dir, 'spaces.json'), 'utf8'));
  assert.equal(reg.active, DEFAULT_SPACE_ID);
});

test('ensureSpaces：第二次跑不再搬（幂等）', (t) => {
  const dir = makeLegacyDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = ensureSpaces(dir);
  assert.equal(first.migrated, true);
  const second = ensureSpaces(dir);
  assert.equal(second.migrated, false, '第二次不该再搬');
  assert.equal(second.degraded, false);
  assert.equal(readFileSync(path.join(second.spaceDir, 'short.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('ensureSpaces：全新空目录照样建出分区结构', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eb-space-new-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = ensureSpaces(dir);
  assert.equal(r.migrated, false);
  assert.equal(r.activeId, DEFAULT_SPACE_ID);
  assert.equal(existsSync(r.spaceDir), true);
  assert.equal(existsSync(path.join(dir, 'spaces.json')), true);
});

test('ensureSpaces：注册表坏掉也照样能用（回退默认分区 + 记问题）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eb-space-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'spaces', DEFAULT_SPACE_ID), { recursive: true });
  writeFileSync(path.join(dir, 'spaces.json'), '{ 这不是 json', 'utf8');

  const r = ensureSpaces(dir);
  assert.equal(r.activeId, DEFAULT_SPACE_ID);
  assert.ok(r.problems.some((p) => p.includes('spaces.json')), '要说一句为什么');
  assert.equal(existsSync(r.spaceDir), true);
});

/* ─────────────────── 会话 → 分区 绑定 ─────────────────── */

test('parseBindings: 坏数据整流，非法分区 id 丢掉', () => {
  const { bindings, problems } = parseBindings({
    bindings: { 'sess-a': 'work', 'sess-b': '非法', '': 'work' },
  });
  assert.equal(bindings['sess-a'], 'work');
  assert.equal('sess-b' in bindings, false);
  assert.equal(Object.keys(bindings).length, 1);
  assert.ok(problems.length >= 1);
});

test('parseBindings: 空表 / 非对象都不炸', () => {
  assert.deepEqual(parseBindings(null).bindings, {});
  assert.deepEqual(parseBindings({}).bindings, {});
  assert.deepEqual(parseBindings({ bindings: 'x' }).bindings, {});
});

test('resolveSessionSpace: 有绑定走绑定，没绑定跟 active', () => {
  const b = { 'sess-a': 'work' };
  assert.equal(resolveSessionSpace(b, 'private', 'sess-a'), 'work');
  assert.equal(resolveSessionSpace(b, 'private', 'sess-new'), 'private');
  assert.equal(resolveSessionSpace(b, 'private', ''), 'private');
});

test('resolveSessionSpace: 绑定的分区已经不存在了 → 回落到 active', () => {
  const b = { 'sess-a': 'gone' };
  assert.equal(resolveSessionSpace(b, 'private', 'sess-a', ['private', 'work']), 'private');
  assert.equal(resolveSessionSpace(b, 'private', 'sess-a', ['gone', 'private']), 'gone');
});

test('bindIfNew: 第一次钉住，第二次不覆盖', () => {
  const b = {};
  assert.equal(bindIfNew(b, 'sess-a', 'private'), true);
  assert.equal(b['sess-a'], 'private');
  assert.equal(bindIfNew(b, 'sess-a', 'work'), false, '钉过就不许改');
  assert.equal(b['sess-a'], 'private');
  assert.equal(bindIfNew(b, '', 'work'), false);
});

test('pruneBindings: 分区没了就把绑定清掉', () => {
  const b = { 'sess-a': 'work', 'sess-b': 'gone' };
  const r = pruneBindings(b, ['private', 'work']);
  assert.equal(r.bindings['sess-a'], 'work');
  assert.equal('sess-b' in r.bindings, false);
  assert.equal(r.removed, 1);
});
