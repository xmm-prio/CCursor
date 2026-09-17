import type { HostRole, HostTopology } from './server/config/hostTopology'
import type { PortStatus } from './server/config/portSelection'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import * as http from 'node:http'
import * as vscode from 'vscode'
import { bumpRefreshSignal, pushRoutesUpdate, startServer, stopServer } from './server'
import { getServerConfig } from './server/config'
import { resolveHostTopology } from './server/config/hostTopology'
import { getLogsDir, getProvidersFilePath, getSessionLogFilePath } from './server/config/paths'
import { selectServerPort } from './server/config/portSelection'
import { buildProviderSetupNotice } from './server/config/providerOnboarding'
import { ensureProvidersFile, onProvidersChange, startProvidersWatcher, stopProvidersWatcher } from './server/config/providersStore'
import { buildServerUrl, normalizeExternalUrl } from './server/config/routesPayload'
import { ensureRoutesFile, onRoutesChange, setServerExternalUrl, startRoutesWatcher, stopRoutesWatcher, toggleByokMode } from './server/config/routesStore'
import { PORT_FALLBACK_SPAN } from './server/data/defaults'
import { isLikelyWindowsMsvcMissing, preflightSupermarkdown, setSupermarkdownNativeErrorNotifier } from './server/handlers/agent/supermarkdown'
import { resetProviderInstanceCache } from './server/handlers/llm/providerRuntime'
import { initLogger } from './server/logger'
import { getRoutesFilePath } from './server/routes'
import { PanelProvider } from './ui/panel-provider'
import { clearEndpointOverride, getEndpoint, getState, onStateChange, probeByokServer, refreshState, setEndpointOverride, setFileLogState } from './ui/state'
import { startUpdateCheck, stopUpdateCheck } from './update-check'

let outputChannel: vscode.LogOutputChannel
let statusBarItem: vscode.StatusBarItem | null = null

// 当前进程的拓扑 (control/worker × local/remote) —— 见 hostTopology.ts
let topology: HostTopology = resolveHostTopology({ role: 'control' })

// 窗口标识 — 从 VSCODE_PROCESS_TITLE 的 [N-M] 提取, 提前声明供 initLogFilePath 读取
let myWindowId: number | null = null

type SseLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
interface SseLogEntry { level: SseLogLevel, msg: string }

// ── File Logger ──────────────────────────────────────────────────
//
// Per-window 日志文件: 每个 Cursor 窗口实例写自己独立的文件,
// 避免多实例并发写冲突。开关状态存 globalState (per-instance debug 偏好,
// 不应跨实例同步)。
//
// 文件路径: ~/.ccursor/logs/${windowId}-${workspace}.log
// 懒初始化: 只在首次写入时创建 writeStream 和 logs 目录
//
const GLOBAL_STATE_FILE_LOG_KEY = 'cursor2plus.fileLogEnabled'

let fileLogEnabled = false
let logFilePath = ''
let logFileStream: NodeJS.WritableStream | null = null

function initLogFilePath(context: vscode.ExtensionContext): void {
  const wid = myWindowId ?? 0
  const workspace = vscode.workspace.name || 'no-workspace'
  logFilePath = getSessionLogFilePath(wid, workspace)
  fileLogEnabled = context.globalState.get<boolean>(GLOBAL_STATE_FILE_LOG_KEY, false)
}

function ensureLogFileStream(): NodeJS.WritableStream | null {
  if (logFileStream)
    return logFileStream
  try {
    const dir = getLogsDir()
    if (!existsSync(dir))
      mkdirSync(dir, { recursive: true })
    logFileStream = createWriteStream(logFilePath, { flags: 'a' })
    return logFileStream
  }
  catch (err) {
    outputChannel.error(`[SRV] file log init failed: ${(err as Error).message}`)
    return null
  }
}

function closeLogFileStream(): void {
  if (logFileStream) {
    try {
      logFileStream.end()
    }
    catch {}
    logFileStream = null
  }
}

