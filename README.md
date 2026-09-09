# thesis-review-dsh-plugin

> **实验项目 / Experimental.** DeepSeek Harness 处于 **developer preview**，官方明确说明
> **“THERE WILL BE COMPATIBILITY-BREAKING CHANGES.”** 本插件按当前官方插件 API 编写，
> 可能随 DSH 的 breaking changes 调整。

一个 **DeepSeek Harness (DSH) 插件**，把现有正式项目
[`thesis-review-agent`](https://github.com/Dionysianspirit/thesis-review-agent) 的
Python Worker 能力（Word 处理、历史问题库、格式 / 语言规则、字符串召回、quote 校验、
Evidence Gate、Word 批注 / 修订输出）作为一组 Harness tool 复用。

**本仓库不包含论文处理核心逻辑。** 它只是一个 adapter：把 Harness 的 tool call 翻译成
thesis-review-agent Python Worker 的 op，再把 Worker 的 JSON 结果返回给 Harness。

**删除本仓库不会影响 `thesis-review-agent` 桌面版。** 两个仓库完全独立，本仓库不 vendor、
不复制、不修改主项目的任何代码。

---

## 这是什么

`thesis-review-agent` 的 V0.4 用 **Pi** 作为 Agent runtime：外层是有边界的 workflow，
内层是 Pi 驱动的 bounded agent，写入 Word 前由 Python 做 Evidence Gate 硬校验。

本仓库要回答一个**不同的问题**：

> 现有的论文领域能力，能否被 **DeepSeek Harness** 作为一个独立插件复用？

它**不是**要把论文初筛助手迁移到 DSH，也**不是**要证明 DSH 比 Pi 更强，更**不是**重新开发
一次论文初筛助手。它要验证的是：**论文领域能力和 Agent Runtime 是可解耦的。**

第一版只做一个真正的 Agent 场景：**Claim ↔ Evidence 一致性核对**（关键主张是否真的被实验 /
数据支持）。

---

## 它与 thesis-review-agent 的关系

```text
DeepSeek Harness (DSH)
      │  Agent loop / 模型调用 / tool selection / 多步导航 / 上下文管理 / 停止判断
      ▼
thesis-review-dsh-plugin        ← 本仓库（只有 adapter，TypeScript）
      │  Harness tool call → Worker op
      ▼
Adapter / Worker Client         ← src/worker-client.ts（stdio / TCP，行分隔 JSON）
      │
      ▼
thesis-review-agent Python Worker   ← 主项目（另一个仓库，不被修改）
      │
      ▼
Word / SQLite 历史库 / 格式语言规则 / 字符串召回 / quote 校验 / Evidence Gate / Word 导出
```

职责划分：

| DeepSeek Harness 负责 | thesis-review-agent 负责（本插件复用，不重写） |
| --- | --- |
| Agent loop、模型调用 | Word DOCX 读取与写回 |
| tool selection | SQLite 历史问题库 |
| 多步导航、上下文管理、停止判断 | 格式规则、语言规则 |
| | 字符串召回、quote 校验 |
| | Evidence Gate、finding 写入、Word 导出 |

本插件**只做**：启动 Worker、建立通信、把 tool call 转成 Worker op、返回 JSON、session 结束时
关闭 Worker。

---

## 为什么单独做一个仓库

- 主项目是面向老师的**正式产品**（Windows GUI + 打包 exe + Pi runtime），不能被实验性代码污染。
- 本实验的目标是**解耦验证**，不是产品功能，生命周期和稳定性要求完全不同。
- 分离后，删掉本仓库，主项目照常工作；这也是本实验最重要的验收标准。

---

## 安装

需要本机已具备：

- **Node.js 22.19+ 或 24+**（与 DeepSeek Harness 官方要求一致；DSH 在 Node 20 上会因 `Promise.withResolvers` / `node:zlib.createZstdDecompress` 缺失而无法启动，本插件也随之无法加载）
- **一个本地的 [`thesis-review-agent`](https://github.com/Dionysianspirit/thesis-review-agent) 检出**，
  并已按主项目 README 完成依赖安装，特别是：
  ```bash
  cd thesis-review-agent
  python -m pip install -r requirements.txt
  python scripts/fetch_docxengine.py   # Worker 打开 / 写回 DOCX 依赖它
  ```
- **DSH**：`npx @deepseek-ai/dsh web` 或源码运行，见 DSH 官方 README。

安装本插件（DSH profile 方式，推荐）：

```bash
# 从 GitHub 安装（pnpm 会运行 prepare 构建 lib/）
dsh plugin --profile thesis add github:Dionysianspirit/thesis-review-dsh-plugin

# 或从本地检出安装
dsh plugin --profile thesis add ./thesis-review-dsh-plugin
```

> **git 安装的构建许可**：pnpm ≥ 10 默认拒绝运行 git 依赖的 `prepare` 脚本。首次 `add` 若失败，
> 按 `dsh` 提示把包名加入 profile 的 `pnpm-workspace.yaml` 后重试：
> ```yaml
> allowBuilds:
>   thesis-review-dsh-plugin: true
> ```
> 这等于允许该包在安装时于你机器上执行代码，请只对你信任的来源开启，并建议用 commit 锁定：
> `github:Dionysianspirit/thesis-review-dsh-plugin#<sha>`。

---

## 如何指定 thesis-review-agent 路径

主项目路径通过 DSH 配置指定，**不写死在代码里**。在 profile 的 `cordis.patch.yml`
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）覆盖本插件的 `thesisReviewAgentPath`：

```yaml
- insert:
    - id: thesis-review
      name: thesis-review-dsh-plugin
      config:
        thesisReviewAgentPath: 'C:/projects/thesis-review-agent'
        python: 'python'          # Windows 上通常是 python；Linux/macOS 用 python3
        teacherId: 'teacher-a'    # 必须与主项目历史库的 teacher_id 一致
        studentId: 'zhou'         # 必须与主项目历史库的 student_id 一致
        transport: 'stdio'        # 或 'tcp'
        enablePreset: true        # 注册 claim-evidence 系统提示片段
        enableHistory: false      # 第二阶段（历史复犯）默认关闭
```

也可以用环境变量 `THESIS_REVIEW_AGENT_PATH` 指定路径（测试与本地开发用）。

> **安全边界**：Worker 的 `--home`（SQLite 历史库所在目录）**永远不会**指向主项目检出目录，
> 否则运行插件会把 `thesis-review.sqlite` 写进主仓库。未显式配置时，插件使用一个临时目录；
> 若把 `workerHome` 指到主仓库内部，插件会以 `unsafe_home` 直接拒绝启动。

`thesisReviewAgentPath` 为空时，插件**失败关闭**：不注册任何 tool，只打印一条 warning。

---

## 如何加载插件 / 运行 demo

加载后，在 DSH 会话里，模型即可看到这些 tool（见下表）。插件同时注册一个 claim-evidence
系统提示片段（`enablePreset`），告诉模型**只做**主张-证据核对、**不**审格式、**不**改正文、
证据不足就放弃、最多 3 条 finding、最后 commit。

demo 脚本会用主项目自带的 `overclaim_draft` 演示稿跑一遍 **scripted**（非模型）工具路径：

```bash
export THESIS_REVIEW_AGENT_PATH=/path/to/thesis-review-agent
node examples/demo.mjs
```

它演示 open → outline → read_section → find_text → record → commit 的完整链路，
并打印 Worker 生成的 `findings.json`。**这是一个 plumbing demo，不是模型能力验证。**

---

## 技术部分

### 注册的 tool

第一版只暴露主项目 Worker 已成熟、且属于 Claim-Evidence 场景的 op：

| Harness tool | → Worker op | 作用 |
| --- | --- | --- |
| `thesis_open` | `open_draft` | 打开 DOCX，返回基本信息（段落数），**不返回全文** |
| `thesis_outline` | `list_outline` | 列出标题段落，供 Agent 导航 |
| `thesis_read_section` | `read_section` | 从某段读到下一标题，受 Worker 段落 / 字符上限 |
| `thesis_read_paragraphs` | `read_paragraphs` | 从某段起读有限段落，受 Worker 上限 |
| `thesis_find_text` | `find_text` | 检索原文，返回少量命中及上下文 |
| `thesis_record_argument` | `record_argument_finding` | 记录主张-证据 finding（受 Evidence Gate 校验） |
| `thesis_commit` | `commit_review` | 导出 `reviewed.docx` + `findings.json` |

可选第二阶段（`enableHistory: true`，默认关闭）：

| Harness tool | → Worker op | 作用 |
| --- | --- | --- |
| `thesis_history_candidates` | `get_history_candidates` | 只返回**字符串召回**候选，不写 Word |
| `thesis_confirm_history` | `confirm_history_finding` | Agent 判断为同一未解决问题后，由 Python 校验并写入 |

**所有单次段落限制、字符数限制、导航 budget、finding 上限、quote 校验，全部由主项目 Python
Worker 强制执行，本插件不绕过、不放宽、不重复实现。**

### 如何连接主项目 Python Worker

`src/worker-client.ts` 复用主项目 Worker 现有的协议：

- **stdio**（默认）：spawn `python -m thesis_review.worker ...`，用行分隔 JSON
  `{ id, op, params }` → `{ id, result } | { id, error }` 通信。
- **tcp**：与主项目 `agent/review.mjs` 一致，Worker 写 portfile，插件连接 socket 后走同一协议。

插件在一个会话内**只启动一个** Worker（它持有已打开文档、导航预算、已记录 finding 等状态），
所有 tool 共享它；tool call 被串行化，避免在同一 stdio/TCP 流上交错两个 op；插件卸载
（session 结束 / HMR 替换）时通过 `ctx.effect` disposer 关闭 Worker。

Worker 的 error code（如 `quote_not_in_draft`、`argument_limit`、`repeat_wording`、
`nav_budget`）被**原样**透传给模型，adapter 不做任何掩盖或改写。

### 目录结构

```text
thesis-review-dsh-plugin/
├─ src/
│  ├─ index.ts            # 包入口：重导出 name / inject / apply / Config
│  ├─ plugin.ts           # apply(ctx, config)：失败关闭 + 注册 tools + preset
│  ├─ config.ts           # Schemastery Config schema 与默认值
│  ├─ worker-client.ts    # 启动 Worker、stdio/TCP、行分隔 JSON、关闭
│  ├─ session.ts          # 单 Worker 会话，串行化 call，dispose
│  ├─ preset.ts           # claim-evidence 系统提示片段（TS 常量）
│  └─ tools/
│     ├─ common.ts        # defineWorkerTool：tool → op 的 JSON 直通工厂
│     ├─ document.ts      # thesis_open + 导航 tools
│     ├─ argument.ts      # thesis_record_argument + thesis_commit
│     └─ history.ts       # 可选第二阶段 tools
├─ presets/
│  └─ claim-evidence.md   # 人类可读 preset（与 src/preset.ts 保持一致，测试校验）
├─ tests/                 # 见下
├─ examples/
│  ├─ README.md
│  └─ demo.mjs            # scripted plumbing demo
├─ cordis.patch.yml       # DSH bundle patch（按包名插入插件行）
├─ package.json           # 含 dsh.bundle manifest
├─ tsconfig.json
├─ vitest.config.ts
├─ README.md
├─ LICENSE                # MIT
└─ .gitignore
```

### DSH 插件规范依据

本插件按 DSH 官方 developer preview 文档编写（`deepseek-ai/deepseek-harness`，
`docs/user/develop/basic/*`、`docs/cookbook/adding-a-tool.md`、`docs/cookbook/extension-cookbook.md`）：

- 插件是一个导出 `apply(ctx, config)` 的 TypeScript 模块，配合 `name` / `inject` /
  `Config`（Schemastery schema）。
- tool 通过 `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`
  注册；schema 自动进入 system-prompt 组装；`execute` 返回 canonical JSON 值。
- 打包为 **bundle**：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 按包名插入插件行；
  用 `dsh plugin --profile <name> add ...` 安装。
- preset 通过 `ctx.systemPrompt.section({ name, order, text })` 注册（`dsh-system-prompt` 为可选 peer）。

---

## 测试

```bash
export THESIS_REVIEW_AGENT_PATH=/path/to/thesis-review-agent
npm install
npm run typecheck
npm test
```

测试分层（**plumbing ≠ 真实模型能力验证**，两者严格区分）：

| 测试 | 类型 | 说明 |
| --- | --- | --- |
| `plugin-smoke` | plumbing | 插件导出 DSH 契约；`apply` 注册 7 个 tool；空路径失败关闭；注册 disposer；Config 校验默认值 |
| `worker-client` | **integration（真实 Worker）** | 真实启动主项目 Worker（stdio + tcp），收发 JSON，原样透传 error code，干净关闭 |
| `tool-mapping` | **integration（真实 Worker）** | `thesis_open`/`thesis_outline`/`thesis_read_section`/`thesis_find_text` 打到真实 Worker，验证映射与 Worker 侧边界 |
| `evidence-gate` | **integration（真实 Worker）** | 真实 quote 被接受；编造 quote 被拒（`quote_not_in_draft`）；「再次」被拒；3 条上限；commit 产物；**证据充分时不写 finding** |
| `agent-loop-faux` | plumbing（scripted） | 用**硬编码**工具路径跑通 open→…→commit；**明确不是模型能力验证** |
| `preset` | unit | `src/preset.ts` 与 `presets/claim-evidence.md` 字节一致；声明边界；不写死导航路径 |

当 `THESIS_REVIEW_AGENT_PATH` / Python / `.vendor/docxengine` 缺失时，integration 测试**跳过而非失败**
（这些是主项目的环境前提，本仓库不伪造）。

> **没有任何测试调用真实 DeepSeek 模型。** `agent-loop-faux` 里的“agent”是我们写死的调用序列，
> 它证明的是链路能跑通，**不**证明模型能自主决定去哪读、是否找反证、何时放弃 finding。
> 后者才是本实验真正的研究问题，需要配置真实 API Key 后独立评估。

---

## 隐私与数据

- 本仓库**不提交**：API Key、`.env`、私有 DOCX、教师真实批注、学生真实论文、本地绝对路径。
- 测试用的演示稿由主项目自带的 `thesis_review.fixtures` 生成（模拟 / 脱敏内容）。
- 真实论文请只在获得授权、且理解模型调用会把必要文本发送给你配置的模型服务商的前提下处理。

---

## 已知限制

- DSH 处于 developer preview，插件 API 可能 breaking change。
- 第一版只验证 Claim-Evidence 一个场景，未覆盖主项目的全部论证类型 / 规则 / 历史能力。
- 历史召回仍只是**字符串候选**（由主项目负责），本插件**不做**语义召回，也不应被宣传为“语义历史搜索”。
- 未在真实 DeepSeek 模型上做过端到端审稿评估（无 API Key）。
- 未在真实学生论文上运行过。

---

## License

MIT — 见 [LICENSE](LICENSE)。

本仓库为独立实验项目，与 `thesis-review-agent` 无代码耦合；主项目保留其自身许可证与第三方声明。
