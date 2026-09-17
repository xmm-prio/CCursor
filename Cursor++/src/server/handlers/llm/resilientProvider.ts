/**
 * Provider 流重试装饰器
 *
 * 把"上游流中途断连"这件事在 provider 层吃掉, 让 agent 层的轮次循环只面对
 * 两种结局: 一条完整的流, 或一个真正无法恢复的错。
 *
 * 行为:
 *   - 尚未 yield 过任何事件 (`emitted === 0`) 就断 → 静默重跑, 下游完全无感知
 *   - 已经吐过字再断 → 先 yield 一条 `stream_restart`, 下游据此丢弃半截状态,
 *     再用**完全相同**的 `LLMStreamRequest` 重跑
 *   - 非瞬时错 / 尝试次数耗尽 → 原样 rethrow, 保持现有 `makeProviderError` 路径不变
 *
 * 关闭语义: 消费者提前 `break` 时 for-await 走的是 `return()` 而不是 `throw()`,
 * 这条完成路径不会进 catch, 只会走 finally —— 所以用户中断不会被误判成需要重试,
 * 同时 finally 里显式关掉内层 iterator, 避免 SDK 的 SSE 连接泄漏。
 */
import { logger } from '../../logger'
import type { StreamRetryPolicy } from './retryPolicy'
import { computeBackoffDelayMs, describeFailure, isTransientStreamFailure, STREAM_RETRY_POLICY } from './retryPolicy'
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from './types'

/** 可注入依赖 — 测试用可控 sleep, 生产用真实定时器 */
export interface StreamResilienceDeps {
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 给任意 `LLMProvider` 套上流重试, 返回实现同一接口的新对象 (不修改 inner)。
 */
export function withStreamResilience(
  inner: LLMProvider,
  policy: StreamRetryPolicy = STREAM_RETRY_POLICY,
  deps: StreamResilienceDeps = {},
): LLMProvider {
  const sleep = deps.sleep ?? defaultSleep
  return {
    name: inner.name,
    stream: (request: LLMStreamRequest) => resilientStream(inner, request, policy, sleep),
  }
}

async function* resilientStream(
  inner: LLMProvider,
  request: LLMStreamRequest,
  policy: StreamRetryPolicy,
  sleep: (ms: number) => Promise<void>,
): AsyncIterable<LLMStreamEvent> {
  let restartReason: string | undefined

  for (let attempt = 1; ; attempt++) {
    if (restartReason !== undefined) {
      yield { type: 'stream_restart', attempt, reason: restartReason }
      restartReason = undefined
    }

    let emitted = 0
    // 区分"内层流抛错"与"消费者通过 throw() 注入的错" —— 后者绝不重试
    let yielding = false
    try {
      const iterator = inner.stream(request)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await iterator.next()
          if (next.done)
            return
          emitted++
          yielding = true
          yield next.value
          yielding = false
        }
      }
      finally {
        await closeQuietly(iterator)
      }
    }
    catch (error) {
      const reason = describeFailure(error)
      if (yielding || attempt >= policy.maxAttempts || !isTransientStreamFailure(error)) {
        if (!yielding && attempt > 1) {
          logger.warn({
            provider: inner.name,
            attempts: attempt,
            emitted,
            reason,
          }, '[LLM_RETRY] giving up on upstream stream')
        }
        throw error
      }

      const delayMs = computeBackoffDelayMs(attempt, policy)
      logger.warn({
        provider: inner.name,
        model: request.model,
        attempt,
        nextAttempt: attempt + 1,
        emitted,
        delayMs,
        reason,
      }, '[LLM_RETRY] upstream stream failed, retrying')
      await sleep(delayMs)
      // emitted === 0 时无需通知下游: 它还没看到本轮任何事件
      if (emitted > 0)
        restartReason = reason
    }
  }
}

async function closeQuietly(iterator: AsyncIterator<LLMStreamEvent>): Promise<void> {
  try {
    await iterator.return?.()
  }
  catch (error) {
    logger.debug({ error: describeFailure(error) }, '[LLM_RETRY] inner stream close failed')
  }
}
