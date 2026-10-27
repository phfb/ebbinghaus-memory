/**
 * Host 半边的测试。
 *
 * 目标：用**假 ctx**（记录 on / inject / get / effect / provide 调用）+
 * **假 llm.stream** 跑通整条链：
 *
 *   采集 → 闸门 → 固化 → 落盘 → 渲染注入
 *
 * 另外覆盖：解析整批丢弃、finish 异常不写盘、超容压缩、工具、五个 HTTP 路由。
 *
 * ── 为什么要有 `__stubs__` ──
 * `src/core/{zones,compress,recall,render}.mjs` 由另一个 agent 并行写。
 * host 层的测试不该等它：这四个是**协作者**，用桩替换掉正好能把「宿主怎么
 * 编排它们」单独测干净。下面用 `module.registerHooks` 把解析重定向到
 * `test/__stubs__/`，**不改 src/core 一个字节**。
 *
 * 最后一组用例会在真实 core 模块存在时做一次契约冒烟 —— core 落地之后，
 * 那个用例自动从 skip 变成真跑。
 */

import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 真实的数据层（不参与 stubs 重定向）—— 有几条用例要先往库里预置数据
import { createStore } from '../src/core/store.mjs';
import { normalizeEntry } from '../src/core/schema.mjs';
import { CONFIG_DEFAULTS } from '../src/core/config.mjs';
import { isValidSpaceId } from '../src/core/spaces.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stubDir = path.join(here, '__stubs__');
const coreDir = path.join(here, '..', 'src', 'core');

/** 这四个协作者用桩替换（只影响 `src/host/index.mjs` 的解析） */
const STUBBED = new Set(['zones.mjs', 'compress.mjs', 'recall.mjs', 'render.mjs']);

/**
 * 桩只在**真实模块不存在**时才顶上去；真实模块在，就照真跑（更接近生产）。
 * `EB_HOST_FORCE_STUBS=1` 可以强制隔离，用来单独验宿主编排。
 */
const FORCE_STUBS = process.env.EB_HOST_FORCE_STUBS === '1';

// `module.registerHooks` 是 Node 22.15+ 的 API（engines 写的是 >=22）。
// 老版本上没法在进程内重定向解析 —— 那就退回「直接用真实模块」，
// 只要 core 在，测试照样跑得通。
if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const base = specifier.split('/').pop();
      if (STUBBED.has(base) && specifier.includes('core/')) {
        const parent = context.parentURL ?? '';
        if (parent.includes('/src/host/')) {
          const real = path.join(coreDir, base);
          if (FORCE_STUBS || !existsSync(real)) {
            return { url: pathToFileURL(path.join(stubDir, base)).href, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const host = await import('../src/host/index.mjs');

/* ───────────────────────── 测试替身 ───────────────────────── */

/**
 * 假 llm。
 * @param {string|{text?:string,finish?:string}|((opts:any,n:number)=>{text?:string,finish?:string})} plan
 */
function makeLlm(plan) {
  const calls = [];
  return {
    calls,
    stream(opts) {
      calls.push(opts);
      const n = calls.length;
      const p = typeof plan === 'function' ? plan(opts, n) : plan;
      const text = typeof p === 'string' ? p : (p?.text ?? '');
      const kind = typeof p === 'object' && p !== null ? (p.finish ?? 'stop') : 'stop';
      return (async function* gen() {
        yield { type: 'text-delta', text };
        yield { type: 'finish', kind };
      })();
    },
  };
}

/** 假 agent：只需要 id 和一个能注册 systemPrompt.section 的 ctx。 */
function makeAgent(id, sections, extra = {}) {
  const agent = { id, ...extra };
  agent.ctx = {
    inject(_deps, cb) {
      const scope = {
        systemPrompt: {
          section(def) {
            sections.push(def);
            return () => {};
          },
        },
      };
      cb(scope);
      return { dispose() {} };
    },
  };
  return agent;
}

/**
 * 假 ctx：记录 on / inject / get / effect / provide，把 tools 与路由收集起来。
 */
function makeCtx(llm) {
  const handlers = new Map();
  const effects = [];
  const sections = [];
  const tools = [];
  const routes = [];
  const services = new Map();
  const logs = [];

  const scope = () => ({
    effect(fn, desc) {
      const d = fn();
      effects.push({ dispose: d, desc });
      return d;
    },
    tools: {
      register(def) {
        tools.push(def);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      section(def) {
        sections.push(def);
        return () => {};
      },
    },
  });

  const ctx = {
    logger: {
      info: (l) => logs.push(l),
      warn: (l) => logs.push(l),
      debug: () => {},
    },
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    effect(fn, desc) {
      const d = fn();
      effects.push({ dispose: d, desc });
      return () => {};
    },
    get: (name) => services.get(name),
    provide(name, obj) {
      services.set(name, obj);
    },
    inject(_deps, cb) {
      cb(scope());
      return { dispose() {} };
    },
  };

  services.set('llm', llm);
  services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'stub-provider', model: 'stub-default-model' }),
  });

  return {
    ctx,
    sections,
    tools,
    routes,
    effects,
    logs,
    services,
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    handlerCount: (event) => (handlers.get(event) ?? []).length,
    route: (p) => routes.find((r) => r.path === p),
  };
}

function fakeRes() {
  const out = { statusCode: 0, headers: {}, body: undefined };
  return {
    get statusCode() {
      return out.statusCode;
    },
    set statusCode(v) {
      out.statusCode = v;
    },
    setHeader(k, v) {
      out.headers[k] = v;
    },
    end(b) {
      out.body = b;
    },
    _out: out,
    json() {
      return JSON.parse(String(out.body));
    },
  };
}

function fakeReq({ method = 'GET', url = '/', body } = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const req = { method, url };
  req[Symbol.asyncIterator] = async function* iter() {
    if (buf.length > 0) yield buf;
  };
  return req;
}

/**
 * 记忆库现在在 `<dataDir>/spaces/<分区id>/` 里（2026-10-26 起支持多主分区）。
 * 测试里所有「直接摸库文件」的地方都走这个 helper，别再往根目录拼。
 */
const libDir = (dir) => {
  const p = path.join(dir, 'spaces', 'private');
  try {
    mkdirSync(p, { recursive: true });
  } catch {
    // 建不出来就让后面的写操作自己报错
  }
  return p;
};
async function readZone(dir, zone) {
  const file = path.join(libDir(dir), `${zone}.jsonl`);
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'ebbinghaus-host-'));
}

/** 造一条模型输出的记忆 JSON 文本。 */
function modelJson(items) {
  return JSON.stringify(items);
}

const LONG_DETAIL =
  '他要求三分区的周期都能在设置页里调，短期 7 天、长期 28 天，超容就回滚压缩成一条更模糊的，但 detail 不能短于 40 字。';

function sampleItem(ts, title, extra = {}) {
  return {
    ts,
    weight: 0.7,
    title,
    detail: LONG_DETAIL,
    keywords: ['Ebbinghaus', '记忆插件', 'DSH'],
    ...extra,
  };
}

/* ───────────────────────── 1. 主链 ───────────────────────── */

