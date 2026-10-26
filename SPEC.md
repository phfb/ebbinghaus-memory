# Ebbinghaus-memory · 接口契约（唯一基准）

> 这份文件是给**并行干活的 AI**看的。签名、字段名、磁盘布局一旦写在这里就是**冻结**的。
> 实现可以优化，签名不能改 —— 改签名会让别人那一半编译不过。

---

## 0. 这是什么

一个 DeepSeek Harness 插件，用**艾宾浩斯遗忘曲线**组织记忆：

```
新对话 ──精简──▶ 短期记忆（short，默认 7 天）
                     │ 到期（7天）按权重判断
                     ├── weight ≥ promoteShortToLong ──▶ 长期记忆（long，默认 28 天）
                     └── 否则 ──▶ 压缩后淘汰
                                   │ 到期（28天）按权重判断
                                   ├── weight ≥ promoteLongToPermanent ──▶ 永久记忆（permanent）
                                   └── 否则 ──▶ 压缩后淘汰

任一区 条数 > capacity ──▶ 回滚压缩：最老的 k 条合并成一条更模糊的 → 压进下一区
```

三条不可动摇的东西：

1. **每条记忆必带时间戳**（`ts` 毫秒 + `iso` 字符串），注入时渲染成人话（「3 天前」）。
2. **越深越模糊，但不能是没有**（`detail` 有长度下限，见 §3.3）。
3. **选择性检索是查找不是载入**：命中几条就只注入那几条，绝不把整个分区倒进上下文。

---

## 1. 目录职责（写作用域，别越界）

| 目录/文件 | 谁写 | 内容 |
|---|---|---|
| `src/core/schema.mjs` `time.mjs` `config.mjs` `store.mjs` | **Lead（已完成）** | 数据结构、时间、配置、磁盘 |
| `src/core/zones.mjs` `compress.mjs` `recall.mjs` `render.mjs` | **core-agent** | 三分区策略、压缩、检索、注入渲染 |
| `src/host/index.mjs` | **host-agent** | 事件钩子、固化、工具、HTTP |
| `src/client/index.js` | **client-agent** | 侧栏面板 |
| `tools/check-patch-yaml.mjs` | — | 补丁 yaml 校验 |

**零运行时依赖**：谁也不许 `import` 任何 `@deepseek-ai/dsh-*`；core 层是纯 ESM 纯函数。
`node --test` 能直接跑，不许有构建步骤。

---

## 2. 磁盘布局（冻结）

```
<dataDir>/
  meta.json           { schema: 1, created_at, updated_at, version }
  short.jsonl         一行一条记忆
  long.jsonl
  permanent.jsonl
  .index.json         派生关键词索引（可随时删掉重建）
```

- JSONL：**一行一个 JSON**，追加友好。坏一行只丢一条。
- 写盘：整份重写 + 原子替换（`tmp` → `rename`），禁止半截文件。
- 排序：文件内按 `ts` 升序（老的在前）。

### 2.1 首次运行初始化（冻结）

`store.load()` 是**幂等**的，并且负责把库骨架建出来 —— 用户要求「首次运行就初始化，
有独立的记忆分区文档」，不能等第一条记忆落盘才冒出来：

| 情况 | 行为 |
|---|---|
| 目录不存在 | `mkdir -p`（`recursive: true`） |
| `meta.json` 不存在 | 写一份初始 meta：`{ schema, created_at: Date.now(), updated_at: 0, version }`，UTF-8 无 BOM |
| 某个分区 jsonl 不存在 | 建一个 **0 字节空文件** |
| 文件已存在 | **一个字都不碰**，`created_at` 不重置 |

**三条约束**：

1. **空文件是合法库**，不是坏档 —— `parseJsonl('')` 返回 `{ entries: [], bad: 0 }`，
   不会被算成 1 行坏数据。
2. **建不出来只 `warn`，绝不抛。** 只读目录、权限不足时插件必须照样加载 ——
   记忆写不进去是次要故障，插件起不来是主要故障。
3. **`reload()` 复用同一套逻辑**，所以外部工具（import / restore）跑完再 reload
   也不会把已有文件重写一遍。

---

## 3. 记忆条目（冻结）

### 3.1 形状

