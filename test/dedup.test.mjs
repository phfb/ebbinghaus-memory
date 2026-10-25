/**
 * 记忆库自检（去重）的测试。
 *
 * 重点不在「函数跑通了」，而在四件容易出事的事：
 *  1. **跨分区合并**后落在最深的那个区（永久 > 长期 > 短期）；
 *  2. **不误合**：同一天的两件不同事、长度悬殊的包含关系、链式传递；
 *  3. **合并后逐字段的取舍**（ts 最老 / weight 最高 / detail 最长 / title 最短）；
 *  4. 坏数据不炸。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEDUP_THRESHOLD_DEFAULT,
  dedupEveryOf,
  dedupThresholdOf,
  findDuplicateGroups,
  mergeDuplicateGroup,
  similarity,
  tokenSetOf,
} from '../src/core/dedup.mjs';
import { resolveConfig } from '../src/core/config.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const cfg = resolveConfig({});

let seq = 0;
function mk(o = {}) {
  seq += 1;
  return {
    id: o.id ?? `em-test-${seq}`,
    ts: o.ts ?? NOW - DAY,
    iso: '2026-10-24T12:00:00+08:00',
    zone: o.zone ?? 'short',
    weight: o.weight ?? 0.5,
    title: o.title ?? `事件${seq}`,
    detail: o.detail ?? '这是一段细节',
    keywords: o.keywords ?? ['测试'],
    source: 'chat',
    depth: o.depth ?? 0,
    mergedFrom: [],
    session: '',
    touchedAt: 0,
    createdAt: 0,
  };
}

/* ───────────────────────── 阈值 / 间隔 ───────────────────────── */

test('dedupThresholdOf：默认 0.5，坏值退默认，越界钳制', () => {
  assert.equal(dedupThresholdOf({}), DEDUP_THRESHOLD_DEFAULT);
  assert.equal(dedupThresholdOf({ dedupThreshold: 0.7 }), 0.7);
  assert.equal(dedupThresholdOf({ dedupThreshold: 5 }), 0.95);
  assert.equal(dedupThresholdOf({ dedupThreshold: 0.01 }), 0.3);
  assert.equal(dedupThresholdOf({ dedupThreshold: 'abc' }), DEDUP_THRESHOLD_DEFAULT);
});

test('dedupEveryOf：默认 30，区间 5-100（用户定的）', () => {
  assert.equal(dedupEveryOf({}), 30);
  assert.equal(dedupEveryOf({ dedupEveryEntries: 12 }), 12);
  assert.equal(dedupEveryOf({ dedupEveryEntries: 1 }), 5);
  assert.equal(dedupEveryOf({ dedupEveryEntries: 500 }), 100);
  assert.equal(dedupEveryOf({ dedupEveryEntries: 'x' }), 30);
});

/* ───────────────────────── 相似度 ───────────────────────── */

test('tokenSetOf：标题重复加权（标题是「这件事是什么」的概括）', () => {
  const a = mk({ title: '林小满是四川人', detail: '' });
  const set = tokenSetOf(a);
  assert.ok(set.size >= 4);
  assert.ok(set.has('林小'), '中文 2-gram');
});

test('similarity：短的那条被长的那条包住 = 高相似（重叠系数，不是余弦）', () => {
  const a = tokenSetOf(mk({ title: '林小满：四川人，在杭州工作', detail: '对方是林小满，四川人，在杭州工作。' }));
  const b = tokenSetOf(
    mk({
      title: '林小满：四川人，在杭州工作',
      detail: '对方是林小满，四川人，在杭州工作。之前合作过，能认出彼此；对方赶进度时会连轴转。',
    }),
  );
  const idf = new Map();
  const sim = similarity(a, b, idf);
  assert.ok(sim > 0.7, `同一件事的两种写法应当高度相似，实际 ${sim}`);
});

test('similarity：不相干的两条要接近 0', () => {
  const a = tokenSetOf(mk({ title: '在改水下机器人模型', detail: 'CAD 里改推进器位置。' }));
  const b = tokenSetOf(mk({ title: '线性代数作业交了', detail: '第三章习题有八道。' }));
  const sim = similarity(a, b, new Map());
  assert.ok(sim < 0.2, `不相干的应当很低，实际 ${sim}`);
});