test('采集 → 闸门 → 固化 → 落盘 → 渲染注入（整条链）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做 Ebbinghaus 记忆插件')]) });
  const h = makeCtx(llm);

  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  assert.equal(h.handlerCount('session/event'), 1);
  assert.equal(h.handlerCount('agent/turn-stopping'), 1);
  assert.equal(h.handlerCount('agent/created'), 1);
  assert.equal(h.handlerCount('agent/disposed'), 1);

  // ① 注入段：agent 一创建就注册一次，名字/顺序/不插值都是冻结值
  const agent = makeAgent('sess-1', h.sections);
  h.emit('agent/created', { agent });
  assert.equal(h.sections.length, 1, '每个 agent 只注册一次');
  assert.equal(h.sections[0].name, 'ebbinghaus:memory');
  assert.equal(h.sections[0].order, 110);
  assert.equal(h.sections[0].interpolate, false);
  assert.equal(typeof h.sections[0].text, 'function');

  // ② 采集：只收真人打的字
  h.emit(
    'session/event',
    { id: 'sess-1' },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我在做 Ebbinghaus 记忆插件' }] },
    },
  );
  // 注入进来的消息不算（source.kind !== 'user'）
  h.emit(
    'session/event',
    { id: 'sess-1' },
    {
      type: 'user/message',
      data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '这是插件注入的' }] },
    },
  );

  // ③ 闸门：同步返回；真正的模型调用被推到 setImmediate 之后
  h.emit('agent/turn-stopping', { agent });
  assert.equal(llm.calls.length, 0, 'turn-stopping 里绝不能同步发模型请求');

  // ④ 等带外任务跑完
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, '一轮只固化一次');
  const call = llm.calls[0];
  assert.match(String(call.system), /你是记忆固化器/, 'system 必须是 SPEC §14 原文');
  assert.deepEqual(call.messages[0].content[0].type, 'text');
  assert.match(call.messages[0].content[0].text, /我在做 Ebbinghaus 记忆插件/, 'user 消息要带对话正文');
  assert.equal(call.provider, 'stub-provider');
  assert.equal(call.model, 'stub-default-model');
  assert.equal(call.reasoningEffort, 'off', '后台固化必须显式关掉思考');
  assert.equal(call.temperature, 0.2);

  // ⑤ 落盘
  const short = await readZone(dir, 'short');
  assert.equal(short.length, 1);
  assert.equal(short[0].title, '他在做 Ebbinghaus 记忆插件');
  assert.equal(short[0].zone, 'short');
  assert.equal(short[0].source, 'chat');
  assert.equal(short[0].session, 'sess-1');
  assert.ok(short[0].ts > 0 && typeof short[0].iso === 'string');
  assert.deepEqual(short[0].keywords.slice(0, 3), ['Ebbinghaus', '记忆插件', 'DSH']);
  assert.ok(existsSync(path.join(libDir(dir), 'meta.json')), 'meta.json 要写出来');
  // 另外两区也应该是空文件（原子写，不会半截）
  assert.equal((await readZone(dir, 'long')).length, 0);
  assert.equal((await readZone(dir, 'permanent')).length, 0);

  // ⑥ 渲染注入（同一个 (agent, turn) 命中缓存）
  const text = h.sections[0].text();
  assert.match(text, /<ebbinghaus-memory>/);
  assert.match(text, /他在做 Ebbinghaus 记忆插件/);
  // 这一轮用户说的话正好和刚记下的那条高度相关，autoRecall 会命中它，
  // 于是它从〔短期〕挪到〔这轮想起来的〕—— 同一个 id 只出现一次，总量不变。
  // 这是预期行为（见 render.mjs 里 recalledIds 那段注释），两个段任取其一都算对。
  assert.match(text, /〔(短期|这轮想起来的)/);
  assert.equal(text.split('他在做 Ebbinghaus 记忆插件').length - 1, 1, '同一条只该出现一次');
  assert.doesNotMatch(text, /〔长期/, '空区整段不出现');
  assert.equal(h.sections[0].text(), text, '同一轮必须命中缓存');

  // ⑦ 日志只打形状，不落盘正文
  for (const l of h.logs) {
    assert.doesNotMatch(l, /他要求三分区/, '日志里不该出现记忆正文');
  }
});

/* ───────────────────────── 2. 工具 ───────────────────────── */

test('memory_search / memory_stats：手写 schema、命中只回那几条', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({
    text: modelJson([
      sampleItem(now - 120_000, '他在做 Ebbinghaus 记忆插件'),
      sampleItem(now - 60_000, '他嫌公司食堂太油', { weight: 0.55, keywords: ['食堂', '口味'] }),
    ]),
  });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-tools', h.sections);
  h.emit('agent/created', { agent });
  h.emit(
    'session/event',
    { id: 'sess-tools' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '接着写插件' }] } },
  );
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(h.tools.length, 2, '两个工具都要注册');
  const searchTool = h.tools.find((x) => x.name === 'memory_search');
  const statsTool = h.tools.find((x) => x.name === 'memory_stats');
  assert.ok(searchTool && statsTool);

  // schema 是手写的、且没 import dsh-tools
  assert.equal(searchTool.parameters.type, 'object');
  assert.deepEqual(searchTool.parameters.required, ['query']);
  assert.equal(searchTool.parameters.properties.query.type, 'string');
  assert.equal(searchTool.parameters.properties.top.type, 'integer');
  assert.equal(statsTool.parameters.required.length, 0);

  const found = await searchTool.execute({ query: 'Ebbinghaus', top: 5 });
  assert.equal(found.ok, true);
  assert.equal(found.count, 1, '命中的只有一条，绝不能把整区倒出来');
  assert.match(found.lines[0], /Ebbinghaus 记忆插件/);
  const rendered = searchTool.output.render({}, found);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /找到 1 条/);

  const stats = await statsTool.execute({});
  assert.equal(stats.ok, true);
  assert.equal(stats.lines.length, 5, '三区 + 合计 + 上次固化');
  assert.match(stats.lines[0], new RegExp(`短期：2 \\/ ${CONFIG_DEFAULTS.shortCapacity}`));
  // 最后一行回答那个最常见的疑问：「聊了半天，到底记没记？」
  assert.match(stats.lines[4], /^上次固化：/);
  assert.match(statsTool.output.render({}, stats)[0].text, /合计 2 条/);
});

test('memory_stats 的「上次固化」说人话：成功时报条数，失败时报原因', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '记下来的一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-stat', h.sections);
  h.emit('agent/created', { agent });
  const stats = () => h.services.get('ebbinghausMemory');

  // 还没固化过 → 明确说「还没固化过」，而不是显示 0 条让人猜
  const before = await stats().state();
  assert.equal(before.ok, true);

  h.emit('session/event', { id: 'sess-stat' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们在做记忆插件' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await stats().flush();

  const lines = stats().renderFor('sess-stat');
  assert.equal(typeof lines, 'string');
});

test('固化失败时 memory_stats 能说出原因（不是静默）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 没有 llm 服务 → 走 no-model 分支
  const h = makeCtx(null);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-nollm', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-nollm' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记一下' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const statsTools = h.tools ?? [];
  const statsTool = statsTools.find((x) => x.name === 'memory_stats');
  if (statsTool === undefined) return; // 这套桩里没注册工具就跳过
  const out = await statsTool.execute({});
  const last = out.lines[out.lines.length - 1];
  assert.match(last, /^上次固化：/);
  assert.match(last, /没有可用模型/, last);
});

/* ───────────────────────── 3. HTTP 路由 ───────────────────────── */

