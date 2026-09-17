# @cometix/ccursor

Cursor++ BYOK Installer — Bring Your Own Key for Cursor IDE.

## Install

```bash
npx @cometix/ccursor install
```

## Uninstall

```bash
npx @cometix/ccursor uninstall
```

## Status

```bash
npx @cometix/ccursor status
```

## 安装形态（profile）

installer 会自动判定目标是哪一种 Cursor 安装树，并只处理该形态声明的补丁目标：

| 形态 | 目标目录 | 打的补丁 |
| --- | --- | --- |
| desktop | `resources/app` | renderer hook、cursor-always-local、签名绕过、cursor-agent-host、utility-process router、KaTeX |
| server | `~/.cursor-server/bin/<commit>` | cursor-agent-host、签名绕过 |

server 形态是 Remote SSH / tunnel 在远端解压的 REH 目录，没有 renderer，
`cursor-always-local`（`extensionKind: ["ui"]`）也不在远端运行，
因此这些目标会被标记为「不适用」而不是失败。

### Remote SSH 下的完整链路

Cursor 把 `cursor-agent-host` / `cursor-agent-exec` / `cursor-agent-worker`
跑在**远端**，所以本机打完补丁还不够，远端也要各来一次：

```bash
# 1. 本机（客户端）
npx @cometix/ccursor install

# 2. ssh 到远端主机
npx @cometix/ccursor install     # 自动选中 ~/.cursor-server/bin/<commit>
vi ~/.ccursor/providers.json     # API Key 不会跨机器复制，需要在远端单独填
```

远端不安装本机那份带 UI 的 `cursor2plus` 扩展 —— 远端用的是无界面的
`cursor2plus-remote` 伴生扩展，由用户在附着远端的窗口里
「Extensions → Install from VSIX → Install in SSH: \<host\>」安装，不归 installer 管。

多份安装并存时：desktop 优先于 server；同形态内取版本最高的一份，
server 目录同版本时取最近写入的 commit。用 `CCURSOR_CURSOR_ROOT` 可显式指定
（指向 `resources/app` 或 `~/.cursor-server/bin/<commit>` 均可）。
