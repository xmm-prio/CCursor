<p align="center">
  English | <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <img src="ccursor.png" width="120" alt="Cursor++" />
</p>

<h1 align="center">Cursor++</h1>

<p align="center">
  <strong>Bring Your Own Key for Cursor IDE</strong>
</p>

<p align="center">
  <strong>Customized fork</strong> of <a href="https://github.com/CometixSpace/CCursor">CometixSpace/CCursor</a> — installed directly from this repository
</p>

---

## What is Cursor++?

Cursor++ lets you use **your own LLM API keys** (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible provider) with [Cursor IDE](https://cursor.com), bypassing the official subscription. It runs a local BYOK server inside Cursor's extension host, intercepts ConnectRPC/REST traffic, and routes LLM requests to your configured providers.

This fork carries source code and prebuilt artifacts, so it installs straight from git with no toolchain required.

---

## Quick Start

Install directly from this repository — no npm publish involved:

```bash
# Install
npx github:xmm-prio/CCursor install

# Restart Cursor, then open the Cursor++ sidebar panel to configure providers

# Uninstall
npx github:xmm-prio/CCursor uninstall

# Check installation status
npx github:xmm-prio/CCursor status
```

`npx` caches the clone. To pick up a newer commit, pin a ref or clear the cache:

```bash
# Pin a branch, tag, or commit
npx github:xmm-prio/CCursor#main install

# Full git URL works too
npx git+https://github.com/xmm-prio/CCursor.git install
```

Requires **Node.js >= 18**. Nothing else — the CLI bundle and the packaged
extension are committed to this repository, so no build step runs on your machine.

### After installing

Patching only redirects traffic to the local BYOK server — the server still
needs to know which models to serve. **A fresh install leaves
`~/.ccursor/providers.json` empty, so Cursor shows no custom models and the
install looks like it did nothing.** Restart Cursor, open the Cursor++ sidebar
panel, and add a provider (or edit `providers.json` directly — see
[Configuration](#configuration)).

`install` reports any remaining gap at the end, including when BYOK mode is
left OFF because you have not signed in to Cursor yet.

### Windows: run elevated

If Cursor lives under `C:\Program Files`, the patches cannot be written from a
normal shell and the install fails or silently leaves nothing behind. Run the
command from an **Administrator** PowerShell. Per-user installs under
`%LOCALAPPDATA%\Programs\cursor` do not need this.

Have several Cursor installs? The CLI picks the newest and prints the ones it
skipped; override with `CCURSOR_CURSOR_ROOT=<path to resources/app>`.

> Upgrading from a previous install? Run `uninstall` before `install`. The
> injected router carries a version marker, and stacking a new install on top of
> old patches will not take effect.

---

## Features

- **BYOK Mode Toggle** — Sidebar one-click switch between BYOK and official Cursor
- **Multi-Provider** — Anthropic, OpenAI (Chat + Responses API), Google Gemini, or any compatible endpoint
- **Full Agent Mode** — Tool calling, multi-turn conversations, auto-summarization, checkpoint persistence
- **Model Config UI** — Visual provider/model management with thinking level, context limits, variant display
- **Error Banner** — LLM errors surface as Cursor's native retry banner with retryable/non-retryable classification
- **Per-Window Logging** — Each window gets its own log stream, colored output in LogOutputChannel
- **Hot-Reload** — Config changes take effect without restarting Cursor
- **Native Agent Tools** — Shell, Read, Grep, Glob, Edit, Write, Task, MCP, plus the `cursor` dynamic namespace (ConnectScm, SearchConversations, SetActiveBranch, CreateGoal, UpdateGoal, WriteShellStdin)
- **Remote SSH** — A headless companion extension serves the remote host while the local side keeps the UI

---

## How It Works

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

---

## Configuration

Config files are stored in `~/.ccursor/`:

| File | Purpose |
|---|---|
| `providers.json` | LLM provider endpoints, API keys, and model definitions |
| `routes.json` | BYOK mode toggle + redirect whitelist |
| `cursor.db` | Conversation persistence (SQLite) |

### Provider Example

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

## Platform Support

| Platform | Status |
|---|---|
| macOS (ARM / Intel) | ✅ |
| Linux | ✅ |
| Windows | ✅ |

Requires **Cursor IDE** + **Node.js >= 18**.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Cannot sign in after install | Toggle BYOK OFF in sidebar panel, then sign in normally |
| Model not found | Add the model in the sidebar panel or edit `~/.ccursor/providers.json` |
| LLM 401/403/404 | Check API key and base URL in providers.json |

---

## Remote SSH

Under Remote SSH the Cursor agent host runs on the **remote** machine, so the
remote side needs its own BYOK server. Three steps, in order:

```bash
# 1. On the remote host — patch the Cursor server install
npx github:xmm-prio/CCursor install   # targets ~/.cursor-server/bin/<commit>

# 2. On the remote host — provide keys (they are never copied across machines)
vi ~/.ccursor/providers.json
```

3. Build the companion extension and install it into the remote window via
   **Extensions → Install from VSIX → Install in SSH: \<host\>**:

```bash
cd Cursor++ && pnpm run vsix:remote   # produces cursor2plus-remote-<ver>.vsix
```

The local `cursor2plus` extension keeps the UI; the remote `cursor2plus-remote`
companion is headless and contributes no commands, so the two never collide.

> `~/.cursor-server/bin/<commit>` is recreated whenever Cursor upgrades, so the
> remote patch is **not** one-time — rerun `install` on the remote after each
> client upgrade.

---

## Building from Source

Prebuilt artifacts are committed, so this is only needed when you change the code:

```bash
cd Cursor++  && pnpm install
cd ../installer && npm install && npm run build:all
```

`build:all` packages the extension into `installer/vsix/` and bundles the CLI
into `installer/dist/`. Both directories are tracked — commit them so that
`npx github:xmm-prio/CCursor` keeps working.

---

## Credits & License

Fork of [CometixSpace/CCursor](https://github.com/CometixSpace/CCursor), licensed
under **AGPL-3.0-or-later**. Upstream discussion:
[LinuxDO](https://linux.do/t/topic/1926833).
