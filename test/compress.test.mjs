/**
 * 压缩的测试。
 *
 * 这个文件里最重要的三条断言：
 *   - 合并后 ts 必须是**最老那条**的（不是 now，也不是最新的）；
 *   - depth 必须 +1；
 *   - detail 永远不空（哪怕模型返回空字符串、哪怕源数据全是空白）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEntry } from '../src/core/schema.mjs';
import {
  compressWithModel,
  fallbackMerge,
  pickCompressGroup,
  truncateDetail,
} from '../src/core/compress.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();

let seq = 0;
function mk(o = {}) {
  seq += 1;
  const ts = o.ts ?? NOW;
  const e = normalizeEntry(
    {
      ts,
      weight: o.weight ?? 0.5,
      title: o.title ?? `事件${seq}`,
      detail: o.detail ?? `${'细节内容'.repeat(20)}。补充说明${seq}。`,
      keywords: o.keywords ?? ['测试', '压缩'],
      depth: o.depth ?? 0,
      createdAt: NOW,
    },
    { zone: o.zone ?? 'short', now: NOW },
  );
  assert.notEqual(e, null);
  return e;
}

test('pickCompressGroup：超容时按 ts 升序取最老的 k 条', () => {
  const cfg = { shortCapacity: 5 };
  // 故意乱序：最老的三条 ts 是 NOW-9d / -8d / -7d
  const mixed = [
    mk({ ts: NOW - 1 * DAY, title: '最新' }),
    mk({ ts: NOW - 9 * DAY, title: '最老' }),
    mk({ ts: NOW - 3 * DAY, title: '较新' }),
    mk({ ts: NOW - 7 * DAY, title: '第三老' }),
    mk({ ts: NOW - 5 * DAY, title: '中间' }),
    mk({ ts: NOW - 8 * DAY, title: '第二老' }),
    mk({ ts: NOW - 2 * DAY, title: '新' }),
    mk({ ts: NOW - 4 * DAY, title: '偏新' }),
  ]; // 8 条，上限 5 → 要挪走 3 条

  const group = pickCompressGroup('short', mixed, cfg);
  assert.equal(group.length, 3);
  assert.deepEqual(
    group.map((e) => e.title),
    ['最老', '第二老', '第三老'],
  );
  // 升序
  for (let i = 1; i < group.length; i += 1) {
    assert.ok(group[i].ts > group[i - 1].ts, '返回的组必须按 ts 升序');
  }
});

test('pickCompressGroup：没超容就返回空数组（不许无端压掉一条）', () => {
  const cfg = { shortCapacity: 5 };
  const list = Array.from({ length: 5 }, () => mk());
  assert.deepEqual(pickCompressGroup('short', list, cfg), []);
  assert.deepEqual(pickCompressGroup('short', [], cfg), []);
});

test('fallbackMerge：ts 取最老、depth=max+1、source=merge、keywords 并集', () => {
  const e1 = mk({ ts: NOW - 12 * DAY, weight: 0.9, title: '老的一条', keywords: ['甲', '乙'], depth: 1 });
  const e2 = mk({ ts: NOW - 5 * DAY, weight: 0.3, title: '中间的一条', keywords: ['乙', '丙'], depth: 2 });
  const e3 = mk({ ts: NOW - 1 * DAY, weight: 0.6, title: '新的一条', keywords: ['丁'], depth: 0 });

  const merged = fallbackMerge([e3, e1, e2], { now: NOW });

  assert.equal(merged.ts, e1.ts, '必须保留最老那条的 ts');
  assert.equal(merged.depth, 3, 'depth = max(depth)+1');
  assert.equal(merged.source, 'merge');
  assert.equal(merged.zone, 'short');
  assert.equal(merged.weight, Math.round(clampWeight((0.9 + 0.3 + 0.6) / 3) * 100) / 100);
  assert.match(merged.title, /老的一条/);
  assert.match(merged.title, /合并 3 条/);
  assert.deepEqual(
    [...merged.keywords].sort(),
    ['丁', '丙', '乙', '甲'].sort(),
  );
  assert.equal(merged.mergedFrom.length, 3);
  assert.ok(merged.mergedFrom.includes(e1.id));
});

function clampWeight(n) {
  return Math.min(1, Math.max(0, n));
}

test('fallbackMerge：detail 不空、且不短于 40 字，并且按 depth 截断', () => {
  const long = '第一句话的内容写得挺长的把细节都写清楚了然后收尾。第二句不该被保留下来。';
  const e1 = mk({ ts: NOW - 30 * DAY, detail: long, title: '甲事件' });
  const e2 = mk({ ts: NOW - 20 * DAY, detail: long.replace('第一句', '另一句'), title: '乙事件' });
  const e3 = mk({ ts: NOW - 10 * DAY, detail: long.replace('第一句', '第三句'), title: '丙事件' });

  const merged = fallbackMerge([e1, e2, e3], { now: NOW });

  assert.ok(merged.detail.length >= 40, `detail 短于 40 字：${merged.detail.length}`);
  assert.ok(merged.detail.length < 200, 'detail 应该被 depth 截短');
  assert.ok(!merged.detail.includes('第二句'), '只保留首句');
  assert.ok(merged.detail.includes('；'), '多条 detail 用「；」连起来');
});

test('fallbackMerge：源数据全是空白，也绝不返回空 detail / 空条目', () => {
  // 手工把 title/detail 清空，模拟读到了坏数据（normalizeEntry 自己会拒绝这种输入）
  const blank = mk({ detail: '占位', title: '占位标题' });
  const broken = { ...blank, title: '', detail: '' };
  const alsoBroken = { ...blank, title: '   ', detail: '\n\t ' };
  const merged = fallbackMerge([broken, alsoBroken], { now: NOW });

  assert.notEqual(merged, null);
  assert.equal(typeof merged.detail, 'string');
  assert.ok(merged.detail.trim() !== '', 'detail 被压成空了');
  assert.ok(merged.detail.length >= 40);
  assert.ok(merged.title.trim() !== '');
});

test('fallbackMerge：空数组也能出一个条目（永远有产出）', () => {
  const merged = fallbackMerge([], { now: NOW });
  assert.notEqual(merged, null);
  assert.ok(merged.detail.length >= 40);
  assert.equal(merged.source, 'merge');
});

test('truncateDetail：尽量切在句末标点，不越过上限', () => {
  const text = '甲'.repeat(60) + '。' + '乙'.repeat(60) + '。';
  const out = truncateDetail(text, 70);
  assert.ok(out.length <= 70);
  assert.ok(out.endsWith('。'), `应该切在句号上：${out.slice(-5)}`);

  const short = truncateDetail('很短', 100);
  assert.equal(short, '很短');
});

test('compressWithModel：成功路径（异步流 + text-delta）', async () => {
  const e1 = mk({ ts: NOW - 20 * DAY, depth: 0 });
  const e2 = mk({ ts: NOW - 15 * DAY, depth: 1 });
  const payload = JSON.stringify({
    title: '压缩后的记忆',
    detail: `这是模型压出来的一条更模糊的记忆，${'内容'.repeat(30)}。`,
    keywords: ['压缩', '记忆'],
  });

  /** @type {any[]} */
  const seen = [];
  const stream = async function* (req) {
    seen.push(req);
    yield { type: 'reasoning-delta', text: '想一下' }; // 不该被收进正文
    const mid = Math.floor(payload.length / 2);
    yield { type: 'text-delta', text: payload.slice(0, mid) };
    yield { type: 'text-delta', text: payload.slice(mid) };
  };

  const out = await compressWithModel([e1, e2], {
    stream,
    provider: 'p',
    model: 'm',
    maxTokens: 300,
    zone: 'long',
    now: NOW,
  });

  assert.notEqual(out, null);
  assert.equal(out.ts, e1.ts, '模型不许改时间戳');
  assert.equal(out.depth, 2);
  assert.equal(out.source, 'merge');
  assert.equal(out.zone, 'long');
  assert.equal(out.title, '压缩后的记忆');
  assert.equal(out.mergedFrom.length, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].maxTokens, 300);
  assert.equal(seen[0].reasoningEffort, 'off');
});

