/**
 * 磁盘层。**core 里唯一允许碰 fs 的文件。**
 *
 * 布局（冻结）：
 *
 *   <dir>/meta.json
 *   <dir>/short.jsonl
 *   <dir>/long.jsonl
 *   <dir>/permanent.jsonl
 *   <dir>/.index.json      派生索引，删了能重建
 *
 * 为什么是 JSONL 而不是一个大 JSON：
 *  - 一行一条，坏一行只丢一条，坏不了一整份档案。
 *  - 追加友好、人可以直接用记事本看、grep。
 *  - 合并（把 short 的几条搬到 long）在内存里做，落盘时整份重写 —— 条目量级是
 *    几百到几千，重写的成本远低于「增量修改导致的半截文件」。
 *
 * 写盘一律 **原子替换**：先写 `xxx.jsonl.tmp`，`fsync` 后 `rename`。
 * Windows 上 `rename` 到已存在的目标会失败，所以先 `unlink` 目标再 rename，
 * 中间窗口极短；调用方永远读不到半截文件（读的是同一个路径，只是文件换了）。
 */

import { promises as fsp } from 'node:fs';
import { watch } from 'node:fs';
import path from 'node:path';
import { ZONES, isValidEntry, makeId, normalizeEntry } from './schema.mjs';
import { CONFIG_DEFAULTS } from './config.mjs';

const META_FILE = 'meta.json';
const INDEX_FILE = '.index.json';
const SCHEMA_VERSION = 1;

function zoneFile(zone) {
  return `${zone}.jsonl`;
}

/**
 * 解析一段 JSONL。坏行跳过并计数 —— 绝不让一行坏数据毁掉整个分区。
 * @param {string} text
 * @returns {{entries: object[], bad: number}}
 */
export function parseJsonl(text) {
  /** @type {object[]} */
  const entries = [];
  let bad = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const obj = JSON.parse(line);
      const e = normalizeEntry(obj, { zone: obj?.zone ?? 'short' });
      if (e !== null && isValidEntry(e)) entries.push(e);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { entries, bad };
}

/**
 * 序列化成 JSONL。一条一行，按 ts 升序。
 * @param {object[]} entries
 * @returns {string}
 */
export function stringifyJsonl(entries) {
  const sorted = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length > 0 ? '\n' : '');
}

