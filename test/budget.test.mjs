/**
 * 全库总量（token）的测试。
 *
 * 重点在三条：
 *  1. 口径与注入**同一个** —— 同一套截断、同一个 1.8 字/token；
 *  2. 上限的钳制区间（5000 .. 300000）与坏值兜底；
 *  3. 回收组的挑选规则 —— 先长期、不碰人格底色、跳过只剩一条的区、
 *     新记忆不优先压。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOTAL_CAPACITY_DEFAULT,
  TOTAL_CAPACITY_MAX,
  TOTAL_CAPACITY_MIN,
  estimateEntryTokens,
  pickReclaimGroup,
  tokenUsage,
  totalCapacityOf,
} from '../src/core/budget.mjs';
import { resolveConfig } from '../src/core/config.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const cfg = resolveConfig({});

let seq = 0;
function mk(o = {}) {
  seq += 1;
  return {
    id: o.id ?? `em-test-${seq}`,
    ts: o.ts ?? NOW - 3 * DAY,
    iso: '2026-10-22T12:00:00+08:00',
    zone: o.zone ?? 'short',
    weight: o.weight ?? 0.5,
    title: o.title ?? `事件${seq}`,
    detail: o.detail ?? '这是一段细节'.repeat(10),
    keywords: ['测试'],
    source: 'chat',
    depth: o.depth ?? 0,
    mergedFrom: [],
    session: '',
    touchedAt: 0,
    createdAt: 0,
  };
}

/* ───────────────────────── 上限 ───────────────────────── */

test('totalCapacityOf：默认 100K，坏值 100K，超顶钳到 300K，过小钳到 5K', () => {
  assert.equal(totalCapacityOf({}), TOTAL_CAPACITY_DEFAULT);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 100000 }), 100000);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 0 }), TOTAL_CAPACITY_DEFAULT);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 'abc' }), TOTAL_CAPACITY_DEFAULT);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 999999 }), TOTAL_CAPACITY_MAX);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 10 }), TOTAL_CAPACITY_MIN);
  assert.equal(totalCapacityOf({ totalTokenCapacity: 60000.7 }), 60001);
});

test('配置里的默认值就是 100K，且不超过硬顶', () => {
  assert.equal(cfg.totalTokenCapacity, TOTAL_CAPACITY_DEFAULT);
  assert.ok(cfg.totalTokenCapacity <= TOTAL_CAPACITY_MAX);
});

/* ───────────────────────── 统计 ───────────────────────── */

test('tokenUsage：空库是 0，不除零', () => {
  const u = tokenUsage({}, cfg, NOW);
  assert.equal(u.total, 0);
  assert.equal(u.count, 0);
  assert.equal(u.over, false);
  assert.equal(u.ratio, 0);
  assert.equal(u.left, TOTAL_CAPACITY_DEFAULT);
});

test('tokenUsage：合计 = 三区之和，count = 条数', () => {
  const zones = {
    short: [mk(), mk()],
    long: [mk({ zone: 'long' })],
    permanent: [mk({ zone: 'permanent', weight: 0.95 })],
  };
  const u = tokenUsage(zones, cfg, NOW);
  assert.equal(u.byZone.short + u.byZone.long + u.byZone.permanent, u.total);
  assert.equal(u.count, 4);
  assert.ok(u.total > 0);
});

test('tokenUsage：条目越多 token 越多，超上限时 over=true', () => {
  const many = Array.from({ length: 80 }, () => mk({ detail: '很长的细节内容'.repeat(30) }));
  const u = tokenUsage({ short: many }, { ...cfg, totalTokenCapacity: 5000 }, NOW);
  assert.ok(u.total > 5000, `实际 ${u.total}`);
  assert.equal(u.over, true);
  assert.equal(u.left, 0);
  assert.equal(u.ratio, 1, '超了就顶到 100%，不显示 120%');
});

test('estimateEntryTokens 走注入口径：细节强度越低，同一条越短', () => {
  const e = mk({ detail: '一二三四五六七八九十'.repeat(20) });
  const heavy = estimateEntryTokens(e, 'short', { ...cfg, shortDetail: 1 }, NOW);
  const light = estimateEntryTokens(e, 'short', { ...cfg, shortDetail: 0.2 }, NOW);
  assert.ok(heavy > light, `详细 ${heavy} 应该大于模糊 ${light}`);
  assert.ok(light > 0, '再模糊也不能是 0 —— 下限 40 字还在');
});