function formatFileLogLine(entry: SseLogEntry): string {
  const ts = new Date().toISOString()
  return `${ts} [${entry.level}] ${entry.msg}\n`
}

/** 单一写入入口 — 所有 log 都走这里, 保证 Output Channel 和文件同步 */
function writeToChannel(entry: SseLogEntry) {
  switch (entry.level) {
    case 'trace':
      outputChannel.trace(entry.msg)
      break
    case 'debug':
      outputChannel.debug(entry.msg)
      break
    case 'info':
      outputChannel.info(entry.msg)
      break
    case 'warn':
      outputChannel.warn(entry.msg)
      break
    case 'error':
      outputChannel.error(entry.msg)
      break
  }

  if (fileLogEnabled) {
    const stream = ensureLogFileStream()
    if (stream) {
      try {
        stream.write(formatFileLogLine(entry))
      }
      catch {}
    }
  }
}

/** 语义化包装: 替代直接 outputChannel.info/warn/error 调用, 走统一文件写入 */
function log(level: SseLogLevel, msg: string): void {
  writeToChannel({ level, msg })
}

function showPortOccupiedMessage(port: number): void {
  const text = `Cursor++ Server cannot start: ports ${port}-${port + PORT_FALLBACK_SPAN - 1} are all used by other processes. Free one of them, then restart Cursor.`
  log('error', `[SRV] ${text}`)
  vscode.window.showErrorMessage(text)
}

let supermarkdownTipShown = false

function setupSupermarkdownNativeTip(): void {
  setSupermarkdownNativeErrorNotifier((error) => {
    if (supermarkdownTipShown || !isLikelyWindowsMsvcMissing(error))
      return
    supermarkdownTipShown = true
    log('warn', `[WEB] supermarkdown native module failed to load: ${error.message}`)
    vscode.window.showWarningMessage(
      'Cursor++ Web Fetch requires Microsoft Visual C++ Redistributable 2015-2022 x64. Install it, then restart Cursor.',
      'Download MSVC Runtime',
    ).then((choice) => {
      if (choice === 'Download MSVC Runtime')
        vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/vs/17/release/vc_redist.x64.exe'))
    })
  })
}

/** 切换文件日志开关, 落盘到 globalState, 同步到 state (UI 显示) */
async function toggleFileLog(context: vscode.ExtensionContext): Promise<void> {
  fileLogEnabled = !fileLogEnabled
  await context.globalState.update(GLOBAL_STATE_FILE_LOG_KEY, fileLogEnabled)

  if (fileLogEnabled) {
    const stream = ensureLogFileStream()
    if (stream) {
      log('info', `[SRV] file logging ENABLED → ${logFilePath}`)
      vscode.window.showInformationMessage(`Cursor++ file logging enabled → ${logFilePath}`)
    }
  }
  else {
    log('info', '[SRV] file logging DISABLED')
    closeLogFileStream()
  }

  setFileLogState(fileLogEnabled, logFilePath)
}

/** 在 VS Code 里打开当前实例的日志文件 */
async function openLogFile(): Promise<void> {
  if (!logFilePath || !existsSync(logFilePath)) {
    vscode.window.showWarningMessage('Cursor++ log file does not exist yet. Enable file logging first.')
    return
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath))
  await vscode.window.showTextDocument(doc)
}

// ── 窗口标识 (从 VSCODE_PROCESS_TITLE 解析) —— myWindowId 声明在文件头部 ──
const RE_WINDOW_ID = /\[(\d+)-\d+\]/

function parseWindowId(): number | null {
  const title = process.env.VSCODE_PROCESS_TITLE || ''
  const m = title.match(RE_WINDOW_ID)
  return m ? Number.parseInt(m[1], 10) : null
}

// ── SSE 日志订阅 + Server Takeover ──
let sseRequest: http.ClientRequest | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let takeoverInProgress = false

