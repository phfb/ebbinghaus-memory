import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_DEFAULTS,
  CONFIG_SPEC,
  buildSchema,
  resolveConfig,
} from '../src/core/config.mjs';

test('默认值完整：每个 spec 键都有默认值，且默认值本身合法', () => {
  for (const f of CONFIG_SPEC) {
    assert.ok(f.key in CONFIG_DEFAULTS, `${f.key} 缺默认值`);
    assert.notEqual(f.default, undefined, `${f.key} 默认值是 undefined`);
  }
  // 默认配置跑一遍 resolve 应当原样返回（幂等）
  const a = resolveConfig({});
  const b = resolveConfig(a);
  assert.deepEqual(a, b);
});

test('resolveConfig 永不抛错：垃圾输入全部退回默认', () => {
  const junk = [null, undefined, 42, 'x', [], { shortDays: 'abc' }, { enabled: 'maybe' }];
  for (const raw of junk) {
    const cfg = resolveConfig(raw);
    assert.equal(typeof cfg.shortDays, 'number');
    assert.equal(typeof cfg.enabled, 'boolean');
    assert.ok(Number.isFinite(cfg.shortDays));
  }
});

test('数值会被夹到 min/max 之间', () => {
  const cfg = resolveConfig({ shortDays: 0, longDays: 99999, recallTop: -3 });
  assert.equal(cfg.shortDays, 1, 'shortDays 下限是 1');
  assert.equal(cfg.longDays, 365, 'longDays 上限是 365');
  assert.equal(cfg.recallTop, 1, 'recallTop 下限是 1');
});

test('长期周期不会短于短期周期（跨字段校正）', () => {
  const cfg = resolveConfig({ shortDays: 20, longDays: 10 });
  assert.ok(cfg.longDays > cfg.shortDays, '长期必须比短期长');
  assert.equal(cfg.longDays, 21);
});

test('字符串键不是字符串就退回默认 —— 防 [object Object] 那个坑', () => {
  // DSH 的 schemastery .volatile() 会把默认值包成对象，进到插件里成 '[object Object]'。
  // 我们不加 volatile，但这里也必须挡住：一个被包成对象的 dataDir 会让记忆写进
  // 一个叫 [object Object] 的目录，而且全程没有任何报错。
  const cfg = resolveConfig({ dataDir: { value: '' }, model: 123, provider: null });
  assert.equal(cfg.dataDir, '');
  assert.equal(cfg.model, '');
  assert.equal(cfg.provider, '');
});

test('布尔值接受字符串与数字写法', () => {
  assert.equal(resolveConfig({ enabled: 'false' }).enabled, false);
  assert.equal(resolveConfig({ enabled: 'true' }).enabled, true);
  assert.equal(resolveConfig({ enabled: 0 }).enabled, false);
  assert.equal(resolveConfig({ enabled: 1 }).enabled, true);
});

test('思考档位默认是 off —— 固化绝不能继承用户聊天的 high', () => {
  assert.equal(CONFIG_DEFAULTS.reasoningEffort, 'off');
});

test('每个数值默认值都必须是 step 的整数倍（schemastery .step() 是硬校验）', () => {
  // 这条是拿真实 schemastery 验出来的：`.step(0.05)` 不是"滑块步进建议"，
  // 而是校验器 —— 默认值 0.72 会让整份配置解析失败、设置页直接报错。
  // 这个 bug 纯逻辑测试原本抓不到，因为它只在真实 schemastery 里触发。
  for (const f of CONFIG_SPEC) {
    if (f.type !== 'number' || !Number.isFinite(f.step) || f.step <= 0) continue;
    const q = f.default / f.step;
    assert.ok(
      Math.abs(q - Math.round(q)) < 1e-9,
      `${f.key} 的默认值 ${f.default} 不是 step ${f.step} 的整数倍（真 schemastery 会拒绝整份配置）`,
    );
    assert.ok(
      f.default >= (f.min ?? -Infinity) && f.default <= (f.max ?? Infinity),
      `${f.key} 的默认值 ${f.default} 不在 [${f.min}, ${f.max}] 里`,
    );
  }
});

test('数值字段的 min 也必须落在 step 网格上（否则设置页第一个可用值就非法）', () => {
  for (const f of CONFIG_SPEC) {
    if (f.type !== 'number' || !Number.isFinite(f.step) || !Number.isFinite(f.min)) continue;
    const q = f.min / f.step;
    assert.ok(
      Math.abs(q - Math.round(q)) < 1e-9,
      `${f.key} 的 min ${f.min} 不是 step ${f.step} 的整数倍`,
    );
  }
});

test('buildSchema 只在给了 schemastery 时才用，且不产生 volatile 链', () => {
  // 假 z：记录调用了哪些方法
  const calls = [];
  const make = (kind) => {
    const chain = {
      default(v) {
        calls.push(`${kind}.default`);
        return chain;
      },
      description(v) {
        calls.push(`${kind}.description`);
        return chain;
      },
      min() {
        return chain;
      },
      max() {
        return chain;
      },
      step() {
        return chain;
      },
      volatile() {
        calls.push('VOLATILE');
        return chain;
      },
    };
    return chain;
  };
  const z = {
    boolean: () => make('boolean'),
    number: () => make('number'),
    string: () => make('string'),
    object: (shape) => {
      assert.equal(typeof shape, 'object');
      return { shape };
    },
  };
  const schema = buildSchema(z);
  assert.ok(schema.shape);
  assert.equal(Object.keys(schema.shape).length, CONFIG_SPEC.length);
  assert.ok(!calls.includes('VOLATILE'), '不许用 volatile：它会把 dataDir 变成对象');
});
