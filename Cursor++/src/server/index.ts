import type { EventSocketServer } from './eventSocket'
import type { LogLevel } from './logger'
import type { RuntimeConfigInit } from './runtime-config'
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify'
import cors from '@fastify/cors'
/**
 * Embedded BYOK Server — Fastify + ConnectRPC
 *
 * 在 extension host 进程内运行，通过 startServer/stopServer 管理生命周期。
 */
import Fastify from 'fastify'
import { STREAMING_TRANSPORT_OPTIONS, tuneStreamingTransport } from './config/connectionTuning'
import { ensureProvidersFile } from './config/providersStore'
import { buildRoutesPayload } from './config/routesPayload'
import { ensureRoutesFile, loadRoutes, toggleByokMode } from './config/routesStore'
import { closeAgentDatabase, initDatabase } from './database/sqlite'
import { serveEventSocket } from './eventSocket'
import { blobCacheDiagnostics } from './handlers/agent/blobStore'
import { agentLinkDiagnostics } from './handlers/agent/session'
import { streamRestartCount } from './handlers/agent/stream'
import { upstreamTrafficSnapshot } from './handlers/llm/upstreamTraffic'
import { enterWindowContext, logger, setLogBroadcast, setLogPush, setLogSubscriberCheck } from './logger'
import {
  addEventSink,
  addLogSink,
  broadcastLog,
  closeAllSinks,
  createSseSink,
  emitEvent,
  emitLog,
  emitShutdown,
  hasLogSink,
  pushChannelDiagnostics,
} from './pushChannel'
import { initRuntimeConfig } from './runtime-config'
import routes from './services'

const RE_CONNECT_RPC_PATH = /\/([^/]+)\/(\w+)$/

/**
 * 高频轮询端点 — 固定走 trace 级别 (默认不可见)。
 *
 * - /auth/full_stripe_profile, /auth/stripe_profile: Cursor 订阅状态轮询
 * - /aiserver.v1.BidiService/BidiAppend: agent 上行通道, chatty shell 下
 *   每个输出 chunk 都是一次 append, 按 debug 记会淹掉整个 Output 面板
 *
 * 节流机制已移除: trace 级别默认被 LogOutputChannel 过滤掉,
 * 开启 trace 时用户自己需要面对所有细节, 不再聚合汇总。
 */
const TRACE_PATHS = new Set([
  '/auth/full_stripe_profile',
  '/auth/stripe_profile',
  '/aiserver.v1.BidiService/BidiAppend',
])

let app: any = null
let eventSocketServer: EventSocketServer | null = null

// ── 推送通道 ──
//
// 订阅者登记、背压与两种传输的编码都在 pushChannel.ts, WebSocket 的 upgrade
// 接管在 eventSocket.ts; 本文件只负责把 HTTP 端点接到那些注册函数上。
//
// windowId 从请求头 x-client-wid 直接读取 — 由 renderer inject-patch 注入,
// 值来自 window.vscodeWindowId。Extension host 侧通过解析 VSCODE_PROCESS_TITLE
// 中的 [N-M] 得到相同的 N, 两边自然对齐, 无需任何映射表。

/** 从请求头 x-client-wid 读取 windowId (由 inject-patch 注入) */
function resolveWindowId(req: any): number | null {
  const v = req.headers['x-client-wid']
  if (typeof v !== 'string')
    return null
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Refresh signal — 通过 /byok/events SSE 端点推送给所有 renderer。
 *
 * 触发链路:
 *   extension toggleByok 命令 / providers.json / routes.json 变更
 *     → bumpRefreshSignal()
 *     → 向所有已连接的 renderer SSE 推送 "event: refresh"
 *     → renderer EventSource 监听 refresh 事件
 *     → globalThis.__byokRefreshModels()
 *     → globalThis.__byokAiSvc.refreshDefaultModels()  (引用由 patch-inject 字符串重写时泄漏)
 *     → 客户端模型选择器自动刷新
 *
 * 替换了早期的轮询方案 (renderer 每 3s GET /byok/refresh-signal + counter 对比)。
 * Push 模式零心跳,消除了 trace 级别的轮询噪声,同时响应更及时。
 */
let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null

export function bumpRefreshSignal(): void {
  if (refreshDebounceTimer)
    clearTimeout(refreshDebounceTimer)
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null
    const sent = emitEvent({ kind: 'refresh' })
    logger.info({ connections: sent }, '[SRV] refresh signal pushed')
  }, 500)
}