function connectLogStream(port: number, windowId: number) {
  disconnectLogStream()

  const req = http.get(`http://127.0.0.1:${port}/byok/log-stream?windowId=${windowId}`, (res) => {
    let buf = ''
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const lines = part.split('\n')
        let eventType = ''
        let dataLine = ''
        for (const l of lines) {
          if (l.startsWith('event: '))
            eventType = l.slice(7).trim()
          else if (l.startsWith('data: '))
            dataLine = l.slice(6)
          else if (l.startsWith(':'))
            continue // SSE comment
        }
        if (eventType === 'shutdown') {
          log('info', '[TAKEOVER] shutdown signal received')
          attemptTakeover()
          return
        }
        if (!dataLine)
          continue
        try {
          const entry = JSON.parse(dataLine) as SseLogEntry
          writeToChannel(entry)
        }
        catch {
          log('info', dataLine)
        }
      }
    })
    res.on('end', () => {
      sseRequest = null
      onSseDisconnect()
    })
  })

  req.on('error', () => {
    sseRequest = null
    onSseDisconnect()
  })

  sseRequest = req
}

function disconnectLogStream() {
  if (sseRequest) {
    sseRequest.destroy()
    sseRequest = null
  }
}

async function onSseDisconnect() {
  if (getState().server === 'local')
    return // owner 自己关闭,不需要接管
  const cfg = getEndpoint()
  const probe = await probeByokServer(cfg.host, cfg.port)
  if (probe.kind === 'byok') {
    setTimeout(() => {
      if (myWindowId !== null) {
        const c = getEndpoint()
        connectLogStream(c.port, myWindowId)
      }
    }, 3000)
  }
  else if (probe.kind === 'offline') {
    attemptTakeover()
  }
  else {
    log('warn', `[SRV] port ${cfg.port} is occupied by another process (${probe.reason})`)
    await refreshState()
    renderStatusBar()
    stopHeartbeat()
  }
}

async function attemptTakeover() {
  if (takeoverInProgress)
    return
  if (getState().server === 'local')
    return
  takeoverInProgress = true
  try {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 600))
    if (getState().server === 'local')
      return // 等待期间已被接管
    await refreshState() // 刷新缓存状态: remote → offline
    await doStartServer()
    await refreshState()
    renderStatusBar()
    stopHeartbeat()
    if (myWindowId !== null) {
      const cfg = getEndpoint()
      connectLogStream(cfg.port, myWindowId)
    }
    log('info', '[TAKEOVER] this window is now the server owner')
  }
  catch {
    await refreshState()
    renderStatusBar()
    startHeartbeat()
    if (myWindowId !== null) {
      const cfg = getEndpoint()
      connectLogStream(cfg.port, myWindowId)
    }
  }
  finally {
    takeoverInProgress = false
  }
}

