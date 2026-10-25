/**
 * 记忆包的导出 / 导入 —— **纯逻辑层**。
 *
 * 为什么单独一个文件（不塞进 store.mjs、也不塞进两个 CLI）：
 *   1. 两端（DSH / AstrBot）必须对同一份包给出**同一个判决**。格式一旦散落在两个
 *      CLI 里，就迟早分叉：这边按 weight 判、那边按 ts 判，同步两次之后两边的库
 *      就再也对不上了，而且没有任何报错 —— 只会「少了几条」，谁也不知道少在哪。
 *   2. 这里**不碰 fs、不碰 ctx**：core 里唯一允许碰磁盘的是 store.mjs，这条界线
 *      不能破。所以本文件只做「数据进、数据出」，读写文件由 tools/*.mjs 负责。
 *
 * 格式冻结在 PORT-SPEC.md §6，字段名一个字都不许改（改了另一边就读不出来）。
 *
 * 三个导出：
 *   buildPackage({ zones, meta, source, now })  → 一个可以 JSON.stringify 的包
 *   validatePackage(raw)                        → 结构不合格抛人话错误，合格返回规整后的包
 *   mergePackage(local, pkg, { now })           → 按 §6.2 合并，返回结果 + 统计
 */

import {
  ZONES,
  ZONE_DEPTH,
  SOURCES,
  clamp01,
  isoOfLocal,
  normalizeKeywords,
} from './schema.mjs';

/** 包格式标识。跨端认的就是这一个字符串，别改。 */
export const PACKAGE_FORMAT = 'ebbinghaus-memory/v1';
/** 包结构版本。比本端认识的新 → 拒绝（宁可不导，也不要读出一个半懂的包）。 */
export const PACKAGE_SCHEMA = 1;
/** `source` 的合法取值。其它值也收（只当来源标记），但这两个是正经来源。 */
export const KNOWN_SOURCES = Object.freeze(['dsh', 'astrbot']);

// 与 schema.mjs 的上限保持一致。这里不 import 那些常量是因为它们没导出 ——
// 与其去改冻结的 schema.mjs，不如把数字抄一份，并在注释里标明出处。
const MAX_TITLE = 80;
const MAX_DETAIL = 2000;
const MAX_DEPTH = 9;
const MAX_MERGED = 64;

// ── 小工具 ────────────────────────────────────────────────────────────────

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** weight 统一两位小数 —— 比较「谁更高」时不能受浮点尾巴干扰。 */
function round2(n) {
  return Math.round(clamp01(n) * 100) / 100;
}

function clampDepth(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(MAX_DEPTH, Math.max(0, v));
}

/** 一条记忆在 jsonl 里必须是一行：压掉换行与连续空白。 */
function flatText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function zoneName(v) {
  return ZONES.includes(v) ? v : 'short';
}

