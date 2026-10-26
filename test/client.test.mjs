/**
 * 客户端半边的测试 —— 用桩 React 把 bundle 在 Node 里真跑一遍。
 *
 * 为什么值得写：客户端半边是这个项目里**唯一没有自动化覆盖**的部分。
 * 它的失效方式全都是静默的 —— id 写错、slot 名拼错、require 了平台不提供的
 * 模块、渲染时抛错，症状都是「侧栏图标不出现」，没有任何报错指向这里。
 *
 * 这一组不替代真浏览器验证，但它能挡住上面那几类，而且能进 CI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SRC = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8');
const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** 去掉注释后的纯代码：查「有没有偷用 JSX / ESM import」必须剥注释，
 *  否则会匹配到文件里「不能 import 项目文件」这句说明自己。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * 一个够用的桩 React。
 *
 * 关键：**hook 槽位跨渲染保留，游标每次渲染归零**。两件事混在一起（每次渲染
 * 都清空槽位）会得到一个永远停在首帧的组件 —— 所有渲染测试就只看到「翻记忆…」。
 *
 * `useEffect` 同步执行且**不跑 cleanup**：真实 React 只在卸载或依赖变化时跑
 * cleanup，而面板的 cleanup 会把 alive 置 false，一跑后面所有 setState 都被丢掉。
 */
function makeStubReact() {
  let hooks = [];
  let cursor = 0;
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      // 真实 React 把 children 放进 props.children —— 必须照做，
      // 否则 Section / Empty 这类拿 props.children 的组件渲染出来是空的。
      return { type, props: { ...(props ?? {}), children: kids.length === 1 ? kids[0] : kids }, children: kids };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (next) => {
          hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
        },
      ];
    },
    useEffect(fn) {
      fn();
    },
    beginRender() {
      cursor = 0;
    },
    reset() {
      hooks = [];
      cursor = 0;
    },
  };
}

/** 把元素树摊平成纯文本。函数组件会被就地展开（子组件不持 hook，展开安全）。 */
function flat(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) flat(n, out);
    return out;
  }
  if (typeof node.type === 'function') return flat(node.type(node.props ?? {}), out);
  for (const c of node.children ?? []) flat(c, out);
  return out;
}
const textOf = (node) => flat(node).join(' ');

/** 在树里找所有满足条件的**宿主**元素（函数组件先展开）。 */
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out);
    return out;
  }
  if (typeof node.type === 'function') {
    findAll(node.type(node.props ?? {}), pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findAll(c, pred, out);
  return out;
}
const buttonsOf = (node) => findAll(node, (n) => n.type === 'button');
const buttonByText = (node, text) => buttonsOf(node).find((b) => textOf(b).includes(text));

/** 在一个假 window 里加载 bundle，拿到插件对象；顺带记下 fetch 调用。 */
function loadClient({ react, fetchImpl } = {}) {
  const R = react ?? makeStubReact();
  const loaded = [];
  const required = [];
  const calls = [];
  const fetchStub = (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    return (fetchImpl ?? (() => Promise.reject(new Error('测试没给 fetch'))))(url, opts);
  };
  const sandbox = {
    console,
    encodeURIComponent,
    fetch: fetchStub,
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded.push(spec);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'src/client/index.js' });

  assert.equal(loaded.length, 1, '客户端 bundle 必须**恰好注册一次**模块');
  const spec = loaded[0];
  const plugin = spec.factory((name) => {
    required.push(name);
    if (name === 'react') return R;
    throw new Error(`客户端 require 了平台基础表之外的模块：${name}`);
  });
  return { spec, plugin, required, calls, react: R };
}

/** 造一个假 ctx，记录 slot 注册。 */
function makeSlotCtx() {
  const registered = [];
  const injects = [];
  const ctx = {
    slots: {
      inject(key, cb) {
        injects.push(key);
        cb();
        return () => {};
      },
      register(def, component) {
        registered.push({ def, component });
        return () => {};
      },
    },
  };
  return { ctx, registered, injects };
}

