/**
 * 主分区（space）：一个插件里放多个完全独立的记忆库。
 *
 * 目录长这样：
 *
 *   <库根>\
 *     spaces.json              ← 注册表：有哪些分区、当前激活哪个
 *     spaces\
 *       private\               ← 一个分区 = 以前的一整个库
 *         short.jsonl  long.jsonl  permanent.jsonl
 *         meta.json  settings.json  dedup-state.json  mirror-state.json
 *         _archive\
 *       工作\
 *         （同上，完全独立）
 *     _trash\                  ← 删掉的分区搬这儿，随时能捞回来
 *
 * 为什么用「目录」当分区边界：这样 store / 落盘 / 冷存档 / 镜像全都不用改逻辑 ——
 * 把它们指向哪个目录，就等于在用哪个分区。分区之间天然不共享任何文件。
 *
 * 这个文件是**纯函数区**：不碰 fs。真正建目录、搬文件的是 host 里的 ensureSpaces()。
 */

import path from 'node:path';

/** 分区目录所在的子目录名（相对库根）。 */
export const SPACES_DIR = 'spaces';
/** 注册表文件名（相对库根）。 */
export const REGISTRY_FILE = 'spaces.json';
/** 回收站目录名（删掉的分区搬这儿）。 */
export const TRASH_DIR = '_trash';
/** 最多几个主分区。 */
export const MAX_SPACES = 10;
/** 老库迁移过去时的分区 id 与显示名。 */
export const DEFAULT_SPACE_ID = 'private';
export const DEFAULT_SPACE_NAME = '私生活';

/**
 * 「库根里属于老库的文件」—— 迁移时只看这些。
 * 不在这个名单里的东西（比如用户自己放进来的）不搬，留在根目录。
 */
export const LEGACY_LIB_FILES = Object.freeze([
  'short.jsonl',
  'long.jsonl',
  'permanent.jsonl',
  'meta.json',
  'settings.json',
  'dedup-state.json',
  'mirror-state.json',
]);

/** 老库里要跟着搬的目录。 */
export const LEGACY_LIB_DIRS = Object.freeze(['_archive']);

/**
 * 分区 id 合不合法：ASCII、小写字母数字加 - 和 _，2~32 位。
 * 为什么不让用中文：它同时是目录名，还得进 URL 和 manifest。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidSpaceId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(id);
}

/**
 * 显示名清洗：去空白、不能为空、最长 24 字。
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeSpaceName(name) {
  const s = String(name ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  if (s === '') return '';
  return s.slice(0, 24);
}

/**
 * 从显示名造一个 id。中文名造不出有意义的 slug，就退成 `space-N`。
 * @param {string} name
 * @param {string[]} taken 已被占用的 id
 * @returns {string}
 */
export function makeSpaceId(name, taken = []) {
  const used = new Set((Array.isArray(taken) ? taken : []).map((s) => String(s)));
  const ascii = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let base = ascii.length >= 2 ? ascii.slice(0, 24) : 'space';
  if (base === 'spaces' || base === 'trash') base = `${base}-1`;
  if (!used.has(base)) return base;
  for (let i = 2; i <= 99; i += 1) {
    const cand = `${base}-${i}`.slice(0, 32);
    if (!used.has(cand)) return cand;
  }
  return `space-${Date.now().toString(36)}`.slice(0, 32);
}

/**
 * 空注册表。
 * @param {number} [now]
 */
export function emptyRegistry(now = Date.now()) {
  return {
    version: 1,
    active: DEFAULT_SPACE_ID,
    spaces: [
      {
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAME,
        createdAt: new Date(now).toISOString(),
      },
    ],
  };
}

/**
 * 读出来的注册表整流：坏的丢掉、缺的补上，永远返回一份能用的。
 * **永不抛错** —— 注册表坏了最多回退到「只有一个默认分区」。
 *
 * @param {unknown} raw
 * @param {number} [now]
 * @returns {{registry: {version:number, active:string, spaces:object[]}, problems: string[]}}
 */
