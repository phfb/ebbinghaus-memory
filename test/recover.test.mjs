import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupByZone, parseJsonl, pickMissing, scanJsonl } from '../src/core/recover.mjs';

const good = (id, zone = 'short') => ({
  id,
  ts: 1793086189781,
  zone,
  title: `t-${id}`,
  detail: `d-${id}`,
  keywords: ['k'],
});

test('parseJsonl：坏行跳过并计数，不整批失败', () => {
  const text = [
    JSON.stringify(good('a')),
    '{ 这不是 json',
    '',
    JSON.stringify(good('b')),
    '[1,2,3]',
    'null',
  ].join('\n');
  const { entries, badLines } = parseJsonl(text);
  assert.equal(entries.length, 2);
  assert.equal(badLines, 3, '非 JSON / 数组 / null 都算坏行');
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
});

test('parseJsonl：空输入不炸', () => {
  assert.deepEqual(parseJsonl(''), { entries: [], badLines: 0 });
  assert.deepEqual(parseJsonl(null), { entries: [], badLines: 0 });
});

test('pickMissing：只补本地没有的，重复和残缺的跳过', () => {
  const mirror = [
    good('a'), // 本地已有
    good('b'), // 该补
    good('b'), // 镜像内重复
    { id: 'c', ts: 1 }, // 缺 zone / keywords，残缺
    { ts: 2, zone: 'short', keywords: [] }, // 没 id
    good('d', 'long'),
  ];
  const { add, skipped } = pickMissing(new Set(['a']), mirror);
  assert.deepEqual(add.map((e) => e.id), ['b', 'd']);
  assert.equal(skipped, 4);
});

test('pickMissing：本地一条都没有时全补', () => {
  const { add } = pickMissing([], [good('x'), good('y')]);
  assert.equal(add.length, 2);
});

test('groupByZone：按 zone 归类，非法 zone 丢掉', () => {
  const grouped = groupByZone([good('a', 'short'), good('b', 'long'), good('c', 'dream')], ['short', 'long', 'permanent']);
  assert.equal(grouped.short.length, 1);
  assert.equal(grouped.long.length, 1);
  assert.equal(grouped.permanent.length, 0);
  assert.equal(grouped.dream, undefined);
});

test('scanJsonl：数出坏行', () => {
  const text = [JSON.stringify(good('a')), 'breaking', JSON.stringify(good('b'))].join('\n');
  assert.deepEqual(scanJsonl(text), { total: 3, bad: 1 });
  assert.deepEqual(scanJsonl(''), { total: 0, bad: 0 });
});
