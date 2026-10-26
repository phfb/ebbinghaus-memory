# 更新日志

本项目的版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

发版前请跑一遍：

```bash
node --test
node tools/check-patch-yaml.mjs
```

---

## [0.2.0] - 2026-10-26

### 新增

- **自动备份镜像**：把记忆库全部文件 + `AGENT.md` / `prompt-inject.md` + （可选的）其它插件数据
  同步到指定目录，附带一个双击就能用的恢复程序。
  - 开关 `mirrorEnabled`（默认关）、频率 `mirrorEveryEntries`（默认 5 条，1-50）、
    目录 `mirrorDir`（绝对路径，留空不备份）、额外路径 `mirrorExtraPaths`
  - 镜像里有 `mirror-manifest.json` 清单 + `恢复记忆.cmd` + `_restore-memory.ps1`
  - 恢复程序自己找目标库位置，会先问 y/N，会把当前库先备份一份；支持 `-Target` 指定目标
  - 目录安全校验：不许和记忆库互相嵌套
- `tools/mirror.mjs`：手动同步 / 预演清单
- 镜像进度落在 `mirror-state.json`（和 `dedup-state.json` 同一个理由：不落盘就会每次重启归零）

### 改动

- 面板设置新增「自动备份镜像」一组，字符串字段（路径）现在有真正的文本框 / 文本域
- 镜像时跳过 `node_modules` / `__pycache__` / `*.pyc` / `*.bak-*` / `.git` —— 那些是运行组件，不是数据


## [0.1.0] — 2026-10-25

第一版。把 DSH 的对话记忆按**艾宾浩斯遗忘曲线**分成三层：

- **短期（7 天）** —— 刚发生的事，权重高的留着
- **长期（28 天）** —— 还记着有这么回事，细节开始模糊
- **永久** —— 沉成「我记得你是这样的人」

### 新增

- **首次运行就把库骨架建出来** —— `meta.json` + `short/long/permanent.jsonl` 四个文档
  在第一次启动时生成（三个分区文件是 0 字节空文件），不用手动初始化，也不用等第一条
  记忆落盘。之后重启只补缺的、绝不重写已有的，`created_at` 不会被重置。
- **三分区与到期策略** —— 到期按权重走三条分支：`weight ≥ promoteShortToLong` 升级、
  `weight < forgetBelow` 淘汰、中间档留级并 `depth+1`。永久区不到期。
- **回滚压缩** —— 分区条数超上限时，把最老的几条揉成一条更模糊的记忆压进下一层。
  压缩有 40 字细节下限：遗忘是模糊，不是删除。原文先写进 `_archive/`。
- **两道容量闸** —— 条数上限（`shortCapacity` / `longCapacity` / `permanentCapacity`）
  管「每区几条」；总量上限（`totalTokenCapacity`，默认 100000、硬顶 300000）管
  「整库渲染成多少 token」。两者都不影响每轮注入量。
- **注入预算** —— 默认 1400 token 硬顶，按「长期 → 检索命中 → 短期 → 永久」的顺序裁。
  永久放最后：它条数少、体积小、价值最高，是底色。
- **按需检索** —— `memory_search` 命中几条就只给几条，绝不把整个分区倒进上下文。
  过期条目靠关键词索引仍可召回：平时想不起来，提一句又想起来了。
- **记忆库自检（去重）** —— 每写 N 条（默认 30）跑一次本地 2-gram + IDF 加权重叠系数
  聚类，把说的是同一件事的记忆跨分区合并。**不注入对话、不调模型、先冷存档再删。**
- **侧栏面板** —— 分区容量条、全库总量条、每区展开列表、检索框、单条「忘掉」、
  分区「压缩」、自检状态与「立刻自检」按钮、「调整容量」折叠面板（改完当场生效，
  存在 `<库>/settings.json`）。
- **冷存档与恢复** —— `_archive/compressed.jsonl` / `_archive/dropped.jsonl` 保存被压缩
  和淘汰的原文，`tools/restore.mjs` 可按 tag / 时间 / 关键词 / id 捞回来。
- **命令行工具** —— `export` / `import`（跨端同步）、
  `restore`（冷存档恢复）、`dedup`（阈值试算）、`preview-injection`（看注入长什么样）、
  `check-patch-yaml`（补丁校验）、`smoke-cordis`（加载冒烟）。

### 设计取舍

- **零运行时依赖、零构建步骤。** 12 个源文件、纯 JS，装之前可以直接读完。
- **时间戳是事件发生的时间**，不是入库时间；迁移进来的旧记忆保留原时间。
- **JSONL 而不是单个 JSON**：坏一次全丢 vs. 坏一行只丢一条。
- **落盘前先 `mergeFromDisk()`**，删除立墓碑 —— 支持两个进程（插件 + 命令行工具、
  或 DSH 端 + AstrBot 端）同时写同一个库而不互相覆盖。

[0.1.0]: https://github.com/phfb/ebbinghaus-memory/releases/tag/v0.1.0