```js
{
  id: 'em-20261025T0058-a1b2',   // string，唯一
  ts: 1761321600000,             // number，**事件发生时间**（毫秒）
  iso: '2026-10-25T00:58:57+08:00', // string，同一时刻的可读形式
  zone: 'short',                 // 'short' | 'long' | 'permanent'
  weight: 0.7,                   // number 0..1，AI 判的重要度
  title: '他在做 DSH 记忆插件',    // string，一句话，≤80 字
  detail: '……',                  // string，细节；被压缩后变短
  keywords: ['记忆插件','DSH'],   // string[] 2..10 个，检索用
  source: 'chat',                // 'chat' | 'seed' | 'note' | 'merge'
  depth: 0,                      // number，压缩层级：0=原始，每压一次 +1
  mergedFrom: [],                // string[]，被合并进来的 id（仅 source=merge）
  session: 'abc123',             // string，来源会话短 id，可空
  touchedAt: 1761321600000,      // number，最近一次被检索/引用
  createdAt: 1761321600000       // number，入库时间
}
```

### 3.2 不变量

- `id` 全局唯一，格式 `em-<YYYYMMDD>T<HHmm>-<4位hex>`。
- `zone` 必须与它所在的 jsonl 一致。
- `weight ∈ [0,1]`；`depth ∈ [0,9]`；`keywords.length ∈ [1,10]`。
- **只增不改时间**：任何压缩/升级都保留原 `ts`（用户明确要求「时间戳按照原有记忆时间」）。

### 3.3 `detail` 长度下限（防「模糊成没有」）

渲染时按 `detailFloor(depth)` 截断，但**不短于 40 字**：

```js
detailFloor(depth) = max(40, round(baseLen * factor(depth)))
factor(0)=1, factor(1)=0.55, factor(2)=0.35, factor(3+)=0.25
```

分区强度 `cfg.shortDetail/longDetail/permanentDetail` 作用在**注入时**的长度上限，
不改变磁盘内容 —— 磁盘永远保留细节，方便日后检索。

---

## 4. `src/core/config.mjs`（已完成，直接用）

```js
import { resolveConfig, CONFIG_SPEC, CONFIG_DEFAULTS, buildSchema } from './config.mjs';
const cfg = resolveConfig(rawConfigFromDSH);  // 永不抛错，坏值退默认
```

字段（全部可在设置页改，见 `cordis.patch.yml`）：

`enabled dataDir shortDays longDays writeEveryTurns shortCapacity longCapacity
permanentCapacity totalTokenCapacity shortDetail longDetail permanentDetail
loadShortCount loadLongRandom loadPermanentCount budgetTokens promoteShortToLong
promoteLongToPermanent forgetBelow recallTop recallThreshold
dedupEnabled dedupEveryEntries dedupThreshold
provider model reasoningEffort maxTokens jobTimeoutMs debugLog`

**默认值（2026-10-25 调整）**：`shortCapacity 120 / longCapacity 600 /
permanentCapacity 1000`（用户嫌记得太少，全体上调）；`totalTokenCapacity 100000`
（第二道闸，硬顶 300000）；`dedupEnabled true / dedupEveryEntries 30（5-100）/
dedupThreshold 0.5`（第三道闸：自检去重）。

### 4.1 面板可调键与运行时覆盖（冻结）

```js
export const TUNABLE_KEYS = [...]              // 面板允许改的 14 个键
export function fieldSpec(key) -> ConfigField | undefined
export function tunableFields(config, overrides) -> field[]   // 给面板画输入框
export function applyOverrides(config, overrides) -> { config, accepted, rejected }
```

- 覆盖层存在 `<dataDir>/settings.json`，**不写回** profile 的 `cordis.patch.yml`
  （那是 DSH 的财产，多写者会互相改坏）。
- 优先级：`settings.json` > `cordis.patch.yml` / 设置页 > 代码默认值。
- 白名单外（`dataDir` / `enabled` / `provider` …）**明确拒收**并在响应里报出来。
- 坏值（`NaN` / 非数字）不进覆盖层，且**保留该键原来的值**（不能掉回默认值）。

---

## 5. `src/core/schema.mjs`（已完成）

```js
export const ZONES = ['short', 'long', 'permanent'];
export const ZONE_LABEL = { short: '短期', long: '长期', permanent: '永久' };
export function makeId(ts, takenIds) -> string
export function normalizeEntry(raw, { zone, now, defaults }) -> entry | null
export function isValidEntry(e) -> boolean
export function clamp01(n) -> number
```