/** 装好插件并取到 Panel 组件。 */
function mount(opts = {}) {
  const boot = loadClient(opts);
  const { ctx, registered, injects } = makeSlotCtx();
  boot.plugin.apply(ctx);
  const panel = registered.find((r) => r.def.name === 'main').component;
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist').component;
  return { ...boot, registered, injects, panel, icon };
}

/** 渲染到「数据已就位」。桩的 effect 同步跑，所以要给微任务一个落定的机会。 */
async function renderSettled(panel, react, times = 1) {
  react.reset();
  react.beginRender();
  let tree = panel({});
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    react.beginRender();
    tree = panel({});
  }
  return tree;
}

/** 同步渲染一次（游标归零，状态保留）。 */
function renderNow(panel, react) {
  react.beginRender();
  return panel({});
}

/**
 * 打字 → 回车 → 等响应落定。
 *
 * 为什么这么多步：受控 input 的值要经过**一次重渲染**才会进新闭包，
 * 而提交后的响应是微任务，必须等它落定再渲染才看得到结果。
 * 少一步的表现都是「测试看到的是上一帧」，跟真 bug 长得一模一样。
 */
async function search(panel, react, text) {
  let tree = renderNow(panel, react);
  findAll(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: text } });
  tree = renderNow(panel, react);
  findAll(tree, (n) => n.type === 'input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  tree = renderNow(panel, react);
  await new Promise((r) => setTimeout(r, 0));
  return renderNow(panel, react);
}

/** 点一个按钮，等它的请求落定，再渲染一次。 */
async function clickAndSettle(panel, react, button) {
  button.props.onClick();
  renderNow(panel, react);
  await new Promise((r) => setTimeout(r, 0));
  return renderNow(panel, react);
}

/* ───────────────────────── 夹具 ───────────────────────── */

const NOW = 1761321600000;

function entry(i, over = {}) {
  return {
    id: `em-${String(i).padStart(2, '0')}`,
    ts: NOW - i * 86400000,
    iso: '2026-10-24T21:30:00+08:00',
    zone: 'short',
    weight: 0.7,
    title: `第 ${i} 条记忆`,
    detail: `这一条讲的是第 ${i} 件事，细节在这里。`,
    keywords: ['记忆', '测试'],
    depth: 0,
    source: 'chat',
    stamp: '10-24 21:30',
    relative: `${i} 天前 21:30`,
    ...over,
  };
}

/** 与 host 对齐后的响形状（SPEC §12.9 冻结版） */
function payload(over = {}) {
  return {
    ok: true,
    ready: true,
    degraded: false,
    dir: 'C:/Users/you/dsh-home/ebbinghaus-memory',
    now: NOW,
    query: '',
    hits: [],
    total: 8,
    zones: {
      short: {
        label: '短期',
        count: 5,
        max: 60,
        ratio: 0.08,
        nextInDays: 3,
        expired: 0,
        entries: [entry(1), entry(2, { depth: 2, weight: 0.82 }), entry(3), entry(4), entry(5)],
      },
      long: {
        label: '长期',
        count: 2,
        max: 40,
        ratio: 0.05,
        nextInDays: null,
        expired: 1,
        entries: [entry(6)],
      },
      permanent: {
        label: '永久',
        count: 1,
        max: 20,
        ratio: 0.05,
        nextInDays: null,
        expired: 0,
        entries: [entry(7)],
      },
    },
    config: { shortDays: 7, longDays: 28, writeEveryTurns: 2 },
    ...over,
  };
}

const okFetch = (data) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

/* ───────────────────────── 模块契约 ───────────────────────── */

test('client: 用 __ModuleLoader__.load 注册，且 id 等于包名', () => {
  const { spec } = loadClient();
  assert.equal(spec.id, PKG.name, 'id 必须是包名 —— 浏览器模块身份就是解析出来的包名');
  assert.equal(typeof spec.factory, 'function');
});

