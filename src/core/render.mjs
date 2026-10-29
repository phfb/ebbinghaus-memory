/**
 * 注入渲染 —— 模型每轮真正看到的那段文字。
 *
 * 两个约束同时成立才算对：
 *   1. **不是全量载入**。短期只带最近 loadShortCount 条，长期随机忆起几条，
 *      永久只带 weight 最高的几条，再加上本轮检索命中的那几条。
 *   2. **预算是硬顶**。超了就按 SPEC §11 的顺序砍：长期 → 这轮想起来的 →
 *      永久里 weight 最低的 → 最后才动短期。顺序不能换：短期是「刚刚发生的」，
 *      砍它等于让人失忆；长期和「想起来的」本来就是背景音。
 *
 * 文本形状严格照 SPEC §11，一个字都不自己发明 —— 模型读的是措辞，不是格式。
 * 空区整段不出现（不写「（空）」），否则等于用 token 买一句「这里没有东西」。
 */

import { detailFloor } from './schema.mjs';
import { DAY_MS, stampFor } from './time.mjs';
import { truncateDetail } from './compress.mjs';

/** 固定的头两行。措辞是 SPEC §11 原文。 */
const HEAD_LINES = [
  '<ebbinghaus-memory>',
  '你的记忆按遗忘曲线分三层。时间戳是事件发生的时间，不是你现在的时间。',
  '不要凭空补全这里没有的事。',
  // 2026-10-29 加：条目里的「我」是她自己，「你」是对面那个人。
  // 老条目里还有不少「他」，这句硬映射就是给那些条目兜底的 ——
  // 不然读进来是第三人称，说出去也变成旁白（他会当场听出来）。
  '这里写的是你自己的记忆：「我」是你自己；「你」就是正在跟你说话的那个人。老条目里写成「他」的，指的就是「你」。',
];
const FOOT_LINE = '</ebbinghaus-memory>';

/** 各区在注入里出现的顺序（固定）。 */
const SHOW_ORDER = ['short', 'long', 'permanent', 'recalled'];

/**
 * 超预算时的裁剪顺序。
 *
 * 决定「装不下时先牺牲谁」，从**最该砍**到**最不该砍**：
 *
 *   1. `long` —— 长期区本来就是随机抽样的远期细节，砍了不心疼。
 *   2. `short` —— 最近发生的其他事。重要，但同一批里总有更老的可以先让。
 *   3. `permanent` —— 人格底色。只有三四条、每条一百来字，体积最小、价值最高。
 *   4. `recalled` —— **用户这轮亲口提起的事**。这是整轮对话的焦点，最不该丢。
 *
 * 两处都是实测改过来的：
 *  - 最初是 `long → recalled → permanent → short`：短期 10 条 ×200 字把 1400 token
 *    吃光，永久区一条都进不去，「我记得你是什么样的人」被挤掉了。永久提到短期后面。
 *  - 后来把 recalled 放第二：用户问「上次那个桌宠怎么做的」，明明命中了两条，
 *    预算一裁先砍 recalled，注入里一条都看不见 —— 问什么没什么，这个功能就白做了。
 *    recalled 挪到最后。
 */
const CUT_ORDER = ['long', 'short', 'permanent', 'recalled'];

/** 分区强度默认值，与 config.mjs 的默认一致；坏配置不至于把 detail 打光。 */
const STRENGTH_DEFAULT = { short: 0.9, long: 0.55, permanent: 0.3 };

/**
 * 注入/面板/工具里单条 detail 的**绝对封顶**（字符）。
 * 强度管「相对原长保留多少」，这个管「不管原长多少，最多就这么多」。
 */
export const DETAIL_CAP = Object.freeze({ short: 240, long: 150, permanent: 110 });

/** token 估算：中文一 token ≈ 1.8 字（SPEC §11）。
 *
 * 导出给 `core/budget.mjs` 用 —— 「全库总量」和「每轮注入预算」必须是同一个
 * 系数。两处各写一个 1.8 以外的数（哪怕 2.0），面板就会显示 40K、而注入
 * 那边算出另一个数，用户永远对不上账。 */
export function countTokens(text) {
  return Math.ceil(String(text ?? '').length / 1.8);
}