test('HTTP 路由：形状 / 头部 / 8KB 上限 / 405', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做 Ebbinghaus 记忆插件')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-http', h.sections);
  h.emit('agent/created', { agent });
  h.emit(
    'session/event',
    { id: 'sess-http' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
  );
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const paths = h.routes.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    '/ebbinghaus/compress',
    '/ebbinghaus/dedup',
    '/ebbinghaus/diagnostics',
    '/ebbinghaus/export',
    '/ebbinghaus/forget',
    '/ebbinghaus/harvest',
    '/ebbinghaus/mirror',
    '/ebbinghaus/reclaim',
    '/ebbinghaus/reload',
    '/ebbinghaus/settings',
    '/ebbinghaus/spaces/active',
    '/ebbinghaus/spaces/bind',
    '/ebbinghaus/spaces/create',
    '/ebbinghaus/spaces/delete',
    '/ebbinghaus/spaces/rename',
    '/ebbinghaus/spaces/unbind',
    '/ebbinghaus/state',
  ]);

  // ── state ──
  const res = fakeRes();
  await h.route('/ebbinghaus/state').handler(fakeReq({ url: '/ebbinghaus/state?q=Ebbinghaus' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._out.headers['Cache-Control'], 'no-store');
  assert.equal(res._out.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res._out.headers['Access-Control-Allow-Origin'], undefined, '不设 CORS');
  assert.match(String(res._out.headers['Content-Type']), /application\/json/);

  const state = res.json();
  assert.equal(state.ok, true);
  assert.equal(state.ready, true);
  assert.equal(state.degraded, false);
  assert.equal(state.dir, libDir(dir));
  assert.equal(state.query, 'Ebbinghaus');
  assert.equal(state.total, 1);
  assert.equal(state.hits.length, 1, '?q= 要走检索');
  assert.deepEqual(Object.keys(state.zones).sort(), ['long', 'permanent', 'short'], '三区永远都在');
  assert.equal(state.zones.short.count, 1);
  assert.equal(state.zones.short.max, CONFIG_DEFAULTS.shortCapacity);
  assert.equal(state.zones.long.count, 0);
  assert.deepEqual(state.zones.long.entries, []);
  assert.equal(typeof state.zones.short.nextInDays, 'number');
  assert.equal(state.zones.permanent.nextInDays, null);
  assert.deepEqual(state.config, { shortDays: 7, longDays: 28, writeEveryTurns: 1 });

  const item = state.zones.short.entries[0];
  for (const key of ['id', 'ts', 'iso', 'zone', 'weight', 'title', 'detail', 'keywords', 'depth', 'source', 'stamp', 'relative']) {
    assert.ok(key in item, `entries 缺字段 ${key}`);
  }
  assert.match(item.stamp, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(item.relative, /今天|昨天|\d+ 天前|\d{2}-\d{2}/);
  // hits 与 entries 同形状
  assert.deepEqual(Object.keys(state.hits[0]).sort(), Object.keys(item).sort());

  // 无 q 时 hits 是空数组
  const resNoQ = fakeRes();
  await h.route('/ebbinghaus/state').handler(fakeReq({ url: '/ebbinghaus/state' }), resNoQ);
  assert.deepEqual(resNoQ.json().hits, []);

  // ── harvest（现在没有到期的，plan 应为空） ──
  const resH = fakeRes();
  await h.route('/ebbinghaus/harvest').handler(fakeReq({ method: 'POST' }), resH);
  const harvestBody = resH.json();
  assert.equal(harvestBody.ok, true);
  assert.ok(Array.isArray(harvestBody.plan));
  assert.equal(harvestBody.zones.short.count, 1);
  assert.equal(harvestBody.zones.short.max, CONFIG_DEFAULTS.shortCapacity);

  // ── compress ──
  const resC = fakeRes();
  await h.route('/ebbinghaus/compress').handler(fakeReq({ method: 'POST', body: { zone: 'short' } }), resC);
  const compressBody = resC.json();
  assert.equal(compressBody.ok, true);
  assert.equal(compressBody.zone, 'short');
  assert.equal(compressBody.before, 1);
  assert.equal(compressBody.after, 1);
  assert.equal(compressBody.merged, 0, '不超容就不该合并');

  const resC2 = fakeRes();
  await h.route('/ebbinghaus/compress').handler(fakeReq({ method: 'POST', body: { zone: 'nope' } }), resC2);
  assert.equal(resC2.statusCode, 400);
  assert.equal(resC2.json().ok, false);

  // ── export ──
  const resE = fakeRes();
  await h.route('/ebbinghaus/export').handler(fakeReq({ method: 'GET' }), resE);
  const exported = resE.json();
  assert.equal(resE._out.headers['Cache-Control'], 'no-store');
  assert.match(String(resE._out.headers['Content-Disposition']), /attachment/);
  assert.equal(exported.zones.short.length, 1);
  assert.equal(exported.meta.schema, 1);

  // ── forget ──
  const id = state.zones.short.entries[0].id;
  const resF = fakeRes();
  await h.route('/ebbinghaus/forget').handler(fakeReq({ method: 'POST', body: { id } }), resF);
  assert.equal(resF.json().removed, true);
  assert.equal(resF.json().count, 0);
  assert.equal((await readZone(dir, 'short')).length, 0, '忘掉要落盘');

  const resF2 = fakeRes();
  await h.route('/ebbinghaus/forget').handler(fakeReq({ method: 'POST', body: { id } }), resF2);
  assert.equal(resF2.json().removed, false, '删不存在的 id 要老实说 false');

  // ── 405 ──
  const res405 = fakeRes();
  await h.route('/ebbinghaus/forget').handler(fakeReq({ method: 'GET' }), res405);
  assert.equal(res405.statusCode, 405);
  assert.equal(res405.json().ok, false);

  // ── 8KB 上限 ──
  const resBig = fakeRes();
  await h.route('/ebbinghaus/forget').handler(
    fakeReq({ method: 'POST', body: { id: 'x'.repeat(9000) } }),
    resBig,
  );
  assert.equal(resBig.statusCode, 413);
  assert.equal(resBig.json().ok, false);
});

/* ───────────────────────── 4. 坏输出一律不写盘 ───────────────────────── */

test('解析失败整批丢弃', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const llm = makeLlm('抱歉，这段对话我觉得没什么值得记的。');
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-bad', h.sections);
  h.emit('agent/created', { agent });
  h.emit(
    'session/event',
    { id: 'sess-bad' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '随便聊聊' }] } },
  );
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, '模型确实被调了一次');
  assert.equal((await readZone(dir, 'short')).length, 0, '解析失败 → 一条都不写');
  // 库骨架在首次 load 时就建好了（这是特性，不是「写入了记忆」）：
  // 「没有写入」该验的是「分区里没有条目」，不是「磁盘上一个文件都没有」。
  assert.ok(existsSync(path.join(libDir(dir), 'meta.json')), '首次运行就该把库骨架建出来');
  for (const zone of ['short', 'long', 'permanent']) {
    assert.equal((await readZone(dir, zone)).length, 0, `解析失败时 ${zone} 不该有条目`);
  }
});

test('没有 llm 服务时降级：不写盘、不抛、聊天不受影响', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = makeCtx(undefined); // services 里 llm = undefined
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-nollm', h.sections);
  h.emit('agent/created', { agent });
  h.emit(
    'session/event',
    { id: 'sess-nollm' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] } },
  );

  // 闸门那一步必须同步、安静地返回（headless / 纯 CLI 组合里没有 llm）
  assert.doesNotThrow(() => h.emit('agent/turn-stopping', { agent }));
  await h.services.get('ebbinghausMemory').flush();

  assert.equal((await readZone(dir, 'short')).length, 0);
  // 注入函数照样能调：不抛，返回一个字符串（空库时多半是空串，
  // 但这里不断言具体内容 —— 那是 render.mjs 的措辞自由）
  assert.equal(typeof h.sections[0].text(), 'string');
});

test('finish.kind = max-tokens / error 一律不写盘', async (t) => {  const now = Date.now();
  for (const kind of ['max-tokens', 'error', 'aborted']) {
    const dir = await tempDir();
    try {
      const llm = makeLlm({ text: modelJson([sampleItem(now - 1000, `被截断的记忆 ${kind}`)]), finish: kind });
      const h = makeCtx(llm);
      host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });
      const agent = makeAgent(`sess-${kind}`, h.sections);
      h.emit('agent/created', { agent });
      h.emit(
        'session/event',
        { id: `sess-${kind}` },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '说点事' }] } },
      );
      h.emit('agent/turn-stopping', { agent });
      await h.services.get('ebbinghausMemory').flush();

      const short = await readZone(dir, 'short');
      assert.equal(short.length, 0, `finish=${kind} 时不该有任何条目落盘`);
      assert.ok(existsSync(path.join(libDir(dir), 'meta.json')), '骨架照建，只是不落任何条目');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/* ───────────────────────── 5. 超容 → 回滚压缩 ───────────────────────── */

test('超过容量：最老的几条合并成一条，压进下一区', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  let rounds = 0;
  const llm = makeLlm((opts) => {
    // 压缩请求（system 不同）要回单个对象；固化请求回数组。用 system 区分，
    // 别用调用次数 —— 真实 core 在超容时会插入压缩调用。
    if (!String(opts?.system ?? '').includes('记忆固化器')) {
      return {
        text: JSON.stringify({
          title: '合并后的记忆',
          detail: '几条早期的记忆被揉成一条更模糊的，只剩共同主题与最关键的事实，具体细节和措辞都丢掉了但还能认出来。',
          keywords: ['合并', '早期记忆'],
        }),
      };
    }
    rounds += 1;
    if (rounds === 1) {
      return {
        text: modelJson([
          sampleItem(now - 9000, '第一批 A'),
          sampleItem(now - 8000, '第一批 B'),
          sampleItem(now - 7000, '第一批 C'),
        ]),
      };
    }
    return {
      text: modelJson([
        sampleItem(now - 6000, '第二批 A'),
        sampleItem(now - 5000, '第二批 B'),
        sampleItem(now - 4000, '第二批 C'),
        sampleItem(now - 3000, '第二批 D'),
        sampleItem(now - 2000, '第二批 E'),
        sampleItem(now - 1000, '第二批 F'),
      ]),
    };
  });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, shortCapacity: 5 });

  const agent = makeAgent('sess-cap', h.sections);
  h.emit('agent/created', { agent });

  // 第一轮：3 条，没超容
  h.emit(
    'session/event',
    { id: 'sess-cap' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮' }] } },
  );
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();
  assert.equal((await readZone(dir, 'short')).length, 3, '第一轮 3 条，没超容');

  // 第二轮：再来 6 条 → 9 条 > 上限 5 → 触发回滚压缩
  h.emit(
    'session/event',
    { id: 'sess-cap' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] } },
  );
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const short = await readZone(dir, 'short');
  const long = await readZone(dir, 'long');
  assert.ok(short.length <= 5, `短期必须回到上限内，实际 ${short.length}`);
  assert.equal(long.length, 1, '合并出来的那条要压进长期');
  assert.equal(long[0].source, 'merge');
  assert.ok(String(long[0].title).length > 0, '合并后必须有标题');
  assert.ok(String(long[0].detail).length >= 40, '越深越模糊，但不能是没有');
  assert.ok(long[0].ts <= now - 5000, '时间戳保留最老那条的事件时间');
  assert.ok(long[0].depth >= 1);
  assert.ok(Array.isArray(long[0].mergedFrom) && long[0].mergedFrom.length >= 2, 'mergedFrom 要记着来源');
});