test('client: 只 require 平台基座里的 react', () => {
  const { required } = loadClient();
  // 摊平成本 realm 的数组再比 —— vm 沙箱里造的数组跨 realm，deepEqual 判不等
  assert.deepEqual([...required], ['react'], '多 require 一个模块就要写进 dsh.client.external');
});

test('client: 返回合法 Cordis 插件，且声明依赖 slots', () => {
  const { plugin } = loadClient();
  assert.equal(plugin.name, PKG.name);
  assert.deepEqual([...plugin.inject], ['slots']);
  assert.equal(typeof plugin.apply, 'function');
});

test('client: package.json 里声明了客户端半边，且路径对得上', () => {
  assert.equal(PKG.dsh.client.platform, 'web');
  assert.equal(PKG.exports['./client'], './src/client/index.js');
  assert.ok(PKG.files.includes('src'), 'src 必须在发布文件里，否则 bundle 不会被打包');
});

/* ───────────────────────── slot 注册 ───────────────────────── */

test('client: 只往 sidebar.panellist 加一个图标，order 42', () => {
  const { registered, injects } = mount();
  const icons = registered.filter((r) => r.def.name === 'sidebar.panellist');
  assert.equal(icons.length, 1, '侧栏位置是稀缺资源，只占一格');
  assert.equal(icons[0].def.order, 42);
  assert.deepEqual([...injects], ['sidebar.panellist', 'main'], '两个 slot 各注入一次');
});

test('client: 侧栏 id 与主面板 key 一致，否则点了没反应', () => {
  const { registered } = mount();
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  const panel = registered.find((r) => r.def.name === 'main');
  assert.equal(icon.def.id, 'ebbinghaus-memory', '用全新 id —— 复用别人的会把人家顶掉');
  assert.equal(panel.def.key, icon.def.id, '侧栏按钮就是靠这个 key 找面板');
});

test('client: label 是可调用的（owner 每次投影都会重新读）', () => {
  const { registered } = mount();
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  assert.equal(typeof icon.def.label, 'function');
  assert.equal(icon.def.label(), '记忆');
});

test('client: 图标渲染不抛错，且吃 {size, active}', () => {
  const { icon } = mount();
  const tree = icon({ size: 18, active: true });
  assert.equal(tree.type, 'svg');
  assert.equal(tree.props.width, 18);
  // owner 可能什么都不传 —— 无参也不能炸
  assert.ok(icon({}));
  assert.ok(icon(undefined));
});

/* ───────────────────── 四种输入下都不白屏 ───────────────────── */

test('client: 数据没到之前说「翻记忆…」，不白屏', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: () => new Promise(() => {}) });
  react.reset();
  react.beginRender();
  const tree = panel({});
  assert.match(textOf(tree), /翻记忆/);
});

test('client: 有数据时三区容量条、条目、权重、压缩层、到期全都在', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(payload()) });
  const out = textOf(await renderSettled(panel, react, 1));

  assert.match(out, /三层记忆 · 共 8 条/, '总数用 host 的 total');
  assert.match(out, /短期 7 天 \/ 长期 28 天/, '周期来自 config');

  // 三根容量条，各带「已用 / 上限 · 占比」。文本被我按 span 拆开了，
  // 所以分片段断言 —— 不为了好断言就把渲染结构改掉。
  assert.match(out, /短期/, '第一根条');
  assert.match(out, /5 \/ 60/, '已用 / 上限');
  assert.match(out, /8%/, '占比');
  assert.match(out, /剩 55/, '剩余的可数出来，不用心算');
  assert.match(out, /2 \/ 40/, '第二根条');
  assert.match(out, /1 \/ 20/, '第三根条');

  // 条目：相对时间（host 给的 relative）+ 标题 + 权重 + 压缩层
  assert.match(out, /1 天前 21:30/, '时间显示直接用 host 的 relative');
  assert.match(out, /第 1 条记忆/, '标题');
  assert.match(out, /权重 0\.82/, 'weight 两位小数');
  assert.match(out, /压缩 2 层/, 'depth > 0 要标出来');

  // 底部到期
  assert.match(out, /什么时候会忘/);
  assert.match(out, /最近一条还有 3 天/, '短期 nextInDays');
  assert.match(out, /最近到期 —/, 'nextInDays 为 null 显示 — 而不是 null 天');
  assert.match(out, /不过期/, '永久区没有周期');
  assert.match(out, /已到期 1 条/, '长期有一条已到期');
});

