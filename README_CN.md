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

### npx 跑不通时：从克隆安装

在受管控或装有杀软的机器上，`npx` 可能在解压到缓存目录时失败 —— 典型表现是出现 `npm warn cleanup ... EPERM`，并且 **CLI 完全没有任何输出**，因为命令 shim 根本没建成。这种情况直接绕开 npx：

```bash
git clone https://github.com/xmm-prio/CCursor.git
cd CCursor
node installer/dist/cli.cjs install
```

CLI 打包后**没有任何运行时依赖**，所以这里不需要执行 `npm install` —— 有 `git clone` 和 `node` 就够了。

### 安装之后

打补丁只是把流量劫持到本地 BYOK 服务器，而服务器提供哪些模型取决于配置。**全新安装时 `~/.ccursor/providers.json` 是空的，Cursor 里看不到任何自定义模型，看起来就像"没有有效安装"。** 请重启 Cursor，打开侧边栏 Cursor++ 面板添加服务商，或直接编辑 `providers.json`（格式见[配置](#配置)一节）。

`install` 结束时会提示所有尚未完成的配置项，包括因未登录 Cursor 而导致 BYOK 模式处于 OFF 的情况。

### Windows：需要管理员权限

如果 Cursor 装在 `C:\Program Files` 下，普通 shell 没有写权限，安装会失败或看似执行了却什么都没留下。请在**管理员** PowerShell 中执行。装在 `%LOCALAPPDATA%\Programs\cursor` 的单用户安装则不需要提权。

有多份 Cursor 安装？CLI 会选版本最高的那份，并打印被跳过的路径；可用 `CCURSOR_CURSOR_ROOT=<resources/app 路径>` 覆盖。

> 从旧版本升级？请先 `uninstall` 再 `install`。注入的路由器带有版本标记，在旧补丁上叠加安装不会生效。
>
> `status` 会明确区分这种情况：由旧版 installer 打过补丁的 bundle 会被报成 **"payload is stale — re-run install"**，而不是当作健康安装，避免新版修复悄无声息地没到你手上。

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

- **Multi-Window Concurrency** — One machine-wide server tuned for many workspaces streaming at once  
  **多窗口并发** — 整机单一服务器，按多工作区同时出流的负载调参（见下文[多窗口并发](#多窗口并发)）

---

## How It Works / 工作原理

```
Cursor IDE
  │
  ├─ inject-patch (renderer)
  │   └─ intercept ConnectRPC + REST → route to BYOK server
  │       + push channel: WebSocket /byok/ws (fallback: SSE /byok/events)
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

## 多窗口并发

BYOK 服务器**整机只有一个**：第一个抢到 `:39831` 的 Cursor 窗口成为 owner，其余窗口作为 peer 把流量路由过去。因此同时打开几个工作区时，所有 agent（以及它们派生的 subagent）都汇聚到同一个进程、同一组连接池上。下面这几条约束就是为这种形态设置的。

### 上游连接池

一次 agent turn 会独占目标服务商 origin 的一条 socket，直到这轮结束 —— 通常是几分钟。池子满了之后 undici 会把后续请求排进一个**没有超时、不发事件、不打日志**的内部队列，表现就是"agent 一直不出第一个 token"。

所以 `UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN` 取 64（见 `src/server/config/upstreamTuning.ts`），让真正的约束回到服务商自己的限流上 —— 429 会被 `retryPolicy.ts` 判定为可重试并退避，而本地队列不会。socket 是懒创建的，空闲时这个上限不占任何资源。

服务器还会在**跨过池子上限的那一刻**打一条 warn，而不是每条请求都打，因为值得知道的是"从这里开始会排队"这个时刻。

### 推送通道：WebSocket 优先

renderer 到同一 origin 的 HTTP/1.1 连接上限是 6 条，而且这个额度是 **Chromium 在所有 Cursor 窗口之间共享的**，不是每个窗口一份。SSE 订阅是一条永不结束的请求，于是每多开一个工作区就永久吃掉六分之一；额度耗尽后，所有发往 BYOK 端口的普通请求都会堵在这些永不结束的流后面。

现在 renderer 优先走 WebSocket（`/byok/ws`），它走的是另一个大得多的连接池。`/byok/events` 的 SSE 保留为回退路径 —— 如果 Content-Security-Policy 禁止 `ws:`，通道会自动降级而不是直接失联，且降级在本次会话内保持（CSP 不会在运行期改变，每次重连都重试只会徒增延迟）。

### 背压与内存

- 日志推送有 1 MiB 的缓冲预算。某个窗口停止读取时（挂起的笔记本、拥塞的 SSH 隧道），它的日志会被丢弃而不是无限堆在共享进程里；恢复后该窗口会收到一条"丢了多少行"的提示。routes / refresh 这类事件帧不受此限制，因为消费方无法自行重建这些状态。
- blob 内存缓存自带上界（20000 条 / 128 MiB，LRU）。淘汰是安全的：每条 blob 同时写入了 sqlite，未命中时 `warmupBlobsAsync` 会读回来。
- 关闭服务器时会先广播 shutdown、再挂断所有订阅、最后强制关闭连接。推送订阅和 agent turn 都是"设计上不会结束"的请求，不这样做端口会一直被占着，其他窗口的接管尝试全部失败。

### 排查

`curl http://127.0.0.1:39831/byok/debug` 给出四组数据：

| 字段 | 回答什么问题 |
|---|---|
| `upstream` | 每个 origin 现在有几条流在跑、峰值多少、跨过池子上限几次 |
| `pushChannel` | 每个通道有几个订阅者、各走什么传输、丢了多少日志 |
| `blobCache` | 缓存占了多少内存、淘汰过多少条 |
| `agentLink` | 编辑器上行链路是否丢包、流重启了几次 |

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