`normalizeEntry` 的职责：补齐缺省、夹紧范围、`ts`→`iso`、`title` 去空、`keywords`
去重截断。**不合格（没 title 也没 detail）返回 `null`**，调用方丢弃。

---

## 6. `src/core/time.mjs`（已完成）

```js
export function isoOf(ts) -> string                  // +08:00 本地时区
export function stampFor(ts) -> string               // '10-24 21:30'
export function fullStamp(ts) -> string              // '2026-10-24 21:30'
export function startOfDay(ts) -> number
export function daysBetween(a, b) -> number          // 日历天，b 比 a 晚为正
export function relativeLabel(ts, now) -> string     // '今天' | '昨天' | '3 天前' | '10-05'
export function isExpired(ts, windowDays, now) -> boolean
```

---

## 7. `src/core/store.mjs`（已完成）

```js
import { createStore } from './store.mjs';
const store = createStore({ dir, log, warn });
await store.load();                    // 幂等；坏文件 → 空数组 + warn，绝不抛
store.meta                             // { schema, created_at, updated_at, version }
store.zones                            // { short: Entry[], long: Entry[], permanent: Entry[] }
store.all()                            // 三区合并，按 ts 升序
store.get(id)                          // Entry | undefined
store.add(entry)                       // 按 entry.zone 落位；重复 id 覆盖
store.remove(id)                       // boolean
store.setZone(zone, entries)           // 整区替换（压缩/升级后用）
store.capacity()                       // { short: {count, max, ratio}, long: {...}, permanent: {...} }
await store.save()                     // 原子写；内部串行化，可并发调用
await store.reload()                   // 重读磁盘（外部工具写过库之后用）
await store.mergeFromDisk()            // save() 内部自动调：合并外部新增，按墓碑跳过已删
```

**两条不能省的写盘纪律：**

1. **落盘前先合并磁盘。** 只要有两个写者（插件 + `tools/import.mjs`、或两个插件实例），
   后落盘的就会静默抹掉先落盘的。`save()` 会先读一遍磁盘，把「磁盘上有、内存里没有」
   且不在墓碑里的条目合并进来，再整份重写。
2. **删除必须立墓碑**（`meta.deleted_ids`）。不立的话，上面那次合并会读回刚删掉的那条
   —— 判成「别人刚加的」捞回来，「忘掉」按钮当场失效。

---

## 8. `src/core/zones.mjs`（core-agent）

```js
/**
 * 新条目进哪一区。
 * hint = 固化时模型自己给的分区建议（用户要求「由 AI 判断该进哪一层」）。
 * 没给建议时按权重保守分层：≥0.92 永久、≥0.78 长期、其余短期。
 */
export function initialZoneFor(weight, cfg, hint) -> 'short' | 'long' | 'permanent'

/**
 * 到期收割。纯函数，不改入参。
 *  - 过 shortDays 的短期条目：weight ≥ promoteShortToLong → long
 *                              weight <  forgetBelow        → 进 dropped（不是直接扔）
 *                              其余                          → 留在 short（但 depth+1，模糊化）
 *  - 过 longDays 的长期条目：weight ≥ promoteLongToPermanent → permanent
 *                            weight <  forgetBelow          → 进 dropped
 *                            其余                            → 留 long（depth+1）
 * 返回：{ zones, plan: [{ id, from, to: 'long'|'permanent'|'drop'|'stay', reason }],
 *         dropped: { short: Entry[], long: Entry[] } }
 */
export function harvest({ zones, cfg, now }) -> { zones, plan, dropped }

/**
 * 「压缩后剔除」：把一批被淘汰的记忆揉成一条模糊印象留在原区。
 * 权重夹在 forgetBelow 与升级线之间 —— 不会再被立刻判死，也爬不回上一层。
 * 少于 2 条返回 null（一条不值得单独留印象）。
 */
export function digestDropped(droppedList, cfg, now) -> Entry | null

/** 某区是否超容。 */
export function isOverCapacity(zone, entries, cfg) -> boolean

/** 超容时要挪走多少条（至少 1）。 */
export function overflowCount(zone, entries, cfg) -> number
```

**到期判断一律用 `entry.ts`**（事件发生时间），不是入库时间。

---

## 9. `src/core/compress.mjs`（core-agent）