test('client: 折叠时只露 3 条，说了共几条，展开能看到剩下的', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(payload()) });
  let tree = await renderSettled(panel, react, 1);

  assert.match(textOf(tree), /共 5 条/);
  // 短期 3 条（折叠）+ 长期 1 + 永久 1
  assert.equal(findAll(tree, (n) => n.type === 'article').length, 5, '折叠只露 3 条');
  assert.ok(!textOf(tree).includes('第 4 条记忆'), '折叠时第 4 条不该出现');
  assert.match(textOf(tree), /展开全部（还有 2 条）/);

  tree = await clickAndSettle(panel, react, buttonByText(tree, '展开全部'));
  assert.equal(findAll(tree, (n) => n.type === 'article').length, 7, '展开后全部出来');
  assert.match(textOf(tree), /第 4 条记忆/);
  assert.match(textOf(tree), /收起/);
});

test('client: 出错时说实话，并给一次重试', async () => {
  const react = makeStubReact();
  const { panel } = mount({
    react,
    fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
  });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /读不到记忆库/);
  assert.match(out, /503/);
  assert.match(out, /再试一次/);
});

test('client: ok:false 时照抄 host 的 error 人话', async () => {
  const react = makeStubReact();
  const { panel } = mount({
    react,
    fetchImpl: okFetch({ ok: false, ready: false, error: '记忆库目录被占用了' }),
  });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /记忆库目录被占用了/, 'host 已经写了一句话，别自己编一句');
  assert.match(out, /再试一次/);
});

test('client: ready:false 时不装死，说明还没就绪', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(payload({ ready: false })) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /记忆库还没就绪/);
});

test('client: 空库不白屏，说人话', async () => {
  const react = makeStubReact();
  const empty = {
    ok: true,
    ready: true,
    dir: '',
    now: NOW,
    query: '',
    hits: [],
    total: 0,
    zones: {
      short: { label: '短期', count: 0, max: 60, ratio: 0, nextInDays: null, expired: 0, entries: [] },
      long: { label: '长期', count: 0, max: 40, ratio: 0, nextInDays: null, expired: 0, entries: [] },
      permanent: { label: '永久', count: 0, max: 20, ratio: 0, nextInDays: null, expired: 0, entries: [] },
    },
    config: { shortDays: 7, longDays: 28 },
  };
  const { panel } = mount({ react, fetchImpl: okFetch(empty) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /共 0 条/);
  assert.match(out, /这一层还是空的/, '空区要有话说');
  assert.match(out, /没有条目/);
});

test('client: host 少给字段 / 给错类型也不崩', async () => {
  const react = makeStubReact();
  // 这份响应把能缺的都缺了、能错的都错了：缺 long/permanent、
  // entries 不是数组、ratio 是字符串、config 是 null。
  const broken = {
    ok: true,
    ready: true,
    zones: { short: { entries: '不是数组', ratio: 'abc' } },
    config: null,
  };
  const { panel } = mount({ react, fetchImpl: okFetch(broken) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /短期/, '缺的区自己补出来');
  assert.match(out, /长期/);
  assert.match(out, /永久/);
  assert.match(out, /0 条/, 'max 没给就只说条数');
  assert.match(out, /0%/, 'ratio 不是数字就退成 0，不显示 NaN');
  assert.ok(!/NaN|undefined|null 天|Infinity/.test(out), `面板上不该出现 NaN/undefined：${out.slice(0, 200)}`);
});

test('client: zones 整个是 null 也能渲染', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch({ ok: true, ready: true, zones: null }) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /共 0 条/);
  assert.ok(!/NaN|undefined/.test(out));
});

