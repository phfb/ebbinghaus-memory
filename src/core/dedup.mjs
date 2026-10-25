/**
 * 记忆库自检 —— **跨分区的重复/相似记忆合并**。
 *
 * 为什么需要它：固化的那一刻，模型只看得到最近十几条对话，看不到库里已经有什么。
 * 所以同一件事会被反复记下来 —— 实测最典型的是一晚上写出三种说法的
 * 「公众场合不许叫他名字」。重复条目不但白烧 token，更伤的是检索：
 * top 3 的名额被三条同义记忆占满，真正有用的那条反而进不了上下文。
 *
 * 与 `compress.mjs` 的分工（两件事，别混）：
 *   - `compress`：**按容量**压，最老的几条揉成模糊印象，越揉越淡（遗忘曲线）；
 *   - `dedup`：**按内容**合，说的是同一件事就并成一条，细节保留最全的那份。
 * 前者是「忘」，后者是「去重」。
 *
 * 算法（纯本地、零依赖、可单测）：
 *   1. 每条记忆切 2-gram token（复用 recall.mjs 的 tokenize，标题重复一次加权）；
 *   2. 用**全库 IDF 加权重叠系数**算相似度 —— 「公众」「场合」「名字」这类有区分度的
 *      词权重高，「记忆」「今天」这类满库都是的词几乎不起作用；用重叠而不是余弦，
 *      是因为重复最常见的形态是「短的那条被长的那条包含」；
 *   3. 倒排索引先筛候选（共享 ≥2 个 token 才进精确计算），避免 O(n²)；
 *   4. 相似度降序、complete-linkage 聚类（簇内两两都得达标，不然会「A像B、B像C
 *      于是A和C也被合成一条」的链式误合），单簇上限 4 条。
 *
 * 阈值是保守的：宁可漏合，不要乱合。漏合只是浪费，乱合是把两件事揉成一件，
 * 事后没法拆开（原文在 `_archive/` 里，但记忆本身已经变了）。
 */

import { ZONE_DEPTH, clamp01, makeId, normalizeEntry, normalizeKeywords } from './schema.mjs';
import { tokenize } from './recall.mjs';

/** 相似度阈值上下限。面板里可调。 */
export const DEDUP_THRESHOLD_MIN = 0.3;
export const DEDUP_THRESHOLD_MAX = 0.95;
/**
 * 默认阈值 0.5。
 *
 * 这个数是**拿真库调出来的**，不是拍脑袋：
 * 在 183 条的真实库上，0.5 能抓到的都是同一件事的重复（「林小满：四川人，在杭州工作」
 * 的三种写法、「雷区：不在群里提他的薪资」的两种说法、几乎一字不差的
 * 「我不许你说你是冰冷的代码」），而 0.45 以下开始出现「搬东西那天」和
 * 「同一天凌晨失眠」这种**同一次对话里两件事**被拉进来。
 *
 * 想更保守就调到 0.65：那时只合几乎一字不差的。想更主动就 0.45，
 * 代价是同一天发生的两件事可能被并成一条（细节不丢，但边界糊了）。
 */
export const DEDUP_THRESHOLD_DEFAULT = 0.5;

/** 一个簇最多几条。再大就不像「重复」，像「同类」了。 */
const MAX_GROUP = 4;

/**
 * token 少于这个数的条目不参加自检。
 * 三个字的标题 + 一句话的 detail 切不出几个 gram，跟谁都能「有点像」。
 */
const MIN_TOKENS = 5;

/** 候选对的门槛：至少共享这么多个 token 才值得精确算一次。 */
const MIN_SHARED = 2;

/**
 * 两条记忆 token 数的最大比值。超过就是「包含」而不是「重复」了：
 * 一条 800 字的档案能把它覆盖到的所有短记忆都吞掉，那不是去重。
 */
const MAX_LEN_RATIO = 4;

/**
 * 阈值钳制。
 * @param {any} cfg
 * @returns {number}
 */
export function dedupThresholdOf(cfg) {
  const n = Number(cfg?.dedupThreshold);
  if (!Number.isFinite(n)) return DEDUP_THRESHOLD_DEFAULT;
  return Math.min(DEDUP_THRESHOLD_MAX, Math.max(DEDUP_THRESHOLD_MIN, n));
}

/**
 * 自检间隔（每写多少条新记忆跑一次）。
 * @param {any} cfg
 * @returns {number}
 */
export function dedupEveryOf(cfg) {
  const n = Number(cfg?.dedupEveryEntries);
  if (!Number.isFinite(n)) return 30;
  return Math.min(100, Math.max(5, Math.round(n)));
}

/**
 * 一条记忆的 token 集。
 *
 * 标题**重复一次**再送进 tokenize：标题是固化的模型对这件事的概括，
 * 比 detail 更能代表「这是不是同一件事」。不重复的话，一条 600 字的
 * detail 会把标题稀释掉。
 *
 * @param {object} entry
 * @returns {Set<string>}
 */