function sortByTs(list) {
  return [...list].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/** 分区深度（0/1/2）。未知分区按 -1，这样任何已知分区都比它深。 */
function depthOfZone(z) {
  const d = ZONE_DEPTH[z];
  return Number.isFinite(d) ? d : -1;
}

/**
 * 把任意一条（来自磁盘 / 来自包 / 来自面板）规整成**导出用的干净形状**。
 *
 * 刻意**不用** `normalizeEntry`：
 *   - 它会把「未来时间」拉回现在，等于导出时偷偷改数据；导出必须幂等
 *     （导出 → 导入 → 再导出，字节不变），否则每次同步都像在修改记忆。
 *   - 它会给缺 id 的条目现造一个 id。导出时造 id 是错的：包里应该只有真实存在
 *     的条目，匿名条目直接丢掉，比凭空造一个新 id 更诚实。
 *
 * @param {unknown} raw
 * @param {'short'|'long'|'permanent'} [zone] 该条目所在的区（覆盖 raw.zone）
 * @returns {object|null} 不合格返回 null
 */
export function pickEntry(raw, zone) {
  if (!isObj(raw)) return null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return null;

  let ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) ts = Number(raw.createdAt ?? raw.created_at);
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const z = zoneName(zone ?? raw.zone);
  const title = flatText(raw.title ?? raw.text, MAX_TITLE);
  // detail 为空但有标题时，用标题兜底 —— 与 normalizeEntry 的行为一致，
  // 免得跨端之后某端渲染出一行空内容。
  const detail = flatText(raw.detail ?? raw.text, MAX_DETAIL) || title;
  if (title === '' && detail === '') return null;

  const keywords = normalizeKeywords(raw.keywords ?? raw.tags);
  const mergedFrom = (Array.isArray(raw.mergedFrom) ? raw.mergedFrom : [])
    .filter((x) => typeof x === 'string' && x !== '')
    .slice(0, MAX_MERGED);

  const touchedAt = Number(raw.touchedAt);
  const createdAt = Number(raw.createdAt);

  // 字段顺序与 schema.mjs 的 normalizeEntry 完全一致：磁盘上两端写出来的行
  // 长得一样，diff 的时候才看得懂。
  return {
    id,
    ts,
    iso: typeof raw.iso === 'string' && raw.iso !== '' ? raw.iso : isoOfLocal(ts),
    zone: z,
    weight: round2(raw.weight ?? 0.4),
    title,
    detail,
    keywords,
    source: SOURCES.includes(raw.source) ? raw.source : 'chat',
    depth: clampDepth(raw.depth),
    mergedFrom,
    session: typeof raw.session === 'string' ? raw.session.slice(0, 40) : '',
    touchedAt: Number.isFinite(touchedAt) ? touchedAt : ts,
    createdAt: Number.isFinite(createdAt) ? createdAt : ts,
  };
}

// ── 导出 ──────────────────────────────────────────────────────────────────

/**
 * 打包。形状见 PORT-SPEC §6.1。
 *
 * 注意：只导**三个活分区**。`_archive/`（冷存档）、`_backup-*`、`_exports/`
 * 都不进包 —— 冷存档是「压缩后留的底」，不是活记忆，导出去只会让另一端的库
 * 凭空多出几百条它从没见过的条目。
 *
 * @param {{zones?: object, meta?: object, source?: string, now?: number}} p
 * @returns {object}
 */
export function buildPackage(p) {
  const src = p?.zones ?? {};
  const meta = p?.meta ?? {};
  const now = Number.isFinite(p?.now) ? /** @type {number} */ (p.now) : Date.now();

  // source 只当来源标记，不做白名单校验：CLI 传的就是 dsh / astrbot，
  // 但 host 将来若传别的（比如 dsh-next），也不该因此导不出来。
  const rawSource = typeof p?.source === 'string' ? p.source.trim() : '';
  const source = rawSource === '' ? 'dsh' : rawSource.slice(0, 32);

  /** @type {Record<string, object[]>} */
  const zones = { short: [], long: [], permanent: [] };
  for (const zone of ZONES) {
    const list = Array.isArray(src[zone]) ? src[zone] : [];
    for (const raw of list) {
      const e = pickEntry(raw, zone);
      if (e === null) continue; // 坏条目不进包，但也不该让整份导出失败
      zones[zone].push(e);
    }
  }

  // 包内按 ts 升序：人拿记事本打开时，读起来就是一条时间线。
  for (const zone of ZONES) zones[zone] = sortByTs(zones[zone]);

  const createdAt = Number(meta.created_at);
  const deleted = Array.isArray(meta.deleted_ids) ? meta.deleted_ids : [];
  const deletedIds = [];
  const seen = new Set();
  for (const id of deleted) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    deletedIds.push(id);
  }

  return {
    format: PACKAGE_FORMAT,
    schema: PACKAGE_SCHEMA,
    exported_at: now,
    source,
    counts: {
      short: zones.short.length,
      long: zones.long.length,
      permanent: zones.permanent.length,
    },
    meta: {
      created_at: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
      deleted_ids: deletedIds,
    },
    zones,
  };
}

// ── 校验 ──────────────────────────────────────────────────────────────────