test('compressWithModel：模型返回带围栏的 JSON 也能解析', async () => {
  const e1 = mk({ ts: NOW - 3 * DAY });
  const body = '```json\n' + JSON.stringify({
    title: '带围栏的标题',
    detail: `${'甲'.repeat(60)}。`,
    keywords: ['围栏'],
  }) + '\n```';
  const out = await compressWithModel([e1], { stream: async () => body, now: NOW });
  assert.notEqual(out, null);
  assert.equal(out.title, '带围栏的标题');
});

test('compressWithModel：模型返回数组时取第一条', async () => {
  const e1 = mk({ ts: NOW - 3 * DAY });
  const body = JSON.stringify([
    { title: '第一条', detail: `${'乙'.repeat(60)}。`, keywords: ['数组'] },
    { title: '第二条', detail: `${'丙'.repeat(60)}。` },
  ]);
  const out = await compressWithModel([e1], { stream: async () => body, now: NOW });
  assert.equal(out.title, '第一条');
});

test('compressWithModel：失败一律返回 null（由调用方退回 fallbackMerge）', async () => {
  const e1 = mk({ ts: NOW - 3 * DAY });

  assert.equal(await compressWithModel([e1], { stream: async () => { throw new Error('boom'); } }), null);
  assert.equal(await compressWithModel([e1], { stream: async () => '完全不是 JSON' }), null);
  assert.equal(await compressWithModel([e1], { stream: async () => '' }), null);
  assert.equal(await compressWithModel([e1], { stream: null }), null);
  assert.equal(await compressWithModel([], { stream: async () => '{}' }), null);
  // abort 也走同一路：不写半成品
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(
    await compressWithModel([e1], {
      stream: async () => { throw new Error('aborted'); },
      signal: ctrl.signal,
    }),
    null,
  );
});

test('compressWithModel：模型把 detail 压成空 → 退回本地拼接的 detail', async () => {
  const e1 = mk({ ts: NOW - 8 * DAY, detail: `${'源细节'.repeat(20)}。` });
  const body = JSON.stringify({ title: '空 detail', detail: '', keywords: ['空'] });
  const out = await compressWithModel([e1], { stream: async () => body, now: NOW });

  assert.notEqual(out, null);
  assert.ok(out.detail.trim() !== '');
  assert.ok(out.detail.length >= 40, `兜底 detail 太短：${out.detail.length}`);
});

test('compressWithModel：depth 封顶在 9', async () => {
  const e1 = mk({ ts: NOW - 3 * DAY, depth: 9 });
  const body = JSON.stringify({ title: '顶格', detail: `${'丁'.repeat(60)}。` });
  const out = await compressWithModel([e1], { stream: async () => body, now: NOW });
  assert.equal(out.depth, 9);
});

test('compressWithModel 同样不改入参', async () => {
  const e1 = mk({ ts: NOW - 3 * DAY, depth: 0 });
  const before = JSON.stringify(e1);
  await compressWithModel([e1], {
    stream: async () => JSON.stringify({ title: 'x', detail: `${'戊'.repeat(60)}。` }),
    now: NOW,
  });
  assert.equal(JSON.stringify(e1), before);
});
