/**
 * 三分区策略的测试。
 *
 * 重点不是「函数跑通了」，而是三条分支（升级 / 淘汰 / 留级）各自走对，
 * 以及一切到期判断都基于 `entry.ts` 而不是 `createdAt`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEntry } from '../src/core/schema.mjs';
import { resolveConfig } from '../src/core/config.mjs';
import {
  digestDropped,
  harvest,
  initialZoneFor,
  isOverCapacity,
  overflowCount,
  zoneCapacity,
} from '../src/core/zones.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime(); // 2026-10-25 12:00 本地
const cfg = resolveConfig({});

let seq = 0;
/**
 * 造一条记忆。默认 ts = 现在；createdAt 永远是「刚入库」，
 * 这样就能验证到期判定到底看的是哪个时间。
 */
function mk(o = {}) {
  seq += 1;
  const ts = o.ts ?? NOW;
  const e = normalizeEntry(
    {
      ts,
      weight: o.weight ?? 0.5,
      title: o.title ?? `事件${seq}`,
      detail: o.detail ?? `细节${seq}`,
      keywords: o.keywords ?? ['测试'],
      depth: o.depth ?? 0,
      createdAt: o.createdAt ?? NOW,
      touchedAt: o.touchedAt ?? ts,
    },
    { zone: o.zone ?? 'short', now: NOW },
  );
  assert.notEqual(e, null, '工厂造出了不合格条目，测试本身有问题');
  return e;
}

test('initialZoneFor：模型给的 zone 建议优先（用户要求 AI 自己判层）', () => {
  assert.equal(initialZoneFor(0.1, cfg, 'permanent'), 'permanent');
  assert.equal(initialZoneFor(0.1, cfg, 'long'), 'long');
  assert.equal(initialZoneFor(0.9, cfg, 'short'), 'short');
  // 垃圾建议不能当判决用，退回权重路径
  assert.equal(initialZoneFor(0.3, cfg, 'dream'), 'short');
  assert.equal(initialZoneFor(0.3, cfg, ''), 'short');
});

test('initialZoneFor：没给建议时按权重保守分层，绝大多数仍从 short 起步', () => {
  assert.equal(initialZoneFor(0, cfg), 'short');
  assert.equal(initialZoneFor(0.5, cfg), 'short');
  assert.equal(initialZoneFor(0.77, cfg), 'short');
  // 0.78 起才进长期 —— 这个门槛刻意高，入库那一刻的权重最不可靠
  assert.equal(initialZoneFor(0.78, cfg), 'long');
  assert.equal(initialZoneFor(0.9, cfg), 'long');
  // 0.92 以上才空降永久（人格 / 雷区 / 死规矩）
  assert.equal(initialZoneFor(0.92, cfg), 'permanent');
  assert.equal(initialZoneFor(1, cfg), 'permanent');
  assert.equal(initialZoneFor(NaN, cfg), 'short');
});

test('harvest 没到期：一条都不动，plan 也是空的', () => {
  const fresh = mk({ ts: NOW - 2 * DAY, weight: 0.9 });
  const { zones, plan } = harvest({ zones: { short: [fresh], long: [], permanent: [] }, cfg, now: NOW });
  assert.equal(zones.short.length, 1);
  assert.equal(zones.short[0].depth, 0);
  assert.equal(zones.long.length, 0);
  assert.deepEqual(plan, []);
});

test('harvest 分支一（升级）：过 7 天且 weight ≥ 0.55 → long，ts 不变', () => {
  const e = mk({ ts: NOW - 8 * DAY, weight: 0.7, depth: 2 });
  const { zones, plan } = harvest({ zones: { short: [e], long: [], permanent: [] }, cfg, now: NOW });

  assert.equal(zones.short.length, 0);
  assert.equal(zones.long.length, 1);
  const moved = zones.long[0];
  assert.equal(moved.zone, 'long');
  assert.equal(moved.ts, e.ts, '升级不许改时间戳');
  assert.equal(moved.depth, 2, '升级只换区，不再叠一层 depth');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].from, 'short');
  assert.equal(plan[0].to, 'long');
  assert.match(plan[0].reason, /升级/);
});

test('harvest 分支二（淘汰）：过 7 天且 weight < 0.2 → 消失', () => {
  const e = mk({ ts: NOW - 9 * DAY, weight: 0.1 });
  const { zones, plan } = harvest({ zones: { short: [e], long: [], permanent: [] }, cfg, now: NOW });

  assert.equal(zones.short.length, 0);
  assert.equal(zones.long.length, 0);
  assert.equal(zones.permanent.length, 0);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].to, 'drop');
  assert.match(plan[0].reason, /遗忘/);
});