```js
/** 挑出该被压缩的那批：按 ts 升序取最老的 k 条（k = overflowCount）。 */
export function pickCompressGroup(zone, entries, cfg) -> Entry[]

/**
 * 本地兜底合并（模型失败/被截断时用）。**必须永远能出一个条目。**
 * 规则：title 取最老那条的 title 加「（合并 N 条）」；
 *       detail 取各条 detail 的首句，用「；」连，按 depth 截断但不短于 40 字；
 *       keywords 并集去重取前 10；weight 取加权平均（按条数）；
 *       ts 取**最老那条**的 ts；depth = max(depth)+1；source='merge'。
 */
export function fallbackMerge(entries, { now }) -> Entry

/**
 * 调模型压缩成一条更模糊的记忆。签名收一个 stream 函数，方便测试注入桩。
 * 失败时返回 null，由调用方退回 fallbackMerge。
 */
export async function compressWithModel(entries, { stream, provider, model, maxTokens, signal, zone }) -> Entry | null
```

---

## 10. `src/core/recall.mjs`（core-agent）

```js
/** 中文按 2-gram + 英文/数字按词切；去掉停用词与长度<2 的中文碎片。 */
export function tokenize(text) -> string[]

/** 单条记忆对一组 query token 的得分（0 起）。 */
export function scoreEntry(entry, queryTokens) -> number

/**
 * 跨区检索。**只返回命中的少量条目**。
 * 打分：keywords 命中 ×3，title 命中 ×2，detail 命中 ×1；再乘 (0.5 + weight)。
 * 过滤 score < threshold，按分数降序取 top 条。同分时永久 > 长期 > 短期。
 */
export function search(zones, query, { top, threshold }) -> Entry[]

/** 给注入层用：本地自动检索（不调模型）。没有命中返回 []。 */
export function autoRecall(zones, lastUserText, cfg) -> Entry[]
```

`autoRecall` 要**保守**：宁可漏，不要每轮都塞一堆旧事。

---

## 11. `src/core/render.mjs`（core-agent）

```js
/**
 * 渲染注入块。
 * @param {object} p
 * @param {object} p.zones          三区条目
 * @param {object} p.cfg
 * @param {number} p.now
 * @param {Entry[]} p.recalled      本轮检索命中（可空）
 * @param {number} p.budgetTokens
 * @returns {{ text: string, tokens: number, breakdown: object }}
 */
export function renderInjection(p) -> { text, tokens, breakdown }

/** 单条记忆渲染成一行（面板与注入共用同一套措辞）。 */
export function renderEntryLine(entry, { now, detailLimit }) -> string
```

注入文本形状（**照这个写，别自己发明**）：

```
<ebbinghaus-memory>
你的记忆按遗忘曲线分三层。时间戳是事件发生的时间，不是你现在的时间。
不要凭空补全这里没有的事。

〔短期 · 最近 7 天〕
- [10-24 21:30] 他在做 DSH 记忆插件 —— 要求三分区、可调周期、时间戳。 · 0.72
- [昨天] 他嫌公司食堂太油 · 0.55

〔长期 · 偶尔想起来〕
- [10-18] 三楼实验室的分区方案做完了 v3 · 0.6

〔永久 · 我记得的〕
- [09-30] 四川人，在杭州工作，吃不惯重油早餐 · 0.9

〔这轮想起来的〕            ← 仅在 recalled 非空时出现
- [10-12 03:12] 他那天也在熬到三点改机器人模型 · 0.7
</ebbinghaus-memory>
```

规则：
- 空区整段不出现（不写「（空）」）。
- 每条占一行，`[时间] title —— detail截断 · weight`。
  如果 `detail` 以 `title` 开头（从别处导入的旧记忆就是这种形状），**只渲染一份** ——
  否则会读成「…不是我新 —— …不是我新装的 dsh-pet；…」，一句话说两遍。
- `tokens` 用 `Math.ceil(text.length / 1.8)` 估（中文一 token ≈ 1.8 字）。
- 超预算：先砍「长期」，再砍「这轮想起来的」，再砍「短期里最老的」，
  **永久区最后砍**。砍完重算。`breakdown` 记每区实际条数与裁掉的数量。
  > 这条顺序是**实测改过来的**：原来永久先于短期被砍，结果短期 10 条 ×200 字
  > 把预算吃光，「我记得你是什么样的人」一条没进去，「上周二改了个 BOM」留下来了。
  > 永久区只有三四条、每条一百来字，体积最小、价值最高，是底色。