export function parseRegistry(raw, now = Date.now()) {
  const problems = [];
  if (raw === null || typeof raw !== 'object') {
    return { registry: emptyRegistry(now), problems: ['注册表为空或不是对象，已按「只有一个默认分区」处理'] };
  }

  /** @type {object[]} */
  const spaces = [];
  const seen = new Set();
  const list = Array.isArray(raw.spaces) ? raw.spaces : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const id = String(item.id ?? '').trim();
    if (!isValidSpaceId(id)) {
      problems.push(`分区 id 不合法，已跳过：${JSON.stringify(item.id)}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`分区 id 重复，已跳过：${id}`);
      continue;
    }
    const name = normalizeSpaceName(item.name) || id;
    seen.add(id);
    spaces.push({
      id,
      name,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(now).toISOString(),
    });
  }

  if (spaces.length === 0) {
    problems.push('注册表里一个合法分区都没有，已重建默认分区');
    return { registry: emptyRegistry(now), problems };
  }

  if (spaces.length > MAX_SPACES) {
    problems.push(`分区超过 ${MAX_SPACES} 个，后面的已忽略`);
    spaces.length = MAX_SPACES;
    for (const s of spaces) seen.add(s.id);
  }

  const wanted = String(raw.active ?? '').trim();
  let active = spaces[0].id;
  if (isValidSpaceId(wanted) && seen.has(wanted)) {
    active = wanted;
  } else if (wanted !== '') {
    problems.push(`激活的分区不存在（${wanted}），已回退到 ${active}`);
  }

  return { registry: { version: 1, active, spaces }, problems };
}

/**
 * 分区目录的绝对路径。
 * @param {string} root 库根
 * @param {string} id
 */
export function spaceDirOf(root, id) {
  return path.join(root, SPACES_DIR, id);
}

/** 注册表里找分区。 */
export function findSpace(registry, id) {
  const list = Array.isArray(registry?.spaces) ? registry.spaces : [];
  return list.find((s) => s.id === id) ?? null;
}

/**
 * 这次启动要不要把「根目录里的老库」搬进分区。
 *
 * 三个条件同时成立才搬（宁可不动，也别乱搬）：
 *   1. `spaces/` 目录不存在 —— 说明还是老结构
 *   2. 根目录里至少有 short.jsonl / long.jsonl / permanent.jsonl 其中之一
 *   3. 目标分区目录还不存在
 *
 * @param {{rootHasSpacesDir: boolean, rootFiles: string[], targetDirExists: boolean}} opts
 * @returns {{needed: boolean, reason: string, files: string[], dirs: string[]}}
 */
export function planLegacyMigration(opts) {
  const rootHasSpacesDir = opts?.rootHasSpacesDir === true;
  const targetDirExists = opts?.targetDirExists === true;
  const present = new Set((Array.isArray(opts?.rootFiles) ? opts.rootFiles : []).map((s) => String(s)));

  if (rootHasSpacesDir) return { needed: false, reason: 'spaces/ 已经有了，不动', files: [], dirs: [] };
  const hasLib = ['short.jsonl', 'long.jsonl', 'permanent.jsonl'].some((f) => present.has(f));
  if (!hasLib) return { needed: false, reason: '根目录里没有老库文件', files: [], dirs: [] };
  if (targetDirExists) {
    return { needed: false, reason: `目标分区目录已存在（${SPACES_DIR}/${DEFAULT_SPACE_ID}），不覆盖`, files: [], dirs: [] };
  }

  const files = LEGACY_LIB_FILES.filter((f) => present.has(f));
  const dirs = LEGACY_LIB_DIRS.filter(() => true);
  return { needed: true, reason: '发现老结构的库，准备搬进默认分区', files, dirs };
}

/**
 * 这台机器上「一份记忆库该长什么样」—— 迁移校验用。
 * 条数对不上就不许删原件，这是最后一道闸。
 *
 * @param {Record<string, number>} counts 分区目录里的条数
 * @param {Record<string, number>} expect 根目录里的条数
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyMigration(counts, expect) {
  const problems = [];
  for (const zone of ['short', 'long', 'permanent']) {
    const a = Number(expect?.[zone]) || 0;
    const b = Number(counts?.[zone]) || 0;
    if (a !== b) problems.push(`${zone} 条数不一致：原库 ${a} / 分区 ${b}`);
  }
  return { ok: problems.length === 0, problems };
}