export function tokenSetOf(entry) {
  const title = String(entry?.title ?? '');
  const detail = String(entry?.detail ?? '');
  const keywords = Array.isArray(entry?.keywords) ? entry.keywords.join(' ') : '';
  return new Set(tokenize(`${title} ${title} ${keywords} ${detail}`));
}

/**
 * 全库文档频率 → IDF。df 越低（越稀有）权重越高。
 * @param {Set<string>[]} sets
 * @returns {Map<string, number>}
 */
function buildIdf(sets) {
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const s of sets) {
    for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = sets.length;
  /** @type {Map<string, number>} */
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / (1 + d)));
  return idf;
}

/**
 * 相似度：**IDF 加权的重叠系数**（overlap coefficient），0..1。
 *
 *   sim = Σ w²(交集) / min( Σ w²(A), Σ w²(B) )
 *
 * 为什么不用余弦：重复记忆最常见的形态是「短的那条被长的那条整个包含」
 * ——同一个事实，一次写成一句话、一次写在五行 detail 里。余弦会因为长条目
 * 多出来的字惩罚分母，实测同义的两条只算出 0.38，根本合不上。
 * 重叠系数只看「短的那条被覆盖了多少」，天然对长度差异免疫。
 *
 * 代价是它偏爱短条目，所以调用方还配了一道长度比保护（MAX_LEN_RATIO）。
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @param {Map<string, number>} idf
 * @returns {number}
 */
export function similarity(a, b, idf) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const t of a) {
    const w = idf.get(t) ?? 1;
    const ww = w * w;
    na += ww;
    if (b.has(t)) dot += ww;
  }
  for (const t of b) {
    const w = idf.get(t) ?? 1;
    nb += w * w;
  }
  const min = Math.min(na, nb);
  if (min === 0) return 0;
  return dot / min;
}

/**
 * 在全库里找重复组。
 *
 * @param {object} zones 三区条目
 * @param {any} cfg
 * @param {{threshold?:number, maxGroup?:number}} [opts]
 * @returns {{groups: {zone:string, entries:object[], similarity:number}[],
 *            checked:number, compared:number}}
 */