---

## 11.5 `src/core/budget.mjs`（全库总量，冻结）

```js
export const TOTAL_CAPACITY_MIN = 5000
export const TOTAL_CAPACITY_MAX = 300000
export const TOTAL_CAPACITY_DEFAULT = 100000

export function totalCapacityOf(cfg) -> number        // 钳到 [5000, 300000]
export function estimateEntryTokens(entry, zone, cfg, now) -> number
export function tokenUsage(zones, cfg, now)
  -> { total, capacity, ratio, over, left, byZone, count }
export function pickReclaimGroup(zones, cfg, now, opts)
  -> { zone, entries } | null
```

**口径必须与注入一致**：`detailLimitFor()` → `renderEntryLine()` → `countTokens()`
（同一套三件，中文 1.8 字 ≈ 1 token）。**任何一处另写系数，面板就会和注入对不上账。**

`tokenUsage` 返回的 `ratio` 顶到 1（不显示 120%），`left` 为 0 而不是负数。

`pickReclaimGroup` 的规则（冻结，都是取舍过的）：

| 规则 | 原因 |
|---|---|
| 区顺序 `long → short → permanent` | 与注入裁剪同源：长期是背景音，永久是底色 |
| 组内按 `weight` 升序、同权重按 `ts` 升序 | 「最不重要 + 最老」先走 |
| 24 小时内的记忆排到组尾 | 刚记下来的事很可能马上要用 |
| 永久区 `weight ≥ 0.92` 不参与 | 那是「我记得你是什么样的人」，不许被回收 |
| 一个区可用的不足 2 条就跳过 | 一条揉不成印象 |
| 挑不出来返回 `null` | 调用方据此报 `exhausted`，**不假装成功** |

---

## 11.6 `src/core/dedup.mjs`（记忆库自检，冻结）

```js
export const DEDUP_THRESHOLD_MIN = 0.3
export const DEDUP_THRESHOLD_MAX = 0.95
export const DEDUP_THRESHOLD_DEFAULT = 0.5

export function dedupThresholdOf(cfg) -> number      // 钳到 [0.3, 0.95]
export function dedupEveryOf(cfg) -> number          // 钳到 [5, 100]，默认 30
export function tokenSetOf(entry) -> Set<string>
export function similarity(aSets, bSets, idf) -> number
export function findDuplicateGroups(zones, cfg, opts)
  -> { groups: {zone, entries, similarity}[], checked, compared }
export function mergeDuplicateGroup(entries, {now, zone, taken}) -> Entry | null
```

**口径（每条都是调过的，别改）：**

| 项 | 做法 | 为什么 |
|---|---|---|
| token 化 | 复用 recall.mjs 的 `tokenize`，**标题重复一次** | 标题是「这件事是什么」的概括，比 detail 更能代表是否同一件事 |
| 相似度 | **IDF 加权重叠系数**：`Σw²(交集) / min(Σw²(A), Σw²(B))` | 重复最常见的形态是「短的那条被长的包住」。实测同类记忆用余弦只有 0.38，用重叠系数 0.73 |
| 候选筛选 | 倒排索引，共享 ≥2 个 token 才精算；单 token 桶 >200 条跳过 | 避免 O(n²)，也让「满库都有的词」失去区分度 |
| 聚类 | 相似度降序 + **complete-linkage**（簇内两两都要达标），单簇 ≤4 | 挡住「A像B、B像C，于是A和C也被合」的链式误合 |
| 长度保护 | token 数比 > 4 倍算「包含」不算「重复」 | 不然一篇 800 字档案能把它覆盖到的所有短记忆全吞掉 |
| 最小体积 | token < 5 不参与 | 三个字的标题跟谁都能「有点像」 |
| 落位 | 组内**最深**的区（永久 > 长期 > 短期） | 一条短期 + 一条永久 → 留永久 |

**合并字段取舍**：`ts` 最老 / `weight` 最高（重复本身就是重要性的证据）/
`detail` 最长（去重不丢信息）/ `title` 最短（≥4 字）/ `keywords` 并集 /
`depth` 最大 / `zone` 调用方给 / `source='merge'` / `mergedFrom` 记全部 id。

---

## 12. `src/host/index.mjs`（host-agent）

必须实现的骨架（细节看本仓 `src/host/index.mjs`）：