/* ───────────────────────── 容量条颜色 ───────────────────────── */

test('client: 超过 80% 换成警示色，正常用 brand', async () => {
  const react = makeStubReact();
  const p = payload();
  p.zones.short.ratio = 0.85;
  p.zones.short.count = 51;
  const { panel } = mount({ react, fetchImpl: okFetch(p) });
  const tree = await renderSettled(panel, react, 1);

  const fills = findAll(
    tree,
    (n) => n.props && n.props.style && typeof n.props.style.width === 'string' && n.props.style.width.endsWith('%'),
  );
  assert.equal(fills.length, 3, '三根条三个填充');
  assert.equal(fills[0].props.style.background, 'var(--dsw-alias-state-error-primary)', '>80% 用警示色');
  assert.equal(fills[1].props.style.background, 'var(--dsw-alias-brand-primary)', '正常用 brand');
  assert.match(textOf(tree), /快满了/);
});

/* ───────────────────────── 检索 ───────────────────────── */

test('client: 检索框回车 → 带 q 的 GET，且关键词是编码过的', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(payload()) });
  await renderSettled(panel, react, 1);

  const tree = await search(panel, react, '记忆 插件&机器人');

  const searched = calls.find((c) => c.url.includes('?q='));
  assert.ok(searched, '回车必须真的打一次带 q 的请求');
  assert.equal(
    searched.url,
    '/ebbinghaus/state?q=%E8%AE%B0%E5%BF%86%20%E6%8F%92%E4%BB%B6%26%E6%9C%BA%E5%99%A8%E4%BA%BA',
    '中文、空格、& 都要 encodeURIComponent，否则 host 收到半截查询',
  );
  assert.equal(searched.method, 'GET');
  // 检索态容量条还在（契约：?q= 时 zones 照常返回）
  assert.match(textOf(tree), /5 \/ 60/);
});

test('client: 检索只显示命中的那几条，带所在分区标签；清空回全量', async () => {
  const react = makeStubReact();
  const hit = entry(9, { zone: 'long', title: '他在调 ROV 的推进器', relative: '昨天 03:12' });
  const { panel } = mount({
    react,
    fetchImpl: (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('?q=') ? payload({ query: 'ROV', hits: [hit], total: 8 }) : payload(),
          ),
      }),
  });
  await renderSettled(panel, react, 1);

  let tree = await search(panel, react, 'ROV');
  const out = textOf(tree);
  assert.match(out, /「ROV」命中 1 条/);
  assert.match(out, /他在调 ROV 的推进器/, '命中的条目');
  assert.match(out, /昨天 03:12/, '时间还是 host 给的');
  assert.match(out, /长期/, '命中条目要带所在分区');
  assert.equal(findAll(tree, (n) => n.type === 'article').length, 1, '检索态只摆命中的几条');
  // 容量条照常显示 —— 检索是查找，不是换一个页面
  assert.match(out, /5 \/ 60/);

  // 清空回全量
  tree = await clickAndSettle(panel, react, buttonByText(tree, '清空'));
  assert.ok(!textOf(tree).includes('命中'), '清空后不再显示检索结果');
  assert.match(textOf(tree), /共 5 条/);
});

test('client: 检索没命中也要说话', async () => {
  const react = makeStubReact();
  const { panel } = mount({
    react,
    fetchImpl: (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(String(url).includes('?q=') ? payload({ query: 'xyz', hits: [] }) : payload()),
      }),
  });
  await renderSettled(panel, react, 1);
  const tree = await search(panel, react, 'xyz');
  assert.match(textOf(tree), /没找到/);
});

/* ───────────────────── 忘掉 / 压缩 / 收割 ───────────────────── */