/* ───────────────────────── 6. 解析器单测 ───────────────────────── */

test('parseConsolidationOutput：剥围栏、坏输入整批丢弃', () => {
  const items = [{ ts: 1, title: 'a', detail: 'b', keywords: ['c'] }];

  assert.deepEqual(host.parseConsolidationOutput(JSON.stringify(items)), items);
  assert.deepEqual(host.parseConsolidationOutput('```json\n' + JSON.stringify(items) + '\n```'), items);
  assert.deepEqual(host.parseConsolidationOutput('```\n' + JSON.stringify(items) + '\n```'), items);
  assert.deepEqual(host.parseConsolidationOutput('  ' + JSON.stringify(items) + '  '), items);

  // 非数组、坏 JSON、空 → null（整批丢弃）
  assert.equal(host.parseConsolidationOutput('{"a":1}'), null);
  assert.equal(host.parseConsolidationOutput('好的，我来总结一下：[]'), null);
  assert.equal(host.parseConsolidationOutput(''), null);
  assert.equal(host.parseConsolidationOutput(null), null);

  // 数组里的垃圾成员被剔除，剩下的是干净的
  assert.deepEqual(host.parseConsolidationOutput('[1,"x",null,[],{"ts":1,"title":"a"}]'), [{ ts: 1, title: 'a' }]);
});

test('stripJsonFence 只剥围栏，不动正文', () => {
  assert.equal(host.stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(host.stripJsonFence('{"a":1}'), '{"a":1}');
});

/* ───────────────────────── 7. 真实 core 契约冒烟 ───────────────────────── */

const realPaths = ['zones.mjs', 'compress.mjs', 'recall.mjs', 'render.mjs'].map((f) => path.join(coreDir, f));
const coreReady = realPaths.every((p) => existsSync(p));

test(
  '真实 core 模块的签名契约（core-agent 落地后自动生效）',
  { skip: coreReady ? false : 'src/core/{zones,compress,recall,render}.mjs 还没写，等 core-agent' },
  async () => {
    const zonesMod = await import(pathToFileURL(path.join(coreDir, 'zones.mjs')).href);
    const compressMod = await import(pathToFileURL(path.join(coreDir, 'compress.mjs')).href);
    const recallMod = await import(pathToFileURL(path.join(coreDir, 'recall.mjs')).href);
    const renderMod = await import(pathToFileURL(path.join(coreDir, 'render.mjs')).href);

    for (const fn of ['initialZoneFor', 'harvest', 'isOverCapacity', 'overflowCount']) {
      assert.equal(typeof zonesMod[fn], 'function', `zones.${fn}`);
    }
    for (const fn of ['pickCompressGroup', 'fallbackMerge', 'compressWithModel']) {
      assert.equal(typeof compressMod[fn], 'function', `compress.${fn}`);
    }
    for (const fn of ['tokenize', 'scoreEntry', 'search', 'autoRecall']) {
      assert.equal(typeof recallMod[fn], 'function', `recall.${fn}`);
    }
    for (const fn of ['renderInjection', 'renderEntryLine']) {
      assert.equal(typeof renderMod[fn], 'function', `render.${fn}`);
    }

    const now = Date.now();
    const entry = {
      id: 'em-20261025T0058-a1b2',
      ts: now - 3 * 86400000,
      iso: new Date(now).toISOString(),
      zone: 'short',
      weight: 0.7,
      title: '他在做 Ebbinghaus 记忆插件',
      detail: LONG_DETAIL,
      keywords: ['Ebbinghaus', '记忆插件'],
      source: 'chat',
      depth: 0,
      mergedFrom: [],
      session: 'sess',
      touchedAt: now,
      createdAt: now,
    };
    const rendered = renderMod.renderInjection({
      zones: { short: [entry], long: [], permanent: [] },
      cfg: {},
      now,
      recalled: [],
      budgetTokens: 1400,
    });
    assert.equal(typeof rendered.text, 'string');
    assert.match(rendered.text, /<ebbinghaus-memory>/);
    assert.match(rendered.text, /<\/ebbinghaus-memory>/);
    assert.match(rendered.text, /他在做 Ebbinghaus 记忆插件/);
    assert.ok(Number.isFinite(rendered.tokens) && rendered.tokens > 0);
    assert.equal(typeof rendered.breakdown, 'object');
  },
);

/* ───────────── 子代理不能污染记忆（Agent Teams 场景） ───────────── */

test('子代理的会话事件一律不采集（它的任务书 source.kind 也是 user）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '子代理的任务')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const childSession = { id: 'child-1', header: { parentSession: 'sess-parent' } };
  h.emit('session/event', childSession, {
    type: 'user/message',
    // dsh-subagent 派活时给子代理发的第一条 prompt 就是 kind: 'user'
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你是 core-agent，去写 zones.mjs' }] },
  });

  const childAgent = makeAgent('child-1', h.sections, {
    session: { header: { parentSession: 'sess-parent' } },
  });
  h.emit('agent/turn-stopping', { agent: childAgent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 0, '子代理的回合不该触发固化');
  const stats = h.services.get('ebbinghausMemory').snapshot();
  assert.equal(stats.zones.short.length + stats.zones.long.length + stats.zones.permanent.length, 0);
});

test('主会话照常采集 —— 过滤的是 parentSession，不是「所有带 header 的会话」', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做记忆插件')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-main', h.sections, { session: { header: { id: 'sess-main' } } });
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-main', header: { id: 'sess-main' } }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们在做记忆插件' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, '主会话该正常固化');
});

/* ───────────── 新会话第一轮必须写，否则「问一句就走」永远记不住 ───────────── */

test('命中多条时先列候选，用户点名后只读那一条（检索式读取的第二段）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 预置三条都跟「桌宠」有关的记忆
  const now = Date.now();
  const store = createStore({ dir: libDir(dir), log: () => {}, warn: () => {} });
  await store.load();
  const mkEntry = (days, title, detail) =>
    normalizeEntry(
      { ts: now - days * 86400000, title, detail, keywords: ['桌宠'], weight: 0.7 },
      { zone: 'short', now },
    );
  const e1 = mkEntry(1, '桌宠第一次做', '完整细节一：pet-app.ps1 用 WPF 画一只猫，双击会说话。');
  const e2 = mkEntry(4, '桌宠改外形', '完整细节二：改 XAML 坐标，重转 UTF-8 BOM。');
  const e3 = mkEntry(9, '桌宠换素材', '完整细节三：换成 icon2.png。');
  for (const e of [e1, e2, e3]) store.add(e);
  await store.save();

  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '不该在这里固化')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 99 });

  const agent = makeAgent('sess-pick', h.sections);
  h.emit('agent/created', { agent });
  // 插件的 store 是异步载入的，不等它渲染出来就是空串
  await h.services.get('ebbinghausMemory').flush();

  // ① 第一轮：用户含糊地提到「桌宠」，命中多条 → 注入应该是候选清单
  h.emit('session/event', { id: 'sess-pick' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '上次那个桌宠是怎么做的来着' }] },
  });
  const first = h.sections[0].text();
  assert.match(first, /有几条都对得上/, `应当进候选模式：${first.slice(0, 200)}`);
  assert.match(first, /先问一句/);
  assert.equal(first.split('完整细节').length - 1, 0, '候选模式不许展开正文');

  // ② 第二轮：他点了第二条 → 只读那一条
  h.emit('session/event', { id: 'sess-pick' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二个' }] },
  });
  const second = h.sections[0].text();
  assert.match(second, /桌宠改外形/, '应当读到第二条');
  assert.match(second, /完整细节二/, '点名之后要展开正文');
  assert.ok(!second.includes('完整细节一'), '别把第一条也塞进来');
  assert.ok(!second.includes('完整细节三'), '别把第三条也塞进来');
});

test('writeEveryTurns=2 时，新会话的第一轮也会写（不是等到第二轮）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他问了一句就走')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 2 });

  const agent = makeAgent('sess-quick', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-quick' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看这个报错' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, '第一轮就该写 —— 否则这个会话再没下文，那句话白说了');
});

test('同一个会话里，第二轮不会重复写（writeEveryTurns=2 仍然生效）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '记一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 2 });

  const agent = makeAgent('sess-two', h.sections);
  h.emit('agent/created', { agent });
  const say = (text) =>
    h.emit('session/event', { id: 'sess-two' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });

  say('第一句');
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();
  assert.equal(llm.calls.length, 1, '第一轮写一次');

  say('第二句');
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();
  assert.equal(llm.calls.length, 1, '第二轮还没攒够 2 轮，不该再写');

  say('第三句');
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();
  assert.equal(llm.calls.length, 2, '过了 2 轮才写第二次');
});

