

<h1 align="center">Oling</h1>

<p align="center">
  <img src="public/oling-logo.png" alt="Oling logo" width="260" />
</p>

<p align="center">
  一款 macOS 悬浮 AI 秘书 —— 内置 Raycast 风格剪贴板管理、Xnip 风格截图标注、长截图拼接、智能回复、可钉住的浮动贴图，以及<strong>用户可完全自定义、横跨全部功能的 AI 命令</strong>。
</p>

<p align="center">
  完全本地运行，永久免费，数据不离开你的电脑。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="Platform: macOS" />
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/OpenAI--compatible-any_backend-412991?logo=openai&logoColor=white" alt="OpenAI-compatible" />
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/fengbird/thuki?color=brightgreen&label=latest" alt="Latest release" /></a>
</p>

---

## 快速安装

**Homebrew**（用 `brew upgrade` 自动跟随新版本）：

```bash
brew install --cask fengbird/tap/oling
```

**或直接下载 DMG**：

```bash
curl -L https://github.com/fengbird/thuki/releases/latest/download/Oling.dmg -o Oling.dmg
open Oling.dmg
```

或者到 [Releases 页面](../../releases/latest) 下载，把 App 拖进 Applications 即可。

> **Fork 说明** —— Oling fork 自 [Logan Nguyen](https://x.com/quiet_node) 的 [**quiet-node/Thuki**](https://github.com/quiet-node/Thuki)（原名 *Thuki*），在本仓库中更名为 Oling 并大幅扩展功能。继续沿用 [Apache License 2.0](LICENSE) 协议，所有上游版权声明完整保留。

## 目录

- [为什么是 Oling](#为什么是-oling)
- [🧠 自定义 AI 命令 —— 核心特色](#-自定义-ai-命令--核心特色)
- [功能一览](#功能一览)
  - [AI 秘书](#ai-秘书)
  - [效率工具](#效率工具)
  - [系统与基础设施](#系统与基础设施)
- [本 Fork 相较上游 Thuki 的增量](#本-fork-相较上游-thuki-的增量)
- [安装](#安装)
- [配置](#配置)
- [架构](#架构)
- [后续计划](#后续计划)
- [赞助支持](#赞助支持)
- [致谢与协议](#致谢与协议)

## 为什么是 Oling

大多数 AI 工具都要账号、API Key，或者按 Token 计费的订阅。Oling 不一样：

- **100% 免费的 AI 交互** —— 自带模型（本地或云端），永远没有按次计费
- **默认零信任** —— 无远程服务器、无云端后端、无分析、无埋点
- **可离线运行** —— 模型拉取完成后无需联网
- **数据归你所有** —— 对话与剪贴板历史都存在本地 SQLite；对话表按设计每次启动清空
- **随处可用** —— 双击 <kbd>⌃</kbd>，Oling 会出现在桌面、浏览器、终端，甚至全屏 App 之上

## 🧠 自定义 AI 命令 —— 核心特色

Oling 的斜杠命令是**一等公民、完全用户可编辑的能力**。定义一次 —— 在 Oling 触达你内容的每一个场景都生效：聊天输入框、任意剪贴板条目、任意 App 里选中的文字、截图带入聊天之后。

### 这个设计为什么存在：隐私优先的智能

Oling 读取的这些场景 —— **剪贴板、截图、其他 App 里选中的文字** —— 是你 Mac 上最敏感的一批数据。刚从密码管理器里复制的密码、一张合同草稿的截图、客户邮件的一段摘录、线上 SQL 查询出来的一行数据、准备发出去之前你正在打磨的回复。云 AI 工具（Raycast AI、ChatGPT 插件、Copilot、托管版 Claude）会把这些**全部送到第三方服务器**。

**Oling 反其道而行。** 智能跑在**本地**，数据永远不离开你的 Mac。一个本地小模型（Gemma 4 2B、Qwen 3 8B、Llama 3.2 3B —— 你自己挑）就足以胜任日常生产力真正需要的任务 —— 翻译、摘要、重排、改写、修语法、提取 —— 完全不联网。这类活**不需要最前沿的推理能力**，需要的是**贴近你数据的模型**。

> **核心论点：** 把 macOS 上那些本身"不带智能"的高敏感工作流 —— 剪贴板、截图、选区 —— 和一个本地小模型加上用户可编辑的命令配对。你 Mac 上每一段随手的文本都能获得一层智能，一个快捷键就能调用，而且永远不离开你的机器。

这就是为什么 Oling「一个命令，处处可用」的设计**真的安全到敢用**。没有本地模型，全局 AI 操作你的剪贴板和截图就是一场隐私灾难；配上本地模型，就是两全其美 —— **绝对隐私 + 一个快捷键的便捷**，而且往往也是**最合适的工具**（对单一用途、模式化的任务，小模型常常够用，甚至比把剪贴板发给前沿大模型更合适）。

### 完全由用户配置

- **编辑任意内置命令** —— 修改 `/translate`、`/rewrite`、`/tldr`、`/refine`、`/bullets`、`/todos`、`/think` 的触发词、描述、提示词模板
- **自定义新命令** —— 写一个触发词和带 `$INPUT` / `$LANG` 占位符的提示词模板就行，不需要改代码、不需要重启
- **禁用** 不用的命令，让命令面板保持清爽
- **即改即生效** —— 设置里改完，下一次调用就用新版提示词

### 同一条命令定义，横跨所有场景

| 场景 | 调用方式 |
| --- | --- |
| **聊天输入框** | 输入 `/your-command`，命令面板自动补全，回车发送 |
| **剪贴板面板** | 每条记录下方的 **AI Actions** 磁贴一键调用（在 设置 → Clipboard 里选哪些命令显示成磁贴） |
| **任意位置选中的文字** | 选中任意 App 里的文字，双击 <kbd>⌃</kbd>，输入 `/your-command` |
| **截图** | 标注完 → **Ask AI** 把图片带入聊天窗口 → 输入任意命令 |

### 你可能会想加的示例命令

```
/fix         修复 $INPUT 中所有的语法与拼写错误，不改变原意。
/en2cn       把 $INPUT 从英文翻译成中文，技术术语保持英文原样。
/commit      为以下改动写一条祈使句、一行、简洁的 git commit message：$INPUT
/explain     把 $INPUT 讲给一个初级开发者听，配一个简短的比喻。
/json        把 $INPUT 重新格式化为干净、紧凑的 JSON。
/sql         把需求描述 $INPUT 转成 PostgreSQL 的 SQL 查询语句。
```

> Oling 跑在**你自己的 OpenAI 兼容后端**上 —— 本地（Ollama、LM Studio、vLLM、llama.cpp）或你信任的任意云端服务商。本设计**鼓励本地**：只有在本地，隐私逻辑才是端到端闭环的。**无订阅，无按次计费。**

## 功能一览

### AI 秘书

- **双击 <kbd>⌃</kbd>** 从任意 App（含全屏）唤起
- **上下文引用** —— 在任意位置选中文字后唤起，通过 macOS 辅助功能 API 自动填入为引用
- **轻量对话** —— 默认临时（每次启动清空）
- **多模态输入** —— 可粘贴或拖拽图片；每条消息最多 10 张，单张最大 20 MB，HEIC 自动转换
- **流式响应 + 中途取消**（取消令牌）
- **推理 / 思考展示** —— `<think>…</think>` 与 OpenAI `reasoning_content` 拆到可折叠块
- **多模型支持** —— `OLING_SUPPORTED_AI_MODELS`（逗号分隔）配置列表，运行时切换
- **API 连接测试** —— 设置页一键验证后端可达并拉取可用模型列表
- **错误分类** —— `NotRunning` / `ModelNotFound` / `Other` 用不同颜色内联展示

### 效率工具

- **剪贴板历史工作区（<kbd>⌘⇧V</kbd>）** —— 按 置顶 / 今天 / 昨天 / 更早 分组，按类型（文本 / URL / 代码 / 图片 / 文件）过滤，支持全局搜索
  - **来源 App 图标** 从每个 App 的 `Info.plist` 抽出并本地缓存
  - **CodeMirror 6 预览与编辑** —— GitHub Dark、自动识别语言、编辑模式 Enter 正常换行
  - **纯文本粘贴（<kbd>⇧⏎</kbd>）** 一键去除富文本格式
  - **回写剪贴板** / **粘贴到当前 App**（合成 ⌘V，粘贴后自动恢复原剪贴板）
  - **置顶** 的条目不计入历史上限（可配置 10 – 10,000，默认 200）
  - **图片条目** —— 复制为 PNG / base64、预览、发给 AI、删除
  - **SHA-256 去重** 避免重复记录
- **截图 + 标注（<kbd>⌘⇧X</kbd>）** —— Xnip 风格跨显示器框选
  - **窗口快速选择** —— 与选区重叠的窗口一键直接选中
  - **Konva 画布工具** —— 画笔、文字、橡皮擦、撤销/重做、8 控点缩放 + 拖动
  - **工具栏操作** —— 复制、钉为贴图、Ask AI、OCR、关闭
  - **OCR** 使用专用提示词（可在设置中自定义）
  - **自动排除 Oling 自身窗口**（按 PID 过滤）
- **智能回复（<kbd>⌃⇧R</kbd>）** —— 对当前前台 App 截图，模型草拟回复，<kbd>Enter</kbd> 自动粘贴回该 App；约 700 ms 后恢复你的原剪贴板
- **长截图 Long Shot** —— 手动滚动捕获，适配聊天（微信、飞书、iMessage）、长邮件、长文章
  - **窗口感知** —— 直接捕获目标窗口并裁到你的选区
  - **自动识别固定头尾** —— 比较前两帧自动裁掉固定区域
  - **拼接算法** —— 在 80 px 重叠带上用 SAD（绝对差之和）匹配；200 帧安全上限
  - **非置焦 HUD** —— 捕获过程中不抢走目标 App 的焦点
  - **进入标注** —— 拼接完成后直接进入标注编辑器
- **浮动贴图 Pin** —— 把任意截图或剪贴板图片钉为独立的无边框窗口
  - 原生拖动、右键透明度滑块（0.2 – 1.0）、在标注器中编辑、删除
  - 可多开，每个独立 Pin 都有自己的 UUID

### 系统与基础设施

- **可配置全局快捷键** —— 下列每个快捷键都可以在 设置 → Shortcuts 重新绑定

  | 功能 | 默认 |
  | --- | --- |
  | 唤起悬浮窗 | 双击 <kbd>⌃</kbd> |
  | 截图 | <kbd>⌘⇧X</kbd> |
  | 剪贴板历史 | <kbd>⌘⇧V</kbd> |
  | 智能回复 | <kbd>⌃⇧R</kbd> |
  | 打开设置 | <kbd>⌘,</kbd> |
  | 发送 / 换行 | <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> |
  | 关闭 | <kbd>Esc</kbd> |
  | 命令面板 | <kbd>/</kbd> 或 <kbd>⌘K</kbd> |
  | 纯文本粘贴（剪贴板） | <kbd>⇧⏎</kbd> |

- **六个设置标签页**：AI Model · Prompts · Shortcuts · Commands · Clipboard · Storage
- **引导流程** 包含辅助功能 + 屏幕录制权限检测、权限回收识别、退出并重启辅助命令
- **崩溃报告** —— `std::panic::set_hook` 写结构化崩溃记录；`installGlobalErrorReporter` 转发 `window.onerror` + `unhandledrejection`；可在 设置 → Storage 浏览
- **滚动日志** —— `tauri-plugin-log`，2 MB 滚动切分，`KeepAll`
- **严格 CI 覆盖率** —— 前端（Vitest）+ 后端（cargo-llvm-cov）均强制 **100% 行覆盖率**
- **macOS 系统集成**
  - 通过 `tauri-nspanel` 做 NSPanel 悬浮 —— 可悬浮在全屏 Space 上且不抢焦点
  - `ActivationPolicy::Accessory` —— 无 Dock 图标
  - CGEventTap HID 级 + Default tap —— 焦点切换和 secure input 下依然存活
  - 多显示器感知，通过 CoreGraphics 计算布局
  - NSWindow 圆角与内部 UI 同步
  - 托盘菜单：打开 / 设置 / 退出
- **可选 Docker 沙箱** —— 强隔离本地推理（`cap_drop: ALL`、禁止提权、只读模型卷、仅绑定 localhost）

## 本 Fork 相较上游 Thuki 的增量

| | 上游 Thuki | Oling（本 Fork） |
| --- | :---: | :---: |
| 悬浮窗（双击 <kbd>⌃</kbd>） | ✅ | ✅ |
| 上下文引用选中文字 | ✅ | ✅ |
| 内置斜杠命令 | ✅（6 个） | ✅（7 个，全部可改） |
| **用户自定义斜杠命令** | ❌ | ✅ |
| **命令横跨 聊天 + 剪贴板 + 选区** | — | ✅ |
| 截图输入（基础 `/screen`） | ✅ | ✅（已替换） |
| **完整 Xnip 风格截图 + 标注 overlay** | ❌ | ✅ |
| **AI OCR** | ❌ | ✅ |
| **剪贴板历史工作区** | ❌ | ✅ |
| **来源 App 图标解析** | ❌ | ✅ |
| **代码片段 CodeMirror 预览 + 编辑** | ❌ | ✅ |
| **长截图（Long Shot）** | ❌ | ✅ |
| **智能回复**（自动粘贴回来源 App） | ❌ | ✅ |
| **浮动贴图 Pin** | ❌ | ✅ |
| **可配置全局快捷键** | ❌ | ✅ |
| **六标签页设置** | ❌ | ✅ |
| 引导流程 + 权限回收检测 | 部分 | ✅ |
| **崩溃报告 + 滚动日志** | ❌ | ✅ |
| OpenAI 兼容后端（任意厂商） | 面向 Ollama | ✅（任意） |
| Docker 沙箱 | ✅ | ✅ |
| Apache 2.0 | ✅ | ✅（完整保留） |

## 安装

### 下载（推荐）

1. 从 [最新 Release](../../releases/latest) 下载 `Oling.dmg`
2. 打开 DMG，把 **Oling** 拖进 **Applications**
3. 弹出 DMG
4. 从 Applications 里打开 Oling —— 常驻菜单栏

因为 Oling 使用 Developer ID 证书签名并已通过 Apple 公证，macOS 不会拦截，也不需要 `xattr` 之类的绕过命令。

> **首次启动：** macOS 会请求 **辅助功能**（双击 Control 全局快捷键）和 **屏幕录制**（截图、智能回复、长截图）两项权限，授予一次即长期有效。后续如果你撤销了任一权限，Oling 会自动检测并再次进入引导流程。

### 从源码构建

**前置条件：** [Bun](https://bun.sh)、[Rust](https://rustup.rs)，以及可选的 [Docker](https://www.docker.com/get-started)。

```bash
git clone https://github.com/fengbird/thuki.git
cd thuki
bun install

bun run dev            # 开发模式（HMR）
bun run build:all      # 生产构建 → src-tauri/target/release/bundle/
```

完整开发环境说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 配置 AI 后端

Oling 使用 OpenAI `/chat/completions` SSE 协议，任何兼容服务都能用。

<details>
<summary><strong>方案 A：本地 Ollama（推荐）</strong></summary>

```bash
brew install ollama
ollama pull gemma4:e2b
export OLING_API_BASE_URL=http://127.0.0.1:11434/v1
export OLING_SUPPORTED_AI_MODELS=gemma4:e2b
```

也可以在 设置 → AI Model 里配置，并点击 **Test Connection** 验证。

</details>

<details>
<summary><strong>方案 B：LM Studio / vLLM / llama.cpp / 云端服务商</strong></summary>

把 `OLING_API_BASE_URL` 设为服务的 Base URL（包含 `/v1`），需要鉴权时再配 `OLING_API_KEY`。任何 OpenAI 兼容接口都能用。

默认值：`http://127.0.0.1:1234/v1`，API Key `lm-studio`（LM Studio 的惯例）。

</details>

<details>
<summary><strong>方案 C：Docker 沙箱（最强隔离）</strong></summary>

```bash
bun run sandbox:start
# ... 用完后：
bun run sandbox:stop   # 会清除数据卷
```

完整架构与安全设计见 [`sandbox/README.md`](sandbox/README.md)。

</details>

## 配置

运行时配置参考：[docs/configurations.md](docs/configurations.md) · 斜杠命令参考：[docs/commands.md](docs/commands.md)。

所有设置遵循 **优先级回落**：SQLite → 环境变量 → 内置默认值。改动即时生效，无需重启。

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `OLING_API_BASE_URL` | OpenAI 兼容 Base URL | `http://127.0.0.1:1234/v1` |
| `OLING_API_KEY` | Bearer Token | `lm-studio` |
| `OLING_SUPPORTED_AI_MODELS` | 逗号分隔的模型列表 | 单个内置 |
| `OLING_SYSTEM_PROMPT` | 自定义系统提示词 | 内置 |
| `OLING_REPLY_PROMPT` | 自定义智能回复提示词 | 内置 |
| `OLING_OCR_PROMPT` | 自定义 OCR 提示词 | 内置 |

## 架构

<details>
<summary>点击展开</summary>

Oling 是一个 **Tauri v2** 应用：Rust 后端 + React 19 + TypeScript 5.8 前端，Tailwind CSS 4，`rusqlite` 管理 SQLite，CodeMirror 6 处理代码，Konva 画标注，Streamdown + Shiki 渲染 Markdown。

### 进程架构

- **前端** 跑在受限 IPC 的系统 WebView
- **后端** 持有 NSPanel、事件 tap、剪贴板监控、截图捕获和设置存储
- **流式** 通过 Tauri Channel API：Rust 端发送强类型 `StreamChunk` 枚举（`Token` / `ThinkingToken` / `Done` / `Cancelled` / `Error`），前端 Hook 累加为 React 状态

### 窗口

- **主悬浮窗** —— 通过 Framer Motion 在 ask-bar 与 chat 两种形态间变形
- **剪贴板面板** —— 920×640 NSPanel，NSWindow 圆角
- **截图 overlay** —— 全屏 Konva 画布，支持窗口快速选择
- **回复草稿** —— 紧凑的非置焦面板
- **浮动贴图 Pin** —— 无边框、可拖动、半透明窗口（每 Pin 一个）
- **长截图 HUD** —— 非置焦捕获进度
- **设置** —— 标准窗口，六标签页

### 存储

`<app_data_dir>/` 下：
- `oling.db` —— 设置、剪贴板历史、引导状态（对话表每次启动清空）
- `images/` —— 保存的聊天附件（启动时清理孤儿）
- `app-icons/` —— 缓存的 128 px 来源 App 图标
- `crashes/` —— Panic 与前端错误报告
- `logs/oling.log` —— 滚动日志

### 快捷键监听（`activator.rs`）

Core Graphics Event Tap 配置为 `CGEventTapLocation::HID` + `CGEventTapOptions::Default`。在 macOS 15 Sequoia 上 **两项都不可少** —— Session 级 tap 在焦点切换后会停止派发事件，`ListenOnly` 则在 secure input 下被系统关闭。详细说明见 `CLAUDE.md`。

</details>

## 后续计划

- 运行中切换模型，无需重新构建
- 联网搜索与 MCP 工具集成
- 语音输入、文件 / 文档拖拽、指定区域截图
- 针对特定场景的更多内置斜杠命令
- 跨设备同步自定义命令（可选）

有想要的功能？欢迎 [提 Issue](../../issues)。

## 赞助支持

Oling 免费开源。如果它帮你节省了时间，欢迎赞助开发：

- 🌏 **GitHub Sponsors** —— [github.com/sponsors/fengbird](https://github.com/sponsors/fengbird)
- 🇨🇳 **爱发电**（微信 / 支付宝）—— 即将开通

你的赞助将用于持续开发、维持让公证构建成为可能的 Apple Developer Program 年费，以及域名 / CDN 成本。赞助者（自愿公开）会出现在 About 对话框中。

## 致谢与协议

- **上游：** [**quiet-node/Thuki**](https://github.com/quiet-node/Thuki)，作者 [Logan Nguyen](https://x.com/quiet_node) —— 原始悬浮交互、AI 秘书核心以及整体项目设计（上游原名 *Thuki*）
- **本 Fork** 新增：剪贴板工作区、Xnip 风格截图 overlay、长截图、智能回复、浮动贴图、可配置快捷键、自定义斜杠命令、引导流程、崩溃报告、滚动日志，以及大量 UI 打磨
- **参与贡献：** 见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [Code of Conduct](CODE_OF_CONDUCT.md)
- **安全问题反馈：** 请使用 [GitHub Security Advisories](../../security/advisories/new)

Copyright 2026 Logan Nguyen and contributors. 本项目以 [Apache License, Version 2.0](LICENSE) 发布，所有上游版权声明均完整保留，完整协议文本见 `LICENSE`。
