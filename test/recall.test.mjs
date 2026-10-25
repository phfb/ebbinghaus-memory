/**
 * 检索的测试。
 *
 * 两条东西必须钉死：
 *   1. 命中阈值真的能挡住「只在 detail 里偶然撞到一个词」的噪音；
 *   2. 返回的永远只是命中的那几条 —— 不是整区。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEntry } from '../src/core/schema.mjs';
import { resolveConfig } from '../src/core/config.mjs';
import { autoRecall, pickFromCandidates, scoreEntry, search, tokenize } from '../src/core/recall.mjs';

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const cfg = resolveConfig({});

let seq = 0;
function mk(o = {}) {
  seq += 1;
  const e = normalizeEntry(
    {
      ts: o.ts ?? NOW - seq * 3600000,
      weight: o.weight ?? 0.5,
      title: o.title ?? `事件${seq}`,
      detail: o.detail ?? `细节${seq}`,
      keywords: o.keywords ?? ['测试'],
      createdAt: NOW,
      // source 要能传进来：「不捞 seed」那条测试全靠它
      ...(o.source === undefined ? {} : { source: o.source }),
    },
    { zone: o.zone ?? 'short', now: NOW },
  );
  assert.notEqual(e, null);
  return e;
}

test('tokenize：中文 2-gram + 英文按词 + 去停用词 + 去重', () => {
  const t = tokenize('记忆插件 DSH memory');
  assert.ok(t.includes('记忆'));
  assert.ok(t.includes('忆插'));
  assert.ok(t.includes('插件'));
  assert.ok(t.includes('dsh'));
  assert.ok(t.includes('memory'));
  // 含单字停用词的 gram 被丢掉
  assert.ok(!t.includes('的记'));
  assert.equal(new Set(t).size, t.length, 'token 必须去重');

  const stopOnly = tokenize('我的 你的 他的');
  assert.deepEqual(stopOnly, []);

  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize：C++ / 数字这类带符号的词不被切碎', () => {
  const t = tokenize('Arduino C++ ESP32');
  assert.ok(t.includes('arduino'));
  assert.ok(t.includes('c++'));
  assert.ok(t.includes('esp32'));
});

test('scoreEntry：keywords ×3、title ×2、detail ×1，再乘 (0.5 + weight)', () => {
  const e = mk({
    weight: 0.5,
    title: '他在做记忆插件',
    detail: '要求三分区、可调周期',
    keywords: ['记忆插件', '分区'],
  });

  // keywords 命中 3 分 + title 命中 2 分 = 5，乘 (0.5+0.5) = 1 → 5
  assert.equal(scoreEntry(e, ['记忆']), 5);
  // 只命中 detail：'可调' 不在 keywords/title 里 → 1 分 × 1 = 1
  assert.equal(scoreEntry(e, ['可调']), 1);
  // 完全没命中
  assert.equal(scoreEntry(e, ['量子力学']), 0);
  assert.equal(scoreEntry(e, []), 0);
  assert.equal(scoreEntry(null, ['记忆']), 0);
});

test('scoreEntry：weight 越高越容易被想起来（乘子生效）', () => {
  // title/detail 都不含目标词，只剩 keywords 的 3 分，方便看乘子
  const low = mk({ weight: 0.1, title: '别的东西', detail: 'x', keywords: ['话题'] });
  const high = { ...low, weight: 0.9 };
  const a = scoreEntry(low, ['话题']);
  const b = scoreEntry(high, ['话题']);
  assert.ok(b > a, `weight 没起作用：${a} vs ${b}`);
  assert.ok(Math.abs(a - 3 * 0.6) < 1e-9, `低权重得分不对：${a}`);
  assert.ok(Math.abs(b - 3 * 1.4) < 1e-9, `高权重得分不对：${b}`);
});

test('search：keywords 命中能过阈值，只有 detail 撞词过不了（默认 threshold=2）', () => {
  const byKeyword = mk({ title: '记忆插件', detail: '无关', keywords: ['记忆插件'], zone: 'short' });
  const byDetailOnly = mk({ title: '无关标题', detail: '这里碰巧写了记忆两个字', keywords: ['无关'], zone: 'short' });

  const zones = { short: [byKeyword, byDetailOnly], long: [], permanent: [] };
  const hits = search(zones, '记忆', { top: 5, threshold: cfg.recallThreshold });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, byKeyword.id);
});

test('search：threshold 调低就能收进 detail 撞词的条目', () => {
  const byDetailOnly = mk({ title: '无关标题', detail: '这里碰巧写了记忆两个字', keywords: ['无关'] });
  const zones = { short: [byDetailOnly], long: [], permanent: [] };
  const hits = search(zones, '记忆', { top: 5, threshold: 0.5 });
  assert.equal(hits.length, 1);
});

test('search：完全不命中返回空数组', () => {
  const zones = { short: [mk({ title: '做菜', keywords: ['菜谱'] })], long: [], permanent: [] };
  assert.deepEqual(search(zones, '量子力学与黑洞', { top: 5, threshold: 2 }), []);
  assert.deepEqual(search(zones, '', { top: 5, threshold: 2 }), []);
  assert.deepEqual(search({}, '记忆', { top: 5, threshold: 2 }), []);
});

test('search：只返回 top 条，不是整个区', () => {
  const list = Array.from({ length: 20 }, () => mk({ title: '记忆插件', keywords: ['记忆插件'] }));
  const hits = search({ short: list, long: [], permanent: [] }, '记忆插件', { top: 3, threshold: 2 });
  assert.equal(hits.length, 3);
});

test('search：同分时 永久 > 长期 > 短期', () => {
  const s = mk({ zone: 'short', title: '分区记忆', detail: 'x', keywords: ['分区'], weight: 0.6 });
  const l = mk({ zone: 'long', title: '分区记忆', detail: 'x', keywords: ['分区'], weight: 0.6 });
  const p = mk({ zone: 'permanent', title: '分区记忆', detail: 'x', keywords: ['分区'], weight: 0.6 });

  const hits = search({ short: [s], long: [l], permanent: [p] }, '分区', { top: 3, threshold: 2 });
  assert.deepEqual(
    hits.map((e) => e.zone),
    ['permanent', 'long', 'short'],
  );

  // 反过来灌进去也一样（排序不能依赖输入顺序）
  const hits2 = search({ short: [s], long: [l], permanent: [p] }, '分区', { top: 2, threshold: 2 });
  assert.equal(hits2.length, 2);
  assert.equal(hits2[0].zone, 'permanent');
});

test('autoRecall：太短的话不检索', () => {
  const zones = { short: [], long: [mk({ zone: 'long', title: '记忆插件', keywords: ['记忆插件'] })], permanent: [] };
  assert.deepEqual(autoRecall(zones, '', cfg), []);
  assert.deepEqual(autoRecall(zones, '   ', cfg), []);
  assert.deepEqual(autoRecall(zones, '记忆', cfg), []);
});

test('autoRecall：短期区照样参与检索（预算裁掉的那几条不然就成死角了）', () => {
  // 曾经的写法是「不查短期」，理由是「短期本来就整批进注入」。
  // 落地不成立：短期 18 条、预算只装得下 8 条，剩下的既没进注入、又检索不到。
  const shortOne = mk({ zone: 'short', title: '记忆插件', keywords: ['记忆插件'] });
  const zones = { short: [shortOne], long: [], permanent: [] };
  const hits = autoRecall(zones, '记忆插件怎么做的', cfg);
  assert.equal(hits.length, 1, '短期条目必须能被检索捞到');
  assert.equal(hits[0].id, shortOne.id);
});

test('autoRecall：重复由渲染层去重，这里不做切分', () => {
  // autoRecall 返回的可能和「短期整批注入」重叠，那是 renderInjection 的
  // shownIds 负责的事。这里只验证「它会返回」，不验证「它避开注入窗口」。
  const recent = mk({ zone: 'short', ts: Date.now() - 1000, title: '记忆插件', keywords: ['记忆插件'] });
  const zones = { short: [recent], long: [], permanent: [] };
  assert.equal(autoRecall(zones, '记忆插件怎么做的', cfg).length, 1);
});

test('autoRecall：不捞 seed（迁移进来的人格档案）—— 实测误报就出在这里', () => {
  // 真实踩到：档案 detail 两千多字，2-gram 覆盖率高到「今天天气怎么样」都会命中
  // 「环境·主目录长什么样」，「Python 的 asyncio 怎么用」会命中「档案·干活习惯」。
  const seed = mk({
    zone: 'permanent',
    source: 'seed',
    title: '档案·干活习惯',
    keywords: ['Python', '脚本', '习惯'],
    detail: 'Python'.repeat(400),
    weight: 0.9,
  });
  const zones = { short: [], long: [], permanent: [seed] };
  assert.deepEqual(autoRecall(zones, 'Python 的 asyncio 怎么用', cfg), []);
});

test('autoRecall：但 search() 仍然能查到 seed —— 主动查的时候全库都要能查到', () => {
  const seed = mk({
    zone: 'permanent',
    source: 'seed',
    title: '档案·干活习惯',
    keywords: ['Python', '脚本'],
    weight: 0.9,
  });
  const zones = { short: [], long: [], permanent: [seed] };
  const hits = search(zones, 'Python', { top: 3, threshold: 2 });
  assert.equal(hits.length, 1, 'AI 主动调 memory_search 时不该被 seed 过滤挡住');
});

/* ───────── 命中多条时，让他挑，再只读那一条 ───────── */