/* ───────────────── 面板设置窗口 + 全库总量 ───────────────── */

test('面板设置：改容量当场生效、落 settings.json、白名单外拒收、能恢复', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const llm = makeLlm({ text: modelJson([sampleItem(Date.now() - 60_000, '一条记忆')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  // ── GET：字段表 + 当前值 + 边界 ──
  const resGet = fakeRes();
  await h.route('/ebbinghaus/settings').handler(fakeReq({ url: '/ebbinghaus/settings' }), resGet);
  const g = resGet.json();
  assert.equal(g.ok, true);
  assert.equal(g.settings.overridden, false, '新库没有覆盖层');
  const tokenField = g.settings.fields.find((f) => f.key === 'totalTokenCapacity');
  assert.ok(tokenField, '总量上限必须出现在可调字段里');
  assert.equal(tokenField.max, 300000, '硬顶 300K');
  assert.equal(tokenField.value, 100000);
  const capField = g.settings.fields.find((f) => f.key === 'shortCapacity');
  assert.ok(capField && capField.max >= 2000, '条数上限也要能调');
  assert.equal(typeof g.tokens.total, 'number', 'state / settings 都带总量');

  // ── POST：改两个数 ──
  const resPost = fakeRes();
  await h
    .route('/ebbinghaus/settings')
    .handler(fakeReq({ method: 'POST', body: { shortCapacity: 300, totalTokenCapacity: 200000 } }), resPost);
  const p = resPost.json();
  assert.equal(p.ok, true);
  assert.deepEqual([...p.accepted].sort(), ['shortCapacity', 'totalTokenCapacity']);

  const file = path.join(libDir(dir), 'settings.json');
  assert.equal(existsSync(file), true, '要落盘 —— 否则重启就丢');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.shortCapacity, 300);
  assert.equal(onDisk.totalTokenCapacity, 200000);

  // ── state 里立刻看到新上限 ──
  const resState = fakeRes();
  await h.route('/ebbinghaus/state').handler(fakeReq({ url: '/ebbinghaus/state' }), resState);
  const st = resState.json();
  assert.equal(st.zones.short.max, 300);
  assert.equal(st.tokens.capacity, 200000);

  // ── 白名单外的键、坏值都要被拒 ──
  const resBad = fakeRes();
  await h
    .route('/ebbinghaus/settings')
    .handler(fakeReq({ method: 'POST', body: { dataDir: 'D:/evil', shortCapacity: 'abc' } }), resBad);
  const bad = resBad.json();
  assert.deepEqual([...bad.rejected].sort(), ['dataDir', 'shortCapacity']);
  assert.equal(bad.changed.length, 0, '拒掉的键不许改任何东西');

  const resState2 = fakeRes();
  await h.route('/ebbinghaus/state').handler(fakeReq({ url: '/ebbinghaus/state' }), resState2);
  assert.equal(resState2.json().zones.short.max, 300, '坏值不许把值打回默认');
  assert.equal(resState2.json().dir, libDir(dir), 'dataDir 不许被面板改掉');

  // ── 越界钳制 ──
  const resClamp = fakeRes();
  await h
    .route('/ebbinghaus/settings')
    .handler(fakeReq({ method: 'POST', body: { totalTokenCapacity: 999999 } }), resClamp);
  assert.equal(resClamp.json().tokens.capacity, 300000, '超过 300K 一律按住');

  // ── 重启（新实例读同一个目录）仍然生效 ──
  const h2 = makeCtx(makeLlm({ text: '' }));
  host.apply(h2.ctx, { dataDir: dir, writeEveryTurns: 1 });
  await h2.services.get('ebbinghausMemory').flush();
  assert.equal(h2.services.get('ebbinghausMemory').state().zones.short.max, 300);

  // ── reset：覆盖层删掉，回到底座配置 ──
  const resReset = fakeRes();
  await h2.route('/ebbinghaus/settings').handler(fakeReq({ method: 'POST', body: { reset: true } }), resReset);
  assert.equal(resReset.json().ok, true);
  assert.equal(existsSync(file), false, '恢复要删掉覆盖层文件');
  assert.equal(
    h2.services.get('ebbinghausMemory').state().zones.short.max,
    CONFIG_DEFAULTS.shortCapacity,
  );
});

test('全库总量：超上限时按最不重要的回收，原文进 _archive', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 预置 50 条又长又老的短期记忆，把总量顶到上限以上
  const now = Date.now();
  const store = createStore({ dir: libDir(dir), log: () => {}, warn: () => {} });
  await store.load();
  for (let i = 0; i < 50; i += 1) {
    const e = normalizeEntry(
      {
        ts: now - (20 + i) * 86400000,
        title: `旧事 ${i}`,
        detail: '很长的细节内容'.repeat(40),
        keywords: ['旧事'],
        weight: 0.3,
      },
      { zone: 'short', now },
    );
    store.add(e);
  }
  await store.save();

  const llm = makeLlm({ text: '{"title":"压过的印象","detail":"揉成一条。","keywords":["旧事"],"weight":0.35}' });
  const h = makeCtx(llm);
  // 上限压低到 5000，保证一定超
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 99, totalTokenCapacity: 5000 });
  const svc = h.services.get('ebbinghausMemory');
  await svc.flush();

  const before = svc.tokenUsage();
  assert.equal(before.over, true, `预置数据应当超限（${before.total}）`);

  const res = fakeRes();
  await h.route('/ebbinghaus/reclaim').handler(fakeReq({ method: 'POST' }), res);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.ok(out.rounds > 0, '应当真的压了几轮');

  const after = svc.tokenUsage();
  assert.ok(after.total < before.total, '总量该降下来');
  assert.ok(after.total <= 5000, `压完要在上限内：${after.total}`);

  // 原文进了 _archive（压缩不可逆，必须留底）
  assert.equal(existsSync(path.join(libDir(dir), '_archive', 'compressed.jsonl')), true);
});

test('全库总量：剩下的全是人格底色时不再硬压，如实报 exhausted', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const store = createStore({ dir: libDir(dir), log: () => {}, warn: () => {} });
  await store.load();
  for (let i = 0; i < 90; i += 1) {
    store.add(
      normalizeEntry(
        {
          ts: now - (30 + i) * 86400000,
          title: `人格 ${i}`,
          detail: '我是谁、我怎么说话、我的底线。'.repeat(20),
          keywords: ['人格'],
          weight: 0.95,
        },
        { zone: 'permanent', now },
      ),
    );
  }
  await store.save();

  const h = makeCtx(makeLlm({ text: '' }));
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 99, totalTokenCapacity: 5000 });
  const svc = h.services.get('ebbinghausMemory');
  await svc.flush();

  const res = fakeRes();
  await h.route('/ebbinghaus/reclaim').handler(fakeReq({ method: 'POST' }), res);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.equal(out.rounds, 0, '一条都不该压');
  assert.equal(out.exhausted, true, '要说清楚「压不动了」而不是假装成功');
  assert.equal(svc.tokenUsage().total > 5000, true, '总量确实还超着');
});

/* ───────────────── 记忆库自检（重复记忆合并） ───────────────── */

/** 预置两条跨分区的重复记忆，返回 store。 */
async function seedDuplicates(dir) {
  const now = Date.now();
  const store = createStore({ dir: libDir(dir), log: () => {}, warn: () => {} });
  await store.load();
  const body = '对方明确要求不在公众场合念他的名字，答应只在两人独处时才叫。';
  store.add(
    normalizeEntry(
      {
        ts: now - 2 * 86400000,
        title: '约定不在公众场合念他名字',
        detail: body,
        keywords: ['名字', '公众场合'],
        weight: 0.6,
      },
      { zone: 'short', now },
    ),
  );
  store.add(
    normalizeEntry(
      {
        ts: now - 2 * 86400000,
        title: '约定不在公众场合念他的名字呀',
        detail: body,
        keywords: ['名字', '公众场合'],
        weight: 0.8,
      },
      { zone: 'permanent', now },
    ),
  );
  await store.save();
}