function startHeartbeat() {
  if (heartbeatTimer)
    return
  heartbeatTimer = setInterval(async () => {
    if (getState().server === 'local') {
      stopHeartbeat()
      return
    }
    const cfg = getEndpoint()
    const probe = await probeByokServer(cfg.host, cfg.port)
    if (probe.kind === 'offline') {
      log('info', '[HEARTBEAT] server unreachable, attempting takeover...')
      attemptTakeover()
    }
    else if (probe.kind === 'occupied') {
      log('warn', `[SRV] port ${cfg.port} is occupied by another process (${probe.reason})`)
      await refreshState()
      renderStatusBar()
      stopHeartbeat()
    }
  }, 3000)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// ── 状态栏渲染 ──
//
// 复合状态: 同时显示 server 进程状态 + BYOK Mode 开关
//   - 前缀 codicon (✓ / ○) → server 进程状态 (复用旧的语义)
//   - 后缀 ◉ / ○ → BYOK Mode 开/关
//   - 整体颜色: BYOK off 时给警告色提示
//
// 点击 → toggle BYOK Mode (非 server)。Server 启停走命令面板/侧边栏。

function renderStatusBar() {
  if (!statusBarItem)
    return
  const s = getState()

  // server 状态前缀 codicon: ✓ on / ✗ offline (close 是 × 不是字母 x)
  const serverIcon = s.server === 'offline' ? '$(close)' : '$(check)'

  // 主 tooltip 行 — 保留旧 Server 描述形态
  const src = s.server === 'local' ? 'this instance' : 'another instance'
  const serverTip = s.serverIssue === 'port_occupied'
    ? `Cursor++ — port ${s.port} is occupied by another process`
    : s.server === 'offline'
      ? 'Cursor++ — Server offline'
      : `Cursor++ — Server :${s.port} (${src})`

  // BYOK mode 后缀 + tooltip 行
  const byokGlyph = s.byokMode ? '◉' : '○'
  const byokTip = s.byokMode
    ? 'BYOK ON — using local providers.json'
    : 'BYOK OFF — passing through to official Cursor'

  statusBarItem.text = `${serverIcon} BYOK ${byokGlyph}`
  statusBarItem.tooltip = `${serverTip}\n${byokTip}\n\nClick: toggle BYOK Mode`
  statusBarItem.backgroundColor = s.byokMode
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground')
  statusBarItem.command = 'cursor2plus.toggleByok'
}

// ── Server 操作 ──

async function toggleServer() {
  const s = getState()

  if (s.server === 'local') {
    await stopServer()
    clearEndpointOverride()
    log('info', '[SRV] stopped')
    vscode.window.showInformationMessage('Cursor++ BYOK Server stopped')
  }
  else if (s.server === 'peer') {
    vscode.window.showInformationMessage('Server is running in another Cursor instance')
    return
  }
  else {
    await doStartServer()
  }
  await refreshState()
}

async function waitForPeerByokServer(host: string, port: number, attempts = 8): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const probe = await probeByokServer(host, port)
    if (probe.kind === 'byok')
      return true
    if (probe.kind === 'offline')
      return false
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/** Translate the shared server probe into the port-selection vocabulary. */
async function probePortStatus(host: string, port: number): Promise<PortStatus> {
  const probe = await probeByokServer(host, port)
  if (probe.kind === 'offline')
    return 'free'
  return probe.kind === 'byok' ? 'byok' : 'occupied'
}

function isAddrInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : ''
  return code === 'EADDRINUSE' || msg.includes('EADDRINUSE')
}

/** Another Cursor++ instance owns the endpoint: follow it instead of competing. */
async function runAsPeer(port: number) {
  log('info', `[SRV] port ${port} claimed by another Cursor++ instance, running as peer`)
  await refreshState()
  renderStatusBar()
  startHeartbeat()
}

/**
 * Publish the address a renderer on the user's machine can reach.
 *
 * Only relevant when the extension host itself runs remotely (Remote SSH /
 * WSL / containers): asExternalUri then hands out a forwarded address. On a
 * local host the topology reports publishesExternalUrl === false, nothing is
 * queried and the field stays absent, so local behaviour is unchanged.
 */
async function publishExternalUrl(host: string, port: number): Promise<void> {
  const localUrl = buildServerUrl(host, port)
  let external: string | null = null

  if (topology.publishesExternalUrl) {
    try {
      const forwarded = await vscode.env.asExternalUri(vscode.Uri.parse(localUrl))
      external = normalizeExternalUrl(localUrl, forwarded.toString())
      log('info', external
        ? `[SRV] ${topology.label}, renderer-facing URL ${external}`
        : `[SRV] ${topology.label}, asExternalUri returned the local address, keeping ${localUrl}`)
    }
    catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', `[SRV] ${topology.label}, asExternalUri failed (${msg}), keeping ${localUrl}`)
    }
  }

  await setServerExternalUrl(external)
}

/** Guard against ping-ponging through the span when ports keep being stolen. */
const MAX_LISTEN_ATTEMPTS = 3

/**
 * Claim a port and listen on it.
 *
 * Ordering matters: startServer() persists the chosen host/port into
 * routes.json before it binds, so the injected consumers — which discover the
 * endpoint from that file — never observe a listening socket they have no
 * address for. Once listening, the routes payload is pushed so already
 * connected consumers pick the new endpoint up without waiting for a watcher.
 */
