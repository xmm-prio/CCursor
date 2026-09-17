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

### If `npx` fails: install from a clone

On locked-down or antivirus-managed machines, `npx` can fail while extracting
into its cache — typically showing `npm warn cleanup ... EPERM` and **no output
from the CLI at all**, because the command shim was never created. Bypass npx
entirely:

```bash
git clone https://github.com/xmm-prio/CCursor.git
cd CCursor
node installer/dist/cli.cjs install
```

The CLI bundle has **no runtime dependencies**, so there is no `npm install`
step here — `git clone` and `node` are all you need.

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
>
> `status` names this case explicitly — a bundle patched by an older installer
> is reported as *"payload is stale — re-run install"* rather than as a healthy
> install, so a shipped fix cannot silently fail to reach you.

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
- **Multi-Window Concurrency** — One machine-wide server tuned for many workspaces streaming at once ([details](#multi-window-concurrency))

---

## How It Works

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

---

## Multi-Window Concurrency

There is exactly **one BYOK server per machine**: the first Cursor window to bind
`:39831` owns it, every other window becomes a peer that routes into it. With
several workspaces open, all agents — and every subagent they spawn — therefore
share one process and one set of connection pools. The constraints below exist
for that shape.

### Upstream connection pool

One agent turn holds one socket of its provider's origin for the whole turn,
typically minutes. Once the pool is full, undici parks further requests in an
internal queue with **no timeout, no event and no log line**, which looks like
"the agent never produces a first token".

`UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN` is therefore 64 (see
`src/server/config/upstreamTuning.ts`), so the binding constraint becomes the
provider's own rate limiter — a 429 that `retryPolicy.ts` classifies as
retryable and backs off from, which a local queue never does. Sockets are
created lazily, so the ceiling costs nothing while the server is idle.

The server logs a warning at the moment an origin **crosses** the pool ceiling
rather than on every request, because the useful fact is when queueing starts.

### Push channel prefers WebSocket

A renderer gets six HTTP/1.1 sockets per origin, and Chromium shares that budget
across every Cursor window rather than giving each one its own. An SSE
subscription is a request that never completes, so each open workspace
permanently spends one of the six; once they are gone, every ordinary request to
the BYOK port queues behind streams that by design never end.

The renderer now prefers WebSocket (`/byok/ws`), which is drawn from a separate
and far larger pool. The SSE endpoint `/byok/events` remains as the fallback: if
a Content-Security-Policy forbids `ws:`, the channel degrades instead of
disappearing, and the fallback is sticky for the session (a CSP does not change
at runtime, so re-probing on every reconnect would only add latency).

### Backpressure and memory

- Log delivery has a 1 MiB buffer budget per subscriber. When a window stops
  reading — a suspended laptop, a congested SSH tunnel — its log frames are
  dropped instead of accumulating without limit inside the shared process, and
  the window is told how much it missed once it drains. Event frames (routes,
  refresh) are exempt: the consumer cannot re-derive that state.
- The in-memory blob cache bounds itself (20 000 entries / 128 MiB, LRU).
  Eviction is safe because every blob is also written to sqlite and
  `warmupBlobsAsync` reads it back on a miss.
- Shutdown broadcasts, then hangs up on subscribers, then force-closes
  connections. Push subscriptions and agent turns are requests designed never to
  finish; without this the listening socket stays bound after the owner window
  closes and every peer's takeover attempt fails.

### Diagnosing

`curl http://127.0.0.1:39831/byok/debug` answers four questions:

| Field | Question |
|---|---|
| `upstream` | how many streams are open per origin, the peak, how often the pool ceiling was crossed |
| `pushChannel` | subscribers per channel and transport, log frames dropped |
| `blobCache` | memory held by the cache, entries evicted |
| `agentLink` | whether the editor uplink lost messages, how often streams restarted |

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