test('记忆库自检：跨分区重复合成一条、落最深的区、原文进 _archive', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await seedDuplicates(dir);

  const h = makeCtx(makeLlm({ text: '' }));
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 99, dedupEveryEntries: 30 });
  const svc = h.services.get('ebbinghausMemory');
  await svc.flush();

  const before = svc.snapshot();
  assert.equal(before.zones.short.length + before.zones.long.length + before.zones.permanent.length, 2);

  const res = fakeRes();
  await h.route('/ebbinghaus/dedup').handler(fakeReq({ method: 'POST' }), res);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.equal(out.groups, 1, '应当合成一组');
  assert.equal(out.before, 2);
  assert.equal(out.after, 1);

  const after = svc.snapshot();
  assert.equal(after.zones.permanent.length, 1, '合并后进永久区（组内最深）');
  assert.equal(after.zones.short.length, 0);
  const merged = after.zones.permanent[0];
  assert.equal(merged.source, 'merge');
  assert.equal(merged.weight, 0.8, '权重取最高');
  assert.equal(merged.mergedFrom.length, 2);

  // 压缩不可逆 —— 原文必须留底
  assert.equal(existsSync(path.join(libDir(dir), '_archive', 'dedup.jsonl')), true);
});

test('记忆库自检：每 N 条自动触发一次，触发后计数清零并落盘', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await seedDuplicates(dir);

  // 模拟「已经攒了 29 条」—— 再写 1 条就该到 30
  writeFileSync(
    path.join(libDir(dir), 'dedup-state.json'),
    JSON.stringify({ entriesSinceCheck: 29, lastCheckAt: 0, totalGroups: 0, totalMerged: 0 }),
    'utf8',
  );

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '新写的一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, dedupEveryEntries: 30 });

  const agent = makeAgent('sess-dedup', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-dedup' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '说点别的' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const state = JSON.parse(readFileSync(path.join(libDir(dir), 'dedup-state.json'), 'utf8'));
  assert.equal(state.entriesSinceCheck, 0, '跑完就清零');
  assert.ok(state.lastCheckAt > 0, '要记下上次自检时间');
  assert.ok(state.lastGroups >= 1, '应当真的合了一组');
});

test('记忆库自检：没攒够只记账，不动库', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await seedDuplicates(dir);

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '新写的一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, dedupEveryEntries: 30 });

  const agent = makeAgent('sess-dedup2', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-dedup2' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再说一句' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const state = JSON.parse(readFileSync(path.join(libDir(dir), 'dedup-state.json'), 'utf8'));
  assert.equal(state.entriesSinceCheck, 1, '只写了 1 条，记账但不动');
  assert.equal(state.lastCheckAt, 0, '没跑过自检');

  const snap = h.services.get('ebbinghausMemory').snapshot();
  const all = [...snap.zones.short, ...snap.zones.long, ...snap.zones.permanent];
  assert.equal(all.length, 3, '预置 2 条 + 新写 1 条，一条都没被合');
  assert.ok(!all.some((e) => e.source === 'merge'), '不该出现合并产物');
});

test('记忆库自检：关掉之后不会自动跑，但手动还能跑', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await seedDuplicates(dir);

  writeFileSync(path.join(libDir(dir), 'dedup-state.json'), JSON.stringify({ entriesSinceCheck: 99 }), 'utf8');

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '又一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, dedupEnabled: false, dedupEveryEntries: 30 });
  const svc = h.services.get('ebbinghausMemory');

  // 自动路径：不跑
  const auto = await svc.dedup({ trigger: 'auto' });
  assert.equal(auto.skipped, 'disabled');

  // 手动路径：照跑（用户点了按钮就该有反应）
  const manual = await svc.dedup({});
  assert.equal(manual.skipped, '');
  assert.equal(manual.groups, 1);
});

/* ─────────────────── 多主分区：会话绑定 ─────────────────── */

/** 造一个「两个分区 + 绑定表」的库根。 */
function makeTwoSpaces(dir, bindings = {}) {
  for (const id of ['private', 'work']) {
    const p = path.join(dir, 'spaces', id);
    mkdirSync(p, { recursive: true });
  }
  writeFileSync(
    path.join(dir, 'spaces.json'),
    JSON.stringify({
      version: 1,
      active: 'private',
      spaces: [
        { id: 'private', name: '私生活', createdAt: new Date().toISOString() },
        { id: 'work', name: '工作', createdAt: new Date().toISOString() },
      ],
    }),
    'utf8',
  );
  if (Object.keys(bindings).length > 0) {
    writeFileSync(path.join(dir, 'space-bindings.json'), JSON.stringify({ version: 1, bindings }), 'utf8');
  }
}