async function startServerWithFallback(host: string, preferredPort: number, attempt = 0): Promise<void> {
  const selection = await selectServerPort(preferredPort, PORT_FALLBACK_SPAN, port => probePortStatus(host, port))
  if (!selection) {
    showPortOccupiedMessage(preferredPort)
    return
  }
  if (selection.shifted)
    log('warn', `[SRV] port ${preferredPort} is occupied, falling back to ${selection.port}`)

  setEndpointOverride(host, selection.port)

  if (selection.status === 'byok') {
    await runAsPeer(selection.port)
    return
  }

  try {
    const started = await startServer({ host, port: selection.port })
    setEndpointOverride(started.host, started.port)
    log('info', `[SRV] listening at http://${started.host}:${started.port}`)
    stopHeartbeat()
    await publishExternalUrl(started.host, started.port)
    pushRoutesUpdate()
  }
  catch (err: unknown) {
    if (!isAddrInUse(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', `[SRV] failed to start: ${msg}`)
      vscode.window.showErrorMessage(`Cursor++ Server failed: ${msg}`)
      return
    }
    // Lost the race between probing and binding.
    if (await waitForPeerByokServer(host, selection.port)) {
      await runAsPeer(selection.port)
      return
    }
    if (attempt + 1 >= MAX_LISTEN_ATTEMPTS) {
      showPortOccupiedMessage(selection.port)
      return
    }
    log('warn', `[SRV] port ${selection.port} was taken while binding, retrying from ${selection.port + 1}`)
    await startServerWithFallback(host, selection.port + 1, attempt + 1)
  }
}

async function doStartServer() {
  const cfg = getServerConfig()

  await refreshState()
  const s = getState()
  if (s.server === 'local') {
    log('warn', '[SRV] server already running in this instance')
    return
  }
  if (s.server === 'peer') {
    log('info', `[SRV] port ${getEndpoint().port} claimed by another Cursor++ instance, running as peer`)
    startHeartbeat()
    return
  }

  await startServerWithFallback(cfg.host, cfg.port)
}

// ── 激活 ──

/**
 * Status bar, panel and commands — everything backed by a `contributes` entry.
 *
 * Only the control identity's manifest declares those contribution points, so
 * registering them from the headless worker would throw on the webview view
 * and duplicate every command id inside a Remote SSH window.
 */
function registerUserInterface(context: vscode.ExtensionContext): void {
  // 状态栏 (BYOK Mode 切换按钮)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'cursor2plus.toggleByok'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // 状态变化 → 刷新状态栏
  context.subscriptions.push(onStateChange(() => renderStatusBar()))

  // 侧边栏面板
  const panelProvider = new PanelProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, panelProvider),
  )

  // ── 正常命令注册 ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor2plus.serverToggle', () => toggleServer()),
    vscode.commands.registerCommand('cursor2plus.toggleByok', async () => {
      const next = await toggleByokMode()
      await refreshState()
      // 1. 下发新的 routes — 消费方安装时只拿到 BASE 白名单, 切 OFF 后
      //    /auth/poll 仍被拦截会阻断登录, 必须推送让两侧热更新。
      pushRoutesUpdate()
      // 2. 触发 renderer hook 主动刷新模型列表 (借助捕获的 aiService 引用)
      bumpRefreshSignal()
      const label = next.byokMode ? 'BYOK enabled' : 'BYOK disabled (using official Cursor)'
      vscode.window.showInformationMessage(`${label}. Model list will refresh automatically.`)
    }),
    vscode.commands.registerCommand('cursor2plus.editRoutes', () => {
      vscode.window.showTextDocument(vscode.Uri.file(getRoutesFilePath()))
    }),
    vscode.commands.registerCommand('cursor2plus.editProviders', () => {
      vscode.window.showTextDocument(vscode.Uri.file(getProvidersFilePath()))
    }),
    vscode.commands.registerCommand('cursor2plus.openSettings', () => {
      vscode.commands.executeCommand('cursor2plus.panel.focus')
    }),
    vscode.commands.registerCommand('cursor2plus.toggleFileLog', () => toggleFileLog(context)),
    vscode.commands.registerCommand('cursor2plus.openLogFile', () => openLogFile()),
  )
}

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return bootstrap(context, 'control')
}