export function findDuplicateGroups(zones, cfg, opts) {
  const src = zones && typeof zones === 'object' ? zones : {};
  const threshold = Number.isFinite(opts?.threshold) ? Number(opts.threshold) : dedupThresholdOf(cfg);
  const maxGroup = Number.isFinite(opts?.maxGroup) ? Math.max(2, Math.floor(opts.maxGroup)) : MAX_GROUP;

  /** @type {{entry:object, zone:string, set:Set<string>}[]} */
  const items = [];
  for (const zone of ['short', 'long', 'permanent']) {
    const list = Array.isArray(src[zone]) ? src[zone] : [];
    for (const e of list) {
      if (e === null || typeof e !== 'object') continue;
      if (typeof e.id !== 'string' || e.id === '') continue;
      const set = tokenSetOf(e);
      if (set.size < MIN_TOKENS) continue;
      items.push({ entry: e, zone, set });
    }
  }
  if (items.length < 2) return { groups: [], checked: items.length, compared: 0 };

  const idf = buildIdf(items.map((it) => it.set));

  // ── 倒排索引先筛候选：共享 ≥ MIN_SHARED 个 token 的对才值得精算 ──
  /** @type {Map<string, number[]>} */
  const inverted = new Map();
  for (let i = 0; i < items.length; i += 1) {
    for (const t of items[i].set) {
      let bucket = inverted.get(t);
      if (bucket === undefined) {
        bucket = [];
        inverted.set(t, bucket);
      }
      bucket.push(i);
    }
  }

  /** @type {Map<string, number>} */
  const shared = new Map();
  for (const bucket of inverted.values()) {
    if (bucket.length < 2 || bucket.length > 200) continue; // 满库都有的词没有区分度
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        const key = `${bucket[a]}:${bucket[b]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  /** 相似度达标的边 */
  /** @type {{i:number, j:number, sim:number}[]} */
  const edges = [];
  for (const [key, count] of shared) {
    if (count < MIN_SHARED) continue;
    const [i, j] = key.split(':').map(Number);
    const sa = items[i].set.size;
    const sb = items[j].set.size;
    // 长度差太远 = 包含关系，不是重复
    if (Math.max(sa, sb) / Math.min(sa, sb) > MAX_LEN_RATIO) continue;
    const sim = similarity(items[i].set, items[j].set, idf);
    if (sim >= threshold) edges.push({ i, j, sim });
  }
  edges.sort((a, b) => b.sim - a.sim);

  // ── complete-linkage 聚类 ──
  /** @type {number[][]} 每簇的 index 列表 */
  const clusters = items.map((_, i) => [i]);
  /** index → 簇 id */
  const owner = items.map((_, i) => i);
  /** 簇内两两相似度缓存 */
  const simOf = new Map();
  for (const e of edges) {
    simOf.set(`${e.i}:${e.j}`, e.sim);
    simOf.set(`${e.j}:${e.i}`, e.sim);
  }
  const simBetween = (x, y) => simOf.get(`${x}:${y}`) ?? 0;

  for (const e of edges) {
    const a = owner[e.i];
    const b = owner[e.j];
    if (a === b) continue;
    const ca = clusters[a];
    const cb = clusters[b];
    if (ca.length === 0 || cb.length === 0) continue;
    if (ca.length + cb.length > maxGroup) continue;
    // 簇内两两都得达标 —— 挡住链式误合
    let ok = true;
    for (const x of ca) {
      for (const y of cb) {
        if (simBetween(x, y) < threshold) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // 并到较小的那个簇 id 上
    const keep = Math.min(a, b);
    const drop = Math.max(a, b);
    clusters[keep] = [...ca, ...cb];
    clusters[drop] = [];
    for (const idx of clusters[keep]) owner[idx] = keep;
  }

  /** @type {{zone:string, entries:object[], similarity:number}[]} */
  const groups = [];
  for (const members of clusters) {
    if (members.length < 2) continue;
    const chosen = members.map((i) => items[i]);
    let minSim = 1;
    for (let x = 0; x < chosen.length; x += 1) {
      for (let y = x + 1; y < chosen.length; y += 1) {
        minSim = Math.min(minSim, simBetween(members[x], members[y]));
      }
    }
    // 落位：组内最深的那个区（永久 > 长期 > 短期）
    let zone = 'short';
    for (const it of chosen) {
      if (ZONE_DEPTH[it.zone] > ZONE_DEPTH[zone]) zone = it.zone;
    }
    groups.push({
      zone,
      entries: chosen.map((it) => it.entry),
      similarity: Math.round(minSim * 100) / 100,
    });
  }
  // 相似度高的组先合，读日志时顺序更符合直觉
  groups.sort((a, b) => b.similarity - a.similarity);
  return { groups, checked: items.length, compared: edges.length };
}

/**
 * 把一组重复记忆合成一条。**纯本地，不调模型**（省 token 是这个功能的初衷，
 * 再去调一次模型就本末倒置了）。
 *
 * 逐字段的取舍：
 *  - `ts`：取**最老**的那条 —— 时间戳是这件事最早发生的时间，和压缩同一条规矩；
 *  - `weight`：取**最高**的 —— 同一件事被反复记下来，本身就是重要性的证据；
 *  - `detail`：取**最长**的那条 —— 去重不该丢信息，只该丢重复；
 *  - `title`：取最短的（不超过 40 字的那些里挑），短标题信息密度最高；
 *  - `keywords`：并集去重；
 *  - `depth`：取最大（它已经被压缩过几层，这个事实要留住）；
 *  - `zone`：由调用方给（组内最深的那层）；
 *  - `source`：`'merge'`，`mergedFrom` 记下所有被并掉的 id。
 *
 * @param {object[]} entries 至少 2 条
 * @param {{now?:number, zone?:'short'|'long'|'permanent', taken?:Iterable<string>}} [opts]
 * @returns {object|null}
 */
export function mergeDuplicateGroup(entries, opts) {
  const now = Number.isFinite(opts?.now) ? /** @type {number} */ (opts.now) : Date.now();
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e !== null && typeof e === 'object' && typeof e.id === 'string',
  );
  if (list.length < 2) return null;

  const ids = list.map((e) => e.id);
  const taken = new Set(opts?.taken ?? []);

  let zone = opts?.zone;
  if (zone !== 'short' && zone !== 'long' && zone !== 'permanent') {
    zone = 'short';
    for (const e of list) {
      const z = /** @type {'short'|'long'|'permanent'} */ (e.zone ?? 'short');
      if ((ZONE_DEPTH[z] ?? 0) > (ZONE_DEPTH[zone] ?? 0)) zone = z;
    }
  }

  let ts = Number.POSITIVE_INFINITY;
  let weight = 0;
  let depth = 0;
  let session = '';
  for (const e of list) {
    const t = Number(e.ts);
    if (Number.isFinite(t)) ts = Math.min(ts, t);
    weight = Math.max(weight, clamp01(e.weight));
    depth = Math.max(depth, Math.round(Number(e.depth) || 0));
    if (session === '' && typeof e.session === 'string') session = e.session;
  }
  if (!Number.isFinite(ts)) ts = now;

  // title：最短的（但别短到只剩两三个字）
  let title = '';
  for (const e of list) {
    const t = String(e.title ?? '').trim();
    if (t.length < 4) continue;
    if (title === '' || t.length < title.length) title = t;
  }
  if (title === '') title = String(list[0].title ?? '').trim();

  // detail：最长的那条（去重不丢信息）
  let detail = '';
  for (const e of list) {
    const d = String(e.detail ?? '').trim();
    if (d.length > detail.length) detail = d;
  }

  const keywords = normalizeKeywords(list.flatMap((e) => (Array.isArray(e.keywords) ? e.keywords : [])));

  const merged = {
    id: makeId(ts, [...taken, ...ids]),
    ts,
    zone,
    weight,
    title,
    detail,
    keywords: keywords.length > 0 ? keywords : undefined,
    source: 'merge',
    depth: Math.min(9, depth),
    mergedFrom: ids,
    session,
    createdAt: now,
  };

  return normalizeEntry(merged, { zone, now, source: 'merge', taken: [...taken, ...ids] });
}
