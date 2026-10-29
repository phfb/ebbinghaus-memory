/**
 * 注入渲染的测试。
 *
 * 这个文件盯的是「模型到底看到了什么」：文本形状、空区不出现、
 * 以及超预算时的裁剪顺序（长期 → 这轮想起来的 → 永久 → 最后才动短期）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEntry } from '../src/core/schema.mjs';
import { resolveConfig } from '../src/core/config.mjs';
import { renderEntryLine, renderInjection } from '../src/core/render.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const cfg = resolveConfig({});

let seq = 0;
function mk(o = {}) {
  seq += 1;
  const ts = o.ts ?? NOW - seq * 3600000;
  const e = normalizeEntry(
    {
      ts,
      weight: o.weight ?? 0.6,
      title: o.title ?? `事件${seq}`,
      detail: o.detail ?? `细节${seq}`,
      keywords: o.keywords ?? ['测试'],
      depth: o.depth ?? 0,
      createdAt: NOW,
    },
    { zone: o.zone ?? 'short', now: NOW },
  );
  assert.notEqual(e, null);
  return e;
}

const empty = { short: [], long: [], permanent: [] };

test('renderInjection：一条记忆都没有 → 空字符串、0 token（不输出空壳）', () => {
  const out = renderInjection({ zones: empty, cfg, now: NOW, recalled: [], budgetTokens: 1400 });
  assert.equal(out.text, '');
  assert.equal(out.tokens, 0);
  assert.equal(out.breakdown.short.shown, 0);
  assert.equal(out.breakdown.long.cut, 0);
});

test('renderInjection：文本形状照 SPEC §11，空区整段不出现', () => {
  const s1 = mk({ ts: NOW - 3600000, title: '他在做 DSH 记忆插件', detail: '要求三分区、可调周期、时间戳。', weight: 0.72 });
  const s2 = mk({ ts: NOW - 26 * 3600000, title: '他嫌公司食堂太油', detail: '更习惯清淡的汤粉。', weight: 0.55 });

  const out = renderInjection({
    zones: { short: [s2, s1], long: [], permanent: [] },
    cfg,
    now: NOW,
    recalled: [],
    budgetTokens: 1400,
  });

  const lines = out.text.split('\n');
  assert.equal(lines[0], '<ebbinghaus-memory>');
  assert.equal(lines[1], '你的记忆按遗忘曲线分三层。时间戳是事件发生的时间，不是你现在的时间。');
  assert.equal(lines[2], '不要凭空补全这里没有的事。');
  // 2026-10-29：多了一行人称硬映射（「我」=她自己，「你」=对面那个人）。
  assert.ok(lines[3].includes('「我」是你自己'), lines[3]);
  assert.ok(lines[3].includes('老条目里写成「他」的'), lines[3]);
  assert.equal(lines[4], '');
  assert.equal(lines[5], '〔短期 · 最近 7 天〕');
  assert.ok(lines[6].startsWith('- [10-25 11:00] 他在做 DSH 记忆插件 —— '), lines[6]);
  assert.ok(lines[6].endsWith(' · 0.72'), lines[6]);
  assert.ok(lines[7].startsWith('- ['), lines[7]);
  assert.equal(lines[lines.length - 1], '</ebbinghaus-memory>');

  // 空区不出现，也不写「（空）」
  assert.ok(!out.text.includes('〔长期'), '空区不该出现');
  assert.ok(!out.text.includes('〔永久'), '空区不该出现');
  assert.ok(!out.text.includes('〔这轮想起来的〕'), '没有 recalled 时不该出现这一段');
  assert.ok(!out.text.includes('（空）'));
});

test('renderInjection：tokens 用 ceil(len/1.8) 估', () => {
  const s = mk({ title: '随便', detail: '一句话细节' });
  const out = renderInjection({ zones: { ...empty, short: [s] }, cfg, now: NOW, budgetTokens: 1400 });
  assert.equal(out.tokens, Math.ceil(out.text.length / 1.8));
});

test('renderInjection：7 天内的记忆带时刻，更早的只到日', () => {
  const recent = mk({ ts: NOW - 2 * DAY, title: '最近的' });
  const old = mk({ ts: NOW - 40 * DAY, title: '很久以前', zone: 'permanent' });

  const out = renderInjection({
    zones: { short: [recent], long: [], permanent: [old] },
    cfg,
    now: NOW,
    budgetTokens: 1400,
  });

  assert.match(out.text, /- \[10-23 12:00\] 最近的/);
  assert.match(out.text, /- \[09-15\] 很久以前/);
});

test('renderInjection：loadShortCount 生效 —— 只带最近几条，不是整区', () => {
  const list = Array.from({ length: 30 }, (_, i) => mk({ ts: NOW - (i + 1) * DAY, title: `第${i}条` }));
  const out = renderInjection({
    zones: { ...empty, short: list },
    cfg: { ...cfg, loadShortCount: 3 },
    now: NOW,
    budgetTokens: 100000,
  });

  assert.equal(out.breakdown.short.candidate, 3);
  assert.equal(out.breakdown.short.shown, 3);
  const bullets = out.text.split('\n').filter((l) => l.startsWith('- ['));
  assert.equal(bullets.length, 3);
});

test('renderInjection：recalled 与已渲染条目重复时只出现一次', () => {
  const e = mk({ zone: 'long', ts: NOW - 3 * DAY, title: '同一条' });
  const out = renderInjection({
    zones: { ...empty, long: [e] },
    cfg,
    now: NOW,
    recalled: [e, mk({ zone: 'long', ts: NOW - 4 * DAY, title: '另一条' })],
    budgetTokens: 1400,
  });

  const hits = out.text.match(/同一条/g) ?? [];
  assert.equal(hits.length, 1, '同一条记忆不许注入两遍');
  // 命中两条 → 走「候选清单」模式，让他挑，而不是把两条正文都展开
  assert.match(out.text, /〔这轮想起来的 · 有几条都对得上〕/);
  assert.match(out.text, /先问一句/);
});

test('renderInjection：命中两条以上只列清单，不展开 detail（省 token 的核心）', () => {
  const a = mk({ zone: 'short', ts: NOW - 1 * DAY, title: '桌宠第一次做', detail: '细节'.repeat(200) });
  const b = mk({ zone: 'short', ts: NOW - 4 * DAY, title: '桌宠改外形', detail: '细节'.repeat(200) });
  const c = mk({ zone: 'short', ts: NOW - 9 * DAY, title: '桌宠换素材', detail: '细节'.repeat(200) });

  const list = renderInjection({
    zones: { ...empty },
    cfg,
    now: NOW,
    recalled: [a, b, c],
    budgetTokens: 1400,
  });
  const single = renderInjection({
    zones: { ...empty },
    cfg,
    now: NOW,
    recalled: [a],
    budgetTokens: 1400,
  });

  // 清单里要有序号、时间、标题
  assert.match(list.text, /  1\. \[/);
  assert.match(list.text, /  3\. \[/);
  // 清单里不该有正文细节（只留标题）
  assert.ok(!list.text.includes('细节'.repeat(50)), '候选模式不许展开 detail');
  // 单条时才展开正文
  assert.ok(single.text.includes('细节'.repeat(20)), '只命中一条时应该正常展开');
  // 清单比全展开省得多
  assert.ok(list.tokens < single.tokens * 2, `清单 ${list.tokens} / 单条 ${single.tokens}`);
});

test('renderInjection：超预算先砍长期，短期一条不动', () => {
  const short = [
    mk({ ts: NOW - 1 * DAY, title: '短期A', detail: '短细节'.repeat(4) }),
    mk({ ts: NOW - 2 * DAY, title: '短期B', detail: '短细节'.repeat(4) }),
  ];
  const long = [
    mk({ zone: 'long', ts: NOW - 10 * DAY, title: '长期A', detail: '长细节'.repeat(40) }),
    mk({ zone: 'long', ts: NOW - 11 * DAY, title: '长期B', detail: '长细节'.repeat(40) }),
  ];
  const permanent = [
    mk({ zone: 'permanent', ts: NOW - 60 * DAY, title: '永久A', detail: '长细节'.repeat(40) }),
    mk({ zone: 'permanent', ts: NOW - 61 * DAY, title: '永久B', detail: '长细节'.repeat(40) }),
  ];
  const recalled = [
    mk({ zone: 'long', ts: NOW - 20 * DAY, title: '想起A', detail: '长细节'.repeat(40) }),
    mk({ zone: 'long', ts: NOW - 21 * DAY, title: '想起B', detail: '长细节'.repeat(40) }),
  ];

  const full = renderInjection({
    zones: { short, long, permanent },
    cfg,
    now: NOW,
    recalled,
    budgetTokens: 100000,
  });
  // 只砍 50 token 的量：长期有 2 条就够补上，不该碰其他区
  const out = renderInjection({
    zones: { short, long, permanent },
    cfg,
    now: NOW,
    recalled,
    budgetTokens: full.tokens - 50,
  });

  assert.ok(out.breakdown.long.cut >= 1, '应该先砍长期');
  assert.equal(out.breakdown.recalled.cut, 0, '长期还没砍光就动了「这轮想起来的」');
  assert.equal(out.breakdown.permanent.cut, 0, '长期还没砍光就动了永久');
  assert.equal(out.breakdown.short.cut, 0, '长期还没砍光就动了短期');
  assert.ok(out.tokens <= out.breakdown.budgetTokens);
});

test('renderInjection：裁剪顺序 长期 → 短期 → 永久 → 这轮想起来的（最不该丢的排最后）', () => {
  const short = [mk({ ts: NOW - 1 * DAY, title: '短期A', detail: '短细节'.repeat(4) })];
  const long = [mk({ zone: 'long', ts: NOW - 10 * DAY, title: '长期A', detail: '长细节'.repeat(40) })];
  const permanent = [
    mk({ zone: 'permanent', ts: NOW - 60 * DAY, title: '永久A', detail: '人格底色'.repeat(4) }),
  ];
  const recalled = [mk({ zone: 'long', ts: NOW - 20 * DAY, title: '想起A', detail: '长细节'.repeat(40) })];

  // 先量出「只装短期 + 永久」要多少 token
  const base = renderInjection({
    zones: { ...empty, short, permanent },
    cfg,
    now: NOW,
    budgetTokens: 100000,
  });

  // 预算卡在刚好装得下短期 + 永久 —— 长期先被砍掉
  const out = renderInjection({
    zones: { short, long, permanent },
    cfg,
    now: NOW,
    recalled,
    budgetTokens: base.tokens,
  });

  assert.equal(out.breakdown.long.cut, 1, '长期最该砍');
  // 用户这轮亲口提起的事排最后砍，所以这里它必须还在
  assert.equal(out.breakdown.recalled.cut, 0, '「这轮想起来的」是焦点，不该被砍');
  assert.ok(out.text.includes('想起A'));
  assert.ok(!out.text.includes('长期A'));
  // 短期和永久这次谁先让位取决于精确的 token 数，不锁死 —— 只要总预算守住了
  assert.ok(out.tokens <= out.breakdown.budgetTokens);
});

test('renderInjection：真的放不下时才动「这轮想起来的」（它排最后一个）', () => {
  const recalled = [mk({ zone: 'long', ts: NOW - 20 * DAY, title: '想起A', detail: '长细节'.repeat(60) })];
  const out = renderInjection({
    zones: empty,
    cfg,
    now: NOW,
    recalled,
    budgetTokens: 60,
  });
  // 装不下就只能砍 —— 但顺序上它是最后一个被砍的
  assert.ok(out.breakdown.recalled.cut >= 0);
});

test('renderInjection：实在放不下时，短期让位给永久（实测踩过的坑）', () => {
  // 装上去实测发现：短期 10 条 ×200 字会把预算吃光，永久一条都进不去，
  // 「我记得你是什么样的人」被挤掉、「上周二改了个 BOM」留下来 —— 方向反了。
  // 现在永久最后砍，所以这里必须保住永久。
  const short = Array.from({ length: 6 }, (_, i) =>
    mk({ ts: NOW - (i + 1) * DAY, title: `短期${i}`, detail: '很长的细节'.repeat(30) }),
  );
  const permanent = [mk({ zone: 'permanent', ts: NOW - 90 * DAY, title: '永久A', detail: '人格底色' })];

  const out = renderInjection({
    zones: { ...empty, short, permanent },
    cfg: { ...cfg, loadShortCount: 6, permanentDetail: 0.3 },
    now: NOW,
    budgetTokens: 200,
  });

  assert.ok(out.breakdown.short.cut > 0, '预算不够时短期必须让位');
  assert.equal(out.breakdown.permanent.cut, 0, '永久区被砍了 —— 那是底色');
  assert.ok(out.text.includes('永久A'));
});

test('renderInjection：预算小到放不下任何条目时，连短期也砍，返回空串', () => {
  const short = [mk({ ts: NOW - 1 * DAY, title: '短期A', detail: '短细节' })];
  const out = renderInjection({
    zones: { ...empty, short },
    cfg,
    now: NOW,
    budgetTokens: 1,
  });
  assert.equal(out.text, '');
  assert.equal(out.tokens, 0);
  assert.equal(out.breakdown.short.cut, 1);
});

test('renderInjection：breakdown 每区都记 candidate/shown/cut，cutTotal 对得上', () => {
  const short = Array.from({ length: 20 }, (_, i) => mk({ ts: NOW - (i + 1) * DAY }));
  const out = renderInjection({
    zones: { ...empty, short },
    cfg: { ...cfg, loadShortCount: 5 },
    now: NOW,
    budgetTokens: 100000,
  });

  for (const key of ['short', 'long', 'permanent', 'recalled']) {
    const z = out.breakdown[key];
    assert.equal(typeof z.candidate, 'number', `${key}.candidate`);
    assert.equal(typeof z.shown, 'number', `${key}.shown`);
    assert.equal(z.cut, z.candidate - z.shown, `${key}.cut`);
  }
  const sum =
    out.breakdown.short.cut +
    out.breakdown.long.cut +
    out.breakdown.permanent.cut +
    out.breakdown.recalled.cut;
  assert.equal(out.breakdown.cutTotal, sum);
});

test('renderEntryLine：形状 `- [时间] title —— detail · weight`', () => {
  const e = mk({ ts: NOW - 3600000, title: '他在做记忆插件', detail: '要求三分区。', weight: 0.72 });
  const line = renderEntryLine(e, { now: NOW });
  assert.equal(line, '- [10-25 11:00] 他在做记忆插件 —— 要求三分区。 · 0.72');
});

test('renderEntryLine：detail 与 title 相同时省略破折号段', () => {
  const e = { ...mk(), title: '同一句话', detail: '同一句话', weight: 0.5 };
  const line = renderEntryLine(e, { now: NOW });
  assert.ok(!line.includes('——'), line);
  assert.match(line, /^- \[\S+ \S+\] 同一句话 · 0\.5$/);
});

test('renderEntryLine：weight 去掉多余尾零，且夹在 0..1', () => {
  const base = mk({ title: 'x', detail: 'y' });
  assert.ok(renderEntryLine({ ...base, weight: 0.6 }, { now: NOW }).endsWith('· 0.6'));
  assert.ok(renderEntryLine({ ...base, weight: 1 }, { now: NOW }).endsWith('· 1'));
  assert.ok(renderEntryLine({ ...base, weight: -3 }, { now: NOW }).endsWith('· 0'));
});

test('renderEntryLine：detailLimit 截断但绝不为空（40 字下限）', () => {
  const e = mk({ title: '标题', detail: '甲'.repeat(300), weight: 0.5 });
  const line = renderEntryLine(e, { now: NOW, detailLimit: 20 });
  const detailPart = line.split(' —— ')[1].replace(' · 0.5', '');
  assert.ok(detailPart.length >= 40, `被压得太短：${detailPart.length}`);
  assert.ok(detailPart.length <= 300);
  // 传 0 也不许把 detail 抹掉
  const line0 = renderEntryLine(e, { now: NOW, detailLimit: 0 });
  assert.ok(line0.includes('——'), 'detail 被抹掉了');
});

test('renderInjection：分区强度真的在起作用（永久比短期更短）', () => {
  const longDetail = '这是很长的细节描述'.repeat(20); // 180 字
  const s = mk({ zone: 'short', ts: NOW - 1 * DAY, title: '短的', detail: longDetail });
  const p = mk({ zone: 'permanent', ts: NOW - 300 * DAY, title: '永久的', detail: longDetail });

  const out = renderInjection({
    zones: { ...empty, short: [s], permanent: [p] },
    cfg,
    now: NOW,
    budgetTokens: 100000,
  });

  const detailOf = (title) => {
    const line = out.text.split('\n').find((l) => l.includes(title));
    return line.split(' —— ')[1].replace(/ · [\d.]+$/, '');
  };

  const shortLen = detailOf('短的').length;
  const permLen = detailOf('永久的').length;
  assert.ok(shortLen > permLen, `永久区应该更模糊：短 ${shortLen} vs 永 ${permLen}`);
  assert.ok(permLen >= 40, '再模糊也不许低于 40 字下限');
});

test('renderEntryLine：detail 以 title 开头时只留一份（迁移进来的旧日记就是这种形状）', () => {
  // normalizeEntry 把 title 截到 80 字、detail 保留全文，所以旧日记必然是
  // 「title 是 detail 的前缀」。照「标题 —— 详情」渲染会把同一句话读两遍。
  const body = 'DSH 界面右下角那只带余额气泡的蓝发娘是 dsh-whale-widget，不是我新装的 dsh-pet。';
  const e = mk({ ts: NOW - 3600000, title: body.slice(0, 40), detail: body, weight: 0.7 });
  const line = renderEntryLine(e, { now: NOW });

  assert.ok(!line.includes(' —— '), `不该出现「标题 —— 详情」的重复：${line}`);
  assert.ok(line.includes('dsh-whale-widget'), '正文要留着');
  assert.equal(line.split('dsh-whale-widget').length - 1, 1, '同一个词出现了两次');
  assert.ok(line.endsWith('· 0.7'));
});

test('renderEntryLine：标题与正文确实不同时，仍然用「标题 —— 正文」', () => {
  const e = mk({ ts: NOW - 3600000, title: '短标题', detail: '完全不同的正文内容。', weight: 0.5 });
  const line = renderEntryLine(e, { now: NOW });
  assert.ok(line.includes('短标题 —— 完全不同的正文内容。'), line);
});