/**
 * 时间戳渲染成人话：7 天内带时刻（`10-24 21:30`），更早的只到日（`10-18`）。
 *
 * 刻意不用「昨天 / 3 天前」这类相对说法：注入是给模型读的，绝对日期不用算，
 * 而且缓存过的渲染结果（host 按 session+turn 缓存）不会因为跨天而自相矛盾。
 *
 * @param {number} ts
 * @param {number} now
 * @returns {string}
 */
function timeLabel(ts, now) {
  const t = Number.isFinite(ts) ? ts : now;
  const days = (now - t) / DAY_MS;
  if (days < 0 || days >= 7) {
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return stampFor(t);
}

/** weight 的显示形式：0.72 / 0.6 / 1 —— 去掉多余的尾零。 */
function weightLabel(w) {
  const n = Math.min(1, Math.max(0, Number(w) || 0));
  return String(Math.round(n * 100) / 100);
}

/**
 * 每区注入时的 detail 上限（字符）。
 *
 * 三个上限取小的那个，但都不许掉到 40 以下：
 *  - 分区强度（shortDetail/longDetail/permanentDetail）—— 越深越模糊；
 *  - detailFloor(depth) —— 这条记忆在压缩里已经糊过几层；
 *  - **绝对封顶（cap）** —— 强度再高也不许一条记忆占满整个预算。
 *
 * 第三条是实测补上的：迁移进来的「档案·业余与精神食粮」类条目 detail 有 2880 字，
 * 强度 0.9 算出来是 2592 —— 一条就吃掉整个 1400 token 预算。面板里看还好，
 * 走 `memory_search` 工具返回时更致命：3 条 = 5000+ 字符直接塞进下一轮 prompt。
 *
 * 短期「稍微详细」= 200 字上下，不是「把原始档案搬回来」。
 * 最后再用 min(len, …) 收口：detail 本来就比上限短时不补齐，绝不编内容。
 *
 * @param {object} entry
 * @param {string} zone
 * @param {any} cfg
 * @returns {number}
 */
export function detailLimitFor(entry, zone, cfg) {
  const len = String(entry?.detail ?? '').length;
  if (len === 0) return 0;
  const key = `${zone}Detail`;
  const strength = Number.isFinite(Number(cfg?.[key]))
    ? Number(cfg[key])
    : (STRENGTH_DEFAULT[zone] ?? 1);
  const byZone = Math.round(len * strength);
  const byDepth = detailFloor(entry.depth, len);
  const cap = DETAIL_CAP[zone] ?? 200;
  const limit = Math.max(40, Math.min(byZone, byDepth, cap));
  return Math.min(len, Math.max(0, limit));
}

/**
 * 单条记忆渲染成一行。面板和注入共用这一套措辞（SPEC §11）。
 *
 * @param {object} entry
 * @param {{now?: number, detailLimit?: number}} [opts]
 * @returns {string}
 */
export function renderEntryLine(entry, opts) {
  const now = Number.isFinite(opts?.now) ? /** @type {number} */ (opts.now) : Date.now();
  const ts = Number.isFinite(entry?.ts) ? entry.ts : now;
  const title = String(entry?.title ?? '').replace(/\s+/g, ' ').trim();
  const rawDetail = String(entry?.detail ?? '').replace(/\s+/g, ' ').trim();
  const weight = weightLabel(entry?.weight);
  const head = `- [${timeLabel(ts, now)}] `;

  // 没有 detail，或者 detail 与 title 完全一样：只写一份
  if (rawDetail === '' || rawDetail === title) return `${head}${title} · ${weight}`;

  // detail 下限 40：即便 caller 给的 detailLimit 很小，也不许把 detail 渲染成空
  const limit = Number.isFinite(opts?.detailLimit)
    ? Math.max(40, Math.floor(opts.detailLimit))
    : rawDetail.length;
  const shown = truncateDetail(rawDetail, Math.min(rawDetail.length, limit));
  if (shown === '') return `${head}${title} · ${weight}`;

  // detail 以 title 开头 —— 迁移进来的旧日记就是这种形状（title 是正文前 80 字）。
  // 照 "标题 —— 详情" 渲染会读成「…不是我新 —— …不是我新装的 dsh-pet；…」，
  // 一句话说两遍。只留一份。
  if (title !== '' && rawDetail.startsWith(title)) return `${head}${shown} · ${weight}`;

  return `${head}${title} —— ${shown} · ${weight}`;
}

/** 确定性伪随机：同一个 now 永远给出同一批长期记忆（否则测试和缓存都对不上）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗牌取前 k 条（长期区「随机忆起」用）。 */
function sample(list, k, seed) {
  if (k >= list.length) return [...list];
  const arr = [...list];
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, k);
}