const cand = () => [
  mk({ zone: 'short', ts: new Date(2026, 9, 22, 4, 48).getTime(), title: '桌宠第一次做', keywords: ['桌宠'] }),
  mk({ zone: 'short', ts: new Date(2026, 9, 18, 21, 30).getTime(), title: '桌宠改外形', keywords: ['外形'] }),
  mk({ zone: 'short', ts: new Date(2026, 9, 5, 14, 0).getTime(), title: '桌面小工具试过 Electron', keywords: ['electron'] }),
];

test('pickFromCandidates：序号优先（「第二个」「第 2 个」「2」）', () => {
  const list = cand();
  assert.equal(pickFromCandidates(list, '第二个').id, list[1].id);
  assert.equal(pickFromCandidates(list, '第 2 个吧').id, list[1].id);
  assert.equal(pickFromCandidates(list, '3').id, list[2].id);
  assert.equal(pickFromCandidates(list, '第一个').id, list[0].id);
  // 越界不选
  assert.equal(pickFromCandidates(list, '第九个'), null);
});

test('pickFromCandidates：日期（「10-22」「10月22」「22 号」）', () => {
  const list = cand();
  assert.equal(pickFromCandidates(list, '10-22 那天的').id, list[0].id);
  assert.equal(pickFromCandidates(list, '10月18号').id, list[1].id);
  assert.equal(pickFromCandidates(list, '22 号那个').id, list[0].id);
  assert.equal(pickFromCandidates(list, '5 日那个').id, list[2].id);
});