/* ───────────────────────── 找重复组 ───────────────────────── */

test('findDuplicateGroups：同一件事的两种写法 → 一组', () => {
  const zones = {
    short: [
      mk({
        id: 'a',
        title: '不在群里说他的薪资',
        detail: '他明确要求：这件事不要在公司群里提，只有私下聊的时候才可以讲。',
        keywords: ['薪资', '公司群', '雷区'],
      }),
      mk({
        id: 'b',
        title: '不在群里提他的薪资',
        detail: '他明确要求：这件事不要在公司群里提，只有私下聊的时候才可以讲。',
        keywords: ['薪资', '公司群', '禁忌'],
      }),
    ],
    long: [],
    permanent: [],
  };
  const { groups } = findDuplicateGroups(zones, cfg);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
  assert.deepEqual(groups[0].entries.map((e) => e.id).sort(), ['a', 'b']);
});

test('findDuplicateGroups：跨分区的重复，合并后落在最深的区', () => {
  const body = '对方明确要求不在公司群里提他的薪资，答应只在私下聊的时候才讲。';
  const zones = {
    short: [mk({ id: 's', zone: 'short', title: '约定不在群里提他的薪资', detail: body })],
    long: [mk({ id: 'l', zone: 'long', title: '约定不在群里提他的薪资额', detail: body })],
    permanent: [mk({ id: 'p', zone: 'permanent', title: '约定不在群里提他的薪资啊', detail: body })],
  };
  const { groups } = findDuplicateGroups(zones, cfg);
  assert.ok(groups.length >= 1);
  assert.equal(groups[0].zone, 'permanent', '永久 > 长期 > 短期');
  assert.equal(groups[0].entries.length, 3);
});

test('findDuplicateGroups：同一天的两件不同事不该被合', () => {
  const zones = {
    short: [
      mk({ id: 'x', title: '白天搬了一整天货架', detail: '下午搬了一整天的东西，晚上吃火锅。' }),
      mk({ id: 'y', title: '在改推进器布局', detail: 'CAD 里把四个水平推进器往外挪了两厘米。' }),
    ],
    long: [],
    permanent: [],
  };
  const { groups } = findDuplicateGroups(zones, cfg);
  assert.equal(groups.length, 0);
});

test('findDuplicateGroups：长度差 4 倍以上算「包含」，不是重复', () => {
  const longDetail = '这条档案里说了很多很多与此相关的内容，'.repeat(20);
  const zones = {
    short: [
      mk({ id: 'short1', title: '推进器', detail: '推进器往外挪。' }),
      mk({ id: 'long1', zone: 'permanent', title: '推进器', detail: longDetail }),
    ],
    long: [],
    permanent: [],
  };
  const { groups } = findDuplicateGroups(zones, cfg);
  assert.equal(groups.length, 0, '一条 800 字档案不该把短记忆吞掉');
});

test('findDuplicateGroups：token 太少的条目不参与（三个字跟谁都能像）', () => {
  const zones = {
    short: [
      mk({ id: 'tiny1', title: '好的', detail: '嗯', keywords: [] }),
      mk({ id: 'tiny2', title: '好的', detail: '嗯', keywords: [] }),
    ],
    long: [],
    permanent: [],
  };
  const { groups, checked } = findDuplicateGroups(zones, cfg);
  assert.equal(groups.length, 0);
  assert.equal(checked, 0, '两条都不够 token 门槛');
});

