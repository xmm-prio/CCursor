/**
 * LLM 流重试判定 — 单一判定源
 *
 * 全链路只有这里回答两个问题:
 *   1. 某个异常是不是"重试有机会成功"的瞬时故障 (`isTransientStreamFailure`)
 *   2. 重试之间该等多久 (`computeBackoffDelayMs` + `STREAM_RETRY_POLICY`)
 *
 * 判定分三层, 从强到弱:
 *   - **永久错 (abort)**: 用户主动中断 (`APIUserAbortError` / `AbortError`) 绝不重试,
 *     否则会在客户端已放弃后继续烧 token。
 *   - **网络层瞬时错**: socket / body timeout / premature close 这类 SDK 之下的断连,
 *     以及 HTTP 429 / 408 / 5xx (含 Anthropic 的 529 overloaded)。
 *   - **消息启发式 (`inferRetryable`)**: 从 `errors.ts` 搬迁过来的原始启发式,
 *     负责识别 401/403/404/请求体校验错这类 "retry 必然无效" 的场景。
 *     `errors.ts` 现在 import 本模块, 保证 banner 的 `is_retryable` 与流重试同源。
 */

/** 流重试策略参数 */
export interface StreamRetryPolicy {
  /** 总尝试次数 (首次 + 重试), 4 = 首次 + 3 次重试 */
  maxAttempts: number
  /** 首次重试的基准退避时长 */
  baseDelayMs: number
  /** 退避时长上限 */
  maxDelayMs: number
  /** 抖动幅度比例, 0.3 = ±30% */
  jitterRatio: number
}

/** 默认策略 — provider 装饰器与测试共用 */
export const STREAM_RETRY_POLICY: StreamRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.3,
}

/** 网络层瞬时错误码 — Node / undici / OpenAI SDK 透出的 `error.code` */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** 网络层瞬时错误的消息特征 — 拿不到 code 时的兜底 */
const TRANSIENT_MESSAGE_PATTERNS = [
  'apiconnectionerror',
  'apiconnectiontimeouterror',
  'connection error',
  'connection closed',
  'premature close',
  'socket hang up',
  'terminated',
  'network error',
  'fetch failed',
  'stream disconnected',
  'incomplete chunked encoding',
  'overloaded',
]

/** 用户中断的错误名 / 消息特征 — 永远不重试 */
const ABORT_ERROR_NAMES = new Set(['AbortError', 'APIUserAbortError'])
const ABORT_MESSAGE_PATTERNS = ['request was aborted', 'user aborted', 'operation was aborted', 'the operation was canceled']

/**
 * 判断一个流异常能否通过重跑上游请求恢复。
 *
 * 顺序: abort 永久错 → HTTP status → 网络错误码 → 消息特征 → `inferRetryable` 兜底。
 */
export function isTransientStreamFailure(error: unknown): boolean {
  if (isAbortFailure(error))
    return false

  const status = extractHttpStatus(error)
  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500)
      return true
    if (status >= 400)
      return false
  }

  if (hasTransientErrorCode(error))
    return true

  const message = describeFailure(error).toLowerCase()
  if (TRANSIENT_MESSAGE_PATTERNS.some(pattern => message.includes(pattern)))
    return true

  return inferRetryable(message)
}

/**
 * 启发式: 识别 retry 必然无效的错误类型。
 *
 * 覆盖的观测类 (实际截图编号 30-39):
 *   - 401/403 auth 错     → 图 38   (api key 错)
 *   - 404 路由错          → 图 31, 34 (baseUrl 错)
 *   - SDK auth 参数缺失   → 图 35   (Anthropic SDK 报 "Could not resolve authentication method")
 *   - Anthropic 400 协议错 → 图 33   (tool_use 无配对 tool_result)
 *   - Anthropic 400 校验错 → 图 39   (tool name 正则不匹配)
 *   - OpenAI 400 协议错   → 图 36   (no tool output for function call)
 *   - Gemini 400 校验错   → 图 37   (function_response.name empty)
 *
 * 未匹配的错误保守默认可 retry (图 30 stream 断 / 图 32 JSON 解析 / 429 / 5xx)。
 */
export function inferRetryable(rawMessage: string): boolean {
  const msg = rawMessage.toLowerCase()

  // 鉴权类 — retry 无效
  if (/\b401\b/.test(msg) || msg.includes('unauthorized') || msg.includes('auth_error'))
    return false
  if (/\b403\b/.test(msg) || msg.includes('forbidden'))
    return false
  if (msg.includes('could not resolve authentication'))
    return false

  // 路由 / endpoint 错 — retry 无效
  if (/\b404\b/.test(msg) || msg.includes('page not found') || msg.includes('not found'))
    return false

  // upstream 400 请求体校验错 — retry 无效 (我们自己 codec / builder bug)
  if (msg.includes('invalid_request_error'))
    return false
  if (msg.includes('tool_use ids were found without tool_result'))
    return false
  if (msg.includes('no tool output found for function call'))
    return false
  if (msg.includes('function_response.name'))
    return false
  if (msg.includes('does not match pattern'))
    return false

  // 其他 — 可 retry
  return true
}

/**
 * 第 `attempt` 次尝试失败后应等待的时长 (attempt 从 1 开始)。
 * 指数退避 + 对称抖动, 上限由 `policy.maxDelayMs` 夹住。
 */
export function computeBackoffDelayMs(attempt: number, policy: StreamRetryPolicy = STREAM_RETRY_POLICY): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * policy.jitterRatio * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(capped + jitter))
}

/** 提取一段可读的失败原因, 用于日志与 `stream_restart` 事件 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error)
    return error.message || error.name || 'Unknown error'
  if (typeof error === 'string')
    return error
  try {
    return JSON.stringify(error) ?? 'Unknown error'
  }
  catch {
    return 'Unknown error'
  }
}

// ── 内部 helper ────────────────────────────────────────────────

function isAbortFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined
  if (name && ABORT_ERROR_NAMES.has(name))
    return true
  if (readString(error, 'code') === 'ABORT_ERR')
    return true
  const message = describeFailure(error).toLowerCase()
  return ABORT_MESSAGE_PATTERNS.some(pattern => message.includes(pattern))
}

function hasTransientErrorCode(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 4; cursor = readUnknown(cursor, 'cause'), depth++) {
    const code = readString(cursor, 'code')
    if (code && TRANSIENT_ERROR_CODES.has(code))
      return true
    const errno = readString(cursor, 'errno')
    if (errno && TRANSIENT_ERROR_CODES.has(errno))
      return true
  }
  return false
}

function extractHttpStatus(error: unknown): number | undefined {
  const direct = readNumber(error, 'status') ?? readNumber(error, 'statusCode')
  if (direct !== undefined)
    return direct
  const response = readUnknown(error, 'response')
  return response ? readNumber(response, 'status') : undefined
}

function readUnknown(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null)
    return undefined
  return (source as Record<string, unknown>)[key]
}

function readString(source: unknown, key: string): string | undefined {
  const value = readUnknown(source, key)
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = readUnknown(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