test('harvest 分支三（留级）：过 7 天但权重在中间 → 留在 short 且 depth+1', () => {
  const e = mk({ ts: NOW - 10 * DAY, weight: 0.35, depth: 1 });
  const { zones, plan } = harvest({ zones: { short: [e], long: [], permanent: [] }, cfg, now: NOW });

  assert.equal(zones.short.length, 1);
  assert.equal(zones.long.length, 0);
  assert.equal(zones.short[0].depth, 2, '留级要模糊一层');
  assert.equal(zones.short[0].ts, e.ts, '留级同样不许改时间戳');
  assert.equal(plan[0].to, 'stay');
});

test('harvest 长期区：升级到 permanent / 淘汰 / 留级三条分支', () => {
  const up = mk({ zone: 'long', ts: NOW - 30 * DAY, weight: 0.8 });
  const gone = mk({ zone: 'long', ts: NOW - 31 * DAY, weight: 0.05 });
  const stay = mk({ zone: 'long', ts: NOW - 40 * DAY, weight: 0.5, depth: 3 });

  const { zones, plan } = harvest({
    zones: { short: [], long: [up, gone, stay], permanent: [] },
    cfg,
    now: NOW,
  });

  assert.equal(zones.long.length, 1);
  assert.equal(zones.permanent.length, 1);
  assert.equal(zones.permanent[0].id, up.id);
  assert.equal(zones.permanent[0].ts, up.ts);
  assert.equal(zones.long[0].id, stay.id);
  assert.equal(zones.long[0].depth, 4);

  const byId = new Map(plan.map((x) => [x.id, x]));
  assert.equal(byId.get(up.id).to, 'permanent');
  assert.equal(byId.get(gone.id).to, 'drop');
  assert.equal(byId.get(stay.id).to, 'stay');
});

test('harvest 永久区：永远不到期', () => {
  const e = mk({ zone: 'permanent', ts: NOW - 3000 * DAY, weight: 0.1 });
  const { zones, plan } = harvest({ zones: { short: [], long: [], permanent: [e] }, cfg, now: NOW });
  assert.equal(zones.permanent.length, 1);
  assert.deepEqual(plan, []);
});

test('harvest 到期判定用 entry.ts，不是 createdAt', () => {
  // 事件发生在 10 天前，但 5 分钟前才入库 —— 会「刚发生」是错的
  const old = mk({ ts: NOW - 10 * DAY, createdAt: NOW - 5 * 60000, weight: 0.35 });
  const { zones, plan } = harvest({ zones: { short: [old], long: [], permanent: [] }, cfg, now: NOW });
  // weight 0.35 落在 [0.2, 0.55) → 留级（如果按 createdAt 算，它会原样不动、plan 为空）
  assert.equal(zones.short.length, 1);
  assert.equal(zones.short[0].depth, 1);
  assert.equal(plan.length, 1);

  // 反向：事件在 2 天前，但 30 天前入库 —— 不该被收割
  const recent = mk({ ts: NOW - 2 * DAY, createdAt: NOW - 30 * DAY, weight: 0.1 });
  const r2 = harvest({ zones: { short: [recent], long: [], permanent: [] }, cfg, now: NOW });
  assert.equal(r2.zones.short.length, 1);
  assert.equal(r2.zones.short[0].depth, 0);
  assert.deepEqual(r2.plan, []);
});

test('harvest 纯函数：不改入参，也不共享对象引用', () => {
  const e = mk({ ts: NOW - 9 * DAY, weight: 0.4, depth: 0 });
  const input = { short: [e], long: [], permanent: [] };
  const before = JSON.stringify(input);
  const { zones } = harvest({ zones: input, cfg, now: NOW });

  assert.equal(JSON.stringify(input), before, '入参被改写了');
  assert.equal(input.short[0].depth, 0, '入参条目被改写了');
  assert.notEqual(zones.short[0], input.short[0], '返回的条目应该是新对象');
});

test('harvest 缺区/坏数据不炸：空对象也能跑', () => {
  const out = harvest({ zones: {}, cfg, now: NOW });
  assert.deepEqual(out.plan, []);
  assert.equal(out.zones.short.length, 0);
  assert.equal(out.zones.long.length, 0);
  assert.equal(out.zones.permanent.length, 0);
});

