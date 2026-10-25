#!/usr/bin/env node
/**
 * 导入记忆包（DSH 端）。**默认只演不写**，加 --apply 才真的落盘。
 *
 * 用法：
 *   node tools/import.mjs <包文件>              # dry-run，打一张表
 *   node tools/import.mjs <包文件> --apply      # 真写（写前自动备份）
 *   node tools/import.mjs --dir D:/x/y <包文件> --apply
 *   node tools/import.mjs                       # 不给文件：列出 _exports/ 里可用的包
 *
 * 为什么默认 dry-run：
 *   导入是**唯一**会批量改用户记忆的动作，而两端的库又是同一份文件。一次误导入
 *   可能把几十条同 id 的条目就地改写（按 §6.2 的判决，本地可能输给包里那份）。
 *   先看一眼「加几条 / 改几条 / 跳过几条 / 到期会淘汰几条」，再决定要不要写。
 *
 * 为什么落盘前备份：
 *   合并规则里「weight 高的赢」意味着导入**会覆盖**本地同 id 的内容。备份是后悔药。
 *
 * 落盘顺序（与插件内部一致）：
 *   合并结果写进 store → 到期收割（harvest）→ 淘汰的原文冷存档 → 生成模糊印象 → save
 * 先收割再 save，是为了让「刚导入的一批老记忆」当场就被时间冲刷一遍，
 * 而不是等下一次对话才慢慢过期。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createStore } from '../src/core/store.mjs';
import { readPackage, mergePackage, PACKAGE_FORMAT } from '../src/core/transfer.mjs';
import { ZONES, ZONE_LABEL, normalizeEntry } from '../src/core/schema.mjs';
import { harvest, digestDropped } from '../src/core/zones.mjs';
import { resolveConfig } from '../src/core/config.mjs';

// ── 控制台小工具 ──────────────────────────────────────────────────────────

function two(n) {
  return String(n).padStart(2, '0');
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function errOut(line = '') {
  process.stderr.write(`${line}\n`);
}

function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  if (!process.stdout.isTTY) return;
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 无视：只影响观感
  }
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x200b || c === 0xfeff) continue;
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

function padCell(text, width, align) {
  const s = String(text ?? '');
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

function renderTable(headers, rows, rightCols) {
  const right = new Set(rightCols ?? []);
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells) =>
    cells
      .map((c, i) => padCell(c, widths[i], right.has(i) ? 'right' : 'left'))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

// ── 时间与路径 ────────────────────────────────────────────────────────────

function fileStamp(d) {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

function human(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

function resolveDataDir(cliDir) {
  if (typeof cliDir === 'string' && cliDir.trim() !== '') return path.resolve(cliDir.trim());
  const home = (process.env.DSH_HOME ?? '').trim();
  if (home !== '') return path.join(home, 'ebbinghaus-memory');
  return path.join('D:/DSH/dsh-home/ebbinghaus-memory');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 备份。只备 store 真正管的四个文件（`_backup-*` 自己不备份，否则越备越大）。
 * 空库（或文件不存在）不留空目录 —— 别让人几个月后看到一堆空的 _backup。
 *
 * @returns {Promise<{dest: string, copied: string[]}|null>}
 */
async function backupStore(dir) {
  const dest = path.join(dir, `_backup-${fileStamp(new Date())}`);
  const files = ['meta.json', 'short.jsonl', 'long.jsonl', 'permanent.jsonl'];
  const copied = [];
  let created = false;
  for (const f of files) {
    const src = path.join(dir, f);
    try {
      if (!created) {
        await fsp.mkdir(dest, { recursive: true });
        created = true;
      }
      await fsp.copyFile(src, path.join(dest, f));
      copied.push(f);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  if (copied.length === 0) {
    if (created) await fsp.rm(dest, { recursive: true, force: true });
    return null;
  }
  return { dest, copied };
}

// ── 参数 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dir: null, file: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') {
      args.apply = true;
    } else if (a === '--dry-run') {
      // 默认就是 dry-run；写出来是为了让命令自解释，也能覆盖前面的 --apply
      args.apply = false;
    } else if (a === '--dir') {
      args.dir = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--dir=')) {
      args.dir = a.slice('--dir='.length);
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('-')) {
      errOut(`[警告] 不认识的参数，已忽略：${a}`);
    } else if (args.file === null) {
      args.file = a;
    } else {
      errOut(`[警告] 多余的位置参数，已忽略：${a}`);
    }
  }
  return args;
}

