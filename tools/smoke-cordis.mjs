/**
 * 冒烟：把插件真的塞进**真的 cordis**里跑一遍 apply。
 *
 * 为什么需要这一步 —— `node --test` 里的 ctx 全是手写桩，它能证明「逻辑对」，
 * 但证明不了「cordis 认这个插件形状」。而这两件事的失败方式完全不同：
 * 逻辑错会在日志里说话，插件形状错会让**整个组合加载失败**，用户看到的是
 * DSH 起不来，且没有任何一行字指向这里。
 *
 * 用法（node 不在 PATH，用全路径）：
 *
 *   & "你的 node.exe" tools\smoke-cordis.mjs
 *
 * 它做三件事：
 *   1. 用 DSH 自带的 cordis 建一个 Context
 *   2. 把插件挂上去（真的走 cordis 的插件生命周期）
 *   3. 手动发一个 `session/event` + `agent/turn-stopping`，确认回调不炸
 *
 * 找不到 cordis 就**跳过**并说明原因（这个脚本不该成为装插件的硬依赖）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROJECT = path.resolve(HERE, '..');

/** DSH 桌面端的 app 目录（未打包那半）。找不到就试常见路径。 */
function findCordis() {
  const candidates = [
    process.env.DSH_APP_DIR ? path.join(process.env.DSH_APP_DIR, 'node_modules') : null,
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app/node_modules'),
  ].filter(Boolean);

  for (const base of candidates) {
    const p = path.join(base, '@deepseek-ai/cordis/lib/index.js');
    if (existsSync(p)) return p;
  }
  return null;
}

function line(s = '') {
  console.log(s);
}

const cordisPath = findCordis();
if (cordisPath === null) {
  line('跳过：找不到 DSH 自带的 cordis（设 DSH_APP_DIR 指到 resources/app 再跑）。');
  process.exit(0);
}

line(`cordis: ${cordisPath}`);
const cordis = await import(pathToFileURL(cordisPath).href);
const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default;
if (typeof Context !== 'function') {
  line('失败：cordis 没导出 Context。');
  process.exit(1);
}

// 记忆库写到临时目录，绝不碰用户的正式库
const tmpDir = path.join(process.env.TEMP ?? '.', `eb-smoke-${Date.now()}`);

const plugin = await import(pathToFileURL(path.join(PROJECT, 'src/host/index.mjs')).href);
line(`插件导出：${Object.keys(plugin).join(', ')}`);

const ctx = new Context();
const errors = [];
ctx.on('internal/error', (e) => errors.push(e));
// cordis 的 logger 在 headless 下没人接，这里接住
const logs = [];
ctx.provide('logger', {
  debug: (m) => logs.push(['debug', String(m)]),
  info: (m) => logs.push(['info', String(m)]),
  warn: (m) => logs.push(['warn', String(m)]),
  error: (m) => logs.push(['error', String(m)]),
});

let fiber;
try {
  fiber = ctx.plugin(plugin, { dataDir: tmpDir, debugLog: true, writeEveryTurns: 1 });
} catch (err) {
  line(`失败：ctx.plugin 抛错 —— ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
line('ctx.plugin 接受（cordis 认这个插件形状）');

// 给插件一点时间做异步载入（store.load 是异步的）
await new Promise((r) => setTimeout(r, 400));

// 手动发两条事件：采集 + 闸门。不该抛错，也不该发起模型调用（没有 llm 服务）
try {
  ctx.emit('session/event', { id: 'smoke-session' }, {
    type: 'user/message',
    seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们在做记忆插件' }] },
  });
  ctx.emit('session/event', { id: 'smoke-session' }, {
    type: 'assistant/message',
    seq: 2,
    data: { message: { content: [{ type: 'text', text: '好' }] } },
  });
  ctx.emit('agent/turn-stopping', { agent: { id: 'smoke-session' } });
  line('session/event + turn-stopping 回调没炸');
} catch (err) {
  line(`失败：事件回调抛错 —— ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 300));

const warnLines = logs.filter(([lvl]) => lvl === 'warn' || lvl === 'error');
line(`日志 ${logs.length} 行，其中 warn/error ${warnLines.length} 行`);
for (const [lvl, m] of warnLines.slice(0, 8)) line(`  [${lvl}] ${m}`);

try {
  await fiber?.dispose?.();
} catch (err) {
  line(`卸载时抛错（不致命）：${err instanceof Error ? err.message : String(err)}`);
}

line('');
line('结论：插件能被真 cordis 加载、挂载、收事件、卸载。');
line('注意：这一步**测不到**注入段和 HTTP 面板 —— 那两个要真起来一个 web 组合才算。');