test('pickFromCandidates：关键词（他复述标题/关键词）', () => {
  const list = cand();
  assert.equal(pickFromCandidates(list, '就是改外形那个').id, list[1].id);
  assert.equal(pickFromCandidates(list, 'Electron 那个').id, list[2].id);
});

test('pickFromCandidates：什么都不沾就不选（宁可不选，也不猜）', () => {
  const list = cand();
  assert.equal(pickFromCandidates(list, '算了不用了'), null);
  assert.equal(pickFromCandidates(list, ''), null);
  assert.equal(pickFromCandidates([], '第二个'), null);
  assert.equal(pickFromCandidates(null, '第二个'), null);
});

test('autoRecall：只在 detail 里撞词不返回（必须锚定 title/keywords）', () => {
  const e = mk({
    zone: 'long',
    title: '无关标题',
    detail: '这里碰巧写了记忆插件两个字而且重复很多次记忆插件记忆插件',
    keywords: ['无关'],
    weight: 0.9,
  });
  const zones = { short: [], long: [e], permanent: [] };
  assert.deepEqual(autoRecall(zones, '记忆插件', cfg), []);
});

test('autoRecall：锚定命中时返回少量，且不超过 recallTop', () => {
  const list = Array.from({ length: 8 }, () =>
    mk({ zone: 'long', title: '记忆插件', detail: 'x', keywords: ['记忆插件'], weight: 0.8 }),
  );
  const zones = { short: [], long: list, permanent: [] };
  const hits = autoRecall(zones, '记忆插件怎么做', cfg);
  assert.equal(hits.length, Math.min(cfg.recallTop, list.length));
  assert.ok(hits.length <= cfg.recallTop);
  assert.ok(hits.length < list.length, '不许把整区倒出来');
});

test('autoRecall：cfg.recallTop = 0 时直接不返回', () => {
  const list = [mk({ zone: 'long', title: '记忆插件', keywords: ['记忆插件'], weight: 0.8 })];
  assert.deepEqual(autoRecall({ short: [], long: list, permanent: [] }, '记忆插件', { ...cfg, recallTop: 0 }), []);
});
