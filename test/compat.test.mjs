import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeEntry,
  canonicalizeList,
  extractJsonArray,
  toTs,
  toZone,
} from '../src/core/compat.mjs';

/* ───────────────────────── 时间写法 ───────────────────────── */

test('toTs 认毫秒 / 秒 / 日期字符串', () => {
  assert.equal(toTs(1793086189781), 1793086189781);          // 13 位毫秒
  assert.equal(toTs(1793086189), 1793086189000);             // 10 位秒 → ×1000
  assert.equal(toTs('1793086189781'), 1793086189781);        // 数字字符串
  const local = toTs('2026-10-27 15:30:00');                 // 本地日期串
  assert.ok(Number.isFinite(local), '本地日期串要能解析');
  assert.equal(new Date(local).getFullYear(), 2026);
  assert.equal(toTs('这不是时间'), undefined);
  assert.equal(toTs(undefined), undefined);
  assert.equal(toTs(''), undefined);
});

/* ───────────────────────── 分区语义词 ───────────────────────── */

test('toZone 把语义词映射到三区，认不出来就交给 weight', () => {
  assert.equal(toZone('short'), 'short');
  assert.equal(toZone('permanent'), 'permanent');
  assert.equal(toZone('semantic'), 'long');
  assert.equal(toZone('episodic'), 'short');
  assert.equal(toZone('config'), 'long');
  assert.equal(toZone('preference'), 'permanent');
  assert.equal(toZone('人格'), 'permanent');
  assert.equal(toZone('短期'), 'short');
  assert.equal(toZone('随便什么'), undefined);
  assert.equal(toZone(undefined), undefined);
});

/* ───────────────────────── 键名对齐 ───────────────────────── */

test('canonicalizeEntry 认得模型那套 type/content/session 写法', () => {
  const raw = {
    type: 'config',
    content: '桌面端记忆插件的 mirror 目录指向 D:/path/to/ebbinghaus-mirror',
    session: 'probe-session',
    ts: 1793086189781,
  };
  const e = canonicalizeEntry(raw);
  assert.match(e.detail, /mirror 目录指向/);
  assert.ok(e.title.length > 0, 'title 应从正文派生');
  assert.ok(e.title.length <= 40);
  assert.equal(e.zone, 'long');            // type: config → long
  assert.equal(e.ts, 1793086189781);
});

test('canonicalizeEntry 对齐 tags / importance / timestamp 这些别名', () => {
  const e = canonicalizeEntry({
    detail: '他下周三下午有课',
    tags: '课程, 时间, 别打扰',
    importance: 0.8,
    timestamp: '1793086189781',
    category: 'episodic',
  });
  assert.deepEqual(e.keywords, ['课程', '时间', '别打扰']);
  assert.equal(e.weight, 0.8);
  assert.equal(e.ts, 1793086189781);
  assert.equal(e.zone, 'short');
});

test('canonicalizeEntry 是幂等的：标准形状走一遍不变形', () => {
  const std = {
    ts: 1793086189781,
    weight: 0.7,
    zone: 'short',
    title: '标题',
    detail: '正文正文正文',
    keywords: ['a', 'b'],
  };
  assert.deepEqual(canonicalizeEntry(std), std);
});

test('canonicalizeEntry 不为空条目编内容', () => {
  const e = canonicalizeEntry({ session: 'x', type: 'fact' });
  assert.equal(e.detail, undefined);
  assert.equal(e.title, undefined);
});

/* ───────────────────────── 从噪声里抠数组 ───────────────────────── */

const ONE = { ts: 1793086189781, title: '标题', detail: '正文' };

test('extractJsonArray 容忍前后解释文字', () => {
  const got = extractJsonArray(`好的，这是记忆条目：\n${JSON.stringify([ONE])}\n希望对你有帮助。`);
  assert.equal(got.length, 1);
  assert.equal(got[0].detail, '正文');
});

test('extractJsonArray 拆开 memories 之类的包装', () => {
  const got = extractJsonArray(JSON.stringify({ memories: [ONE] }));
  assert.equal(got.length, 1);
  assert.equal(got[0].title, '标题');
});

test('extractJsonArray 单个对象也当一条', () => {
  const got = extractJsonArray(JSON.stringify(ONE));
  assert.equal(got.length, 1);
});

test('extractJsonArray 容忍尾逗号和 markdown 围栏', () => {
  assert.equal(extractJsonArray('[{"title":"a","detail":"b"},]').length, 1);
  assert.equal(extractJsonArray('```json\n[{"title":"a","detail":"b"}]\n```').length, 1);
});

test('extractJsonArray 能救回被截断的数组', () => {
  const text = '[{"ts":1793086189781,"title":"甲","detail":"正文甲"},{"ts":1793086189782,"title":"乙","det';
  const got = extractJsonArray(text);
  assert.equal(got.length, 1, '只救回写完整的那一条');
  assert.equal(got[0].title, '甲');
});

test('extractJsonArray 该拒的还是要拒', () => {
  assert.equal(extractJsonArray(''), null);
  assert.equal(extractJsonArray(null), null);
  assert.equal(extractJsonArray('模型今天不想干活'), null);
  assert.equal(extractJsonArray('{"a":1}')?.length, 1); // 包装成一条，由下游判空后丢掉
});

test('canonicalizeList 剔掉非对象成员', () => {
  assert.deepEqual(canonicalizeList([1, 'x', null, [], ONE]).length, 1);
  assert.deepEqual(canonicalizeList(null), []);
});