function bad(msg) {
  return new Error(`不是可用的记忆包：${msg}`);
}

/**
 * 校验并**规整**一个包。不合格抛人话错误（用户看到的是「这不是记忆包」，
 * 而不是 `Cannot read properties of undefined`）。
 *
 * 结构级问题（format / schema / zones 形状）一律抛错：一个结构坏的包，
 * 猜着导只会把库弄脏。条目级问题（缺 id、ts 是 0）逐条剔除，
 * 用 `readPackage` 能看到剔了几条。
 *
 * @param {unknown} raw 对象，或者一段 JSON 文本
 * @returns {object} 规整后的包（形状与 buildPackage 的输出一致）
 */
export function validatePackage(raw) {
  return readPackage(raw).pack;
}

/**
 * validatePackage 的带统计版本：CLI 用它，才能把「包里有 2 条坏条目，已跳过」
 * 说出来。host 只需要 validatePackage 就够。
 *
 * @param {unknown} raw
 * @returns {{pack: object, dropped: number, unknownZones: string[]}}
 */
export function readPackage(raw) {
  let data = raw;

  if (typeof data === 'string') {
    const text = data.replace(/^\uFEFF/, '').trim();
    if (text === '') throw bad('文件是空的');
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw bad(`内容不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  if (!isObj(data)) throw bad('顶层不是一个对象');

  if (data.format !== PACKAGE_FORMAT) {
    const got = typeof data.format === 'string' ? data.format : '（缺失）';
    throw bad(`format 是「${got}」，应该是由本插件导出的「${PACKAGE_FORMAT}」`);
  }

  if (data.schema !== undefined) {
    const schema = Number(data.schema);
    if (!Number.isFinite(schema)) throw bad('schema 字段不是数字');
    if (schema > PACKAGE_SCHEMA) {
      throw bad(`包结构版本 schema=${schema} 比本端认识的 ${PACKAGE_SCHEMA} 新，请先升级插件再导入`);
    }
  }

  if (!isObj(data.zones)) throw bad('缺少 zones（应当包含 short / long / permanent 三个数组）');

  /** @type {Record<string, object[]>} */
  const zones = { short: [], long: [], permanent: [] };
  let dropped = 0;
  const unknownZones = [];

  for (const key of Object.keys(data.zones)) {
    if (!ZONES.includes(key)) {
      unknownZones.push(key);
      continue;
    }
    const list = data.zones[key];
    if (!Array.isArray(list)) throw bad(`zones.${key} 不是数组`);
    for (const item of list) {
      const e = pickEntry(item, key);
      if (e === null) {
        dropped += 1;
        continue;
      }
      zones[key].push(e);
    }
  }

  // 三个区一个都没有也不拦：空包是合法的（空库导出来的就是这样），
  // 由调用方决定要不要提示「这个包是空的」。
  for (const zone of ZONES) zones[zone] = sortByTs(zones[zone]);

  const meta = isObj(data.meta) ? data.meta : {};
  const createdAt = Number(meta.created_at);
  const deletedIds = [];
  const seen = new Set();
  for (const id of Array.isArray(meta.deleted_ids) ? meta.deleted_ids : []) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    deletedIds.push(id);
  }

  const exportedAt = Number(data.exported_at);

  return {
    pack: {
      format: PACKAGE_FORMAT,
      schema: PACKAGE_SCHEMA,
      exported_at: Number.isFinite(exportedAt) && exportedAt > 0 ? exportedAt : 0,
      source: typeof data.source === 'string' && data.source.trim() !== '' ? data.source.trim() : 'unknown',
      counts: {
        short: zones.short.length,
        long: zones.long.length,
        permanent: zones.permanent.length,
      },
      meta: {
        created_at: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
        deleted_ids: deletedIds,
      },
      zones,
    },
    dropped,
    unknownZones,
  };
}

// ── 合并 ──────────────────────────────────────────────────────────────────

/**
 * 「谁的证据更强」——PORT-SPEC §6.2 的判决顺序，只写在这一处。
 *
 *   1. `weight` 高的赢（被反复引用过的更可信）
 *   2. weight 相同 → `depth` 小的赢（深度小 = 更原始、细节更全）
 *   3. 再相同 → `ts` 早的赢（时间是事件的属性，不可被后来的抄本改写）
 *   4. 完全同分 → 0（调用方保留本地，避免「导入一次就洗一遍库」）
 *
 * @returns {number} 1 = a 赢，-1 = b 赢，0 = 同分
 */
export function compareEvidence(a, b) {
  const wa = round2(a?.weight ?? 0);
  const wb = round2(b?.weight ?? 0);
  if (wa !== wb) return wa > wb ? 1 : -1;

  const da = clampDepth(a?.depth);
  const db = clampDepth(b?.depth);
  if (da !== db) return da < db ? 1 : -1;

  const ta = Number(a?.ts) || 0;
  const tb = Number(b?.ts) || 0;
  if (ta !== tb) return ta < tb ? 1 : -1;

  return 0;
}

/** 两条同 id 的记忆是不是「同一份内容」。只比会影响注入结果的字段。 */
function sameContent(a, b) {
  return (
    a.id === b.id &&
    a.zone === b.zone &&
    round2(a.weight) === round2(b.weight) &&
    clampDepth(a.depth) === clampDepth(b.depth) &&
    a.title === b.title &&
    a.detail === b.detail
  );
}

/**
 * 合并一个包到本地。
 *
 * `local` 可以是 `store.snapshot()`，也可以直接是 store 实例（两者都有
 * `zones` / `meta` 属性）。**不修改入参**：返回全新对象，调用方自己决定要不要落盘。
 *
 * 返回值里的统计口径（给人看的「加了几条 / 更新几条 / 跳过几条 / 冲突几条」）：
 *   added     —— 本地没有、从包里新加的
 *   updated   —— 同 id 已存在，但合并后内容或分区变了（被包里的版本改写，或者升级了区）
 *   skipped   —— 没变化（幂等重复导入）、或命中本地墓碑
 *   conflicts —— 同 id 两边都有**且内容不同**的条数；其中被本地守住的那些同时计入 skipped
 *   于是 added + updated + skipped = 包里有效条目数，conflicts ⊆ 同 id 命中数
 *
 * @param {{zones?: object, meta?: object}} local
 * @param {object} pkg 已校验的包（未校验也能吃，内部会再 pick 一遍）
 * @param {{now?: number}} [opts]
 * @returns {{zones: Record<string, object[]>, meta: object, added: number, updated: number, skipped: number, conflicts: number, tombstones: string[]}}
 */
export function mergePackage(local, pkg, opts) {
  const now = Number.isFinite(opts?.now) ? /** @type {number} */ (opts.now) : Date.now();
  const localZones = isObj(local?.zones) ? local.zones : {};
  const localMeta = isObj(local?.meta) ? local.meta : {};

  // 本地墓碑：这边已经删掉的，导入时一律跳过（§6.2 第 4 条）。
  // 不跳的话「忘掉」按钮就成了摆设 —— 同步一次就复活。
  const tombstones = new Set(
    (Array.isArray(localMeta.deleted_ids) ? localMeta.deleted_ids : []).filter(
      (x) => typeof x === 'string' && x !== '',
    ),
  );

  // ── 1. 本地现状：id → { zone, entry } ──────────────────────────────────
  // 历史上出现过同一 id 横跨两个区（复制粘贴），这里按同一套判决留最强的那个。
  /** @type {Map<string, {zone: string, entry: object}>} */
  const merged = new Map();

  for (const zone of ZONES) {
    const list = Array.isArray(localZones[zone]) ? localZones[zone] : [];
    for (const raw of list) {
      const e = pickEntry(raw, zone);
      if (e === null) continue;
      const cur = merged.get(e.id);
      if (cur === undefined) {
        merged.set(e.id, { zone: e.zone, entry: e });
        continue;
      }
      const winner = compareEvidence(e, cur.entry) > 0 ? e : cur.entry;
      const deeper = depthOfZone(e.zone) > depthOfZone(cur.zone) ? e.zone : cur.zone;
      merged.set(e.id, { zone: deeper, entry: { ...winner, zone: deeper } });
    }
  }

  const localCount = merged.size;

  // ── 2. 逐个导入 ────────────────────────────────────────────────────────
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  const pkgZones = isObj(pkg?.zones) ? pkg.zones : {};
  for (const zone of ZONES) {
    const list = Array.isArray(pkgZones[zone]) ? pkgZones[zone] : [];
    for (const raw of list) {
      const inc = pickEntry(raw, zone);
      if (inc === null) continue;

      if (tombstones.has(inc.id)) {
        skipped += 1;
        continue;
      }

      const cur = merged.get(inc.id);
      if (cur === undefined) {
        merged.set(inc.id, { zone: inc.zone, entry: inc });
        added += 1;
        continue;
      }

      const identical = sameContent(cur.entry, inc);
      if (!identical) conflicts += 1;

      // 同分（或本地更强）→ 保留本地：导入不该让库里的记忆「越同步越模糊」。
      // ⚠️ 这里必须比**引用**，不能比 id —— 同 id 合并时 id 必然相等，
      // 用 `winner.id === cur.entry.id` 判断会让「包里更强」永远失效（踩过）。
      const cmp = compareEvidence(inc, cur.entry);
      const localWins = cmp <= 0;
      const winner = localWins ? cur.entry : inc;
      // 分区取更深的那个：已经在深层 = 已经被时间验证过，不能因为另一端的抄本
      // 还停在浅层就把它拽回来（那样遗忘曲线会被同步动作打断）。
      const newZone = depthOfZone(inc.zone) > depthOfZone(cur.zone) ? inc.zone : cur.zone;
      const zoneChanged = newZone !== cur.zone;

      if (localWins && !zoneChanged) {
        // 内容没变（或本地更强）且分区没升级 —— 什么都不做
        skipped += 1;
        continue;
      }

      merged.set(inc.id, { zone: newZone, entry: { ...winner, zone: newZone } });
      updated += 1;
    }
  }

  // ── 3. 组装结果 ────────────────────────────────────────────────────────
  /** @type {Record<string, object[]>} */
  const zones = { short: [], long: [], permanent: [] };
  for (const { zone, entry } of merged.values()) {
    zones[zoneName(zone)].push(entry);
  }
  for (const zone of ZONES) zones[zone] = sortByTs(zones[zone]);

  // ── 4. meta ───────────────────────────────────────────────────────────
  // created_at 取更早的那个：建库时间是「这份记忆从哪天开始」的锚，越早越接近真相。
  const localCreated = Number(localMeta.created_at);
  const pkgCreated = Number(pkg?.meta?.created_at);
  const candidates = [localCreated, pkgCreated].filter((n) => Number.isFinite(n) && n > 0);
  const createdAt = candidates.length > 0 ? Math.min(...candidates) : now;

  // 包里的墓碑：只搬「本地已经不存在这条」的那些。
  // 为什么不是照单全收 —— 本地还有这条活着的记忆时，把墓碑搬过来会让下一次
  // 落盘前的 mergeFromDisk 跟它自相矛盾（内存里有、墓碑里有）。这种冲突的
  // 正确解是让用户自己决定删哪边，工具不替他删。
  const tombAdded = [];
  for (const id of Array.isArray(pkg?.meta?.deleted_ids) ? pkg.meta.deleted_ids : []) {
    if (typeof id !== 'string' || id === '') continue;
    if (tombstones.has(id)) continue;
    if (merged.has(id)) continue;
    tombstones.add(id);
    tombAdded.push(id);
  }

  return {
    zones,
    meta: {
      ...localMeta,
      created_at: createdAt,
      deleted_ids: [...tombstones],
    },
    added,
    updated,
    skipped,
    conflicts,
    localCount,
    tombstones: tombAdded,
  };
}