test('client: 「忘掉」要点两次才发请求，第二次能反悔', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(payload()) });
  let tree = await renderSettled(panel, react, 1);

  const firstArticle = () => findAll(tree, (n) => n.type === 'article')[0];

  tree = await clickAndSettle(panel, react, buttonByText(firstArticle(), '忘掉'));
  assert.match(textOf(firstArticle()), /确定忘掉？/);
  assert.equal(calls.filter((c) => c.url.endsWith('/forget')).length, 0, '第一下只是问一句，不能真删');

  // 反悔：点「算了」不删，回到未确认
  tree = await clickAndSettle(panel, react, buttonByText(firstArticle(), '算了'));
  assert.ok(!textOf(firstArticle()).includes('确定忘掉？'));

  // 再来一次，这回确认
  tree = await clickAndSettle(panel, react, buttonByText(firstArticle(), '忘掉'));
  tree = await clickAndSettle(panel, react, buttonByText(firstArticle(), '忘掉'));

  const posts = calls.filter((c) => c.url.endsWith('/forget'));
  assert.equal(posts.length, 1, '确认后只发一次');
  assert.equal(posts[0].method, 'POST');
  assert.deepEqual(JSON.parse(posts[0].body), { id: 'em-01' });
});

test('client: 每区一个「压缩」按钮，POST 带 zone', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(payload()) });
  const tree = await renderSettled(panel, react, 1);

  const compressButtons = buttonsOf(tree).filter((b) => textOf(b).includes('压缩'));
  assert.ok(compressButtons.length >= 3, '三区各有一个压缩按钮');

  await clickAndSettle(panel, react, compressButtons[0]);
  const post = calls.find((c) => c.url.endsWith('/compress'));
  assert.ok(post);
  assert.equal(post.method, 'POST');
  assert.deepEqual(JSON.parse(post.body), { zone: 'short' });
});

test('client: 底部「收割到期」走 harvest 接口', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(payload()) });
  const tree = await renderSettled(panel, react, 1);
  const btn = buttonsOf(tree).find((b) => textOf(b) === '收割到期');
  assert.ok(btn, '到期那一栏要能手动跑一次');
  await clickAndSettle(panel, react, btn);
  assert.ok(calls.some((c) => c.url.endsWith('/harvest') && c.method === 'POST'));
});

test('client: 动作失败时只在头上报一句，不掀掉整块面板', async () => {
  const react = makeStubReact();
  const { panel } = mount({
    react,
    fetchImpl: (url, opts) =>
      opts && opts.method === 'POST'
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload()) }),
  });
  let tree = await renderSettled(panel, react, 1);
  tree = await clickAndSettle(
    panel,
    react,
    buttonsOf(tree).filter((b) => textOf(b).includes('压缩'))[0],
  );
  const out = textOf(tree);
  assert.match(out, /压缩没成功/, '失败要说人话');
  assert.match(out, /第 1 条记忆/, '原来的数据还在，没有整块变成错误页');
});

/* ───────────────── 全库总量条 + 调整窗口 ───────────────── */

/** 带 tokens / settings 的响应（host 新加的字段）。 */
const tokenPayload = () =>
  payload({
    tokens: {
      total: 10400,
      capacity: 100000,
      ratio: 0.104,
      over: false,
      left: 89600,
      count: 8,
      byZone: { short: 3000, long: 2400, permanent: 5000 },
    },
    settings: {
      file: 'C:/Users/you/dsh-home/ebbinghaus-memory/settings.json',
      overridden: false,
      fields: [
        {
          key: 'shortCapacity',
          type: 'number',
          min: 5,
          max: 2000,
          step: 1,
          label: '短期容量上限（条）',
          default: 120,
          value: 120,
          overridden: false,
        },
        {
          key: 'totalTokenCapacity',
          type: 'number',
          min: 5000,
          max: 300000,
          step: 1000,
          label: '全库总量上限（token，渲染口径，最多 30 万）',
          default: 100000,
          value: 100000,
          overridden: false,
        },
        {
          key: 'dedupEnabled',
          type: 'boolean',
          label: '记忆库自检（重复记忆合并）',
          default: true,
          value: true,
          overridden: false,
        },
        {
          key: 'dedupEveryEntries',
          type: 'number',
          min: 5,
          max: 100,
          step: 1,
          label: '每写入多少条记忆自检一次（5-100）',
          default: 30,
          value: 30,
          overridden: false,
        },
      ],
      baseValues: { shortCapacity: 120, totalTokenCapacity: 100000 },
    },
    dedup: {
      enabled: true,
      every: 30,
      threshold: 0.5,
      pending: 7,
      lastCheckAt: NOW - 12 * 60000,
      lastGroups: 3,
      lastMerged: 4,
      lastChecked: 180,
      totalGroups: 9,
      totalMerged: 13,
    },
  });

