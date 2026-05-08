

<h1 align="center">Oling</h1>

<p align="center">
  <img src="public/oling-logo.png" alt="Oling logo" width="260" />
</p>

<p align="center">
  A floating AI secretary for macOS — with a Raycast-style clipboard manager, Xnip-style screenshot & annotation, scrolling screenshot, smart reply, pinnable image stickers, and <strong>fully user-customizable AI commands that span every feature</strong>.
</p>

<p align="center">
  Fully local. Completely free. Zero data ever leaves your machine.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="Platform: macOS" />
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/OpenAI--compatible-any_backend-412991?logo=openai&logoColor=white" alt="OpenAI-compatible" />
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/fengbird/thuki?color=brightgreen&label=latest" alt="Latest release" /></a>
</p>

---

## Quick Install

**Homebrew** (auto-updates on `brew upgrade`):

```bash
brew install --cask fengbird/tap/oling
```

**Or download the DMG directly**:

```bash
curl -L https://github.com/fengbird/thuki/releases/latest/download/Oling.dmg -o Oling.dmg
open Oling.dmg
```

Or [download from the Releases page](../../releases/latest) and drag the app into Applications.

> **Fork notice** — Oling is a fork of [**quiet-node/Thuki**](https://github.com/quiet-node/Thuki) by [Logan Nguyen](https://x.com/quiet_node) (originally released as *Thuki*), renamed and substantially extended in this repo. Distributed under the same [Apache License 2.0](LICENSE); all upstream copyright notices are preserved.

## Table of Contents

- [Why Oling](#why-oling)
- [🧠 Custom AI Commands — the standout feature](#-custom-ai-commands--the-standout-feature)
- [Features](#features)
  - [AI Secretary](#ai-secretary)
  - [Workflow Tools](#workflow-tools)
  - [System & Infrastructure](#system--infrastructure)
- [This fork vs upstream Thuki](#this-fork-vs-upstream-thuki)
- [Installation](#installation)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Sponsor](#sponsor)
- [Credits & License](#credits--license)

## Why Oling

Most AI tools require accounts, API keys, or subscriptions billed per token. Oling is different:

- **100% free AI interactions** — bring your own model (local or hosted), no per-query cost, ever
- **Zero trust by design** — no remote server, no cloud backend, no analytics, no telemetry
- **Works offline** — once your model is pulled, Oling runs without an internet connection
- **Your data is yours** — conversations and clipboard history live in a local SQLite database; the conversation table is purged on every launch by design
- **Works everywhere** — double-tap <kbd>⌃</kbd> and Oling appears on the desktop, inside a browser, inside a terminal, even in fullscreen apps

## 🧠 Custom AI Commands — the standout feature

Oling's slash commands are a **first-class, fully user-editable primitive**. Define a command once — it runs in every place Oling touches your content: the chat bar, any clipboard entry, highlighted text in any app, a screenshot brought into the chat.

### Why this design exists: privacy-first intelligence

The surfaces Oling reads from — clipboard entries, screenshots, text selected in another app — are **some of the most privacy-sensitive data on your Mac**. A password you just copied from a password manager. A screenshot of a contract draft. A client email you're excerpting. A SQL row against prod. A reply you're polishing before sending. Cloud AI tools (Raycast AI, ChatGPT plugins, Copilot, hosted Claude) route all of it through a third-party server.

**Oling flips that.** The intelligence runs *locally*, the data never leaves your Mac. A small on-device model (Gemma 4 2B, Qwen 3 8B, Llama 3.2 3B — you pick) handles the tasks daily productivity actually needs — translate, summarize, reformat, rewrite, grammar-fix, extract — without touching the network. These don't need frontier reasoning; they need a model that **sits close to your data**.

> **The thesis:** pair privacy-heavy but inherently "dumb" macOS workflows — clipboard, screenshots, selections — with a small on-device model and user-editable commands. Every piece of ambient text on your Mac gets a layer of intelligence, one keystroke away, that never leaves your machine.

That's why Oling's "one command, everywhere" design is *safe enough to be useful*. Without a local model, universal AI on your clipboard and screenshots would be a privacy disaster. With one, it's the best of both worlds — **absolute privacy + one-keystroke convenience**, and usually the *right tool for the job*: small models are often *enough* for single-purpose, pattern-shaped tasks, and often *better* than shipping your clipboard to a frontier model.

### Fully user-configurable

- **Edit any built-in** — change the trigger, description, or prompt template of `/translate`, `/rewrite`, `/tldr`, `/refine`, `/bullets`, `/todos`, `/think`
- **Add your own** — just provide a trigger and a prompt template with `$INPUT` / `$LANG` placeholders. No code, no restart.
- **Disable** the ones you don't use so they stop cluttering your command palette
- **Live reload** — edit in Settings → next invocation uses the new prompt

### The same command works across every context

| Where | How it runs |
| --- | --- |
| **Chat bar** | Type `/your-command` — palette autocomplete, submit with Enter |
| **Clipboard panel** | One-click **AI Actions** tile on any entry (pick which commands show up in Settings → Clipboard) |
| **Highlighted text anywhere** | Select text in any app, double-tap <kbd>⌃</kbd>, type `/your-command` |
| **Screenshots** | Annotate → **Ask AI** opens the chat with the image attached → type any command |

### Example commands you might add

```
/fix         Fix grammar and spelling issues in $INPUT without changing the meaning.
/cn2en       Translate $INPUT from Chinese to English. Keep technical terms unchanged.
/commit      Write a one-line git commit message (imperative mood) for: $INPUT
/explain     Explain $INPUT to a junior developer. Use a short analogy.
/json        Reformat $INPUT as clean, minified JSON.
/sql         Turn the English requirement $INPUT into a SQL query for PostgreSQL.
```

> Oling runs on **your own OpenAI-compatible backend** — local (Ollama, LM Studio, vLLM, llama.cpp) or hosted (any provider you trust). The design *encourages* local: that's where the privacy story holds end-to-end. **No subscription, no per-query cost.**

## Features

### AI Secretary

- **Double-tap <kbd>⌃</kbd>** to summon from any app, including fullscreen
- **Context-aware quotes** — highlight text anywhere; the selection is pre-filled via macOS Accessibility APIs
- **Throwaway conversations** — ephemeral by default (purged on launch)
- **Multimodal input** — paste or drag images; up to 10 per message, 20 MB each, HEIC auto-converted
- **Streaming with mid-stream cancel** via cancellation token
- **Reasoning / thinking display** — `<think>…</think>` and OpenAI `reasoning_content` are split into a collapsible block
- **Multi-model support** — comma-separated list via `OLING_SUPPORTED_AI_MODELS`, pick at runtime
- **API connection tester** — one click in Settings verifies your LLM server is reachable and lists available models
- **Classified errors** — `NotRunning` / `ModelNotFound` / `Other` render as inline colored callouts

### Workflow Tools

- **Clipboard history workspace (<kbd>⌘⇧V</kbd>)** — grouped by Pinned / Today / Yesterday / Earlier, filterable by type (text / URL / code / image / file), with global search
  - **Source-app icons** extracted from each app's `Info.plist` and cached locally
  - **CodeMirror 6 preview & edit** — GitHub Dark, language auto-detection, Enter inserts newlines
  - **Paste as Text (<kbd>⇧⏎</kbd>)** strips formatting
  - **Restore to clipboard** / **paste into focused app** (synthesized ⌘V with original clipboard restored after)
  - **Pin** exempts entries from the history cap (configurable 10 – 10,000, default 200)
  - **Image entries** — copy as PNG / base64, preview, attach to chat, delete
  - **SHA-256 dedup** suppresses duplicate clips
- **Screenshot + annotation (<kbd>⌘⇧X</kbd>)** — Xnip-style drag-to-select across monitors
  - **Quick-select windows** overlapping the selection
  - **Konva canvas tools** — pencil, text, eraser, undo/redo, 8-handle resize + move
  - **Toolbar actions** — copy, pin as sticker, Ask AI, OCR, close
  - **OCR** uses a dedicated prompt (customizable in Settings)
  - **Excludes Oling's own windows** from capture by PID
- **Smart reply (<kbd>⌃⇧R</kbd>)** — screenshots the frontmost app, model drafts a reply, <kbd>Enter</kbd> auto-pastes back to the app; original clipboard is restored after ~700 ms
- **Scrolling screenshot (Long Shot)** — manual scroll-capture for chat histories (WeChat, Feishu, iMessage), long emails, long articles
  - **Window-aware** — captures the target window directly and crops to your selection
  - **Automatic chrome detection** crops out fixed headers/footers by comparing the first two frames
  - **Stitch algorithm** uses SAD matching on 80 px overlap strips; 200-frame safety cap
  - **Non-key HUD** while capturing so your scrolling app keeps focus
  - **Edit in overlay** — stitched output opens in the annotation editor
- **Pin stickers** — pin any screenshot or clipboard image as an independent frameless window
  - Native drag-to-move, right-click opacity slider (0.2 – 1.0), edit in overlay, delete
  - Multiple independent pins, each identified by UUID

### System & Infrastructure

- **Configurable global shortcuts** — every shortcut below is re-bindable in Settings → Shortcuts

  | Action | Default |
  | --- | --- |
  | Summon overlay | Double-tap <kbd>⌃</kbd> |
  | Screenshot | <kbd>⌘⇧X</kbd> |
  | Clipboard history | <kbd>⌘⇧V</kbd> |
  | Smart reply | <kbd>⌃⇧R</kbd> |
  | Open Settings | <kbd>⌘,</kbd> |
  | Submit / newline | <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> |
  | Dismiss | <kbd>Esc</kbd> |
  | Command palette | <kbd>/</kbd> or <kbd>⌘K</kbd> |
  | Paste as text (clipboard) | <kbd>⇧⏎</kbd> |

- **Settings — six tabs**: AI Model · Prompts · Shortcuts · Commands · Clipboard · Storage
- **Onboarding flow** with Accessibility + Screen Recording permission checks, revocation detection, and quit-and-relaunch helper
- **Crash reporter** — `std::panic::set_hook` writes structured crash records; `installGlobalErrorReporter` forwards `window.onerror` + `unhandledrejection`; browseable in Settings → Storage
- **Rolling logs** — `tauri-plugin-log`, 2 MB rotation, `KeepAll`
- **Strict CI coverage** — frontend (Vitest) + backend (cargo-llvm-cov) both enforced at **100% line coverage**
- **macOS system integration**
  - NSPanel overlay via `tauri-nspanel` — floats on fullscreen Spaces without stealing focus
  - `ActivationPolicy::Accessory` — no Dock icon
  - CGEventTap HID-level + Default tap — survives focus changes and secure input
  - Multi-monitor aware placement via CoreGraphics
  - Rounded NSWindow corners synced with inner UI
  - Tray menu: Open / Settings / Quit
- **Optional Docker sandbox** for hardened local inference (`cap_drop: ALL`, no-new-privileges, read-only model volume, localhost-only port binding)

## This fork vs upstream Thuki

| | upstream Thuki | Oling (this fork) |
| --- | :---: | :---: |
| Floating overlay (double-tap <kbd>⌃</kbd>) | ✅ | ✅ |
| Context-aware text quoting | ✅ | ✅ |
| Built-in slash commands | ✅ (6) | ✅ (7, all editable) |
| **Custom user-defined slash commands** | ❌ | ✅ |
| **Commands shared across chat + clipboard + quoted text** | — | ✅ |
| Screenshot input (basic `/screen`) | ✅ | ✅ (replaced) |
| **Full Xnip-style screenshot + annotation overlay** | ❌ | ✅ |
| **OCR via AI** | ❌ | ✅ |
| **Clipboard history workspace** | ❌ | ✅ |
| **Source-app icon resolution** | ❌ | ✅ |
| **CodeMirror preview + edit for code clips** | ❌ | ✅ |
| **Scrolling screenshot (long shot)** | ❌ | ✅ |
| **Smart reply** (auto-paste back to source app) | ❌ | ✅ |
| **Pin stickers** (floating image windows) | ❌ | ✅ |
| **Configurable global shortcuts** | ❌ | ✅ |
| **Six-tab Settings panel** | ❌ | ✅ |
| Onboarding & permission revocation detection | partial | ✅ |
| **Crash reporter + rolling logs** | ❌ | ✅ |
| OpenAI-compatible backend (any provider) | Ollama focused | ✅ (any) |
| Docker sandbox | ✅ | ✅ |
| Apache 2.0 | ✅ | ✅ (preserved) |

## Installation

### Download (recommended)

1. Download `Oling.dmg` from the [latest release](../../releases/latest)
2. Open the DMG and drag **Oling** into **Applications**
3. Eject the DMG
4. Open Oling from Applications — it lives in your menu bar

Because Oling is signed with a Developer ID certificate and notarized by Apple, macOS will let you run it without any quarantine workaround.

> **First launch:** macOS will ask for **Accessibility** (double-tap Control global hotkey) and **Screen Recording** (screenshot, smart reply, long shot). Grant both; they persist across restarts. If you later revoke a permission, Oling detects it and re-shows the onboarding screen.

### Build from source

**Prerequisites:** [Bun](https://bun.sh), [Rust](https://rustup.rs), optionally [Docker](https://www.docker.com/get-started).

```bash
git clone https://github.com/fengbird/thuki.git
cd thuki
bun install

bun run dev            # development with HMR
bun run build:all      # production build → src-tauri/target/release/bundle/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup guide.

### Set up your AI backend

Oling speaks the OpenAI `/chat/completions` SSE protocol, so any compliant server works.

<details>
<summary><strong>Option A: Local Ollama (recommended for most users)</strong></summary>

```bash
brew install ollama
ollama pull gemma4:e2b
export OLING_API_BASE_URL=http://127.0.0.1:11434/v1
export OLING_SUPPORTED_AI_MODELS=gemma4:e2b
```

Or configure it in Settings → AI Model and click **Test Connection**.

</details>

<details>
<summary><strong>Option B: LM Studio / vLLM / llama.cpp / hosted provider</strong></summary>

Set `OLING_API_BASE_URL` to the server's base URL (include `/v1`) and `OLING_API_KEY` if auth is required. Any OpenAI-compatible endpoint works.

Defaults: `http://127.0.0.1:1234/v1` with API key `lm-studio` (LM Studio convention).

</details>

<details>
<summary><strong>Option C: Docker sandbox (maximum isolation)</strong></summary>

```bash
bun run sandbox:start
# ... when you're done:
bun run sandbox:stop   # destructive: wipes the volume
```

Full architecture and security philosophy: [`sandbox/README.md`](sandbox/README.md).

</details>

## Configuration

Runtime configuration reference: [docs/configurations.md](docs/configurations.md) · Slash command reference: [docs/commands.md](docs/commands.md).

Every setting supports **priority fallback**: SQLite → environment variable → built-in default. Changes apply live, no restart.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OLING_API_BASE_URL` | OpenAI-compatible base URL | `http://127.0.0.1:1234/v1` |
| `OLING_API_KEY` | Bearer token | `lm-studio` |
| `OLING_SUPPORTED_AI_MODELS` | Comma-separated model list | single built-in |
| `OLING_SYSTEM_PROMPT` | Custom system prompt | built-in |
| `OLING_REPLY_PROMPT` | Custom smart-reply prompt | built-in |
| `OLING_OCR_PROMPT` | Custom OCR prompt | built-in |

## Architecture

<details>
<summary>Click to expand</summary>

Oling is a **Tauri v2** app: Rust backend, React 19 + TypeScript 5.8 frontend, Tailwind CSS 4, SQLite via `rusqlite`, CodeMirror 6 for code, Konva for annotation, Streamdown + Shiki for markdown.

### Process architecture

- **Frontend** runs in the system WebView with restricted IPC
- **Backend** owns the NSPanel, event taps, clipboard monitor, screenshot capture, and settings store
- **Streaming** uses Tauri's typed Channel API — the Rust side sends `StreamChunk` variants (`Token`, `ThinkingToken`, `Done`, `Cancelled`, `Error`) and the frontend hook accumulates them into React state

### Windows

- **Main overlay** — morphs between ask-bar and chat modes via Framer Motion
- **Clipboard panel** — 920×640 NSPanel with rounded NSWindow chrome
- **Screenshot overlay** — fullscreen Konva canvas with quick-window-select
- **Reply draft** — compact non-key panel
- **Pin stickers** — frameless, draggable, semi-transparent windows (one per pin)
- **Long-shot HUD** — non-key capture progress indicator
- **Settings** — standard window with six tabs

### Storage

`<app_data_dir>/` contains:
- `oling.db` — settings, clipboard history, onboarding state (conversation table purged on launch)
- `images/` — saved chat attachments (orphans pruned at startup)
- `app-icons/` — cached 128 px source-app icons
- `crashes/` — panic and frontend-error reports
- `logs/oling.log` — rolling app log

### Hotkey listener (`activator.rs`)

Core Graphics event tap configured with `CGEventTapLocation::HID` + `CGEventTapOptions::Default`. On macOS 15 Sequoia, **both** are load-bearing — Session-level taps stop delivering events when focus changes, and `ListenOnly` taps are disabled by secure input mode. See `CLAUDE.md` for the full writeup.

</details>

## Roadmap

- In-app model switching without rebuild
- Internet search and MCP tool integrations
- Voice input, file/document drop, targeted region capture
- More built-in slash commands for domain-specific workflows
- Cross-device sync for custom commands (opt-in)

Have a feature idea? [Open an issue](../../issues).

## Sponsor

Oling is free and open source. If it saves you time, consider supporting development:

- 🌏 **GitHub Sponsors** — [github.com/sponsors/fengbird](https://github.com/sponsors/fengbird)
- 🇨🇳 **爱发电** (WeChat / Alipay) — coming soon

Your support funds ongoing development, the Apple Developer Program fee that makes notarized builds possible, and domain/CDN costs. Sponsors are listed (opt-in) in the About dialog.

## Credits & License

- **Upstream:** [**quiet-node/Thuki**](https://github.com/quiet-node/Thuki) by [Logan Nguyen](https://x.com/quiet_node) — original overlay, AI secretary core, and project design (originally released as *Thuki*)
- **This fork** adds the clipboard workspace, Xnip-style screenshot overlay, scrolling screenshot, smart reply, pin stickers, configurable shortcuts, custom slash commands, onboarding flow, crash reporter, rolling logs, and a substantial amount of UI polish
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md)
- **Security reports:** please use [GitHub Security Advisories](../../security/advisories/new)

Copyright 2026 Logan Nguyen and contributors. Licensed under the [Apache License, Version 2.0](LICENSE). All upstream copyright notices are preserved; see `LICENSE` for the full text.