test('isOverCapacity：正好等于上限不算超', () => {
  // 上限从配置里取，不写死数字 —— 默认值改过一次（60 → 120），
  // 写死会让「改配置」变成「改测试」，那这个断言保护的就不是行为了。
  const cap = cfg.shortCapacity;
  const list = Array.from({ length: cap }, () => mk());
  assert.equal(isOverCapacity('short', list, cfg), false);
  assert.equal(isOverCapacity('short', [...list, mk()], cfg), true);
  assert.equal(isOverCapacity('short', [], cfg), false);
});

test('overflowCount：未超容返回 0，超了就返回超出多少（至少 1）', () => {
  const cap = cfg.shortCapacity;
  const list = Array.from({ length: cap }, () => mk());
  assert.equal(overflowCount('short', list, cfg), 0);
  assert.equal(overflowCount('short', [...list, mk()], cfg), 1);
  assert.equal(overflowCount('short', [...list, mk(), mk(), mk()], cfg), 3);
  assert.equal(overflowCount('short', [], cfg), 0);
});

test('zoneCapacity：坏配置退回默认，不会变成无底洞', () => {
  assert.equal(zoneCapacity('short', cfg), cfg.shortCapacity);
  assert.equal(zoneCapacity('short', { shortCapacity: 12 }), 12);
  assert.equal(zoneCapacity('short', { shortCapacity: 0 }), cfg.shortCapacity);
  assert.equal(zoneCapacity('short', { shortCapacity: 'abc' }), cfg.shortCapacity);
  assert.equal(zoneCapacity('permanent', {}), cfg.permanentCapacity);
});

/* ─────────────────── 「压缩后剔除」：遗忘不能是空白 ─────────────────── */

test('harvest 把被淘汰的条目交到 dropped 里，而不是直接扔掉', () => {
  const dead = mk({ ts: NOW - 9 * DAY, weight: 0.05 });
  const alive = mk({ ts: NOW - 9 * DAY, weight: 0.9 });
  const out = harvest({ zones: { short: [dead, alive], long: [], permanent: [] }, cfg, now: NOW });

  assert.equal(out.dropped.short.length, 1, '被淘汰的那条必须进 dropped');
  assert.equal(out.dropped.short[0].id, dead.id);
  assert.equal(out.zones.short.length, 0, '它不该留在 short 里');
  assert.equal(out.zones.long.length, 1, '高权重那条正常升级');
  // plan 里依然要能看见「遗忘」这件事
  assert.ok(out.plan.some((p) => p.to === 'drop'));
});

test('digestDropped：N 条遗忘 → 1 条模糊印象，时间戳保留最老那条', () => {
  const a = mk({ ts: NOW - 20 * DAY, weight: 0.05, title: '整理账目表' });
  const b = mk({ ts: NOW - 10 * DAY, weight: 0.08, title: '迁移 DSH' });
  const digest = digestDropped([a, b], cfg, NOW);

  assert.ok(digest, '两条就该生成一条印象');
  assert.equal(digest.ts, a.ts, '印象要落在最早那件事上');
  assert.ok(digest.depth >= 1, '印象要比原来更模糊');
  assert.ok(digest.detail.length >= 15, '印象不能是空的');
  assert.deepEqual(digest.mergedFrom.sort(), [a.id, b.id].sort());
});

test('digestDropped：权重夹在遗忘线和升级线之间 —— 不会立刻被再判死，也爬不回去', () => {
  const list = [mk({ ts: NOW - 20 * DAY, weight: 0.02 }), mk({ ts: NOW - 19 * DAY, weight: 0.03 })];
  const digest = digestDropped(list, cfg, NOW);
  assert.ok(digest.weight > cfg.forgetBelow, '低于遗忘线 = 下一轮又被判死，死循环');
  assert.ok(digest.weight < cfg.promoteShortToLong, '高于升级线 = 反而升进长期，等于没遗忘');
});

test('digestDropped：只有一条时不生成印象（一条不值得单独留印象）', () => {
  assert.equal(digestDropped([mk({ ts: NOW - 20 * DAY, weight: 0.01 })], cfg, NOW), null);
  assert.equal(digestDropped([], cfg, NOW), null);
  assert.equal(digestDropped(null, cfg, NOW), null);
});

test('digestDropped：长期区的印象按长期门槛夹，不会错用短期门槛', () => {
  const list = [
    mk({ ts: NOW - 60 * DAY, weight: 0.02, zone: 'long' }),
    mk({ ts: NOW - 59 * DAY, weight: 0.02, zone: 'long' }),
  ];
  const digest = digestDropped(list, cfg, NOW);
  assert.equal(digest.zone, 'long');
  assert.ok(digest.weight < cfg.promoteLongToPermanent);
});