/**
 * Shared activation path of both deployment identities.
 *
 * `control` is the `ui` extension the user installs locally; `worker` is the
 * headless `workspace` companion installed on a remote host so that the
 * extension hosts living over there (cursor-agent-host and friends) reach a
 * BYOK server on their own machine. Everything below is identical for the two
 * except the user interface, which only the control identity contributes.
 */
export async function bootstrap(context: vscode.ExtensionContext, role: HostRole): Promise<void> {
  topology = resolveHostTopology({ role, remoteName: vscode.env.remoteName })

  outputChannel = vscode.window.createOutputChannel(
    topology.ownsUserInterface ? 'Cursor++' : 'Cursor++ (remote host)',
    { log: true },
  )
  initLogger((level, msg) => writeToChannel({ level, msg }))
  setupSupermarkdownNativeTip()
  preflightSupermarkdown()
  log('info', `Cursor++ activating... (${topology.label})`)

  if (topology.ownsUserInterface)
    registerUserInterface(context)

  // 确保配置文件存在 —— 即使 server 未启动,面板也能读写
  await ensureRoutesFile()
  const providers = await ensureProvidersFile()
  const setupNotice = buildProviderSetupNotice(topology, providers, getProvidersFilePath())
  if (setupNotice) {
    log('warn', `[CFG] ${setupNotice.message} ${setupNotice.detail}`)
    vscode.window.showWarningMessage(`${setupNotice.message} ${setupNotice.detail}`)
  }

  // 文件监听: 其他实例修改配置时自动同步状态 + UI
  startRoutesWatcher()
  startProvidersWatcher()
  const disposeRoutesWatch = onRoutesChange(async () => {
    await refreshState()
    renderStatusBar()
    // 手动编辑 routes.json 与 toggle 命令走同一条下发通道, 否则消费方的
    // 白名单停留在上一次推送的版本。
    pushRoutesUpdate()
    bumpRefreshSignal()
  })
  const disposeProvidersWatch = onProvidersChange(async () => {
    resetProviderInstanceCache() // 清除缓存的 SDK client, 下次请求用新 baseUrl/apiKey
    await refreshState()
    bumpRefreshSignal()
  })
  context.subscriptions.push({ dispose: disposeRoutesWatch }, { dispose: disposeProvidersWatch })

  // 初始化状态
  await refreshState()
  renderStatusBar()

  // Auto-start server
  const { autoStart } = getServerConfig()
  if (autoStart) {
    await doStartServer()
    await refreshState()
  }

  if (getState().server === 'peer')
    startHeartbeat()

  // 解析窗口 ID 并连接 SSE 日志流
  myWindowId = parseWindowId()
  // 初始化 file log 路径 (依赖 myWindowId 和 vscode.workspace.name)
  initLogFilePath(context)
  setFileLogState(fileLogEnabled, logFilePath)
  if (myWindowId !== null) {
    const cfg = getEndpoint()
    log('info', `[SRV] windowId=${myWindowId}, connecting to :${cfg.port}`)
    connectLogStream(cfg.port, myWindowId)
  }
  else {
    log('warn', '[SRV] could not parse windowId from VSCODE_PROCESS_TITLE')
  }

  if (fileLogEnabled)
    log('info', `[SRV] file logging restored from globalState → ${logFilePath}`)

  log('info', `Cursor++ activated (${topology.label})`)

  // 版本更新检查 — 只有带 UI 的一侧能把结果呈现给用户
  if (topology.ownsUserInterface)
    startUpdateCheck(context.globalState, msg => log('info', msg))
}

export async function deactivate() {
  stopUpdateCheck()
  stopHeartbeat()
  disconnectLogStream()
  closeLogFileStream()
  stopRoutesWatcher()
  stopProvidersWatcher()
  await stopServer()
  clearEndpointOverride()
  statusBarItem = null
  if (outputChannel)
    outputChannel.dispose()
}
