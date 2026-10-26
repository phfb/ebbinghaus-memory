/**
 * Ebbinghaus-memory · Host 半边
 *
 * 把「对话 → 记忆」这条链在 DSH 里接起来：
 *
 *   session/event（采集） → agent/turn-stopping（闸门，同步极快）
 *     → 带外队列（setImmediate 推出调用栈） → llm.stream 固化
 *     → normalizeEntry → store.add → harvest → 压缩 → store.save()
 *     → systemPrompt.section（注入） / tools / webServer
 *
 * ── 四条不可破的工程约束（都是踩过的坑，别改） ──
 *
 *  1. **绝不能挡住聊天。** 所有事件回调、注入函数、HTTP 处理都包 try/catch。
 *     记忆坏了只降级成「这次没记住」，绝不向上抛。
 *
 *  2. **`agent/turn-stopping` 是 serial 事件，会被 await。**
 *     那里只做本地计数与入队（微秒级），模型调用一律 setImmediate 推出
 *     这个调用栈 —— 否则 `llm.stream` 会死等回合锁，表现为「永不返回且不报错」。
 *
 *  3. **后台任务要 ref 地拖住事件循环**（`holdProcessOpen()`）。
 *     一次性会话（headless）回合结束就退进程，带外工作没人等 —— 症状是
 *     「时好时坏，模型答了记忆没了」。用 `unref()` 等于没人在等。
 *
 *  4. **目录在 `apply()` 里一次算定。** 不懒读 `$DSH_HOME` —— 环境变量中途
 *     变了会静默写到另一个目录，而且没有任何报错。
 *
 * 零运行时依赖：不 import 任何 `@deepseek-ai/dsh-*`（schemastery 也只是试探性
 * require，拿不到就没有设置表单，功能一样不少）。
 */

import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  CONFIG_SPEC,
  TUNABLE_KEYS,
  applyOverrides,
  buildSchema,
  resolveConfig,
  tunableFields,
} from '../core/config.mjs';
import { pickReclaimGroup, tokenUsage, totalCapacityOf } from '../core/budget.mjs';
import { dedupEveryOf, dedupThresholdOf, findDuplicateGroups, mergeDuplicateGroup } from '../core/dedup.mjs';
import {
  MANIFEST_FILE,
  RESTORE_CMD,
  RESTORE_PS1,
  buildManifest,
  isSafeMirrorDir,
  planMirror,
  renderRestoreCmd,
  renderRestorePs1,
  shouldSkipName,
} from '../core/mirror.mjs';
import { createStore } from '../core/store.mjs';
import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  LEGACY_LIB_DIRS,
  REGISTRY_FILE,
  SPACES_DIR,
  emptyRegistry,
  findSpace,
  parseRegistry,
  planLegacyMigration,
  spaceDirOf,
  verifyMigration,
} from '../core/spaces.mjs';
import { ZONE_LABEL, ZONES, normalizeEntry } from '../core/schema.mjs';
import { expiryOverview, fullStamp, relativeStamp, stampFor } from '../core/time.mjs';
import { harvest, initialZoneFor, isOverCapacity, digestDropped } from '../core/zones.mjs';
import { compressWithModel, fallbackMerge, pickCompressGroup } from '../core/compress.mjs';
import { autoRecall, pickFromCandidates, search } from '../core/recall.mjs';
import { renderEntryLine, renderInjection } from '../core/render.mjs';

/* ───────────────────────── 插件身份 ───────────────────────── */

/** Cordis 里只有这几个导出会被读。 */
export const name = 'ebbinghaus-memory';

/**
 * 硬依赖留空：服务全部用 `ctx.get` / `ctx.inject` 懒取。
 *
 * 写成 `inject: ['llm', 'webServer', ...]` 的后果是 headless / 纯 CLI 组合里
 * 缺一个服务插件就永远不激活 —— 对一个「装上就该忘掉它」的记忆插件，
 * 这个失败模式不能接受。少了 webServer，面板不出现，记忆照常工作。
 */
export const inject = [];

/**
 * Config **可选**。schemastery 只在能 require 到的时候才用；
 * 拿不到就没有设置页表单，但 `cordis.patch.yml` 里的 `config:` 照写不误，
 * `resolveConfig()` 自己补默认值，行为完全一致。
 */
export const Config = (() => {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@deepseek-ai/schemastery');
    const z = mod?.default ?? mod;
    if (z !== undefined && z !== null && typeof z.object === 'function') return buildSchema(z);
  } catch {
    // 拿不到就没有表单，不影响任何功能
  }
  return undefined;
})();

/* ───────────────────────── 常量 ───────────────────────── */

/** 注入段名与顺序（§12.7 冻结）。 */
const SECTION_NAME = 'ebbinghaus:memory';
/** 晚于人设（0），早于计划策略（500）。 */
const SECTION_ORDER = 110;

/** 内存里保留的对话条数上限。固化只取最近这几条，全量没有意义。 */
const MAX_TRANSCRIPT = 40;
/** 固化送给模型的最近消息条数。 */
const CONSOLIDATE_TAIL = 14;
/** 单条消息送进模型前截断的字符数（防一次长贴图把 maxTokens 吃光）。 */
const MAX_MESSAGE_CHARS = 1200;
/** 面板每区一次最多回多少条（§ lead 冻结）。 */
const PANEL_MAX_ENTRIES = 50;
/** HTTP 请求体上限。我们只收 id / zone / 几个数字，8KB 足够。 */
const MAX_BODY_BYTES = 8192;

/**
 * 面板设置文件名（落在记忆库目录里）。
 *
 * 为什么不写回 profile 的 `cordis.patch.yml`：那个文件是 DSH 的财产，
 * 顶层是 `insert:` 数组、还有别的插件在写，一个插件去改它等于两只手同时
 * 编辑同一个 yml —— 改坏了整份配置读不出来，插件全挂。所以自己留一份
 * 覆盖层：DSH 配置是底座，这个是用户临时拧的旋钮，删掉就回到底座。
 */
const SETTINGS_FILE = 'settings.json';

/**
 * 自检进度（落在记忆库目录里）。
 *
 * 为什么要落盘：`entriesSinceCheck` 只存在内存里的话，每次重启 DSH 都归零，
 * 于是「每 30 条自检一次」变成「每 30 条、或者每次重启后第一次写记忆」——
 * 你一天重开十次 DSH，它就跑十次，全白跑。
 *
 * 记的是：自上次自检以来新写了多少条、上次什么时候跑的、合并了几组、省了几条。
 */
const DEDUP_STATE_FILE = 'dedup-state.json';
/** 镜像同步进度（落在库目录）。和自检那个同一个理由：不落盘就会每次重启归零。 */
const MIRROR_STATE_FILE = 'mirror-state.json';

/** 总量回收一次最多压几轮。防配置异常时死循环。 */
const TOTAL_RECLAIM_MAX_ROUNDS = 24;

/** 一次自检最多合几轮（合完新的条目可能又和别的重复）。 */
const DEDUP_MAX_ROUNDS = 5;

const SEARCH_TOOL_NAME = 'memory_search';
const STATS_TOOL_NAME = 'memory_stats';

/**
 * 固化提示词 —— **SPEC §14 原文，冻结**。
 * 改一个字都可能让模型开始输出解释文字，解析整批丢弃。
 */
export const CONSOLIDATE_SYSTEM = `你是记忆固化器。把这段对话压缩成 1-3 条记忆条目。

规则：
1. 只记事实与偏好，不记寒暄、不记你的建议、不记你自己说的话里的客套。
2. 每条必须自带时间戳（用给定的事件时间）。
3. weight：0.1=琐碎 0.5=有用 0.8=重要 0.95=核心（人格/习惯/雷区/长期项目）
4. zone = 你判断这条该进哪一层：
   - "permanent"：关于这个人本身、不会过期的东西 —— 人格、习惯、雷区、说话方式、长期在做的项目
   - "long"：一件有意义的事，过些天还值得被想起来
   - "short"：刚发生的事、临时状态、一次性的技术细节
   拿不准就给 "short"。别为了讨好对方把什么都写成 permanent —— 那样分层就废了。
5. 时间词（昨天/刚才）一律去掉，时间由 ts 字段承载。
6. 输出**严格 JSON 数组**，不要解释、不要 markdown 围栏。

输出格式：
[{"ts":1761321600000,"weight":0.7,"zone":"short","title":"≤40字","detail":"≤200字","keywords":["2-6个词"]}]`;

/* ───────────────────────── 纯函数小工具 ───────────────────────── */

/** DSH 主目录。`$DSH_HOME` 优先，否则 `~/.dsh`。**只在 apply 里用一次。** */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(homedir(), '.dsh');
}

/**
 * 记忆库目录。**在 `apply()` 时一次算定**，之后全程用这个值。
 *
 * `[object Object]` 那道防线是给 schemastery 的 `.volatile()` 坑留的：
 * 空字符串默认值被包成对象后会变成字符串 `'[object Object]'`，
 * `path.resolve()` 一拼就把整个记忆库写进一个叫 `[object Object]` 的目录，
 * 全程没有任何报错。配置文件里也见过这个目录，所以这里硬拦。
 */
function resolveDataDir(config) {
  const raw = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  const explicit = raw.includes('[object Object]') ? '' : raw;
  return explicit !== '' ? path.resolve(explicit) : path.join(dshHome(), 'ebbinghaus-memory');
}