test('findDuplicateGroups：complete-linkage 挡住链式误合', () => {
  // A 和 B 很像、B 和 C 很像，但 A 和 C 不像 —— 不能因此把三条揉一起
  const a = mk({ id: 'A', title: '苹果 香蕉 橙子 葡萄 西瓜', detail: '水果清单里有苹果香蕉橙子葡萄西瓜。' });
  const b = mk({ id: 'B', title: '苹果 香蕉 橙子 葡萄 西瓜', detail: '水果清单里有苹果香蕉橙子葡萄西瓜。' });
  const c = mk({ id: 'C', title: '白菜 萝卜 土豆 茄子 青椒', detail: '蔬菜清单里有白菜萝卜土豆茄子青椒。' });
  const zones = { short: [a, b, c], long: [], permanent: [] };
  const { groups } = findDuplicateGroups(zones, cfg);
  assert.equal(groups.length, 1, '只有 A+B 该成组');
  assert.equal(groups[0].entries.length, 2);
  assert.ok(!groups[0].entries.some((e) => e.id === 'C'));
});

test('findDuplicateGroups：坏数据不炸', () => {
  assert.deepEqual(findDuplicateGroups({}, cfg).groups, []);
  assert.deepEqual(findDuplicateGroups(null, cfg).groups, []);
  const zones = { short: [null, { title: '没 id' }, mk({ id: 'ok' })], long: [], permanent: [] };
  assert.deepEqual(findDuplicateGroups(zones, cfg).groups, []);
});

/* ───────────────────────── 合并 ───────────────────────── */

test('mergeDuplicateGroup：ts 最老 / weight 最高 / detail 最长 / title 最短', () => {
  const older = mk({
    id: 'old',
    ts: NOW - 5 * DAY,
    weight: 0.4,
    title: '林小满：四川人，在杭州工作',
    detail: '对方是林小满，四川人，在杭州工作。',
    keywords: ['林小满', '四川'],
    depth: 0,
  });
  const newer = mk({
    id: 'new',
    ts: NOW - 1 * DAY,
    weight: 0.9,
    title: '林小满是四川人，在杭州工作这件事',
    detail: '对方是林小满，四川人，在杭州工作。之前合作过，能认出彼此；赶进度时会连轴转。',
    keywords: ['杭州', '旧识'],
    depth: 2,
  });
  const merged = mergeDuplicateGroup([newer, older], { now: NOW, zone: 'permanent' });
  assert.ok(merged);
  assert.equal(merged.ts, NOW - 5 * DAY, '时间戳取最老');
  assert.equal(merged.weight, 0.9, '权重取最高 —— 反复出现本身就是重要性的证据');
  assert.match(merged.detail, /之前合作过/, 'detail 取最长的那条，不丢信息');
  assert.equal(merged.title, '林小满：四川人，在杭州工作', 'title 取最短的');
  assert.deepEqual([...merged.keywords].sort(), ['林小满', '四川', '杭州', '旧识'].sort(), 'keywords 取并集');
  assert.equal(merged.zone, 'permanent');
  assert.equal(merged.source, 'merge');
  assert.equal(merged.depth, 2, 'depth 取最大');
  assert.deepEqual(merged.mergedFrom.sort(), ['new', 'old']);
  assert.ok(typeof merged.id === 'string' && merged.id.startsWith('em-'));
});

test('mergeDuplicateGroup：不给 zone 时自动取组内最深', () => {
  const s = mk({ id: 's1', zone: 'short', title: '同一件事的一句话说法', detail: '一样的细节内容在这里。' });
  const l = mk({ id: 'l1', zone: 'long', title: '同一件事的另一种说法', detail: '一样的细节内容在这里。' });
  const merged = mergeDuplicateGroup([s, l], { now: NOW });
  assert.equal(merged.zone, 'long');
});

test('mergeDuplicateGroup：少于两条返回 null', () => {
  assert.equal(mergeDuplicateGroup([], { now: NOW }), null);
  assert.equal(mergeDuplicateGroup([mk()], { now: NOW }), null);
});

test('mergeDuplicateGroup：新 id 不与现有 id 冲突', () => {
  const a = mk({ id: 'x1', title: '重复的内容甲', detail: '同一段话。' });
  const b = mk({ id: 'x2', title: '重复的内容乙', detail: '同一段话。' });
  const merged = mergeDuplicateGroup([a, b], { now: NOW, zone: 'short' });
  assert.ok(!['x1', 'x2'].includes(merged.id));
});