function byTsDesc(a, b) {
  return (b.ts ?? 0) - (a.ts ?? 0);
}

/** 把若干 section 拼成最终文本。空 section 整段不出现。 */
function buildText(sections) {
  const parts = [...HEAD_LINES];
  for (const key of SHOW_ORDER) {
    const s = sections[key];
    if (!s || s.items.length === 0) continue;
    parts.push(''); // 区前空行
    parts.push(s.header);
    for (const it of s.items) parts.push(it.line);
    // 区尾提示（目前只有「检索到多条、先问一句」用得上）
    if (typeof s.note === 'string' && s.note !== '') parts.push(s.note);
  }
  if (parts.length === HEAD_LINES.length) return ''; // 一条都没有 → 不输出空壳
  parts.push(FOOT_LINE);
  return parts.join('\n');
}

/**
 * 渲染注入块。
 *
 * @param {object} p
 * @param {object} p.zones 三区条目
 * @param {object} p.cfg
 * @param {number} p.now
 * @param {object[]} [p.recalled] 本轮检索命中（可空）
 * @param {number} [p.budgetTokens]
 * @returns {{text: string, tokens: number, breakdown: object}}
 */
export function renderInjection(p) {
  const zones = p?.zones ?? {};
  const cfg = p?.cfg ?? {};
  const now = Number.isFinite(p?.now) ? /** @type {number} */ (p.now) : Date.now();
  const budget = Number.isFinite(p?.budgetTokens)
    ? Number(p.budgetTokens)
    : Number.isFinite(Number(cfg.budgetTokens))
      ? Number(cfg.budgetTokens)
      : 1400;

  const shortDays = Number.isFinite(Number(cfg.shortDays)) ? Number(cfg.shortDays) : 7;
  const loadShort = Number.isFinite(Number(cfg.loadShortCount)) ? Number(cfg.loadShortCount) : 12;
  const loadLong = Number.isFinite(Number(cfg.loadLongRandom)) ? Number(cfg.loadLongRandom) : 3;
  const loadPerm = Number.isFinite(Number(cfg.loadPermanentCount))
    ? Number(cfg.loadPermanentCount)
    : 3;

  /** 一条 entry → items 里的一行。这里统一决定 detail 上限与时间戳措辞。 */
  const toItem = (entry, zone) => ({
    id: String(entry?.id ?? ''),
    entry,
    line: renderEntryLine(entry, { now, detailLimit: detailLimitFor(entry, zone, cfg) }),
  });

  // ── 挑选（载入策略）──────────────────────────────────────────────
  // 三个分区都是**确定性**的：同一时刻同一份库，渲染出来必然一样。
  // 以前长期区是按小时种子随机抽的（`sample()`），换局/重开对话时「想起什么」全看运气 ——
  // 用户 2026-10-28 明确要求改成「近期权重最高」。
  const shortList = (Array.isArray(zones.short) ? zones.short : [])
    .slice()
    .sort(byTsDesc)
    .slice(0, Math.max(0, loadShort));

  // 长期：只在这个时间窗口里挑，按权重从高到低（同权重按时间新的优先）。
  // 窗口外的一条都不进注入 —— 需要「更久以前但很重要」的记忆时，把它固化到永久区去，
  // 那条路才是「我记得的」，长期区本来就是过渡层。
  const loadLongWindowDays = Number.isFinite(Number(cfg.loadLongWindowDays))
    ? Math.max(1, Number(cfg.loadLongWindowDays))
    : 60;
  const longCutoff = now - loadLongWindowDays * 86_400_000;
  const longPool = (Array.isArray(zones.long) ? zones.long : []).filter(
    (entry) => (Number(entry?.ts) || 0) >= longCutoff,
  );
  const longList = longPool
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, Math.max(0, loadLong))
    .sort(byTsDesc);

  /* 永久区两级注入（2026-10-28 用户要求）：
     一级 = 权重最高的那几条 —— 「我是谁」这类铁律必须每轮都在；
     二级 = 从**剩下**的里随机抽，优先抽「离现在 ≥ loadPermanentSecondaryDays 天」的老记忆，
            老的不够就从剩余部分随机补 —— 否则越久的东西永远进不了注入（这正是用户提的问题）。
     种子按小时变：同一小时内结果稳定（不改提示词缓存），跨小时才换一批。 */
  const permAll = Array.isArray(zones.permanent) ? zones.permanent : [];
  const permPrimary = permAll
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, Math.max(0, loadPerm));
  const permPrimaryIds = new Set(permPrimary.map((entry) => String(entry?.id ?? '')));
  const permRest = permAll.filter((entry) => !permPrimaryIds.has(String(entry?.id ?? '')));

  const loadPermSec = Number.isFinite(Number(cfg.loadPermanentSecondaryCount))
    ? Math.max(0, Number(cfg.loadPermanentSecondaryCount))
    : 20;
  const secDays = Number.isFinite(Number(cfg.loadPermanentSecondaryDays))
    ? Math.max(1, Number(cfg.loadPermanentSecondaryDays))
    : 60;
  // 「按时间戳日间隔算」不是自然日：直接比毫秒差
  const secCutoff = now - secDays * 86_400_000;
  const permOldEnough = permRest.filter((entry) => (Number(entry?.ts) || 0) <= secCutoff);
  const permSecPool = permOldEnough.length >= loadPermSec ? permOldEnough : permRest;
  const permSecondary = loadPermSec > 0
    ? sample(permSecPool, loadPermSec, (Math.floor(now / 3_600_000) ^ 0x85ebca6b) >>> 0)
    : [];

  const permList = permPrimary.concat(permSecondary).sort(byTsDesc);

  // 用户这轮**明确提起**的条目，归到「这轮想起来的」，而不是「最近发生的」。
  //
  // 曾经的写法是反过来的：recalled 里凡是三个区里已有的，一律丢掉。问题是——
  // 短期区按 loadShortCount 挑 12 条、预算只装得下 8 条，被预算裁掉的 4 条
  // 既不在注入里、又被 shownIds 挡住，成了死角。实测「上次那个桌宠怎么做的」
  // 明明命中了两条，注入里却一条都看不见。
  //
  // 现在改成把它们从原分区移到 recalled：同一个 id 只出现一次，总 token 不变，
  // 但语义对了 —— 它是被"想起来"的，不是"最近发生的"。
  const recalledRaw = (Array.isArray(p?.recalled) ? p.recalled : []).filter(
    (e) => e !== null && typeof e === 'object' && String(e?.id ?? '') !== '',
  );
  const recalledIds = new Set(recalledRaw.map((e) => String(e.id)));
  // 「他点名了某一条」之后，同批的**其他候选**要从注入里彻底拿掉。
  // 用户的原话是「再只读取那个正确的记忆和事件」—— 只读，不是"再顺带讲两个别的"。
  // 这些 id 是 host 在确认那一刻记下来的。
  const hideIds = p?.hideIds instanceof Set ? p.hideIds : new Set(Array.isArray(p?.hideIds) ? p.hideIds : []);
  const keep = (e) => !hideIds.has(String(e.id ?? ''));
  const shortKept = shortList.filter((e) => !recalledIds.has(String(e.id ?? '')) && keep(e));
  const longKept = longList.filter((e) => !recalledIds.has(String(e.id ?? '')) && keep(e));
  const permKept = permList.filter((e) => !recalledIds.has(String(e.id ?? '')) && keep(e));

  // 命中 ≥2 条：只列「序号 + 时间 + 标题」，**不展开 detail**。
  //
  // 用户的原话：「检索后预读取，然后说：找到几个有关的，向用户提问并区分是哪个时间
  // 或者能够区分和锁定的问题，再只读取那个正确的记忆和事件。」
  //
  // 所以这里不猜、也不全量塞。列个清单让他点，下一轮他说「22 号那个」，
  // host 会把那一条单独注入（见 recall.mjs 的 pickFromCandidates）。
  // 候选行只占十来个 token，比展开三条 detail 省得多。
  const recalledItems =
    recalledRaw.length >= 2
      ? recalledRaw.map((e, i) => ({
          id: String(e.id ?? ''),
          entry: e,
          line:
            `  ${i + 1}. [${timeLabel(Number(e.ts) || now, now)}] ` +
            `${String(e.title ?? '').slice(0, 44)} · ${weightLabel(e.weight)}`,
        }))
      : recalledRaw.map((e) => toItem(e, e?.zone ?? 'long'));

  /** @type {Record<string, any>} */
  const sections = {
    short: {
      key: 'short',
      header: `〔短期 · 最近 ${shortDays} 天〕`,
      items: shortKept.map((e) => toItem(e, 'short')),
      candidate: shortList.length,
    },
    long: {
      key: 'long',
      header: '〔长期 · 偶尔想起来〕',
      items: longKept.map((e) => toItem(e, 'long')),
      candidate: longList.length,
    },
    permanent: {
      key: 'permanent',
      header: '〔永久 · 我记得的〕',
      items: permKept.map((e) => toItem(e, 'permanent')),
      candidate: permList.length,
    },
    recalled: {
      key: 'recalled',
      header:
        recalledRaw.length >= 2
          ? '〔这轮想起来的 · 有几条都对得上〕'
          : '〔这轮想起来的〕',
      items: recalledItems,
      candidate: recalledRaw.length,
      note:
        recalledRaw.length >= 2
          ? '还不确定是哪一条。先问一句（说「22 号那个」「第二个」都行），' +
            '他确认之后再讲那一条的细节 —— 别猜，也别把几条一起讲。'
          : '',
    },
  };

  // ── 预算 ────────────────────────────────────────────────────────
  // 每个区的「先砍谁」：重要的在后，砍的时候从队头开始。
  //  - 长期：weight 最低的先砍（最不重要）
  //  - 这轮想起来的：weight 最低的先砍（检索分已经在挑选时用过一次）
  //  - 永久：weight 最低的先砍
  //  - 短期：**最老的先砍**（同一个 weight 下，新的比老的更该留在上下文里）
  const cutQueues = {
    long: sections.long.items
      .slice()
      .sort((a, b) => (a.entry.weight ?? 0) - (b.entry.weight ?? 0) || (a.entry.ts ?? 0) - (b.entry.ts ?? 0))
      .map((it) => it.id),
    recalled: sections.recalled.items
      .slice()
      .sort((a, b) => (a.entry.weight ?? 0) - (b.entry.weight ?? 0) || (a.entry.ts ?? 0) - (b.entry.ts ?? 0))
      .map((it) => it.id),
    permanent: sections.permanent.items
      .slice()
      .sort((a, b) => (a.entry.weight ?? 0) - (b.entry.weight ?? 0) || (a.entry.ts ?? 0) - (b.entry.ts ?? 0))
      .map((it) => it.id),
    short: sections.short.items
      .slice()
      .sort((a, b) => (a.entry.ts ?? 0) - (b.entry.ts ?? 0))
      .map((it) => it.id),
  };

  const removeById = (key, id) => {
    const s = sections[key];
    const i = s.items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    s.items.splice(i, 1);
    return true;
  };

  let text = buildText(sections);
  let tokens = countTokens(text);

  // 每一轮从「最该砍」的那一区砍掉**一条**，然后重算 tokens，再回到外层
  // 重新从「长期」判断 —— 不能一轮里每区各砍一条，那样长期还没砍光就动了永久。
  while (tokens > budget) {
    let cutSomething = false;
    outer: for (const key of CUT_ORDER) {
      const queue = cutQueues[key];
      while (queue.length > 0) {
        const id = queue.shift();
        if (!removeById(key, id)) continue; // 已经被别的路径删掉了
        cutSomething = true;
        text = buildText(sections);
        tokens = countTokens(text);
        break outer;
      }
    }
    if (!cutSomething) break; // 四个区全都空了，预算再小也只能这样
  }

  const report = (key) => {
    const s = sections[key];
    return { candidate: s.candidate, shown: s.items.length, cut: s.candidate - s.items.length };
  };
  const rShort = report('short');
  const rLong = report('long');
  const rPerm = report('permanent');
  const rRecalled = report('recalled');

  /** @type {any} */
  const breakdown = {
    tokens,
    budgetTokens: budget,
    short: rShort,
    long: rLong,
    permanent: rPerm,
    recalled: rRecalled,
    cutTotal: rShort.cut + rLong.cut + rPerm.cut + rRecalled.cut,
  };

  return { text, tokens, breakdown };
}
