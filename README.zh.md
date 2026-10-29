# dsh-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的长期记忆与自进化技能插件。

`dsh-memory` 是一个零依赖的 Cordis Host 插件，为 DSH profile 补上发行版没有的四件事：

- **自动捕获**：用户提问与助手回复按事件写入本地、可直接查看的记忆库，同一事件只写一次；
- **自动召回**：每一步开始前，把与当前请求相关的记忆包装成 `<system-reminder>` 注入上下文；
- **记忆工具**：`memory_save`、`memory_search`、`memory_forget`，让模型显式读写记忆；
- **技能进化**：`memory_distill_skill` 把验证过的流程写成 `SKILL.md`，落到用户技能根目录，之后每个会话都能被 harness 发现并加载。

全部数据留在本机：记忆是 `$DSH_HOME/memory` 下的 JSONL，技能是 `$DSH_HOME/skills`（或 `$DSH_AGENTS_HOME/skills`）。无网络请求、无 embedding 服务、无原生模块。

## 为什么做这个

DSH 刻意不自带记忆插件。它提供的是原语：`AGENTS.md` 指令加载、会监视文件系统的技能注册表、带热重载的插件系统——但没有把「这个会话发生过什么」变成「下一个会话知道什么」的闭环。

Hermes 生态里的记忆插件（例如 [MemOS 本地插件](https://memos-docs.openmem.net/cn/openclaw/hermes_local_plugin/)）用 LLM + embedding + SQLite 做这个闭环。本插件用更小的体积做同一件事：

| Hermes / MemOS 本地插件 | dsh-memory |
| --- | --- |
| 全量对话捕获、分片、向量化入库 | 按轮次捕获进 append-only JSONL，不做向量化 |
| 自动召回注入 system 上下文 | 自动召回，作为一条可回放的 `user` 消息在第 1 步注入 |
| 混合检索（FTS5 + 向量、RRF、MMR、时间衰减） | BM25 风格词法检索 + 查询覆盖率 + 时间半衰期 |
| `memory_search` / `task_summary` / `skill_get` | `memory_search` / `memory_forget` / `memory_distill_skill` |
| 任务总结流水线 | 不做；上下文压缩由 DSH 自带的 `compaction` 负责 |
| 技能自动进化（生成 + 升级） | 模型驱动的蒸馏，产出真正的 `SKILL.md`，由 harness 原生发现 |
| SQLite + 桥接守护进程 + 可视化 | 纯文件，任何编辑器都能读 |

取舍是明确的：没有语义检索、没有后台摘要，换来零依赖、零守护进程、可 `git diff` 的数据格式，以及能装进任何 DSH profile。

## 安装

要求：带 `@deepseek-ai/dsh-base` 的 DSH（`web`、`headless`、`tui` 等随发行版 profile 均可）、Node.js ≥ 22。

### 插件管理器（推荐）

在 DSH Web 界面的 **插件 → 安装组合包** 里指向本目录；或在创造模式（preset `cordis`）的会话里执行：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

发布到 npm 后，用包名 + 版本作为 target 即可。

### CLI

```bash
dsh plugin --profile <profile> add file:<本仓库绝对路径>
```

`desktop` profile 由 Electron 应用独占，请改用插件页或 `plugin_manager`。`dsh plugin` 会把参数转发给 pnpm，因此 `pnpm` 必须在 `PATH` 上；`file:` 依赖是复制安装，改完 checkout 后需要重新安装。

### 手动安装（开发用）

```bash
node scripts/dev-install.mjs --profile memdev --debug \
  --memory-root  "$PWD/.e2e/memory" \
  --skills-root  "$PWD/.e2e/agents-home/skills"
```

它会把本包复制到 `<DSH_HOME>/profiles/memdev/node_modules/dsh-memory` 并写入 loader 行；`--uninstall` 移除。

### 启用

安装组合包会向 profile patch 插入：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        maxRecallItems: 4
        recallMinScore: 0.22
```

开启 HMR 时立即挂载，否则重启 profile。

## 配置

全部可选；激活时校验，每处修正都会记录。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `memoryRoot` | `$DSH_HOME/memory` | 记忆库根目录。 |
| `skillsRoot` | `$DSH_HOME/skills` | 蒸馏出的 `SKILL.md` 落盘目录；设为 `$DSH_AGENTS_HOME/skills` 可与其他 agent 工具共享技能。 |
| `autoCapture` | `true` | 自动捕获对话轮次。 |
| `captureAssistant` | `true` | 同时捕获上一轮的助手回复。 |
| `minCaptureChars` | `24` | 短于此长度的消息不自动捕获。 |
| `maxCaptureChars` | `4000` | 自动捕获的截断长度。 |
| `maxRecallItems` | `4` | 每次召回注入的条数；`0` 关闭召回。 |
| `recallMinScore` | `0.22` | 注入所需的最低相关度（0..1）。 |
| `recallMaxChars` | `2000` | 整个注入块的字数预算。 |
| `halfLifeDays` | `30` | 时间衰减半衰期；`0` 关闭时间权重。 |
| `includeGlobalScope` | `true` | 召回包含 `scope: 'global'` 的记忆。 |
| `recallOn` | `first-step` | `first-step` 或 `every-step`。 |
| `debug` | `false` | 写 `<memoryRoot>/debug.log` 诊断日志。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `memory_save` | 存一条可长期复用的信息：偏好、决策及理由、环境事实、教训。跨项目偏好用 `scope: 'global'`。 |
| `memory_search` | 在工作区与全局命名空间中按相关度检索。 |
| `memory_forget` | 按 id 删除记忆——优于再写一条互相矛盾的新记忆。 |
| `memory_distill_skill` | 把验证过的流程写成 `SKILL.md`，并记录来源记忆 id。 |

工具描述本身携带使用策略，所以会话不需要额外的提示词注入就知道何时保存、何时检索。

## 工作原理

```text
agent/pre-step（第 1 步）
  ├─ 捕获  本轮的用户消息（来自 pre-step 决策的待进入批次）
  │        上一轮的助手消息（来自会话日志，按 seq 去重）
  ├─ 召回  query = 最新的用户文本
  │        rank(工作区 ∪ 全局) → 过滤本轮捕获 → 渲染注入块
  └─ 注入  追加一条 source.kind 为 `dsh-memory` 的 `user` 消息
```

几个关键设计：

- **会话日志仍是唯一真源。** 召回是一条普通 `user` 消息，因此可回放、可压缩、可随会话恢复；记忆库只是派生索引，不是第二份日志。
- **捕获有两重幂等。** 事件序号防止恢复会话后重复捕获；归一化文本去重防止重复提问产生副本。
- **召回不回显当前轮。** 本轮刚捕获的记忆会被过滤掉——它只是重复模型已经拥有的内容。
- **除 Node 内置模块外零 import。** Host 组合包必须在没有依赖树的情况下加载，因此 schema 手写并在原地校验。
- **蒸馏产物就是普通技能包。** 写入被监视的技能根，由 `@deepseek-ai/dsh-skill-filesystem` 解析，下个会话出现在目录里——不需要注册表 API，不需要重启。

### 数据布局

```text
$DSH_HOME/memory/
  <workspace-key>/memories.jsonl     # sha256(cwd)[0:16]
  global/memories.jsonl              # 跨项目记忆
  debug.log                          # 仅 debug: true
$DSH_HOME/skills/<name>/SKILL.md     # 蒸馏出的技能
```

每行一个 JSON 对象：

```json
{"id":"mem_mvtaup5t_c19e0b","text":"...","kind":"note","tags":["build"],"importance":1,
 "scope":"workspace","workspace":"4ae8d930ea1f76ea","createdAt":1792395281000,
 "sessionId":"session-…","seq":12,"turn":1,"source":"auto-capture"}
```

损坏的行会被跳过并告警，删除通过临时文件原子重写。

## 验证

```bash
node --test                      # 62 个单元测试：检索、存储、渲染、配置
node scripts/e2e.mjs --profile memdev   # 4 个真实 headless 轮次，跑在 mock provider 上
```

离线端到端检查用 `scripts/mock-provider.mjs`（Anthropic Messages 协议的 mock）驱动真实的 harness 轮次，断言只基于磁盘产物：

- **A** `memory_save` 走真实工具链路，记忆落盘；
- **B** 之后的轮次在召回块里收到这条事实；
- **C** `memory_distill_skill` 写出合法的 `SKILL.md`；
- **D** harness 在下一个会话的技能目录里列出该技能。

同一套检查在 `npm pack` 出的 tarball 上（`dsh plugin add file:<tgz>`，即注册表安装走的路径）也全部通过。

不需要 API key；mock provider 会记录每个请求体，断言针对模型真正收到的内容。

## 已知限制

- **只有词法检索。** BM25 风格打分对标识符、路径、中文 bigram 效果好，但只有换一种说法才能匹配上的内容（纯语义相似）会漏。
- **没有后台摘要。** 记忆就是对话轮次与显式笔记，没有任务总结流水线；上下文压缩由 DSH 的 `compaction` 负责。
- **捕获发生在每轮第 1 步。** 在第 1 步就被中断的轮次可能只留下用户消息而没有回复；这符合事实，但偶尔会有噪音。
- **subagent 的会话也会被捕获。** 子任务跑同一个 profile，因此它们的轮次进入同一个工作区命名空间；不需要时关掉 utoCapture。
- **每个文件一个写者。** 多个 harness 进程写同一命名空间时追加可能交错，但每行用一次 `appendFileSync` 写入，行本身不会被截断；删除通过临时文件重写。
- **技能是写出来的，不是策展出来的。** 插件只校验命名与 frontmatter，「这条流程值不值得留」由模型判断。
- **没有可视化界面。** 数据就是 JSONL；做 UI 会是另一个插件包。

## 路线图

- 在同一个存储接口后面接可选的 embedding 后端。
- `memory_stats` 工具，以及让被取代的旧记忆过期压缩的钩子。
- Web 端记忆列表 / 搜索 / 删除页面。

## 数据与隐私

插件会把对话文本存在本机，[SECURITY.md](SECURITY.md) 说明具体写入什么、存在哪里、哪些内容会进入模型请求，以及怎么删除。

## 许可证

MIT，见 [LICENSE](LICENSE)。
