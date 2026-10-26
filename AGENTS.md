# 给接手这个项目的 AI 读

> DSH 会自动加载工作区的 `AGENTS.md`。目标：**换一个全新会话、没有任何上下文，
> 也能接着干，不用问人。**

## 一句话

`ebbinghaus-memory` 是一个 DSH 插件：把对话按**艾宾浩斯遗忘曲线**整理成
短期（7 天）/ 长期（28 天）/ 永久三层记忆。到期升级、超容压缩、按需检索。

用户的原话（照着做，别"优化"掉）：

> 我的解决方案是创建三个记忆文件夹，短期七天记忆，长期28天记忆，以及永久记忆，
> 短期只留最近七天，第七天把它认为相对和极其重要的记忆存进长期记忆中。

## 先读这些（按顺序）

| 文件 | 内容 |
|---|---|
| `SPEC.md` | **唯一基准**。冻结的签名、磁盘布局、注入格式、禁令清单 |
| `README.md` | 对外门面：装法、设置项、面板、排错 |
| `src/core/*.mjs` | 纯函数层。**不碰 fs 之外的任何东西**，能 `node --test` 直跑 |
| `src/host/index.mjs` | 编排层。事件钩子 / 模型调用 / 注入 / 工具 / HTTP |
| `src/client/index.js` | 侧栏面板。手写，无构建 |

**改代码前先读 SPEC。** 里面每条禁令背后都有一个真实踩过的坑。

## 硬约束（别破坏）

1. **零运行时依赖、零构建步骤。** 绝不 `import` 任何 `@deepseek-ai/dsh-*` ——
   解析不到就整个插件加载失败。`peerDependencies` 只写 `@deepseek-ai/cordis`。
2. **`schemastery` 只能试探性 require，不能静态 import。**
3. **配置不加 `.volatile()`。** 加了会让 `dataDir: ''` 被包成对象，进插件里变成
   `'[object Object]'`，记忆库写进一个叫 `[object Object]` 的目录，**全程无报错**。
   `resolveConfig` 已经挡了一层（非字符串退回默认），别把这层去掉。
4. **`agent/turn-stopping` 里同步极快返回，模型调用一律 `setImmediate` 出栈。**
   在那个调用栈里同步发 `llm.stream` 会死等回合锁：请求正常发出、chunk 正常到达、
   没有一条报错、就是不返回。
5. **后台任务要 hold 一个 ref 的 `setInterval`。** 用 `unref()` 等于没人在等，
   一次性会话会直接退进程，表现为「时好时坏，模型答了记忆没了」。
6. **到期判定用 `entry.ts`（事件时间），不是 `createdAt`。** 用户明确要求
   「时间戳按照原有记忆时间」。
7. **压缩后 `detail` 有 40 字下限。** 越深越模糊，但**不能模糊成没有**。
8. **检索是查找不是载入。** 命中几条只注入那几条，绝不整区倒进上下文。
9. **注入预算有硬上限**，超了按「长期 → 检索命中 → 短期 → 永久」的顺序砍。
   永久放最后是实测改的：短期 10 条 ×200 字会把预算吃光，人格记忆一条进不去。
10. **调试日志只打形状**（条数/token/耗时），绝不落盘对话正文。
11. **面板不许 JSX、不许 require react 以外的东西、颜色只用 `--dsw-alias-*`。**
12. **子代理的对话不是记忆。** `session.header.parentSession` 存在就跳过 ——
    dsh-subagent 派活时给子代理的第一条 prompt 用的是 `source: {kind:'user'}`，
    只按 source 过滤挡不住，记忆里会长出「core-agent 在写 zones.mjs」。
13. **每个会话第一轮必写。** 否则 `writeEveryTurns: 2` 时「问一句就走」永远记不住：
    第 1 轮 `1 - 0 = 1 < 2`，然后会话结束，那句话白说了。