/**
 * 原子写：tmp → fsync → rename。
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // Windows: 目标存在时 rename 可能失败（EPERM/EEXIST）。退一步：删了再改名。
    if (err && (err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EACCES')) {
      /* 2026-10-28 修：原来直接 rm 目标再 rename —— 中间崩一下，这个分区就只剩 tmp 那份、
         目标没了，等于丢唯一副本。改成「旧文件先挪成 .old → 换新的进去 → 再删 .old」，
         任何时刻磁盘上都有一份完整的。 */
      const backup = `${file}.old`
      await fsp.rm(backup, { force: true }).catch(() => {})
      await fsp.rename(file, backup)
      try {
        await fsp.rename(tmp, file)
      } catch (swapErr) {
        // 换不进去就把旧的还回来，别让这个分区裸着
        await fsp.rename(backup, file).catch(() => {})
        throw swapErr
      }
      await fsp.rm(backup, { force: true }).catch(() => {})
    } else {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * 建一个记忆库。
 *
 * @param {object} opts
 * @param {string} opts.dir 绝对路径
 * @param {(msg: string) => void} [opts.log]
 * @param {(msg: string) => void} [opts.warn]
 */
export function createStore(opts) {
  const dir = path.resolve(String(opts?.dir ?? ''));
  const log = typeof opts?.log === 'function' ? opts.log : () => {};
  const warn = typeof opts?.warn === 'function' ? opts.warn : () => {};

  /** @type {any} */
  let meta = {
    schema: SCHEMA_VERSION,
    created_at: Date.now(),
    updated_at: 0,
    version: '0.1.0',
  };

  /** @type {Record<'short'|'long'|'permanent', object[]>} */
  const zones = { short: [], long: [], permanent: [] };

  let loaded = false;
  /** 写盘串行化：后台固化 + 面板删除可能同时触发 */
  let writeChain = Promise.resolve();

  /**
   * 上一次**我们自己**写进盘的每个分区文本。
   *
   * 2026-10-29 加，起因是一次真实事故：外部工具（迁移脚本）刚改完 jsonl，
   * 插件毫不知情，下一次落盘拿内存里的旧副本整份覆盖 —— 296 条改动当场蒸发，
   * 磁盘上看不出任何异常。
   *
   * 有了这份记录，「磁盘内容和上次自己写的不一样」就等于「有人在外面改了」，
   * 这时候重读一次即可，不必让用户重启应用。
   */
  const lastWritten = new Map();

  /** 外部改动监听的轮询状态（只在这个 store 上有一份）。 */
  /** 上次看到的每个分区文件 mtime:size —— 变了才去读内容。 */
  const lastStat = new Map();
  /** @type {NodeJS.Timeout | null} */
  let pollTimer = null;
  /** @type {(() => void) | null} */
  let watchStop = null;
  let checking = false;

  const store = {
    get dir() {
      return dir;
    },
    get meta() {
      return meta;
    },
    get zones() {
      return zones;
    },
    get ready() {
      return loaded;
    },

    /**
     * 载入。**幂等**。坏文件 → 空数组 + warn，绝不抛。
     * @returns {Promise<{ok: boolean, bad: number}>}
     */
    async load() {
      if (loaded) return { ok: true, bad: 0 };
      let bad = 0;
      try {
        await fsp.mkdir(dir, { recursive: true });
      } catch (err) {
        warn(`记忆库目录建不了：${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, bad: 0 };
      }

      // meta
      let metaExisted = true;
      try {
        const raw = await fsp.readFile(path.join(dir, META_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          meta = { ...meta, ...parsed, schema: SCHEMA_VERSION };
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') warn(`meta.json 读不了，按新库处理`);
        meta = { ...meta, created_at: Date.now() };
        metaExisted = false;
      }

      /** 首次运行时缺哪几个分区文件 —— 读完要建出来（见下面「库骨架」） */
      const missingZoneFiles = [];
      for (const zone of ZONES) {
        const file = path.join(dir, zoneFile(zone));
        try {
          const text = await fsp.readFile(file, 'utf8');
          const { entries, bad: n } = parseJsonl(text);
          zones[zone] = entries.map((e) => ({ ...e, zone }));
          lastWritten.set(zone, text);
          bad += n;
          if (n > 0) warn(`${zone}.jsonl 有 ${n} 行读不出来，已跳过`);
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            missingZoneFiles.push(zone);
          } else if (err) {
            warn(`${zone}.jsonl 读不了（${err.code ?? '?'}），这一区按空处理`);
          }
          zones[zone] = [];
          lastWritten.delete(zone);
        }
      }

      // ── 库骨架：首次运行就把这几个文档建出来 ──
      //
      // 只建**缺的**，已有文件一个字不碰（空库要是被人手动清成空文件，
      // 这里也不会把它判成「没初始化过」再写一遍 meta）。
      // 失败只 warn 不抛：只读目录、权限不足时不该让整个插件加载不了 ——
      // 记忆写不进去是次要故障，插件起不来是主要故障。
      if (!metaExisted) {
        try {
          await fsp.writeFile(
            path.join(dir, META_FILE),
            `${JSON.stringify(meta, null, 2)}\n`,
            'utf8',
          );
        } catch (err) {
          warn(`meta.json 建不了：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const zone of missingZoneFiles) {
        try {
          // 空文件就是「这一区还没有记忆」，不是坏档：
          // parseJsonl('') 返回空数组，不会被当成 1 行坏数据。
          await fsp.writeFile(path.join(dir, zoneFile(zone)), '', 'utf8');
        } catch (err) {
          warn(`${zone}.jsonl 建不了：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 跨区 id 去重（历史上出现过复制粘贴导致的重复）
      const seen = new Set();
      for (const zone of ZONES) {
        const kept = [];
        for (const e of zones[zone]) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          kept.push(e);
        }
        zones[zone] = kept;
      }

      loaded = true;
      log(
        `记忆库就绪：短 ${zones.short.length} / 长 ${zones.long.length} / 永久 ${zones.permanent.length}` +
          (bad > 0 ? `（跳过坏行 ${bad}）` : ''),
      );
      return { ok: true, bad };
    },

    /** 三区合并，按 ts 升序。 */
    all() {
      return [...zones.short, ...zones.long, ...zones.permanent].sort(
        (a, b) => (a.ts ?? 0) - (b.ts ?? 0),
      );
    },

    /** @param {string} id */
    get(id) {
      if (typeof id !== 'string' || id === '') return undefined;
      for (const zone of ZONES) {
        const hit = zones[zone].find((e) => e.id === id);
        if (hit !== undefined) return hit;
      }
      return undefined;
    },

    /** 所有已占用的 id。 */
    ids() {
      return new Set(this.all().map((e) => e.id));
    },

    /**
     * 重新从磁盘读一遍。
     *
     * 存在的理由很实际：`tools/import.mjs` 是**另一个进程**，它往库里写完，
     * 正在跑的插件内存里还是旧的。不重读的话，插件下一次落盘会拿旧内存整份
     * 覆盖磁盘 —— 刚导入的几十条记忆一行不剩，而且没有任何报错。
     */
    async reload() {
      loaded = false;
      for (const zone of ZONES) zones[zone] = [];
      return this.load();
    },

    /**
     * 落盘前把**磁盘上有、内存里没有**的条目合并进来。
     *
     * 这是整份重写必然要付的代价：只要有两个写者（插件 + 迁移工具、或者两个
     * 插件实例），后落盘的就会静默抹掉先落盘的。合并是唯一的解法。
     *
     * 墓碑（`meta.deleted_ids`）不能省：删掉的条目在磁盘上还在，不立碑就会被
     * 当成「别人刚加的」捞回来，「忘掉」按钮当场失效。
     */
    async mergeFromDisk() {
      const deleted = new Set(Array.isArray(meta.deleted_ids) ? meta.deleted_ids : []);
      const known = new Set();
      for (const zone of ZONES) for (const e of zones[zone]) known.add(e.id);

      for (const zone of ZONES) {
        let text;
        try {
          text = await fsp.readFile(path.join(dir, zoneFile(zone)), 'utf8');
        } catch (err) {
          // 文件还没写过 → 正常，跳过。
          if (err && err.code === 'ENOENT') continue;
          /* 2026-10-28 修：读失败（权限 / 半截 / 被占用）以前静默 continue，
             紧接着 save() 又整份重写这个分区 —— 外面刚导入的条目就被抹掉了，一声不响。
             现在直接抛：这一次落盘整体中止，宁可这次不写，也不能把别人的数据盖掉。 */
          throw new Error(
            `合并外部写入时读不出 ${zoneFile(zone)}：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const { entries } = parseJsonl(text);
        let added = 0;
        for (const e of entries) {
          if (known.has(e.id) || deleted.has(e.id)) continue;
          zones[zone].push({ ...e, zone });
          known.add(e.id);
          added += 1;
        }
        if (added > 0) {
          zones[zone].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
          log(`${zone}.jsonl 里有 ${added} 条是外部写进来的，已合并`);
        }
      }
    },

    /**
     * 落一条。已存在同 id 则整体替换（并跟着 zone 走）。
     * @param {object} entry
     * @returns {object|null}
     */
    add(entry) {
      const e = normalizeEntry(entry, { zone: entry?.zone ?? 'short', taken: this.ids() });
      if (e === null) return null;
      // 先把它从别的区摘掉（升级就是「从 short 消失、在 long 出现」）
      for (const zone of ZONES) {
        zones[zone] = zones[zone].filter((x) => x.id !== e.id);
      }
      // 重新加回来的条目要把墓碑撤掉，否则下一轮合并又把它滤掉
      if (Array.isArray(meta.deleted_ids) && meta.deleted_ids.includes(e.id)) {
        meta.deleted_ids = meta.deleted_ids.filter((x) => x !== e.id);
      }
      zones[e.zone].push(e);
      zones[e.zone].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      return e;
    },

    /**
     * @param {string} id
     * @returns {boolean} 是否真的删掉了
     */
    remove(id) {
      if (typeof id !== 'string' || id === '') return false;
      let removed = false;
      for (const zone of ZONES) {
        const before = zones[zone].length;
        zones[zone] = zones[zone].filter((e) => e.id !== id);
        if (zones[zone].length !== before) removed = true;
      }
      if (removed) {
        // **删了就得立碑** —— 不立的话，落盘前的合并会读一遍磁盘，
        // 那条还在磁盘上、内存里没有 → 判成「别人刚加的」→ 捞回来。
        const tombstones = new Set(Array.isArray(meta.deleted_ids) ? meta.deleted_ids : []);
        tombstones.add(id);
        meta.deleted_ids = [...tombstones];
      }
      return removed;
    },

    /**
     * 整区替换（压缩/收割后用）。
     * @param {'short'|'long'|'permanent'} zone
     * @param {object[]} entries
     */
    setZone(zone, entries) {
      if (!ZONES.includes(zone)) return;
      const taken = new Set();
      /** @type {object[]} */
      const out = [];
      for (const raw of Array.isArray(entries) ? entries : []) {
        const e = normalizeEntry({ ...raw, zone }, { zone, taken });
        if (e === null) continue;
        if (taken.has(e.id)) continue;
        taken.add(e.id);
        out.push(e);
      }
      out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      zones[zone] = out;
    },

    /**
     * 三区容量。面板直接吃这个。
     * @returns {Record<string, {count: number, max: number, ratio: number, bytes: number}>}
     */
    capacity(cfg) {
      // 兜底值从 CONFIG_DEFAULTS 取 —— 这里写死过一次旧默认值（60/120/240），
      // 结果「没配置」和「配置坏了」算出两个不同的上限，面板上看不出来。
      const max = {
        short: Number(cfg?.shortCapacity) || CONFIG_DEFAULTS.shortCapacity,
        long: Number(cfg?.longCapacity) || CONFIG_DEFAULTS.longCapacity,
        permanent: Number(cfg?.permanentCapacity) || CONFIG_DEFAULTS.permanentCapacity,
      };
      /** @type {any} */
      const out = {};
      for (const zone of ZONES) {
        const count = zones[zone].length;
        const bytes = zones[zone].reduce(
          (n, e) => n + (e.title?.length ?? 0) + (e.detail?.length ?? 0),
          0,
        );
        out[zone] = {
          count,
          max: max[zone],
          ratio: max[zone] > 0 ? Math.min(1, count / max[zone]) : 0,
          bytes,
        };
      }
      return out;
    },

    /**
     * 冷存档：把一批即将被合并/淘汰的**原始条目**追加写进 `_archive/`。
     *
     * 为什么需要：压缩是**不可逆**的 —— N 条原始记忆被揉成 1 条模糊的，那 N 条
     * 就从库里消失了，细节永久丢失。用户问过「记忆会不会被 AI 篡改」，压缩
     * 恰恰是唯一一处会真丢东西的地方。
     *
     * 所以留一份原文：`_archive/` 不进注入、不占容量、不参与检索。
     * 主库还是干净的，「忘掉」仍然有效，但真要翻旧账时原文还在。
     * 用 appendFile 而不是整份重写 —— 这个文件只增不改，没有并发覆盖问题。
     *
     * @param {object[]} entries
     * @param {string} tag 文件名（`compressed` / `dropped`）
     * @returns {Promise<number>} 写了几条
     */
    async archive(entries, tag = 'compressed') {
      const list = (Array.isArray(entries) ? entries : []).filter(
        (e) => e !== null && typeof e === 'object' && typeof e.id === 'string',
      );
      if (list.length === 0) return 0;
      try {
        const archiveDir = path.join(dir, '_archive');
        await fsp.mkdir(archiveDir, { recursive: true });
        const safe = String(tag).replace(/[^a-z0-9_-]/gi, '') || 'compressed';
        const file = path.join(archiveDir, `${safe}.jsonl`);
        const text = list.map((e) => JSON.stringify({ ...e, archivedAt: Date.now() })).join('\n') + '\n';
        await fsp.appendFile(file, text, 'utf8');
        return list.length;
      } catch (err) {
        // 存档失败绝不能挡住压缩本身 —— 主流程优先
        warn(`冷存档失败（不影响压缩）：${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    },

    /**
     * 写盘。并发安全（内部串行）。
     * @returns {Promise<void>}
     */
    save() {
      const run = writeChain.then(async () => {
          await fsp.mkdir(dir, { recursive: true });
          // 先合并外部写入，再整份重写 —— 顺序不能反
          await this.mergeFromDisk();
          meta = { ...meta, schema: SCHEMA_VERSION, updated_at: Date.now() };
          for (const zone of ZONES) {
            const text = stringifyJsonl(zones[zone]);
            await writeAtomic(path.join(dir, zoneFile(zone)), text);
            lastWritten.set(zone, text);
          }
          await writeAtomic(
            path.join(dir, META_FILE),
            `${JSON.stringify(meta, null, 2)}\n`,
          );
        });
      // 队列本身必须继续能用：某一次写失败不能把后面所有写都卡死，所以这里吞掉
      writeChain = run.then(() => undefined, () => undefined);
      /* 2026-10-28 修：原来这条链的 .catch 只 warn 就吞，promise 永远 resolve ——
         上层那句「固化完成：入库 N 条」和面板上的 ok 全是假的（盘满时内存有、盘上没有）。
         现在把错误抛给调用方，同时队列照旧继续。 */
      return run.catch((err) => {
        warn(`记忆落盘失败：${err instanceof Error ? err.message : String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      });
    },

    /** 等所有挂起的写盘落定（导出前要用）。 */
    async flush() {
      await writeChain;
    },

    /**
     * 盯着自己的 jsonl：**别人改了盘就重读**。
     *
     * 用 mtime+size 轮询，不用 fs.watch —— watcher 在 Windows 上会吊住进程
     * （测试跑不完），而且落盘是「删 + 改名」的原子替换，事件语义还乱。
     * 只认「磁盘内容 ≠ 上次自己写的内容」；自己写盘会更新 `lastWritten`，
     * 所以不会自激。2 秒一轮、只 stat 三个小文件。
     *
     * @param {() => void} [onChange] 重读之后回调（宿主拿它清渲染缓存 + 记日志）
     * @returns {() => void} 停止监听
     */
    watchExternal(onChange) {
      if (watchStop !== null) return watchStop;

      const check = async () => {
        if (checking) return; // 上一轮还没读完
        checking = true;
        try {
          let dirty = false;
          for (const zone of ZONES) {
            const file = path.join(dir, zoneFile(zone));
            let st;
            try {
              st = await fsp.stat(file);
            } catch {
              continue; // 正在被原子替换的瞬间 → 下一轮再说
            }
            const sig = `${st.mtimeMs}:${st.size}`;
            if (lastStat.get(zone) === sig) continue;
            lastStat.set(zone, sig);
            let text = '';
            try {
              text = await fsp.readFile(file, 'utf8');
            } catch {
              continue;
            }
            if (text !== lastWritten.get(zone)) dirty = true;
          }
          if (!dirty) return;
          if (loaded) await store.reload();
          else await store.load();
          if (typeof onChange === 'function') onChange();
        } catch (err) {
          warn(`外部改动重读失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          checking = false;
        }
      };

      // 先记一遍基线，否则第一次轮询会把「本来就是这些文件」当成外部改动
      for (const zone of ZONES) {
        try {
          const st = statSync(path.join(dir, zoneFile(zone)));
          lastStat.set(zone, `${st.mtimeMs}:${st.size}`);
        } catch {
          /* 文件还没建出来 */
        }
      }

      pollTimer = setInterval(() => void check(), 2000);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      watchStop = () => {
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
        watchStop = null;
      };
      return watchStop;
    },

    /** 给导出/调试用的一份纯数据快照。 */
    snapshot() {
      return {
        meta: { ...meta },
        dir,
        zones: {
          short: zones.short.map((e) => ({ ...e })),
          long: zones.long.map((e) => ({ ...e })),
          permanent: zones.permanent.map((e) => ({ ...e })),
        },
      };
    },

    /** 下一个 id（给 host 层用，避免它知道 id 生成细节）。 */
    nextId(ts) {
      return makeId(Number.isFinite(ts) ? ts : Date.now(), this.ids());
    },

    /** 派生索引的落盘路径（面板/工具可能会打开它）。 */
    get indexPath() {
      return path.join(dir, INDEX_FILE);
    },
  };

  return store;
}