```js
export const name = 'ebbinghaus-memory';
export const inject = [];          // 服务用 ctx.get/ctx.inject 懒取，别写死
export function apply(ctx, rawConfig) { … }
```

要点（**每条都是踩过的坑**）：

1. `ctx.effect(() => () => {…}, '描述')` 注册一切清理。
2. 目录在 `apply()` 里一次算定（`dataDir || $DSH_HOME/ebbinghaus-memory`），别懒读环境变量。
3. `ctx.on('session/event', (session, event) => …)` 收 `user/message`（`data.source.kind === 'user'`）
   与 `assistant/message` 到内存 transcript（最多 40 条）。
4. `ctx.on('agent/turn-stopping', …)`：**同步、极快**返回，只做计数与入队；
   模型调用一律 `setImmediate` 推出调用栈（否则 `llm.stream` 死等回合锁）。
5. 后台任务要 `holdProcessOpen()`（ref 的 `setInterval`）：否则一次性会话直接退进程，
   表现为「时好时坏，模型答了记忆没了」。任务超时 = `cfg.jobTimeoutMs`。
6. 固化：`ctx.get('llm')` + `ctx.get('agentDefaultModel')?.currentSelection?.()` 拿 provider；
   `llm.stream({ provider, model, system, messages, maxTokens, temperature: 0.2,
   reasoningEffort: 'off', signal })`，收 `chunk.type === 'text-delta'`。
   `finish.kind === 'error' | 'aborted' | 'max-tokens'` 一律**不写盘**。
7. 注入：`agent.ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section({
   name: 'ebbinghaus:memory', order: 110, text: () => renderFor(agent.id), interpolate: false }))`，
   为每个 agent 建一次，`agent/created` / `agent/disposed` 管理。
   按 `(sessionId, turn)` 缓存渲染结果。
8. 工具（`ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({…}), '…'))`）：
   - `memory_search`：`{ query, top? }` → 跨区关键词查找，返回命中条目（**只取这几条**）
   - `memory_stats`：三区容量
   参数用**手写 JSON Schema**（不能 import `@deepseek-ai/dsh-tools`）。
9. HTTP（`ctx.inject(['webServer'], …)` + `scope.webServer.register({ kind:'exact', path, handler })`）：
   - `GET  /ebbinghaus/state`   三区容量 + 全库 token 总量 + 设置字段表 + 最近条目 + 检索结果（带 `?q=`）
   - `GET  /ebbinghaus/settings` 可调字段表（当前值 / 边界 / 底座值）
   - `POST /ebbinghaus/settings` `{ key: value, … }` 或 `{ reset: true }` → 落 settings.json 并当场生效
   - `POST /ebbinghaus/forget`  `{ id }` 删一条
   - `POST /ebbinghaus/harvest` 手动跑一次到期收割
   - `POST /ebbinghaus/compress` `{ zone }` 手动压缩一次
   - `POST /ebbinghaus/reclaim` 按全库 token 总量回收一次（**等它跑完再回**）
   - `POST /ebbinghaus/dedup` 记忆库自检一次（重复记忆合并，本地算法，**等它跑完再回**）
   - `POST /ebbinghaus/reload`  重读磁盘（外部工具写过库之后用，否则内存还是旧的）
   - `GET  /ebbinghaus/export`  导出 JSON

   > `reclaim` 的返回字段叫 `withinCapacity`，**不叫 `ok`**：响应体的 `ok` 是
   > 「这次请求成没成」，回收没达标是业务结果。同名会被 spread 覆盖，面板就会
   > 报出一句「回收失败」，其实回收跑得好好的。
10. **降级优先**：所有回调包 try/catch，记忆坏了不能挡住聊天。
11. **总量回收挂在三处**：固化结束、手动 harvest、手动 compress 之后各跑一次
    （`reclaimForTotalBudget`）；面板保存设置后如果已经超限，用 `runInBackground`
    异步跑，**不让保存按钮等模型**。
12. **自检（去重）挂在固化的尾巴上**：`noteNewEntries(added)` 累加
    `dedup-state.json` 里的 `entriesSinceCheck`，满 `dedupEveryEntries` 就按
    `runDedupNow({trigger:'auto'})` 跑一次。**必须走同一个串行队列**（和固化一样），
    两边都在改 store，并发写会互相覆盖。