14. **落盘前先 `mergeFromDisk()`。** 只要有两个写者（插件 + 迁移/导入工具、
    或者 DSH 端 + AstrBot 端），后落盘的会静默抹掉先落盘的。
15. **删除必须立墓碑**（`meta.deleted_ids`）。不立的话上面那次合并会把刚删的条目
    捞回来，「忘掉」按钮当场失效。
16. **压缩/淘汰前先 `store.archive()`。** 压缩不可逆，原文进了 `_archive/` 才捞得回来。
17. **两道容量闸，别混。** 条数上限（`*Capacity`）管「每区几条」，总量上限
    （`totalTokenCapacity`）管「整库渲染成多少 token」；`budgetTokens` 是**每轮注入**
    的预算，跟那两个都不是一回事。总量口径必须与注入一致：
    `detailLimitFor()` → `renderEntryLine()` → `countTokens()` 三件套，谁另写一个系数，
    面板就和实际进上下文的东西对不上账。
18. **面板改的值存 `<dataDir>/settings.json`，不写回 profile 的 `cordis.patch.yml`。**
    那是 DSH 的财产，多个插件都在写，一个插件去改它等于两只手同时编辑同一个 yml。
    优先级：settings.json > yml / 设置页 > 代码默认值。白名单外的键明确拒收
    （`TUNABLE_KEYS`），坏值保留原值而不是掉回默认。
19. **`reclaimForTotalBudget` 的返回字段是 `withinCapacity`，不是 `ok`。** 响应体里的
    `ok` 是「请求成没成」；回收没达标是业务结果。同名会被 spread 覆盖，面板就会
    报「回收失败」，其实回收跑得好好的 —— 这个坑已经踩过一次。
20. **默认值不许在两处各写一份。** 容量默认值从 60/120/240 提到 120/600/1000 时，
    `zones.mjs`、`store.mjs` 里各有一份写死的兜底数字，结果「没配置」和「配置坏了」
    算出两个不同上限，面板上看不出来。兜底一律取 `CONFIG_DEFAULTS`。
21. **自检（去重）和压缩是两件事，别混。** `compress` 按**容量**压，越压越模糊
    （遗忘曲线）；`dedup` 按**内容**合，说的是同一件事就并成一条，细节留最全的那份。
    前者是「忘」，后者是「去重」。自检跑在固化的尾巴上、同一个串行队列里，
    **不注入对话、不调模型**（用户原话「不注入对话的自检」）—— 改它的时候这两条
    不能破：一旦它开始调模型或往 systemPrompt 里塞东西，省 token 的初衷就反过来了。
22. **自检进度必须落盘**（`<dataDir>/dedup-state.json`）。只存内存 = 每次重启归零，
    「每 30 条自检一次」会变成「每 30 条，或者每次重开 DSH 后第一次写记忆」。
23. **相似度用重叠系数，不用余弦。** 重复最常见的形态是「短的那条被长的包住」，
    实测同一件事的两种写法：余弦 0.38（合不上）、重叠系数 0.73（合得上）。
24. **阈值 0.5 是拿真库调出来的**，改之前先跑 `tools/dedup.mjs --dry-run` 看会多合
    哪些 —— 这个数往下的第一档就开始把「同一天发生的两件事」揉一起了。
25. **首次运行要把库骨架建出来。** `meta.json` + `short/long/permanent.jsonl`
    在第一次 `store.load()` 时就创建（分区文件是 0 字节空文件），不能等第一条记忆
    落盘才出现 —— 用户要求「首次运行初始化独立的分区文档」。已有文件**一个字都不碰**，
    重启不许重置 `created_at`；建不出来只 `warn`，只读目录不该让插件加载失败。
    细节见 `SPEC.md` §2.1。

## 共用记忆库

作者同时维护了两份实现（Python 那份不在本仓库里）：

```
<克隆目录>                     DSH 插件（Node，就是这个仓库）
<AstrBot 插件目录>              AstrBot 插件（Python，另一个仓库）
        └──── 都读写同一个目录 ────┘
$DSH_HOME/ebbinghaus-memory/   （默认 ~/.dsh/ebbinghaus-memory/）
```