/* ───────────────────────── 挑回收组 ───────────────────────── */

test('pickReclaimGroup：先动长期区（背景音），不是短期', () => {
  const zones = {
    short: [mk({ id: 's1' }), mk({ id: 's2' })],
    long: [mk({ id: 'l1', zone: 'long' }), mk({ id: 'l2', zone: 'long' })],
    permanent: [],
  };
  const g = pickReclaimGroup(zones, cfg, NOW);
  assert.equal(g.zone, 'long');
  assert.equal(g.entries.length, 2);
  assert.deepEqual(g.entries.map((e) => e.id).sort(), ['l1', 'l2']);
});

test('pickReclaimGroup：一个区只剩一条就不动它', () => {
  const zones = {
    short: [mk({ id: 'solo' })],
    long: [mk({ id: 'l1', zone: 'long' }), mk({ id: 'l2', zone: 'long' })],
    permanent: [],
  };
  const g = pickReclaimGroup(zones, cfg, NOW);
  assert.equal(g.zone, 'long', '短期只有一条，不能挑');
});

test('pickReclaimGroup：权重最低的先被压，同权重挑最老', () => {
  const zones = {
    short: [
      mk({ id: 'high', weight: 0.9, ts: NOW - 5 * DAY }),
      mk({ id: 'low-old', weight: 0.1, ts: NOW - 9 * DAY }),
      mk({ id: 'low-new', weight: 0.1, ts: NOW - 2 * DAY }),
    ],
    long: [],
    permanent: [],
  };
  const g = pickReclaimGroup(zones, cfg, NOW, { groupSize: 2 });
  assert.equal(g.zone, 'short');
  assert.deepEqual(g.entries.map((e) => e.id), ['low-old', 'low-new']);
});

test('pickReclaimGroup：24 小时内的新记忆排在同权重旧记忆后面', () => {
  const zones = {
    short: [
      mk({ id: 'old', weight: 0.5, ts: NOW - 10 * DAY }),
      mk({ id: 'fresh', weight: 0.5, ts: NOW - 3600_000 }),
      mk({ id: 'older', weight: 0.5, ts: NOW - 20 * DAY }),
    ],
    long: [],
    permanent: [],
  };
  const g = pickReclaimGroup(zones, cfg, NOW, { groupSize: 3 });
  assert.equal(g.entries[g.entries.length - 1].id, 'fresh', '刚记下来的排最后');
});

test('pickReclaimGroup：永久区的底色（weight ≥ 0.92）不参与回收', () => {
  const zones = {
    short: [],
    long: [],
    permanent: [
      mk({ id: 'who', zone: 'permanent', weight: 0.95 }),
      mk({ id: 'habit', zone: 'permanent', weight: 0.9 }),
      mk({ id: 'hobby', zone: 'permanent', weight: 0.4 }),
    ],
  };
  const g = pickReclaimGroup(zones, cfg, NOW);
  assert.equal(g.zone, 'permanent');
  const ids = g.entries.map((e) => e.id);
  assert.ok(!ids.includes('who'), '人格底色不许动');
  assert.ok(ids.includes('hobby'));
});

test('pickReclaimGroup：全是底色时返回 null（到极限了）', () => {
  const zones = {
    short: [],
    long: [],
    permanent: [
      mk({ id: 'a', zone: 'permanent', weight: 0.95 }),
      mk({ id: 'b', zone: 'permanent', weight: 0.99 }),
    ],
  };
  assert.equal(pickReclaimGroup(zones, cfg, NOW), null);
});

test('pickReclaimGroup：坏数据不炸（缺区 / null / 没 id）', () => {
  assert.equal(pickReclaimGroup({}, cfg, NOW), null);
  assert.equal(pickReclaimGroup({ short: [null, { title: '没 id' }] }, cfg, NOW), null);
  const g = pickReclaimGroup(
    { short: [null, { id: 'x', ts: NOW - DAY, weight: 0.1 }, { id: 'y', ts: NOW - 2 * DAY, weight: 0.2 }] },
    cfg,
    NOW,
  );
  assert.equal(g.zone, 'short');
  assert.equal(g.entries.length, 2);
});