13. **自检进度必须落盘**（`<dataDir>/dedup-state.json`）。只存内存的话每次重启归零，
    「每 30 条一次」会变成「每 30 条，或者每次重开 DSH 后第一次写记忆」。
14. **手动触发不受 `dedupEnabled` 拦**：面板上「立刻自检」按钮点了就该有反应，
    开关管的是「自动跑不跑」。

---

## 13. `src/client/index.js`（client-agent）

```js
window.__ModuleLoader__.load({
  id: 'ebbinghaus-memory',           // 必须等于包名
  factory: (require) => {
    const React = require('react');  // 只能 require react
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'ebbinghaus-memory', order: 42, label: () => '记忆' }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ebbinghaus-memory' }, Panel));
    }
    return { name: 'ebbinghaus-memory', inject: ['slots'], apply };
  },
});
```

面板内容（这是用户点名要的）：

- 顶部：三根**分区容量条**（短/长/永），显示 `已用 / 上限`、占比、峰值颜色（>80% 变警示色）
- 顶部：**第四根条 —— 全库总量**（token），缩写显示（`10.4K / 100K`），同样 >80% 警示
- **记忆库自检**：一行状态（每再写几条触发 / 上次什么时候跑的 / 合了几组 /
  累计少了几条）+「立刻自检」按钮
- **调整容量**（可折叠，默认收起）：`TUNABLE_KEYS` 的输入框 + token 开销说明（wiki）
  + 「保存」「恢复 DSH 配置」「按总量回收一次」。**入口必须一眼看见** ——
  用户原话是「我没看到在哪可以调」。布尔字段渲染成勾选框，不要用数字框。
- 每个分区可展开：按时间倒序列出条目（时间戳 + title + weight + depth）
- 检索框：输入关键词 → `GET /ebbinghaus/state?q=…` → 只显示命中的那几条
- 每区一个「压缩」按钮、每条一个「忘掉」按钮
- 底部：下次到期倒计时（最近一条要到期的记忆还有几天）

**不能用 JSX、不能 import 别的模块、颜色只能用 `--dsw-alias-*` token。**
字段表（`settings.fields`）由 host 给，客户端**不重复写 min/max** ——
两处各写一份，早晚有一处忘改。

---

## 14. 固化提示词（host-agent 用，冻结）

```
system:
你是记忆固化器。把这段对话压缩成 1-3 条记忆条目。

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
[{"ts":1761321600000,"weight":0.7,"zone":"short","title":"≤40字","detail":"≤200字","keywords":["2-6个词"]}]
```

解析要求：先剥 ```` ```json ```` 围栏，再 `JSON.parse`；失败则**整批丢弃**（绝不写半成品）。

---

## 15. 迁移（不随本仓发布）

针对某个私有插件旧档案格式的迁移脚本**没有随本仓发布** —— 那东西只对原作者自己的旧数据有用。
想把别处整理好的记忆搬进来，走 `tools/import.mjs`（见 README「导出 / 导入」）：
**保留原始时间戳**、按「距今多久」自动分层、重复跑不会产生重复条目。
## 16. 验收

```bash
node --test                 # 全绿
node tools/check-patch-yaml.mjs
```

然后**必须真装一次**（纯逻辑测试碰不到生命周期问题）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh eb-verify --from-default-profile headless --dump-config
& $dsh plugin --profile eb-verify add "link:D:\Ebbinghaus-memory"
```

---

## 17. 别做的事

| 别这么干 | 为什么 |
|---|---|
| 在 `turn-stopping` 里同步发模型请求 | 死等回合锁，`llm.stream` 永不返回且不报错 |
| 用 `unref()` 的定时器拖住进程 | 等于没人等，一次性会话直接退进程 |
| 导入任何 `@deepseek-ai/dsh-*` | 解析不到就整个插件加载失败 |
| 让 core 层碰 `ctx` / `fs` | core 必须是纯函数，否则没法用 `node --test` 跑 |
| 把整个分区塞进注入 | 用户明确说了「查找不是载入」 |
| 压缩时改 `ts` | 时间戳必须是事件发生时间 |
| 压缩后 `detail` 短于 40 字 | 越深越模糊，但**不能是没有** |
| 调试日志打对话正文 | 只打形状（条数/token/耗时） |
| 用 JSX / 引入 UI 组件库 | 没有构建步骤，只能 `React.createElement` |
| 写死颜色 | 只能用 `--dsw-alias-*`，否则深浅色切换翻车 |