/**
 * Routes delivery channel — one projection, one broadcast, three consumers.
 *
 * The renderer hook, the node HTTP/1.1 routers and any peer instance all need
 * the same two facts: where the server listens (host / port / forwarded URL)
 * and which requests belong to it (REST paths + ConnectRPC services/methods).
 * Every source of change (BYOK toggle, routes.json edit, port fallback,
 * external URL publication) funnels into pushRoutesUpdate(), which re-reads
 * routes.json and broadcasts the projection built by buildRoutesPayload().
 *
 * Wire compatibility: serializeRoutesFrames() emits the legacy `routes` frame
 * next to `routes-v2`, so hooks injected by an older installer keep working.
 */
function currentRoutesPayload() {
  return buildRoutesPayload(loadRoutes())
}

export function pushRoutesUpdate(): void {
  const payload = currentRoutesPayload()
  const sent = emitEvent({ kind: 'routes', payload })
  logger.info(
    {
      connections: sent,
      endpoint: payload.server.externalUrl ?? payload.server.url,
      rest: payload.rest.length,
      connectRpc: payload.services.length + payload.methods.length,
    },
    '[SRV] routes update pushed',
  )
}

export interface StartServerOptions extends RuntimeConfigInit {}

export async function startServer(opts: StartServerOptions): Promise<{ host: string, port: number }> {
  if (app) {
    throw new Error('Server already running')
  }

  await initRuntimeConfig(opts)
  await ensureRoutesFile()
  await ensureProvidersFile()
  await initDatabase()

  const host = opts.host || '127.0.0.1'
  const port = opts.port || 39831

  const server = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    bodyLimit: 10 * 1024 * 1024,
    ...STREAMING_TRANSPORT_OPTIONS,
  })

  // Agent turns are single, minutes-long, mostly silent requests; over a
  // remote tunnel they also need OS-level keepalive. See connectionTuning.ts.
  tuneStreamingTransport(server.server)

  // onRequest: 绑定 windowId 到 AsyncLocalStorage, 后续整个处理链
  // 的 logger 调用都会自动路由到正确的窗口 (per-window SSE 推送)
  server.addHook('onRequest', (req, _reply, done) => {
    const wid = resolveWindowId(req)
    if (wid !== null)
      enterWindowContext(wid)
    done()
  })

  // Request logging — 通过 logger.xxx() 输出, 由 AsyncLocalStorage 上下文
  // (在 onRequest hook 中设置) 自动路由到正确的 windowId SSE 连接。
  //
  // 格式统一为 "[CATEGORY] 主体 → 状态 (耗时)":
  //   - [GRPC]  aiserver.v1.AiService/AvailableModels → 200 (5ms)
  //   - [GET]   /byok/refresh-signal → 200 (0ms)
  //   - [POST]  /auth/logout → 200 (1ms)
  //
  // 判定顺序 (顺序很重要):
  //   1. TRACE_PATHS 优先 — 高频轮询端点会被 RE_CONNECT_RPC_PATH 错误匹配
  //      (e.g. /auth/full_stripe_profile → 捕获 auth/full_stripe_profile), 必须先拦截。
  //   2. ConnectRPC 服务名匹配 — service 段必须含点 (aiserver.v1.AiService),
  //      与扁平 REST 路径区分。
  //   3. 其他 REST 端点 → debug
  server.addHook('onResponse', (req, reply, done) => {
    const url = req.url
    const status = reply.statusCode
    const rt = reply.elapsedTime?.toFixed(0) ?? '?'

    if (TRACE_PATHS.has(url)) {
      logger.trace(`[${req.method}] ${url} → ${status} (${rt}ms)`)
      done()
      return
    }

    const match = url.match(RE_CONNECT_RPC_PATH)
    if (match && match[1].includes('.')) {
      const [, svc, method] = match
      const shortSvc = svc.split('.').pop()
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      logger[level](`[GRPC] ${shortSvc}/${method} → ${status} (${rt}ms)`)
      done()
      return
    }

    logger.debug(`[${req.method}] ${url} → ${status} (${rt}ms)`)
    done()
  })

  await server.register(cors, { origin: true })
  await server.register(fastifyConnectPlugin, { routes })

  // ── 推送通道端点 + 窗口注册 ──

  /**
   * Diagnostics — everything needed to answer "is this server the bottleneck".
   *
   * Under several workspaces the same three questions come up: is a turn stuck
   * on the editor link (`agentLink`), is it stuck waiting for a provider socket
   * (`upstream`), and is a window silently losing output or holding memory
   * (`pushChannel`, `blobCache`).
   */
  server.get('/byok/debug', async () => ({
    pushChannel: pushChannelDiagnostics(),
    upstream: upstreamTrafficSnapshot(),
    blobCache: blobCacheDiagnostics(),
    agentLink: {
      ...agentLinkDiagnostics(),
      streamRestarts: streamRestartCount(),
    },
  }))

  // SSE 公共头 — reply.raw.writeHead 绕过 Fastify 管道,
  // 必须手动包含 CORS header (renderer EventSource 受浏览器 CORS 策略限制)
  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  }

  // Extension host SSE 订阅 — per-windowId 日志流
  server.get('/byok/log-stream', async (req, reply) => {
    const wid = Number((req.query as any).windowId)
    if (Number.isNaN(wid)) {
      reply.code(400).send({ error: 'windowId required' })
      return
    }

    reply.raw.writeHead(200, sseHeaders)
    const sink = createSseSink(reply.raw)
    const unsubscribe = addLogSink(wid, sink)
    sink.write({ kind: 'log', entry: { level: 'info', msg: `[SRV] log stream connected (windowId=${wid})` } })
    // hijack: 不让 Fastify 关闭 response
    reply.hijack()

    req.raw.on('close', unsubscribe)
  })

  // Renderer / node router SSE 订阅 — routes + refresh 推送。
  // 广播式: 不按窗口过滤, 因为 providers / routes 变更是全局事件。
  //
  // 同一通道另有 WebSocket 形态 (见 BYOK_WS_PATH); 两者共用同一套订阅登记,
  // 消费方任选其一即可。
  server.get('/byok/events', async (req, reply) => {
    reply.raw.writeHead(200, sseHeaders)
    const sink = createSseSink(reply.raw)
    const unsubscribe = addEventSink(sink)
    sink.write({ kind: 'comment', text: 'connected' })
    // 立即下发当前 routes — 消费方 (renderer hook / node router) 初始只含 BASE,
    // 这一帧同时解除 renderer 的启动期就绪门控
    sink.write({ kind: 'routes', payload: currentRoutesPayload() })
    reply.hijack()

    req.raw.on('close', unsubscribe)
  })

  // BYOK toggle — renderer (glass sidebar) 通过 fetch 调用
  server.post('/byok/toggle', async () => {
    const next = await toggleByokMode()
    pushRoutesUpdate()
    bumpRefreshSignal()
    logger.info({ byokMode: next.byokMode }, '[SRV] BYOK toggled via REST')
    return { byokMode: next.byokMode }
  })

  // Fake auth endpoints
  server.get('/health', async () => ({ ok: true, mode: 'byok' }))

  server.get('/auth/full_stripe_profile', async () => ({
    membershipType: 'ultra',
    paymentId: 'byok_local',
    subscriptionStatus: 'active',
    verifiedStudent: false,
    trialEligible: false,
    trialLengthDays: 0,
    isOnStudentPlan: false,
    isOnBillableAuto: false,
    customerBalance: null,
    trialWasCancelled: false,
    isTeamMember: false,
    teamMembershipType: null,
    individualMembershipType: 'ultra',
    lastPaymentFailed: false,
    pendingCancellationDate: null,
    isYearlyPlan: false,
  }))

  server.get('/auth/stripe_profile', async (_req, reply) => {
    reply.type('text/plain').send('byok_local')
  })

  server.get('/auth/has_valid_payment_method', async () => ({ hasValidPaymentMethod: true }))
  server.post('/auth/logout', async () => ({ ok: true }))
  server.get('/auth/poll', async () => ({ accessToken: 'byok-token', authId: 'byok-user' }))

  // WebSocket 形态的事件通道 —— 与 /byok/events 同源同载荷, 不同 socket 池。
  const eventSocket = serveEventSocket(server.server, currentRoutesPayload)

  // 日志分发回调: 请求内 → emitLog (per-window), 请求外 → broadcastLog (所有窗口)
  setLogBroadcast(broadcastLog)
  setLogPush(emitLog)
  setLogSubscriberCheck(hasLogSink)

  try {
    await server.listen({ port, host })
  }
  catch (err) {
    app = null
    try {
      eventSocket.close()
    }
    catch { /* noop */ }
    try {
      await server.close()
    }
    catch { /* noop */ }
    try {
      await closeAgentDatabase()
    }
    catch { /* noop */ }
    throw err
  }
  app = server
  eventSocketServer = eventSocket
  logger.info(`[SRV] listening at http://${host}:${port}`)

  return { host, port }
}

export function broadcastShutdown(): void {
  const delivered = emitShutdown()
  logger.info({ subscribers: delivered }, '[SRV] shutdown broadcast sent')
}

export async function stopServer(): Promise<void> {
  if (!app)
    return
  const server = app
  app = null
  broadcastShutdown()
  // Order matters: the peers must hear the shutdown before their streams are
  // cut, and every stream must be cut before close() — see closeAllSinks().
  closeAllSinks()
  if (eventSocketServer) {
    eventSocketServer.close()
    eventSocketServer = null
  }
  try {
    await server.close()
  }
  finally {
    await closeAgentDatabase()
  }
}

export function isServerRunning(): boolean {
  return app !== null
}
