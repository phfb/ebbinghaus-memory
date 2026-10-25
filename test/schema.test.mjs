import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZONES,
  clamp01,
  deriveKeywords,
  detailFloor,
  isValidEntry,
  makeId,
  normalizeEntry,
  normalizeKeywords,
} from '../src/core/schema.mjs';

test('分区常量顺序即深度', () => {
  assert.deepEqual([...ZONES], ['short', 'long', 'permanent']);
});

test('id 格式正确且能防撞', () => {
  const ts = new Date(2026, 9, 25, 0, 58, 57).getTime();
  const id = makeId(ts);
  assert.match(id, /^em-\d{8}T\d{4}-[0-9a-f]{4}$/);
  // 同一分钟生成 200 个，必须互不相同
  const taken = new Set();
  for (let i = 0; i < 200; i += 1) {
    const next = makeId(ts, taken);
    assert.ok(!taken.has(next), '撞 id 了');
    taken.add(next);
  }
});

test('normalizeEntry 补齐缺省并夹紧范围', () => {
  const e = normalizeEntry(
    { title: '他在做记忆插件', weight: 3, depth: 99 },
    { zone: 'short', now: 1000 },
  );
  assert.ok(e);
  assert.equal(e.weight, 1, 'weight 要夹到 1');
  assert.equal(e.depth, 9, 'depth 要夹到 9');
  assert.equal(e.zone, 'short');
  assert.ok(e.keywords.length >= 1, '没给关键词就要自己抽');
  assert.match(e.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('normalizeEntry 保留原始时间戳（迁移时不许被改成导入时刻）', () => {
  const old = new Date(2026, 8, 1, 3, 12).getTime();
  const e = normalizeEntry(
    { title: '旧事', ts: old },
    { zone: 'permanent', now: Date.now() },
  );
  assert.equal(e.ts, old);
});

test('未来时间戳会被拉回现在（时钟漂移不该让记忆永不到期）', () => {
  const now = Date.now();
  const e = normalizeEntry({ title: '未来', ts: now + 86400000 * 30 }, { zone: 'short', now });
  assert.ok(e.ts <= now + 60000);
});

test('什么都没给 → 返回 null（绝不写空条目）', () => {
  assert.equal(normalizeEntry({}, { zone: 'short' }), null);
  assert.equal(normalizeEntry({ title: '  ' }, { zone: 'short' }), null);
  assert.equal(normalizeEntry(null, { zone: 'short' }), null);
});

test('detail 为空时用 title 兜底 —— 永远不许没有内容', () => {
  const e = normalizeEntry({ title: '只有标题' }, { zone: 'short' });
  assert.equal(e.detail, '只有标题');
});

test('关键词去重、截断、限量', () => {
  const k = normalizeKeywords(['记忆', '记忆', '插件', '  ', 'DSH', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.ok(k.length <= 10);
  assert.equal(new Set(k.map((x) => x.toLowerCase())).size, k.length);
  assert.ok(!k.includes(''));
});

test('deriveKeywords 会从中文里切出 2-gram', () => {
  const k = deriveKeywords('记忆插件的分区容量');
  assert.ok(k.length > 0);
  assert.ok(k.some((x) => x.length === 2), '应当有二元组');
});

test('detailFloor：越深越短，但有 40 字下限', () => {
  const base = 1000;
  const d0 = detailFloor(0, base);
  const d1 = detailFloor(1, base);
  const d2 = detailFloor(2, base);
  const d5 = detailFloor(5, base);
  assert.equal(d0, base);
  assert.ok(d1 < d0 && d2 < d1 && d5 <= d2, '必须单调变短');
  assert.equal(detailFloor(9, 10), 40, '原本就短于 40 字也要保到 40');
  assert.ok(detailFloor(9, 30) >= 30, '不能比原文更短到丢失');
});

test('clamp01 挡住 NaN 与越界', () => {
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01('abc'), 0);
});

test('isValidEntry 拒绝塌掉的字段', () => {
  const good = normalizeEntry({ title: 'x' }, { zone: 'short' });
  assert.equal(isValidEntry(good), true);
  assert.equal(isValidEntry({ ...good, id: '' }), false);
  assert.equal(isValidEntry({ ...good, ts: 'abc' }), false);
  assert.equal(isValidEntry({ ...good, zone: 'dream' }), false);
  assert.equal(isValidEntry(null), false);
});