/** 数一个 jsonl 有几条（迁移校验用）。 */
function countJsonlLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((s) => s.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * 保证库根下有分区结构，必要时把「根目录里的老库」搬进默认分区。
 *
 * 三条纪律：
 *  1. **先复制、校验条数、才删原件** —— 任何一步不对就回滚，老库一个字节都不动。
 *  2. 校验失败不抛错，退回「直接用根目录当库」（降级模式），插件照常能用。
 *  3. 全新库也走 spaces/ 结构，不做特例 —— 否则以后每次判断都要分叉。
 *
 * @param {string} root 库根（配置里的 dataDir）
 * @param {(m:string)=>void} [log]
 * @param {(m:string)=>void} [warn]
 */
function ensureSpaces(root, log = () => {}, warn = () => {}) {
  /** @type {any} */
  const out = {
    activeId: DEFAULT_SPACE_ID,
    activeName: DEFAULT_SPACE_NAME,
    spaceDir: root,
    spaces: [],
    migrated: false,
    degraded: false,
    problems: [],
  };
  try {
    mkdirSync(root, { recursive: true });
    const spacesRoot = path.join(root, SPACES_DIR);
    const hasSpacesDir = existsSync(spacesRoot);
    let rootFiles = [];
    try {
      rootFiles = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      rootFiles = [];
    }

    // ── ① 老库迁移 ──
    const targetDir = spaceDirOf(root, DEFAULT_SPACE_ID);
    const plan = planLegacyMigration({
      rootHasSpacesDir: hasSpacesDir,
      rootFiles,
      targetDirExists: existsSync(targetDir),
    });
    if (plan.needed) {
      const expect = {
        short: countJsonlLines(path.join(root, 'short.jsonl')),
        long: countJsonlLines(path.join(root, 'long.jsonl')),
        permanent: countJsonlLines(path.join(root, 'permanent.jsonl')),
      };
      mkdirSync(targetDir, { recursive: true });
      for (const name of plan.files) {
        const from = path.join(root, name);
        if (existsSync(from)) copyFileSync(from, path.join(targetDir, name));
      }
      for (const name of plan.dirs) {
        const from = path.join(root, name);
        if (existsSync(from)) cpSync(from, path.join(targetDir, name), { recursive: true, force: true });
      }
      const got = {
        short: countJsonlLines(path.join(targetDir, 'short.jsonl')),
        long: countJsonlLines(path.join(targetDir, 'long.jsonl')),
        permanent: countJsonlLines(path.join(targetDir, 'permanent.jsonl')),
      };
      const check = verifyMigration(got, expect);
      if (!check.ok) {
        try {
          rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // 删不掉也不影响老库
        }
        out.degraded = true;
        out.problems.push(...check.problems);
        warn(`分区迁移校验没过，已回滚（老库没动）：${check.problems.join('；')}`);
        return out;
      }
      for (const name of plan.files) {
        try {
          unlinkSync(path.join(root, name));
        } catch {
          // 删不掉就留着，spaces/ 已经存在，下次不会再搬一次
        }
      }
      for (const name of plan.dirs) {
        try {
          rmSync(path.join(root, name), { recursive: true, force: true });
        } catch {
          // 同上
        }
      }
      out.migrated = true;
      log(`老库已搬进分区「${DEFAULT_SPACE_NAME}」（${expect.short}/${expect.long}/${expect.permanent} 条）`);
    }

    // ── ② 注册表 ──
    const regPath = path.join(root, REGISTRY_FILE);
    let registry;
    if (existsSync(regPath)) {
      try {
        const parsed = parseRegistry(JSON.parse(readFileSync(regPath, 'utf8')));
        registry = parsed.registry;
        out.problems.push(...parsed.problems);
      } catch (err) {
        registry = emptyRegistry();
        out.problems.push(`spaces.json 读不了，按单分区处理：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      registry = emptyRegistry();
    }

    // ── ③ 激活分区目录 ──
    const activeDef = findSpace(registry, registry.active) ?? registry.spaces[0];
    const dir = spaceDirOf(root, activeDef.id);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(regPath)) {
      writeFileSync(regPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    }

    out.activeId = activeDef.id;
    out.activeName = activeDef.name;
    out.spaceDir = dir;
    out.spaces = registry.spaces;
    return out;
  } catch (err) {
    out.degraded = true;
    out.problems.push(`分区初始化失败，退回直接用库根：${err instanceof Error ? err.message : String(err)}`);
    warn(out.problems[out.problems.length - 1]);
    return out;
  }
}
/** 仅供单测：分区初始化/迁移。**/
export const __spacesTest = { ensureSpaces };


/* ───────────────── 面板设置的持久化（settings.json 覆盖层） ───────────────── */

/** `<dataDir>/settings.json` —— 面板拧过的旋钮。删掉就回到底座配置。 */
function settingsPathOf(dir) {
  return path.join(dir, SETTINGS_FILE);
}

/**
 * 读覆盖层。坏文件 → 空覆盖 + 一句 warn，**绝不抛**。
 *
 * 这里不校验白名单：`applyOverrides()` 会过一遍，非法键被它拒掉并报告。
 * 但读进来时要把非对象抹平 —— `[]` 和 `"x"` 都不是覆盖层。
 *
 * @param {string} dir
 * @param {(...a:any[])=>void} warn
 * @returns {Record<string, any>}
 */
function readSettingsOverrides(dir, warn) {
  try {
    const p = settingsPathOf(dir);
    if (!existsSync(p)) return {};
    const text = readFileSync(p, 'utf8');
    if (text.trim() === '') return {};
    const raw = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return /** @type {Record<string, any>} */ (raw);
  } catch (err) {
    warn(`读 settings.json 失败，这次忽略面板覆盖值：${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * 写覆盖层。原子替换（tmp → rename），失败只 warn。
 *
 * 只写白名单键：面板之外的东西（dataDir / enabled / provider）不许借这条路进来。
 *
 * @param {string} dir
 * @param {Record<string, any>} overrides
 */
function writeSettingsOverrides(dir, overrides) {
  mkdirSync(dir, { recursive: true });
  const p = settingsPathOf(dir);
  const tmp = `${p}.tmp-${process.pid}`;
  // Node 的 utf8 写盘不带 BOM（PowerShell 的 Set-Content 会带）——
  // 带 BOM 的 JSON 会让下一次 JSON.parse 直接失败。
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
  renameSync(tmp, p);
}

/* ───────────────── 自检进度（dedup-state.json） ───────────────── */

/** 自检进度的全零形状。 */
function emptyDedupState() {
  return {
    /** 自上次自检以来新写了几条（够了就触发） */
    entriesSinceCheck: 0,
    /** 上次自检时间（0 = 从没跑过） */
    lastCheckAt: 0,
    lastGroups: 0,
    lastMerged: 0,
    lastChecked: 0,
    totalGroups: 0,
    totalMerged: 0,
  };
}

/**
 * 读自检进度。坏文件 → 全零，**绝不抛**。
 * @param {string} dir
 * @param {(msg:string)=>void} warn
 * @returns {ReturnType<typeof emptyDedupState>}
 */
function readDedupState(dir, warn) {
  const empty = emptyDedupState();
  try {
    const p = path.join(dir, DEDUP_STATE_FILE);
    if (!existsSync(p)) return empty;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
    return {
      entriesSinceCheck: num(raw.entriesSinceCheck),
      lastCheckAt: num(raw.lastCheckAt),
      lastGroups: num(raw.lastGroups),
      lastMerged: num(raw.lastMerged),
      lastChecked: num(raw.lastChecked),
      totalGroups: num(raw.totalGroups),
      totalMerged: num(raw.totalMerged),
    };
  } catch (err) {
    warn(`读 ${DEDUP_STATE_FILE} 失败，进度从零算：${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

/**
 * 写自检进度。**失败只 warn** —— 进度丢了最多多跑一次自检，不该挡住任何事。
 * @param {string} dir
 * @param {ReturnType<typeof emptyDedupState>} state
 */
function writeDedupState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, DEDUP_STATE_FILE);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch {
    // 进度不是数据，写不了就算了
  }
}

/**
 * 剥掉模型偶尔还是会吐的 ```` ```json ```` 围栏。
 * @param {unknown} text
 * @returns {string}
 */
export function stripJsonFence(text) {
  const s = String(text ?? '').trim();
  if (s === '') return '';
  const fenced = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(s);
  if (fenced !== null) return fenced[1].trim();
  return s;
}

/**
 * 解析固化输出。
 *
 * **失败整批丢弃**（返回 null）—— 半成品写进档案比漏记危险得多：
 * 漏记只是少一条，半成品会让后面每一次检索都撞上一条残缺的记忆。
 *
 * @param {unknown} text 模型返回的正文
 * @returns {object[]|null} 干净的原始条目数组，或 null（整批丢弃）
 */
export function parseConsolidationOutput(text) {
  const body = stripJsonFence(text);
  if (body === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // 数组里非对象的成员直接剔除；一条都不剩也算"没内容"，但仍是合法空批
  return parsed.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** 三个分区里的下一个区（压缩后的落点）。 */
function nextZone(zone) {
  return zone === 'short' ? 'long' : 'permanent';
}

/* ───────────────────────── 插件主体 ───────────────────────── */

/**
 * @param {any} ctx Cordis context
 * @param {any} rawConfig 行配置（可能未经校验，resolveConfig 会补默认值）
 */
export function apply(ctx, rawConfig) {
  /**
   * `baseConfig` = DSH 配置（cordis.patch.yml + 设置页）解析出来的原值，**只读**。
   * `config` = 把 `<dataDir>/settings.json` 的覆盖叠上去之后的生效值。
   *
   * 两份都要留：面板里「恢复 DSH 配置」就是把覆盖层清空、`config` 重新等于
   * `baseConfig`。只留一份的话，用户拧坏了就没路了 —— 只能去翻 yml。
   */
  const baseConfig = resolveConfig(rawConfig);
  /** 记忆库目录：apply 时一次算定 */
  /** 库根（配置里的 dataDir）：里面放 spaces.json 和 spaces\ 分区目录。 */
  const libraryRoot = resolveDataDir(baseConfig);
  /** 分区账本：当前激活哪个、都有哪些、有没有刚搬过家。 */
  const spaceInfo = ensureSpaces(libraryRoot);
  /** 当前激活分区的目录 —— 下面几百行里所有的「库目录」指的都是它。 */
  const dataDir = spaceInfo.spaceDir;
  /**
   * 读覆盖层要赶在 `emit()` 定义之前（`emit` 自己要用 config）。
   * 所以这里用一个只走 ctx.logger 的极简出口 —— 读失败本身就是异常路径，
   * 少了 stderr / 文件两个去向可以接受。
   */
  const earlyWarn = (msg) => {
    try {
      ctx.logger?.warn?.(`[ebbinghaus] ${msg}`);
    } catch {
      // logger 坏了不影响功能
    }
  };
  /** 面板当前生效的覆盖值（跟 settings.json 内容一致） */
  let settingsOverrides = readSettingsOverrides(dataDir, earlyWarn);
  /** 生效配置。**`let`**：面板改设置时要整体换一份。 */
  let config = applyOverrides(baseConfig, settingsOverrides).config;
  /**
   * 自检进度。**必须落盘**：只存内存的话每次重启都归零，
   * 「每 30 条自检一次」会变成「每 30 条，或者每次重开 DSH 后第一次写记忆」。
   */
  let dedupState = readDedupState(dataDir, earlyWarn);

  /* 分区账本攒下的问题，等 config 初始化完再播报（ensureSpaces 那会儿调 warn 会踩 TDZ）。 */
  for (const msg of spaceInfo.problems) warn(`分区：${msg}`);
  if (spaceInfo.migrated) log(`老库已搬进分区「${spaceInfo.activeName}」（${dataDir}）`);
  if (spaceInfo.degraded) warn('分区初始化降级：仍然直接用库根当记忆库');

  /* ── 日志：只打形状，绝不落盘对话正文 ── */

  const DEBUG_LOG_FILE = 'ebbinghaus.debug.log';

  /**
   * 三份去向，理由各不相同：
   *  - `ctx.logger`：正式渠道（桌面端界面能看到）
   *  - `stderr`：headless 下 logger 可能没人接
   *  - 文件：一次性会话直接退进程时，前两份都会丢 —— 只有落文件留得住
   *
   * **只有 `debugLog: true` 才写文件**，且只写条数/耗时/分区计数（SPEC §17）。
   */
  function emit(level, args) {
    const line = `[ebbinghaus] ${args.join(' ')}`;
    try {
      ctx.logger?.[level]?.(line);
    } catch {
      // logger 坏了不影响功能
    }
    if (!config.debugLog) return;
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // 没有 stderr 就只走 logger
    }
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(path.join(dataDir, DEBUG_LOG_FILE), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // 写不了就算了，日志不该影响功能
    }
  }
  function log(...args) {
    if (config.debugLog) emit('info', args);
  }
  /** 告警永远打：出事时用户至少能在日志里看见一行。 */
  function warn(...args) {
    emit('warn', args);
  }

  /* ── 记忆库 ── */

  const store = createStore({ dir: dataDir, log, warn });

  let ready = false;
  /** 磁盘坏了就只读不写 —— 绝不因为记忆坏了挡住聊天。 */
  let degraded = false;

  const abort = new AbortController();

  /** @type {Map<string, {turn:number,lastWriteTurn:number,lastUserText:string,transcript:{role:'user'|'assistant',text:string}[],renderCache:{turn:number,text:string},queued:boolean}>} */
  const sessionStates = new Map();

  function stateOf(sessionId) {
    let s = sessionStates.get(sessionId);
    if (s === undefined) {
      s = {
        turn: 0,
        lastWriteTurn: 0,
        lastUserText: '',
        transcript: [],
        renderCache: { turn: -1, text: '' },
        queued: false,
        /** 上一轮列过候选、这一轮他点了某条时，挂着那一条，下一次渲染只读它 */
        confirmedRecall: null,
        /** 点名之后要藏掉的 id（同批的其他候选），用一次就清 */
        hiddenRecallIds: null,
      };
      sessionStates.set(sessionId, s);
    }
    return s;
  }

  /** 作废某会话的注入缓存（写盘/删除/压缩后必须调）。 */
  function invalidateRender(sessionId) {
    const s = sessionStates.get(sessionId);
    if (s !== undefined) s.renderCache = { turn: -1, text: '' };
  }
  function invalidateAllRenders() {
    for (const s of sessionStates.values()) s.renderCache = { turn: -1, text: '' };
  }

  /** 载入（幂等）。坏文件 → 空数组 + warn，绝不抛。 */
  const loadPromise = (async () => {
    try {
      const r = await store.load();
      if (r?.ok === false) {
        degraded = true;
        warn('记忆库载入失败，本次以「只读不记」模式运行');
        return;
      }
      ready = true;
      log('记忆库就绪');
    } catch (err) {
      degraded = true;
      warn(`记忆库载入异常，本次以「只读不记」模式运行：${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  /* ── 注入：每个 agent 一段 ── */

  /**
   * 为某个会话渲染注入文本。
   *
   * **按 (sessionId, turn) 缓存**：`assemble` 每个 model step 都会调一次，
   * 一个回合可能有几十个 step（工具调用）。不缓存的话，同一个回合里
   * 会换着花样想起不同的事 —— 很出戏，而且检索冷却会白白烧掉。
   */
  function renderFor(agentId) {
    if (!ready || degraded || !config.enabled) return '';
    const s = stateOf(agentId);
    if (s.renderCache.turn === s.turn) return s.renderCache.text;

    let text = '';
    try {
      /** @type {object[]} */
      let recalled = [];
      let hideIds = null;
      try {
        // 上一轮列过候选、这一轮他点了某一条 → 只读那一条
        if (s.confirmedRecall !== null && s.confirmedRecall !== undefined) {
          recalled = [s.confirmedRecall];
          hideIds = s.hiddenRecallIds;
          s.confirmedRecall = null;
          s.hiddenRecallIds = null;
          log('他点名了上一次列出的候选之一，只读那一条');
        } else {
          recalled = autoRecall(store.zones, s.lastUserText, config) ?? [];
          // 命中 ≥2 条：不猜，列清单让他挑（渲染层会变成候选模式）。
          // 把候选记下来，下一轮他说「22 号那个」时从这里挑。
          if (recalled.length >= 2) {
            pendingRecall.set(agentId, { candidates: recalled, at: Date.now() });
          }
        }
      } catch (err) {
        warn(`自动检索失败（这一轮不摘旧事）：${err instanceof Error ? err.message : String(err)}`);
        recalled = [];
        hideIds = null;
      }
      touch(recalled);

      const rendered = renderInjection({
        zones: store.zones,
        cfg: config,
        now: Date.now(),
        recalled,
        hideIds,
        budgetTokens: config.budgetTokens,
      });
      text = typeof rendered?.text === 'string' ? rendered.text : '';
      log(
        `注入：${Number(rendered?.tokens) || 0} token · 想起 ${recalled.length} 条 · ` +
          `短 ${store.zones.short.length}/长 ${store.zones.long.length}/永 ${store.zones.permanent.length}`,
      );
    } catch (err) {
      warn(`渲染记忆失败（这块跳过）：${err instanceof Error ? err.message : String(err)}`);
      text = '';
    }

    s.renderCache = { turn: s.turn, text };
    return text;
  }

  /**
   * 标记「最近被想起」。只改内存，不额外写盘 —— 下一次正常落盘时带出去。
   * 写盘不是这件事的语义，为了它多写一次盘不值得。
   */
  function touch(entries) {
    const now = Date.now();
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e !== null && typeof e === 'object') e.touchedAt = now;
    }
  }

  /** agent → fiber（scoped 注册的手柄），用于释放。 */
  const promptFibers = new Map();

  function installPrompt(agent) {
    if (agent === undefined || agent === null) return undefined;
    if (promptFibers.has(agent)) return promptFibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          // 每次 assemble 重新求值；内部按轮缓存
          text: () => renderFor(agent.id),
          // 记忆文本里可能出现 {{ }}，绝不能当模板解析
          interpolate: false,
        });
      });
    } catch (err) {
      warn(`注册记忆段失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    promptFibers.set(agent, fiber);
    log(`已为会话 ${String(agent.id)} 注册记忆段`);
    // 官方 practices：agent.ctx 上的注册有两个 owner，插件自己也要留一份 disposer
    ctx.effect(
      () => () => {
        const f = promptFibers.get(agent);
        if (f === undefined) return;
        promptFibers.delete(agent);
        try {
          void f?.dispose?.();
        } catch {
          // 释放失败不该影响卸载
        }
      },
      `ebbinghaus: dispose prompt for ${String(agent?.id ?? '?')}`,
    );
    return fiber;
  }

  // 已经存在的 agent 先补一遍。用 ctx.get 而不是 ctx.agents —— 我们 inject 是空的，
  // 直接摸一个没注入的服务属性在 cordis 里会抛，try/catch 兜住也没必要硬碰。
  try {
    const agents = ctx.get('agents');
    for (const agent of agents?.list?.() ?? []) installPrompt(agent);
  } catch (err) {
    warn(`枚举已有会话失败：${err instanceof Error ? err.message : String(err)}`);
  }

  ctx.on('agent/created', (payload) => {
    try {
      installPrompt(payload?.agent);
    } catch (err) {
      warn(`agent/created 处理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent;
      const f = promptFibers.get(agent);
      if (f !== undefined) {
        promptFibers.delete(agent);
        void f?.dispose?.();
      }
      if (agent !== undefined && typeof agent?.id === 'string') sessionStates.delete(agent.id);
    } catch (err) {
      warn(`agent/disposed 处理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /* ── 采集：只做本地记账，零 I/O、零模型 ── */

  ctx.on('session/event', (session, event) => {
    try {
      if (!config.enabled) return;
      // ⚠️ 子代理（subagent / Agent Teams）的对话**不是「他和我」的对话**。
      //
      // dsh-subagent 派活时给子代理的第一条 prompt 用的是 `source: { kind: 'user' }`
      // （见 dsh-subagent 的 submitMaterialized 调用），所以只靠 source.kind 过滤
      // 挡不住它 —— 子代理的任务书会被当成人话收进来，然后固化进记忆库。
      // 那本记忆里就会长出一堆「core-agent 在写 zones.mjs」。
      //
      // session.header.parentSession 是子代理与父会话的持久链接（fork 继承的会话
      // 也有它），所以这一条能同时挡住「新派的子代理」和「从父会话 fork 出来的」。
      const parentSession = session?.header?.parentSession;
      if (parentSession !== undefined && parentSession !== null) return;

      const id = session?.id;
      if (typeof id !== 'string' || id === '') return;
      const s = stateOf(id);

      if (event?.type === 'user/message') {
        // 必须过滤掉注入进来的消息，只要真人打的字
        if (event.data?.source?.kind !== 'user') return;
        const text = (event.data?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text === '') return;

        // 上一轮列过「有几条对得上，是哪个？」，这一轮先看他是不是在回答那个问题。
        try {
          const pend = pendingRecall.get(id);
          if (pend !== undefined) {
            if (Date.now() - pend.at > PENDING_RECALL_MS) {
              pendingRecall.delete(id);
            } else {
              const picked = pickFromCandidates(pend.candidates, text);
              if (picked !== null) {
                s.confirmedRecall = picked;
                // 「只读那一条」：同批的其他候选要从注入里彻底拿掉，
                // 否则它们在短期区里还会照常出现，等于没做这个功能。
                s.hiddenRecallIds = new Set(
                  pend.candidates
                    .map((e) => String(e?.id ?? ''))
                    .filter((id) => id !== '' && id !== String(picked.id)),
                );
                pendingRecall.delete(id);
                log('他回答了上次的候选提问，锁定其中一条');
              }
            }
          }
        } catch (err) {
          warn(`候选判定失败（照常检索）：${err instanceof Error ? err.message : String(err)}`);
        }

        s.turn += 1;
        s.lastUserText = text;
        // 新一轮：作废注入缓存
        s.renderCache = { turn: -1, text: '' };
        s.transcript.push({ role: 'user', text: text.slice(0, MAX_MESSAGE_CHARS) });
        if (s.transcript.length > MAX_TRANSCRIPT) {
          s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT);
        }
        return;
      }

      if (event?.type === 'assistant/message') {
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text === '') return;
        s.transcript.push({ role: 'assistant', text: text.slice(0, MAX_MESSAGE_CHARS) });
        if (s.transcript.length > MAX_TRANSCRIPT) {
          s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT);
        }
      }
    } catch (err) {
      warn(`采集会话事件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /* ── 闸门 + 带外队列 ── */

  /**
   * 最近一次固化的结果。
   *
   * 为什么要有它：固化有六种「静默跳过」的路径 —— 没有可用模型、输出被截断、
   * JSON 解析失败、模型判断不值得记、条目全没过校验、没到 writeEveryTurns。
   * 它们全都只写日志、不打扰用户，于是用户看到的现象是「聊了三天，记忆一条没涨」，
   * 而且不知道卡在哪一步。
   *
   * 这个对象让 `memory_stats` / 面板能直接说：「上次尝试 3 分钟前 · 解析失败」。
   */
  /**
   * 上一轮列给用户的候选（「我记得有 3 件对得上，是哪个？」）。
   *
   * 命中 ≥2 条时不该猜，也不该把几条全展开 —— 用户原话：「检索后预读取，
   * 然后说：找到几个有关的，向用户提问并区分是哪个时间或者能够区分和锁定的问题，
   * 再只读取那个正确的记忆和事件。」
   *
   * 这里存候选，下一轮用户说「22 号那个」时用 `pickFromCandidates` 挑出来，
   * 只把那一条注入。10 分钟没回应就作废（人不会隔一小时还在回这句话）。
   */
  const pendingRecall = new Map();
  const PENDING_RECALL_MS = 10 * 60 * 1000;

  let lastAttempt = { at: 0, outcome: 'never', added: 0 };

  /** @param {string} outcome @param {number} [added] */
  function noteAttempt(outcome, added = 0) {
    lastAttempt = { at: Date.now(), outcome, added, total: store.all().length };
    return undefined;
  }

  /** @type {Array<{sessionId: string, agent: any}>} */
  const queue = [];
  let draining = false;
  /** 当前这轮后台工作的 promise（服务/导出要等它）。 */
  let drainPromise = Promise.resolve();

  /**
   * 有活时**主动拖住事件循环**，干完再放手。
   *
   * 必须是一个 **ref 的** interval：`unref()` 等于没人在等 ——
   * 一次性会话回合结束照样退进程，症状是「时好时坏」。
   */
  let keepAlive = null;
  function holdProcessOpen() {
    if (keepAlive !== null) return;
    keepAlive = setInterval(() => {}, 1000);
  }
  function releaseProcessOpen() {
    if (keepAlive === null) return;
    clearInterval(keepAlive);
    keepAlive = null;
  }

  /** 真正跑队列。**只允许由 setImmediate 调起**，见 enqueue 注释。 */
  async function runQueue() {
    try {
      while (queue.length > 0) {
        if (abort.signal.aborted) return;
        const job = queue.shift();
        if (job === undefined) break;
        // 每个任务独立的可中止信号：一次卡住的调用不该把整个插件废掉
        const jobAbort = new AbortController();
        const onPluginAbort = () => jobAbort.abort();
        abort.signal.addEventListener('abort', onPluginAbort, { once: true });
        const timer = setTimeout(() => {
          warn('后台固化超时，这次记忆放弃（宁可漏记，不要挂住进程）');
          jobAbort.abort();
        }, Math.max(1000, Number(config.jobTimeoutMs) || 60000));
        try {
          await consolidate(job.sessionId, job.agent, jobAbort.signal);
        } catch (err) {
          warn(`固化失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onPluginAbort);
          const s = sessionStates.get(job.sessionId);
          if (s !== undefined) s.queued = false;
        }
      }
    } finally {
      draining = false;
      releaseProcessOpen();
    }
  }

  function enqueue(sessionId, agent) {
    const s = stateOf(sessionId);
    if (s.queued) return;
    s.queued = true;
    queue.push({ sessionId, agent });
    if (draining) return;
    draining = true;
    holdProcessOpen();

    // ⚠️ **绝不能在这个事件回调里同步开跑。**
    //
    // `agent/turn-stopping` 是回合生命周期的一部分。在这个调用栈里发起模型
    // 请求会**死等**：端到端验证时表现为 `llm.stream` 永不返回、而且一个字
    // 都不报。原因是异步函数在第一个 await 之前是同步执行的，而
    // `for await (const c of llm.stream(...))` 的 `llm.stream(...)` 恰恰在
    // await 之前就被求值 —— 请求就在回合关闭的栈里发出去了。
    //
    // 推到下一轮事件循环，彻底离开那个调用栈再开始。
    drainPromise = new Promise((resolve) => {
      setImmediate(() => {
        void runQueue().then(resolve);
      });
    });
  }

  /**
   * 把一件事推到下一轮事件循环去跑，并拖住进程直到它结束。
   *
   * 用途：HTTP 处理里刚改完设置，顺手按新上限回收一次 —— 回收要调模型压缩，
   * 不能让面板的保存按钮等上几十秒。**必须 setImmediate 出栈**：HTTP 处理
   * 本身就在一个异步调用栈里，同步发起 `llm.stream` 仍然有死等回合锁的风险。
   *
   * @param {string} label 出问题时日志里显示的名字
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  function runInBackground(label, fn) {
    holdProcessOpen();
    const p = new Promise((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(fn)
          .catch((err) => {
            warn(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
          })
          .then(resolve);
      });
    });
    drainPromise = drainPromise.then(() => p);
    return p;
  }

  ctx.on('agent/turn-stopping', (payload) => {    // ⚠️ 这个事件是 serial，会被 await。必须**同步、极快**地返回。
    try {
      if (!config.enabled || degraded) return;
      const agent = payload?.agent ?? payload;
      const id = agent?.id;
      if (typeof id !== 'string' || id === '') return;
      // 子代理的回合不写记忆 —— 理由见 session/event 那段
      const parentSession = agent?.session?.header?.parentSession;
      if (parentSession !== undefined && parentSession !== null) return;

      const s = stateOf(id);
      if (s.turn === 0 || s.lastUserText === '') return;

      const every = Math.max(1, Math.floor(Number(config.writeEveryTurns) || 1));
      // 这个会话还一次都没写过 → 第一轮就写。
      // 否则「开个新会话问一句就走」在 writeEveryTurns ≥ 2 时**永远记不住**：
      // 第 1 轮 1 - 0 = 1 < 2，然后会话就结束了，那条话白说了。
      const firstWrite = s.lastWriteTurn === 0;
      if (!firstWrite && s.turn - s.lastWriteTurn < every) return;

      s.lastWriteTurn = s.turn;
      log(`开闸（第 ${s.turn} 轮${firstWrite ? '，本会话首次' : ''}），排队固化`);
      // 这里**不检查 ready**：载入是异步的，插件刚起来那一两毫秒里
      // 用户已经开始说话是可能的。任务自己会在跑之前 `await loadPromise`，
      // 比在这里丢掉一轮更不容易漏记。
      enqueue(id, agent);
    } catch (err) {
      warn(`闸门判断失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /* ── 模型调用 ── */

  /** 拿 llm / provider / model。拿不到就返回 null（跳过这次固化）。 */
  function modelRoute() {
    const llm = ctx.get('llm');
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return null;
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? undefined;
    const provider = config.provider || selection?.provider;
    const model = config.model || selection?.model || 'deepseek-flash';
    if (typeof provider !== 'string' || provider === '') return null;
    if (typeof model !== 'string' || model === '') return null;
    return { llm, provider, model };
  }

  /**
   * 构造 `stream` 函数给 core 层用（`compressWithModel` 收的就是这个）。
   *
   * `reasoningEffort` **显式给值、绝不继承聊天里的档位**：用户在桌面端选了
   * high，后台固化也会跟着疯狂思考，maxTokens 全烧在推理上，正文一个字都没有。
   * 症状极有迷惑性：请求正常、chunk 正常、无报错、就是什么都不记。
   */
  function makeStream({ llm, provider, model, signal }) {
    const effort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
    return (override = {}) => {
      const opts = {
        provider,
        model,
        maxTokens: config.maxTokens,
        temperature: 0.2,
        signal,
        ...override,
      };
      if (effort !== '') opts.reasoningEffort = effort;
      return llm.stream(opts);
    };
  }

  /** 收一个 stream 的全文。只认 `text-delta` 与 `finish`。 */
  async function collectStream(iterable) {
    let text = '';
    /** @type {any} */
    let finish;
    let chunks = 0;
    for await (const chunk of iterable) {
      chunks += 1;
      if (chunk?.type === 'text-delta') text += typeof chunk.text === 'string' ? chunk.text : '';
      else if (chunk?.type === 'finish') finish = chunk;
    }
    return { text, finish, chunks };
  }

  /** 组装固化的 user 消息。**只给形状与事件时间，正文当然要给模型。** */
  function buildConsolidateUser({ transcript, now, sessionId }) {
    const lines = transcript.map((m) => `${m.role === 'user' ? '他' : '我'}：${m.text}`).join('\n');
    return [
      `事件时间：${fullStamp(now)}（ts=${now}）`,
      `会话：${sessionId}`,
      '',
      '对话：',
      lines,
      '',
      '只输出 JSON 数组。',
    ].join('\n');
  }

  /* ── 固化：真正的模型调用（带外） ── */

  /**
   * @param {string} sessionId
   * @param {any} agent
   * @param {AbortSignal} signal 这个任务自己的可中止信号
   */
  async function consolidate(sessionId, agent, signal) {
    // 载入是异步的：插件刚起来时 store 还是空的。等它，别拿空库去固化。
    await loadPromise;
    if (!ready || degraded) {
      log('记忆库没就绪，跳过这次固化');
      return;
    }
    const s = stateOf(sessionId);
    const route = modelRoute();
    if (route === null) {
      log('没有可用的 llm / provider，跳过固化');
      return noteAttempt('no-model');
    }

    const transcript = s.transcript.slice(-CONSOLIDATE_TAIL);
    if (transcript.length === 0) {
      log('没有可总结的对话，跳过固化');
      return;
    }

    const now = Date.now();
    const started = Date.now();
    const stream = makeStream({ llm: route.llm, provider: route.provider, model: route.model, signal });

    log(`固化开始：${transcript.length} 条消息 → ${route.provider}/${route.model}`);

    let run;
    try {
      run = await collectStream(
        stream({
          system: CONSOLIDATE_SYSTEM,
          messages: [
            { role: 'user', content: [{ type: 'text', text: buildConsolidateUser({ transcript, now, sessionId }) }] },
          ],
          maxTokens: config.maxTokens,
          temperature: 0.2,
          signal,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 有的 provider 不认这个档位会直接抛 UNSUPPORTED_REASONING_EFFORT。
      // 该退回「不指定」，而不是让整个记忆功能瘫痪。
      if (/REASONING_EFFORT/i.test(msg)) {
        warn('provider 不接受思考档位，退回不指定重试一次');
        const retryStream = makeStream({ llm: route.llm, provider: route.provider, model: route.model, signal });
        run = await collectStream(
          retryStream({
            system: CONSOLIDATE_SYSTEM,
            messages: [
              { role: 'user', content: [{ type: 'text', text: buildConsolidateUser({ transcript, now, sessionId }) }] },
            ],
            maxTokens: config.maxTokens,
            temperature: 0.2,
            signal,
          }),
        );
      } else if (signal?.aborted) {
        warn('固化被中止，这次不记');
        return;
      } else {
        throw err;
      }
    }

    log(`模型返回 ${run.chunks} 个 chunk / ${run.text.length} 字 / ${Date.now() - started}ms`);

    // ⚠️ 三种 finish 一律**不写盘**：宁可漏记，也不要坏档。
    if (run.finish?.kind === 'error' || run.finish?.kind === 'aborted') {
      warn(`模型调用失败：${run.finish?.failure?.code ?? 'unknown'} ${run.finish?.failure?.message ?? ''}`);
      return noteAttempt('model-error');
    }
    if (run.finish?.kind === 'max-tokens') {
      warn('输出被 maxTokens 截断，这次不记（宁可漏记，不要坏档）');
      return noteAttempt('truncated');
    }

    const parsed = parseConsolidationOutput(run.text);
    if (parsed === null) {
      // 解析失败**整批丢弃** —— 半成品写进档案比漏记危险得多
      warn('固化输出解析失败，整批丢弃');
      return noteAttempt('parse-failed');
    }
    if (parsed.length === 0) {
      log('模型判断这段不值得记，跳过');
      return noteAttempt('nothing-worth');
    }

    const added = await ingest(parsed, { sessionId, now, signal });
    if (added === 0) {
      log('没有通过校验的条目，跳过落盘');
      return noteAttempt('no-valid');
    }

    s.lastWriteTurn = s.turn;
    invalidateRender(sessionId);
    noteAttempt('ok', added);
    log(`固化完成：入库 ${added} 条 / 总 ${store.all().length} 条 / ${Date.now() - started}ms`);
  }

  /**
   * 一批原始条目 → 入库 → 到期收割 → 超容压缩 → 落盘。
   *
   * 顺序不能换：收割要在新条目入库之后（新条目可能撑破容量），
   * 压缩要在收割之后（收割会腾出空位），落盘放最后一次性完成。
   *
   * @param {object[]} rawList
   * @param {{sessionId: string, now: number, signal?: AbortSignal}} ctxInfo
   * @returns {Promise<number>} 真正入库的条数
   */
  async function ingest(rawList, ctxInfo) {
    const taken = new Set(store.all().map((e) => e.id));
    let added = 0;

    for (const raw of rawList) {
      try {
        const weight = Number(raw?.weight);
        let zone = 'short';
        try {
          // 第三个参数是模型自己给的分区建议（用户要求「由 AI 判断该进哪一层」）。
          // 它没给建议时，initialZoneFor 只有极高权重才会空降永久区。
          zone = initialZoneFor(
            Number.isFinite(weight) ? weight : 0.4,
            config,
            raw?.zone,
          );
        } catch {
          zone = 'short';
        }
        const entry = normalizeEntry(
          { ...raw, source: raw?.source ?? 'chat' },
          { zone, now: ctxInfo.now, session: ctxInfo.sessionId, source: 'chat', taken },
        );
        if (entry === null) continue;
        taken.add(entry.id);
        store.add(entry);
        added += 1;
      } catch (err) {
        // 单条坏了只丢这一条
        warn(`条目入库失败，跳过一条：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (added === 0) return 0;

    // 到期收割（升级 / 淘汰 / 留级模糊化）
    try {
      const result = harvest({ zones: store.zones, cfg: config, now: Date.now() });
      if (result !== null && typeof result === 'object' && result.zones !== null && typeof result.zones === 'object') {
        await applyHarvest(result, ctxInfo.now);
        const plan = Array.isArray(result.plan) ? result.plan : [];
        if (plan.length > 0) {
          const counts = { long: 0, permanent: 0, drop: 0, stay: 0 };
          for (const p of plan) {
            if (p?.to === 'long' || p?.to === 'permanent' || p?.to === 'drop' || p?.to === 'stay') {
              counts[p.to] += 1;
            }
          }
          log(`到期收割：升长 ${counts.long} / 升永 ${counts.permanent} / 淘汰 ${counts.drop} / 留级 ${counts.stay}`);
        }
      }
    } catch (err) {
      warn(`到期收割失败（本次跳过，记忆不受影响）：${err instanceof Error ? err.message : String(err)}`);
    }

    // 超容 → 回滚压缩
    await compressAll(ctxInfo?.signal);

    // 条数没超、但全库 token 超了 → 第二道闸：按总量回收
    try {
      await reclaimForTotalBudget(ctxInfo?.signal);
    } catch (err) {
      warn(`按总量回收失败（不影响这次固化）：${err instanceof Error ? err.message : String(err)}`);
    }

    // 第三道闸：攒够 N 条就做一次记忆库自检（去重）。
    // 走的是同一个串行队列 —— 自检和固化都在改 store，并发写会互相覆盖。
    // 自检是纯本地的，毫秒级，不调模型、不碰上下文。
    try {
      await noteNewEntries(added, ctxInfo?.signal);
    } catch (err) {
      warn(`记忆库自检失败（不影响这次固化）：${err instanceof Error ? err.message : String(err)}`);
    }

    await store.save();

    // 镜像：攒够 N 条就同步一次。失败只 warn —— 备份坏了不能连累记忆本身。
    try {
      await noteMirror(added);
    } catch (err) {
      warn(`镜像同步失败（不影响记忆）：${err instanceof Error ? err.message : String(err)}`);
    }

    return added;
  }

  /**
   * 把 harvest 的结果落到 store 上，并执行**「压缩后剔除」**。
   *
   * 用户的原话是「进行剔除（压缩）后再删去记忆区」。所以被淘汰的那批不能凭空
   * 消失：N 条要忘掉的记忆先被揉成 1 条模糊印象，留在原区，depth+1，
   * 权重夹在「遗忘线」和「升级线」之间 —— 它不会立刻再被判死，也爬不回长期，
   * 只能靠一次次到期慢慢变模糊。
   *
   * 少于 2 条时不生成印象：一条不值得单独留印象，直接忘掉才是人的做法。
   *
   * @param {{zones: object, plan?: object[], dropped?: object}} result harvest 的返回值
   * @param {number} now
   */
  async function applyHarvest(result, now) {
    for (const zone of ZONES) {
      if (Array.isArray(result.zones[zone])) store.setZone(zone, result.zones[zone]);
    }

    const dropped = result?.dropped;
    if (dropped === null || typeof dropped !== 'object') return;

    for (const zone of ['short', 'long']) {
      const list = Array.isArray(dropped[zone]) ? dropped[zone] : [];
      if (list.length < 2) continue;
      try {
        // 冷存档：被淘汰的原文不能真的消失，只是不再进注入
        await store.archive(list, 'dropped');
        const digest = digestDropped(list, config, now);
        if (digest === null) continue;
        const entry = normalizeEntry(digest, {
          zone,
          now,
          source: 'merge',
          taken: store.ids(),
        });
        if (entry === null) continue;
        store.add(entry);
        log(`遗忘 ${list.length} 条 → 留下一条模糊印象（depth ${entry.depth}）`);
      } catch (err) {
        // 印象生成失败也不能挡住其它记忆
        warn(`遗忘压缩失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 逐区（short → long → permanent）压缩到不超容为止。 */
  async function compressAll(signal) {
    for (const zone of ZONES) {
      await compressZone(zone, signal);
    }
  }

  /**
   * 把一组记忆揉成一条更模糊的，压进下一区。**压缩的最小单元。**
   *
   * 抽出来是因为它有两个调用方：按条数超容（`compressZone`）和按 token 超量
   * （`reclaimForTotalBudget`）。两条链路必须走同一套「模型压 → 本地兜底 →
   * 先存档再删」，否则一份记忆会因为触发原因不同而被压成两种东西。
   *
   * @param {'short'|'long'|'permanent'} zone 这组记忆**原来**所在的区
   * @param {object[]} group 至少 2 条
   * @param {AbortSignal} sig
   * @returns {Promise<boolean>} 是否真的落位了
   */
  async function compressOnce(zone, group, sig) {
    // ① 先让模型压；② 失败/被截断就本地兜底 —— 兜底**永远能出一条**
    let entry = null;
    const route = modelRoute();
    if (route !== null) {
      try {
        entry = await compressWithModel(group, {
          stream: makeStream({ llm: route.llm, provider: route.provider, model: route.model, signal: sig }),
          provider: route.provider,
          model: route.model,
          maxTokens: config.maxTokens,
          signal: sig,
          zone,
        });
      } catch (err) {
        warn(`模型压缩失败，退回本地合并：${err instanceof Error ? err.message : String(err)}`);
        entry = null;
      }
    }
    if (entry === null || typeof entry !== 'object') {
      try {
        entry = fallbackMerge(group, { now: Date.now() });
      } catch (err) {
        warn(`本地合并也失败，放弃这次压缩：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    if (entry === null || typeof entry !== 'object') return false;

    try {
      // **先冷存档再删** —— 压缩不可逆，原文丢了就真丢了
      await store.archive(group, 'compressed');
      const ids = new Set(group.map((e) => e?.id).filter((id) => typeof id === 'string'));
      for (const id of ids) store.remove(id);
      store.add({ ...entry, zone: nextZone(zone) });
      return true;
    } catch (err) {
      warn(`压缩落位失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 按**全库 token 总量**回收，直到不超上限为止。
   *
   * 为什么还要这一道：条数上限管不住体积。永久区 1000 条里混进几篇三千字的
   * 旧档案，条数才用掉 5%，检索和面板就已经在拖了。
   *
   * 每一轮都重新统计、重新挑组 —— 压一次库就变了，拿旧的判断往下压会把
   * 刚生成的那条模糊印象又压一遍。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{before:number, after:number, capacity:number, rounds:number,
   *                    withinCapacity:boolean, exhausted:boolean}>}
   */
  async function reclaimForTotalBudget(signal) {
    const sig = signal ?? abort.signal;
    const capacity = totalCapacityOf(config);
    const before = tokenUsage(store.zones, config, Date.now()).total;
    let rounds = 0;
    let after = before;
    /** 挑不出组 = 真的到极限了（剩下的全是底色，或者某区只剩一条） */
    let exhausted = false;

    if (before <= capacity) {
      return { before, after, capacity, rounds: 0, withinCapacity: true, exhausted: false };
    }

    for (let guard = 0; guard < TOTAL_RECLAIM_MAX_ROUNDS; guard += 1) {
      if (sig.aborted) break;
      const now = Date.now();
      const usage = tokenUsage(store.zones, config, now);
      after = usage.total;
      if (after <= capacity) break;

      let group = null;
      try {
        group = pickReclaimGroup(store.zones, config, now);
      } catch (err) {
        warn(`总量回收挑组失败：${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (group === null) {
        exhausted = true;
        break;
      }

      const done = await compressOnce(group.zone, group.entries, sig);
      if (!done) break;
      rounds += 1;
    }

    after = tokenUsage(store.zones, config, Date.now()).total;
    // ⚠️ 字段名不能叫 `ok`：HTTP 响应体里 `ok` 是「这次请求成没成」，
    // 回收没达标是**业务结果**，不是请求失败。同名会被 spread 覆盖，
    // 面板于是报「回收失败」。叫 withinCapacity。
    const withinCapacity = after <= capacity;
    if (rounds > 0) {
      log(`按总量回收 ${rounds} 轮：${before} → ${after} / ${capacity} token`);
    }
    if (!withinCapacity) {
      warn(
        `全库 ${after} token 仍超过上限 ${capacity}${
          exhausted ? '（剩下的都是人格底色或单条，压不动了）' : ''
        }`,
      );
    }
    return { before, after, capacity, rounds, withinCapacity, exhausted };
  }

  /* ── 自动备份镜像（记忆 + 人格提示词 + 插件配置） ── */

  /**
   * 每写入多少条同步一次（1~50，默认 5）。
   * @param {Record<string, any>} cfg
   * @returns {number}
   */
  function mirrorEveryOf(cfg) {
    const n = Math.round(Number(cfg?.mirrorEveryEntries));
    if (!Number.isFinite(n)) return 5;
    return Math.min(50, Math.max(1, n));
  }

  /**
   * 镜像进度（落在库目录 mirror-state.json）。
   * 和自检一样必须落盘：只放内存的话，每次重启 DSH 计数归零，
   * 「每 5 条同步一次」就退化成「每 5 条、或者每次重开后的第一次写记忆」。
   */
  function readMirrorState(dir, warner) {
    const base = {
      entriesSinceMirror: 0,
      lastAt: null,
      lastOk: null,
      lastError: null,
      lastFiles: 0,
      lastBytes: 0,
      lastTrigger: null,
    };
    try {
      const p = path.join(dir, MIRROR_STATE_FILE);
      if (!existsSync(p)) return base;
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (raw === null || typeof raw !== 'object') return base;
      return { ...base, ...raw };
    } catch (err) {
      if (typeof warner === 'function') {
        warner(`读 ${MIRROR_STATE_FILE} 失败，进度从零算：${err instanceof Error ? err.message : String(err)}`);
      }
      return base;
    }
  }

  function writeMirrorState(dir, state) {
    try {
      const p = path.join(dir, MIRROR_STATE_FILE);
      writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
      // 进度记不住不影响记忆本身
    }
  }

  let mirrorState = readMirrorState(dataDir, earlyWarn);

  /** 插件版本，写进 manifest —— 恢复时能看出这份备份是哪一版生成的。 */
  function pluginVersionOf() {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      return typeof pkg?.version === 'string' ? pkg.version : '';
    } catch {
      return '';
    }
  }

  /**
   * 现在就把镜像跑一遍（全量覆盖）。
   *
   * 「镜像」两个字是字面意思：`library\` `dsh\` `extra\` 三个子树**整体重建**，
   * 源里删掉的条目镜像里也会跟着消失。目录根下的用户自己的东西不碰。
   *
   * @param {'auto'|'manual'|'settings'|'init'} trigger
   * @returns {Promise<{ok:boolean, files?:number, bytes?:number, dir?:string, reason?:string}>}
   */
  async function runMirrorNow(trigger) {
    const dir = String(config.mirrorDir ?? '').trim();
    const safe = isSafeMirrorDir(path.join(path.resolve(dir), spaceInfo.activeId), dataDir);
    if (!safe.ok) {
      mirrorState = { ...mirrorState, lastOk: false, lastError: safe.reason };
      writeMirrorState(dataDir, mirrorState);
      return { ok: false, reason: safe.reason };
    }

    // 每个分区一个子目录：镜像里也是「多开」，互不覆盖
    const mir = path.join(path.resolve(dir), spaceInfo.activeId);
    try {
      mkdirSync(mir, { recursive: true });
      for (const sub of ['library', 'dsh', 'extra']) {
        try {
          rmSync(path.join(mir, sub), { recursive: true, force: true });
        } catch {
          // 删不掉就覆盖，别因此整个同步失败
        }
      }

      const plan = planMirror({ dataDir, dshHome: dshHome(), extraPaths: config.mirrorExtraPaths });
      const files = [];
      let bytes = 0;
      for (const item of plan.items) {
        if (!existsSync(item.src)) continue;
        const dest = path.join(mir, item.rel.split('/').join(path.sep));
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(item.src, dest, { recursive: true, force: true, filter: (s) => !shouldSkipName(path.basename(s)) });
        let size = 0;
        try {
          size = statSync(dest).size;
        } catch {
          size = 0;
        }
        bytes += size;
        files.push({ rel: item.rel, src: item.src, kind: item.kind, size, mtime: Date.now() });
      }

      const manifest = buildManifest({
        createdAt: Date.now(),
        dataDir,
        dshHome: dshHome(),
        counts: {
          short: store.zones.short.length,
          long: store.zones.long.length,
          permanent: store.zones.permanent.length,
        },
        pluginVersion: pluginVersionOf(),
        files,
      });
      writeFileSync(path.join(mir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      // 入口 .cmd 全英文，直接写；.ps1 里有大段中文，powershell 5.1 必须靠 BOM 才不会乱码
      writeFileSync(path.join(mir, RESTORE_CMD), renderRestoreCmd(), 'utf8');
      writeFileSync(path.join(mir, RESTORE_PS1), `\uFEFF${renderRestorePs1()}`, 'utf8');

      mirrorState = {
        ...mirrorState,
        entriesSinceMirror: 0,
        lastAt: new Date().toISOString(),
        lastOk: true,
        lastError: null,
        lastFiles: files.length,
        lastBytes: bytes,
        lastTrigger: trigger,
      };
      writeMirrorState(dataDir, mirrorState);
      for (const w of plan.warnings) warn(`镜像：${w}`);
      return { ok: true, files: files.length, bytes, dir: mir };
    } catch (err) {
      mirrorState = { ...mirrorState, lastOk: false, lastError: err instanceof Error ? err.message : String(err) };
      writeMirrorState(dataDir, mirrorState);
      warn(`镜像同步失败：${mirrorState.lastError}`);
      return { ok: false, reason: mirrorState.lastError };
    }
  }

  /**
   * 固化写完 N 条，够了就同步一次镜像。没够只记账。
   * @param {number} added
   */
  async function noteMirror(added) {
    const n = Math.round(Number(added) || 0);
    if (n > 0) mirrorState.entriesSinceMirror = (Number(mirrorState.entriesSinceMirror) || 0) + n;
    const ready =
      config.mirrorEnabled === true && String(config.mirrorDir ?? '').trim() !== '';
    if (!ready) {
      if (n > 0) writeMirrorState(dataDir, mirrorState);
      return null;
    }
    if (mirrorState.entriesSinceMirror < mirrorEveryOf(config)) {
      writeMirrorState(dataDir, mirrorState);
      return null;
    }
    return runMirrorNow('auto');
  }

  /** 面板要的镜像状态。**只在这里拼一份** —— 两处各拼一次早晚会不一致。 */
  function mirrorPanelState() {
    const dir = String(config.mirrorDir ?? '').trim();
    const safe = isSafeMirrorDir(dir, dataDir);
    return {
      enabled: Boolean(config.mirrorEnabled),
      every: mirrorEveryOf(config),
      dir,
      dirOk: safe.ok,
      dirReason: safe.reason,
      pending: Number(mirrorState.entriesSinceMirror) || 0,
      lastAt: mirrorState.lastAt,
      lastOk: mirrorState.lastOk,
      lastError: mirrorState.lastError,
      lastFiles: Number(mirrorState.lastFiles) || 0,
      lastBytes: Number(mirrorState.lastBytes) || 0,
      lastTrigger: mirrorState.lastTrigger,
    };
  }
  /* ── 记忆库自检：重复记忆合并 ── */

  /**
   * 攒够 N 条就做一次自检。**没够就只记账**（写 dedup-state.json）。
   *
   * @param {number} added 这次固化新写进去的条数
   * @param {AbortSignal} [signal]
   * @returns {Promise<object|null>} 跑了就返回结果，没跑返回 null
   */
  async function noteNewEntries(added, signal) {
    const n = Math.round(Number(added) || 0);
    if (n <= 0) return null;

    dedupState.entriesSinceCheck += n;
    const every = dedupEveryOf(config);

    if (!config.dedupEnabled) {
      // 关掉了也照样记账：重新打开时不用从头数
      writeDedupState(dataDir, dedupState);
      return null;
    }
    if (dedupState.entriesSinceCheck < every) {
      writeDedupState(dataDir, dedupState);
      return null;
    }
    return runDedupNow({ signal, trigger: 'auto' });
  }

  /**
   * 记忆库自检：把「说的是同一件事」的条目跨分区并成一条。
   *
   * 三条硬规矩：
   *  1. **不注入对话**（用户原话「不注入对话的自检」）—— 它跑在后台队列里，
   *     不产生任何 systemPrompt 片段，也不占 `budgetTokens`；
   *  2. **不调模型** —— 省 token 是这个功能的初衷，为省 token 去调模型是本末倒置；
   *  3. **先冷存档再删** —— 合并不可逆，原文进 `_archive/dedup.jsonl`，
   *     `tools/restore.mjs` 能捞回来。
   *
   * 合完一轮要重算：合并产物可能又和别的条目像。最多 DEDUP_MAX_ROUNDS 轮。
   *
   * @param {{signal?:AbortSignal, trigger?:'auto'|'manual'}} [opts]
   * @returns {Promise<{skipped:string, groups:number, merged:number, checked:number,
   *                    rounds:number, threshold:number, before:number, after:number}>}
   */
  async function runDedupNow(opts) {
    await loadPromise;
    const sig = opts?.signal ?? abort.signal;
    const trigger = opts?.trigger === 'manual' ? 'manual' : 'auto';
    const threshold = dedupThresholdOf(config);
    const before = store.all().length;

    // 关掉自检时，只有手动触发能越过（面板上的「立刻自检」按钮）
    if (!config.dedupEnabled && trigger !== 'manual') {
      return {
        skipped: 'disabled',
        groups: 0,
        merged: 0,
        checked: 0,
        rounds: 0,
        threshold,
        before,
        after: before,
      };
    }
    if (degraded) {
      return { skipped: 'degraded', groups: 0, merged: 0, checked: 0, rounds: 0, threshold, before, after: before };
    }

    let groups = 0;
    let checked = before;
    let rounds = 0;

    for (let round = 0; round < DEDUP_MAX_ROUNDS; round += 1) {
      if (sig.aborted) break;
      let found;
      try {
        found = findDuplicateGroups(store.zones, config, { threshold });
      } catch (err) {
        warn(`自检找重复失败：${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      checked = Number(found?.checked) || checked;
      const list = Array.isArray(found?.groups) ? found.groups : [];
      if (list.length === 0) break;

      let doneThisRound = 0;
      for (const g of list) {
        try {
          const entry = mergeDuplicateGroup(
            g.entries,
            { now: Date.now(), zone: g.zone, taken: store.ids() },
          );
          if (entry === null) continue;
          // 先冷存档再删 —— 合并不可逆
          await store.archive(g.entries, 'dedup');
          for (const e of g.entries) store.remove(e.id);
          store.add(entry);
          doneThisRound += 1;
        } catch (err) {
          warn(`合并重复组失败（跳过这一组）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (doneThisRound === 0) break;
      rounds += 1;
      groups += doneThisRound;
    }

    const after = store.all().length;
    const merged = Math.max(0, before - after);

    if (groups > 0) {
      invalidateAllRenders();
      log(`记忆库自检：合 ${groups} 组，${before} → ${after} 条（阈值 ${threshold}）`);
    }

    dedupState = {
      ...dedupState,
      entriesSinceCheck: 0,
      lastCheckAt: Date.now(),
      lastGroups: groups,
      lastMerged: merged,
      lastChecked: checked,
      totalGroups: dedupState.totalGroups + groups,
      totalMerged: dedupState.totalMerged + merged,
    };
    writeDedupState(dataDir, dedupState);

    return { skipped: '', groups, merged, checked, rounds, threshold, before, after };
  }

  /**
   * 压缩一个分区。合并出来的那条**压进下一区**（SPEC §0）；
   * 永久区没有再下一区，就留在永久区（越深越模糊，但仍然在）。
   *
   * @param {'short'|'long'|'permanent'} zone
   * @param {AbortSignal} [signal] 本次任务的信号（没有就用插件级的）
   * @returns {Promise<{zone:string, before:number, after:number, merged:number}>}
   */
  async function compressZone(zone, signal) {
    const sig = signal ?? abort.signal;
    const before = store.zones[zone].length;
    let merged = 0;
    // guard：容量配置异常时绝不死循环
    for (let guard = 0; guard < 32; guard += 1) {
      if (sig.aborted) break;
      let over = false;
      try {
        over = isOverCapacity(zone, store.zones[zone], config);
      } catch {
        over = false;
      }
      if (!over) break;

      let group = [];
      try {
        group = pickCompressGroup(zone, store.zones[zone], config) ?? [];
      } catch (err) {
        warn(`挑压缩组失败：${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (!Array.isArray(group) || group.length < 2) break;

      const done = await compressOnce(zone, group, sig);
      if (!done) break;
      merged += 1;
    }

    const after = store.zones[zone].length;
    if (merged > 0) log(`压缩 ${zone}：${before} → ${after}（合并 ${merged} 次）`);
    return { zone, before, after, merged };
  }

  /* ── 手动操作：忘掉 / 收割 / 压缩（HTTP 与工具共用） ── */

  /** @param {string} id @returns {Promise<boolean>} */
  async function forgetEntry(id) {
    await loadPromise;
    if (typeof id !== 'string' || id === '') return false;
    let removed = false;
    try {
      removed = store.remove(id);
    } catch {
      removed = false;
    }
    if (!removed) return false;
    await store.save();
    invalidateAllRenders();
    log(`忘掉一条，剩 ${store.all().length} 条`);
    return true;
  }

  /**
   * 重新从磁盘读一遍记忆库。
   *
   * 为什么需要它：`tools/import.mjs` 是**另一个进程**，它往库里写完，正在跑的
   * 插件内存里还是旧副本。不重读的话，插件下一次落盘会拿旧内存整份覆盖磁盘 ——
   * 刚导入的几十条一行不剩，而且没有任何报错。
   *
   * `store.mergeFromDisk()` 是更底层的兜底（落盘前合并外部新增），但它救不了
   * 「工具和面板读到的还是旧内存」这件事。两个都要有。
   */
  async function reloadNow() {
    await loadPromise;
    await store.flush();
    const r = await store.reload();
    invalidateAllRenders();
    log(
      `重读记忆库：短 ${store.zones.short.length} / 长 ${store.zones.long.length} / 永 ${store.zones.permanent.length}`,
    );
    return {
      ok: r?.ok !== false,
      bad: Number(r?.bad) || 0,
      zones: {
        short: store.zones.short.length,
        long: store.zones.long.length,
        permanent: store.zones.permanent.length,
      },
    };
  }

  /** 手动跑一次到期收割。 @returns {Promise<{plan:object[]}>} */
  async function harvestNow() {
    await loadPromise;
    let plan = [];
    try {
      const result = harvest({ zones: store.zones, cfg: config, now: Date.now() });
      if (result !== null && typeof result === 'object' && result.zones !== null && typeof result.zones === 'object') {
        await applyHarvest(result, Date.now());
        plan = Array.isArray(result.plan) ? result.plan : [];
      }
    } catch (err) {
      warn(`手动收割失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // 收割完总量可能又超了（升级会把条目挪进 detail 上限更大的区）
    try {
      await reclaimForTotalBudget(abort.signal);
    } catch (err) {
      warn(`按总量回收失败：${err instanceof Error ? err.message : String(err)}`);
    }
    await store.save();
    invalidateAllRenders();
    return { plan };
  }

  /** 手动压缩。不传 zone 就三区都过一遍。 */
  async function compressNow(zone) {
    await loadPromise;
    const targets = ZONES.includes(zone) ? [zone] : [...ZONES];
    /** @type {any[]} */
    const results = [];
    for (const z of targets) {
      results.push(await compressZone(z, abort.signal));
    }
    // 条数压下去了，总量未必 —— 两道闸各管一头
    try {
      await reclaimForTotalBudget(abort.signal);
    } catch (err) {
      warn(`按总量回收失败：${err instanceof Error ? err.message : String(err)}`);
    }
    await store.save();
    invalidateAllRenders();
    return results;
  }

  /* ── 面板数据（HTTP 与工具共用同一份） ── */

  /**
   * 把「上次固化结果」说成人话。
   *
   * 这一行回答的是用户最常见的那个疑问：**聊了半天，到底记没记？**
   * 固化有六条静默跳过的路径，每一条都只写日志、不打扰用户 —— 于是「没记上」
   * 和「还没到该记的时候」在用户眼里长得一模一样。这行字把它们分开。
   */
  function formatLastAttempt() {
    if (lastAttempt.at === 0) return '还没固化过（新库，或者还没到 writeEveryTurns）';
    const minutes = Math.max(0, Math.round((Date.now() - lastAttempt.at) / 60000));
    const when =
      minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
    const label =
      {
        ok: `入库 ${lastAttempt.added} 条`,
        'no-model': '没有可用模型，跳过',
        'model-error': '模型调用出错，整批丢弃',
        truncated: '输出被截断，整批丢弃（调大 maxTokens）',
        'parse-failed': '模型输出不是合法 JSON，整批丢弃',
        'nothing-worth': '模型判断这段不值得记',
        'no-valid': '条目没通过校验，一条都没写',
      }[lastAttempt.outcome] ?? lastAttempt.outcome;
    return `上次固化：${when} · ${label}`;
  }

  /**
   * 检索命中门槛。工具、面板、本地自动检索用**同一个数** ——
   * 三处用三个数，就会出现「面板查得到、模型查不到」这种谁也说不清的毛病。
   */
  function recallThreshold() {
    const n = Number(config.recallThreshold);
    return Number.isFinite(n) && n >= 0 ? n : 2;
  }

  function panelZones(now) {
    const cap = store.capacity(config);
    const windowDays = { short: config.shortDays, long: config.longDays, permanent: 0 };
    /** @type {Record<string, any>} */
    const out = {};
    for (const zone of ZONES) {
      const entries = store.zones[zone];
      let overview = { nextInDays: null, expired: 0 };
      try {
        if (windowDays[zone] > 0) overview = expiryOverview(entries, windowDays[zone], now);
      } catch {
        overview = { nextInDays: null, expired: 0 };
      }
      const c = cap?.[zone] ?? { count: entries.length, max: 0, ratio: 0 };
      out[zone] = {
        label: ZONE_LABEL[zone] ?? zone,
        count: Number(c.count) || 0,
        max: Number(c.max) || 0,
        ratio: Number(c.ratio) || 0,
        nextInDays: overview.nextInDays,
        expired: overview.expired,
        // 新的在前，每区最多 50 条
        entries: entries
          .slice(-PANEL_MAX_ENTRIES)
          .reverse()
          .map((e) => panelEntry(e, now)),
      };
    }
    return out;
  }

  /** 单条 → 面板/工具共用的形状。 */
  function panelEntry(entry, now) {
    return {
      id: typeof entry?.id === 'string' ? entry.id : '',
      ts: Number(entry?.ts) || 0,
      iso: typeof entry?.iso === 'string' ? entry.iso : '',
      zone: entry?.zone ?? 'short',
      weight: Number(entry?.weight) || 0,
      title: typeof entry?.title === 'string' ? entry.title : '',
      detail: typeof entry?.detail === 'string' ? entry.detail : '',
      keywords: Array.isArray(entry?.keywords) ? entry.keywords : [],
      depth: Number(entry?.depth) || 0,
      source: entry?.source ?? 'chat',
      // 面板要显示的两栏时间，都在这里算
      stamp: safeStamp(entry?.ts),
      relative: safeRelative(entry?.ts, now),
    };
  }

  function safeStamp(ts) {
    try {
      return stampFor(ts);
    } catch {
      return '';
    }
  }
  function safeRelative(ts, now) {
    try {
      return relativeStamp(ts, now);
    } catch {
      return '';
    }
  }

  /* ── 面板设置：读 / 写 / 恢复 ── */

  /**
   * 面板设置的一份快照。客户端不重复写字段定义，直接吃这张表。
   *
   * `baseValues` 是 DSH 配置里的原值 —— 用户把某个数拧坏了，面板上要能看见
   * 「本来是多少」，否则「恢复」按钮等于在猜。
   *
   * @returns {object}
   */
  function settingsSnapshot() {
    const fields = tunableFields(config, settingsOverrides);
    /** @type {Record<string, any>} */
    const baseValues = {};
    for (const f of fields) baseValues[f.key] = baseConfig?.[f.key] ?? f.default;
    return {
      file: settingsPathOf(dataDir),
      overridden: Object.keys(settingsOverrides).length > 0,
      fields,
      baseValues,
    };
  }

  /**
   * 应用面板传来的设置。
   *
   * 三种入参：
   *  - `{ reset: true }` —— 清空覆盖层，回到 DSH 配置的值（文件也删掉）；
   *  - `{ shortCapacity: 200 }` —— 部分更新，没提到的键保留原覆盖值；
   *  - `{}` —— 什么都不改（只回一份当前状态）。
   *
   * 落盘顺序：**先改文件，再改内存**。反过来的话写盘失败时用户看到的是新值、
   * 重启后又变回旧值，这种「自己弹回去」最难查。
   *
   * @param {any} body
   * @returns {{ok:boolean, accepted:string[], rejected:string[], changed:string[],
   *            settings:object, tokens:object, reclaim:boolean}}
   */
  function updateSettings(body) {
    const wantsReset = body?.reset === true;
    /** @type {Record<string, any>} */
    let next = wantsReset ? {} : { ...settingsOverrides };
    /** 传了但不在白名单里的键 —— 要如实回一句「这个我不管」 */
    /** @type {string[]} */
    const extraRejected = [];

    if (!wantsReset && body !== null && typeof body === 'object') {
      for (const key of TUNABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = body[key];
      }
      // 白名单外的键连 next 都进不去 —— 但**必须报出来**：静默忽略会让用户
      // 以为「我改了 dataDir 怎么没反应」。rest/dataDir/enabled 这类键动一下
      // 就能把库写歪或把插件关掉，所以是明确拒收，不是没看见。
      for (const key of Object.keys(body)) {
        if (key !== 'reset' && !TUNABLE_KEYS.includes(key)) extraRejected.push(key);
      }
    }

    const applied = applyOverrides(baseConfig, next);
    // 坏值（NaN / 非数字）不进覆盖层，而且**必须保留这一键原来的值** ——
    // 直接删掉的话它会掉回底座默认值：用户手滑传了个 "abc"，容量从 300
    // 变成默认的 120，看起来像「设置自己重置了」。
    for (const key of applied.rejected) {
      if (Object.prototype.hasOwnProperty.call(settingsOverrides, key)) {
        next[key] = settingsOverrides[key];
      } else {
        delete next[key];
      }
    }
    const finalConfig = applyOverrides(baseConfig, next).config;

    const changed = TUNABLE_KEYS.filter((k) => finalConfig[k] !== config[k]);
    const rejected = [...new Set([...extraRejected, ...applied.rejected])];

    // ① 文件
    let saved = true;
    try {
      if (Object.keys(next).length === 0) {
        const p = settingsPathOf(dataDir);
        if (existsSync(p)) unlinkSync(p);
      } else {
        writeSettingsOverrides(dataDir, next);
      }
    } catch (err) {
      saved = false;
      warn(`面板设置写盘失败（本次仍生效，重启后会丢）：${err instanceof Error ? err.message : String(err)}`);
    }

    // ② 内存
    settingsOverrides = next;
    config = finalConfig;
    invalidateAllRenders();

    const now = Date.now();
    const tokens = tokenUsage(store.zones, config, now);
    if (changed.length > 0) log(`面板设置变更：${changed.join(' / ')}`);

    return {
      ok: saved,
      accepted: applied.accepted,
      rejected,
      changed,
      settings: settingsSnapshot(),
      mirror: mirrorPanelState(),
      tokens,
      // 改了上限之后已经超了 → 告诉调用方「我这就去后台收」
      reclaim: tokens.over,
    };
  }

  /** token 数缩写：10400 → 10.4K，100000 → 100K。面板和工具共用一套写法。 */
  function tokenText(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v >= 100000) return `${Math.round(v / 1000)}K`;
    if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(v);
  }

  /**
   * 自检进度的一份快照。面板和 HTTP 响应共用，别在两处各拼一遍 ——
   * 拼两遍的下场是「面板说还差 3 条、接口说还差 5 条」。
   * @returns {object}
   */
  function dedupPanelState() {
    return {
      enabled: Boolean(config.dedupEnabled),
      every: dedupEveryOf(config),
      threshold: dedupThresholdOf(config),
      /** 自上次自检以来又攒了几条，满 every 就自动跑 */
      pending: dedupState.entriesSinceCheck,
      lastCheckAt: dedupState.lastCheckAt,
      lastGroups: dedupState.lastGroups,
      lastMerged: dedupState.lastMerged,
      lastChecked: dedupState.lastChecked,
      totalGroups: dedupState.totalGroups,
      totalMerged: dedupState.totalMerged,
    };
  }

  /**
   * `GET /ebbinghaus/state` 的 body。 */
  function panelState(query) {
    const now = Date.now();
    const q = typeof query === 'string' ? query.trim() : '';
    /** @type {object[]} */
    let hits = [];
    if (q !== '') {
      try {
        // 阈值用配置里的 recallThreshold（默认 2），不是 1。
        // 1 太宽：查「绝对不可能命中的词」也能靠字重叠命中一条 —— 模型调
        // memory_search 时被这种无关命中糊一脸，还不如少给它一条。
        hits = (search(store.zones, q, { top: Math.max(1, Number(config.recallTop) || 3), threshold: recallThreshold() }) ?? []).map(
          (e) => panelEntry(e, now),
        );
      } catch (err) {
        warn(`面板检索失败：${err instanceof Error ? err.message : String(err)}`);
        hits = [];
      }
    }
    return {
      ok: true,
      ready,
      degraded,
      dir: dataDir,
      spaces: {
        active: spaceInfo.activeId,
        name: spaceInfo.activeName,
        list: spaceInfo.spaces,
        migrated: spaceInfo.migrated,
        degraded: spaceInfo.degraded,
        problems: spaceInfo.problems,
        max: 10,
      },
      now,
      query: q,
      hits,
      total: store.all().length,
      zones: panelZones(now),
      // 全库总量：与注入同一个口径（渲染后估算），面板拿它画第二根容量条
      tokens: tokenUsage(store.zones, config, now),
      // 面板设置：字段定义 + 当前值 + 底座值，一次给全，客户端不重复写字段表
      settings: settingsSnapshot(),
      mirror: mirrorPanelState(),
      // 记忆库自检的进度（面板上「上次自检」那一行）
      dedup: dedupPanelState(),
      config: {
        shortDays: config.shortDays,
        longDays: config.longDays,
        writeEveryTurns: config.writeEveryTurns,
      },
    };
  }

  /* ── 对外服务（测试与将来可能的别处都用这个口） ── */

  try {
    ctx.provide('ebbinghausMemory', {
      get ready() {
        return ready;
      },
      get degraded() {
        return degraded;
      },
      dir: dataDir,
      spaces: {
        active: spaceInfo.activeId,
        name: spaceInfo.activeName,
        list: spaceInfo.spaces,
        migrated: spaceInfo.migrated,
        degraded: spaceInfo.degraded,
        problems: spaceInfo.problems,
        max: 10,
      },
      /** 等到「载入 + 带外队列 + 挂起写盘」全部落定。 */
      async flush() {
        await loadPromise;
        await drainPromise;
        await store.flush();
      },
      snapshot() {
        return store.snapshot();
      },
      state: (query) => panelState(query),
      forget: forgetEntry,
      harvest: harvestNow,
      compress: compressNow,
      reload: reloadNow,
      /** 面板设置的读 / 写（测试也走这里，不重复实现） */
      settings: () => settingsSnapshot(),
      updateSettings,
      /** 全库 token 总量（渲染口径） */
      tokenUsage: () => tokenUsage(store.zones, config, Date.now()),
      /** 按总量回收一次 */
      reclaimTotal: reclaimForTotalBudget,
      /** 记忆库自检（去重）一次。默认按「手动」走（不受 dedupEnabled 拦），传 trigger:'auto' 才走自动那条路 */
      dedup: (opts) => runDedupNow({ ...opts, trigger: opts?.trigger === 'auto' ? 'auto' : 'manual' }),
      /** 自检进度（面板/测试用） */
      dedupState: () => ({ ...dedupState }),
      renderFor,
    });
  } catch (err) {
    // 有的组合里 provide 不存在（比如被当成纯工具插件加载）—— 不影响别的
    warn(`注册 ebbinghausMemory 服务失败：${err instanceof Error ? err.message : String(err)}`);
  }

  /* ── 卸载：先尽力写完，再中止 ── */

  /**
   * 这个上限**必须大于单任务超时**（`jobTimeoutMs`）：
   * flush 只是「进程已经要死了」的最后一道保险，不是任务的时间预算。
   * 反过来写（flush < job）会让每个慢任务都在跑完前被砍掉，而且没报错。
   */
  const flushTimeoutMs = Math.max(180000, (Number(config.jobTimeoutMs) || 60000) + 60000);

  ctx.effect(
    () => () => {
      const flush = Promise.resolve()
        .then(() => drainPromise)
        .then(() => store.flush())
        .catch(() => undefined);
      const deadline = new Promise((resolve) => {
        const t = setTimeout(resolve, flushTimeoutMs);
        if (typeof t.unref === 'function') t.unref();
      });
      return Promise.race([flush, deadline]).then(() => {
        abort.abort();
        releaseProcessOpen();
        sessionStates.clear();
        promptFibers.clear();
      });
    },
    'ebbinghaus: flush pending work, then abort',
  );

  /* ── HTTP：面板的数据通道 ── */

  /**
   * 【为什么走 HTTP 而不是 Cordis RPC】
   * 已安装的客户端插件**没有自己的 host RPC**（`host.call` 只对动态包开放），
   * Typert Remote 是构建期固定的第一方能力，第三方插件加不进去。
   * 但 host 半边能注册 HTTP 路由，而客户端本来就是普通浏览器模块 ——
   * 同源 `fetch` 就够，零依赖。
   *
   * 【权限，想清楚再改】
   * **故意不设 CORS 头**：浏览器里别的站点 `fetch` 它读不到响应体，
   * 这是真正有意义的防护。本机其它进程当然能 curl，但它们本来就能直接读
   * `<dataDir>/*.jsonl` —— 威胁面没有变大。别往这里加自创的鉴权，
   * 那是假的安全感。
   */
  const PANEL_BASE = '/ebbinghaus';

  /** 统一响应头：不缓存、不嗅探。 */
  function reply(res, status, body) {
    try {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify(body));
    } catch {
      // 连接已经断了，回不了就算了
    }
  }

  function fail(res, status, error) {
    reply(res, status, { ok: false, error: error instanceof Error ? error.message : String(error ?? '未知错误') });
  }

  /** 读一个很小的 JSON 请求体。超过 8KB 直接拒 —— 我们只收 id / zone。 */
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }

  /** 从 URL 上取 `?q=`（只认第一个值）。 */
  function queryOf(req) {
    try {
      const url = new URL(String(req?.url ?? '/'), 'http://localhost');
      return url.searchParams.get('q') ?? '';
    } catch {
      return '';
    }
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: `${PANEL_BASE}/state`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'GET') return reply(res, 405, { ok: false, error: '只支持 GET' });
              await loadPromise;
              return reply(res, 200, panelState(queryOf(req)));
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/forget`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              let body;
              try {
                body = await readBody(req);
              } catch (err) {
                return fail(res, 413, err);
              }
              const id = typeof body?.id === 'string' ? body.id : '';
              if (id === '') return reply(res, 400, { ok: false, error: '缺 id' });
              const removed = await forgetEntry(id);
              return reply(res, 200, { ok: true, removed, count: store.all().length });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/harvest`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              const { plan } = await harvestNow();
              const cap = store.capacity(config);
              const zones = {};
              for (const zone of ZONES) {
                zones[zone] = { count: Number(cap?.[zone]?.count) || 0, max: Number(cap?.[zone]?.max) || 0 };
              }
              return reply(res, 200, {
                ok: true,
                plan: plan.map((p) => ({ id: p?.id ?? '', from: p?.from ?? '', to: p?.to ?? '', reason: p?.reason ?? '' })),
                zones,
              });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/compress`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              let body;
              try {
                body = await readBody(req);
              } catch (err) {
                return fail(res, 413, err);
              }
              const zone = typeof body?.zone === 'string' ? body.zone : '';
              if (zone !== '' && !ZONES.includes(zone)) {
                return reply(res, 400, { ok: false, error: `未知分区：${zone}` });
              }
              // before / after 数的是**被压缩的那几区**的条数（不传 zone 就是三区合计），
              // 所以单区压缩时会看到条数真的变少；merged 是「合并了几次」。
              const targets = ZONES.includes(zone) ? [zone] : [...ZONES];
              const countOf = () => targets.reduce((n, z) => n + store.zones[z].length, 0);
              const before = countOf();
              const results = await compressNow(zone);
              const merged = results.reduce((n, r) => n + (Number(r?.merged) || 0), 0);
              return reply(res, 200, {
                ok: true,
                zone: zone === '' ? 'all' : zone,
                before,
                after: countOf(),
                merged,
              });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/settings`,
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') {
                await loadPromise;
                return reply(res, 200, {
                  ok: true,
                  settings: settingsSnapshot(),
                  mirror: mirrorPanelState(),
                  tokens: tokenUsage(store.zones, config, Date.now()),
                });
              }
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 GET / POST' });
              let body;
              try {
                body = await readBody(req);
              } catch (err) {
                return fail(res, 413, err);
              }
              const result = updateSettings(body);
              // 新上限当场就超了 → 后台按总量回收一次，不让保存按钮等模型
              if (result.reclaim) {
                runInBackground('按总量回收', () => reclaimForTotalBudget(abort.signal));
              }
              return reply(res, 200, { ok: result.ok, ...result });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/reclaim`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              await loadPromise;
              // 手动触发就等它跑完 —— 用户点了按钮，要看到结果
              const r = await reclaimForTotalBudget(abort.signal);
              await store.save();
              invalidateAllRenders();
              return reply(res, 200, {
                ok: true,
                ...r,
                tokens: tokenUsage(store.zones, config, Date.now()),
                total: store.all().length,
              });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/mirror`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              await loadPromise;
              const r = await runMirrorNow('manual');
              return reply(res, 200, { ...r, mirror: mirrorPanelState() });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/dedup`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              await loadPromise;
              // 手动点「立刻自检」就等它跑完 —— 本地算法，毫秒级
              const r = await runDedupNow({ signal: abort.signal, trigger: 'manual' });
              await store.save();
              invalidateAllRenders();
              return reply(res, 200, {
                ok: true,
                ...r,
                // 面板上要看「现在还剩多少」，所以连总量一起回
                tokens: tokenUsage(store.zones, config, Date.now()),
                total: store.all().length,
                dedup: dedupPanelState(),
              });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/reload`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '只支持 POST' });
              // 外部工具（比如 tools/import.mjs）改过库文件之后，调一下这个
              const r = await reloadNow();
              return reply(res, 200, { ok: true, ...r });
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/export`,
          handler: async (req, res) => {
            try {
              if (req.method !== 'GET') return reply(res, 405, { ok: false, error: '只支持 GET' });
              await loadPromise;
              await drainPromise;
              await store.flush();
              const name = `ebbinghaus-memory-${new Date().toISOString().slice(0, 10)}.json`;
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Content-Type-Options', 'nosniff');
              res.end(JSON.stringify(store.snapshot(), null, 2));
            } catch (err) {
              return fail(res, 500, err);
            }
          },
        },
      ];

      const disposers = [];
      for (const r of routes) {
        try {
          disposers.push(scope.webServer.register(r));
        } catch (err) {
          warn(`注册路由 ${r.path} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log(`面板接口已注册：${PANEL_BASE}/{state,settings,forget,harvest,compress,reclaim,dedup,reload,export}`);

      return () => {
        for (const d of disposers.reverse()) {
          try {
            d?.();
          } catch {
            // 注销失败不该影响卸载
          }
        }
      };
    }, 'ebbinghaus: 面板数据接口');
  });

  /* ── 工具：给模型用的两只手 ── */

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => {
      const disposers = [];

      /**
       * `memory_search` —— 跨区关键词查找。
       *
       * 参数是**手写 JSON Schema**：我们不能 import `@deepseek-ai/dsh-tools`
       * （零依赖铁律），`defineTool` 那层转换得自己产出同样的形状。
       */
      try {
        disposers.push(
          scope.tools.register({
            name: SEARCH_TOOL_NAME,
            description:
              '在长期记忆库里按关键词查找旧事（短期 / 长期 / 永久三区）。' +
              '只在确实需要回忆以前发生过什么的时候用；它只返回命中的少数几条，不会把整个记忆倒出来。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: { type: 'string', description: '要查的关键词或一句话，中英文都行。' },
                top: { type: 'integer', minimum: 1, maximum: 20, description: '可选，最多取回几条（默认 3）。' },
              },
              required: ['query'],
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  count: { type: 'integer' },
                  lines: { type: 'array', items: { type: 'string' } },
                },
              },
              render: (_args, value) =>
                value?.ok === true
                  ? [
                      {
                        type: 'text',
                        text:
                          value.count === 0
                            ? '记忆里没有相关的条目。'
                            : `找到 ${value.count} 条：\n${(value.lines ?? []).join('\n')}`,
                      },
                    ]
                  : [{ type: 'text', text: '查记忆失败，这次当没想起来。' }],
            },
            async execute(args) {
              await loadPromise;
              const query = typeof args?.query === 'string' ? args.query.trim() : '';
              if (query === '') throw new Error('query 不能是空的。');
              const rawTop = Number(args?.top);
              const top = Number.isFinite(rawTop) ? Math.min(20, Math.max(1, Math.round(rawTop))) : config.recallTop;
              let hits = [];
              try {
                hits = search(store.zones, query, { top, threshold: recallThreshold() }) ?? [];
              } catch (err) {
                warn(`memory_search 失败：${err instanceof Error ? err.message : String(err)}`);
                return { ok: false, count: 0, lines: [] };
              }
              touch(hits);
              const now = Date.now();
              const lines = hits.map((e) => {
                try {
                  return renderEntryLine(e, { now, detailLimit: detailLimitFor(e) });
                } catch {
                  return `[${safeStamp(e?.ts)}] ${e?.title ?? ''}`;
                }
              });
              log(`memory_search：命中 ${hits.length} 条`);
              return { ok: true, count: hits.length, lines };
            },
            presentCall: (args) => ({
              card: 'generic',
              title: '查记忆',
              kind: 'other',
              rawInput: args,
            }),
          }),
        );
      } catch (err) {
        warn(`注册 ${SEARCH_TOOL_NAME} 失败：${err instanceof Error ? err.message : String(err)}`);
      }

      /** `memory_stats` —— 三区容量。数据与面板同一份（`panelZones`）。 */
      try {
        disposers.push(
          scope.tools.register({
            name: STATS_TOOL_NAME,
            description: '看一眼记忆库的容量：三个分区各有多少条、上限多少、有没有快到期的。',
            parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  lines: { type: 'array', items: { type: 'string' } },
                },
              },
              render: (_args, value) =>
                value?.ok === true
                  ? [{ type: 'text', text: (value.lines ?? []).join('\n') }]
                  : [{ type: 'text', text: '读不到记忆容量。' }],
            },
            async execute() {
              await loadPromise;
              const now = Date.now();
              const zones = panelZones(now);
              const lines = [];
              for (const zone of ZONES) {
                const z = zones[zone];
                const pct = z.max > 0 ? Math.round((z.count / z.max) * 100) : 0;
                let line = `${z.label}：${z.count} / ${z.max}（${pct}%）`;
                if (typeof z.nextInDays === 'number') line += ` · 最近 ${z.nextInDays} 天后到期`;
                if (z.expired > 0) line += ` · 已到期 ${z.expired} 条`;
                lines.push(line);
              }
              const usage = tokenUsage(store.zones, config, now);
              // 总量塞进「合计」这一行，不新增行 —— 行数变了会让调用方（和测试）
              // 对不上号，而这三区 + 合计 + 上次固化 的五行结构是冻结的。
              lines.push(`合计 ${store.all().length} 条 · 总量 ${tokenText(usage.total)} / ${tokenText(usage.capacity)} token`);
              lines.push(formatLastAttempt());
              return { ok: true, lines };
            },
            presentCall: () => ({ card: 'generic', title: '记忆容量', kind: 'other' }),
          }),
        );
      } catch (err) {
        warn(`注册 ${STATS_TOOL_NAME} 失败：${err instanceof Error ? err.message : String(err)}`);
      }

      log(`已注册工具 ${SEARCH_TOOL_NAME} / ${STATS_TOOL_NAME}`);

      return () => {
        for (const d of disposers.reverse()) {
          try {
            d?.();
          } catch {
            // 注销失败不该影响卸载
          }
        }
      };
    }, 'ebbinghaus: memory tools');
  });

  /* ── 就绪 ── */

  /**
   * 一条记忆在注入时 detail 允许留多长。
   *
   * SPEC §3.3：分区强度作用在**注入时**的长度上限，不改磁盘内容；
   * 下限 40 字 —— 越深越模糊，但不能模糊成没有。
   *
   * @param {any} entry
   * @returns {number}
   */
  function detailLimitFor(entry) {
    const map = {
      short: Number(config.shortDetail) || 0.9,
      long: Number(config.longDetail) || 0.55,
      permanent: Number(config.permanentDetail) || 0.3,
    };
    // 绝对上限：强度再高也不许一条记忆占满整个预算。
    // 短期「稍微详细」= 200 字上下，不是「把原始对话搬回来」。
    const cap = { short: 240, long: 150, permanent: 110 };
    const strength = map[entry?.zone] ?? 0.9;
    const base = String(entry?.detail ?? '').length || 40;
    const soft = Math.round(base * strength);
    const ceiling = cap[entry?.zone] ?? 200;
    return Math.max(40, Math.min(soft, ceiling));
  }

  log(`已加载，当前分区「${spaceInfo.activeName}」：${dataDir}`);
}