两端的磁盘格式必须**字节级一致**（驼峰字段、`ensure_ascii=False`、紧凑 JSON）。
改任何一侧的 `schema` / `store` / `zones`，另一侧必须同步，否则「同一份记忆」
会在两端算出不同结果。契约在 Python 那份的 `PORT-SPEC.md` 里。

> 只装 Node 这一侧完全能独立工作 —— 共用库是可选的，不是依赖。

同步靠命令行，不靠 HTTP：

```powershell
node tools/export.mjs --out D:\temp\mem.json
node tools/import.mjs --apply D:\temp\mem.json
node tools/restore.mjs --tag dropped          # 从冷存档捞回来
```

## 怎么跑

Windows 上 `node` 常常不在 PATH（DSH Desktop 自带一份）：

```powershell
# DSH Desktop 自带的那份；路径按你的安装位置改
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe"
cd <克隆目录>
& $node --test                    # 全部测试（219 个）
& $node tools/check-patch-yaml.mjs
& $node tools/export.mjs --help
```

macOS / Linux 直接 `node --test` 就行，`node` 在 PATH 里。

## 改完必须真装一次

**测试全绿 ≠ 插件能用。** 纯逻辑测试碰不到「插件 × 运行时 × 生命周期」交界处的问题。
真装到临时 profile 里跑一遍（别动用户的 desktop profile）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh eb-verify --from-default-profile headless --dump-config
& $dsh plugin --profile eb-verify add "link:<克隆目录>"
& $dsh --profile eb-verify "记住：我在做记忆插件"
Remove-Item "$env:USERPROFILE\.dsh\profiles\eb-verify" -Recurse -Force
```

日志里应该依次出现：`记忆库就绪` → `已注册注入段` → `开闸` → `固化开始` →
`模型返回` → `记下 N 条`。哪一行断了，问题就在那一行之后。

## 已经踩过的坑

| 别这么干 | 为什么 |
|---|---|
| 把整个分区塞进注入 | 用户明确说了「查找不是载入」 |
| 压缩时改 `ts` | 时间戳必须是事件发生时间 |
| 让 core 层碰 `ctx` / `net` | core 必须是纯函数，否则没法单测 |
| 用 `JSON.stringify` 整个库写一个文件 | 坏一次全丢；JSONL 坏一行只丢一条 |
| 在写盘前就更新内存副本 | 会读到「内存已更新、磁盘还没写」的中间态 |
| 后台调用跟随前台的 `reasoningEffort` | 用户选 high → 后台也在疯狂思考，token 全烧在推理上，正文一个字没有 |
| 拿 `stderr` 当日志出口 | headless 跑完直接退进程，缓冲区来不及刷 |
| 把回收结果字段叫 `ok` | 会被 HTTP 响应的 `ok` 覆盖，面板报「回收失败」而其实成功了 |
| 在 client 里再写一份字段 min/max | host 的 `settings.fields` 已经给了，两处早晚漂移 |
| 用余弦算「是不是同一件事」 | 长度差异一大会被稀释，实测同义的两条只算出 0.38，根本合不上 |
| 自检里调模型 | 自检的目的就是省 token，调模型等于为了省钱花钱 |
| 把自检进度只放内存 | 每次重启归零，「每 N 条一次」变成「每 N 条或每次重开一次」 |
| 用数字框渲染布尔配置 | 提交会变成 1/0，host 那边 coerce 成 true/false 看似没错，但用户看到的是「1」 |
| 面板改配置直接写 `cordis.patch.yml` | 多个插件共写一个 yml，改坏就整份读不出来 |

## 规矩

- 用户不是专业开发者。**说人话，给能照着做的步骤。**
- 改用户已有数据（旧档案、DSH 配置）前先说一声，且**默认只演不写**。
- 做取舍时问一句：**「这像人的记忆，还是像一个数据库？」** 像数据库的砍掉。