test('client: 全库总量那根条在，token 要缩写（10.4K / 100K）', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  const out = textOf(await renderSettled(panel, react, 1));

  assert.match(out, /全库总量/);
  assert.match(out, /10\.4K \/ 100K/, 'token 数要缩写，不能糊一串 10400 / 100000');
  assert.match(out, /总量 10\.4K \/ 100K token/, '顶部那行也带总量')
  assert.match(out, /剩 89\.6K/, '剩余也要能一眼看出来');
});

test('client: host 没给 tokens 就不画那根条（不用 0 假装很空）', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(payload()) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.ok(!out.includes('全库总量'));
});

test('client: 调整窗口默认收起，展开后有输入框 + token 开销说明，保存会 POST', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  let tree = await renderSettled(panel, react, 1);

  const numberInputs = (t) => findAll(t, (n) => n.type === 'input' && n.props.type === 'number');
  assert.equal(numberInputs(tree).length, 0, '默认收起 —— 面板主线是「还记着什么」，不是配置编辑器');

  const openBtn = buttonByText(tree, '展开');
  assert.ok(openBtn, '必须有一个一眼能看见的入口（用户原话：找不到在哪调）');
  tree = await clickAndSettle(panel, react, openBtn);

  const inputs = numberInputs(tree);
  assert.ok(inputs.length >= 2, `展开后每个可调键一个输入框，实际 ${inputs.length}`);

  const out = textOf(tree);
  assert.match(out, /1\.8 字 = 1 token/, 'token 开销要说清楚');
  assert.match(out, /300K 是硬顶/);
  assert.match(out, /注入预算/, '必须说清「库大 ≠ 每轮都贵」');
  assert.match(out, /_archive/, '要说清压缩不是删除');
  assert.match(out, /settings\.json/, '要说清这些值存在哪');

  // 改总量 → 保存
  const target = inputs.find(
    (n) => n.props['aria-label'] === '全库总量上限（token，渲染口径，最多 30 万）',
  );
  assert.ok(target, '总量上限的输入框要在');
  target.props.onChange({ target: { value: '200000' } });
  tree = renderNow(panel, react);

  const save = buttonByText(tree, '保存');
  assert.ok(save, '要有一个保存按钮');
  await clickAndSettle(panel, react, save);

  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/ebbinghaus/settings'));
  assert.ok(post, '要 POST 到 /ebbinghaus/settings');
  assert.equal(JSON.parse(post.body).totalTokenCapacity, 200000);
});

test('client: 输入框里不是数字就不提交，直接在面板上说一句', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  let tree = await renderSettled(panel, react, 1);
  tree = await clickAndSettle(panel, react, buttonByText(tree, '展开'));

  const input = findAll(tree, (n) => n.type === 'input' && n.props.type === 'number')[0];
  input.props.onChange({ target: { value: 'abc' } });
  tree = renderNow(panel, react);
  tree = await clickAndSettle(panel, react, buttonByText(tree, '保存'));

  assert.match(textOf(tree), /不是数字/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '坏值不许发出去');
});

test('client: 「恢复 DSH 配置」发 reset，不挨个回传旧值', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  let tree = await renderSettled(panel, react, 1);
  tree = await clickAndSettle(panel, react, buttonByText(tree, '展开'));

  const reset = buttonByText(tree, '恢复 DSH 配置');
  assert.ok(reset);
  await clickAndSettle(panel, react, reset);

  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/ebbinghaus/settings'));
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.body), { reset: true });
});

