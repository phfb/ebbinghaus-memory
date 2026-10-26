# 参与这个项目

先说清楚这个项目是什么：**一套会遗忘的记忆**，跑在 DeepSeek Harness 上。
它记对话，按艾宾浩斯曲线往下沉，该忘的忘掉，忘了的还能按关键词翻出来。

所以这里唯一的标准是一句话：

> **「这像人的记忆，还是像一个数据库？」** 像数据库的砍掉。

很多看着合理的东西（全量归档、精确时间线、跨区全文搜索、每轮注入整库）就是被这一条挡下来的。
提功能之前先过一遍这句话，会比读十页文档有用。

---

## 一、跑起来

克隆下来不需要 `npm install` —— **零运行时依赖、零构建步骤**，`node` 能跑就能用。

```bash
git clone https://github.com/phfb/ebbinghaus-memory.git
cd ebbinghaus-memory

node --test                          # 全部测试（217 个）
node tools/check-patch-yaml.mjs       # 校验 cordis.patch.yml
node tools/preview-injection.mjs      # 看看当前库渲染进上下文长什么样
```

> **Windows 上 `node` 常常不在 PATH 里**（DSH Desktop 自带一份）。用这个：
>
> ```powershell
> $node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe"
> & $node --test
> ```
>
> 找不到就搜一下 `Get-ChildItem $env:LOCALAPPDATA -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select -First 5`。

装了插件之后想验证「真能用」（测试全绿 ≠ 插件能加载），装到**临时 profile** 里跑一遍，
别动你自己的 `desktop`：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh eb-verify --from-default-profile headless --dump-config
& $dsh plugin --profile eb-verify add "link:<你的克隆目录>"
& $dsh --profile eb-verify "记住：我在做记忆插件"
```

日志里应该按顺序出现：`记忆库就绪` → `已注册注入段` → `开闸` → `固化开始` → `模型返回` → `记下 N 条`。
哪一行断了，问题就在那一行之后。

---

## 二、改代码之前

**先读 [`SPEC.md`](./SPEC.md)。** 它是唯一基准：冻结的签名、磁盘布局、注入格式、禁令清单。
里面每条禁令背后都有一个真实踩过的坑，不是风格偏好。

然后是 [`AGENTS.md`](./AGENTS.md) —— 那份是写给 AI 接手者的，人读同样有效：
24 条硬约束，每条都附了「这么干会怎么死」的具体现象。

几条最容易踩的，先摆在这儿：

| 别这么干 | 会怎么样 |
|---|---|
| 静态 `import` 任何 `@deepseek-ai/dsh-*` | 解析不到就整个插件加载失败 |
| 给配置加 `.volatile()` | `dataDir: ''` 被包成对象 → 记忆库写进 `[object Object]/` 目录，**全程无报错** |
| 把整个分区塞进注入 | 用户明确要求过「查找不是载入」；预算当场炸 |
| 用 `JSON.stringify` 整个库写一个文件 | 坏一次全丢；JSONL 坏一行只丢一条 |
| 拿 `stderr` 当日志出口 | headless 跑完直接退进程，缓冲区来不及刷 |
| 在自检里调模型 | 自检的目的就是省 token，调模型等于为了省钱花钱 |

完整清单在 `AGENTS.md`。改 `src/core/` 的任何东西之前，也顺手把 `test/` 里对应的测试看一遍 ——
那 217 个测试是这个项目真正的骨架。

---

## 三、提交

- 分支随便起名，PR 描述按模板写。
- 一个 PR 一件事。顺手重构和功能混在一起，review 的时候分不清哪个逻辑在动。
- 提交信息写「为什么」，不写「改了什么」——`git diff` 已经说了改了什么。
- **改了磁盘格式 / 注入格式 / 配置键 / 默认值，一定要在 PR 里标出来。** 这些一变，
  用户已有的库和另一端的 AstrBot 实现都会受影响，得单独处理。

---

## 四、绝对不要提交的东西

这个插件处理的是**别人的私人记忆**。仓库里出现一条真实记忆，就是一次泄露。

`.gitignore` 已经拦了这些，但你自己也看一眼：

```
*.jsonl              meta.json        settings.json      dedup-state.json
_archive/            _exports/        _backup-*/         [object Object]/
```

跑完导入 / 压力测试之后，`git status` 里不许出现它们。CI 里有一道检查专门守这条
（`lint-shape` job），混进来会直接红。

贴日志之前也顺手扫一遍 —— 虽然 `debugLog` 只打形状（条数 / token / 耗时）、
不打对话正文，但别赌。

---

## 五、报告问题

用 [Issue 模板](https://github.com/phfb/ebbinghaus-memory/issues/new/choose)。
最有用的是**日志断在哪一行**：

```
记忆库就绪 → 已注册注入段 → 开闸 → 固化开始 → 模型返回 → 记下 N 条
```

哪一行没出现，问题就在那一行之后。这个信息比「它不记事」有用一百倍。