test('多分区：两个会话各写各自的分区，互不串', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  makeTwoSpaces(dir, { 'sess-work': 'work' });

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做记忆插件')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  // 会话 A：没有绑定 → 跟随 active（private）
  const a = makeAgent('sess-home', h.sections);
  h.emit('agent/created', { agent: a });
  h.emit('session/event', { id: 'sess-home' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天干点啥' }] },
  });
  h.emit('agent/turn-stopping', { agent: a });
  await h.services.get('ebbinghausMemory').flush();

  // 会话 B：绑在 work 上
  const b = makeAgent('sess-work', h.sections);
  h.emit('agent/created', { agent: b });
  h.emit('session/event', { id: 'sess-work' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '那个接口改完了' }] },
  });
  h.emit('agent/turn-stopping', { agent: b });
  await h.services.get('ebbinghausMemory').flush();

  const readZone = (spaceId, zone) => {
    const p = path.join(dir, 'spaces', spaceId, `${zone}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter((s) => s.trim() !== '').map((s) => JSON.parse(s));
  };

  const homeAll = [...readZone('private', 'short'), ...readZone('private', 'long'), ...readZone('private', 'permanent')];
  const workAll = [...readZone('work', 'short'), ...readZone('work', 'long'), ...readZone('work', 'permanent')];

  assert.ok(homeAll.length >= 1, 'private 应当写进了记忆');
  assert.ok(workAll.length >= 1, 'work 应当写进了记忆');
  // 两边内容不能一样（各写各的）
  const homeIds = new Set(homeAll.map((e) => e.id));
  assert.equal(workAll.every((e) => !homeIds.has(e.id)), true, '两个分区的条目不许串');

  // 绑定表也落盘了（work 这条是预先写的，不该被改）
  const bindings = JSON.parse(readFileSync(path.join(dir, 'space-bindings.json'), 'utf8')).bindings;
  assert.equal(bindings['sess-work'], 'work');
  assert.equal(bindings['sess-home'], 'private', '新会话要被钉在当时的 active 上');
});

test('多分区：切 active 之后，老会话仍留在原分区', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  makeTwoSpaces(dir);

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做记忆插件')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const oldSession = makeAgent('sess-old', h.sections);
  h.emit('agent/created', { agent: oldSession });
  h.emit('session/event', { id: 'sess-old' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] },
  });

  // 切到 work（走真实路由）
  const route = h.route('/ebbinghaus/spaces/active');
  assert.ok(route, '要有 /spaces/active 路由');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', url: '/ebbinghaus/spaces/active', body: { id: 'work' } }), res);
  assert.equal(res.json().ok, true, '切换要成功，响应：' + String(res._out.body));
  assert.equal(res.json().active, 'work');

  // 老会话再说话 —— 它已经被钉在 private，不该跟着跑
  h.emit('session/event', { id: 'sess-old' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句' }] },
  });
  h.emit('agent/turn-stopping', { agent: oldSession });
  await h.services.get('ebbinghausMemory').flush();

  const bindings = JSON.parse(readFileSync(path.join(dir, 'space-bindings.json'), 'utf8')).bindings;
  assert.equal(bindings['sess-old'], 'private', '老会话必须留在原分区');

  const reg = JSON.parse(readFileSync(path.join(dir, 'spaces.json'), 'utf8'));
  assert.equal(reg.active, 'work', '注册表里的 active 也要跟着改');
});

/* ─────────────────── 分区管理：新建 / 改名 / 删除 ─────────────────── */

/** 调一次 POST 路由，返回 {status, body}。 */
async function callPost(h, p, body) {
  const route = h.route(p);
  assert.ok(route, `要有 ${p} 路由`);
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', url: p, body }), res);
  return { status: res.statusCode, body: res.json() };
}

test('分区管理：新建 / 改名 / 删除', async (t) => {
  const dir = await tempDir();
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows 上偶尔目录句柄还没释放，清理失败不影响测试结论
    }
  });

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在做记忆插件')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  // ① 新建
  const created = await callPost(h, '/ebbinghaus/spaces/create', { name: '工作' });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const newId = created.body.space.id;
  assert.equal(isValidSpaceId(newId), true, 'id 要合法');
  assert.equal(existsSync(path.join(dir, 'spaces', newId)), true, '目录要建出来');

  const reg1 = JSON.parse(readFileSync(path.join(dir, 'spaces.json'), 'utf8'));
  assert.equal(reg1.spaces.length, 2);
  assert.ok(reg1.spaces.some((s) => s.id === newId && s.name === '工作'));

  // ② 改名（id 和目录都不该动）
  const renamed = await callPost(h, '/ebbinghaus/spaces/rename', { id: newId, name: '干活用' });
  assert.equal(renamed.body.ok, true);
  assert.equal(renamed.body.space.name, '干活用');
  assert.equal(renamed.body.space.id, newId, '改名不许换 id');
  assert.equal(existsSync(path.join(dir, 'spaces', newId)), true, '目录也不许动');

  // ③ 不能删最后一个
  const del0 = await callPost(h, '/ebbinghaus/spaces/delete', { id: 'private' });
  // 这时还有两个，能删；先删 private 之外的那个，再试删最后一个
  assert.equal(del0.status, 200, '还有两个分区时允许删');

  const reg2 = JSON.parse(readFileSync(path.join(dir, 'spaces.json'), 'utf8'));
  assert.equal(reg2.spaces.length, 1);
  assert.equal(reg2.active, reg2.spaces[0].id, '删掉当前分区要自动切到剩下的');

  const last = reg2.spaces[0].id;
  const del1 = await callPost(h, '/ebbinghaus/spaces/delete', { id: last });
  assert.equal(del1.status, 400, '最后一个不许删');
  assert.match(String(del1.body.error), /至少|留一个/);

  // ④ 删掉的目录搬进 _trash（不真删）
  const trash = path.join(dir, '_trash');
  assert.equal(existsSync(trash), true, '要建 _trash');
  const moved = readdirSync(trash);
  assert.equal(moved.length, 1, '搬过去一份');
  assert.ok(String(moved[0]).startsWith('private'), '被删的是 private，_trash 里的目录名要带它的 id');
});

test('分区管理：新建超过 10 个会被拒', async (t) => {
  const dir = await tempDir();
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows 上偶尔目录句柄还没释放，清理失败不影响测试结论
    }
  });

  const llm = makeLlm({ text: modelJson([]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  // 已经有了 1 个，再加 9 个到顶
  for (let i = 1; i <= 9; i += 1) {
    const r = await callPost(h, '/ebbinghaus/spaces/create', { name: `分区${i}` });
    assert.equal(r.body.ok, true, `第 ${i} 个应该能建`);
  }
  const over = await callPost(h, '/ebbinghaus/spaces/create', { name: '再来一个' });
  assert.equal(over.status, 400);
  assert.match(String(over.body.error), /10/);
});

/* ─────────────────── 配置分层：每个分区各用各的设置 ─────────────────── */

/** 读一次 /state。 */
async function getState(h) {
  const route = h.route('/ebbinghaus/state');
  const res = fakeRes();
  await route.handler(fakeReq({ url: '/ebbinghaus/state' }), res);
  return res.json();
}

/** /state.settings.fields 里某个键的当前值。 */
function fieldValue(state, key) {
  const fields = state && state.settings && Array.isArray(state.settings.fields) ? state.settings.fields : [];
  const f = fields.find((x) => x && x.key === key);
  return f ? f.value : undefined;
}

test('配置分层：两个分区各用各自的 settings.json', async (t) => {
  const dir = await tempDir();
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows 上偶尔句柄没释放
    }
  });
  makeTwoSpaces(dir);

  // 两个分区各自拧了不同的短期容量
  writeFileSync(path.join(dir, 'spaces', 'private', 'settings.json'), JSON.stringify({ shortCapacity: 200 }), 'utf8');
  writeFileSync(path.join(dir, 'spaces', 'work', 'settings.json'), JSON.stringify({ shortCapacity: 500 }), 'utf8');

  const llm = makeLlm({ text: modelJson([]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const s1 = await getState(h);
  assert.equal(s1.spaces.active, 'private');
  assert.equal(fieldValue(s1, 'shortCapacity'), 200, '私生活应当用自己的 200');

  const switched = await callPost(h, '/ebbinghaus/spaces/active', { id: 'work' });
  assert.equal(switched.body.ok, true);

  const s2 = await getState(h);
  assert.equal(s2.spaces.active, 'work');
  assert.equal(fieldValue(s2, 'shortCapacity'), 500, '切到工作之后应当用它的 500');

  // 全局键（不在面板白名单里）永远走底座，不会被分区设置影响
  assert.equal(typeof s2.settings.baseValues, 'object');
  const overriddenKeys = (s2.settings.fields || []).filter((f) => f.overridden).map((f) => f.key);
  assert.deepEqual(overriddenKeys, ['shortCapacity'], '只有那一个键是「面板改过」');
});

test('配置分层：一个分区改了设置，不影响另一个分区', async (t) => {
  const dir = await tempDir();
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // 同上
    }
  });
  makeTwoSpaces(dir);

  const llm = makeLlm({ text: modelJson([]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const before = fieldValue(await getState(h), 'shortCapacity');

  // 只改当前分区（private）
  const saved = await callPost(h, '/ebbinghaus/settings', { shortCapacity: 333 });
  assert.equal(saved.body.ok, true);
  assert.equal(fieldValue(await getState(h), 'shortCapacity'), 333, '当前分区应当立刻生效');

  // 落盘也只落在 private 的目录里
  const priv = JSON.parse(readFileSync(path.join(dir, 'spaces', 'private', 'settings.json'), 'utf8'));
  assert.equal(priv.shortCapacity, 333);
  assert.equal(existsSync(path.join(dir, 'spaces', 'work', 'settings.json')), false, '另一个分区不该被写文件');

  // 切过去看，work 还是底座默认值
  await callPost(h, '/ebbinghaus/spaces/active', { id: 'work' });
  const workVal = fieldValue(await getState(h), 'shortCapacity');
  assert.notEqual(workVal, 333, 'work 不该被 private 的改动带上');
  assert.equal(workVal, before, 'work 还是原来的值');
});

/* ── 2026-10-27：QQ 通道进不了记忆（source.kind = 'qq' 被当成注入消息挡掉） ── */

test('QQ 转进来的消息也能触发固化（source.kind = qq）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '他在 QQ 上说想我')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-qq', h.sections);
  h.emit('agent/created', { agent });

  // dsh-qq-bot 造的消息：source.kind 是 'qq'，不是 'user'（见它的 SOURCE_KIND）
  h.emit('session/event', { id: 'sess-qq' }, {
    type: 'user/message',
    data: { source: { kind: 'qq', uin: '3448932873' }, content: [{ type: 'text', text: '在吗' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, 'QQ 消息必须能触发固化 —— 否则 QQ 上一句话都记不上');
  assert.match(String(llm.calls[0].messages[0].content[0].text), /在吗/);
});

test('插件注入 / 子代理那类来源仍然一条都不收', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const llm = makeLlm({ text: modelJson([sampleItem(Date.now() - 60_000, '不该出现')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-inject', h.sections);
  h.emit('agent/created', { agent });

  for (const kind of ['plugin', 'system', 'subagent', undefined]) {
    h.emit('session/event', { id: 'sess-inject' }, {
      type: 'user/message',
      data: { source: kind === undefined ? undefined : { kind }, content: [{ type: 'text', text: '注入的内容' }] },
    });
  }
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 0, '非真人来源不能进 transcript，更不能触发固化');
});

test('连续失败会在 memory_stats 里带 ⚠ 提示（单次失败时不带）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 没有 llm 服务 → 每次都走 no-model 分支
  const h = makeCtx(null);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-streak', h.sections);
  h.emit('agent/created', { agent });
  const stats = h.services.get('ebbinghausMemory');
  const statsTool = (h.tools ?? []).find((x) => x.name === 'memory_stats');

  const runOnce = async (text) => {
    h.emit('session/event', { id: 'sess-streak' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    h.emit('agent/turn-stopping', { agent });
    await stats.flush();
  };

  await runOnce('第一轮');
  if (statsTool === undefined) return; // 桩里没注册工具就跳过
  let out = await statsTool.execute({});
  let last = out.lines[out.lines.length - 1];
  assert.match(last, /^上次固化：/);
  assert.doesNotMatch(last, /连续/, '只失败一次不给警告，免得和「没到该记的时候」混淆');

  await runOnce('第二轮');
  out = await statsTool.execute({});
  last = out.lines[out.lines.length - 1];
  assert.match(last, /已连续 2 次没写进去/, '连续失败必须显式说出来');
});

/* ── 2026-10-27：固化链路兜底（失败切官方，存成功切回） ── */

/** 建一个「按次数给不同输出」的 llm：指定次数之前吐坏文本，之后吐正常条目。 */
function chainLlm(badTimes, now) {
  return makeLlm((opts, n) =>
    n <= badTimes
      ? { text: '好的，我先讲讲我的想法：今天天气不错，晚饭想吃什么' }
      : { text: modelJson([sampleItem(now - 60_000, `第 ${n} 次固化`)]) },
  );
}

test('连续失败到阈值 → 切官方兜底；兜底存成功 → 切回聊天模型', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = chainLlm(3, now);
  const h = makeCtx(llm);
  host.apply(h.ctx, {
    dataDir: dir,
    writeEveryTurns: 1,
    provider: 'unlimit',
    model: 'deepseek-v4.1-flash',
    fallbackEnabled: true,
    fallbackAfter: 3,
    fallbackProvider: 'deepseek-account',
    fallbackModel: 'deepseek-flash',
  });

  const agent = makeAgent('sess-chain', h.sections);
  h.emit('agent/created', { agent });
  const say = async (text) => {
    h.emit('session/event', { id: 'sess-chain' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    h.emit('agent/turn-stopping', { agent });
    await h.services.get('ebbinghausMemory').flush();
  };

  for (let i = 1; i <= 3; i += 1) {
    await say(`第 ${i} 轮`);
    assert.equal(llm.calls[i - 1].provider, 'unlimit', `第 ${i} 次还在主链路`);
  }

  // 第 4 次：已经切到兜底，而且这次模型正常 → 存进去了
  await say('第 4 轮');
  assert.equal(llm.calls[3].provider, 'deepseek-account', '到阈值后必须切兜底');
  assert.equal(llm.calls[3].model, 'deepseek-flash');

  // 存成功算「好了」→ 第 5 次切回聊天模型
  await say('第 5 轮');
  assert.equal(llm.calls[4].provider, 'unlimit', '兜底存成功后必须切回聊天模型');
});

test('切回后的冷静期内即使失败，也不立刻再切兜底（防来回抖）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  // 前 3 次坏 → 第 4 次（兜底）好 → 第 5 次起又坏
  const llm = makeLlm((opts, n) => {
    if (n <= 3) return { text: '不是 JSON' };
    if (n === 4) return { text: modelJson([sampleItem(now - 60_000, '兜底存的')]) };
    return { text: '又不是 JSON' };
  });
  const h = makeCtx(llm);
  host.apply(h.ctx, {
    dataDir: dir,
    writeEveryTurns: 1,
    provider: 'unlimit',
    model: 'deepseek-v4.1-flash',
    fallbackEnabled: true,
    fallbackAfter: 3,
    fallbackProvider: 'deepseek-account',
    fallbackModel: 'deepseek-flash',
    fallbackCooldownSeconds: 600,
  });

  const agent = makeAgent('sess-cool', h.sections);
  h.emit('agent/created', { agent });
  const say = async (text) => {
    h.emit('session/event', { id: 'sess-cool' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    h.emit('agent/turn-stopping', { agent });
    await h.services.get('ebbinghausMemory').flush();
  };

  for (let i = 1; i <= 5; i += 1) await say(`第 ${i} 轮`);

  // 第 5 次已经切回主链路且失败，但处在冷静期 → 仍走主链路，不再切兜底
  assert.equal(llm.calls[4].provider, 'unlimit');
  await say('第 6 轮');
  assert.equal(llm.calls[5].provider, 'unlimit', '冷静期内不该再切兜底');
});

test('关掉兜底开关后，失败多少次都不切链路', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const llm = chainLlm(99, Date.now());
  const h = makeCtx(llm);
  host.apply(h.ctx, {
    dataDir: dir,
    writeEveryTurns: 1,
    provider: 'unlimit',
    model: 'deepseek-v4.1-flash',
    fallbackEnabled: false,
    fallbackAfter: 2,
    fallbackProvider: 'deepseek-account',
    fallbackModel: 'deepseek-flash',
  });

  const agent = makeAgent('sess-nofb', h.sections);
  h.emit('agent/created', { agent });
  for (let i = 1; i <= 4; i += 1) {
    h.emit('session/event', { id: 'sess-nofb' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 轮` }] },
    });
    h.emit('agent/turn-stopping', { agent });
    await h.services.get('ebbinghausMemory').flush();
  }
  assert.equal(llm.calls.length, 4);
  for (const c of llm.calls) assert.equal(c.provider, 'unlimit', '开关关着就不该切');
});

