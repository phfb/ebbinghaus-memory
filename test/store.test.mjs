import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, parseJsonl, stringifyJsonl } from '../src/core/store.mjs';
import { makeId, normalizeEntry } from '../src/core/schema.mjs';

async function tmpDir(tag) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), `eb-test-${tag}-`));
}

function entry(over = {}) {
  const ts = over.ts ?? new Date(2026, 9, 20, 10, 0).getTime();
  return normalizeEntry(
    { id: makeId(ts), title: '测试记忆', detail: '细节内容', weight: 0.5, ...over },
    { zone: over.zone ?? 'short' },
  );
}

test('parseJsonl：坏行跳过，好行留下', () => {
  const good = JSON.stringify(entry());
  const text = `${good}\nnot json\n\n{"id":"x"}\n`;
  const { entries, bad } = parseJsonl(text);
  assert.equal(entries.length, 1);
  assert.equal(bad, 2);
});

test('stringifyJsonl：一条一行、按 ts 升序', () => {
  const a = entry({ ts: 2000 });
  const b = entry({ ts: 1000 });
  const text = stringifyJsonl([a, b]);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(JSON.parse(lines[0]).ts < JSON.parse(lines[1]).ts);
  assert.ok(text.endsWith('\n'));
});

test('load 在空目录里建库，读到三区皆空', async () => {
  const dir = await tmpDir('load');
  const store = createStore({ dir });
  const r = await store.load();
  assert.equal(r.ok, true);
  assert.deepEqual(store.zones, { short: [], long: [], permanent: [] });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('首次运行：load 就把库骨架建出来（meta.json + 三个空分区文件）', async () => {
  const dir = await tmpDir('skeleton');
  const store = createStore({ dir });
  await store.load();

  const metaPath = path.join(dir, 'meta.json');
  assert.ok(existsSync(metaPath), '首次运行就该有 meta.json');
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  assert.ok(typeof meta.created_at === 'number' && meta.created_at > 0, 'meta 里要有创建时间');

  for (const zone of ['short', 'long', 'permanent']) {
    const file = path.join(dir, `${zone}.jsonl`);
    assert.ok(existsSync(file), `${zone}.jsonl 该在首次运行时就建好，而不是等第一次写记忆`);
    assert.equal(await fsp.readFile(file, 'utf8'), '', '新建的分区文件是空的，不是坏档');
  }

  await fsp.rm(dir, { recursive: true, force: true });
});

test('首次运行初始化：重启不重写已有文件、不改创建时间', async () => {
  const dir = await tmpDir('skeleton2');
  const first = createStore({ dir });
  await first.load();
  const metaPath = path.join(dir, 'meta.json');
  const createdAt = JSON.parse(await fsp.readFile(metaPath, 'utf8')).created_at;

  first.add(entry());
  await first.save();

  const second = createStore({ dir });
  await second.load();
  const meta2 = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  assert.equal(meta2.created_at, createdAt, '创建时间不能被重启改掉');
  assert.equal(second.zones.short.length, 1, '已有的记忆要读回来');
  assert.equal(await fsp.readFile(path.join(dir, 'permanent.jsonl'), 'utf8'), '', '空区不重复写');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('add / get / remove / setZone 的往返', async () => {
  const dir = await tmpDir('crud');
  const store = createStore({ dir });
  await store.load();

  const e = entry();
  store.add(e);
  assert.equal(store.zones.short.length, 1);
  assert.equal(store.get(e.id)?.id, e.id);

  // 升级：同一个 id 从 short 搬到 long，绝不能两边都有
  store.add({ ...e, zone: 'long' });
  assert.equal(store.zones.short.length, 0);
  assert.equal(store.zones.long.length, 1);

  assert.equal(store.remove(e.id), true);
  assert.equal(store.get(e.id), undefined);
  assert.equal(store.remove(e.id), false, '删不存在的东西要说 false');

  store.setZone('permanent', [entry()]);
  assert.equal(store.zones.permanent.length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('save → load 完整往返，时间戳不变', async () => {
  const dir = await tmpDir('roundtrip');
  const s1 = createStore({ dir });
  await s1.load();
  const old = new Date(2026, 8, 1, 3, 12).getTime();
  const e = entry({ ts: old, title: '旧事' });
  s1.add(e);
  await s1.save();

  const s2 = createStore({ dir });
  await s2.load();
  const back = s2.get(e.id);
  assert.ok(back, '落盘的条目读不回来');
  assert.equal(back.ts, old, '时间戳被改了');
  assert.equal(back.title, '旧事');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('磁盘上的文件真的是一行一条 JSON（人能用记事本看）', async () => {
  const dir = await tmpDir('jsonl');
  const store = createStore({ dir });
  await store.load();
  store.add(entry({ title: '第一行' }));
  store.add(entry({ title: '第二行' }));
  await store.save();

  const text = await fsp.readFile(path.join(dir, 'short.jsonl'), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  // 每条记忆必须是一行 —— detail 里带换行会把 jsonl 搞坏
  assert.ok(!text.includes('\n\n\t'));

  await fsp.rm(dir, { recursive: true, force: true });
});

test('坏档案不阻塞加载（降级优先）', async () => {
  const dir = await tmpDir('broken');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'short.jsonl'), '这不是 json\n{"坏":true}\n', 'utf8');
  const store = createStore({ dir });
  const r = await store.load();
  assert.equal(r.ok, true);
  assert.equal(store.zones.short.length, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('并发 save 不会互相踩（串行化）', async () => {
  const dir = await tmpDir('concurrent');
  const store = createStore({ dir });
  await store.load();
  for (let i = 0; i < 5; i += 1) store.add(entry({ title: `条 ${i}` }));
  await Promise.all([store.save(), store.save(), store.save()]);
  await store.flush();

  const s2 = createStore({ dir });
  await s2.load();
  assert.equal(s2.zones.short.length, 5, '并发写丢了条目');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('capacity 给出 count / max / ratio', async () => {
  const dir = await tmpDir('cap');
  const store = createStore({ dir });
  await store.load();
  store.add(entry());
  const cap = store.capacity({ shortCapacity: 10, longCapacity: 20, permanentCapacity: 30 });
  assert.equal(cap.short.count, 1);
  assert.equal(cap.short.max, 10);
  assert.equal(cap.short.ratio, 0.1);
  assert.equal(cap.long.count, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('跨区 id 重复会在加载时被去掉（历史粘贴事故）', async () => {
  const dir = await tmpDir('dup');
  const store = createStore({ dir });
  await store.load();
  const e = entry({ id: 'em-same-id' });
  store.add(e);
  await store.save();
  // 手动把同一条也写进 long.jsonl
  await fsp.writeFile(path.join(dir, 'long.jsonl'), `${JSON.stringify({ ...e, zone: 'long' })}\n`, 'utf8');

  const s2 = createStore({ dir });
  await s2.load();
  const total = s2.all().filter((x) => x.id === 'em-same-id').length;
  assert.equal(total, 1, '同一个 id 不能出现在两个区');

  await fsp.rm(dir, { recursive: true, force: true });
});

/* ───────── 外部写入：导入工具跑完之后不能被插件整份覆盖 ───────── */

test('mergeFromDisk：磁盘上外部新增的条目，落盘时会被合并进来而不是抹掉', async () => {
  const dir = await tmpDir('external');
  // 模拟「另一个进程」直接往磁盘写
  const store = createStore({ dir });
  await store.load();
  const mine = entry({ title: '插件自己记的' });
  store.add(mine);
  await store.save();

  // 外部进程写了 3 条（插件内存里不知道）
  const external = [
    entry({ ts: 1000, title: '外部第一条' }),
    entry({ ts: 2000, title: '外部第二条' }),
  ];
  const lines = external.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(path.join(dir, 'short.jsonl'), lines, 'utf8');

  // 插件现在写一次盘 —— 它的内存里没有那两条
  store.add(entry({ title: '又记一条' }));
  await store.save();
  await store.flush();

  const back = createStore({ dir });
  await back.load();
  const titles = back.zones.short.map((e) => e.title);
  assert.equal(back.zones.short.length, 4, '外部写入被整份覆盖了');
  assert.ok(titles.includes('外部第一条'));
  assert.ok(titles.includes('外部第二条'));

  await fsp.rm(dir, { recursive: true, force: true });
});

test('remove 立墓碑：落盘前的合并不会把删掉的条目捞回来', async () => {
  const dir = await tmpDir('tombstone');
  const store = createStore({ dir });
  await store.load();
  const e = entry({ title: '待删' });
  store.add(e);
  await store.save();

  assert.equal(store.remove(e.id), true);
  await store.save();
  await store.flush();

  const back = createStore({ dir });
  await back.load();
  assert.equal(back.zones.short.length, 0, '删掉的条目又被合并回来了');
  assert.equal(back.zones.short.find((x) => x.id === e.id), undefined);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('reload：外部进程写完后重读，内存与磁盘一致', async () => {
  const dir = await tmpDir('reload');
  const store = createStore({ dir });
  await store.load();
  assert.equal(store.zones.short.length, 0);

  // 外部写入两条
  const list = [entry({ ts: 1000, title: 'A' }), entry({ ts: 2000, title: 'B' })];
  await fsp.writeFile(
    path.join(dir, 'permanent.jsonl'),
    list.map((e) => JSON.stringify({ ...e, zone: 'permanent' })).join('\n') + '\n',
    'utf8',
  );

  await store.reload();
  assert.equal(store.zones.permanent.length, 2, 'reload 之后应该看见外部写入');
  assert.equal(store.zones.short.length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('reload 之后再加条目不会把外部那批挤掉', async () => {
  const dir = await tmpDir('reload2');
  const store = createStore({ dir });
  await store.load();
  const list = [entry({ ts: 1000, title: 'A' }), entry({ ts: 2000, title: 'B' })];
  await fsp.writeFile(
    path.join(dir, 'short.jsonl'),
    list.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  await store.reload();
  store.add(entry({ title: '新的' }));
  await store.save();
  await store.flush();

  const back = createStore({ dir });
  await back.load();
  assert.equal(back.zones.short.length, 3);

  await fsp.rm(dir, { recursive: true, force: true });
});

/* ─────────── 冷存档：压缩不可逆，但原文要留得住 ─────────── */

test('archive：被合并的原始条目追加进 _archive/，主库不受影响', async () => {
  const dir = await tmpDir('archive');
  const store = createStore({ dir });
  await store.load();

  const a = entry({ title: '原始 A', detail: 'A 的完整细节' });
  const b = entry({ title: '原始 B', detail: 'B 的完整细节' });
  store.add(a);
  store.add(b);

  const n = await store.archive([a, b], 'compressed');
  assert.equal(n, 2);

  const file = path.join(dir, '_archive', 'compressed.jsonl');
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.id, a.id);
  assert.equal(first.detail, 'A 的完整细节', '原文必须一字不改地留下来');
  assert.ok(Number.isFinite(first.archivedAt), '要记下什么时候被归档的');

  // 主库一点没动
  assert.equal(store.zones.short.length, 2);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('archive：多次归档是追加，不覆盖前一次', async () => {
  const dir = await tmpDir('archive2');
  const store = createStore({ dir });
  await store.load();

  await store.archive([entry({ title: '第一批' })], 'dropped');
  await store.archive([entry({ title: '第二批' })], 'dropped');

  const text = await fsp.readFile(path.join(dir, '_archive', 'dropped.jsonl'), 'utf8');
  assert.equal(text.trim().split('\n').length, 2, '第二批把第一批覆盖了');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('archive：坏数据不炸，也不写垃圾', async () => {
  const dir = await tmpDir('archive3');
  const store = createStore({ dir });
  await store.load();

  const n = await store.archive([{ title: '没有 id' }, null, undefined, { id: 'x' }], 'compressed');
  assert.equal(n, 1, '只该收下那条有 id 的');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('archive：tag 里的路径字符被清掉（不能靠它写出库外）', async () => {
  const dir = await tmpDir('archive4');
  const store = createStore({ dir });
  await store.load();

  await store.archive([entry()], '../../escape');
  const files = await fsp.readdir(path.join(dir, '_archive'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('..'), files[0]);
  assert.ok(files[0].endsWith('.jsonl'));

  await fsp.rm(dir, { recursive: true, force: true });
});
