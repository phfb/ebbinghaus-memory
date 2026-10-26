/**
 * 预览：把此刻**真正会注入给模型**的那段记忆打出来。
 *
 * 这个插件平时看不见自己的输出 —— 只能从模型的反应去猜。而「注入读起来像不像
 * 记忆」这件事，光看代码判断不了，必须把渲染结果打出来看。
 *
 * 用法：
 *   & "…\node.exe" tools\preview-injection.mjs
 *   & "…\node.exe" tools\preview-injection.mjs --dir "D:/别的库"
 *   & "…\node.exe" tools\preview-injection.mjs --query "上次那个记忆插件怎么改的"
 *
 * 它用一个**真的 cordis Context** 挂载插件（跟 DSH 启动时走的是同一套插件机制），
 * 所以这里能跑通，基本就等于「装上去能跑」。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROJECT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const dataDir =
  arg('--dir', '') ||
  (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'ebbinghaus-memory') : '');
const query = arg('--query', '');

if (dataDir === '') {
  console.log('找不到记忆库目录：请设置 DSH_HOME 环境变量，或者用 --dir 指定。');
  process.exit(1);
}

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

const cordisPath = findCordis();
if (cordisPath === null) {
  console.log('找不到 DSH 自带的 cordis，没法模拟挂载。设 DSH_APP_DIR 再跑。');
  process.exit(1);
}

const { Context } = await import(pathToFileURL(cordisPath).href);
const plugin = await import(pathToFileURL(path.join(PROJECT, 'src/host/index.mjs')).href);

console.log(`库目录：${dataDir}`);
if (!existsSync(dataDir)) {
  console.log('这个目录还不存在 —— 插件启动时会自己建一个空库。');
}

const ctx = new Context();
ctx.on('internal/error', () => {});
const ctxPlugin = ctx.plugin(plugin, { dataDir, debugLog: false });
await new Promise((r) => setTimeout(r, 500));

const svc = ctx.get('ebbinghausMemory');
if (!svc) {
  console.log('插件没起来（拿不到 ebbinghausMemory 服务）。');
  process.exit(1);
}

const st = svc.state(query || undefined);
const z = st.zones || {};
console.log('');
console.log('── 三区容量 ─────────────────────────────────');
for (const k of ['short', 'long', 'permanent']) {
  const x = z[k] || {};
  const pct = Math.round((Number(x.ratio) || 0) * 100);
  const bar = '█'.repeat(Math.round(pct / 4)) + '░'.repeat(25 - Math.round(pct / 4));
  console.log(
    `  ${x.label ?? k}\t${bar} ${x.count ?? 0}/${x.max ?? 0} (${pct}%)` +
      (x.expired ? ` · 已到期 ${x.expired}` : '') +
      (typeof x.nextInDays === 'number' ? ` · 最近 ${x.nextInDays} 天到期` : ''),
  );
}
if (query) {
  console.log(`\n检索「${query}」命中 ${(st.hits || []).length} 条：`);
  for (const h of st.hits || []) console.log(`  · [${h.relative}] ${h.title}  (${h.zone} · ${h.weight})`);
}

// 这里是重点：真·注入内容
const injection = svc.renderFor('preview-session');
console.log('');
console.log('── 这一轮会注入给模型的内容 ─────────────────');
console.log(injection === '' ? '（空的 —— 库里没有可注入的记忆，或者预算被裁到 0）' : injection);

const stats = svc.snapshot();
console.log('');
console.log(`── 库里一共 ${(stats.zones.short?.length ?? 0) + (stats.zones.long?.length ?? 0) + (stats.zones.permanent?.length ?? 0)} 条 ──`);
for (const k of ['short', 'long', 'permanent']) {
  const list = stats.zones[k] || [];
  if (list.length === 0) continue;
  console.log(`\n[${k}] 最近 3 条：`);
  for (const e of list.slice(-3)) {
    const d = new Date(e.ts);
    const stamp = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    console.log(`  ${stamp} · ${e.title}  [w=${e.weight} d=${e.depth} kw=${(e.keywords || []).slice(0, 3).join('/')}]`);
  }
}

try {
  await ctxPlugin?.dispose?.();
} catch {
  // 卸载失败不影响预览结果
}