function printHelp() {
  out(`
导入记忆包（DSH 端，默认只演不写）

  node tools/import.mjs [选项] <包文件>

选项
  --dir <path>   目标记忆库目录
                 默认 $DSH_HOME/ebbinghaus-memory，再退回 D:/DSH/dsh-home/ebbinghaus-memory
  --apply        真的写盘（写前自动备份到 <库目录>/_backup-<YYYYMMDD-HHmmss>/）
  --dry-run      只演不写（默认行为）
  --help, -h     这张帮助

不给包文件时，会列出 <库目录>/_exports/ 里可用的包。

合并规则（PORT-SPEC §6.2）
  按 id 合并，不是覆盖
  同 id 两边都有 → weight 高的赢 → depth 小的赢 → ts 早的赢
  分区取更深的那个（短期 < 长期 < 永久）
  本地墓碑里的 id 直接跳过（这边已经删了）
`);
}

/** 不给包文件时：把 _exports/ 里可用的包列出来。 */
async function listPackages(dataDir) {
  const dir = path.join(dataDir, '_exports');
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    errOut(`[提示] 没有可列出的包目录：${dir}`);
  }
  names.sort().reverse();
  out('');
  out(`可用的包（${dir}）`);
  if (names.length === 0) {
    out('  （空的 —— 先在另一端或本端跑一次 export）');
    return 0;
  }
  for (const n of names.slice(0, 20)) {
    const full = path.join(dir, n);
    let size = 0;
    try {
      size = (await fsp.stat(full)).size;
    } catch {
      size = 0;
    }
    out(`  ${n}   ${(size / 1024).toFixed(1)} KB`);
  }
  if (names.length > 20) out(`  … 还有 ${names.length - 20} 个`);
  out('');
  out('用法：node tools/import.mjs <上面任意一个包的完整路径>          （先 dry-run 看一眼）');
  out('      node tools/import.mjs <包> --apply                        （确认后真写）');
  return 0;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  ensureUtf8Console();

  const dataDir = resolveDataDir(args.dir);
  const now = Date.now();

  if (args.file === null) {
    return listPackages(dataDir);
  }

  const pkgFile = path.resolve(args.file);

  // ── 1. 读包（先校验，不合格就别碰库）─────────────────────────────────
  if (!(await exists(pkgFile))) {
    errOut(`[错误] 包文件不存在：${pkgFile}`);
    return 1;
  }
  let text;
  try {
    text = await fsp.readFile(pkgFile, 'utf8');
  } catch (e) {
    errOut(`[错误] 包文件读不了：${e?.message ?? e}`);
    return 1;
  }

  let read;
  try {
    read = readPackage(text);
  } catch (e) {
    errOut(`[错误] ${e instanceof Error ? e.message : String(e)}`);
    errOut(`       文件：${pkgFile}`);
    return 1;
  }
  const pack = read.pack;
  const pkgTotal = pack.counts.short + pack.counts.long + pack.counts.permanent;

  // ── 2. 读本地库（只读；--apply 时才会写）────────────────────────────
  const dirExists = await exists(dataDir);
  const store = createStore({
    dir: dataDir,
    log: () => {},
    warn: (m) => errOut(`[库] ${m}`),
  });
  // dry-run 且目录不存在时**不** load：store.load() 会 mkdir，
  // 「只演不写」不该顺手建出一个空库目录。
  if (dirExists || args.apply) await store.load();

  const before = {
    short: store.zones.short.length,
    long: store.zones.long.length,
    permanent: store.zones.permanent.length,
  };
  const beforeTotal = before.short + before.long + before.permanent;

  // ── 3. 合并（纯内存，不动磁盘）───────────────────────────────────────
  const merged = mergePackage(store.snapshot(), pack, { now });

  // ── 4. 模拟一次到期收割，让「导入会淘汰几条」提前可见 ────────────────
  // 这一步**不改** store，只是把合并结果喂给纯函数 harvest 看它的判决。
  // 为什么值得先看：导入的多半是旧记忆，一进库就可能被判到期；
  // 用户看到「新增 33 条，其中 5 条会当场淘汰成 1 条模糊印象」才不会以为丢数据。
  const cfg = resolveConfig({});
  let planCount = { long: 0, permanent: 0, drop: 0, stay: 0 };
  let droppedCount = 0;
  let digestCount = 0;
  let harvestOk = false;
  try {
    const probe = harvest({ zones: merged.zones, cfg, now });
    harvestOk = true;
    for (const p of Array.isArray(probe.plan) ? probe.plan : []) {
      if (p?.to === 'long' || p?.to === 'permanent' || p?.to === 'drop' || p?.to === 'stay') {
        planCount[p.to] += 1;
      }
    }
    for (const zone of ['short', 'long']) {
      const list = Array.isArray(probe.dropped?.[zone]) ? probe.dropped[zone] : [];
      droppedCount += list.length;
      // digestDropped 少于 2 条不生成印象（一条不值得单独留印象）
      if (list.length >= 2) digestCount += 1;
    }
  } catch (e) {
    // 收割模拟失败不能挡住导入：真落盘时还会再跑一次，且失败是被容错的
    harvestOk = false;
    errOut(`[警告] 到期收割模拟失败（不影响导入本身）：${e?.message ?? e}`);
  }

  // ── 5. 报表 ──────────────────────────────────────────────────────────
  const after = {
    short: merged.zones.short.length,
    long: merged.zones.long.length,
    permanent: merged.zones.permanent.length,
  };

  const rows = [];
  for (const zone of ZONES) {
    const delta = after[zone] - before[zone];
    rows.push([
      ZONE_LABEL[zone],
      String(before[zone]),
      String(pack.counts[zone]),
      String(after[zone]),
      delta === 0 ? '±0' : delta > 0 ? `+${delta}` : String(delta),
    ]);
  }
  rows.push([
    '合计',
    String(beforeTotal),
    String(pkgTotal),
    String(after.short + after.long + after.permanent),
    '',
  ]);

  out('');
  out('Ebbinghaus-memory · 导入记忆包（DSH 端）');
  out(`  模式      ${args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（只演不写）'}`);
  out(`  包文件    ${pkgFile}`);
  out(`  包来源    ${pack.source}   导出于 ${human(pack.exported_at)}   格式 ${PACKAGE_FORMAT}`);
  out(`  目标库    ${dataDir}${dirExists ? '' : '   （还不存在，--apply 时创建）'}`);
  if (read.dropped > 0) {
    out(`  坏条目    ${read.dropped} 条（缺 id / ts 无效，已跳过）`);
  }
  if (read.unknownZones.length > 0) {
    out(`  未知分区  ${read.unknownZones.join(' / ')}（已忽略，本端只认 short/long/permanent）`);
  }
  out('');
  out(renderTable(['分区', '导入前', '包内', '合并后', '变化'], rows, [1, 2, 3, 4]));
  out('');

  out('合并统计');
  out(`  新增      ${merged.added} 条（本地没有，直接进对应区）`);
  out(`  更新      ${merged.updated} 条（同 id 已存在，内容或分区被包里的版本改写）`);
  out(`  跳过      ${merged.skipped} 条（已存在且无变化，或命中本地墓碑）`);
  out(`  冲突      ${merged.conflicts} 条（同 id 两边内容不同，按 weight→depth→ts 判决）`);
  if (merged.tombstones.length > 0) {
    out(`  墓碑      ${merged.tombstones.length} 条从包里并入（那端删过、这边也没有）`);
  }
  out('');
  out('  说明：added + updated + skipped = 包内有效条数；conflicts 是其中「两边都有但不一样」的部分。');
  out('        conflicts 里如果本地赢了，会计进「跳过」（库保持原样，只记一笔冲突）。');

  if (harvestOk) {
    out('');
    out(`到期收割（${args.apply ? '已执行' : '预演'}，周期 短 ${cfg.shortDays} 天 / 长 ${cfg.longDays} 天）`);
    out(
      `  升级     升长期 ${planCount.long} 条 / 升永久 ${planCount.permanent} 条 / ` +
        `留级模糊 ${planCount.stay} 条 / 淘汰 ${planCount.drop} 条`,
    );
    if (droppedCount > 0) {
      out(
        `  淘汰      ${droppedCount} 条会先冷存档到 _archive/dropped.jsonl，` +
          `再压成 ${digestCount} 条模糊印象留在原区（原文不丢）`,
      );
    } else {
      out('  淘汰      0 条（没有条目到期）');
    }
  }

  // ── 6. 落盘 ──────────────────────────────────────────────────────────
  out('');
  if (!args.apply) {
    out('DRY-RUN 结束，没有写任何文件。确认无误后加 --apply 真写。');
    return 0;
  }

  const nothingToDo = merged.added === 0 && merged.updated === 0 && merged.tombstones.length === 0;
  if (nothingToDo) {
    out('没有需要写入的变化（幂等：重复导入同一个包不会改动库）。');
    return 0;
  }

  const backup = await backupStore(dataDir);
  if (backup === null) {
    out('备份：目标库还是空的，没有可备份的文件。');
  } else {
    out(`备份：${backup.dest}`);
    out(`      ${backup.copied.join(' / ')}`);
  }

  // 合并结果整区写回 store（setZone 会按 zone 归位、按 ts 排序、同 id 去重）
  for (const zone of ZONES) store.setZone(zone, merged.zones[zone]);
  // 墓碑要一起写进去，否则下次 save 前的 mergeFromDisk 会把刚删的捞回来
  store.meta.deleted_ids = merged.meta.deleted_ids;

  // 到期收割：升级 / 留级 / 淘汰。淘汰的那批**先冷存档**再压成模糊印象 ——
  // 用户的原话是「压缩后剔除」，原文不能就这么没了（压缩是不可逆的）。
  let h = null;
  try {
    h = harvest({ zones: store.zones, cfg, now });
    for (const zone of ZONES) {
      if (Array.isArray(h.zones[zone])) store.setZone(zone, h.zones[zone]);
    }
    for (const zone of ['short', 'long']) {
      const list = Array.isArray(h.dropped?.[zone]) ? h.dropped[zone] : [];
      if (list.length < 2) continue;
      try {
        // 冷存档：_archive/ 不进注入、不占容量、不参与检索，只是「原文还留着」。
        if (typeof store.archive === 'function') await store.archive(list, 'dropped');
      } catch (e) {
        errOut(`[警告] 冷存档失败（不影响收割）：${e?.message ?? e}`);
      }
      const digest = digestDropped(list, cfg, now);
      if (digest === null) continue;
      const entry = normalizeEntry(digest, {
        zone,
        now,
        source: 'merge',
        taken: store.ids(),
      });
      if (entry === null) continue;
      store.add(entry);
      out(`遗忘 ${list.length} 条 → 留下一条模糊印象（depth ${entry.depth}）`);
    }
  } catch (e) {
    errOut(`[警告] 到期收割失败（本次跳过，导入的记忆本身已经写进去了）：${e?.message ?? e}`);
  }

  await store.save();
  await store.flush();

  // ── 7. 后验：另开一个 store 把文件读回来 ─────────────────────────────
  // save() 内部吞异常（只 warn），只看它有没有抛是不够的。
  const verify = createStore({ dir: dataDir, warn: (m) => errOut(`[校验] ${m}`) });
  await verify.load();
  const expectIds = store.ids();
  const gotIds = verify.ids();
  const missing = [...expectIds].filter((id) => !gotIds.has(id));
  const extra = [...gotIds].filter((id) => !expectIds.has(id));

  out('');
  out('写入结果');
  out(
    `  短 ${before.short} → ${verify.zones.short.length} / ` +
      `长 ${before.long} → ${verify.zones.long.length} / ` +
      `永久 ${before.permanent} → ${verify.zones.permanent.length}`,
  );
  if (missing.length === 0 && extra.length === 0) {
    out('  校验：读回文件的 id 与内存一致。');
    return 0;
  }
  errOut(`  校验：id 对不上 —— 缺 ${missing.length} 条，多 ${extra.length} 条`);
  if (missing.length > 0) errOut(`        缺：${missing.slice(0, 5).join(', ')}`);
  if (extra.length > 0) errOut(`        多：${extra.slice(0, 5).join(', ')}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errOut(`[错误] 导入中断：${e?.stack ?? e}`);
    process.exit(1);
  });