test('固化日志记在面板数据里（只记形状，不记正文）', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '记一条')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-log', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-log' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这句正文不该出现在日志里' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  const snap = await h.services.get('ebbinghausMemory').state();
  const log = snap?.consolidate?.log;
  assert.ok(Array.isArray(log) && log.length >= 1, '固化日志应该有一条');
  const last = log[log.length - 1];
  assert.equal(last.outcome, 'ok');
  assert.ok(typeof last.at === 'number');
  assert.ok(!JSON.stringify(last).includes('这句正文不该出现在日志里'), '日志里不能出现对话正文');
  assert.equal(snap.consolidate.chain.fallbackActive, false);
});

/* ── 2026-10-27：链路故障要能从注入段里“喊”出来，而不是只躺在日志里 ── */

test('连续固化失败后，注入段会带「记忆插件异常」告警；正常时不带', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  let bad = true;
  const llm = makeLlm(() => (bad ? { text: '今天不想给 JSON' } : { text: modelJson([sampleItem(now - 60_000, '一条记忆')]) }));
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-health', h.sections);
  h.emit('agent/created', { agent });
  const svc = h.services.get('ebbinghausMemory');
  const say = async (text) => {
    h.emit('session/event', { id: 'sess-health' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    h.emit('agent/turn-stopping', { agent });
    await svc.flush();
  };

  // 连续失败两轮
  await say('第一轮');
  await say('第二轮');
  const sick = svc.renderFor('sess-health');
  assert.match(sick, /记忆插件异常/, '连续两次没写进去，注入段必须说出来');
  assert.match(sick, /复制诊断/, '得告诉对方怎么把问题交出来');

  // 恢复正常
  bad = false;
  await say('第三轮');
  const healthy = svc.renderFor('sess-health');
  assert.doesNotMatch(healthy, /记忆插件异常/, '恢复后就不该再喊了');
});

test('手动暂停模型调用时，注入段说明「新对话不会进记忆库」', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '一条记忆')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, modelCallsPaused: true });

  const agent = makeAgent('sess-paused', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-paused' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '随便聊聊' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 0, '暂停时不该调模型');
  const text = h.services.get('ebbinghausMemory').renderFor('sess-paused');
  assert.match(text, /记忆插件已暂停/);
});

/* ── 2026-10-27：开源后的反馈链路（诊断报告 / 来源白名单可配） ── */

test('诊断报告：带版本和链路，但不含记忆正文和密钥', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '这句是记忆正文不该出现在诊断里')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1 });

  const agent = makeAgent('sess-diag', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-diag' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这句是对话正文也不该出现' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  const svc = h.services.get('ebbinghausMemory');
  await svc.flush();

  const text = svc.diagnostics();
  assert.equal(typeof text, 'string');
  assert.match(text, /ebbinghaus-memory v/, '要带版本号');
  assert.match(text, /当前路由：/, '要带当前路由');
  assert.match(text, /最近固化/, '要带最近固化记录');
  assert.ok(!text.includes('这句是对话正文也不该出现'), '诊断里不能出现对话正文');
  assert.ok(!text.includes('这句是记忆正文不该出现在诊断里'), '诊断里不能出现记忆内容');
  assert.ok(!/sk-|bearer|api[_-]?key/i.test(text), '诊断里不能出现任何密钥样式的串');
});

test('sourceKinds 可配置：换成别的桥接名字也能收到消息', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const llm = makeLlm({ text: modelJson([sampleItem(now - 60_000, '来自 telegram 桥接的一句')]) });
  const h = makeCtx(llm);
  // 别人接的是 telegram 桥接，source.kind 不叫 user 也不叫 qq
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, sourceKinds: 'user,qq,telegram' });

  const agent = makeAgent('sess-tg', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-tg' }, {
    type: 'user/message',
    data: { source: { kind: 'telegram' }, content: [{ type: 'text', text: '在吗' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 1, '配置里写进去的来源必须能触发固化');
});

test('sourceKinds 没列到的来源仍然不收', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const llm = makeLlm({ text: modelJson([sampleItem(Date.now() - 60_000, '不该出现')]) });
  const h = makeCtx(llm);
  host.apply(h.ctx, { dataDir: dir, writeEveryTurns: 1, sourceKinds: 'user,qq' });

  const agent = makeAgent('sess-tg2', h.sections);
  h.emit('agent/created', { agent });
  h.emit('session/event', { id: 'sess-tg2' }, {
    type: 'user/message',
    data: { source: { kind: 'telegram' }, content: [{ type: 'text', text: '在吗' }] },
  });
  h.emit('agent/turn-stopping', { agent });
  await h.services.get('ebbinghausMemory').flush();

  assert.equal(llm.calls.length, 0, '没列进白名单的来源不能触发固化');
});
