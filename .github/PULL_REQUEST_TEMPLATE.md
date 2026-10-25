## 这个 PR 干了什么

<!-- 一句话。别写成 changelog，写「为什么」。 -->

## 动了哪一层

- [ ] `src/core/`（纯函数：分区 / 压缩 / 检索 / 渲染 / 磁盘）
- [ ] `src/host/`（编排：事件钩子 / 模型调用 / 注入 / 工具 / HTTP）
- [ ] `src/client/`（侧栏面板）
- [ ] `tools/`（迁移、校验、导入导出）
- [ ] 文档（README / SPEC / AGENTS / CHANGELOG）
- [ ] 仓库工程（CI、模板、.gitignore）

## 自查清单

- [ ] `node --test` 全绿（改了 `src/core` 的话，对应的 `test/*.test.mjs` 也补了）
- [ ] `node tools/check-patch-yaml.mjs` 全绿（改了 `cordis.patch.yml` 或 `CONFIG_SPEC` 的话）
- [ ] 没有引入任何 `dependencies` / `devDependencies`（零运行时依赖是硬约束）
- [ ] `src/` 里没有静态 `import ... from '@deepseek-ai/dsh-*'`
- [ ] **没有把记忆库数据带进来**（`*.jsonl`、`meta.json`、`settings.json`、`_archive/`、`[object Object]/`）
- [ ] 改的是「记得像人」，不是「存得像数据库」

## 破坏性变更？

<!-- 磁盘格式、注入格式、配置键、默认值 —— 这些一变，用户已有的库和另一端的 AstrBot 插件都会受影响。 -->

- [ ] 没有
- [ ] 有，说明：

## 补充

<!-- 截图、日志形状、你实测的那个 case。 -->