/* ───────────────── 记忆库自检（重复合并） ───────────────── */

test('client: 自检区块显示状态（每隔几条 / 上次合了几组 / 还差几条触发）', async () => {
  const react = makeStubReact();
  const { panel } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  const out = textOf(await renderSettled(panel, react, 1));

  assert.match(out, /记忆库自检/);
  assert.match(out, /每再写 30 条自检一次/);
  assert.match(out, /阈值 0\.5/);
  assert.match(out, /上次 12 分钟前，合了 3 组/);
  assert.match(out, /再写 23 条触发下一次/, 'pending 7 / every 30 → 还差 23');
  assert.match(out, /累计合过 9 组、少 13 条/);
});

test('client: 「立刻自检」POST /dedup，回来报合了几组', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({
    react,
    fetchImpl: (url, opts) => {
      if (opts && opts.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ ok: true, groups: 2, merged: 3, before: 20, after: 17, skipped: '' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tokenPayload()) });
    },
  });
  let tree = await renderSettled(panel, react, 1);
  const btn = buttonByText(tree, '立刻自检');
  assert.ok(btn, '要有手动入口');
  tree = await clickAndSettle(panel, react, btn);

  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/ebbinghaus/dedup'));
  assert.ok(post, '要 POST 到 /ebbinghaus/dedup');
  assert.match(textOf(tree), /合了 2 组，少了 3 条/);
  assert.match(textOf(tree), /_archive\/dedup\.jsonl/, '要说清原文去哪了');
});

test('client: 自检关着时状态行说「关着」，不假装在跑', async () => {
  const react = makeStubReact();
  const payloadOff = tokenPayload();
  payloadOff.dedup = { ...payloadOff.dedup, enabled: false, pending: 0 };
  const { panel } = mount({ react, fetchImpl: okFetch(payloadOff) });
  const out = textOf(await renderSettled(panel, react, 1));
  assert.match(out, /自检关着（还能手动跑）/);
  assert.ok(!out.includes('再写 '), '关着就别提什么时候触发');
});

test('client: 设置里的开关渲染成勾选框，点一下按布尔提交', async () => {
  const react = makeStubReact();
  const { panel, calls } = mount({ react, fetchImpl: okFetch(tokenPayload()) });
  let tree = await renderSettled(panel, react, 1);
  tree = await clickAndSettle(panel, react, buttonByText(tree, '展开'));

  const box = findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.ok(box, '自检开关要是 checkbox，不是数字框');
  assert.equal(box.props.checked, true);

  box.props.onChange({ target: { checked: false } });
  tree = renderNow(panel, react);
  await clickAndSettle(panel, react, buttonByText(tree, '保存'));

  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/ebbinghaus/settings'));
  assert.ok(post);
  assert.equal(JSON.parse(post.body).dedupEnabled, false, '布尔要原样传，别变成 0');
});

/* ───────────────────── 静态检查：颜色 / JSX / import ───────────────────── */

test('client: 只用主题 token 上色，不写死颜色', () => {
  const colors = SRC.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(colors, [], `写死颜色会在浅色/深色切换时翻车：${colors.join(', ')}`);
  assert.ok(/--dsw-alias-/.test(SRC), '要用主题 token');
});

test('client: 没有 JSX、没有 ESM import、不借 UI 组件库', () => {
  assert.ok(!/\bimport\s/.test(CODE), '没有打包器，不能有 ESM import');
  assert.ok(!/<>|<\/[A-Z]/.test(CODE), '没有 JSX 变换，不能用 JSX');
  assert.ok(!/dsh-client-ui-primitives/.test(CODE), 'import 它等于跟别的插件共享运行时');
  assert.ok(!/\brequire\s*\(\s*['"](?!react)/.test(CODE), '只有 react 是允许的');
});
