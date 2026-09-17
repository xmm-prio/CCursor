<p align="center">
  <a href="README.md">English</a> | 中文
</p>

<p align="center">
  <img src="ccursor.png" width="120" alt="Cursor++" />
</p>

<h1 align="center">Cursor++</h1>

<p align="center">
  <strong>Bring Your Own Key for Cursor IDE</strong><br/>
  使用自己的 API Key 驱动 Cursor 的 Agent / Chat / Composer
</p>

<p align="center">
  <a href="https://github.com/CometixSpace/CCursor">CometixSpace/CCursor</a> 的<strong>定制分支</strong> — 直接从本仓库安装
</p>

---

## Cursor++ 是什么?

Cursor++ 让你使用**自己的 LLM API Key**（Anthropic / OpenAI / Google Gemini 或任何兼容服务商）驱动 [Cursor IDE](https://cursor.com)，无需官方订阅。它在 Cursor 扩展宿主内运行本地 BYOK 服务器，拦截 ConnectRPC/REST 通信并路由到你配置的服务商。

本分支包含完整源码与预构建产物，因此可以直接从 git 安装，本机无需任何构建工具链。

---

## 快速开始

直接从本仓库安装，不经过 npm 发布：

```bash
# 安装
npx github:xmm-prio/CCursor install

# 重启 Cursor，打开侧边栏 Cursor++ 面板配置服务商

# 卸载
npx github:xmm-prio/CCursor uninstall

# 检查安装状态
npx github:xmm-prio/CCursor status
```

`npx` 会缓存克隆结果。要拉取更新的提交，可以指定 ref 或改用完整 git 地址：

```bash
# 指定分支、tag 或 commit
npx github:xmm-prio/CCursor#main install

# 完整 git 地址同样可用
npx git+https://github.com/xmm-prio/CCursor.git install
```

要求 **Node.js >= 18**，仅此而已 —— CLI 与扩展包都已提交到仓库，安装时不会在你机器上执行任何构建。

> 从旧版本升级？请先 `uninstall` 再 `install`。注入的路由器带有版本标记，在旧补丁上叠加安装不会生效。

---

## Features / 功能特性

- **BYOK Mode Toggle** — Sidebar one-click switch between BYOK and official Cursor  
  **BYOK 模式开关** — 侧边栏一键切换 BYOK 和官方 Cursor

- **Multi-Provider** — Anthropic, OpenAI (Chat + Responses API), Google Gemini, or any compatible endpoint  
  **多服务商** — Anthropic、OpenAI（Chat + Responses API）、Google Gemini 或任何兼容端点

- **Full Agent Mode** — Tool calling, multi-turn conversations, auto-summarization, checkpoint persistence  
  **完整 Agent** — 工具调用、多轮对话、自动摘要、检查点持久化

- **Model Config UI** — Visual provider/model management with thinking level, context limits, variant display  
  **模型配置 UI** — 可视化服务商/模型管理，支持思考档位、上下文限制、变体显示

- **Error Banner** — LLM errors surface as Cursor's native retry banner with retryable/non-retryable classification  
  **错误横幅** — LLM 错误通过原生重试横幅展示，自动区分可重试/不可重试

- **Per-Window Logging** — Each window gets its own log stream, colored output in LogOutputChannel  
  **逐窗口日志** — 每个窗口独立日志流，LogOutputChannel 彩色输出

- **Hot-Reload** — Config changes take effect without restarting Cursor  
  **热重载** — 配置修改无需重启 Cursor 即可生效

- **Native Agent Tools** — Shell, Read, Grep, Glob, Edit, Write, Task, MCP, plus the `cursor` dynamic namespace  
  **原生 Agent 工具** — Shell、Read、Grep、Glob、Edit、Write、Task、MCP，以及 `cursor` 动态命名空间下的 ConnectScm、SearchConversations、SetActiveBranch、CreateGoal、UpdateGoal、WriteShellStdin

- **Remote SSH** — A headless companion extension serves the remote host  
  **Remote SSH** — 无 UI 的伴生扩展为远端提供服务，本地侧保留界面

---

## How It Works / 工作原理

```
Cursor IDE
  │
  ├─ inject-patch (renderer)
  │   └─ intercept ConnectRPC + REST → route to BYOK server
  │
  ├─ always-local-patch (extension host)
  │   └─ rewrite http/https.request + hot-reload from routes.json
  │
  └─ Cursor++ Extension (BYOK Server @ 127.0.0.1:39831)
      ├─ Fastify + ConnectRPC (27 services)
      ├─ LLM: Anthropic / OpenAI / Gemini SDK
      ├─ Agent: multi-round tool-calling orchestrator
      └─ Config: ~/.ccursor/providers.json + routes.json
```

All patches create backup files and are fully reversible via `uninstall`.  
所有补丁创建备份文件，可通过 `uninstall` 完全还原。

---

## Configuration / 配置

Config files in `~/.ccursor/`:

| File | Purpose / 用途 |
|---|---|
| `providers.json` | LLM providers, API keys, models / 服务商、密钥、模型定义 |
| `routes.json` | BYOK toggle + redirect whitelist / BYOK 开关 + 重定向白名单 |
| `cursor.db` | Conversation persistence / 对话持久化 |

### Provider Example / 配置示例

```json
{
  "providers": [
    {
      "id": "my-anthropic",
      "name": "Anthropic",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "auth": { "kind": "apiKey", "value": "sk-ant-..." },
      "models": [
        {
          "id": "claude-sonnet-4",
          "apiModel": "claude-sonnet-4-20250514",
          "displayName": "Claude Sonnet 4",
          "thinking": true,
          "thinkingLevel": "medium",
          "contextTokenLimit": 200000,
          "defaultOn": true
        }
      ]
    }
  ]
}
```

---

## Platform / 平台支持

| Platform | Status |
|---|---|
| macOS (ARM / Intel) | ✅ |
| Linux | ✅ |
| Windows | ✅ |

Requires **Cursor IDE** + **Node.js >= 18**.

---

## Troubleshooting / 故障排除

| Issue / 问题 | Solution / 解决 |
|---|---|
| Cannot sign in after install / 安装后无法登录 | Toggle BYOK OFF in sidebar, then sign in / 侧边栏切 OFF 后登录 |
| Model not found / 模型未找到 | Add model in sidebar panel / 在面板中添加模型 |
| LLM 401/403/404 | Check API key & base URL in providers.json / 检查密钥和地址 |

---

## Remote SSH

Remote SSH 下 Cursor 的 agent host 跑在**远端**机器上，因此远端需要一份自己的 BYOK 服务器。按顺序三步：

```bash
# 1. 在远端机器上 —— 给 Cursor server 打补丁
npx github:xmm-prio/CCursor install   # 目标是 ~/.cursor-server/bin/<commit>

# 2. 在远端机器上 —— 配置密钥（密钥不会跨机器复制）
vi ~/.ccursor/providers.json
```

3. 构建伴生扩展，并在远程窗口里通过 **Extensions → Install from VSIX → Install in SSH: \<host\>** 安装：

```bash
cd Cursor++ && pnpm run vsix:remote   # 产出 cursor2plus-remote-<ver>.vsix
```

本地的 `cursor2plus` 保留全部 UI；远端的 `cursor2plus-remote` 是无界面的，不贡献任何命令，两者共存不会冲突。

> `~/.cursor-server/bin/<commit>` 会在 Cursor 升级时按新 commit 重建，所以远端补丁**不是一次性的** —— 每次客户端升级后都要在远端重跑一次 `install`。

---

## 从源码构建

预构建产物已提交，只有在你改动代码时才需要执行：

```bash
cd Cursor++  && pnpm install
cd ../installer && npm install && npm run build:all
```

`build:all` 会把扩展打包进 `installer/vsix/`，并把 CLI 打包进 `installer/dist/`。这两个目录都纳入版本管理 —— 请一并提交，否则 `npx github:xmm-prio/CCursor` 会失效。

---

## 致谢与许可

本仓库是 [CometixSpace/CCursor](https://github.com/CometixSpace/CCursor) 的分支，采用 **AGPL-3.0-or-later** 许可。上游讨论：[LinuxDO](https://linux.do/t/topic/1926833)。
